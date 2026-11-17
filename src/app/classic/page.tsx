"use client";

import Link from "next/link";
import UserBadge from "@/components/UserBadge";
import { useMe } from "@/lib/auth";
import { canOpen } from "@/lib/roles";

// 従来方式（チェックリスト単体）のメニュー。トップの入口から開く。
const CLASSIC_FEATURES = [
  {
    title: "機器マスター / QR発行",
    desc: "機器マスターをインポートし、機器ごとにQRコードを発行します。",
    href: "/equipment",
  },
  {
    title: "機器QRコード印刷",
    desc: "機器マスターに登録済みの機器のQRコードを印刷・画像出力します。",
    href: "/equipment/print",
  },
  {
    title: "チェックリスト取込",
    desc: "既存のExcelチェックリストを読み込み、点検項目として登録します。",
    href: "/checklists",
  },
  {
    title: "現場チェック（iPad）",
    desc: "QRコードを読み取り、対象バルブのチェックリストにその場で記録します。",
    href: "/inspect",
  },
  {
    title: "点検ダッシュボード（制御室PC）",
    desc: "現場のチェック状況をリアルタイムに確認します。",
    href: "/control-room",
  },
];

export default function ClassicMenu() {
  const me = useMe();
  // 権限で開けないメニューは出さない
  const visible = CLASSIC_FEATURES.filter((f) => canOpen(me?.roles, f.href));
  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-16 dark:bg-black">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between gap-4">
          <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400">
            ← トップに戻る
          </Link>
          <UserBadge />
        </div>
        <h1 className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">従来方式（チェックリスト単体）</h1>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">
          Excel のチェックリストを取り込み、QRコードの読み取りで弁ごとに記録する方式です。
        </p>

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {visible.map((f) => (
            <Link key={f.href} href={f.href}>
              <div className="h-full rounded-xl border border-zinc-200 bg-white p-5 transition-colors hover:border-emerald-400 dark:border-zinc-800 dark:bg-zinc-950">
                <h2 className="font-medium text-zinc-900 dark:text-zinc-50">{f.title}</h2>
                <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{f.desc}</p>
              </div>
            </Link>
          ))}
        </div>
        {me && visible.length === 0 && (
          <p className="mt-8 text-sm text-zinc-500">この方式で使える機能がありません（権限の変更は管理者に依頼してください）。</p>
        )}
      </div>
    </main>
  );
}
