import { normalValveState, shortestPath, type Graph } from "./graph";
import type { ValveState } from "./types";

// 制御室で入力する「運用」（受入・払出・移送・バイパス返油）から、
// 実際に燃料が流れるライン（運用ライン）と弁の開閉状態を求める。

export type Operation =
  | { id: string; kind: "receive"; system: "A" | "B"; tank: string; strainers: number[]; filters: number[] }
  | { id: string; kind: "issue"; tanks: string[]; system: 1 | 2; pumps: number[] }
  | { id: string; kind: "transfer"; fromTank: string; toTank: string; pumps: number[] }
  | { id: string; kind: "bypass"; fromTank: string; toTank: string; system: 1 | 2; pumps: number[] };

export type OperationKind = Operation["kind"];

export const OPERATION_META: Record<OperationKind, { label: string; color: string }> = {
  receive: { label: "受入", color: "#0284c7" },
  issue: { label: "払出", color: "#16a34a" },
  transfer: { label: "移送", color: "#9333ea" },
  bypass: { label: "バイパス返油", color: "#ea580c" },
};

export const TANKS = [1, 2].flatMap((y) => [1, 2, 3, 4, 5, 6].map((i) => `T-${y}0${i}`));

export function describeOperation(op: Operation): string {
  switch (op.kind) {
    case "receive":
      return `受入系統${op.system} → ${op.tank}（ストレーナー${op.strainers.join("・")}／フィルター${op.filters.join("・")}）`;
    case "issue":
      return `${op.tanks.join("・")} → 払出系統${op.system}（P-${op.pumps.map((p) => `${op.system}${p}`).join("・P-")}）→ ハイドラント${op.system}`;
    case "transfer":
      return `${op.fromTank} → 移送ポンプ（TP-${op.pumps.join("・TP-")}）→ ${op.toTank}`;
    case "bypass":
      return `${op.fromTank} → 払出系統${op.system}（P-${op.pumps.map((p) => `${op.system}${p}`).join("・P-")}）→ バイパス → ${op.toTank}`;
  }
}

export type OperationRoute = {
  op: Operation;
  pipeIds: Set<string>;
  nodeIds: Set<string>;
  openValves: string[];
  closeValves: string[];
  error?: string;
};

const tankNo = (t: string) => t.replace("T-", "");

function nozzle(tank: string, key: "R" | "I" | "T") {
  return `V-${tankNo(tank)}${key}`;
}
function otherNozzles(tank: string, key: "R" | "I" | "T") {
  return (["R", "I", "T"] as const).filter((k) => k !== key).map((k) => nozzle(tank, k));
}

