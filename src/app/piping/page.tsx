"use client";

import { useMemo } from "react";
import Link from "next/link";
import PipingDiagram, { DiagramLegend } from "@/components/piping/PipingDiagram";
import { liveDiagram, OUTAGE_COLOR } from "@/lib/piping/live";
import { describeOperation, OPERATION_META, type OperationKind } from "@/lib/piping/operations";
import { useGraph, usePipingStore } from "@/lib/piping/usePiping";

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
  // 今の運用・点検状況（数秒ごとに更新）
  const { store, error } = usePipingStore(3000);
  const live = useMemo(() => liveDiagram(graph, store), [graph, store]);
  const opRoutes = live.opState.routes.filter((r) => !r.error);
  const overrideCount = Object.keys(store?.valveOverrides ?? {}).length;
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

        <div className="mt-6 grid gap-4 md:grid-cols-3 xl:grid-cols-5">
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

        <section className="mt-6 space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">現在の運用・点検状況</h2>
            <span className="text-xs text-zinc-500">
              {store ? `自動更新中（${new Date().toLocaleTimeString("ja-JP")} 時点）` : "読み込み中…"}
              {error && <span className="ml-2 text-red-600">{error}</span>}
            </span>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <div className="rounded-xl border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-950">
              <p className="text-xs font-semibold text-zinc-500">運用中（{opRoutes.length}）</p>
              {opRoutes.length === 0 ? (
                <p className="mt-1 text-zinc-400">運用中のラインはありません（待機状態）。</p>
              ) : (
                <ul className="mt-1 space-y-0.5">
                  {opRoutes.map((r) => (
                    <li key={r.op.id} className="flex items-start gap-2">
                      <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: OPERATION_META[r.op.kind].color }} />
                      <span>
                        <b>{OPERATION_META[r.op.kind].label}</b>：{describeOperation(r.op)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {overrideCount > 0 && <p className="mt-1 text-xs text-violet-700 dark:text-violet-300">制御室で手動変更した弁：{overrideCount}箇所</p>}
            </div>
            <div className="rounded-xl border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-950">
              <p className="text-xs font-semibold text-zinc-500">点検中（{live.views.length}）</p>
              {live.views.length === 0 ? (
                <p className="mt-1 text-zinc-400">点検中の作業はありません。</p>
              ) : (
                <ul className="mt-1 space-y-0.5">
                  {live.views.map(({ exec, plan, v }) => (
                    <li key={exec.id}>
                      <b>{exec.planName}</b>
                      <span className="ml-2 text-zinc-600 dark:text-zinc-400">
                        {plan.steps[exec.currentStep]}（{v.done}/{v.total}）
                        {v.stepComplete && <span className="ml-1 font-semibold text-emerald-600">工程完了</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          {live.outages.length > 0 && (
            <div className="rounded-xl border-2 border-slate-600 bg-slate-50 p-3 text-sm dark:bg-slate-900">
              <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">運用停止中（{live.outages.length}）</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {live.outages.map((o) => (
                  <span key={o.def.key} title={o.def.desc} className="rounded bg-slate-700 px-2 py-0.5 text-xs font-semibold text-white">
                    {o.def.label}
                    <span className="ml-1 font-normal opacity-80">
                      {new Date(o.at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}〜
                    </span>
                  </span>
                ))}
              </div>
              {live.outageConflicts.map((c) => (
                <p key={c} className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                  ⚠ {c}
                </p>
              ))}
            </div>
          )}
          <PipingDiagram
            graph={graph}
            valveState={live.valveState}
            layers={live.layers}
            boxes={live.boxes}
            marks={live.marks}
            height="65vh"
          />
          <DiagramLegend
            items={[
              ...(Object.keys(OPERATION_META) as OperationKind[]).map((k) => ({
                color: OPERATION_META[k].color,
                label: `${OPERATION_META[k].label}ライン`,
              })),
              { color: "#ef4444", label: "点検範囲（点滅）" },
              { color: OUTAGE_COLOR, label: "運用停止範囲（灰色の破線・枠）" },
              { color: "#0284c7", label: "抜取の流れ" },
              { color: "#0d9488", label: "充填の流れ" },
              { color: "#dc2626", label: "閉操作待ち", kind: "blink" as const },
              { color: "#2563eb", label: "開操作待ち", kind: "blink" as const },
              { color: "#f59e0b", label: "確認待ち", kind: "blink" as const },
              { color: "#22c55e", label: "操作済み", kind: "ring" as const },
              { color: "#7c3aed", label: "手動で開閉変更", kind: "ring" as const },
            ]}
          />
          <p className="text-xs text-zinc-500">
            弁の色は今の開閉（緑＝開、赤＝閉）です。操作や確認は ② 現場点検・③ 制御室で行います（この図面は表示のみ）。
          </p>
        </section>
      </div>
    </main>
  );
}
