"use client";

import { useMe } from "@/lib/auth";
import { can } from "@/lib/roles";
import type { SavedPlan } from "@/lib/piping/checklist";
import type { StoreAction } from "@/lib/piping/store";

const fmt = (at: string) =>
  new Date(at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * チェックリストの確認（承認）の状態と、承認者向けの「承認する／取り消す」。
 * 承認はサーバー側（/api/piping の approvePlan）で承認者権限を確かめて付ける。保存し直すと外れる。
 */
export default function PlanApproval({
  plan,
  act,
  compact = false,
}: {
  plan: Pick<SavedPlan, "id" | "name" | "approvedAt" | "approvedBy">;
  act: (a: StoreAction) => Promise<unknown>;
  compact?: boolean;
}) {
  const canApprove = can(useMe()?.roles, "approve");
  const run = async (approve: boolean) => {
    if (!approve && !confirm(`「${plan.name}」の承認を取り消しますか？`)) return;
    try {
      await act({ action: "approvePlan", id: plan.id, approve });
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {plan.approvedAt ? (
        <span
          className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
          title={`${plan.approvedBy ?? ""} ${fmt(plan.approvedAt)}`}
        >
          ✔ 承認済み{compact ? "" : `（${plan.approvedBy ?? "?"}・${fmt(plan.approvedAt)}）`}
        </span>
      ) : (
        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          未承認
        </span>
      )}
      {canApprove &&
        (plan.approvedAt ? (
          <button onClick={() => run(false)} className="text-[11px] text-zinc-500 underline">
            取消
          </button>
        ) : (
          <button
            onClick={() => run(true)}
            className="rounded border border-emerald-600 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400"
          >
            承認する
          </button>
        ))}
    </span>
  );
}
