"use client";

import { useState } from "react";
import type { Graph } from "@/lib/piping/graph";
import { needsFillSupply } from "@/lib/piping/checklist";
import { conflictText, lineConflicts, targetConflicts } from "@/lib/piping/execRules";
import { OPERATION_BLOCK_HINT, operationBlockers, operationContext } from "@/lib/piping/operationSafety";
import { execPlan } from "@/lib/piping/store";
import type { Execution, PipingStore, StoreAction } from "@/lib/piping/store";
import type { ValveState } from "@/lib/piping/types";
import { needsDayParams } from "@/lib/piping/workTypes";
import FillSupplyPicker from "./FillSupplyPicker";
import DayParamsPicker from "./DayParamsPicker";

// ③ 制御室：現場で「点検開始」が押された点検の承認。
// タンク・ポンプを選ぶ作業は、選んで「この内容で開始を承認」を押すだけ（入力と承認を1回で行う）。
// タンク・ポンプを選ばない作業は「開始を承認」だけ。ラインが重なる点検があれば、確認のチェックが要る。

export default function StartRequests({
  graph,
  store,
  base,
  act,
  onPreview,
  overlapExecId,
  onShowOverlap,
}: {
  graph: Graph;
  store: PipingStore;
  base: Record<string, ValveState>;
  act: (a: StoreAction) => Promise<unknown>;
  /** 作業名をクリックしたときにチェックリストのプレビューを開く */
  onPreview?: (execId: string) => void;
  /** 図面にラインの重なりを表示している申請（点検の ID）と、その切り替え */
  overlapExecId?: string | null;
  onShowOverlap?: (execId: string | null) => void;
}) {
  const pending = store.executions.filter((e) => e.status === "pending");
  if (!pending.length) return <p className="text-sm text-zinc-400">開始の申請はありません。</p>;
  return (
    <ul className="space-y-3">
      {pending.map((e) => (
        <Request
          key={e.id}
          graph={graph}
          store={store}
          exec={e}
          base={base}
          act={act}
          onPreview={onPreview}
          showingOverlap={overlapExecId === e.id}
          onShowOverlap={onShowOverlap}
        />
      ))}
    </ul>
  );
}

