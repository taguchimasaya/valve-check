"use client";

import { useEffect, useRef, useState } from "react";
import PipingDiagram, { DiagramLegend, type DiagramHandle, type NodeMark, type PipeLayer } from "@/components/piping/PipingDiagram";
import { isOperateCell, ROLE_LABEL, rowGlyph, stateAtStep, type PlanRow, type RowRole, type SavedPlan } from "@/lib/piping/checklist";
import type { Graph } from "@/lib/piping/graph";
import { flowColor, stepFlow } from "@/lib/piping/flow";
import type { ValveState } from "@/lib/piping/types";
import { formatLiters, formatMinutes } from "@/lib/piping/isolation";
import { recordKey, type Execution } from "@/lib/piping/store";
import { workTypeOf } from "@/lib/piping/workTypes";

const volumeLabel = (p: SavedPlan) => (workTypeOf(p) === "flush" ? "末端部容量" : "抜取量");

// チェックリスト（と点検記録）のプレビュー（① 作成画面・② 現場点検で共通）：
// 工程ごとに図面で範囲・対象バルブ・流れを、表で工程ごとの開閉を確認する。

const ROLE_MARK: Record<RowRole, NodeMark> = {
  boundary: "boundary",
  internal: "internal",
  drain: "drain",
  gauge: "gauge",
  fill: "fill",
  route: "selected",
  pump: "selected",
  imported: "selected",
};

