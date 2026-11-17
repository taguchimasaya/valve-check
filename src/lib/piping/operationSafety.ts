// 安全機構：点検を開始できるのは、運用していない範囲か、運用停止範囲の中だけ。
//
// 運用中のライン（③ で入力した受入・払出・移送・バイパス返油）が、点検の範囲（抜取範囲の配管）を通っている、
// または点検で閉める弁が運用中のラインの開いている弁なら、開始できない。
// ただし、その配管・弁が当日の運用停止範囲（③ で設定）の中なら、運用は止まっている扱いで開始できる。
// 図面（グラフ）が要るため、判定は ② ③ の画面で行う（グラフはブラウザで組み立てているため）。

import type { SavedPlan } from "./checklist";
import type { Graph } from "./graph";
import { currentValveState, describeOperation, OPERATION_META, type OperationRoute } from "./operations";
import { outageRange } from "./outages";
import type { PipingStore } from "./store";

export type OperationContext = {
  routes: OperationRoute[];
  /** 運用停止範囲の配管・ノード（弁） */
  outagePipes: Set<string>;
  outageNodes: Set<string>;
};

/** 今の運用ラインと運用停止範囲（画面ごとに1回だけ求めて、チェックリストごとの判定に使う） */
export function operationContext(
  g: Graph,
  store: Pick<PipingStore, "operations" | "valveOverrides" | "outages" | "outageDefs"> | null | undefined
): OperationContext {
  const op = currentValveState(g, store?.operations ?? [], store?.valveOverrides ?? {});
  const outagePipes = new Set<string>();
  const outageNodes = new Set<string>();
  for (const o of store?.outages ?? []) {
    const r = outageRange(g, o.key, store?.outageDefs);
    r?.pipeIds.forEach((p) => outagePipes.add(p));
    r?.nodeIds.forEach((n) => outageNodes.add(n));
  }
  return { routes: op.routes.filter((r) => !r.error), outagePipes, outageNodes };
}

/**
 * 点検を開始できない理由（運用中のラインと重なるもの）。空なら開始できる。
 * plan は当日の選択（タンク・ポンプ）で加えた行を重ねたものを渡すと、その弁も判定に入る。
 */
export function operationBlockers(ctx: OperationContext, plan: Pick<SavedPlan, "rows" | "regionPipeIds">): string[] {
  const region = new Set(plan.regionPipeIds);
  // 点検で閉める弁（どこかの工程で「閉」）
  const closes = plan.rows.filter((r) => r.nodeId && r.states.some((s) => s === "close"));
  const out: string[] = [];
  for (const r of ctx.routes) {
    const label = `運用中の「${OPERATION_META[r.op.kind].label}」ライン（${describeOperation(r.op)}）`;
    const pipes = [...r.pipeIds].filter((p) => region.has(p) && !ctx.outagePipes.has(p)).length;
    if (pipes) out.push(`${label}が点検範囲を通っています（${pipes}区間）`);
    const open = new Set(r.openValves);
    const valves = closes.filter((row) => open.has(row.nodeId!) && !ctx.outageNodes.has(row.nodeId!)).map((row) => row.code);
    if (valves.length) out.push(`${label}の開いている弁 ${valves.join("・")} を点検で閉めることになります`);
  }
  return out;
}

/** 開始できないときの案内 */
export const OPERATION_BLOCK_HINT = "その運用を終了するか、点検範囲を含む運用停止範囲を ③ で設定すると開始できます。";
