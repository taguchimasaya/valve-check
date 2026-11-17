"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import UserBadge from "@/components/UserBadge";
import { authFetch, refreshMe } from "@/lib/auth";
import { ROLE_LABEL, ROLES, SITE_ROLES, roleDesc, type Role, type SiteRoles } from "@/lib/roles";
import { useFacilities, type FacilityItem } from "@/lib/piping/usePiping";
import type { AdminUser, TestMailResult } from "@/app/api/admin/users/route";
import { decodeCsv, parseCsvText, planImport, rolesAtFacility, usersToCsv, type ImportPlan } from "@/lib/userCsv";

// ユーザー管理（管理者のみ）。利用者の作成・権限の変更・無効化は /api/admin/users（service role キー）で行う。
// 権限は拠点ごと（作業者・チームリーダー・G長・制御室）。管理者だけは全拠点共通。

/** 権限の編集値：管理者（全拠点）＋拠点ごとの権限。siteRoles が null の人は roles が全拠点に効く（拠点ごとに分ける前） */
type Access = { admin: boolean; siteRoles: SiteRoles | null; roles: Role[] };

const accessOfUser = (u: AdminUser): Access => ({
  admin: u.roles.includes("admin"),
  siteRoles: u.siteRoles,
  roles: u.siteRoles ? [] : u.roles.filter((r) => r !== "admin"),
});
const sameAccess = (a: Access, b: Access) => JSON.stringify(a) === JSON.stringify(b);
const hasAnyRole = (a: Access) => a.admin || (a.siteRoles ? Object.values(a.siteRoles).some((r) => r.length) : a.roles.length > 0);

