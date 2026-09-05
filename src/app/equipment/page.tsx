"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import * as XLSX from "xlsx";
import { QRCodeSVG } from "qrcode.react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useHierarchyFilter } from "@/lib/useHierarchyFilter";
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
  valve_type: string | null;
  hierarchy1: string | null;
  hierarchy2: string | null;
  hierarchy3: string | null;
  hierarchy4: string | null;
  qr_issued_at: string | null;
  checklist_template_id: string | null;
};

type TemplateOption = { id: string; name: string };

type StatusFilter = "all" | "issued" | "unissued";

function hierarchyPath(eq: EquipmentRecord) {
  return [eq.hierarchy1, eq.hierarchy2, eq.hierarchy3, eq.hierarchy4]
    .filter(Boolean)
    .join(" > ");
}

export default function EquipmentPage() {
  const router = useRouter();
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [equipmentList, setEquipmentList] = useState<EquipmentRecord[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [origin, setOrigin] = useState("");
  const [searchText, setSearchText] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastCheckedIndex, setLastCheckedIndex] = useState<number | null>(null);
  const [qrPreview, setQrPreview] = useState<EquipmentRecord | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const loadEquipment = useCallback(async () => {
    setLoadingList(true);
    const { data, error } = await supabase
      .from("equipment")
      .select(
        "id, code, name, valve_type, hierarchy1, hierarchy2, hierarchy3, hierarchy4, qr_issued_at, checklist_template_id"
      )
      .order("code", { ascending: true });
    if (!error && data) {
      setEquipmentList(data);
    }
    setLoadingList(false);
  }, []);

  useEffect(() => {
    loadEquipment();
  }, [loadEquipment]);

  const hierarchyFilter = useHierarchyFilter(equipmentList);

  const filteredList = useMemo(() => {
    return hierarchyFilter.filtered.filter((eq) => {
      if (statusFilter === "issued" && !eq.qr_issued_at) return false;
      if (statusFilter === "unissued" && eq.qr_issued_at) return false;
      if (searchText.trim()) {
        const q = searchText.trim().toLowerCase();
        const haystack = [eq.code, eq.name, eq.valve_type]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [hierarchyFilter.filtered, statusFilter, searchText]);

  // フィルター条件が変わったら選択も一旦クリアする（見えていない行が選択されたままになるのを防ぐ）
  useEffect(() => {
    setSelectedIds(new Set());
  }, [hierarchyFilter.h1, hierarchyFilter.h2, hierarchyFilter.h3, hierarchyFilter.h4, statusFilter, searchText]);

  const issuedCount = equipmentList.filter((eq) => eq.qr_issued_at).length;
  const allFilteredSelected =
    filteredList.length > 0 && filteredList.every((eq) => selectedIds.has(eq.id));

  function toggleSelectAll() {
    if (allFilteredSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredList.map((eq) => eq.id)));
    }
  }

  function toggleSelectOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // 行チェックボックスのクリック。Shiftキーを押しながらだと、直前にクリックした行から
  // 今回の行までの範囲をまとめて選択する（表計算ソフトやファイル一覧と同じ操作感）。
  function handleRowCheckboxClick(
    id: string,
    index: number,
    shiftKey: boolean
  ) {
    if (shiftKey && lastCheckedIndex !== null) {
      const [start, end] = [lastCheckedIndex, index].sort((a, b) => a - b);
      const rangeIds = filteredList.slice(start, end + 1).map((eq) => eq.id);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        rangeIds.forEach((rid) => next.add(rid));
        return next;
      });
    } else {
      toggleSelectOne(id);
    }
    setLastCheckedIndex(index);
  }

  const existingCodes = useMemo(
    () => new Set(equipmentList.map((eq) => eq.code)),
    [equipmentList]
  );
  const updateRows = useMemo(
    () => (parseResult ? parseResult.valid.filter((r) => existingCodes.has(r.code)) : []),
    [parseResult, existingCodes]
  );
  const updateCount = updateRows.length;
  const newCount = (parseResult?.valid.length ?? 0) - updateCount;
  const updateRowsPreview = updateRows.slice(0, 8).map((r) => r.code);

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
        valve_type: r.valveType || null,
        hierarchy1: r.hierarchy1 || null,
        hierarchy2: r.hierarchy2 || null,
        hierarchy3: r.hierarchy3 || null,
        hierarchy4: r.hierarchy4 || null,
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

  async function toggleIssued(eq: EquipmentRecord) {
    const nextValue = eq.qr_issued_at ? null : new Date().toISOString();
    const { error } = await supabase
      .from("equipment")
      .update({ qr_issued_at: nextValue })
      .eq("id", eq.id);
    if (!error) {
      setEquipmentList((prev) =>
        prev.map((item) =>
          item.id === eq.id ? { ...item, qr_issued_at: nextValue } : item
        )
      );
    }
  }

  async function bulkSetIssued(issued: boolean) {
    if (selectedIds.size === 0) return;
    setBulkUpdating(true);
    const ids = Array.from(selectedIds);
    const { error } = await supabase
      .from("equipment")
      .update({ qr_issued_at: issued ? new Date().toISOString() : null })
      .in("id", ids);
    setBulkUpdating(false);
    if (!error) loadEquipment();
  }

  function printSelected() {
    if (selectedIds.size === 0) return;
    const codes = equipmentList
      .filter((eq) => selectedIds.has(eq.id))
      .map((eq) => eq.code);
    router.push(`/equipment/print?codes=${encodeURIComponent(codes.join(","))}`);
  }

  async function deleteEquipment(ids: string[]) {
    setDeleteError(null);
    setBulkUpdating(true);
    const { error } = await supabase.from("equipment").delete().in("id", ids);
    setBulkUpdating(false);
    if (error) {
      setDeleteError(
        `削除に失敗しました: ${error.message}（点検記録などから参照されている機器は削除できません）`
      );
      return;
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.delete(id));
      return next;
    });
    loadEquipment();
  }

  function deleteOne(eq: EquipmentRecord) {
    if (!window.confirm(`「${eq.code} ${eq.name}」を削除します。この操作は取り消せません。よろしいですか？`)) {
      return;
    }
    deleteEquipment([eq.id]);
  }

  function deleteSelected() {
    if (selectedIds.size === 0) return;
    if (
      !window.confirm(
        `選択中の${selectedIds.size}件を削除します。この操作は取り消せません。よろしいですか？`
      )
    ) {
      return;
    }
    deleteEquipment(Array.from(selectedIds));
  }

  // 一覧の「印刷用QRシートを開く」は、今の絞り込み結果と必ず一致させる。
  // 何も絞り込んでいなければ、印刷ページ側の初期表示（未発行のみ）に任せる。
  const isFilterActive =
    Boolean(hierarchyFilter.h1 || hierarchyFilter.h2 || hierarchyFilter.h3 || hierarchyFilter.h4) ||
    statusFilter !== "all" ||
    Boolean(searchText.trim());
  const printAllHref = isFilterActive
    ? `/equipment/print?codes=${encodeURIComponent(
        filteredList.map((eq) => eq.code).join(",")
      )}`
    : "/equipment/print";

  const hierarchyLabels = ["階層1", "階層2", "階層3", "階層4"];

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-12 dark:bg-black">
      <div className="mx-auto max-w-5xl">
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
            列は「機器番号」「機器名称」「階層1」〜「階層4」「バルブ種別」の順で用意してください（階層は使う分だけでOKです）。
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
                有効: {parseResult.valid.length}件（新規{newCount}件 / 既存データを更新
                {updateCount}件） / 無効: {parseResult.invalid.length}件
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
              {updateCount > 0 && (
                <div className="mt-2 rounded-lg bg-amber-50 p-3 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                  <p className="font-medium">
                    {updateCount}件は既存の機器番号と一致するため、内容を上書きします。
                  </p>
                  <p className="mt-1 text-xs">
                    {updateRowsPreview.join("、")}
                    {updateCount > updateRowsPreview.length &&
                      ` ほか${updateCount - updateRowsPreview.length}件`}
                  </p>
                </div>
              )}
              {parseResult.valid.length > 0 && (
                <button
                  onClick={() => handleImport(parseResult.valid)}
                  disabled={importing}
                  className="mt-3 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
                >
                  {importing
                    ? "登録中..."
                    : `${parseResult.valid.length}件をインポート（新規${newCount} / 更新${updateCount}）`}
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

        {/* 一覧テーブル */}
        <section className="mt-6 rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-medium text-zinc-900 dark:text-zinc-50">
              2. 登録済み機器一覧
            </h2>
            {equipmentList.length > 0 && (
              <Link
                href={printAllHref}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                印刷用QRシートを開く{isFilterActive && `（絞り込み中の${filteredList.length}件）`}
              </Link>
            )}
          </div>

          {equipmentList.length > 0 && (
            <>
              <p className="mt-1 text-sm text-zinc-500">
                全{equipmentList.length}件 / 発行済み{issuedCount}件 / 未発行
                {equipmentList.length - issuedCount}件
              </p>

              {/* 階層フィルター */}
              <div className="mt-4 flex flex-wrap gap-2">
                <select
                  value={hierarchyFilter.h1}
                  onChange={(e) => hierarchyFilter.setH1(e.target.value)}
                  className="rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
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
                    className="rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
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
                    className="rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
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
                    className="rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                  >
                    <option value="">{hierarchyLabels[3]}：すべて</option>
                    {hierarchyFilter.options4.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* 検索・状態フィルター */}
              <div className="mt-2 flex flex-wrap gap-2">
                <input
                  type="text"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  placeholder="機器番号・機器名称・バルブ種別で検索"
                  className="min-w-[220px] flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                />
                <div className="flex gap-1 rounded-lg border border-zinc-300 p-1 dark:border-zinc-700">
                  {(
                    [
                      { key: "all", label: "すべて" },
                      { key: "issued", label: "発行済み" },
                      { key: "unissued", label: "未発行" },
                    ] as { key: StatusFilter; label: string }[]
                  ).map((opt) => (
                    <button
                      key={opt.key}
                      onClick={() => setStatusFilter(opt.key)}
                      className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                        statusFilter === opt.key
                          ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                          : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* 一括操作バー */}
          {selectedIds.size > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-emerald-50 p-3 text-sm dark:bg-emerald-950">
              <span className="font-medium text-emerald-900 dark:text-emerald-200">
                {selectedIds.size}件選択中
              </span>
              <button
                onClick={printSelected}
                className="rounded-lg bg-emerald-700 px-3 py-1.5 text-white hover:bg-emerald-800"
              >
                選択した機器のQRを発行・印刷
              </button>
              <button
                onClick={() => bulkSetIssued(true)}
                disabled={bulkUpdating}
                className="rounded-lg border border-emerald-700 px-3 py-1.5 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 dark:text-emerald-300 dark:hover:bg-emerald-900"
              >
                発行済みにする
              </button>
              <button
                onClick={() => bulkSetIssued(false)}
                disabled={bulkUpdating}
                className="rounded-lg border border-zinc-400 px-3 py-1.5 text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                未発行に戻す
              </button>
              <button
                onClick={deleteSelected}
                disabled={bulkUpdating}
                className="rounded-lg border border-red-300 px-3 py-1.5 text-red-700 hover:bg-red-100 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
              >
                削除
              </button>
              <button
                onClick={() => setSelectedIds(new Set())}
                className="ml-auto text-zinc-500 hover:underline"
              >
                選択解除
              </button>
            </div>
          )}

          {deleteError && (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400">
              {deleteError}
            </p>
          )}

          {loadingList ? (
            <p className="mt-4 text-sm text-zinc-500">読み込み中...</p>
          ) : equipmentList.length === 0 ? (
            <p className="mt-4 text-sm text-zinc-500">
              まだ機器が登録されていません。上のフォームから取り込んでください。
            </p>
          ) : filteredList.length === 0 ? (
            <p className="mt-4 text-sm text-zinc-500">
              条件に一致する機器がありません。
            </p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800">
                    <th className="w-8 py-2 pr-2">
                      <input
                        type="checkbox"
                        checked={allFilteredSelected}
                        onChange={toggleSelectAll}
                      />
                    </th>
                    <th className="py-2 pr-4">機器番号</th>
                    <th className="py-2 pr-4">機器名称</th>
                    <th className="py-2 pr-4">階層</th>
                    <th className="py-2 pr-4">バルブ種別</th>
                    <th className="py-2 pr-4">状態</th>
                    <th className="py-2 pr-2 text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredList.map((eq, index) => (
                    <tr
                      key={eq.id}
                      className="border-b border-zinc-100 dark:border-zinc-900"
                    >
                      <td className="py-2 pr-2">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(eq.id)}
                          onChange={() => {}}
                          onClick={(e) =>
                            handleRowCheckboxClick(eq.id, index, e.shiftKey)
                          }
                        />
                      </td>
                      <td className="py-2 pr-4 font-medium text-zinc-900 dark:text-zinc-100">
                        {eq.code}
                      </td>
                      <td className="py-2 pr-4 text-zinc-700 dark:text-zinc-300">
                        {eq.name}
                      </td>
                      <td className="py-2 pr-4 text-zinc-500">
                        {hierarchyPath(eq) || "—"}
                      </td>
                      <td className="py-2 pr-4 text-zinc-500">
                        {eq.valve_type || "—"}
                      </td>
                      <td className="py-2 pr-4">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            eq.qr_issued_at
                              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300"
                              : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                          }`}
                        >
                          {eq.qr_issued_at ? "発行済み" : "未発行"}
                        </span>
                      </td>
                      <td className="py-2 pr-2 text-right">
                        <button
                          onClick={() => setQrPreview(eq)}
                          className="mr-3 text-zinc-600 hover:underline dark:text-zinc-300"
                        >
                          QR表示
                        </button>
                        <button
                          onClick={() => toggleIssued(eq)}
                          className="mr-3 text-emerald-700 hover:underline dark:text-emerald-400"
                        >
                          {eq.qr_issued_at ? "未発行に戻す" : "発行済みにする"}
                        </button>
                        <button
                          onClick={() => deleteOne(eq)}
                          className="text-red-600 hover:underline dark:text-red-400"
                        >
                          削除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {/* チェックリスト割り当てモーダル */}
      {/* QRプレビューモーダル */}
      {qrPreview && origin && (
        <div
          className="fixed inset-0 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setQrPreview(null)}
        >
          <div
            className="flex flex-col items-center rounded-xl bg-white p-6 dark:bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          >
            <QRCodeSVG value={`${origin}/inspect/${qrPreview.code}`} size={220} />
            <p className="mt-3 font-semibold text-zinc-900 dark:text-zinc-100">
              {qrPreview.code}
            </p>
            <p className="text-sm text-zinc-500">{qrPreview.name}</p>
            <button
              onClick={() => setQrPreview(null)}
              className="mt-4 rounded-lg border border-zinc-300 px-4 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300"
            >
              閉じる
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
