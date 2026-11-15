"use client";

import type { SavedPlan } from "@/lib/piping/checklist";
import { approvalState, STAGE_LABEL, type ApprovalStage } from "@/lib/piping/approval";

const fmt = (at: string) =>
  new Date(at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * チェックリストの承認状況：作成 → チームリーダー → G長 → 制御室（設定による）の各段と、差し戻しの理由。
 * 承認・差し戻しの操作は ① の承認画面（ApprovalBoard）で行う。
 */
export default function PlanApproval({
  plan,
  stages,
  compact = false,
}: {
  plan: Pick<SavedPlan, "approvals" | "rejection" | "updatedBy">;
  stages: ApprovalStage[];
  compact?: boolean;
}) {
  const { next, complete } = approvalState(plan, stages);
  if (plan.rejection) {
    return (
      <span
        className="inline-flex shrink-0 flex-wrap items-center gap-1 rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-semibold text-red-800 dark:bg-red-950 dark:text-red-300"
        title={`${plan.rejection.by}（${STAGE_LABEL[plan.rejection.stage]}）${fmt(plan.rejection.at)}`}
      >
        ↩ 差し戻し（{STAGE_LABEL[plan.rejection.stage]}・{plan.rejection.by}）：{plan.rejection.reason}
      </span>
    );
  }
  if (compact) {
    return complete ? (
      <span className="shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
        ✔ 承認済み
      </span>
    ) : (
      <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
        {STAGE_LABEL[next!]}の承認待ち
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 flex-wrap items-center gap-0.5 text-[10px]">
      <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">作成 {plan.updatedBy ?? "?"}</span>
      {stages.map((s) => {
        const sign = plan.approvals?.[s];
        return (
          <span key={s} className="inline-flex items-center gap-0.5">
            <span className="text-zinc-400">→</span>
            <span
              title={sign ? `${sign.by} ${fmt(sign.at)}` : undefined}
              className={`rounded px-1.5 py-0.5 font-semibold ${
                sign
                  ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                  : s === next
                    ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                    : "bg-zinc-50 text-zinc-400 dark:bg-zinc-900"
              }`}
            >
              {STAGE_LABEL[s]} {sign ? `✔ ${sign.by}` : s === next ? "待ち" : ""}
            </span>
          </span>
        );
      })}
    </span>
  );
}
