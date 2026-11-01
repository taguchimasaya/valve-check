import type { DiagramBox, NodeMark, PipeLayer } from "@/components/piping/PipingDiagram";
import { outageRange, type OutageRange } from "./outages";
import { stateAtStep, type SavedPlan } from "./checklist";
import { execView, type ExecView } from "./execution";
import { flowColor, stepFlow } from "./flow";
import type { Graph } from "./graph";
import { currentValveState, OPERATION_META, type OperationState } from "./operations";
import { execPlan, type Execution, type PipingStore } from "./store";
import type { ValveState } from "./types";

// 「今の状態」の系統図（制御室・トップ画面で共通）：
// 運用ライン（流れ）＋点検中作業の範囲（点滅）・操作待ち／操作済みの弁・抜取／充填の流れ＋弁の手動変更。

export type LiveView = { exec: Execution; plan: SavedPlan; v: ExecView };

export type LiveDiagram = {
  opState: OperationState;
  /** 運用・手動変更・点検の操作記録を反映した、今の弁状態 */
  valveState: Record<string, ValveState>;
  layers: PipeLayer[];
  marks: Record<string, NodeMark>;
  views: LiveView[];
  /** 当日の運用停止範囲 */
  outages: (OutageRange & { at: string; note?: string })[];
  boxes: DiagramBox[];
  /** 運用ラインが停止範囲を通っている */
  outageConflicts: string[];
};

export const OUTAGE_COLOR = "#475569";

export function liveDiagram(g: Graph, store: PipingStore | null, hiddenExecIds: string[] = []): LiveDiagram {
  const opState = currentValveState(g, store?.operations ?? [], store?.valveOverrides ?? {});
  // 点検ライン（太い赤・点滅）を下地に、運用ライン（細い流れ表示）を上に重ねる
  const inspLayers: PipeLayer[] = [];
  const opLayers: PipeLayer[] = [];
  opState.routes.forEach((r) => {
    if (r.error) return;
    opLayers.push({ key: `op-${r.op.id}`, pipeIds: r.pipeIds, color: OPERATION_META[r.op.kind].color, width: 5, flow: true });
  });

  // 運用状態に、点検中作業の操作記録を順に重ねる
  let valveState = opState.valveState;
  const marks: Record<string, NodeMark> = {};
  const views: LiveView[] = [];
  const running = (store?.executions ?? []).filter((e) => e.status === "in_progress" && !hiddenExecIds.includes(e.id));
  for (const e of running) {
    const raw = store!.plans.find((p) => p.id === e.planId);
    if (!raw) continue;
    const plan = execPlan(raw, e);
    const v = execView(plan, e, valveState);
    valveState = v.valveState;
    inspLayers.push({ key: `insp-${e.id}`, pipeIds: plan.regionPipeIds, color: "#ef4444", width: 13, opacity: 0.6, blink: true });
    // 抜取・充填の工程中は、燃料の流れる向きを矢印で示す
    const flow = stepFlow(g, plan, e.currentStep, stateAtStep(opState.valveState, plan.rows, e.currentStep));
    if (flow) {
      opLayers.push({
        key: `flow-${e.id}`,
        pipeIds: [...flow.directions.keys()],
        directions: flow.directions,
        color: flowColor(flow.kind),
        width: 5,
        flow: true,
      });
    }
    Object.assign(marks, v.marks);
    views.push({ exec: e, plan, v });
  }
  Object.keys(store?.valveOverrides ?? {}).forEach((id) => {
    if (!marks[id]) marks[id] = "manual";
  });

  // 運用停止範囲：灰色の破線の帯（一番下）と、範囲名の枠
  const outages = (store?.outages ?? [])
    .map((o) => {
      const r = outageRange(g, o.key);
      return r ? { ...r, at: o.at, note: o.note } : null;
    })
    .filter((o): o is NonNullable<typeof o> => !!o);
  const outLayers: PipeLayer[] = outages.map((o) => ({
    key: `out-${o.def.key}`,
    pipeIds: o.pipeIds,
    color: OUTAGE_COLOR,
    width: 16,
    opacity: 0.55,
    dash: "10 7",
  }));
  const boxes: DiagramBox[] = outages.map((o) => ({ key: `out-${o.def.key}`, ...o.box, label: `運用停止：${o.def.label.replace("停止", "")}`, color: OUTAGE_COLOR }));
  const outPipes = new Map<string, string>();
  outages.forEach((o) => o.pipeIds.forEach((p) => outPipes.set(p, o.def.label)));
  const outageConflicts: string[] = [];
  opState.routes.forEach((r) => {
    const hit = [...r.pipeIds].map((p) => outPipes.get(p)).find(Boolean);
    if (hit) outageConflicts.push(`${OPERATION_META[r.op.kind].label}の運用ラインが「${hit}」の範囲を通っています`);
  });

  return { opState, valveState, layers: [...outLayers, ...inspLayers, ...opLayers], marks, views, outages, boxes, outageConflicts };
}
