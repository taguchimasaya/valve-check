"use client";

import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMe, useSession } from "@/lib/auth";
import { canOpen, deniedMessage, pagePerms, ROLE_LABEL } from "@/lib/roles";

// ログインしていなければログイン画面へ。ログイン後は元の画面（QRで開いた画面を含む）へ戻る。
// ページごとに必要な権限（src/lib/roles.ts の PAGE_PERMS）が無ければ、中身を出さずに案内を出す。
// ※ 画面での制限は表示のためのもの。操作の可否は API（/api/*）と DB 側でも確かめる。

const PUBLIC_PATHS = ["/login"];

function Message({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 text-sm text-zinc-500 dark:bg-black">
      <div className="text-center">{children}</div>
    </div>
  );
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const session = useSession();
  const me = useMe();
  const pathname = usePathname();
  const router = useRouter();
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  useEffect(() => {
    if (isPublic || session !== null) return;
    const next = window.location.pathname + window.location.search;
    router.replace(`/login?next=${encodeURIComponent(next)}`);
  }, [isPublic, session, router]);

  if (isPublic) return <>{children}</>;
  if (!session) return <Message>{session === undefined ? "読み込み中…" : "ログイン画面へ移動しています…"}</Message>;
  if (me === undefined) return <Message>読み込み中…</Message>;
  if (me === null) {
    return (
      <Message>
        <p>利用者の権限を読み込めませんでした。</p>
        <button onClick={() => window.location.reload()} className="mt-2 text-emerald-700 underline">
          読み込み直す
        </button>
      </Message>
    );
  }
  if (!canOpen(me.roles, pathname)) {
    return (
      <Message>
        <p className="text-base font-semibold text-zinc-800 dark:text-zinc-100">このページを開く権限がありません</p>
        <p className="mt-2">{deniedMessage(pagePerms(pathname) ?? [])}。</p>
        <p className="mt-1 text-xs">
          あなたの権限：{me.roles.map((r) => ROLE_LABEL[r]).join("・") || "なし"}（変更は管理者に依頼してください）
        </p>
        <Link href="/" className="mt-4 inline-block text-emerald-700 underline dark:text-emerald-400">
          ホームに戻る
        </Link>
      </Message>
    );
  }
  return <>{children}</>;
}
