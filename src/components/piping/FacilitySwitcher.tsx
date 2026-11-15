"use client";

import { selectFacility, useFacilities, useFacilityId } from "@/lib/piping/usePiping";

// 拠点（施設）の切り替え。選んだ拠点は端末ごとに記憶し、全画面がその拠点のデータになる。

export default function FacilitySwitcher() {
  const current = useFacilityId();
  const list = useFacilities();
  const options = [...(list ?? [])];
  if (!options.some((f) => f.id === current)) options.unshift({ id: current, name: current, activeVersionNo: null });
  return (
    <label className="flex items-center gap-2 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950">
      <span className="text-xs font-semibold text-zinc-500">拠点</span>
      <select
        value={current}
        onChange={(e) => selectFacility(e.target.value)}
        disabled={list === null}
        className="bg-transparent font-semibold text-zinc-900 dark:text-zinc-100"
      >
        {options.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
            {f.activeVersionNo ? `（第${f.activeVersionNo}版）` : "（系統図なし）"}
            {f.viewOnly ? "【表示のみ】" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
