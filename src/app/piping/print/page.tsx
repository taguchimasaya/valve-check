"use client";

import { Suspense, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import PipingDiagram, { DiagramLegend, type NodeMark, type PipeLayer } from "@/components/piping/PipingDiagram";
import { needsFillSupply, ROLE_LABEL, stateAtStep, stateGlyph, isOperateCell, type SavedPlan } from "@/lib/piping/checklist";
import { stepFlow } from "@/lib/piping/flow";
import { normalValveState, type Graph } from "@/lib/piping/graph";
import { formatLiters, formatMinutes } from "@/lib/piping/isolation";
import { stepOps, workBounds } from "@/lib/piping/print";
import { execPlan, type Execution } from "@/lib/piping/store";
import { useGraph, usePipingStore } from "@/lib/piping/usePiping";

// 印刷用（PDF保存用）のページ：チェックリスト（全工程）と、工程ごとの図面。
// ブラウザの印刷機能で「PDFに保存」を選ぶと PDF になる。

const PRINT_CSS = `
@page { size: A4 landscape; margin: 9mm; }
@media print {
  html, body { background: white !important; }
  .print-page { break-after: page; }
  .print-page:last-child { break-after: auto; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
}
`;

export default function PrintPage() {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-zinc-500">読み込み中…</p>}>
      <PrintContent />
    </Suspense>
  );
}

function PrintContent() {
  const params = useSearchParams();
  const g = useGraph();
  const { store, error } = usePipingStore(0);
  const [withChecklist, setWithChecklist] = useState(true);
  const [withDrawings, setWithDrawings] = useState(true);

  const exec = store?.executions.find((e) => e.id === params.get("exec")) ?? null;
  const rawPlan = store?.plans.find((p) => p.id === (params.get("plan") ?? exec?.planId)) ?? null;
  const plan = useMemo(() => (rawPlan && exec ? execPlan(rawPlan, exec) : rawPlan), [rawPlan, exec]);

  if (!store) return <p className="p-6 text-sm text-zinc-500">{error ?? "読み込み中…"}</p>;
  if (!plan) return <p className="p-6 text-sm text-red-600">チェックリストが見つかりません。</p>;

  return (
    <main className="min-h-screen bg-zinc-100 py-4 text-zinc-900 print:bg-white print:py-0">
      <style>{PRINT_CSS}</style>
      <div className="mx-auto mb-4 flex max-w-[1100px] flex-wrap items-center gap-3 px-4 print:hidden">
        <Link href="/piping/field" className="text-sm text-zinc-500 hover:text-zinc-700">
          ← 現場点検
        </Link>
        <h1 className="text-lg font-semibold">印刷・PDF出力：{plan.name}</h1>
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={withChecklist} onChange={(e) => setWithChecklist(e.target.checked)} />
          チェックリスト
        </label>
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={withDrawings} onChange={(e) => setWithDrawings(e.target.checked)} />
          工程ごとの図面（{plan.steps.length}枚）
        </label>
        <button
          onClick={() => window.print()}
          className="ml-auto rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600"
        >
          印刷／PDF保存
        </button>
        <p className="w-full text-xs text-zinc-500">
          印刷画面の「送信先」で「PDFに保存」を選ぶと PDF になります（用紙：A4 横）。バルブが多いチェックリストは複数ページに分かれ、見出しは各ページに入ります。
        </p>
      </div>

      <div className="mx-auto max-w-[1100px] space-y-4 print:max-w-none print:space-y-0">
        {withChecklist && <ChecklistSheet graph={g} plan={plan} exec={exec} />}
        {withDrawings && <DrawingSheets graph={g} plan={plan} />}
      </div>
    </main>
  );
}

function Sheet({ children }: { children: ReactNode }) {
  return (
    <section className="print-page bg-white p-6 shadow print:p-0 print:shadow-none">{children}</section>
  );
}

function targetLabel(g: Graph, plan: SavedPlan) {
  if (!plan.targets.length) return plan.source === "excel" ? "Excel取込" : "—";
  return plan.targets
    .map((t) => (t.type === "node" ? g.nodeById.get(t.id)?.label ?? t.id : `配管 ${g.pipeById.get(t.id)?.sizeA ?? ""}A`))
    .join("・");
}