export function routeOperation(g: Graph, op: Operation): OperationRoute {
  const pipeIds = new Set<string>();
  const nodeIds = new Set<string>();
  const closeValves: string[] = [];
  let error: string | undefined;

  function seg(from: string, to: string, blocked: string[] = []) {
    if (error) return;
    const r = shortestPath(g, from, to, new Set(blocked));
    if (!r) {
      error = `${g.nodeById.get(from)?.label ?? from} → ${g.nodeById.get(to)?.label ?? to} の経路が見つかりません`;
      return;
    }
    r.pipeIds.forEach((p) => pipeIds.add(p));
    r.nodeIds.forEach((n) => nodeIds.add(n));
  }
  function fromTank(tank: string, key: "R" | "I" | "T") {
    seg(tank, nozzle(tank, key), otherNozzles(tank, key));
  }

  switch (op.kind) {
    case "receive": {
      const p = `R${op.system}`;
      const unusedS = [1, 2].filter((k) => !op.strainers.includes(k));
      const unusedF = [1, 2, 3].filter((k) => !op.filters.includes(k));
      const blocked = [...unusedS.map((k) => `STR-${p}${k}`), ...unusedF.map((k) => `FLT-${p}${k}`)];
      if (!op.strainers.length || !op.filters.length) error = "ストレーナー・フィルターを1基以上選択してください";
      op.strainers.forEach((s) => {
        seg(`SRC-${op.system}`, `STR-${p}${s}`, blocked);
        op.filters.forEach((f) => seg(`STR-${p}${s}`, `FLT-${p}${f}`, blocked));
      });
      op.filters.forEach((f) => seg(`FLT-${p}${f}`, nozzle(op.tank, "R"), blocked));
      fromTank(op.tank, "R");
      unusedS.forEach((k) => closeValves.push(`V-${p}S${k}I`, `V-${p}S${k}O`));
      unusedF.forEach((k) => closeValves.push(`V-${p}F${k}I`, `V-${p}F${k}O`));
      break;
    }
    case "issue": {
      if (!op.tanks.length || !op.pumps.length) error = "タンクとポンプを1つ以上選択してください";
      op.tanks.forEach((t) => {
        fromTank(t, "I");
        op.pumps.forEach((k) => seg(nozzle(t, "I"), `P-${op.system}${k}`));
      });
      op.pumps.forEach((k) => seg(`P-${op.system}${k}`, `HYD-${op.system}`));
      break;
    }
    case "transfer": {
      if (op.fromTank === op.toTank) error = "移送元と移送先が同じタンクです";
      if (!op.pumps.length) error = "移送ポンプを1台以上選択してください";
      fromTank(op.fromTank, "T");
      op.pumps.forEach((k) => {
        seg(nozzle(op.fromTank, "T"), `TP-${k}`);
        seg(`TP-${k}`, nozzle(op.toTank, "R"));
      });
      fromTank(op.toTank, "R");
      break;
    }
    case "bypass": {
      if (op.fromTank === op.toTank) error = "払出元と返油先が同じタンクです";
      if (!op.pumps.length) error = "ポンプを1台以上選択してください";
      fromTank(op.fromTank, "I");
      op.pumps.forEach((k) => {
        seg(nozzle(op.fromTank, "I"), `P-${op.system}${k}`);
        seg(`P-${op.system}${k}`, `V-BP${op.system}`, [`V-H${op.system}`]);
      });
      seg(`V-BP${op.system}`, nozzle(op.toTank, "R"));
      fromTank(op.toTank, "R");
      break;
    }
  }

  const openValves = [...nodeIds].filter((n) => g.nodeById.get(n)?.kind === "valve");
  return { op, pipeIds, nodeIds, openValves, closeValves, error };
}

export type OperationState = {
  routes: OperationRoute[];
  valveState: Record<string, ValveState>;
  conflicts: string[];
};

/** 運用状態に、オペレーターの手動変更を重ねた現在の弁状態 */
export function currentValveState(
  g: Graph,
  ops: Operation[],
  overrides: Record<string, ValveState> = {}
): OperationState {
  const s = applyOperations(g, ops);
  const valveState = { ...s.valveState, ...overrides };
  const conflicts = [...s.conflicts];
  s.routes.forEach((r) => {
    if (r.error) return;
    r.openValves.forEach((v) => {
      if (overrides[v] === "close") {
        conflicts.push(`${v}：「${OPERATION_META[r.op.kind].label}」ライン上のバルブが手動で閉になっています`);
      }
    });
  });
  return { ...s, valveState, conflicts };
}

/** 待機状態に各運用の開閉を重ねた弁状態 */
export function applyOperations(g: Graph, ops: Operation[]): OperationState {
  const valveState = normalValveState(g.facility);
  const routes = ops.map((op) => routeOperation(g, op));
  const conflicts: string[] = [];
  const openBy = new Map<string, Operation>();
  routes.forEach((r) => {
    if (r.error) return;
    r.openValves.forEach((v) => {
      valveState[v] = "open";
      openBy.set(v, r.op);
    });
  });
  routes.forEach((r) => {
    if (r.error) return;
    r.closeValves.forEach((v) => {
      if (openBy.has(v)) {
        conflicts.push(
          `${v}：「${OPERATION_META[openBy.get(v)!.kind].label}」で開、「${OPERATION_META[r.op.kind].label}」で閉が必要です`
        );
        return;
      }
      valveState[v] = "close";
    });
  });
  // 同一の配管を別々の運用が使う場合は混油のおそれ
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const shared = [...routes[i].pipeIds].filter((p) => routes[j].pipeIds.has(p));
      if (shared.length) {
        conflicts.push(
          `「${OPERATION_META[routes[i].op.kind].label}」と「${OPERATION_META[routes[j].op.kind].label}」が同じ配管（${shared.length}区間）を共用しています`
        );
      }
    }
  }
  return { routes, valveState, conflicts };
}
