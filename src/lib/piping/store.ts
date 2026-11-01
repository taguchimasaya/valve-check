import type { PlanRow, SavedPlan } from "./checklist";
import { needsDayParams, type DayParams } from "./workTypes";
import type { Operation } from "./operations";
import type { ValveState } from "./types";
import type { PipingLayout } from "./layout";

// 配管系統図機能の共有ストア（現場・制御室で同じデータを見る）。
// 保存先は API（/api/piping）側で切り替わる：本番は Supabase の piping_store テーブル、
// ローカル開発では .local-data/ のファイル。既存システムのテーブルには書き込まない。

export type ValveRecord = {
  result: "OK" | "NG";
  checkedAt: string;
  confirmedAt?: string;
};

export type ExecEvent = { at: string; type: "valve" | "step" | "info"; text: string };

export type Execution = {
  id: string;
  planId: string;
  planName: string;
  startedAt: string;
  /** 現在の工程（0=作業前 は確認不要のため、1から開始） */
  currentStep: number;
  status: "in_progress" | "completed";
  /** key: `${stepIndex}:${code}` */
  records: Record<string, ValveRecord>;
  events: ExecEvent[];
  /** 当日に選んだ充填元タンク・移送ポンプ（充填ラインを使う作業のみ） */
  fillSupply?: { tank: string; pump: string; pipeIds: string[] };
  /** 当日の選択で充填工程に加えた弁の行（末端部作業・タンク縁切りでは当日の選択で作る行すべて） */
  extraRows?: PlanRow[];
  /** 末端部作業・タンク縁切り：当日に選んだタンク・ポンプ */
  dayParams?: DayParams;
  stepNotes?: Record<number, string>;
  stepRoutes?: Record<number, { nodeIds: string[]; pipeIds: string[] }>;
  /** 「循環完了」「移送完了」を押した工程（工程番号 → 日時） */
  manualDone?: Record<number, string>;
};

export type PipingStore = {
  version: number;
  plans: SavedPlan[];
  executions: Execution[];
  operations: Operation[];
  /** オペレーターが図面上で手動変更した弁状態（運用・待機状態より優先） */
  valveOverrides: Record<string, ValveState>;
  /** 制御室の操作記録（運用入力・弁の手動変更） */
  log: ExecEvent[];
  /** 図面の下絵に合わせた機器の配置 */
  layout?: PipingLayout;
};

export type StoreAction =
  | { action: "savePlan"; plan: SavedPlan }
  | { action: "deletePlan"; id: string }
  | { action: "startExecution"; planId: string; id: string }
  | { action: "record"; execId: string; step: number; code: string; result: "OK" | "NG" }
  | { action: "undoRecord"; execId: string; step: number; code: string }
  | { action: "confirm"; execId: string; step: number; code: string }
  | { action: "advanceStep"; execId: string }
  | { action: "completeExecution"; execId: string }
  | { action: "deleteExecution"; execId: string }
  | { action: "setOperations"; operations: Operation[] }
  | { action: "setValve"; id: string; label: string; state: ValveState | null }
  | { action: "clearValveOverrides" }
  | { action: "setLayout"; layout: PipingLayout }
  | {
      action: "setDayParams";
      execId: string;
      params: DayParams;
      rows: PlanRow[];
      stepNotes: Record<number, string>;
      stepRoutes: Record<number, { nodeIds: string[]; pipeIds: string[] }>;
    }
  | { action: "markStepDone"; execId: string; step: number }
  | {
      action: "setFillSupply";
      execId: string;
      fillSupply: { tank: string; pump: string; pipeIds: string[] };
      rows: PlanRow[];
    };

export const EMPTY_STORE: PipingStore = {
  version: 0,
  plans: [],
  executions: [],
  operations: [],
  valveOverrides: {},
  log: [],
};

export const recordKey = (step: number, code: string) => `${step}:${code}`;

/** 点検で使うチェックリスト：元のチェックリストに、当日の選択で加えた行・充填元を重ねたもの */
export function execPlan(plan: SavedPlan, exec: Execution): SavedPlan {
  if (!exec.extraRows?.length && !exec.fillSupply && !exec.stepNotes && !exec.stepRoutes) return plan;
  const codes = new Set(plan.rows.map((r) => r.code));
  // 末端部作業・タンク縁切りは、当日の選択で作った行がチェックリストそのものになる
  const replace = needsDayParams(plan) && !!exec.dayParams;
  return {
    ...plan,
    rows: replace ? exec.extraRows ?? [] : [...plan.rows, ...(exec.extraRows ?? []).filter((r) => !codes.has(r.code))],
    fillSupply: exec.fillSupply ?? plan.fillSupply,
    stepNotes: { ...(plan.stepNotes ?? {}), ...(exec.stepNotes ?? {}) },
    stepRoutes: { ...(plan.stepRoutes ?? {}), ...(exec.stepRoutes ?? {}) },
  };
}

export async function fetchStore(): Promise<PipingStore> {
  const res = await fetch("/api/piping", { cache: "no-store" });
  if (!res.ok) throw new Error((await res.text()) || "配管系統図のデータを読み込めませんでした");
  return res.json();
}

export async function dispatch(action: StoreAction): Promise<PipingStore> {
  const res = await fetch("/api/piping", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });
  if (!res.ok) throw new Error((await res.text()) || "保存に失敗しました");
  return res.json();
}
