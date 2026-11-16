"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import UserBadge from "@/components/UserBadge";
import { authFetch, refreshMe } from "@/lib/auth";
import { LOCKED_GRANTS, PERMISSION_INFO, PERMISSIONS, ROLE_LABEL, ROLES, type Grants, type Permission, type Role } from "@/lib/roles";

// 権限の設定：ロール（作業者・チームリーダー・G長・制御室・管理者）ごとに使える機能を、権限×機能の表で決める（全拠点共通）。
// 保存は /api/admin/roles（DB の app_settings）。画面・API・DB 側の制限（RLS）がこの表を読む。

type Loaded = { grants: Grants; defaults: Grants; stored: boolean; tableMissing: boolean };

async function call(init?: RequestInit): Promise<Loaded> {
  const res = await authFetch("/api/admin/roles", { cache: "no-store", ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body as Loaded;
}

const locked = (r: Role, p: Permission) => !!LOCKED_GRANTS[r]?.includes(p);
const groups = [...new Set(PERMISSIONS.map((p) => PERMISSION_INFO[p].group))];

export default function RolesPage() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState<Grants | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const l = await call();
      setLoaded(l);
      setDraft(structuredClone(l.grants));
    } catch (e) {
      setMessage({ type: "err", text: `読み込めませんでした：${e instanceof Error ? e.message : String(e)}` });
    }
  }, []);
  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  const dirty = useMemo(() => !!loaded && !!draft && JSON.stringify(loaded.grants) !== JSON.stringify(draft), [loaded, draft]);
  const isDefault = useMemo(() => !!loaded && !!draft && JSON.stringify(loaded.defaults) === JSON.stringify(draft), [loaded, draft]);

  function toggle(r: Role, p: Permission) {
    if (!draft || locked(r, p)) return;
    const has = draft[r].includes(p);
    setDraft({ ...draft, [r]: PERMISSIONS.filter((x) => (x === p ? !has : draft[r].includes(x))) });
  }

  async function save(reset = false) {
    if (!draft) return;
    const warn = reset
      ? "権限×機能の表を既定に戻しますか？"
      : `権限×機能の表を保存しますか？\n保存すると、全拠点の利用者の画面・操作にすぐ反映されます（開いている画面は再読み込みで反映）。${
          !ROLES.some((r) => r !== "admin" && draft[r].includes("create")) ? "\n\n⚠ チェックリストを作成できるロールがありません。" : ""
        }${draft.admin.includes("create") ? "\n\n⚠ 管理者に作成を付けると、管理者が作ったチェックリストは別の人が承認する必要があります。" : ""}`;
    if (!confirm(warn)) return;
    setBusy(true);
    setMessage(null);
    try {
      const l = await call({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reset ? { reset: true } : { grants: draft }),
      });
      setLoaded(l);
      setDraft(structuredClone(l.grants));
      refreshMe();
      setMessage({ type: "ok", text: reset ? "既定の表に戻しました。" : "保存しました。各画面は再読み込みすると新しい表で動きます。" });
    } catch (e) {
      setMessage({ type: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-zinc-50 px-4 py-6 dark:bg-black">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-4">
            <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400">
              ← ホーム
            </Link>
            <Link href="/admin/users" className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400">
              ← ユーザー管理
            </Link>
          </div>
          <UserBadge />
        </div>
        <h1 className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">🔑 権限の設定</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          権限（ロール）ごとに、使える機能を決めます（全拠点共通）。利用者にどの権限を付けるかは
          <Link href="/admin/users" className="text-sky-700 underline dark:text-sky-400">
            ユーザー管理
          </Link>
          で拠点ごとに決めます。画面のメニュー・ページの入口・保存の操作・DB 側の制限のすべてがこの表で判断します。
        </p>

        {message && (
          <p
            className={`mt-3 whitespace-pre-line rounded-lg px-3 py-2 text-sm ${
              message.type === "ok" ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" : "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"
            }`}
          >
            {message.text}
          </p>
        )}
        {loaded?.tableMissing && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            保存先のテーブルがまだありません。<code>supabase/role_grants.sql</code> を Supabase の SQL Editor で実行すると保存できるようになります（それまでは既定の表で動きます）。
          </p>
        )}

        {!draft ? (
          <p className="mt-4 text-sm text-zinc-500">読み込み中…</p>
        ) : (
          <section className="mt-4 overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-zinc-50 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">機能</th>
                  {ROLES.map((r) => (
                    <th key={r} className="px-2 py-2 text-center font-medium whitespace-nowrap">
                      {ROLE_LABEL[r]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groups.map((grp) => (
                  <GroupRows key={grp} group={grp} draft={draft} defaults={loaded!.defaults} onToggle={toggle} />
                ))}
              </tbody>
            </table>
          </section>
        )}

        {draft && (
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            <span className="mr-auto text-xs text-zinc-500">
              {loaded?.stored ? "保存した表で動いています。" : "既定の表で動いています。"}
              ◆＝既定と違う　🔒＝外せない（管理者のユーザー管理）
            </span>
            {dirty && (
              <button onClick={() => setDraft(structuredClone(loaded!.grants))} disabled={busy} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700">
                変更を取り消す
              </button>
            )}
            {loaded?.stored && (
              <button onClick={() => save(true)} disabled={busy || loaded.tableMissing} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700">
                既定に戻す
              </button>
            )}
            <button
              onClick={() => save(false)}
              disabled={busy || !dirty || loaded?.tableMissing}
              className="rounded-lg bg-emerald-700 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
            >
              保存する
            </button>
          </div>
        )}
        {draft && !isDefault && !dirty && <p className="mt-1 text-right text-xs text-zinc-500">既定と違う設定で動いています。</p>}

        <ul className="mt-4 list-disc space-y-1 pl-5 text-xs text-zinc-500">
          <li>作成した本人は、どの権限でも自分のチェックリストを承認できません。作成と承認は別のロールに分けてください。</li>
          <li>承認の段（チームリーダー・G長・制御室）は、その段の承認の機能を持つロールの人が承認します。承認のお知らせのメールは、管理者以外でその段を承認できる人に送ります（いなければ管理者）。</li>
          <li>表の変更は保存するとすぐ効きます。利用者に付けた権限（ロール）の変更は、DB 側では次のログインの更新（最長1時間）から効きます。</li>
        </ul>
      </div>
    </main>
  );
}

function GroupRows({
  group,
  draft,
  defaults,
  onToggle,
}: {
  group: string;
  draft: Grants;
  defaults: Grants;
  onToggle: (r: Role, p: Permission) => void;
}) {
  const perms = PERMISSIONS.filter((p) => PERMISSION_INFO[p].group === group);
  return (
    <>
      <tr className="border-t border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900/60">
        <td colSpan={ROLES.length + 1} className="px-3 py-1 text-xs font-semibold text-zinc-500">
          {group}
        </td>
      </tr>
      {perms.map((p) => (
        <tr key={p} className="border-t border-zinc-100 dark:border-zinc-800">
          <td className="px-3 py-2">
            <p className="font-medium text-zinc-900 dark:text-zinc-100">{PERMISSION_INFO[p].label}</p>
            <p className="text-xs text-zinc-500">{PERMISSION_INFO[p].desc}</p>
          </td>
          {ROLES.map((r) => {
            const on = draft[r].includes(p);
            const changed = on !== defaults[r].includes(p);
            const lock = locked(r, p);
            return (
              <td key={r} className="px-2 py-2 text-center">
                <label className={`inline-flex items-center gap-1 ${lock ? "cursor-not-allowed" : "cursor-pointer"}`}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={lock}
                    onChange={() => onToggle(r, p)}
                    aria-label={`${ROLE_LABEL[r]}：${PERMISSION_INFO[p].label}`}
                    className="h-4 w-4 accent-emerald-700"
                  />
                  {lock && <span title="外せません">🔒</span>}
                  {changed && <span className="text-amber-600" title="既定と違います">◆</span>}
                </label>
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}
