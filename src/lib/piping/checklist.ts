import * as XLSX from "xlsx";
import {
  buildProcedureExportWorkbook,
  parseProcedureChecklistFile,
  type RequiredStep,
} from "@/lib/parseProcedureChecklistFile";
import type { Graph } from "./graph";
import type { IsolationResult, Target } from "./isolation";
import type { ValveState } from "./types";

// 抜取計画 → 「バルブ×工程」チェックリスト。
// 既存システムの手順チェックリスト（Excel取込形式）と同じ構造で持ち、同じ形式で書き出せるようにする。

// 抜取 → （作業） → 充填 → 復旧。作業そのものは弁操作が無いため工程に含めない。
export const PLAN_STEPS = ["作業前", "ラインナップ", "抜取", "充填", "復旧"];

export type RowRole = "boundary" | "internal" | "drain" | "gauge" | "fill" | "imported";

export const ROLE_LABEL: Record<RowRole, string> = {
  boundary: "遮断弁",
  internal: "範囲内弁",
  drain: "ドレン弁",
  gauge: "圧力計",
  fill: "充填弁",
  imported: "取込",
};

export type PlanRow = {
  code: string;
  /** 図面上のノードID（図面に無いバルブは null） */
  nodeId: string | null;
  name: string;
  role: RowRole;
  /** 工程ごとの目標状態（null＝その工程では対象外「／」） */
  states: (ValveState | null)[];
  /** 操作上の注意（微開など） */
  note?: string;
};

export type SavedPlan = {
  id: string;
  name: string;
  purpose: string;
  createdAt: string;
  source: "planner" | "excel";
  targets: Target[];
  regionPipeIds: string[];
  regionNodeIds: string[];
  /** 液封の恐れがある区間（図面で注意表示する） */
  sealPipeIds: string[];
  /** 充填に使う配管（充填工程中に図面で表示する） */
  fillPipeIds?: string[];
  steps: string[];
  rows: PlanRow[];
  /** 作成画面で再編集するための入力条件 */
  planner?: {
    expandToDrain: boolean;
    baselineMode: "normal" | "operation";
    extraSectionIds: string[];
    excludedDrains: string[];
    gaugeIds: string[];
    portableLpm: number;
    fillLpm?: number;
  };
  summary: {
    volumeL: number | null;
    drainMinutes: number | null;
    fillMinutes?: number | null;
    drains: string[];
    warnings: string[];
    notes: string[];
  };
};

export function buildPlanRows(
  g: Graph,
  iso: IsolationResult,
  baseline: Record<string, ValveState>,
  drainIds: string[],
  gaugeIds: string[]
): PlanRow[] {
  // 工程：0 作業前 / 1 ラインナップ（遮断弁を閉め、抜取範囲を構成する） / 2 抜取 / 3 充填 / 4 復旧
  const rows: PlanRow[] = [];
  const row = (id: string, role: RowRole, states: (ValveState | null)[], note?: string) => {
    const n = g.nodeById.get(id)!;
    rows.push({ code: n.label, nodeId: id, name: n.name, role, states, ...(note ? { note } : {}) });
  };
  const fillOpen = new Set(iso.fill.openValves);
  const isFillValve = (v: string) => !!g.nodeById.get(v)!.fillLine;
  iso.boundaryValves.forEach((v) => {
    const base = baseline[v] ?? "close";
    if (!fillOpen.has(v)) {
      row(v, "boundary", [base, "close", null, null, base]);
    } else if (isFillValve(v)) {
      row(v, "fill", [base, "close", null, "open", base]);
    } else {
      // 充填ラインが無い場合：遮断弁を微開して充填し、そのまま復旧する
      row(v, "boundary", [base, "close", null, "open", base], "充填時は微開で徐々に開く");
    }
  });
  iso.internalValves.forEach((v) => {
    const base = baseline[v] ?? "close";
    row(v, "internal", base === "open" ? ["open", "open", null, null, null] : ["close", "open", null, null, "close"]);
  });
  drainIds.forEach((d) => row(d, "drain", ["close", null, "open", "close", null]));
  gaugeIds.forEach((d) => row(d, "gauge", ["close", "open", null, null, "close"]));
  // 遮断範囲の外側にある充填ライン上の弁（充填元弁など）
  iso.fill.openValves
    .filter((v) => !iso.boundaryValves.includes(v))
    .forEach((v) => {
      const base = baseline[v] ?? "close";
      row(v, "fill", [base, null, null, "open", base]);
    });
  return rows;
}

