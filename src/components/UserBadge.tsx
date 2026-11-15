"use client";

import { useRouter } from "next/navigation";
import { displayName, signOut, useMe, useSession } from "@/lib/auth";
import { ROLE_LABEL } from "@/lib/roles";

/** ログイン中の利用者名とログアウト */
export default function UserBadge() {
  const session = useSession();
  const me = useMe();
  const router = useRouter();
  if (!session) return null;
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
        👤 {displayName(session.user)}
        {me && me.roles.length > 0 && (
          <span className="ml-1.5 text-xs text-zinc-500 dark:text-zinc-400">（{me.roles.map((r) => ROLE_LABEL[r]).join("・")}）</span>
        )}
      </span>
      <button
        onClick={async () => {
          await signOut();
          router.replace("/login");
        }}
        className="text-xs text-zinc-500 underline hover:text-zinc-700 dark:text-zinc-400"
      >
        ログアウト
      </button>
    </div>
  );
}
