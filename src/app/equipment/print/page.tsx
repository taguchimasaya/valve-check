"use client";

import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";

type EquipmentRecord = {
  id: string;
  code: string;
  name: string;
};

export default function EquipmentPrintPage() {
  const [equipmentList, setEquipmentList] = useState<EquipmentRecord[]>([]);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
    supabase
      .from("equipment")
      .select("id, code, name")
      .order("code", { ascending: true })
      .then(({ data }) => {
        if (data) setEquipmentList(data);
      });
  }, []);

  return (
    <div className="min-h-screen bg-white px-6 py-8">
      <div className="mx-auto max-w-4xl print:max-w-none">
        <div className="mb-6 flex items-center justify-between print:hidden">
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

        <h1 className="mb-4 text-lg font-semibold text-zinc-900 print:hidden">
          QRコード印刷シート（{equipmentList.length}件）
        </h1>

        <div className="grid grid-cols-3 gap-4 print:grid-cols-3 print:gap-3">
          {equipmentList.map((eq) => (
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
