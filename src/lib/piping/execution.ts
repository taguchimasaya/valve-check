import type { NodeMark } from "@/components/piping/PipingDiagram";
import type { PlanRow, SavedPlan } from "./checklist";
import { recordKey, type Execution } from "./store";
import type { ValveState } from "./types";

// 点検実施中（現場・制御室共通）の表示状態を求める。

export type ExecView = {
  /** 現在工程で操作・確認が必要な行 */
  targets: PlanRow[];
  done: number;
  total: number;
  stepComplete: boolean;
  isLastStep: boolean;
  /** 記録をもとにした、現時点の実際の弁状態 */
  valveState: Record<string, ValveState>;
  marks: Record<string, NodeMark>;
};

export function execView(
  plan: SavedPlan,
  exec: Execution,
  base: Record<string, ValveState>
): ExecView {
  const step = exec.currentStep;
  // 「作業前」は想定状態の記録なので重ねない（実際の状態＝運用状態のまま）
  const valveState = { ...base };
  for (let i = 1; i < step; i++) {
    plan.rows.forEach((r) => {
      if (r.nodeId && r.states[i]) valveState[r.nodeId] = r.states[i]!;
    });
  }
  const targets = plan.rows.filter((r) => r.states[step]);
  const marks: Record<string, NodeMark> = {};
  let done = 0;
  targets.forEach((r) => {
    const rec = exec.records[recordKey(step, r.code)];
    if (rec?.result === "OK") {
      done++;
      if (r.nodeId) valveState[r.nodeId] = r.states[step]!;
    }
    if (!r.nodeId) return;
    marks[r.nodeId] = !rec ? "pending" : rec.result === "NG" ? "ng" : rec.confirmedAt ? "confirmed" : "done";
  });
  return {
    targets,
    done,
    total: targets.length,
    stepComplete: targets.length > 0 && done === targets.length,
    isLastStep: step >= plan.steps.length - 1,
    valveState,
    marks,
  };
}

/** 点検計画と、制御室で入力された運用との干渉 */
export function planConflicts(
  plan: Pick<SavedPlan, "rows" | "regionPipeIds">,
  opState: { valveState: Record<string, ValveState>; routes: { pipeIds: Set<string>; openValves: string[]; op: { kind: string } }[] },
  opLabel: (kind: string) => string
): string[] {
  const out: string[] = [];
  const openBy = new Map<string, string>();
  opState.routes.forEach((r) => r.openValves.forEach((v) => openBy.set(v, opLabel(r.op.kind))));
  plan.rows.forEach((r) => {
    if (!r.nodeId) return;
    if (openBy.has(r.nodeId) && r.states.some((s) => s === "close")) {
      out.push(`${r.code}：運用中の「${openBy.get(r.nodeId)}」ラインのバルブを閉止します`);
    }
    const expected = r.states[0];
    const actual = opState.valveState[r.nodeId];
    if (expected && actual && expected !== actual) {
      out.push(`${r.code}：作業前の想定（${expected === "open" ? "開" : "閉"}）と現在の状態（${actual === "open" ? "開" : "閉"}）が異なります`);
    }
  });
  const region = new Set(plan.regionPipeIds);
  opState.routes.forEach((r) => {
    const n = [...r.pipeIds].filter((p) => region.has(p)).length;
    if (n) out.push(`点検範囲を「${opLabel(r.op.kind)}」ラインが通過しています（${n}区間）`);
  });
  return [...new Set(out)];
}

export function actionText(row: PlanRow, step: number) {
  const t = row.states[step];
  let prev: ValveState | null = null;
  for (let i = step - 1; i >= 0; i--) {
    if (row.states[i]) {
      prev = row.states[i];
      break;
    }
  }
  const verb = prev && prev === t ? "確認" : "操作";
  return `${t === "close" ? "閉" : "開"}${verb}`;
}
