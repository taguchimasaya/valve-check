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
  isFlushLike,
  isTransferLike,
  isolationIssueRoute,
  isolationTransferRoute,
  manualStepLabel,
  manualStepsOf,
  workTypeOf,
  type DayParams,
} from "@/lib/piping/workTypes";
import { applyBlocks, buildCustomChecklist } from "@/lib/piping/ruleBlocks";
import { unionRoute } from "@/lib/piping/fireTest";

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
  /** 表示だけ（当日の入力は制御室だけが行う） */
  readOnly?: boolean;
  /**
   * 入力のあとに続けて行う操作（③ の開始の承認）。指定すると、ボタンは「入力（変わっていれば）→ この操作」を1回で行う
   */
  onSubmit?: () => Promise<void>;
  submitLabel?: string;
  submitDisabled?: boolean;
};

const yardOf = (tank: string) => tank.slice(2, 3);

export default function DayParamsPicker({ graph: g, plan, exec, base, act, compact, readOnly, onSubmit, submitLabel, submitDisabled }: Props) {
  // ユーザー定義の作業で計算の部品「循環経路」を使うものは、燃料末端部作業と同じ選び方
  const custom = workTypeOf(plan) === "custom";
  const type = isFlushLike(plan) ? "flush" : isTransferLike(plan) ? "tankIsolation" : workTypeOf(plan);
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

  /** 当日の選択を保存する。保存できたら true */
  async function save(): Promise<boolean> {
    setError(null);
    if (!params) return false;
    // ユーザー定義の作業：作成時の作業の定義（工程・ルール・計算の部品）で作り直す
    if (custom && plan.customType) {
      const c =
        params.kind === "flush"
          ? buildCustomChecklist(g, plan.customType, null, base, { flushPipes: plan.flushPipeIds ?? [], day: params })
          : buildCustomChecklist(g, plan.customType, plan.isolationTank ?? null, base, { transferDay: params });
      if (c.error) {
        setError(c.error);
        return false;
      }
      setSaving(true);
      try {
        await act({ action: "setDayParams", execId: exec.id, params, rows: c.rows, stepNotes: c.stepNotes, stepRoutes: c.stepRoutes });
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setSaving(false);
      }
    }
    // 作成時のルール（⑤）で作り直す
    const r = buildDayChecklist(g, plan, params, base, plan.appliedRules ?? {});
    if (r.error) {
      setError(r.error);
      return false;
    }
    const blocks = plan.appliedRules?.blocks ?? [];
    if (blocks.length) {
      const routes = Object.values(r.stepRoutes);
      r.rows = applyBlocks(g, r.rows, plan.steps, blocks, {
        target: plan.isolationTank ?? null,
        route: routes.length ? unionRoute(routes) : null,
        base,
      }).rows;
    }
    setSaving(true);
    try {
      await act({ action: "setDayParams", execId: exec.id, params, rows: r.rows, stepNotes: r.stepNotes, stepRoutes: r.stepRoutes });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function apply() {
    if (!onSubmit) {
      await save();
      return;
    }
    // 変わっていれば先に保存し、続けて承認する
    if (changed && !(await save())) return;
    setSaving(true);
    try {
      await onSubmit();
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
        {summary ?? <span className="text-amber-700 dark:text-amber-300">{readOnly ? "未入力（制御室の入力待ち）" : "未選択（作業を始める前に選んでください）"}</span>}
      </p>
      {readOnly ? (
        <p className="mt-1 text-zinc-500">制御室が当日の運用に合わせて入力します。</p>
      ) : !locked ? (
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
            disabled={saving || !params || (onSubmit ? !!submitDisabled : !changed)}
            className={`rounded px-3 py-1 font-semibold text-white disabled:opacity-40 ${onSubmit ? "bg-emerald-700 hover:bg-emerald-600" : "bg-purple-700 hover:bg-purple-600"}`}
          >
            {onSubmit ? submitLabel ?? "この内容で決定" : current ? "変更する" : "この内容で設定"}
          </button>
        </div>
      ) : (
        <p className="mt-1 text-zinc-500">弁を記録済みのため、変更できません。</p>
      )}
      {!params && !locked && !readOnly && (
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