function ChecklistSheet({ graph, plan, exec }: { graph: Graph; plan: SavedPlan; exec: Execution | null }) {
  const supply = exec?.fillSupply;
  const fillSource = supply
    ? `${supply.tank}／移送ポンプ ${supply.pump}`
    : needsFillSupply(plan)
      ? "当日の運用で選択（タンク：＿＿＿＿　移送ポンプ：＿＿＿＿）"
      : "—";
  const info: [string, string][] = [
    ["作業名", plan.name],
    ["作業種別", plan.source === "excel" ? "Excel取込" : plan.purpose],
    ["抜取対象", targetLabel(graph, plan)],
    ["作成日", new Date(plan.createdAt).toLocaleDateString("ja-JP")],
    ["抜取量", plan.summary.volumeL ? formatLiters(plan.summary.volumeL) : "—"],
    ["抜取時間", formatMinutes(plan.summary.drainMinutes)],
    ["充填時間", formatMinutes(plan.summary.fillMinutes ?? null)],
    ["充填元", fillSource],
  ];
  const cautions = [...plan.summary.warnings, ...plan.summary.notes];

  return (
    <Sheet>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] text-zinc-500">仮想空港給油施設　燃料抜取・充填 作業チェックリスト</p>
          <h2 className="text-xl font-bold">{plan.name}</h2>
        </div>
        <table className="border-collapse text-center text-[10px]">
          <tbody>
            <tr>
              {["作成", "確認", "承認", "作業責任者", "制御室"].map((h) => (
                <td key={h} className="w-16 border border-zinc-700 px-1 py-0.5">
                  {h}
                </td>
              ))}
            </tr>
            <tr>
              {[0, 1, 2, 3, 4].map((i) => (
                <td key={i} className="h-10 border border-zinc-700" />
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <table className="mt-2 w-full border-collapse text-[11px]">
        <tbody>
          {Array.from({ length: Math.ceil(info.length / 4) }, (_, r) => (
            <tr key={r}>
              {info.slice(r * 4, r * 4 + 4).map(([k, v]) => (
                <td key={k} className="border border-zinc-400 px-1.5 py-1">
                  <span className="mr-1 text-zinc-500">{k}</span>
                  <b>{v}</b>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {cautions.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-[10px] text-zinc-700">
          {cautions.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}

      <table className="mt-2 w-full border-collapse text-[10.5px]">
        <thead>
          <tr className="bg-zinc-100">
            <th rowSpan={2} className="border border-zinc-500 px-1">No</th>
            <th rowSpan={2} className="border border-zinc-500 px-1">バルブ</th>
            <th rowSpan={2} className="border border-zinc-500 px-1">名称</th>
            <th rowSpan={2} className="border border-zinc-500 px-1">区分</th>
            {plan.steps.map((st, i) => (
              <th key={st} colSpan={i === 0 ? 1 : 3} className="border border-zinc-500 px-1">
                {i === 0 ? st : `${i}. ${st}`}
              </th>
            ))}
            <th rowSpan={2} className="border border-zinc-500 px-1">備考</th>
          </tr>
          <tr className="bg-zinc-50 text-[9px]">
            {plan.steps.map((st, i) =>
              i === 0 ? (
                <th key={st} className="border border-zinc-500 px-1">状態</th>
              ) : (
                [
                  <th key={`${st}-t`} className="border border-zinc-500 px-1">操作</th>,
                  <th key={`${st}-f`} className="border border-zinc-500 px-1">現場</th>,
                  <th key={`${st}-c`} className="border border-zinc-500 px-1">制御室</th>,
                ]
              )
            )}
          </tr>
        </thead>
        <tbody>
          {plan.rows.map((r, idx) => (
            <tr key={r.code}>
              <td className="border border-zinc-400 px-1 text-center">{idx + 1}</td>
              <td className="border border-zinc-400 px-1 font-semibold whitespace-nowrap">{r.code}</td>
              <td className="border border-zinc-400 px-1">{r.name}</td>
              <td className="border border-zinc-400 px-1 whitespace-nowrap">{ROLE_LABEL[r.role]}</td>
              {r.states.map((s, i) => {
                const operate = isOperateCell(r, i) && i > 0;
                const glyph = (
                  <span className={!s ? "text-zinc-300" : operate ? (s === "open" ? "font-bold text-emerald-700" : "font-bold text-red-700") : "text-zinc-600"}>
                    {stateGlyph(s)}
                    {s && i > 0 && <span className="ml-0.5 text-[8px]">{operate ? "操作" : "確認"}</span>}
                  </span>
                );
                if (i === 0)
                  return (
                    <td key={i} className="border border-zinc-400 px-1 text-center">
                      {glyph}
                    </td>
                  );
                const box = s ? "☐" : "";
                return [
                  <td key={`${i}-t`} className="border border-zinc-400 px-1 text-center whitespace-nowrap">{glyph}</td>,
                  <td key={`${i}-f`} className="border border-zinc-400 px-1 text-center text-base leading-none">{box}</td>,
                  <td key={`${i}-c`} className="border border-zinc-400 px-1 text-center text-base leading-none">{box}</td>,
                ];
              })}
              <td className="border border-zinc-400 px-1 text-[9.5px]">{r.note ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-[9px] text-zinc-500">
        ○＝開　☓＝閉　／＝対象外。「操作」＝その工程で開閉を変える弁、「確認」＝状態を確認する弁。現場・制御室の欄に確認者がチェックしてください。
      </p>
    </Sheet>
  );
}

function DrawingSheets({ graph, plan }: { graph: Graph; plan: SavedPlan }) {
  const base = useMemo(() => normalValveState(graph.facility), [graph]);
  // 全工程を、その作業で最も広い作業範囲で出力する
  const box = useMemo(() => workBounds(graph, plan, base), [graph, plan, base]);

  return (
    <>
      {plan.steps.map((st, step) => {
        const valveState = stateAtStep(base, plan.rows, step);
        const flow = stepFlow(graph, plan, step, valveState);
        const ops = stepOps(plan, step);
        const layers: PipeLayer[] = [
          { key: "region", pipeIds: plan.regionPipeIds, color: "#ef4444", opacity: flow ? 0.2 : 0.35 },
          { key: "seal", pipeIds: plan.sealPipeIds, color: "#f59e0b", opacity: 0.3 },
        ];
        if (flow) {
          layers.push({
            key: "flow",
            pipeIds: [...flow.directions.keys()],
            directions: flow.directions,
            color: flow.kind === "drain" ? "#0284c7" : "#0d9488",
            width: 6,
          });
        }
        const marks: Record<string, NodeMark> = {};
        if (step === 0) plan.rows.forEach((r) => r.nodeId && (marks[r.nodeId] = "selected"));
        ops.confirmed.forEach((r) => r.nodeId && (marks[r.nodeId] = "selected"));
        ops.opened.forEach((r) => r.nodeId && (marks[r.nodeId] = "internal"));
        ops.closed.forEach((r) => r.nodeId && (marks[r.nodeId] = "boundary"));
        const codes = (rows: typeof ops.opened) => rows.map((r) => r.code).join("、") || "なし";

        return (
          <Sheet key={st}>
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-lg font-bold">
                {step === 0 ? st : `工程 ${step}：${st}`}
                <span className="ml-3 text-sm font-normal text-zinc-600">{plan.name}</span>
              </h2>
              <span className="text-[10px] text-zinc-500">
                配管系統図（作業範囲）　{step + 1} / {plan.steps.length}
              </span>
            </div>
            {step > 0 && (
              <div className="mt-1 grid grid-cols-3 gap-2 text-[10.5px]">
                <p>
                  <b className="mr-1 rounded bg-red-600 px-1 text-white">閉操作</b>
                  {codes(ops.closed)}
                </p>
                <p>
                  <b className="mr-1 rounded bg-emerald-600 px-1 text-white">開操作</b>
                  {codes(ops.opened)}
                </p>
                <p>
                  <b className="mr-1 rounded bg-cyan-600 px-1 text-white">確認</b>
                  {codes(ops.confirmed)}
                </p>
              </div>
            )}
            {/* A4横の1ページに収まるよう、図面の高さを抑える（縦横比は workBounds で用紙に合わせている） */}
            <div className="mt-1 border border-zinc-400 print:mx-auto print:max-h-[150mm] print:w-[277mm] print:overflow-hidden">
              <PipingDiagram graph={graph} valveState={valveState} layers={layers} marks={marks} printBox={box} />
            </div>
            <div className="mt-1">
              <DiagramLegend
                items={[
                  { color: "#16a34a", label: "開操作", kind: "ring" },
                  { color: "#dc2626", label: "閉操作", kind: "ring" },
                  { color: "#06b6d4", label: step === 0 ? "チェックリスト対象弁" : "確認", kind: "ring" },
                  { color: "#ef4444", label: "抜取範囲" },
                  { color: "#0284c7", label: "抜取の流れ" },
                  { color: "#0d9488", label: "充填の流れ" },
                ]}
              />
              <p className="text-[9px] text-zinc-500">弁の色はこの工程を終えた時点の開閉（緑＝開、赤＝閉）。</p>
            </div>
          </Sheet>
        );
      })}
    </>
  );
}
