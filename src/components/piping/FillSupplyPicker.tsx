"use client";

import { useState } from "react";
import { supplyRows, type SavedPlan } from "@/lib/piping/checklist";
import type { Graph } from "@/lib/piping/graph";
import { fillSupplyRoute } from "@/lib/piping/isolation";
import { TANKS } from "@/lib/piping/operations";
import type { Execution, StoreAction } from "@/lib/piping/store";
import type { ValveState } from "@/lib/piping/types";

// 充填ラインで充填する作業の「充填元タンク・移送ポンプ」を、当日の運用に合わせて選ぶ欄（現場点検・制御室で共通）。

type Props = {
  graph: Graph;
  /** 元のチェックリスト（当日の行を重ねる前のもの） */
  plan: SavedPlan;
  exec: Execution;
  /** 今の弁状態（運用・手動変更を反映したもの）。経路の弁の「作業前」状態に使う */
  base: Record<string, ValveState>;
  act: (a: StoreAction) => Promise<unknown>;
  compact?: boolean;
};

export default function FillSupplyPicker({ graph, plan, exec, base, act, compact }: Props) {
  // 既定の充填元：受入系統A の充填ラインなら第1ヤード、B なら第2ヤード
  const defaultTank = plan.rows.some((r) => r.code === "V-FLB") ? "T-201" : "T-101";
  const [tank, setTank] = useState(exec.fillSupply?.tank ?? defaultTank);
  const [pump, setPump] = useState(exec.fillSupply?.pump ?? "TP-1");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const locked = (exec.extraRows ?? []).some((r) => Object.keys(exec.records).some((k) => k.endsWith(`:${r.code}`)));
  const current = exec.fillSupply;
  const changed = !current || current.tank !== tank || current.pump !== pump;

  async function apply() {
    setError(null);
    const supply = fillSupplyRoute(graph, tank, pump);
    if (supply.error) {
      setError(supply.error);
      return;
    }
    setSaving(true);
    try {
      await act({
        action: "setFillSupply",
        execId: exec.id,
        fillSupply: { tank, pump, pipeIds: supply.pipeIds },
        rows: supplyRows(graph, plan, supply, base),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const select = "rounded border border-zinc-300 bg-white px-1.5 py-1 text-sm disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900";
  return (
    <div
      className={`rounded-lg border p-2 text-xs ${
        current ? "border-teal-300 bg-teal-50 dark:border-teal-800 dark:bg-teal-950" : "border-amber-400 bg-amber-50 dark:bg-amber-950"
      }`}
    >
      <p className="font-semibold text-teal-800 dark:text-teal-300">
        充填元（当日の運用で選択）：
        {current ? (
          <span>
            {current.tank} ／ 移送ポンプ {current.pump}
          </span>
        ) : (
          <span className="text-amber-700 dark:text-amber-300">未選択（充填工程の前に選んでください）</span>
        )}
      </p>
      {!locked ? (
        <div className={`mt-1 flex flex-wrap items-center gap-2 ${compact ? "" : "text-sm"}`}>
          <label className="flex items-center gap-1">
            タンク
            <select value={tank} onChange={(e) => setTank(e.target.value)} className={select}>
              {TANKS.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            移送ポンプ
            <select value={pump} onChange={(e) => setPump(e.target.value)} className={select}>
              <option>TP-1</option>
              <option>TP-2</option>
            </select>
          </label>
          <button
            onClick={apply}
            disabled={saving || !changed}
            className="rounded bg-teal-700 px-3 py-1 font-semibold text-white hover:bg-teal-600 disabled:opacity-40"
          >
            {current ? "変更する" : "この内容で設定"}
          </button>
        </div>
      ) : (
        <p className="mt-1 text-zinc-500">経路の弁を記録済みのため、変更できません。</p>
      )}
      {error && <p className="mt-1 text-red-600">{error}</p>}
      {!compact && (
        <p className="mt-1 text-[11px] text-zinc-500">
          設定すると、充填元タンクの移送弁 → 移送吸込弁 → 移送ポンプの弁が充填工程に加わります（移送ポンプの起動・停止の注記つき）。
        </p>
      )}
    </div>
  );
}
