"use client";

import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";

type EquipmentRecord = {
  id: string;
  code: string;
  name: string;
  qr_issued_at: string | null;
};

export default function EquipmentPrintPage() {
  const [equipmentList, setEquipmentList] = useState<EquipmentRecord[]>([]);
  const [origin, setOrigin] = useState("");
  const [unissuedOnly, setUnissuedOnly] = useState(true);
  const [marking, setMarking] = useState(false);

  function loadEquipment() {
    supabase
      .from("equipment")
      .select("id, code, name, qr_issued_at")
      .order("code", { ascending: true })
      .then(({ data }) => {
        if (data) setEquipmentList(data);
      });
  }

  useEffect(() => {
    setOrigin(window.location.origin);
    loadEquipment();
  }, []);

  const visibleList = unissuedOnly
    ? equipmentList.filter((eq) => !eq.qr_issued_at)
    : equipmentList;

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
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 print:hidden">
          <Link href="/equipment" className="text-sm text-zinc-500 hover:text-zinc-700">
            ← 機器マスター管理に戻る
          </Link>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-zinc-700">
              <input
                type="checkbox"
                checked={unissuedOnly}
                onChange={(e) => setUnissuedOnly(e.target.checked)}
              />
              未発行のみ表示
            </label>
            <button
              onClick={markVisibleAsIssued}
              disabled={marking || visibleList.length === 0}
              className="rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            >
              表示中の{visibleList.length}件を発行済みにする
            </button>
            <button
              onClick={() => window.print()}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
            >
              印刷する
            </button>
          </div>
        </div>

        <h1 className="mb-4 text-lg font-semibold text-zinc-900 print:hidden">
          QRコード印刷シート（{visibleList.length}件）
        </h1>

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
