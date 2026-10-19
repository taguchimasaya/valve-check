"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { useGraph, usePipingStore } from "@/lib/piping/usePiping";
import type { NodeKind } from "@/lib/piping/types";

// 配管系統図で使っている弁（仕切弁・ドレン弁・圧力計元弁）のQRコード印刷シート。
// QRの中身は既存の機器マスターのQRと同じ「{origin}/inspect/{機器番号}」形式。
// 既存システムの機器マスター（Supabase）には登録・変更しない。

const KIND_LABEL: Partial<Record<NodeKind, string>> = {
  valve: "仕切弁",
  drain: "ドレン弁",
  gauge: "圧力計元弁",
};

function normalize(t: string) {
  return t.normalize("NFKC").toLowerCase();
}

export default function PipingQrPage() {
  const g = useGraph();
  const { store } = usePipingStore(0);
  const origin = useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => ""
  );

  const [area, setArea] = useState("");
  const [kinds, setKinds] = useState<NodeKind[]>(["valve", "drain", "gauge"]);
  const [planId, setPlanId] = useState("");
  const [search, setSearch] = useState("");

  const all = useMemo(
    () =>
      g.facility.nodes
        .filter((n) => n.kind in KIND_LABEL)
        .sort((a, b) => a.area.localeCompare(b.area, "ja") || a.label.localeCompare(b.label, "ja", { numeric: true })),
    [g]
  );
  const areas = useMemo(() => [...new Set(all.map((n) => n.area))], [all]);
  const storePlans = store?.plans;
  const plans = useMemo(() => storePlans ?? [], [storePlans]);
  const planIds = useMemo(() => {
    const p = plans.find((x) => x.id === planId);
    return p ? new Set(p.rows.map((r) => r.nodeId).filter(Boolean)) : null;
  }, [plans, planId]);

  const q = normalize(search);
  const list = all.filter(
    (n) =>
      kinds.includes(n.kind) &&
      (!area || n.area === area) &&
      (!planIds || planIds.has(n.id)) &&
      (!q || normalize(n.label).includes(q) || normalize(n.name).includes(q))
  );

  return (
    <div className="min-h-screen bg-white px-4 py-6 print:p-0">
      <div className="mx-auto max-w-4xl">
        <div className="print:hidden">
          <Link href="/piping" className="text-sm text-zinc-500 hover:text-zinc-700">
            ← 配管系統図メニュー
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-zinc-900">系統図の機器 QRコード印刷シート（{list.length}件）</h1>
          <p className="mt-1 text-xs text-zinc-500">
            QRの中身は既存の機器マスターと同じ形式（{origin || "…"}/inspect/機器番号）です。②現場点検のQR読取で使えます。
            既存の機器マスター（本番データ）には登録しません。
          </p>

          <div className="mt-4 flex flex-wrap items-end gap-3 rounded-xl border border-zinc-200 p-4 text-sm">
            <label className="space-y-1">
              <span className="block text-xs text-zinc-500">区画</span>
              <select value={area} onChange={(e) => setArea(e.target.value)} className="rounded-lg border border-zinc-300 px-2 py-1.5">
                <option value="">すべて</option>
                {areas.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="block text-xs text-zinc-500">チェックリスト</span>
              <select value={planId} onChange={(e) => setPlanId(e.target.value)} className="max-w-56 rounded-lg border border-zinc-300 px-2 py-1.5">
                <option value="">すべての機器</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="space-y-1">
              <span className="block text-xs text-zinc-500">種別</span>
              <div className="flex gap-3 py-1.5">
                {(Object.keys(KIND_LABEL) as NodeKind[]).map((k) => (
                  <label key={k} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={kinds.includes(k)}
                      onChange={(e) => setKinds((p) => (e.target.checked ? [...p, k] : p.filter((x) => x !== k)))}
                    />
                    {KIND_LABEL[k]}
                  </label>
                ))}
              </div>
            </div>
            <label className="min-w-48 flex-1 space-y-1">
              <span className="block text-xs text-zinc-500">検索</span>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="機器番号・名称（例：V-101R、フィルター）"
                className="w-full rounded-lg border border-zinc-300 px-2 py-1.5"
              />
            </label>
            <button
              onClick={() => window.print()}
              disabled={!list.length}
              className="rounded-lg bg-emerald-700 px-4 py-2 font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
            >
              印刷（{list.length}件）
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 print:mt-0 print:grid-cols-3 print:gap-3">
          {list.map((n) => (
            <div key={n.id} className="flex flex-col items-center rounded-lg border border-zinc-300 p-4 text-center break-inside-avoid">
              {origin && <QRCodeSVG value={`${origin}/inspect/${n.label}`} size={120} />}
              <p className="mt-2 text-sm font-semibold text-zinc-900">{n.label}</p>
              <p className="text-xs text-zinc-600">{n.name}</p>
              <p className="text-[10px] text-zinc-400">
                {n.area}・{KIND_LABEL[n.kind]}
              </p>
            </div>
          ))}
        </div>
        {list.length === 0 && <p className="mt-6 text-center text-sm text-zinc-500">該当する機器がありません。</p>}
      </div>
    </div>
  );
}
