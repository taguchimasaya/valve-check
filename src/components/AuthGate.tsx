"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useSession } from "@/lib/auth";

// ログインしていなければログイン画面へ。ログイン後は元の画面（QRで開いた画面を含む）へ戻る。

const PUBLIC_PATHS = ["/login"];

export default function AuthGate({ children }: { children: ReactNode }) {
  const session = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  useEffect(() => {
    if (isPublic || session !== null) return;
    const next = window.location.pathname + window.location.search;
    router.replace(`/login?next=${encodeURIComponent(next)}`);
  }, [isPublic, session, router]);

  if (isPublic) return <>{children}</>;
  if (!session) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 text-sm text-zinc-500 dark:bg-black">
        {session === undefined ? "読み込み中…" : "ログイン画面へ移動しています…"}
      </div>
    );
  }
  return <>{children}</>;
}
