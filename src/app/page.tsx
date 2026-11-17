"use client";

import Link from "next/link";
import UserBadge from "@/components/UserBadge";
import { useMe } from "@/lib/auth";
import { canOpen } from "@/lib/roles";

// トップは2つの入口だけ：従来方式（チェックリスト単体）と新方式（図面連動方式）
const CLASSIC_PAGES = ["/equipment", "/equipment/print", "/checklists", "/inspect", "/control-room"];

const entrances = [
  {
    title: "従来方式（チェックリスト単体）",
    desc: "Excel のチェックリストを取り込み、QRコードの読み取りで弁ごとに記録します。機器マスター・QR発行・現場チェック・点検ダッシュボード。",
    href: "/classic",
    pages: CLASSIC_PAGES,
  },
  {
    title: "新方式（図面連動方式）",
    desc: "配管系統図から抜取範囲と操作する弁を算定してチェックリストを作り、図面上で現場点検・制御室の確認を行います。",
    href: "/piping",
    pages: null, // 配管系統図トップは誰でも開ける
  },
];

export default function Home() {
  const me = useMe();
  // 従来方式は、中の機能を1つも開けない人には出さない
  const visible = entrances.filter((e) => !e.pages || e.pages.some((p) => canOpen(me?.roles, p)));
  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-16 dark:bg-black">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Valve Inspection App</p>
            <h1 className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">バルブ点検アプリ</h1>
          </div>
          <div className="flex items-center gap-4">
            <UserBadge />
            {canOpen(me?.roles, "/admin/users") && (
              <Link href="/admin/users" className="text-sm text-zinc-600 hover:text-zinc-800 dark:text-zinc-400">
                👥 ユーザー管理
              </Link>
            )}
            <Link href="/settings" className="text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300">
              <span className="text-2xl">⚙️</span>
            </Link>
          </div>
        </div>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">点検の方式を選んでください。</p>

        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {visible.map((e) => (
            <Link key={e.href} href={e.href}>
              <div className="h-full rounded-xl border border-zinc-200 bg-white p-6 transition-colors hover:border-emerald-400 dark:border-zinc-800 dark:bg-zinc-950">
                <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{e.title}</h2>
                <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{e.desc}</p>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </main>
  );
}
