"use client";

import { useMemo, useState } from "react";
import PlanApproval from "@/components/piping/PlanApproval";
import PlanPreview from "@/components/piping/PlanPreview";
import { useMe } from "@/lib/auth";
import type { Graph } from "@/lib/piping/graph";
import type { SavedPlan } from "@/lib/piping/checklist";
import type { PipingStore, StoreAction } from "@/lib/piping/store";
import type { ValveState } from "@/lib/piping/types";
import { approvalStages, approvalState, canApproveStage, isApprover, isCreator, STAGE_LABEL } from "@/lib/piping/approval";

/**
 * ① の承認画面（チームリーダー・G長・制御室）：チェックリストの一覧から、プレビューで中身を確かめて承認・差し戻しする。
 * 承認できるのは承認フローの次の段の権限を持つ人だけ（作成者本人は不可）。
 */
export default function ApprovalBoard({
  graph,
  store,
  base,
  act,
}: {
  graph: Graph;
  store: PipingStore | null;
  base: Record<string, ValveState>;
  act: (a: StoreAction) => Promise<unknown>;
}) {
  const me = useMe();
  const [tab, setTab] = useState<"mine" | "all">("mine");
  const [preview, setPreview] = useState<SavedPlan | null>(null);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const stages = useMemo(() => approvalStages(store?.rules), [store?.rules]);
  const plans = store?.plans ?? [];

  /** この利用者が今承認できるか（次の段の権限があり、作成者本人でない） */
  const canApproveNow = (p: SavedPlan) => {
    if (!me || p.rejection || isCreator(p, me.userId, me.name)) return false;
    const { next } = approvalState(p, stages);
    return !!next && canApproveStage(me.roles, next);
  };
  const waiting = plans.filter(canApproveNow);
  const shown = tab === "mine" ? waiting : plans;

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMessage(null);
    try {
      await fn();
      setMessage({ type: "ok", text: ok });
      setPreview(null);
    } catch (e) {
      setMessage({ type: "err", text: e instanceof Error ? e.message : String(e) });
    }
  };
  const approve = (p: SavedPlan) => {
    const { next } = approvalState(p, stages);
    if (!next) return;
    run(() => act({ action: "approvePlan", id: p.id, stage: next }), `「${p.name}」を承認しました（${STAGE_LABEL[next]}）`);
  };
  const reject = (p: SavedPlan) => {
    const reason = prompt(`「${p.name}」を差し戻す理由を入力してください（作成者に表示されます）`);
    if (!reason?.trim()) return;
    run(() => act({ action: "rejectPlan", id: p.id, reason }), `「${p.name}」を差し戻しました`);
  };

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">チェックリストの承認</h2>
        <div className="flex overflow-hidden rounded-lg border border-zinc-300 text-sm dark:border-zinc-700">
          {(
            [
              ["mine", `あなたの承認待ち（${waiting.length}）`],
              ["all", `すべて（${plans.length}）`],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`px-3 py-1 ${tab === k ? "bg-emerald-700 text-white" : "text-zinc-600 dark:text-zinc-300"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        承認の順番：作成者 → {stages.map((s) => STAGE_LABEL[s]).join(" → ")}。最後まで承認されたチェックリストだけ、② 現場点検で開始できます。
        「プレビュー」で工程ごとの中身を確かめてから承認・差し戻ししてください。
      </p>
      {message && (
        <p
          className={`mt-2 rounded-lg px-3 py-2 text-sm ${
            message.type === "ok" ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" : "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200"
          }`}
        >
          {message.text}
        </p>
      )}
      {shown.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-500">{tab === "mine" ? "あなたが承認する順番のチェックリストはありません。" : "チェックリストはありません。"}</p>
      ) : (
        <ul className="mt-2 divide-y divide-zinc-100 dark:divide-zinc-800">
          {shown.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{p.name}</p>
                <p className="text-xs text-zinc-500">
                  {p.source === "excel" ? "Excel取込" : p.purpose} ・ {p.steps.length}工程 ・ {p.rows.length}弁{p.period ? ` ・ 周期 ${p.period}` : ""}
                </p>
                <div className="mt-0.5">
                  <PlanApproval plan={p} stages={stages} />
                </div>
              </div>
              <button onClick={() => setPreview(p)} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700">
                プレビュー
              </button>
              {canApproveNow(p) && (
                <button
                  onClick={() => approve(p)}
                  className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-600"
                >
                  承認する
                </button>
              )}
              {isApprover(me?.roles) && !p.rejection && me && !isCreator(p, me.userId, me.name) && (
                <button
                  onClick={() => reject(p)}
                  className="rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-700 dark:border-red-900 dark:text-red-400"
                >
                  差し戻す
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {preview && (
        <PlanPreview
          graph={graph}
          plan={preview}
          base={base}
          onClose={() => setPreview(null)}
          startLabel={(() => {
            const n = approvalState(preview, stages).next;
            return n ? `承認する（${STAGE_LABEL[n]}）` : "";
          })()}
          onStart={canApproveNow(preview) ? () => approve(preview) : undefined}
          deleteLabel="差し戻す"
          onDelete={isApprover(me?.roles) && !preview.rejection && me && !isCreator(preview, me.userId, me.name) ? () => reject(preview) : undefined}
        />
      )}
    </section>
  );
}
