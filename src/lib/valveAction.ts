export type TargetState = "open" | "close";

export type RequiredStepRef = {
  itemId: string;
  itemNo: number;
  target: TargetState;
};

export type ValveAction = "open-operate" | "open-confirm" | "close-operate" | "close-confirm";

// あるバルブについて、直前の必須工程（無ければ「作業前」の初期状態）と状態を比較し、
// 状態が変わっていれば「操作」、変わっていなければ「確認」と判定する。
export function classifyAction(
  requiredSequence: RequiredStepRef[],
  itemId: string
): ValveAction | null {
  const sorted = [...requiredSequence].sort((a, b) => a.itemNo - b.itemNo);
  const idx = sorted.findIndex((s) => s.itemId === itemId);
  if (idx === -1) return null;
  const current = sorted[idx];
  const prev = idx > 0 ? sorted[idx - 1] : null;
  const isConfirm = prev ? prev.target === current.target : false;
  return `${current.target}-${isConfirm ? "confirm" : "operate"}` as ValveAction;
}

export function valveActionMessage(code: string, action: ValveAction): string {
  const stateLabel = action.startsWith("open") ? "開" : "閉";
  const verb = action.endsWith("confirm") ? "確認" : "操作";
  return `${code}を${stateLabel}${verb}しました`;
}

export function stepCompleteMessage(templateName: string, stepName: string): string {
  return `${templateName}、${stepName}が完了しました`;
}

export function stepStartMessage(templateName: string, stepName: string): string {
  return `${templateName}、${stepName}を開始しました`;
}