function AccessEditor({
  value,
  onChange,
  facilities,
  lockAdmin,
  disabled,
}: {
  value: Access;
  onChange: (v: Access) => void;
  facilities: FacilityItem[];
  lockAdmin?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className={`space-y-1 ${disabled ? "pointer-events-none" : ""}`}>
      {lockAdmin ? (
        <span title="環境変数 ADMIN_LOGIN_IDS で指定" className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
          ✔ 管理者（全拠点・固定）
        </span>
      ) : (
        <label title={roleDesc("admin")} className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={value.admin} onChange={(e) => onChange({ ...value, admin: e.target.checked })} />
          管理者（全拠点）
        </label>
      )}
      {value.siteRoles ? (
        <table className="min-w-[420px] text-xs">
          <tbody>
            {facilities.map((f) => (
              <tr key={f.id} className="align-top">
                <td className="max-w-[140px] pr-2 pt-0.5 text-zinc-500">{f.name}</td>
                <td className="whitespace-nowrap [&>div]:flex-nowrap">
                  <RoleChecks
                    options={SITE_ROLES}
                    value={value.siteRoles?.[f.id] ?? []}
                    onChange={(r) => onChange({ ...value, siteRoles: { ...(value.siteRoles ?? {}), [f.id]: r } })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div>
          <span className="text-[11px] text-zinc-500">全拠点で共通：</span>
          <RoleChecks options={SITE_ROLES} value={value.roles} onChange={(r) => onChange({ ...value, roles: r })} />
          <button
            type="button"
            onClick={() => onChange({ ...value, siteRoles: Object.fromEntries(facilities.map((f) => [f.id, value.roles])), roles: [] })}
            className="mt-0.5 text-[11px] text-sky-700 underline"
          >
            拠点ごとに分ける
          </button>
        </div>
      )}
    </div>
  );
}

async function api<T>(init?: RequestInit): Promise<T> {
  const res = await authFetch("/api/admin/users", { cache: "no-store", ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body as T;
}

const post = <T,>(body: object) =>
  api<T>({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const fmt = (at: string | null) =>
  at ? new Date(at).toLocaleString("ja-JP", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

function RoleChecks({
  value,
  onChange,
  lock,
  options = ROLES,
}: {
  value: Role[];
  onChange: (v: Role[]) => void;
  lock?: Role[];
  options?: readonly Role[];
}) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {options.map((r) => {
        // ADMIN_LOGIN_IDS で決まっている権限は変えられないので、チェックボックスではなく文字で出す
        if (lock?.includes(r)) {
          return (
            <span key={r} title="環境変数 ADMIN_LOGIN_IDS で指定" className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
              ✔ {ROLE_LABEL[r]}（固定）
            </span>
          );
        }
        const locked = false;
        return (
          <label key={r} title={roleDesc(r)} className={`flex items-center gap-1 text-sm ${locked ? "font-semibold text-zinc-500" : ""}`}>
            <input
              type="checkbox"
              checked={value.includes(r)}
              disabled={locked}
              onChange={(e) => onChange(e.target.checked ? ROLES.filter((x) => x === r || value.includes(x)) : value.filter((x) => x !== r))}
            />
            {ROLE_LABEL[r]}
          </label>
        );
      })}
    </div>
  );
}

export default function UsersPage() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [meId, setMeId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // 一覧の絞り込み
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState<Role | "">("");
  const [siteFilter, setSiteFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | "active" | "disabled">("");
  const [mailFilter, setMailFilter] = useState<"" | "todo" | "done" | "none">("");
  // CSV 取込のプレビュー・進み具合
  const [importPlan, setImportPlan] = useState<(ImportPlan & { file: string }) | null>(null);
  const [progress, setProgress] = useState("");
  // 権限・名前の編集中の値（利用者ID → 値）
  const [edits, setEdits] = useState<Record<string, { access: Access; name: string; notifyEmail: string }>>({});
  // 拠点の一覧（管理者はすべての拠点が見える）
  const facilities = useFacilities() ?? [];
  // 新しい利用者
  const emptyForm = { loginId: "", name: "", password: "", access: { admin: false, siteRoles: {}, roles: [] } as Access, notifyEmail: "" };
  const [form, setForm] = useState(emptyForm);

  const load = useCallback(async () => {
    try {
      const r = await api<{ users: AdminUser[]; me: string }>();
      setUsers(r.users);
      setMeId(r.me);
      setEdits({});
    } catch (e) {
      setMessage({ type: "err", text: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setMessage({ type: "ok", text: ok });
      await load();
    } catch (e) {
      setMessage({ type: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (users ?? []).filter((u) => {
      if (statusFilter === "active" && u.disabled) return false;
      if (statusFilter === "disabled" && !u.disabled) return false;
      if (t && ![u.loginId, u.name, u.email, u.notifyEmail].some((x) => x.toLowerCase().includes(t))) return false;
      const isAdmin = u.roles.includes("admin");
      // 拠点：その拠点に権限がある人（管理者は全拠点に含む）
      if (siteFilter && !isAdmin && !rolesAtFacility(u, siteFilter).length) return false;
      if (roleFilter) {
        if (roleFilter === "admin") {
          if (!isAdmin) return false;
        } else if (siteFilter ? !rolesAtFacility(u, siteFilter).includes(roleFilter) : !u.roles.includes(roleFilter)) return false;
      }
      if (mailFilter === "none" && u.notifyEmail) return false;
      if (mailFilter === "done" && !u.testMailDone) return false;
      if (mailFilter === "todo" && (!u.notifyEmail || u.testMailDone)) return false;
      return true;
    });
  }, [users, q, roleFilter, siteFilter, statusFilter, mailFilter]);
  const filtered = !!(q.trim() || roleFilter || siteFilter || statusFilter || mailFilter);
  // 一括テストメールの対象：表示中で有効・通知先あり・未送信
  const mailTargets = useMemo(() => shown.filter((u) => !u.disabled && u.notifyEmail && !u.testMailDone), [shown]);
  const clearFilters = () => {
    setQ("");
    setRoleFilter("");
    setSiteFilter("");
    setStatusFilter("");
    setMailFilter("");
  };

  const exportCsv = () => {
    const url = URL.createObjectURL(new Blob([usersToCsv(shown, facilities)], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `利用者一覧_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const readCsv = async (file: File) => {
    setMessage(null);
    const rows = parseCsvText(decodeCsv(await file.arrayBuffer()));
    setImportPlan({ ...planImport(rows, users ?? [], facilities), file: file.name });
  };

  // CSV の変更を1件ずつ反映する（有効に戻す → 更新 → 無効にする の順）
  const applyImport = async () => {
    if (!importPlan) return;
    const done: string[] = [];
    const failed: string[] = [];
    setBusy(true);
    setMessage(null);
    for (const [i, c] of importPlan.changes.entries()) {
      setProgress(`反映中 ${i + 1}/${importPlan.changes.length}：${c.loginId}`);
      try {
        if (c.kind === "create") await post(c.body);
        else {
          if (c.status === "enable") await post({ action: "enable", id: c.id });
          if (c.body) await post(c.body);
          if (c.status === "disable") await post({ action: "disable", id: c.id });
        }
        done.push(c.loginId);
      } catch (e) {
        failed.push(`${c.loginId}（${e instanceof Error ? e.message : String(e)}）`);
      }
    }
    setProgress("");
    setBusy(false);
    setImportPlan(null);
    await load();
    refreshMe();
    setMessage(
      failed.length
        ? { type: "err", text: `${done.length}件を反映しました。反映できなかったもの：${failed.join("、")}` }
        : { type: "ok", text: `CSV の${done.length}件を反映しました。` }
    );
  };

  // 一括テストメール（20人ずつ。送信済みのアドレスにはサーバー側でも送らない）
  const bulkTestMail = async () => {
    const list = mailTargets;
    if (!list.length) return;
    if (!confirm(`表示中の未送信の${list.length}人にテストメールを送りますか？\n（送信済みのアドレスには送りません）`)) return;
    setBusy(true);
    setMessage(null);
    const results: TestMailResult[] = [];
    try {
      for (let i = 0; i < list.length; i += 20) {
        setProgress(`テストメール送信中 ${Math.min(i + 20, list.length)}/${list.length}`);
        const r = await post<{ results: TestMailResult[] }>({ action: "testMailBulk", ids: list.slice(i, i + 20).map((u) => u.id) });
        results.push(...r.results);
      }
    } catch (e) {
      results.push({ id: "", status: "error", error: e instanceof Error ? e.message : String(e) });
    }
    setProgress("");
    setBusy(false);
    await load();
    const n = (st: TestMailResult["status"]) => results.filter((x) => x.status === st).length;
    const errors = results.filter((x) => x.status === "error" || x.error);
    const loginOf = (id: string) => users?.find((u) => u.id === id)?.loginId ?? id;
    setMessage({
      type: errors.length ? "err" : "ok",
      text:
        `テストメール：送信 ${n("sent")}件、送信済みのため省略 ${n("skipped")}件` +
        (n("noAddress") + n("disabled") ? `、対象外 ${n("noAddress") + n("disabled")}件` : "") +
        (errors.length
          ? `。エラー：${errors.map((x) => `${x.id ? loginOf(x.id) : ""}${x.to ? `（${x.to}）` : ""} ${x.error}`).join("、")}`
          : "。届いたか本人に確認してください。"),
    });
  };
  const counts = useMemo(() => {
    const active = (users ?? []).filter((u) => !u.disabled);
    return Object.fromEntries(ROLES.map((r) => [r, active.filter((u) => u.roles.includes(r)).length])) as Record<Role, number>;
  }, [users]);

  const create = () =>
    run(async () => {
      const { access, ...rest } = form;
      await post({ action: "create", ...rest, ...access });
      setForm(emptyForm);
    }, `利用者「${form.loginId}」を作成しました。ログインIDとパスワードを本人に伝えてください。`);

  return (
    <main className="min-h-screen bg-zinc-50 px-4 py-8 dark:bg-black">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-4">
            <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400">
              ← ホーム
            </Link>
            <Link href="/piping" className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400">
              ← 配管系統図
            </Link>
          </div>
          <UserBadge />
        </div>
        <h1 className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">👥 ユーザー管理</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          利用者の作成・権限の変更・無効化を行います。権限は拠点ごとに付けます（拠点ごとに担当者が違うため）。1つの拠点に複数の権限も付けられます（例：チームリーダー＋制御室）。管理者は全拠点共通です。どこかの拠点で制御室の人は、ほかの拠点も表示だけできます。権限の変更は次に画面を開いたときから反映されます。
        </p>
        <ul className="mt-2 grid gap-1 text-xs text-zinc-600 sm:grid-cols-2 dark:text-zinc-400">
          {ROLES.map((r) => (
            <li key={r}>
              <b className="text-zinc-800 dark:text-zinc-200">{ROLE_LABEL[r]}</b>（有効 {counts[r] ?? 0}人）：{roleDesc(r)}
            </li>
          ))}
        </ul>
        <p className="mt-1 text-xs">
          <Link href="/admin/roles" className="text-sky-700 underline dark:text-sky-400">
            🔑 権限の設定（どの権限でどの機能を使えるか）を変える
          </Link>
        </p>

        {message && (
          <p
            className={`mt-3 rounded-lg px-3 py-2 text-sm ${
              message.type === "ok" ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" : "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"
            }`}
          >
            {message.text}
          </p>
        )}

        {/* 作成 */}
        <section className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">利用者を作成</h2>
          <p className="mt-1 text-xs text-zinc-500">
            ログインIDは半角英小文字・数字（例：tanaka）。メールアドレスを入れると、@ より前がログインIDになります。メールの確認なしで、すぐにログインできます。
          </p>
          <div className="mt-3 grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end">
            <label className="text-sm">
              <span className="text-xs text-zinc-500">ログインID</span>
              <input
                value={form.loginId}
                onChange={(e) => setForm({ ...form, loginId: e.target.value })}
                autoComplete="off"
                className="mt-0.5 block w-full rounded-lg border border-zinc-300 px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
            <label className="text-sm">
              <span className="text-xs text-zinc-500">表示名（記録に残る名前）</span>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="mt-0.5 block w-full rounded-lg border border-zinc-300 px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
            <label className="text-sm">
              <span className="text-xs text-zinc-500">初期パスワード（8文字以上）</span>
              <input
                type="text"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                autoComplete="new-password"
                className="mt-0.5 block w-full rounded-lg border border-zinc-300 px-2 py-1.5 font-mono dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
            <button
              onClick={create}
              disabled={busy || !form.loginId.trim() || form.password.length < 8 || !hasAnyRole(form.access)}
              className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
            >
              作成する
            </button>
          </div>
          <div className="mt-2 grid gap-3 md:grid-cols-[1fr_1fr] md:items-end">
            <div>
              <span className="text-xs text-zinc-500">権限（拠点ごと）</span>
              <AccessEditor value={form.access} onChange={(access) => setForm({ ...form, access })} facilities={facilities} />
            </div>
            <label className="text-sm">
              <span className="text-xs text-zinc-500">通知先メール（承認依頼などのメールの宛先。空欄なら送らない）</span>
              <input
                type="email"
                value={form.notifyEmail}
                onChange={(e) => setForm({ ...form, notifyEmail: e.target.value })}
                className="mt-0.5 block w-full rounded-lg border border-zinc-300 px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
          </div>
        </section>

        {/* 一覧 */}
        <section className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">
              利用者の一覧（{filtered ? `${shown.length} / ` : ""}
              {users?.length ?? "…"}）
            </h2>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <button
                onClick={bulkTestMail}
                disabled={busy || !mailTargets.length}
                title="表示中の利用者のうち、有効で通知先メールがあり、まだテストメールを送っていない人に送ります"
                className="rounded-lg border border-sky-300 px-2.5 py-1.5 text-sky-700 disabled:opacity-40 dark:border-sky-900 dark:text-sky-400"
              >
                ✉ 未送信の{mailTargets.length}人にテストメール
              </button>
              <button onClick={exportCsv} disabled={!users?.length} className="rounded-lg border border-zinc-300 px-2.5 py-1.5 disabled:opacity-40 dark:border-zinc-700">
                ⬇ CSV出力（表示中の{shown.length}人）
              </button>
              <label className={`cursor-pointer rounded-lg border border-zinc-300 px-2.5 py-1.5 dark:border-zinc-700 ${busy || !users ? "pointer-events-none opacity-40" : ""}`}>
                ⬆ CSV取込（一括設定）
                <input
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) readCsv(f);
                  }}
                />
              </label>
            </div>
          </div>
          {progress && <p className="mt-2 text-xs text-sky-700">{progress}</p>}

          {/* 絞り込み */}
          <div className="mt-3 flex flex-wrap items-end gap-2 rounded-lg bg-zinc-50 p-2 text-xs dark:bg-zinc-900">
            <label className="min-w-40 flex-1">
              <span className="block text-zinc-500">検索</span>
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="ログインID・表示名・メール"
                className="mt-0.5 w-full rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            <label>
              <span className="block text-zinc-500">拠点</span>
              <select value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)} className="mt-0.5 rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950">
                <option value="">すべて</option>
                {facilities.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="block text-zinc-500">権限{siteFilter ? "（その拠点で）" : ""}</span>
              <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as Role | "")} className="mt-0.5 rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950">
                <option value="">すべて</option>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="block text-zinc-500">状態</span>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
                className="mt-0.5 rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
              >
                <option value="">すべて</option>
                <option value="active">有効</option>
                <option value="disabled">無効</option>
              </select>
            </label>
            <label>
              <span className="block text-zinc-500">テストメール</span>
              <select
                value={mailFilter}
                onChange={(e) => setMailFilter(e.target.value as typeof mailFilter)}
                className="mt-0.5 rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
              >
                <option value="">すべて</option>
                <option value="todo">未送信</option>
                <option value="done">送信済み</option>
                <option value="none">通知先なし</option>
              </select>
            </label>
            {filtered && (
              <button onClick={clearFilters} className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700">
                絞り込みを解除
              </button>
            )}
          </div>

          {/* CSV 取込の確認 */}
          {importPlan && (
            <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
              <p className="font-semibold">
                CSV取込の確認：{importPlan.file}（変更 {importPlan.changes.length}件・変更なし {importPlan.unchanged}件・エラー {importPlan.errors.length}件）
              </p>
              {importPlan.errors.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-xs text-red-700 dark:text-red-300">
                  {importPlan.errors.map((e, i) => (
                    <li key={i}>
                      {e.line}行目：{e.message}
                    </li>
                  ))}
                </ul>
              )}
              {importPlan.changes.length > 0 && (
                <table className="mt-2 w-full text-xs">
                  <tbody>
                    {importPlan.changes.map((c) => (
                      <tr key={c.line} className="border-t border-amber-200 align-top dark:border-amber-900">
                        <td className="whitespace-nowrap py-1 pr-2 text-zinc-500">{c.line}行目</td>
                        <td className="py-1 pr-2 font-mono">{c.loginId}</td>
                        <td className="py-1">{c.summary.join(" ／ ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">エラーの行は反映しません。直した CSV をもう一度取り込むこともできます。</p>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={applyImport}
                  disabled={busy || !importPlan.changes.length}
                  className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                >
                  {importPlan.changes.length}件を反映する
                </button>
                <button onClick={() => setImportPlan(null)} disabled={busy} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs dark:border-zinc-700">
                  やめる
                </button>
              </div>
            </div>
          )}
          {!users ? (
            <p className="mt-2 text-sm text-zinc-500">読み込み中…</p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[1100px] text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800">
                    <th className="py-1.5 pr-2">ログインID</th>
                    <th className="pr-2">表示名・通知先メール</th>
                    <th className="pr-2">権限</th>
                    <th className="pr-2">最終ログイン</th>
                    <th className="pr-2">状態・テストメール</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((u) => {
                    const edit = edits[u.id];
                    const access = edit?.access ?? accessOfUser(u);
                    const name = edit?.name ?? u.name;
                    const notifyEmail = edit?.notifyEmail ?? u.notifyEmail;
                    const dirty =
                      u.rolesUnset ||
                      (!!edit && (edit.name !== u.name || !sameAccess(edit.access, accessOfUser(u)) || edit.notifyEmail !== u.notifyEmail));
                    const isMe = u.id === meId;
                    const setEdit = (patch: Partial<{ access: Access; name: string; notifyEmail: string }>) =>
                      setEdits((m) => ({ ...m, [u.id]: { access, name, notifyEmail, ...patch } }));
                    return (
                      <tr key={u.id} className={`border-b border-zinc-100 align-top dark:border-zinc-900 ${u.disabled ? "opacity-50" : ""}`}>
                        <td className="py-2 pr-2">
                          <span className="font-mono">{u.loginId}</span>
                          {isMe && <span className="ml-1 text-[10px] text-sky-700">（自分）</span>}
                          <span className="block text-[10px] text-zinc-400">{u.email}</span>
                        </td>
                        <td className="py-1.5 pr-2">
                          <input
                            value={name}
                            onChange={(e) => setEdit({ name: e.target.value })}
                            disabled={u.disabled}
                            className="w-36 rounded border border-zinc-200 px-1.5 py-1 dark:border-zinc-800 dark:bg-zinc-900"
                          />
                          <input
                            type="email"
                            value={notifyEmail}
                            onChange={(e) => setEdit({ notifyEmail: e.target.value })}
                            disabled={u.disabled}
                            placeholder="通知先メール"
                            title="承認依頼などのメールの宛先（空欄なら送らない）"
                            className="mt-1 block w-36 rounded border border-zinc-200 px-1.5 py-1 text-xs dark:border-zinc-800 dark:bg-zinc-900"
                          />
                        </td>
                        <td className="py-2 pr-2">
                          <AccessEditor
                            value={access}
                            onChange={(a) => setEdit({ access: a })}
                            facilities={facilities}
                            lockAdmin={u.envAdmin}
                            disabled={u.disabled}
                          />
                          {u.rolesUnset && <span className="text-[10px] text-amber-700">権限が未設定のため、全拠点で作業者として扱っています</span>}
                          {!u.siteRoles && !u.rolesUnset && <span className="block text-[10px] text-amber-700">拠点ごとに分けるまでは、全拠点で同じ権限です</span>}
                        </td>
                        <td className="py-2 pr-2 text-xs text-zinc-500">{fmt(u.lastSignInAt)}</td>
                        <td className="py-2 pr-2">
                          {u.disabled ? (
                            <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs text-zinc-700">無効</span>
                          ) : (
                            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-800">有効</span>
                          )}
                          <span className="mt-1 block whitespace-nowrap text-[10px] text-zinc-500">
                            {!u.notifyEmail ? (
                              "通知先なし"
                            ) : u.testMailDone ? (
                              <>
                                <span className="text-emerald-700" title={fmt(u.testMail?.at ?? null)}>
                                  ✉ テスト送信済み
                                </span>
                                <button
                                  disabled={busy}
                                  onClick={() => run(() => post({ action: "resetTestMail", id: u.id }), `「${u.loginId}」のテストメールを未送信に戻しました`)}
                                  className="ml-1 text-sky-700 underline"
                                  title="届かなかったときなど、一括送信の対象に戻します"
                                >
                                  未送信に戻す
                                </button>
                              </>
                            ) : (
                              <span className="text-amber-700">✉ テスト未送信</span>
                            )}
                          </span>
                        </td>
                        <td className="whitespace-nowrap py-1.5 text-right">
                          {!u.disabled && (
                            <button
                              disabled={busy || !dirty || !hasAnyRole(access)}
                              onClick={() =>
                                run(async () => {
                                  await post({ action: "update", id: u.id, name, notifyEmail, ...access });
                                  if (isMe) refreshMe();
                                }, `「${u.loginId}」を保存しました`)
                              }
                              className="rounded-lg bg-zinc-900 px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-30 dark:bg-zinc-100 dark:text-zinc-900"
                            >
                              保存
                            </button>
                          )}
                          {!u.disabled && u.notifyEmail && (
                            <button
                              disabled={busy}
                              title={
                                u.testMailDone ? `${fmt(u.testMail?.at ?? null)} に送信済みです。もう一度送ります` : "通知先メールにテストメールを送ります（メールの設定の確認）"
                              }
                              onClick={() => {
                                if (u.testMailDone && !confirm(`「${u.notifyEmail}」には ${fmt(u.testMail?.at ?? null)} にテストメールを送信済みです。もう一度送りますか？`)) return;
                                run(() => post({ action: "testMail", id: u.id, force: u.testMailDone }), `「${u.notifyEmail}」にテストメールを送りました。届いたか確認してください`);
                              }}
                              className="ml-1 rounded-lg border border-sky-300 px-2.5 py-1 text-xs text-sky-700 dark:border-sky-900 dark:text-sky-400"
                            >
                              {u.testMailDone ? "再送" : "テストメール"}
                            </button>
                          )}
                          {!u.disabled && (
                            <button
                              disabled={busy}
                              onClick={() => {
                                const pw = prompt(`「${u.loginId}」の新しいパスワード（8文字以上）`);
                                if (pw) run(() => post({ action: "password", id: u.id, password: pw }), `「${u.loginId}」のパスワードを変更しました`);
                              }}
                              className="ml-1 rounded-lg border border-zinc-300 px-2.5 py-1 text-xs dark:border-zinc-700"
                            >
                              パスワード
                            </button>
                          )}
                          {u.disabled ? (
                            <button
                              disabled={busy}
                              onClick={() => run(() => post({ action: "enable", id: u.id }), `「${u.loginId}」を有効に戻しました`)}
                              className="ml-1 rounded-lg border border-emerald-400 px-2.5 py-1 text-xs text-emerald-700"
                            >
                              有効に戻す
                            </button>
                          ) : (
                            !isMe && (
                              <button
                                disabled={busy}
                                onClick={() => {
                                  if (confirm(`「${u.loginId}」を無効にしますか？（ログインできなくなります。記録は残ります。あとで有効に戻せます）`)) {
                                    run(() => post({ action: "disable", id: u.id }), `「${u.loginId}」を無効にしました`);
                                  }
                                }}
                                className="ml-1 rounded-lg border border-red-300 px-2.5 py-1 text-xs text-red-700 dark:border-red-900"
                              >
                                無効にする
                              </button>
                            )
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-zinc-500">
            CSV出力は表示中の利用者を、権限は拠点ごとの列（「チームリーダー・制御室」のように「・」区切り、空欄は権限なし）で出します。Excel
            で直して取り込むと、違うところだけをまとめて反映します（反映前に確認を表示）。新しい利用者の行には初期パスワード（8文字以上）を入れてください。ログインIDの変更・利用者の削除は
            CSV ではできません。
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            テストメールは、送れたアドレスを記録し、一括送信では同じアドレスにもう一度送りません（通知先を変えると未送信に戻ります）。
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            無効にした利用者はログインできなくなります（配管系統図の画面は次の操作で、ほかの画面も最長1時間でログインが切れます）。利用者の削除はできません（点検記録に名前が残るため）。
          </p>
        </section>
      </div>
    </main>
  );
}
