import type { SavedPlan } from "./checklist";
import type { Graph } from "./graph";

// チェックリストの「周期」（月次・年次など）と、② 現場点検で「機器名×周期」で探すための補助。
// 周期は ① の保存時に入力し（任意の文字も可）、② の一覧からも後で付けられる。

/** 既定の周期の候補（これ以外の文字も入れられる） */
export const DEFAULT_PERIODS = ["日次", "週次", "月次", "3か月", "6か月", "年次", "臨時"];

export const PERIOD_MAX = 20;

/** 候補：既定の周期＋保存済みのチェックリストで使われている周期 */
export function periodOptions(plans: Pick<SavedPlan, "period">[]): string[] {
  const used = plans.map((p) => p.period?.trim()).filter((p): p is string => !!p);
  return [...new Set([...DEFAULT_PERIODS, ...used])];
}

/** チェックリストの対象機器（「機器番号 名称」）。Excel 取込など対象が無いものは空 */
export function planEquipment(plan: SavedPlan, graph: Pick<Graph, "nodeById" | "facility">): string[] {
  const label = (id: string) => {
    const n = graph.nodeById.get(id);
    if (!n) return id;
    // 名称に機器番号が含まれていれば名称だけ（例：「T-104 貯蔵タンク」）
    return !n.name || n.name.includes(n.label) ? n.name || n.label : `${n.label} ${n.name}`;
  };
  const pipeLabel = (id: string) => {
    const p = graph.facility.pipes.find((x) => x.id === id);
    return p ? `配管 ${p.id}（${p.sizeA}A）` : `配管 ${id}`;
  };
  const out: string[] = [];
  for (const t of plan.targets ?? []) out.push(t.type === "node" ? label(t.id) : pipeLabel(t.id));
  for (const id of [plan.isolationTank, plan.fireTestTank, plan.customTarget]) if (id) out.push(label(id));
  for (const id of plan.flushPipeIds ?? []) out.push(pipeLabel(id));
  return [...new Set(out)];
}
