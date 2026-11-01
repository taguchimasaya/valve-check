"use client";

import { useMemo, useState } from "react";
import type { SavedPlan } from "@/lib/piping/checklist";
import type { Graph } from "@/lib/piping/graph";
import { TANKS } from "@/lib/piping/operations";
import type { Execution, StoreAction } from "@/lib/piping/store";
import type { ValveState } from "@/lib/piping/types";
import {
  ALL_PUMPS,
  buildDayChecklist,
  flushPumps,
  isolationIssueRoute,
  isolationTransferRoute,
  manualStepLabel,
  manualStepsOf,
  workTypeOf,
  type DayParams,
} from "@/lib/piping/workTypes";

// 燃料末端部作業・タンク縁切りの「当日のタンク・ポンプ」を選ぶ欄（現場点検・制御室で共通）。
// 選ぶと、その経路の弁でチェックリストが作り直される（弁を記録した後は変更できない）。

type Props = {
  graph: Graph;
  /** 元のチェックリスト（当日の行を重ねる前のもの） */
  plan: SavedPlan;
  exec: Execution;
  /** 今の弁状態（運用・手動変更を反映したもの）。経路の弁の「作業前」状態に使う */
  base: Record<string, ValveState>;
  act: (a: StoreAction) => Promise<unknown>;
  compact?: boolean;
};

const yardOf = (tank: string) => tank.slice(2, 3);

export default function DayParamsPicker({ graph: g, plan, exec, base, act, compact }: Props) {
  const type = workTypeOf(plan);
  const init = exec.dayParams ?? plan.dayDefaults;
  const [srcTank, setSrcTank] = useState(init?.kind === "flush" ? init.srcTank : "T-101");
  const [returnTank, setReturnTank] = useState(init?.kind === "flush" ? init.returnTank : "T-102");
  const [pump, setPump] = useState(init?.kind === "flush" ? init.pump : "");
  const tank = plan.isolationTank ?? "";
  const [destTank, setDestTank] = useState(
    init?.kind === "tankIsolation" ? init.destTank : TANKS.find((t) => t !== tank && yardOf(t) === yardOf(tank)) ?? "T-101"
  );
  const [issuePump, setIssuePump] = useState(init?.kind === "tankIsolation" ? init.issuePump : "");
  const [transferPump, setTransferPump] = useState(init?.kind === "tankIsolation" ? init.transferPump : "TP-1");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const flushPipes = plan.flushPipeIds;
  const pumpOptions = useMemo(
    () => (type === "flush" ? flushPumps(g, flushPipes ?? [], srcTank, returnTank) : []),
    [g, type, flushPipes, srcTank, returnTank]
  );
  const issueOptions = useMemo(
    () =>
      type === "tankIsolation"
        ? ALL_PUMPS(g).filter((p) => g.nodeById.get(p)!.kind === "pump" && isolationIssueRoute(g, tank, destTank, p))
        : [],
    [g, type, tank, destTank]
  );
  const transferOptions = useMemo(
    () =>
      type === "tankIsolation"
        ? ALL_PUMPS(g).filter((p) => g.nodeById.get(p)!.kind === "transferPump" && isolationTransferRoute(g, tank, destTank, p))
        : [],
    [g, type, tank, destTank]
  );
  const effPump = pumpOptions.includes(pump) ? pump : pumpOptions[0];
  const effIssue = issueOptions.includes(issuePump) ? issuePump : issueOptions[0];
  const effTransfer = transferOptions.includes(transferPump) ? transferPump : transferOptions[0];
  const params: DayParams | null =
    type === "flush"
      ? effPump
        ? { kind: "flush", srcTank, pump: effPump, returnTank }
        : null
      : effIssue && effTransfer
        ? { kind: "tankIsolation", destTank, issuePump: effIssue, transferPump: effTransfer }
        : null;

  const locked = Object.keys(exec.records).length > 0;
  const current = exec.dayParams;
  const changed = JSON.stringify(current) !== JSON.stringify(params);

  async function apply() {
    setError(null);
    if (!params) return;
    const r = buildDayChecklist(g, plan, params, base);
    if (r.error) {
      setError(r.error);
      return;
    }
    setSaving(true);
    try {
      await act({ action: "setDayParams", execId: exec.id, params, rows: r.rows, stepNotes: r.stepNotes, stepRoutes: r.stepRoutes });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const select =
    "rounded border border-zinc-300 bg-white px-1.5 py-1 text-sm disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900";
  const pick = (label: string, value: string, options: string[], onChange: (v: string) => void) => (
    <label className="flex items-center gap-1">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={!options.length} className={select}>
        {!options.length && <option value="">（なし）</option>}
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    </label>
  );
  const summary = !current
    ? null
    : current.kind === "flush"
      ? `${current.srcTank} → ${current.pump} → 末端部 → ${current.returnTank}`
      : `${tank} → ${current.destTank}（払出 ${current.issuePump}／移送 ${current.transferPump}）`;

  return (
    <div
      className={`rounded-lg border p-2 text-xs ${
        current ? "border-purple-300 bg-purple-50 dark:border-purple-800 dark:bg-purple-950" : "border-amber-400 bg-amber-50 dark:bg-amber-950"
      }`}
    >
      <p className="font-semibold text-purple-800 dark:text-purple-300">
        {type === "flush" ? "循環経路" : "移送先"}（当日の運用で選択）：
        {summary ?? <span className="text-amber-700 dark:text-amber-300">未選択（作業を始める前に選んでください）</span>}
      </p>
      {!locked ? (
        <div className={`mt-1 flex flex-wrap items-center gap-2 ${compact ? "" : "text-sm"}`}>
          {type === "flush" ? (
            <>
              {pick("送り元", srcTank, TANKS, setSrcTank)}
              {pick("ポンプ", effPump ?? "", pumpOptions, setPump)}
              {pick("戻り先", returnTank, TANKS, setReturnTank)}
            </>
          ) : (
            <>
              {pick("移送先", destTank, TANKS.filter((t) => t !== tank), setDestTank)}
              {pick("払出ポンプ", effIssue ?? "", issueOptions, setIssuePump)}
              {pick("移送ポンプ", effTransfer ?? "", transferOptions, setTransferPump)}
            </>
          )}
          <button
            onClick={apply}
            disabled={saving || !params || !changed}
            className="rounded bg-purple-700 px-3 py-1 font-semibold text-white hover:bg-purple-600 disabled:opacity-40"
          >
            {current ? "変更する" : "この内容で設定"}
          </button>
        </div>
      ) : (
        <p className="mt-1 text-zinc-500">弁を記録済みのため、変更できません。</p>
      )}
      {!params && !locked && (
        <p className="mt-1 text-red-600">
          {type === "flush" ? "この送り元・戻り先では末端部へ届くポンプがありません。" : "この移送先への移送経路が見つかりません。"}
        </p>
      )}
      {current && !compact && (
        <a
          href={`/piping/print?exec=${exec.id}`}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block text-xs font-semibold text-sky-700 underline dark:text-sky-400"
        >
          この内容でPDF出力（チェックリスト・工程ごとの図面）
        </a>
      )}
      {error && <p className="mt-1 text-red-600">{error}</p>}
      {!compact && (
        <p className="mt-1 text-[11px] text-zinc-500">
          設定すると、選んだタンク・ポンプの経路の弁でチェックリストが作られます。
          {manualStepsOf(plan).length > 0 && `${type === "flush" ? "循環" : "移送"}が終わったら「${manualStepLabel(plan)}」を押して次の工程へ進みます。`}
        </p>
      )}
    </div>
  );
}
