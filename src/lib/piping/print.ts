import { isOperateCell, stateAtStep, type PlanRow, type SavedPlan } from "./checklist";
import { stepFlow } from "./flow";
import { pipePoints, type Graph } from "./graph";
import type { ValveState } from "./types";

// 印刷（PDF）用の計算：図面の出力範囲と、工程ごとの操作一覧。

export type Box = { x: number; y: number; width: number; height: number };

/**
 * その作業で最も広い作業範囲（全工程の対象弁・抜取範囲・抜取／充填の流れ・充填元の経路）を囲む範囲。
 * 全工程の図面をこの同じ範囲で出力する。用紙（横長）に合わせて縦横比をそろえる。
 */
export function workBounds(g: Graph, plan: SavedPlan, base: Record<string, ValveState>, aspect = 1.85): Box {
  const xs: number[] = [];
  const ys: number[] = [];
  const addPoint = (x: number, y: number) => {
    xs.push(x);
    ys.push(y);
  };
  const addPipe = (pid: string) => {
    const p = g.pipeById.get(pid);
    if (p) pipePoints(g, p).forEach(([x, y]) => addPoint(x, y));
  };
  plan.regionPipeIds.forEach(addPipe);
  (plan.fillPipeIds ?? []).forEach(addPipe);
  (plan.fillSupply?.pipeIds ?? []).forEach(addPipe);
  plan.rows.forEach((r) => {
    const n = r.nodeId ? g.nodeById.get(r.nodeId) : undefined;
    if (n) addPoint(n.x, n.y);
  });
  plan.steps.forEach((_, i) => {
    const flow = stepFlow(g, plan, i, stateAtStep(base, plan.rows, i));
    flow?.directions.forEach((_, pid) => addPipe(pid));
  });
  if (!xs.length) return { x: 0, y: 0, width: g.facility.width, height: g.facility.height };

  const pad = 70;
  let x0 = Math.min(...xs) - pad;
  let x1 = Math.max(...xs) + pad;
  let y0 = Math.min(...ys) - pad;
  let y1 = Math.max(...ys) + pad;
  // 小さすぎる範囲は広げ、用紙の縦横比にそろえる
  let w = Math.max(x1 - x0, 400);
  let h = Math.max(y1 - y0, 260);
  if (w / h > aspect) h = w / aspect;
  else w = h * aspect;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  x0 = cx - w / 2;
  y0 = cy - h / 2;
  x1 = x0 + w;
  y1 = y0 + h;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export type StepOps = { opened: PlanRow[]; closed: PlanRow[]; confirmed: PlanRow[]; started: PlanRow[]; stopped: PlanRow[] };

/** ある工程で開操作・閉操作・確認する弁 */
export function stepOps(plan: SavedPlan, step: number): StepOps {
  const ops: StepOps = { opened: [], closed: [], confirmed: [], started: [], stopped: [] };
  if (step === 0) return ops;
  plan.rows.forEach((r) => {
    const s = r.states[step];
    if (!s) return;
    if (!isOperateCell(r, step)) ops.confirmed.push(r);
    else if (r.role === "pump") (s === "open" ? ops.started : ops.stopped).push(r);
    else if (s === "open") ops.opened.push(r);
    else ops.closed.push(r);
  });
  return ops;
}
