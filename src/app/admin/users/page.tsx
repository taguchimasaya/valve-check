"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import UserBadge from "@/components/UserBadge";
import { authFetch, refreshMe } from "@/lib/auth";
import { ROLE_DESC, ROLE_LABEL, ROLES, type Role } from "@/lib/roles";
import type { AdminUser } from "@/app/api/admin/users/route";

// ユーザー管理（管理者のみ）。利用者の作成・権限の変更・無効化は /api/admin/users（service role キー）で行う。

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

function RoleChecks({ value, onChange, lock }: { value: Role[]; onChange: (v: Role[]) => void; lock?: Role[] }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {ROLES.map((r) => {
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
          <label key={r} title={ROLE_DESC[r]} className={`flex items-center gap-1 text-sm ${locked ? "font-semibold text-zinc-500" : ""}`}>
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
  const [showDisabled, setShowDisabled] = useState(true);
  // 権限・名前の編集中の値（利用者ID → 値）
  const [edits, setEdits] = useState<Record<string, { roles: Role[]; name: string }>>({});
  // 新しい利用者
  const [form, setForm] = useState<{ loginId: string; name: string; password: string; roles: Role[] }>({
    loginId: "",
    name: "",
    password: "",
    roles: ["worker"],
  });

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

  const shown = useMemo(() => (users ?? []).filter((u) => showDisabled || !u.disabled), [users, showDisabled]);
  const counts = useMemo(() => {
    const active = (users ?? []).filter((u) => !u.disabled);
    return Object.fromEntries(ROLES.map((r) => [r, active.filter((u) => u.roles.includes(r)).length])) as Record<Role, number>;
  }, [users]);

  const create = () =>
    run(async () => {
      await post({ action: "create", ...form });
      setForm({ loginId: "", name: "", password: "", roles: ["worker"] });
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
          利用者の作成・権限の変更・無効化を行います。権限は複数付けられます（例：承認者＋制御室）。権限の変更は次に画面を開いたときから反映されます。
        </p>
        <ul className="mt-2 grid gap-1 text-xs text-zinc-600 sm:grid-cols-2 dark:text-zinc-400">
          {ROLES.map((r) => (
            <li key={r}>
              <b className="text-zinc-800 dark:text-zinc-200">{ROLE_LABEL[r]}</b>（有効 {counts[r] ?? 0}人）：{ROLE_DESC[r]}
            </li>
          ))}
        </ul>

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
              disabled={busy || !form.loginId.trim() || form.password.length < 8 || form.roles.length === 0}
              className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
            >
              作成する
            </button>
          </div>
          <div className="mt-2">
            <span className="text-xs text-zinc-500">権限</span>
            <RoleChecks value={form.roles} onChange={(roles) => setForm({ ...form, roles })} />
          </div>
        </section>

        {/* 一覧 */}
        <section className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">利用者の一覧（{users?.length ?? "…"}）</h2>
            <label className="flex items-center gap-1 text-xs text-zinc-600">
              <input type="checkbox" checked={showDisabled} onChange={(e) => setShowDisabled(e.target.checked)} />
              無効の利用者も表示
            </label>
          </div>
          {!users ? (
            <p className="mt-2 text-sm text-zinc-500">読み込み中…</p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[860px] text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800">
                    <th className="py-1.5 pr-2">ログインID</th>
                    <th className="pr-2">表示名</th>
                    <th className="pr-2">権限</th>
                    <th className="pr-2">最終ログイン</th>
                    <th className="pr-2">状態</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((u) => {
                    const edit = edits[u.id];
                    const roles = edit?.roles ?? u.roles;
                    const name = edit?.name ?? u.name;
                    const dirty = u.rolesUnset || (!!edit && (edit.name !== u.name || edit.roles.join() !== u.roles.join()));
                    const isMe = u.id === meId;
                    const setEdit = (patch: Partial<{ roles: Role[]; name: string }>) =>
                      setEdits((m) => ({ ...m, [u.id]: { roles, name, ...patch } }));
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
                        </td>
                        <td className="py-2 pr-2">
                          <RoleChecks value={roles} onChange={(r) => setEdit({ roles: r })} lock={u.envAdmin ? ["admin"] : undefined} />
                          {u.rolesUnset && <span className="text-[10px] text-amber-700">権限が未設定のため作業者として扱っています</span>}
                          {u.envAdmin && <span className="block text-[10px] text-zinc-500">ADMIN_LOGIN_IDS で管理者に指定</span>}
                        </td>
                        <td className="py-2 pr-2 text-xs text-zinc-500">{fmt(u.lastSignInAt)}</td>
                        <td className="py-2 pr-2">
                          {u.disabled ? (
                            <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs text-zinc-700">無効</span>
                          ) : (
                            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-800">有効</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap py-1.5 text-right">
                          {!u.disabled && (
                            <button
                              disabled={busy || !dirty || roles.length === 0}
                              onClick={() =>
                                run(async () => {
                                  await post({ action: "update", id: u.id, name, roles });
                                  if (isMe) refreshMe();
                                }, `「${u.loginId}」を保存しました`)
                              }
                              className="rounded-lg bg-zinc-900 px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-30 dark:bg-zinc-100 dark:text-zinc-900"
                            >
                              保存
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
            無効にした利用者はログインできなくなります（配管系統図の画面は次の操作で、ほかの画面も最長1時間でログインが切れます）。利用者の削除はできません（点検記録に名前が残るため）。
          </p>
        </section>
      </div>
    </main>
  );
}