/** 既存システムの手順チェックリスト形式（Excel）として書き出す */
export function planToWorkbook(plan: Pick<SavedPlan, "steps" | "rows">): XLSX.WorkBook {
  const rows = plan.rows.map((r) => {
    const requiredSteps: RequiredStep[] = [];
    r.states.forEach((s, i) => {
      if (s) requiredSteps.push({ stepIndex: i, target: s });
    });
    return { equipmentCode: r.code, requiredSteps };
  });
  return buildProcedureExportWorkbook(plan.steps, rows);
}

/** 既存システムの機器マスター取込形式で、チェックリスト対象バルブを書き出す */
export function planToEquipmentWorkbook(g: Graph, plan: Pick<SavedPlan, "rows">): XLSX.WorkBook {
  const kindLabel: Record<string, string> = { valve: "仕切弁", drain: "ドレン弁", gauge: "圧力計元弁" };
  const aoa: string[][] = [["機器番号", "機器名称", "階層1", "階層2", "階層3", "階層4", "バルブ種別"]];
  plan.rows.forEach((r) => {
    const n = r.nodeId ? g.nodeById.get(r.nodeId) : undefined;
    aoa.push([r.code, r.name, "仮想空港給油施設", n?.area ?? "", "", "", kindLabel[n?.kind ?? "valve"] ?? ""]);
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "機器マスター");
  return wb;
}

/** 既存形式のExcelチェックリストを読み込み、図面上のバルブと対応付ける */
export async function importPlanFromExcel(
  g: Graph,
  file: File
): Promise<{ plan: SavedPlan; unmatched: string[]; errors: string[] }> {
  const parsed = await parseProcedureChecklistFile(file);
  const byLabel = new Map(g.facility.nodes.map((n) => [n.label, n.id]));
  const unmatched: string[] = [];
  const rows: PlanRow[] = parsed.rows.map((r) => {
    const nodeId = byLabel.get(r.equipmentCode) ?? null;
    if (!nodeId) unmatched.push(r.equipmentCode);
    const states: (ValveState | null)[] = parsed.steps.map(() => null);
    r.requiredSteps.forEach((s) => (states[s.stepIndex] = s.target));
    return {
      code: r.equipmentCode,
      nodeId,
      name: nodeId ? g.nodeById.get(nodeId)!.name : "（図面に未登録）",
      role: "imported",
      states,
    };
  });
  const plan: SavedPlan = {
    id: newId(),
    name: file.name.replace(/\.[^.]+$/, ""),
    purpose: "既存チェックリスト取込",
    createdAt: new Date().toISOString(),
    source: "excel",
    targets: [],
    regionPipeIds: [],
    regionNodeIds: [],
    sealPipeIds: [],
    steps: parsed.steps,
    rows,
    summary: { volumeL: null, drainMinutes: null, drains: [], warnings: [], notes: [] },
  };
  return { plan, unmatched, errors: parsed.errors.map((e) => `${e.rowNumber}行目：${e.message}`) };
}

export function downloadWorkbook(wb: XLSX.WorkBook, fileName: string) {
  XLSX.writeFile(wb, fileName);
}

export function newId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function stateGlyph(s: ValveState | null) {
  return s === "close" ? "☓" : s === "open" ? "○" : "／";
}

/** ある工程を終えた時点の弁状態（作業前の状態に、各工程の目標状態を順に重ねる） */
export function stateAtStep(
  baseline: Record<string, ValveState>,
  rows: PlanRow[],
  step: number
): Record<string, ValveState> {
  const s = { ...baseline };
  for (let i = 0; i <= step; i++) {
    rows.forEach((r) => {
      const t = r.states[i];
      if (r.nodeId && t) s[r.nodeId] = t;
    });
  }
  return s;
}

/** 直前の対象工程から状態が変わる（＝実際に操作する）か */
export function isOperateCell(row: PlanRow, step: number): boolean {
  const cur = row.states[step];
  if (!cur) return false;
  for (let i = step - 1; i >= 0; i--) {
    if (row.states[i]) return row.states[i] !== cur;
  }
  return step !== 0;
}
