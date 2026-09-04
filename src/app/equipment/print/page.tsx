"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useHierarchyFilter } from "@/lib/useHierarchyFilter";

type EquipmentRecord = {
  id: string;
  code: string;
  name: string;
  hierarchy1: string | null;
  hierarchy2: string | null;
  hierarchy3: string | null;
  hierarchy4: string | null;
  qr_issued_at: string | null;
};

export default function EquipmentPrintPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-zinc-500">読み込み中...</div>}>
      <EquipmentPrintContent />
    </Suspense>
  );
}

function EquipmentPrintContent() {
  const searchParams = useSearchParams();
  const codesParam = searchParams.get("codes");
  const explicitCodes = codesParam
    ? codesParam.split(",").map((c) => c.trim()).filter(Boolean)
    : null;

  const [equipmentList, setEquipmentList] = useState<EquipmentRecord[]>([]);
  const [origin, setOrigin] = useState("");
  const [unissuedOnly, setUnissuedOnly] = useState(true);
  const [marking, setMarking] = useState(false);

  function loadEquipment() {
    supabase
      .from("equipment")
      .select("id, code, name, hierarchy1, hierarchy2, hierarchy3, hierarchy4, qr_issued_at")
      .order("code", { ascending: true })
      .then(({ data }) => {
        if (data) setEquipmentList(data);
      });
  }

  useEffect(() => {
    setOrigin(window.location.origin);
    loadEquipment();
  }, []);

  const hierarchyFilter = useHierarchyFilter(equipmentList);
  const hierarchyLabels = ["階層1", "階層2", "階層3", "階層4"];

  // codes指定があれば、その機器だけを対象にする（階層フィルターは使わない）
  const scoped = explicitCodes
    ? equipmentList.filter((eq) => explicitCodes.includes(eq.code))
    : hierarchyFilter.filtered;

  const visibleList = unissuedOnly
    ? scoped.filter((eq) => !eq.qr_issued_at)
    : scoped;

  async function markVisibleAsIssued() {
    if (visibleList.length === 0) return;
    setMarking(true);
    const ids = visibleList.map((eq) => eq.id);
    const { error } = await supabase
      .from("equipment")
      .update({ qr_issued_at: new Date().toISOString() })
      .in("id", ids);
    setMarking(false);
    if (!error) loadEquipment();
  }

  return (
    <div className="min-h-screen bg-white px-6 py-8">
      <div className="mx-auto max-w-4xl print:max-w-none">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 print:hidden">
          <Link href="/equipment" className="text-sm text-zinc-500 hover:text-zinc-700">
            ← 機器マスター管理に戻る
          </Link>
          <button
            onClick={() => window.print()}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
          >
            印刷する
          </button>
        </div>

        {explicitCodes ? (
          <p className="mb-4 text-sm text-zinc-500 print:hidden">
            一覧画面で選択した{explicitCodes.length}件を表示しています。
            <Link href="/equipment/print" className="ml-2 text-emerald-700 hover:underline">
              階層で選び直す
            </Link>
          </p>
        ) : (
          <div className="mb-4 flex flex-wrap items-center gap-2 print:hidden">
            <select
              value={hierarchyFilter.h1}
              onChange={(e) => hierarchyFilter.setH1(e.target.value)}
              className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
            >
              <option value="">{hierarchyLabels[0]}：すべて</option>
              {hierarchyFilter.options1.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            {hierarchyFilter.hasLevel2 && (
              <select
                value={hierarchyFilter.h2}
                onChange={(e) => hierarchyFilter.setH2(e.target.value)}
                className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
              >
                <option value="">{hierarchyLabels[1]}：すべて</option>
                {hierarchyFilter.options2.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            )}
            {hierarchyFilter.hasLevel3 && (
              <select
                value={hierarchyFilter.h3}
                onChange={(e) => hierarchyFilter.setH3(e.target.value)}
                className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
              >
                <option value="">{hierarchyLabels[2]}：すべて</option>
                {hierarchyFilter.options3.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            )}
            {hierarchyFilter.hasLevel4 && (
              <select
                value={hierarchyFilter.h4}
                onChange={(e) => hierarchyFilter.setH4(e.target.value)}
                className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
              >
                <option value="">{hierarchyLabels[3]}：すべて</option>
                {hierarchyFilter.options4.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            )}
            <label className="flex items-center gap-2 text-sm text-zinc-700">
              <input
                type="checkbox"
                checked={unissuedOnly}
                onChange={(e) => setUnissuedOnly(e.target.checked)}
              />
              未発行のみ表示
            </label>
          </div>
        )}

        <div className="mb-4 flex items-center justify-between print:hidden">
          <h1 className="text-lg font-semibold text-zinc-900">
            QRコード印刷シート（{visibleList.length}件）
          </h1>
          <button
            onClick={markVisibleAsIssued}
            disabled={marking || visibleList.length === 0}
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            表示中の{visibleList.length}件を発行済みにする
          </button>
        </div>

        <div className="grid grid-cols-3 gap-4 print:grid-cols-3 print:gap-3">
          {visibleList.map((eq) => (
            <div
              key={eq.id}
              className="flex flex-col items-center rounded-lg border border-zinc-300 p-4 text-center break-inside-avoid"
            >
              {origin && (
                <QRCodeSVG value={`${origin}/inspect/${eq.code}`} size={120} />
              )}
              <p className="mt-2 text-sm font-semibold text-zinc-900">
                {eq.code}
              </p>
              <p className="text-xs text-zinc-600">{eq.name}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
