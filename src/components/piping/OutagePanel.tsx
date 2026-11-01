"use client";

import { useState } from "react";
import { OUTAGES, type OutageKey } from "@/lib/piping/outages";
import type { Outage, StoreAction } from "@/lib/piping/store";

// 制御室：当日の運用停止範囲の入力（複数を同時に停止できる）。

type Props = {
  outages: Outage[];
  act: (a: StoreAction) => Promise<unknown>;
  /** 運用ラインが停止範囲を通っているときの注意 */
  conflicts: string[];
};

export default function OutagePanel({ outages, act, conflicts }: Props) {
  const [busy, setBusy] = useState<OutageKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = new Map(outages.map((o) => [o.key, o]));

  async function toggle(key: OutageKey) {
    setError(null);
    setBusy(key);
    try {
      await act({ action: "setOutage", key, on: !active.has(key) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-1.5">
        {OUTAGES.map((o) => {
          const on = active.get(o.key);
          return (
            <button
              key={o.key}
              onClick={() => toggle(o.key)}
              disabled={busy !== null}
              title={o.desc}
              className={`rounded-lg border px-2 py-1.5 text-left text-xs leading-tight disabled:opacity-60 ${
                on
                  ? "border-slate-700 bg-slate-700 font-semibold text-white"
                  : "border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
              }`}
            >
              {on ? "■ " : "□ "}
              {o.label}
              {on && (
                <span className="block text-[10px] font-normal opacity-80">
                  {new Date(on.at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })} から停止中
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-[11px] text-zinc-500">
        押すと停止／解除が切り替わります（複数同時に停止できます）。トップ画面と制御室の図面に、灰色の破線と枠で表示されます。
      </p>
      {outages.length > 0 && (
        <button
          onClick={async () => {
            if (confirm("運用停止範囲をすべて解除しますか？")) await act({ action: "clearOutages" });
          }}
          className="mt-1 text-xs text-zinc-500 underline"
        >
          すべて解除
        </button>
      )}
      {conflicts.map((c) => (
        <p key={c} className="mt-1 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          ⚠ {c}
        </p>
      ))}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
