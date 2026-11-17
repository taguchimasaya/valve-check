// 点検・チェックリストの重複の決まり（画面と /api/piping で共通）。
//
// - チェックリスト：作業の種類・対象・周期がすべて同じものは2つ作れない（周期が違えば作れる）。
// - 点検：同じチェックリストの点検、または同じ対象（機器・配管・タンク）を含む点検が申請中・点検中のあいだは開始できない
//   （作業名が違っても、同じ機器を同時に点検することになるため）。
// - 点検：ほかの点検（申請中・点検中）と同じライン（範囲の配管・使う弁が重なる）を使うときは、
//   開始の申請はできるが、制御室が重なりを確認したうえで承認する（承認時に確認を求める）。
// - 点検は開始した本人のもの（ownerId）。持ち主の決まる前に始めた点検（ownerId なし）は誰のものでもない扱い。

import type { SavedPlan } from "./checklist";
import type { Execution, PipingStore } from "./store";
import { workTypeOf } from "./workTypes";

const sorted = (xs: readonly string[] | undefined) => [...(xs ?? [])].sort().join(",");
const norm = (s: string | undefined) => (s ?? "").normalize("NFKC").trim().toLowerCase();

/** チェックリストの「作業の種類＋対象」（周期は含まない） */
export function planTargetKey(p: SavedPlan): string {
  if (p.source === "excel") return `excel:${sorted(p.rows.map((r) => r.code))}`;
  const t = workTypeOf(p);
  switch (t) {
    case "flush":
      return `flush:${sorted(p.flushPipeIds)}`;
    case "tankIsolation":
      return `tankIsolation:${p.isolationTank ?? ""}`;
    case "fireTest":
      return `fireTest:${p.fireTestTank ?? ""}`;
    case "custom":
      return `custom:${p.customType?.id ?? ""}:${p.customTarget ?? ""}`;
    default:
      return `drain:${sorted(p.targets.map((x) => `${x.type}:${x.id}`))}`;
  }
}

/** 同じ作業・対象・周期の、別のチェックリスト */
export function duplicatePlan(plans: readonly SavedPlan[], p: SavedPlan): SavedPlan | undefined {
  const key = planTargetKey(p);
  const period = norm(p.period);
  return plans.find((x) => x.id !== p.id && planTargetKey(x) === key && norm(x.period) === period);
}

/** 開始の申請中・点検中 */
export const isActive = (e: Execution) => e.status === "pending" || e.status === "in_progress";

/** 同じチェックリストの、申請中・点検中の点検 */
export function activeExecOfPlan(store: Pick<PipingStore, "executions">, planId: string, exceptExecId?: string) {
  return store.executions.find((e) => e.planId === planId && e.id !== exceptExecId && isActive(e));
}

/**
 * チェックリストの対象（点検する機器・配管・タンク）。同じ対象を2つの点検で同時に点検しない。
 * Excel 取込のチェックリストは対象を持たないため、ここでは比べない（弁の重なりは lineConflicts で見る）。
 */
export function planTargets(p: SavedPlan): string[] {
  if (p.source === "excel") return [];
  switch (workTypeOf(p)) {
    case "flush":
      return (p.flushPipeIds ?? []).map((id) => `pipe:${id}`);
    case "tankIsolation":
      return p.isolationTank ? [`tank:${p.isolationTank}`] : [];
    case "fireTest":
      return p.fireTestTank ? [`tank:${p.fireTestTank}`] : [];
    case "custom":
      if (!p.customTarget) return [];
      return [p.customType?.target === "tank" ? `tank:${p.customTarget}` : `node:${p.customTarget}`];
    default:
      return p.targets.map((x) => `${x.type}:${x.id}`);
  }
}

/** 同じ対象（機器・配管・タンク）を点検している、ほかのチェックリストの申請中・点検中の点検 */
export function targetConflicts(store: Pick<PipingStore, "executions" | "plans">, plan: SavedPlan, exceptExecId?: string) {
  const mine = new Set(planTargets(plan));
  if (!mine.size) return [];
  const out: { exec: Execution; plan: SavedPlan }[] = [];
  for (const e of store.executions) {
    if (e.id === exceptExecId || e.planId === plan.id || !isActive(e)) continue;
    const other = store.plans.find((p) => p.id === e.planId);
    if (other && planTargets(other).some((t) => mine.has(t))) out.push({ exec: e, plan: other });
  }
  return out;
}