function Request({
  graph,
  store,
  exec,
  base,
  act,
  onPreview,
  showingOverlap,
  onShowOverlap,
}: {
  graph: Graph;
  store: PipingStore;
  exec: Execution;
  base: Record<string, ValveState>;
  act: (a: StoreAction) => Promise<unknown>;
  onPreview?: (execId: string) => void;
  showingOverlap?: boolean;
  onShowOverlap?: (execId: string | null) => void;
}) {
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plan = store.plans.find((p) => p.id === exec.planId);
  if (!plan) return null;
  // 同じ機器を対象とする点検が実施中なら承認できない（重複）。ラインだけが重なるなら確認して承認できる
  const sameTarget = targetConflicts(store, plan, exec.id);
  const conflicts = lineConflicts(store, plan, exec.id).filter((c) => !sameTarget.some((s) => s.exec.id === c.exec.id));
  const needDay = needsDayParams(plan);
  // 充填元の欄で承認するか（タンク・ポンプの欄があればそちらで承認する）
  const fillApprove = needsFillSupply(plan) && !needDay;
  // 安全機構：運用中のラインと重なる点検は承認できない（運用停止範囲の中なら可）。当日の選択で加えた弁も見る
  const opBlock = operationBlockers(operationContext(graph, store), execPlan(plan, exec));
  const blocked = sameTarget.length > 0 || opBlock.length > 0 || (conflicts.length > 0 && !ack);
  const approve = () => act({ action: "approveStart", execId: exec.id, ackOverlap: conflicts.length > 0 && ack });

  async function run(a: StoreAction) {
    setBusy(true);
    setError(null);
    try {
      await act(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-lg border-2 border-amber-400 bg-amber-50 p-3 dark:bg-amber-950">
      {onPreview ? (
        <button
          onClick={() => onPreview(exec.id)}
          title="チェックリストのプレビューを開く"
          className="text-left text-sm font-semibold text-sky-800 underline decoration-dotted underline-offset-2 hover:text-sky-600 dark:text-sky-300"
        >
          {exec.planName}
        </button>
      ) : (
        <p className="text-sm font-semibold">{exec.planName}</p>
      )}
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        申請：{exec.ownerName ?? "—"}（{new Date(exec.startedAt).toLocaleString("ja-JP")}）
      </p>

      {opBlock.length > 0 && (
        <div className="mt-2 rounded border-2 border-red-600 bg-red-100 p-2 text-xs text-red-900 dark:bg-red-950 dark:text-red-200">
          <p className="font-semibold">⛔ 運用中のラインと重なるため、承認できません</p>
          <ul className="mt-1 list-disc pl-4">
            {opBlock.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          <p className="mt-1">{OPERATION_BLOCK_HINT}</p>
        </div>
      )}
      {sameTarget.length > 0 && (
        <div className="mt-2 rounded border-2 border-red-600 bg-red-100 p-2 text-xs text-red-900 dark:bg-red-950 dark:text-red-200">
          <p className="font-semibold">⛔ 同じ機器を対象とする点検が実施中のため、承認できません</p>
          <ul className="mt-1 list-disc pl-4">
            {sameTarget.map((c) => (
              <li key={c.exec.id}>
                「{c.exec.planName}」（{c.exec.status === "pending" ? "承認待ち" : "点検中"}
                {c.exec.ownerName ? `・${c.exec.ownerName}` : ""}）と点検する機器が重複しています
              </li>
            ))}
          </ul>
          <p className="mt-1">その点検が終わってから点検開始し直すよう、却下してください。</p>
          {onShowOverlap && (
            <button
              onClick={() => onShowOverlap(showingOverlap ? null : exec.id)}
              className={`mt-1 rounded px-2 py-0.5 font-semibold ${showingOverlap ? "bg-fuchsia-700 text-white" : "border border-fuchsia-600 text-fuchsia-700 dark:text-fuchsia-300"}`}
            >
              {showingOverlap ? "図面の重なり表示を消す" : "🗺 図面で重なりを見る"}
            </button>
          )}
        </div>
      )}
      {conflicts.length > 0 && (
        <div className="mt-2 rounded border-2 border-red-500 bg-red-50 p-2 text-xs text-red-800 dark:bg-red-950 dark:text-red-200">
          <p className="font-semibold">⚠ ほかの点検とラインが重なっています</p>
          <ul className="mt-1 list-disc pl-4">
            {conflicts.map((c) => (
              <li key={c.exec.id}>{conflictText(c)}</li>
            ))}
          </ul>
          {onShowOverlap && (
            <button
              onClick={() => onShowOverlap(showingOverlap ? null : exec.id)}
              className={`mt-1 rounded px-2 py-0.5 font-semibold ${showingOverlap ? "bg-fuchsia-700 text-white" : "border border-fuchsia-600 text-fuchsia-700 dark:text-fuchsia-300"}`}
            >
              {showingOverlap ? "図面の重なり表示を消す" : "🗺 図面で重なりを見る"}
            </button>
          )}
          <label className="mt-1 flex items-center gap-1 font-semibold">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            重なりを確認し、同時に行っても問題ないと判断した
          </label>
        </div>
      )}
      {needDay && (
        <div className="mt-2">
          <DayParamsPicker
            graph={graph}
            plan={plan}
            exec={exec}
            base={base}
            act={act}
            compact
            onSubmit={async () => {
              await approve();
            }}
            submitLabel="この内容で開始を承認"
            submitDisabled={blocked}
          />
        </div>
      )}
      {needsFillSupply(plan) && (
        <div className="mt-2">
          <FillSupplyPicker
            graph={graph}
            plan={plan}
            exec={exec}
            base={base}
            act={act}
            compact
            {...(fillApprove
              ? {
                  onSubmit: async () => {
                    await approve();
                  },
                  submitLabel: "この内容で開始を承認",
                  submitDisabled: blocked,
                }
              : {})}
          />
        </div>
      )}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      <div className="mt-2 flex gap-2">
        {!needDay && !fillApprove && (
          <button
            onClick={() => run({ action: "approveStart", execId: exec.id, ackOverlap: conflicts.length > 0 && ack })}
            disabled={busy || blocked}
            className="rounded bg-emerald-700 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
          >
            開始を承認
          </button>
        )}
        <button
          onClick={() => {
            const reason = prompt(`「${exec.planName}」の点検開始を却下する理由`);
            if (reason?.trim()) run({ action: "rejectStart", execId: exec.id, reason });
          }}
          disabled={busy}
          className="rounded border border-red-300 px-3 py-1 text-xs text-red-700"
        >
          却下
        </button>
      </div>
      {(needDay || fillApprove) && (
        <p className="mt-1 text-[11px] text-zinc-600 dark:text-zinc-400">
          {needDay ? "当日のタンク・ポンプ" : "充填元のタンク・移送ポンプ"}を選んで「この内容で開始を承認」を押してください。
        </p>
      )}
    </li>
  );
}
