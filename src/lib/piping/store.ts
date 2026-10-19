import type { SavedPlan } from "./checklist";
import type { Operation } from "./operations";

// ローカル試作用の共有ストア（next dev を動かしているPCの .local-data/ に保存）。
// 現場（iPad）と制御室（PC）が同じ dev サーバーを見ることで状態を共有する。
// 既存システムの Supabase には一切書き込まない。

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
};

export type PipingStore = {
  version: number;
  plans: SavedPlan[];
  executions: Execution[];
  operations: Operation[];
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
  | { action: "setOperations"; operations: Operation[] };

export const EMPTY_STORE: PipingStore = { version: 0, plans: [], executions: [], operations: [] };

export const recordKey = (step: number, code: string) => `${step}:${code}`;

export async function fetchStore(): Promise<PipingStore> {
  const res = await fetch("/api/piping", { cache: "no-store" });
  if (!res.ok) throw new Error("ローカルストアを読み込めませんでした");
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