/** 点検を開始できない種類：same＝同じチェックリストの点検が実施中、target＝同じ機器を対象とする別の点検が実施中 */
export function startBlockKind(store: Pick<PipingStore, "executions" | "plans">, plan: SavedPlan, exceptExecId?: string): "same" | "target" | null {
  if (activeExecOfPlan(store, plan.id, exceptExecId)) return "same";
  if (targetConflicts(store, plan, exceptExecId).length) return "target";
  return null;
}

/** 開始できない種類の短い表示（② のボタン） */
export const BLOCK_LABEL = { same: "実施中", target: "対象機器を点検中" } as const;

/**
 * 点検を開始できない理由（同じチェックリスト、または同じ対象の点検が申請中・点検中）。開始できるなら null。
 * 作業者には、だれの・どの点検かは知らせない。
 */
export function startBlocker(store: Pick<PipingStore, "executions" | "plans">, plan: SavedPlan, exceptExecId?: string): string | null {
  const kind = startBlockKind(store, plan, exceptExecId);
  if (kind === "same") return "この点検はほかの作業者が実施中のため、開始できません（終わるまでお待ちください）";
  if (kind === "target") return "同じ機器を対象とする別の点検が実施中のため、開始できません（その点検が終わるまでお待ちください）";
  return null;
}

/** チェックリストが使うライン：範囲・充填の配管と、使う弁 */
function linesOf(p: SavedPlan) {
  return {
    pipes: new Set([...(p.regionPipeIds ?? []), ...(p.fillPipeIds ?? [])]),
    valves: new Set(p.rows.map((r) => r.nodeId ?? r.code)),
  };
}

export type Overlap = {
  /** 重なった配管の数 */
  pipes: number;
  /** 重なった配管の ID（図面に描く） */
  pipeIds: string[];
  /** 重なった弁の番号 */
  valves: string[];
  /** 重なった弁の図面上の ID */
  valveNodeIds: string[];
};

/** 2つのチェックリストのラインが重なるか（重なった配管・弁） */
export function lineOverlap(a: SavedPlan, b: SavedPlan): Overlap {
  const la = linesOf(a);
  const lb = linesOf(b);
  const pipeIds = [...la.pipes].filter((x) => lb.pipes.has(x));
  const rows = b.rows.filter((r) => la.valves.has(r.nodeId ?? r.code));
  return {
    pipes: pipeIds.length,
    pipeIds,
    valves: [...new Set(rows.map((r) => r.code))],
    valveNodeIds: [...new Set(rows.map((r) => r.nodeId).filter((x): x is string => !!x))],
  };
}

export type LineConflict = { exec: Execution; plan: SavedPlan } & Overlap;

/** このチェックリストとラインが重なる、ほかの申請中・点検中の点検（同じチェックリストの点検は含まない） */
export function lineConflicts(store: Pick<PipingStore, "executions" | "plans">, plan: SavedPlan, exceptExecId?: string): LineConflict[] {
  const out: LineConflict[] = [];
  for (const e of store.executions) {
    if (e.id === exceptExecId || e.planId === plan.id || !isActive(e)) continue;
    const other = store.plans.find((p) => p.id === e.planId);
    if (!other) continue;
    const o = lineOverlap(plan, other);
    if (o.pipes || o.valves.length) out.push({ exec: e, plan: other, ...o });
  }
  return out;
}

export function conflictText(c: LineConflict) {
  const parts = [c.pipes ? `配管${c.pipes}本` : "", c.valves.length ? `弁 ${c.valves.slice(0, 5).join("・")}${c.valves.length > 5 ? " ほか" : ""}` : ""].filter(Boolean);
  return `「${c.exec.planName}」（${c.exec.status === "pending" ? "開始申請中" : "点検中"}${c.exec.ownerName ? `・${c.exec.ownerName}` : ""}）と${parts.join("・")}が重なっています`;
}

/** その点検を操作できる持ち主か（持ち主の無い古い点検は誰でも） */
export const isOwner = (e: Pick<Execution, "ownerId">, userId: string | null | undefined) => !e.ownerId || e.ownerId === userId;
