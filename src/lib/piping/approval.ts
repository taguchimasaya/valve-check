import { can, type Permission, type Role } from "../roles";
import type { SavedPlan } from "./checklist";
import type { ChecklistRules } from "./rules";

// チェックリストの承認フロー：作成者 → チームリーダー → G長 → 制御室（制御室の段は ⑤ 共通の設定で拠点ごとに有無を決める）。
// 順番どおりにしか承認できず、各段はその段の承認の機能を持つ人（権限×機能の表で決まる）だけが承認できる。作成者本人は承認できない。
// 差し戻すと承認はすべて外れる。保存し直したチェックリストは最初から承認をやり直す。点検は最後の段まで承認されてから開始できる。

export const STAGES = ["leader", "manager", "control"] as const;
export type ApprovalStage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<ApprovalStage, string> = { leader: "チームリーダー", manager: "G長", control: "制御室" };
/** 各段の承認の機能（どのロールが使えるかは権限×機能の表で決まる） */
export const STAGE_PERM: Record<ApprovalStage, Permission> = { leader: "approveLeader", manager: "approveManager", control: "approveControl" };

export type ApprovalSign = { by: string; byId?: string; at: string };
export type Rejection = { by: string; at: string; reason: string; stage: ApprovalStage };

/** 承認フローの設定（⑤ 共通）：制御室の段の有無と、承認のメールを送るか（初期の大量配信を避けるため既定は送らない） */
export type ApprovalRules = { requireControl: boolean; notifyEmail: boolean };
export const DEFAULT_APPROVAL_RULES: ApprovalRules = { requireControl: true, notifyEmail: false };
export const approvalRulesOf = (rules: ChecklistRules | null | undefined): ApprovalRules => ({
  ...DEFAULT_APPROVAL_RULES,
  ...(rules?.approval ?? {}),
});

/** この拠点の承認の段（順番どおり） */
export function approvalStages(rules: ChecklistRules | null | undefined): ApprovalStage[] {
  return STAGES.filter((s) => s !== "control" || approvalRulesOf(rules).requireControl);
}

/** 承認の進み具合：次に承認する段（すべて済めば null）と、最後まで承認済みか */
export function approvalState(plan: Pick<SavedPlan, "approvals">, stages: ApprovalStage[]) {
  const next = stages.find((s) => !plan.approvals?.[s]) ?? null;
  return { next, complete: next === null };
}

export const canApproveStage = (roles: readonly Role[] | null | undefined, stage: ApprovalStage) => can(roles, STAGE_PERM[stage]);

/** 承認フローのどれかの段を承認できる人（差し戻しもできる） */
export const isApprover = (roles: readonly Role[] | null | undefined) => STAGES.some((s) => canApproveStage(roles, s));

/** 作成者（最後に保存した人）か。古いチェックリストは利用者 ID が無いので名前で比べる */
export function isCreator(plan: Pick<SavedPlan, "updatedBy" | "updatedById">, userId: string, name: string) {
  return plan.updatedById ? plan.updatedById === userId : !!plan.updatedBy && plan.updatedBy === name;
}
