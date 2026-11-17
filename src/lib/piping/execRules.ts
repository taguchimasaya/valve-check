// 点検・チェックリストの重複の決まり（画面と /api/piping で共通）。
//
// - チェックリスト：作業の種類・対象・周期がすべて同じものは2つ作れない（周期が違えば作れる）。
// - 点検：同じチェックリストの点検は、開始の申請中・点検中のものが1つあるあいだは開始できない。
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

/** チェックリストが使うライン：範囲・充填の配管と、使う弁 */
function linesOf(p: SavedPlan) {
  return {
    pipes: new Set([...(p.regionPipeIds ?? []), ...(p.fillPipeIds ?? [])]),
    valves: new Set(p.rows.map((r) => r.nodeId ?? r.code)),
  };
}

/** 2つのチェックリストのラインが重なるか（重なった配管・弁の数） */
export function lineOverlap(a: SavedPlan, b: SavedPlan): { pipes: number; valves: string[] } {
  const la = linesOf(a);
  const lb = linesOf(b);
  const pipes = [...la.pipes].filter((x) => lb.pipes.has(x)).length;
  const valves = b.rows.filter((r) => la.valves.has(r.nodeId ?? r.code)).map((r) => r.code);
  return { pipes, valves: [...new Set(valves)] };
}

export type LineConflict = { exec: Execution; plan: SavedPlan; pipes: number; valves: string[] };

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
