"use client";

import { useState } from "react";
import { exportQrImages, type QrExportFormat, type QrExportItem } from "@/lib/qrExport";

// QR 印刷シートの「画像で出力」ボタン（Falcon Design Space などへ読み込む用）。
// 対象の QR は画面に data-qr-export={機器番号} をつけて描画しておくこと。
export function QrImageExport({
  items,
  zipName,
  note,
  onExported,
}: {
  items: QrExportItem[];
  zipName: string;
  note?: string;
  onExported?: (count: number) => void | Promise<void>;
}) {
  const [format, setFormat] = useState<QrExportFormat>("png");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function run() {
    setBusy(true);
    setMessage("");
    try {
      const count = await exportQrImages(items, format, zipName);
      if (count === 0) {
        setMessage("出力できる QR がありません。");
      } else {
        setMessage(`${count}件を出力しました${count > 1 ? "（ZIP）" : ""}。`);
        await onExported?.(count);
      }
    } catch (e) {
      setMessage(`出力に失敗しました：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-200 p-3 text-sm print:hidden">
      <span className="font-medium text-zinc-700">画像で出力（Falcon Design Space 用）</span>
      <select
        value={format}
        onChange={(e) => setFormat(e.target.value as QrExportFormat)}
        className="rounded-lg border border-zinc-300 px-2 py-1.5"
      >
        <option value="png">PNG（QR＋機器番号・名称）</option>
        <option value="svg">SVG（QRのみ・ベクター）</option>
      </select>
      <button
        onClick={run}
        disabled={busy || items.length === 0}
        className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-40"
      >
        {busy ? "作成中..." : `${items.length}件を出力${items.length > 1 ? "（ZIP）" : ""}`}
      </button>
      {message && <span className="text-xs text-zinc-600">{message}</span>}
      <p className="w-full text-xs text-zinc-500">
        PNG は文字入りのラベル画像（白地・黒）、SVG は拡大しても荒れない QR だけの図形（初期サイズ 30mm、文字はソフト側で追加）です。
        {note}
      </p>
    </div>
  );
}
