"use client";

import { useCallback, useEffect, useState } from "react";
import * as XLSX from "xlsx";
import { QRCodeSVG } from "qrcode.react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import {
  buildTemplateWorkbook,
  parseEquipmentFile,
  type EquipmentRow,
  type ParseResult,
} from "@/lib/parseEquipmentFile";

type EquipmentRecord = {
  id: string;
  code: string;
  name: string;
  location: string | null;
  valve_type: string | null;
};

export default function EquipmentPage() {
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [equipmentList, setEquipmentList] = useState<EquipmentRecord[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const loadEquipment = useCallback(async () => {
    setLoadingList(true);
    const { data, error } = await supabase
      .from("equipment")
      .select("id, code, name, location, valve_type")
      .order("code", { ascending: true });
    if (!error && data) {
      setEquipmentList(data);
    }
    setLoadingList(false);
  }, []);

  useEffect(() => {
    loadEquipment();
  }, [loadEquipment]);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setImportMessage(null);
    setImportError(null);
    try {
      const result = await parseEquipmentFile(file);
      setParseResult(result);
    } catch {
      setImportError(
        "ファイルの読み込みに失敗しました。CSVまたはExcel(.xlsx)形式か確認してください。"
      );
      setParseResult(null);
    }
  }

  async function handleImport(rows: EquipmentRow[]) {
    setImporting(true);
    setImportMessage(null);
    setImportError(null);
    const { error } = await supabase.from("equipment").upsert(
      rows.map((r) => ({
        code: r.code,
        name: r.name,
        location: r.location || null,
        valve_type: r.valveType || null,
      })),
      { onConflict: "code" }
    );
    setImporting(false);
    if (error) {
      setImportError(`インポートに失敗しました: ${error.message}`);
      return;
    }
    setImportMessage(`${rows.length}件の機器マスターを登録しました。`);
    setParseResult(null);
    setFileName(null);
    loadEquipment();
  }

  function downloadTemplate() {
    const wb = buildTemplateWorkbook();
    XLSX.writeFile(wb, "機器マスター_テンプレート.xlsx");
  }

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-12 dark:bg-black">
      <div className="mx-auto max-w-3xl">
        <Link
          href="/"
          className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400"
        >
          ← ホームに戻る
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          機器マスター管理
        </h1>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">
          CSV/Excelから機器マスターを取り込み、機器ごとにQRコードを発行します。
        </p>

        {/* インポートカード */}
        <section className="mt-8 rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="font-medium text-zinc-900 dark:text-zinc-50">
            1. 機器マスターの取り込み
          </h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            列は「機器番号」「機器名称」「設置場所」「バルブ種別」の順で用意してください。
          </p>
          <button
            onClick={downloadTemplate}
            className="mt-3 text-sm font-medium text-emerald-700 hover:underline dark:text-emerald-400"
          >
            テンプレートをダウンロード
          </button>

          <div className="mt-4 flex items-center gap-3">
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={handleFileChange}
              className="block w-full text-sm text-zinc-600 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-zinc-700 dark:text-zinc-400 dark:file:bg-zinc-100 dark:file:text-zinc-900"
            />
          </div>

          {fileName && parseResult && (
            <div className="mt-4 rounded-lg bg-zinc-50 p-4 text-sm dark:bg-zinc-900">
              <p className="text-zinc-700 dark:text-zinc-300">
                <span className="font-medium">{fileName}</span> を読み込みました。
                有効: {parseResult.valid.length}件 / 無効:{" "}
                {parseResult.invalid.length}件
              </p>
              {parseResult.invalid.length > 0 && (
                <ul className="mt-2 list-disc pl-5 text-amber-700 dark:text-amber-500">
                  {parseResult.invalid.slice(0, 5).map((row) => (
                    <li key={row.rowNumber}>
                      {row.rowNumber}行目: {row.errors.join(", ")}
                    </li>
                  ))}
                  {parseResult.invalid.length > 5 && (
                    <li>ほか{parseResult.invalid.length - 5}件</li>
                  )}
                </ul>
              )}
              {parseResult.valid.length > 0 && (
                <button
                  onClick={() => handleImport(parseResult.valid)}
                  disabled={importing}
                  className="mt-3 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
                >
                  {importing
                    ? "登録中..."
                    : `${parseResult.valid.length}件をインポート`}
                </button>
              )}
            </div>
          )}

          {importMessage && (
            <p className="mt-3 text-sm text-emerald-700 dark:text-emerald-400">
              {importMessage}
            </p>
          )}
          {importError && (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400">
              {importError}
            </p>
          )}
        </section>

        {/* 一覧・QRカード */}
        <section className="mt-6 rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-center justify-between">
            <h2 className="font-medium text-zinc-900 dark:text-zinc-50">
              2. 登録済み機器とQRコード（{equipmentList.length}件）
            </h2>
            {equipmentList.length > 0 && (
              <Link
                href="/equipment/print"
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                印刷用QRシートを開く
              </Link>
            )}
          </div>

          {loadingList ? (
            <p className="mt-4 text-sm text-zinc-500">読み込み中...</p>
          ) : equipmentList.length === 0 ? (
            <p className="mt-4 text-sm text-zinc-500">
              まだ機器が登録されていません。上のフォームから取り込んでください。
            </p>
          ) : (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {equipmentList.map((eq) => (
                <div
                  key={eq.id}
                  className="flex flex-col items-center rounded-lg border border-zinc-200 p-3 text-center dark:border-zinc-800"
                >
                  {origin && (
                    <QRCodeSVG
                      value={`${origin}/inspect/${eq.code}`}
                      size={96}
                    />
                  )}
                  <p className="mt-2 text-xs font-medium text-zinc-900 dark:text-zinc-100">
                    {eq.code}
                  </p>
                  <p className="text-xs text-zinc-500">{eq.name}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
