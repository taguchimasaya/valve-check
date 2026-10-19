"use client";

import Link from "next/link";
import PipingDiagram from "@/components/piping/PipingDiagram";
import { normalValveState } from "@/lib/piping/graph";
import { useGraph } from "@/lib/piping/usePiping";

const menus = [
  {
    no: "①",
    title: "抜取チェックリスト作成",
    desc: "図面上で抜取対象の機器を選ぶと、ドレン口までの遮断範囲・操作バルブ・液封リスク・抜取量／時間を算定し、チェックリストを作成します。",
    href: "/piping/planner",
  },
  {
    no: "②",
    title: "現場点検（図面ビュー）",
    desc: "作成したチェックリスト（または既存形式のExcel）を図面上に表示し、QR読取・タップで操作を記録します。",
    href: "/piping/field",
  },
  {
    no: "③",
    title: "制御室（図面ビュー）",
    desc: "運用パターン・タンク・ポンプを入力して運用ラインを表示し、点検ラインの点滅・操作済みバルブの点灯で進捗を確認します。",
    href: "/piping/control",
  },
  {
    no: "QR",
    title: "機器QRコード印刷",
    desc: "系統図で使っているバルブ・ドレン弁・圧力計元弁のQRコードを印刷します（既存の機器QRと同じ形式）。",
    href: "/piping/qr",
  },
];

export default function PipingHome() {
  const graph = useGraph();
  const valves = graph.facility.nodes.filter((n) => n.kind === "valve").length;
  const drains = graph.facility.nodes.filter((n) => n.kind === "drain").length;

  return (
    <main className="min-h-screen bg-zinc-50 px-4 py-8 dark:bg-black">
      <div className="mx-auto max-w-6xl">
        <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400">
          ← ホームに戻る
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-2">
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">配管系統図（試作）</h1>
          <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            既存の機器マスター・チェックリストとは別に保存します
          </span>
        </div>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          {graph.facility.name}：受入2系統・貯蔵タンク6基×2ヤード・払出ポンプ2系統（各3台）・移送ポンプ2台。
          バルブ{valves}箇所、ドレン口{drains}箇所、配管区間{graph.sections.length}区間。
        </p>

        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {menus.map((m) => (
            <Link
              key={m.href}
              href={m.href}
              className="rounded-xl border border-zinc-200 bg-white p-5 transition-colors hover:border-emerald-400 dark:border-zinc-800 dark:bg-zinc-950"
            >
              <h2 className="font-medium text-zinc-900 dark:text-zinc-50">
                <span className="mr-1 text-emerald-600">{m.no}</span>
                {m.title}
              </h2>
              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{m.desc}</p>
            </Link>
          ))}
        </div>

        <div className="mt-6">
          <PipingDiagram graph={graph} valveState={normalValveState(graph.facility)} height="65vh" />
          <p className="mt-2 text-xs text-zinc-500">
            待機時の弁状態を表示しています（緑＝開、赤＝閉）。ストレーナー・フィルターは並列、ポンプは流れ方向を三角で表示。
          </p>
        </div>
      </div>
    </main>
  );
}
