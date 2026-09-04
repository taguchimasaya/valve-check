"use client";

import { useCallback, useEffect, useState } from "react";
import * as XLSX from "xlsx";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import {
  buildChecklistTemplateWorkbook,
  parseChecklistFile,
  type ChecklistItemRow,
  type ChecklistParseResult,
} from "@/lib/parseChecklistFile";
import {
  buildProcedureTemplateWorkbook,
  parseProcedureChecklistFile,
  type ProcedureParseResult,
} from "@/lib/parseProcedureChecklistFile";

type TemplateRecord = {
  id: string;
  name: string;
  source_file: string | null;
  created_at: string;
  itemCount: number;
};

type ItemRecord = {
  id: string;
  item_no: number;
  item_name: string;
  criteria: string | null;
};

type Mode = "list" | "procedure";

export default function ChecklistsPage() {
  const [mode, setMode] = useState<Mode>("procedure");

  const [templates, setTemplates] = useState<TemplateRecord[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [equipmentByCode, setEquipmentByCode] = useState<Map<string, string>>(new Map());

  // 項目リスト形式
  const [templateName, setTemplateName] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseResult, setParseResult] = useState<ChecklistParseResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // バルブ×工程表形式
  const [procTemplateName, setProcTemplateName] = useState("");
  const [procFileName, setProcFileName] = useState<string | null>(null);
  const [procResult, setProcResult] = useState<ProcedureParseResult | null>(null);
  const [procImporting, setProcImporting] = useState(false);
  const [procImportMessage, setProcImportMessage] = useState<string | null>(null);
  const [procImportError, setProcImportError] = useState<string | null>(null);

  const [openTemplate, setOpenTemplate] = useState<TemplateRecord | null>(null);
  const [openItems, setOpenItems] = useState<ItemRecord[]>([]);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const loadTemplates = useCallback(async () => {
    setLoadingList(true);
    const { data, error } = await supabase
      .from("checklist_templates")
      .select("id, name, source_file, created_at, checklist_items(count)")
      .order("created_at", { ascending: false });
    if (!error && data) {
      setTemplates(
        data.map((t) => ({
          id: t.id,
          name: t.name,
          source_file: t.source_file,
          created_at: t.created_at,
          itemCount: (t.checklist_items as { count: number }[])[0]?.count ?? 0,
        }))
      );
    }
    setLoadingList(false);
  }, []);

  const loadEquipmentCodes = useCallback(async () => {
    const { data } = await supabase.from("equipment").select("id, code");
    if (data) {
      setEquipmentByCode(new Map(data.map((e) => [e.code, e.id])));
    }
  }, []);

  useEffect(() => {
    loadTemplates();
    loadEquipmentCodes();
  }, [loadTemplates, loadEquipmentCodes]);

  // --- 項目リスト形式 ---

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    if (!templateName) {
      setTemplateName(file.name.replace(/\.(xlsx|xls|csv)$/i, ""));
    }
    setImportMessage(null);
    setImportError(null);
    try {
      const result = await parseChecklistFile(file);
      setParseResult(result);
    } catch {
      setImportError(
        "ファイルの読み込みに失敗しました。CSVまたはExcel(.xlsx)形式か確認してください。"
      );
      setParseResult(null);
    }
  }

  async function handleImport(rows: ChecklistItemRow[]) {
    if (!templateName.trim()) {
      setImportError("チェックリスト名を入力してください。");
      return;
    }
    setImporting(true);
    setImportMessage(null);
    setImportError(null);

    const { data: template, error: templateError } = await supabase
      .from("checklist_templates")
      .insert({ name: templateName.trim(), source_file: fileName })
      .select("id")
      .single();

    if (templateError || !template) {
      setImporting(false);
      setImportError(`チェックリストの作成に失敗しました: ${templateError?.message}`);
      return;
    }

    const { error: itemsError } = await supabase.from("checklist_items").insert(
      rows.map((r) => ({
        template_id: template.id,
        item_no: r.itemNo,
        item_name: r.itemName,
        criteria: r.criteria || null,
      }))
    );

    setImporting(false);
    if (itemsError) {
      setImportError(`点検項目の登録に失敗しました: ${itemsError.message}`);
      return;
    }

    setImportMessage(`「${templateName.trim()}」を${rows.length}項目で作成しました。`);
    setParseResult(null);
    setFileName(null);
    setTemplateName("");
    loadTemplates();
  }

  function downloadTemplate() {
    const wb = buildChecklistTemplateWorkbook();
    XLSX.writeFile(wb, "チェックリスト_テンプレート.xlsx");
  }

  // --- バルブ×工程表形式 ---

  async function handleProcFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setProcFileName(file.name);
    if (!procTemplateName) {
      setProcTemplateName(file.name.replace(/\.(xlsx|xls|csv)$/i, ""));
    }
    setProcImportMessage(null);
    setProcImportError(null);
    try {
      const result = await parseProcedureChecklistFile(file);
      setProcResult(result);
    } catch {
      setProcImportError(
        "ファイルの読み込みに失敗しました。CSVまたはExcel(.xlsx)形式か確認してください。"
      );
      setProcResult(null);
    }
  }

  function downloadProcedureTemplate() {
    const wb = buildProcedureTemplateWorkbook();
    XLSX.writeFile(wb, "作業手順_テンプレート.xlsx");
  }

  async function handleProcedureImport() {
    if (!procResult) return;
    if (!procTemplateName.trim()) {
      setProcImportError("チェックリスト名を入力してください。");
      return;
    }

    const unknownCodes = procResult.rows.filter((r) => !equipmentByCode.has(r.equipmentCode));
    const knownRows = procResult.rows.filter((r) => equipmentByCode.has(r.equipmentCode));

    if (knownRows.length === 0) {
      setProcImportError("機器マスターに登録済みのバルブが1件も含まれていません。");
      return;
    }

    setProcImporting(true);
    setProcImportMessage(null);
    setProcImportError(null);

    const { data: template, error: templateError } = await supabase
      .from("checklist_templates")
      .insert({ name: procTemplateName.trim(), source_file: procFileName })
      .select("id")
      .single();

    if (templateError || !template) {
      setProcImporting(false);
      setProcImportError(`チェックリストの作成に失敗しました: ${templateError?.message}`);
      return;
    }

    const { data: insertedItems, error: itemsError } = await supabase
      .from("checklist_items")
      .insert(
        procResult.steps.map((stepName, i) => ({
          template_id: template.id,
          item_no: i + 1,
          item_name: stepName,
        }))
      )
      .select("id, item_no");

    if (itemsError || !insertedItems) {
      setProcImporting(false);
      setProcImportError(`工程の登録に失敗しました: ${itemsError?.message}`);
      return;
    }

    const itemIdByStepIndex = new Map(insertedItems.map((it) => [it.item_no - 1, it.id]));

    const mappingRows = knownRows.flatMap((row) =>
      row.requiredStepIndexes.map((stepIndex) => ({
        item_id: itemIdByStepIndex.get(stepIndex)!,
        equipment_id: equipmentByCode.get(row.equipmentCode)!,
      }))
    );

    const { error: mappingError } = await supabase
      .from("checklist_item_equipment")
      .insert(mappingRows);

    if (mappingError) {
      setProcImporting(false);
      setProcImportError(`バルブと工程の紐付けに失敗しました: ${mappingError.message}`);
      return;
    }

    const equipmentIds = Array.from(new Set(knownRows.map((r) => equipmentByCode.get(r.equipmentCode)!)));
    await supabase
      .from("equipment")
      .update({ checklist_template_id: template.id })
      .in("id", equipmentIds);

    setProcImporting(false);
    setProcImportMessage(
      `「${procTemplateName.trim()}」を${procResult.steps.length}工程・${knownRows.length}台のバルブで作成しました。` +
        (unknownCodes.length > 0
          ? ` （機器マスターに見つからなかった${unknownCodes.length}件はスキップしました）`
          : "")
    );
    setProcResult(null);
    setProcFileName(null);
    setProcTemplateName("");
    loadTemplates();
  }

  async function openTemplateItems(t: TemplateRecord) {
    setOpenTemplate(t);
    const { data } = await supabase
      .from("checklist_items")
      .select("id, item_no, item_name, criteria")
      .eq("template_id", t.id)
      .order("item_no", { ascending: true });
    setOpenItems(data ?? []);
  }

  async function deleteTemplate(t: TemplateRecord) {
    if (
      !window.confirm(
        `「${t.name}」（${t.itemCount}項目）を削除します。この操作は取り消せません。よろしいですか？`
      )
    ) {
      return;
    }
    setDeleteError(null);
    const { error } = await supabase.from("checklist_templates").delete().eq("id", t.id);
    if (error) {
      setDeleteError(
        `削除に失敗しました: ${error.message}（機器に割り当て中のチェックリストは、先に割り当てを解除してください）`
      );
      return;
    }
    if (openTemplate?.id === t.id) setOpenTemplate(null);
    loadTemplates();
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
          チェックリスト管理
        </h1>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">
          既存のチェックリスト（Excel）を取り込み、現場チェックで使う項目を登録します。
        </p>

        {/* モード切り替え */}
        <div className="mt-6 flex gap-1 rounded-lg border border-zinc-300 p-1 dark:border-zinc-700">
          <button
            onClick={() => setMode("procedure")}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
              mode === "procedure"
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            }`}
          >
            バルブ操作手順（バルブ×工程表）
          </button>
          <button
            onClick={() => setMode("list")}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
              mode === "list"
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            }`}
          >
            点検項目リスト
          </button>
        </div>

        {mode === "procedure" ? (
          <section className="mt-4 rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
            <h2 className="font-medium text-zinc-900 dark:text-zinc-50">
              1. 作業手順の取り込み
            </h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              1列目にバルブ名（機器番号）、2列目以降に工程名を並べてください。各セルは、そのバルブをその工程で操作する場合は印（○など）、操作しない場合は「／」または空欄にします。
            </p>
            <button
              onClick={downloadProcedureTemplate}
              className="mt-3 text-sm font-medium text-emerald-700 hover:underline dark:text-emerald-400"
            >
              テンプレートをダウンロード
            </button>

            <div className="mt-4 flex flex-col gap-3">
              <input
                type="text"
                value={procTemplateName}
                onChange={(e) => setProcTemplateName(e.target.value)}
                placeholder="チェックリスト名（例: 第1系統 切替作業手順）"
                className="rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
              <input
                type="file"
                accept=".csv,.xlsx,.xls"
                onChange={handleProcFileChange}
                className="block w-full text-sm text-zinc-600 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-zinc-700 dark:text-zinc-400 dark:file:bg-zinc-100 dark:file:text-zinc-900"
              />
            </div>

            {procFileName && procResult && (
              <div className="mt-4 rounded-lg bg-zinc-50 p-4 text-sm dark:bg-zinc-900">
                <p className="text-zinc-700 dark:text-zinc-300">
                  <span className="font-medium">{procFileName}</span> を読み込みました。
                  工程数: {procResult.steps.length} / バルブ数: {procResult.rows.length}
                </p>
                <p className="mt-1 text-xs text-zinc-500">
                  工程: {procResult.steps.join(" → ")}
                </p>

                {(() => {
                  const unknown = procResult.rows.filter((r) => !equipmentByCode.has(r.equipmentCode));
                  return unknown.length > 0 ? (
                    <div className="mt-2 rounded-lg bg-amber-50 p-3 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                      <p className="font-medium">
                        機器マスターに見つからないバルブが{unknown.length}件あります（インポートからは除外されます）
                      </p>
                      <p className="mt-1 text-xs">
                        {unknown.slice(0, 8).map((r) => r.equipmentCode).join("、")}
                        {unknown.length > 8 && ` ほか${unknown.length - 8}件`}
                      </p>
                    </div>
                  ) : null;
                })()}

                {procResult.errors.length > 0 && (
                  <ul className="mt-2 list-disc pl-5 text-amber-700 dark:text-amber-500">
                    {procResult.errors.slice(0, 5).map((e) => (
                      <li key={e.rowNumber}>
                        {e.rowNumber}行目: {e.message}
                      </li>
                    ))}
                    {procResult.errors.length > 5 && <li>ほか{procResult.errors.length - 5}件</li>}
                  </ul>
                )}

                <button
                  onClick={handleProcedureImport}
                  disabled={procImporting || procResult.rows.length === 0}
                  className="mt-3 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
                >
                  {procImporting ? "登録中..." : "この内容でチェックリストを作成"}
                </button>
              </div>
            )}

            {procImportMessage && (
              <p className="mt-3 text-sm text-emerald-700 dark:text-emerald-400">{procImportMessage}</p>
            )}
            {procImportError && (
              <p className="mt-3 text-sm text-red-600 dark:text-red-400">{procImportError}</p>
            )}
          </section>
        ) : (
          <section className="mt-4 rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
            <h2 className="font-medium text-zinc-900 dark:text-zinc-50">
              1. チェックリストの取り込み
            </h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              列は「項目番号」「点検項目」「判定基準」の順で用意してください（項目番号は省略すると行の順番で自動採番します）。この形式は全バルブ共通の点検項目リストで、機器マスター管理画面から個別にバルブへ割り当てます。
            </p>
            <button
              onClick={downloadTemplate}
              className="mt-3 text-sm font-medium text-emerald-700 hover:underline dark:text-emerald-400"
            >
              テンプレートをダウンロード
            </button>

            <div className="mt-4 flex flex-col gap-3">
              <input
                type="text"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder="チェックリスト名（例: バルブ定期点検チェックリスト）"
                className="rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
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
                  有効: {parseResult.valid.length}項目 / 無効: {parseResult.invalid.length}項目
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
                  <div className="mt-3 max-h-40 overflow-y-auto rounded border border-zinc-200 dark:border-zinc-800">
                    <table className="w-full text-left text-xs">
                      <tbody>
                        {parseResult.valid.map((r) => (
                          <tr key={r.itemNo} className="border-b border-zinc-100 dark:border-zinc-900">
                            <td className="px-2 py-1 text-zinc-400">{r.itemNo}</td>
                            <td className="px-2 py-1 text-zinc-700 dark:text-zinc-300">{r.itemName}</td>
                            <td className="px-2 py-1 text-zinc-500">{r.criteria}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {parseResult.valid.length > 0 && (
                  <button
                    onClick={() => handleImport(parseResult.valid)}
                    disabled={importing}
                    className="mt-3 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
                  >
                    {importing ? "登録中..." : `${parseResult.valid.length}項目でチェックリストを作成`}
                  </button>
                )}
              </div>
            )}

            {importMessage && (
              <p className="mt-3 text-sm text-emerald-700 dark:text-emerald-400">{importMessage}</p>
            )}
            {importError && (
              <p className="mt-3 text-sm text-red-600 dark:text-red-400">{importError}</p>
            )}
          </section>
        )}

        {/* 一覧 */}
        <section className="mt-6 rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="font-medium text-zinc-900 dark:text-zinc-50">
            2. 登録済みチェックリスト（{templates.length}件）
          </h2>

          {deleteError && (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400">{deleteError}</p>
          )}

          {loadingList ? (
            <p className="mt-4 text-sm text-zinc-500">読み込み中...</p>
          ) : templates.length === 0 ? (
            <p className="mt-4 text-sm text-zinc-500">
              まだチェックリストが登録されていません。上のフォームから取り込んでください。
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-zinc-100 dark:divide-zinc-900">
              {templates.map((t) => (
                <li key={t.id} className="flex items-center justify-between py-3">
                  <div>
                    <p className="font-medium text-zinc-900 dark:text-zinc-100">{t.name}</p>
                    <p className="text-xs text-zinc-500">
                      {t.itemCount}項目 ・ {new Date(t.created_at).toLocaleDateString("ja-JP")}
                    </p>
                  </div>
                  <div className="flex gap-3 text-sm">
                    <button
                      onClick={() => openTemplateItems(t)}
                      className="text-zinc-600 hover:underline dark:text-zinc-300"
                    >
                      項目を見る
                    </button>
                    <button
                      onClick={() => deleteTemplate(t)}
                      className="text-red-600 hover:underline dark:text-red-400"
                    >
                      削除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* 項目プレビューモーダル */}
      {openTemplate && (
        <div
          className="fixed inset-0 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOpenTemplate(null)}
        >
          <div
            className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 dark:bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">{openTemplate.name}</h3>
              <button
                onClick={() => setOpenTemplate(null)}
                className="text-sm text-zinc-500 hover:underline"
              >
                閉じる
              </button>
            </div>
            <table className="mt-4 w-full text-left text-sm">
              <thead>
                <tr className="text-zinc-500">
                  <th className="w-10 py-1">No</th>
                  <th className="py-1">項目</th>
                  <th className="py-1">判定基準</th>
                </tr>
              </thead>
              <tbody>
                {openItems.map((item) => (
                  <tr key={item.id} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="py-2 text-zinc-400">{item.item_no}</td>
                    <td className="py-2 text-zinc-800 dark:text-zinc-200">{item.item_name}</td>
                    <td className="py-2 text-zinc-500">{item.criteria || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </main>
  );
}