// チェックリスト（と点検記録）のプレビュー：図面で範囲と対象バルブ、表で工程ごとの開閉を確認する
export default function PlanPreview({
  graph,
  plan,
  exec,
  base,
  onClose,
  onStart,
  startLabel,
  onDelete,
  deleteLabel,
  pdfHref,
}: {
  graph: Graph;
  plan: SavedPlan;
  exec?: Execution;
  base: Record<string, ValveState>;
  onClose: () => void;
  onStart?: () => void;
  startLabel: string;
  onDelete?: () => void;
  deleteLabel?: string;
  /** PDF出力のリンク先（null なら出さない。未保存のチェックリストなど） */
  pdfHref?: string | null;
}) {
  const diagramRef = useRef<DiagramHandle>(null);
  // 表示する工程（点検中なら現在の工程から）
  const [step, setStep] = useState(exec && exec.status === "in_progress" ? exec.currentStep : 0);

  // 作業エリア（抜取範囲と、表示中の工程で操作する弁。作業前はラインナップの対象弁）に合わせて拡大する。
  // 工程を切り替えるたびに合わせ直す（充填では充填元弁まで、ラインナップでは範囲付近だけ）
  const areaIdsRef = useRef<string[]>([]);
  useEffect(() => {
    areaIdsRef.current = [
      ...plan.regionNodeIds,
      ...plan.rows
        .filter((r) => r.states[step === 0 ? Math.min(1, plan.steps.length - 1) : step])
        .map((r) => r.nodeId)
        .filter((id): id is string => !!id),
    ];
  });
  useEffect(() => {
    const t = setTimeout(() => diagramRef.current?.fitNodes(areaIdsRef.current), 80);
    return () => clearTimeout(t);
  }, [plan.id, step]);

  // その工程を終えた時点の弁状態と、その工程での燃料の流れ
  const valveState = stateAtStep(base, plan.rows, step);
  const flow = stepFlow(graph, plan, step, valveState);
  const layers: PipeLayer[] = [
    { key: "region", pipeIds: plan.regionPipeIds, color: "#ef4444", opacity: flow ? 0.2 : 0.4 },
    { key: "seal", pipeIds: plan.sealPipeIds, color: "#f59e0b", opacity: 0.3 },
  ];
  if (flow) {
    layers.push({
      key: `flow-${step}`,
      pipeIds: [...flow.directions.keys()],
      directions: flow.directions,
      color: flowColor(flow.kind),
      width: 6,
      flow: true,
    });
  }

  // その工程で操作する弁：開操作＝緑、閉操作＝赤、状態が変わらない確認＝水色
  const opened: PlanRow[] = [];
  const closed: PlanRow[] = [];
  const confirmed: PlanRow[] = [];
  const started: PlanRow[] = [];
  const stopped: PlanRow[] = [];
  plan.rows.forEach((r) => {
    if (!r.states[step] || step === 0) return;
    if (!isOperateCell(r, step)) confirmed.push(r);
    else if (r.role === "pump") (r.states[step] === "open" ? started : stopped).push(r);
    else if (r.states[step] === "open") opened.push(r);
    else closed.push(r);
  });
  const marks: Record<string, NodeMark> =
    step === 0
      ? Object.fromEntries(plan.rows.filter((r) => r.nodeId).map((r) => [r.nodeId!, ROLE_MARK[r.role]]))
      : Object.fromEntries([
          ...confirmed.filter((r) => r.nodeId).map((r) => [r.nodeId!, "selected" as NodeMark]),
          ...opened.filter((r) => r.nodeId).map((r) => [r.nodeId!, "internal" as NodeMark]),
          ...closed.filter((r) => r.nodeId).map((r) => [r.nodeId!, "boundary" as NodeMark]),
        ]);
  const codes = (rows: PlanRow[]) => rows.map((r) => r.code + (r.note ? "※" : "")).join("、");
  const label = (id: string) => graph.nodeById.get(id)?.label || "移送系統（移送ポンプ吐出）";
  const done = exec ? Object.values(exec.records).filter((r) => r.result === "OK").length : 0;
  const total = plan.rows.reduce((a, r) => a + r.states.filter((s, i) => s && i > 0).length, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-2 sm:p-4" onClick={onClose}>
      <div
        className="flex max-h-[95vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white dark:bg-zinc-950"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-zinc-500">
              {exec ? (exec.status === "completed" ? "完了した点検" : "点検中") : "チェックリスト"}のプレビュー
            </p>
            <h2 className="truncate text-lg font-semibold text-zinc-900 dark:text-zinc-50">{plan.name}</h2>
            <p className="text-xs text-zinc-500">
              {plan.source === "excel" ? "Excel取込" : plan.purpose} ・ {plan.steps.length}工程 ・ {plan.rows.length}弁
              {plan.summary.volumeL ? ` ・ ${volumeLabel(plan)} ${formatLiters(plan.summary.volumeL)}` : ""}
              {plan.summary.drainMinutes ? ` ・ 抜取 ${formatMinutes(plan.summary.drainMinutes)}` : ""}
              {plan.summary.fillMinutes ? ` ・ 充填 ${formatMinutes(plan.summary.fillMinutes)}` : ""}
              {exec ? ` ・ 記録 ${done}/${total}` : ""}
              {exec && exec.status === "in_progress" ? ` ・ 現在工程：${plan.steps[exec.currentStep]}` : ""}
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg border border-zinc-300 px-3 py-1 text-sm dark:border-zinc-700" aria-label="閉じる">
            ✕
          </button>
        </div>

        <div className="space-y-3 overflow-auto p-4">
          {plan.summary.warnings.length > 0 && (
            <ul className="list-disc rounded-lg bg-amber-50 py-2 pl-8 pr-3 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              {plan.summary.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          {/* 工程の切り替え */}
          <div className="flex flex-wrap items-center gap-1">
            <button
              onClick={() => setStep(Math.max(0, step - 1))}
              disabled={step === 0}
              className="rounded-lg border border-zinc-300 px-2 py-1.5 text-sm disabled:opacity-30 dark:border-zinc-700"
              aria-label="前の工程"
            >
              ◀
            </button>
            {plan.steps.map((st, i) => (
              <button
                key={st}
                onClick={() => setStep(i)}
                className={`flex-1 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm ${
                  i === step
                    ? "bg-zinc-800 font-semibold text-white dark:bg-zinc-200 dark:text-zinc-900"
                    : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300"
                }`}
              >
                {i === 0 ? st : `${i}. ${st}`}
                {exec?.status === "in_progress" && i === exec.currentStep && <span className="ml-1 text-amber-500">●</span>}
              </button>
            ))}
            <button
              onClick={() => setStep(Math.min(plan.steps.length - 1, step + 1))}
              disabled={step === plan.steps.length - 1}
              className="rounded-lg border border-zinc-300 px-2 py-1.5 text-sm disabled:opacity-30 dark:border-zinc-700"
              aria-label="次の工程"
            >
              ▶
            </button>
          </div>

          {/* その工程の内容（状態遷移と流れ） */}
          <div className="grid gap-2 rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800 sm:grid-cols-2">
            {step === 0 ? (
              <p className="text-zinc-600 dark:text-zinc-400 sm:col-span-2">
                作業前の状態です。図面の弁は作業前の開閉（緑＝開、赤＝閉）、リングはチェックリストの対象弁（区分別）を表します。
              </p>
            ) : (
              <>
                <div className="space-y-1">
                  {stopped.length > 0 && (
                    <p>
                      <span className="mr-1 inline-block rounded bg-zinc-700 px-1.5 text-white">ポンプ停止</span>
                      {codes(stopped)}
                    </p>
                  )}
                  {started.length > 0 && (
                    <p>
                      <span className="mr-1 inline-block rounded bg-green-700 px-1.5 text-white">ポンプ起動</span>
                      {codes(started)}
                    </p>
                  )}
                  <p>
                    <span className="mr-1 inline-block rounded bg-red-500 px-1.5 text-white">閉操作</span>
                    {codes(closed) || "なし"}
                  </p>
                  <p>
                    <span className="mr-1 inline-block rounded bg-emerald-500 px-1.5 text-white">開操作</span>
                    {codes(opened) || "なし"}
                  </p>
                  <p>
                    <span className="mr-1 inline-block rounded bg-cyan-500 px-1.5 text-white">確認</span>
                    {codes(confirmed) || "なし"}
                  </p>
                </div>
                <div className="text-zinc-600 dark:text-zinc-400">
                  {flow?.kind === "drain" && (
                    <p>
                      <span className="mr-1 inline-block rounded bg-sky-600 px-1.5 text-white">流れ</span>
                      範囲内の燃料を {flow.origins.map(label).join("・")} へ抜き取ります（矢印＝流れ方向）。
                    </p>
                  )}
                  {flow?.kind === "fill" && (
                    <p>
                      <span className="mr-1 inline-block rounded bg-teal-600 px-1.5 text-white">流れ</span>
                      {flow.origins.map(label).join("・")} から範囲内へ充填します（矢印＝流れ方向）。
                    </p>
                  )}
                  {!flow && <p>この工程では燃料の移動はありません（弁の開閉のみ）。</p>}
                  {[...closed, ...opened].some((r) => r.note) && <p className="mt-1 text-amber-700">※ {[...closed, ...opened].find((r) => r.note)?.note}</p>}
                </div>
              </>
            )}
          </div>

          <PipingDiagram
            ref={diagramRef}
            graph={graph}
            valveState={valveState}
            layers={layers}
            marks={marks}
            height="42vh"
            toolbar={
              <button
                onClick={() => diagramRef.current?.fitNodes(areaIdsRef.current)}
                className="rounded border border-zinc-300 px-2 py-0.5 text-xs dark:border-zinc-700"
              >
                作業エリアを表示
              </button>
            }
          />
          <DiagramLegend
            items={[
              { color: "#22c55e", label: "開操作", kind: "ring" },
              { color: "#dc2626", label: "閉操作", kind: "ring" },
              { color: "#06b6d4", label: "確認（状態変化なし）", kind: "ring" },
              { color: "#0284c7", label: "抜取の流れ" },
              { color: "#0d9488", label: "充填の流れ" },
              { color: "#ef4444", label: "点検範囲" },
            ]}
          />
          <div className="overflow-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-xs">
              <thead className="bg-zinc-50 text-zinc-500 dark:bg-zinc-900">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium">バルブ</th>
                  <th className="px-2 text-left font-medium">区分</th>
                  {plan.steps.map((st, i) => (
                    <th
                      key={st}
                      onClick={() => setStep(i)}
                      className={`cursor-pointer px-2 text-center font-medium ${
                        i === step ? "bg-zinc-800 text-white dark:bg-zinc-200 dark:text-zinc-900" : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      }`}
                    >
                      {st}
                      {exec?.status === "in_progress" && i === exec.currentStep && <span className="ml-0.5 text-amber-500">●</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {plan.rows.map((r) => (
                  <tr key={r.code} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="px-2 py-1">
                      {r.nodeId ? (
                        <button onClick={() => diagramRef.current?.focusNode(r.nodeId!)} className="text-left text-sky-700 hover:underline dark:text-sky-400">
                          📍 {r.code}
                        </button>
                      ) : (
                        r.code
                      )}
                      <span className="block text-[11px] text-zinc-500">{r.name}</span>
                    </td>
                    <td className="px-2 text-zinc-500">{ROLE_LABEL[r.role]}</td>
                    {r.states.map((st, i) => {
                      const rec = exec?.records[recordKey(i, r.code)];
                      return (
                        <td key={i} className={`px-2 text-center ${i === step ? "bg-zinc-100 dark:bg-zinc-900" : ""}`}>
                          <span
                            className={`inline-block min-w-6 rounded px-1 ${
                              !st
                                ? "text-zinc-300 dark:text-zinc-700"
                                : rec?.result === "NG"
                                  ? "bg-red-700 text-white"
                                  : isOperateCell(r, i) && i > 0
                                    ? st === "open"
                                      ? "bg-emerald-500 text-white"
                                      : "bg-red-500 text-white"
                                    : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800"
                            }`}
                          >
                            {rowGlyph(r, st, i)}
                            {exec && st && i > 0 ? (rec?.result === "OK" ? "☑" : "☐") : ""}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
          {onDelete ? (
            <button
              onClick={onDelete}
              className="mr-auto rounded-lg border border-red-300 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:text-red-400"
            >
              {deleteLabel}
            </button>
          ) : (
            <span className="mr-auto" />
          )}
          {pdfHref !== null && (
            <a
              href={pdfHref ?? (exec ? `/piping/print?exec=${exec.id}` : `/piping/print?plan=${plan.id}`)}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700"
            >
              PDF出力（印刷）
            </a>
          )}
          <button onClick={onClose} className="rounded-lg border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700">
            閉じる
          </button>
          {onStart && (
            <button onClick={onStart} className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600">
              {startLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
