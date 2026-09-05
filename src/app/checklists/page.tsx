"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import * as XLSX from "xlsx";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import {
  buildProcedureExportWorkbook,
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

type CellState = "NA" | "PENDING" | "OK" | "NG";
type TargetState = "open" | "close";
type Cell = { state: CellState; target: TargetState | null; confirmed: boolean };
type ValveRow = {
  equipmentId: string;
  code: string;
  name: string;
  cells: Record<string, Cell>;
};
type StepInfo = { id: string; itemNo: number; name: string };

type FileEntry = {
  id: string;
  file: File;
  templateName: string;
  result: ProcedureParseResult | null;
  parseError: string | null;
};

type BatchResultLine = {
  name: string;
  ok: boolean;
  detail: string;
};

function getCellLabel(cell: Cell): string {
  if (cell.state === "NA") return "／";
  if (cell.state === "NG") return "✕";
  return cell.target === "close" ? "☓" : "◯";
}

function getCellClass(cell: Cell): string {
  if (cell.state === "NA") return "text-zinc-300 dark:text-zinc-700";
  if (cell.state === "NG") {
    return "bg-red-600 text-white ring-2 ring-red-900 dark:ring-red-400";
  }
  const isOpen = cell.target !== "close";
  return isOpen
    ? "bg-emerald-500 text-white dark:bg-emerald-600"
    : "bg-red-500 text-white dark:bg-red-600";
}

export default function ChecklistsPage() {
  const [templates, setTemplates] = useState<TemplateRecord[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [equipmentByCode, setEquipmentByCode] = useState<Map<string, string>>(new Map());

  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [importing, setImporting] = useState(false);
  const [batchSummary, setBatchSummary] = useState<BatchResultLine[] | null>(null);

  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [exportingId, setExportingId] = useState<string | null>(null);

  const [previewTemplate, setPreviewTemplate] = useState<TemplateRecord | null>(null);
  const [previewSteps, setPreviewSteps] = useState<StepInfo[]>([]);
  const [previewRows, setPreviewRows] = useState<ValveRow[]>([]);
  const [loadingPreview, setLoadingPreview] = useState(false);

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

  function unknownCodesOf(result: ProcedureParseResult | null): string[] {
    if (!result) return [];
    return Array.from(
      new Set(
        result.rows
          .filter((r) => !equipmentByCode.has(r.equipmentCode))
          .map((r) => r.equipmentCode)
      )
    );
  }

  async function handleFilesChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    setBatchSummary(null);

    const parsed = await Promise.all(
      files.map(async (file) => {
        const entry: FileEntry = {
          id: crypto.randomUUID(),
          file,
          templateName: file.name.replace(/\.(xlsx|xls|csv)$/i, ""),
          result: null,
          parseError: null,
        };
        try {
          entry.result = await parseProcedureChecklistFile(file);
        } catch {
          entry.parseError =
            "ファイルの読み込みに失敗しました。CSVまたはExcel(.xlsx)形式か確認してください。";
        }
        return entry;
      })
    );

    setEntries(parsed);
    e.target.value = "";
  }

  function updateEntryName(id: string, name: string) {
    setEntries((prev) => prev.map((en) => (en.id === id ? { ...en, templateName: name } : en)));
  }

  function removeEntry(id: string) {
    setEntries((prev) => prev.filter((en) => en.id !== id));
  }

  function downloadTemplate() {
    const wb = buildProcedureTemplateWorkbook();
    XLSX.writeFile(wb, "作業手順_テンプレート.xlsx");
  }

  async function importOne(entry: FileEntry): Promise<BatchResultLine> {
    const result = entry.result!;
    const { data: template, error: templateError } = await supabase
      .from("checklist_templates")
      .insert({ name: entry.templateName.trim(), source_file: entry.file.name })
      .select("id")
      .single();

    if (templateError || !template) {
      return { name: entry.templateName, ok: false, detail: `作成失敗: ${templateError?.message}` };
    }

    const { data: insertedItems, error: itemsError } = await supabase
      .from("checklist_items")
      .insert(
        result.steps.map((stepName, i) => ({
          template_id: template.id,
          item_no: i + 1,
          item_name: stepName,
        }))
      )
      .select("id, item_no");

    if (itemsError || !insertedItems) {
      return { name: entry.templateName, ok: false, detail: `工程登録失敗: ${itemsError?.message}` };
    }

    const itemIdByStepIndex = new Map(insertedItems.map((it) => [it.item_no - 1, it.id]));
    const mappingRows = result.rows.flatMap((row) =>
      row.requiredSteps.map(({ stepIndex, target }) => ({
        item_id: itemIdByStepIndex.get(stepIndex)!,
        equipment_id: equipmentByCode.get(row.equipmentCode)!,
        target_state: target,
      }))
    );

    const { error: mappingError } = await supabase
      .from("checklist_item_equipment")
      .insert(mappingRows);

    if (mappingError) {
      return { name: entry.templateName, ok: false, detail: `紐付け失敗: ${mappingError.message}` };
    }

    const equipmentIds = Array.from(
      new Set(result.rows.map((r) => equipmentByCode.get(r.equipmentCode)!))
    );
    await supabase
      .from("equipment")
      .update({ checklist_template_id: template.id })
      .in("id", equipmentIds);

    return {
      name: entry.templateName,
      ok: true,
      detail: `${result.steps.length}工程・${result.rows.length}台のバルブで作成`,
    };
  }

  async function handleImportAll() {
    setImporting(true);
    setBatchSummary(null);
    const summary: BatchResultLine[] = [];

    for (const entry of entries) {
      if (!entry.templateName.trim()) {
        summary.push({ name: entry.file.name, ok: false, detail: "チェックリスト名が空です" });
        continue;
      }
      if (entry.parseError) {
        summary.push({ name: entry.templateName, ok: false, detail: entry.parseError });
        continue;
      }
      if (!entry.result || entry.result.rows.length === 0) {
        summary.push({ name: entry.templateName, ok: false, detail: "有効な行がありません" });
        continue;
      }
      const unknown = unknownCodesOf(entry.result);
      if (unknown.length > 0) {
        summary.push({
          name: entry.templateName,
          ok: false,
          detail: `機器マスターに無い機器番号: ${unknown.join("、")}`,
        });
        continue;
      }
      summary.push(await importOne(entry));
    }

    setImporting(false);
    setBatchSummary(summary);
    setEntries([]);
    loadTemplates();
  }

  async function openPreview(t: TemplateRecord) {
    setPreviewTemplate(t);
    setLoadingPreview(true);

    const { data: items } = await supabase
      .from("checklist_items")
      .select("id, item_no, item_name")
      .eq("template_id", t.id)
      .order("item_no", { ascending: true });

    const stepList: StepInfo[] = (items ?? []).map((i) => ({
      id: i.id,
      itemNo: i.item_no,
      name: i.item_name,
    }));
    setPreviewSteps(stepList);
    const itemIds = stepList.map((s) => s.id);

    if (itemIds.length === 0) {
      setPreviewRows([]);
      setLoadingPreview(false);
      return;
    }

    const { data: mappings } = await supabase
      .from("checklist_item_equipment")
      .select("item_id, equipment_id, target_state, equipment(code, name)")
      .in("item_id", itemIds);

    const { data: sessions } = await supabase
      .from("inspection_sessions")
      .select("id")
      .eq("status", "in_progress")
      .order("created_at", { ascending: false })
      .limit(1);

    let resultMap = new Map<string, { state: CellState; confirmed: boolean }>();
    if (sessions && sessions.length > 0) {
      const { data: results } = await supabase
        .from("inspection_results")
        .select("equipment_id, item_id, result, confirmed_at")
        .eq("session_id", sessions[0].id)
        .in("item_id", itemIds);

      resultMap = new Map(
        (results ?? []).map((r) => [
          `${r.equipment_id}:${r.item_id}`,
          { state: r.result as CellState, confirmed: !!r.confirmed_at },
        ])
      );
    }

    const rowMap = new Map<string, ValveRow>();
    (mappings ?? []).forEach((m) => {
      const eq = m.equipment as unknown as { code: string; name: string } | null;
      if (!eq) return;
      const row =
        rowMap.get(m.equipment_id) ??
        ({ equipmentId: m.equipment_id, code: eq.code, name: eq.name, cells: {} } as ValveRow);
      const existing = resultMap.get(`${m.equipment_id}:${m.item_id}`);
      row.cells[m.item_id] = {
        state: existing?.state ?? "PENDING",
        confirmed: existing?.confirmed ?? false,
        target: m.target_state === "close" ? "close" : m.target_state === "open" ? "open" : null,
      };
      rowMap.set(m.equipment_id, row);
    });

    setPreviewRows(Array.from(rowMap.values()).sort((a, b) => a.code.localeCompare(b.code)));
    setLoadingPreview(false);
  }

  async function exportTemplate(t: TemplateRecord) {
    setExportingId(t.id);
    const { data: items } = await supabase
      .from("checklist_items")
      .select("id, item_no, item_name")
      .eq("template_id", t.id)
      .order("item_no", { ascending: true });

    const itemList = items ?? [];
    const itemIds = itemList.map((i) => i.id);
    const steps = itemList.map((i) => i.item_name);

    const { data: mappings } = itemIds.length
      ? await supabase
          .from("checklist_item_equipment")
          .select("item_id, target_state, equipment(code)")
          .in("item_id", itemIds)
      : { data: [] as { item_id: string; target_state: string | null; equipment: { code: string } | null }[] };

    const itemIndexById = new Map(itemList.map((it, i) => [it.id, i]));
    const rowsByCode = new Map<string, Map<number, "open" | "close">>();
    (mappings ?? []).forEach((m) => {
      const eq = m.equipment as unknown as { code: string } | null;
      if (!eq) return;
      const stepIndex = itemIndexById.get(m.item_id);
      if (stepIndex === undefined) return;
      const map = rowsByCode.get(eq.code) ?? new Map<number, "open" | "close">();
      map.set(stepIndex, m.target_state === "close" ? "close" : "open");
      rowsByCode.set(eq.code, map);
    });

    const rows = Array.from(rowsByCode.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([equipmentCode, map]) => ({
        equipmentCode,
        requiredSteps: Array.from(map.entries()).map(([stepIndex, target]) => ({
          stepIndex,
          target,
        })),
      }));

    const wb = buildProcedureExportWorkbook(steps, rows);
    XLSX.writeFile(wb, `${t.name}.xlsx`);
    setExportingId(null);
  }

  async function deleteTemplate(t: TemplateRecord) {
    if (
      !window.confirm(
        `「${t.name}」（${t.itemCount}工程）を削除します。この操作は取り消せません。よろしいですか？`
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
    loadTemplates();
  }

  const importableCount = entries.filter(
    (en) => en.result && !en.parseError && en.result.rows.length > 0 && unknownCodesOf(en.result).length === 0
  ).length;

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
          バルブ操作手順（どのバルブをどの工程で操作するか）を取り込み、現場での誤操作を防ぎます。
        </p>

        <section className="mt-6 rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="font-medium text-zinc-900 dark:text-zinc-50">
            1. 作業手順の取り込み
          </h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            1列目にバルブ名（機器番号）、2列目以降に工程名を並べてください。各セルは、そのバルブをその工程で操作する場合は印（○など）、操作しない場合は「／」または空欄にします。「操作者」「制御室」列があっても構いません（自動で読み飛ばします）。ファイルは複数選択でき、フォルダ内のファイルをまとめて選べばまとめて取り込めます。
          </p>
          <button
            onClick={downloadTemplate}
            className="mt-3 text-sm font-medium text-emerald-700 hover:underline dark:text-emerald-400"
          >
            テンプレートをダウンロード
          </button>

          <div className="mt-4">
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              multiple
              onChange={handleFilesChange}
              className="block w-full text-sm text-zinc-600 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-zinc-700 dark:text-zinc-400 dark:file:bg-zinc-100 dark:file:text-zinc-900"
            />
          </div>

          {entries.length > 0 && (
            <div className="mt-4 flex flex-col gap-2">
              {entries.map((entry) => {
                const unknown = unknownCodesOf(entry.result);
                const hasError = !!entry.parseError || unknown.length > 0;
                return (
                  <div
                    key={entry.id}
                    className={`rounded-lg border p-3 text-sm ${
                      hasError
                        ? "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40"
                        : "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={entry.templateName}
                        onChange={(e) => updateEntryName(entry.id, e.target.value)}
                        className="flex-1 rounded-lg border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                      />
                      <button
                        onClick={() => removeEntry(entry.id)}
                        className="text-xs text-zinc-500 hover:underline"
                      >
                        除外
                      </button>
                    </div>
                    <p className="mt-1 text-xs text-zinc-500">{entry.file.name}</p>
                    {entry.parseError ? (
                      <p className="mt-1 text-red-600 dark:text-red-400">{entry.parseError}</p>
                    ) : entry.result ? (
                      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                        工程数: {entry.result.steps.length} / バルブ数: {entry.result.rows.length}
                      </p>
                    ) : null}
                    {unknown.length > 0 && (
                      <p className="mt-1 text-red-600 dark:text-red-400">
                        機器マスターに登録されていない機器番号: {unknown.join("、")}
                        （修正してから再選択してください）
                      </p>
                    )}
                  </div>
                );
              })}

              <button
                onClick={handleImportAll}
                disabled={importing || importableCount === 0}
                className="mt-2 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
              >
                {importing
                  ? "登録中..."
                  : `有効な${importableCount}件をインポート（全${entries.length}件中）`}
              </button>
            </div>
          )}

          {batchSummary && (
            <div className="mt-4 rounded-lg bg-zinc-50 p-4 text-sm dark:bg-zinc-900">
              <p className="font-medium text-zinc-700 dark:text-zinc-300">
                {batchSummary.filter((b) => b.ok).length}/{batchSummary.length}件を取り込みました
              </p>
              <ul className="mt-2 flex flex-col gap-1">
                {batchSummary.map((b, i) => (
                  <li
                    key={i}
                    className={b.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}
                  >
                    {b.ok ? "✓" : "✕"} {b.name}: {b.detail}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

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
                      {t.itemCount}工程 ・ {new Date(t.created_at).toLocaleDateString("ja-JP")}
                    </p>
                  </div>
                  <div className="flex gap-3 text-sm">
                    <button
                      onClick={() => openPreview(t)}
                      className="text-emerald-700 hover:underline dark:text-emerald-400"
                    >
                      プレビュー
                    </button>
                    <button
                      onClick={() => exportTemplate(t)}
                      disabled={exportingId === t.id}
                      className="text-emerald-700 hover:underline disabled:opacity-50 dark:text-emerald-400"
                    >
                      {exportingId === t.id ? "出力中..." : "エクスポート"}
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

      {/* プレビューモーダル（制御室形式） */}
      {previewTemplate && (
        <div
          className="fixed inset-0 flex items-center justify-center bg-black/40 p-4 z-50"
          onClick={() => setPreviewTemplate(null)}
        >
          <div
            className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-xl bg-white p-6 dark:bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">{previewTemplate.name}</h3>
                <p className="text-xs text-zinc-500 mt-1">最新セッション状態</p>
              </div>
              <button
                onClick={() => setPreviewTemplate(null)}
                className="text-sm text-zinc-500 hover:underline"
              >
                閉じる
              </button>
            </div>

            {loadingPreview ? (
              <p className="text-sm text-zinc-500">読み込み中...</p>
            ) : previewRows.length === 0 ? (
              <p className="text-sm text-zinc-500">対象バルブがありません。</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] border-collapse text-sm">
                  <thead>
                    <tr>
                      <th rowSpan={2} className="sticky left-0 bg-white py-2 pr-3 text-left align-bottom dark:bg-zinc-900">
                        バルブ
                      </th>
                      {previewSteps.map((s) => (
                        <th key={s.id} colSpan={3} className="px-2 py-1 text-center text-xs font-medium text-zinc-500">
                          {s.name}
                        </th>
                      ))}
                    </tr>
                    <tr>
                      {previewSteps.map((s) => (
                        <Fragment key={s.id}>
                          <th className="px-1 pb-1 text-center text-[10px] font-normal text-zinc-400">
                            状態
                          </th>
                          <th className="px-1 pb-1 text-center text-[10px] font-normal text-zinc-400">
                            現場
                          </th>
                          <th className="px-1 pb-1 text-center text-[10px] font-normal text-zinc-400">
                            確認
                          </th>
                        </Fragment>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((row) => (
                      <tr key={row.equipmentId} className="border-t border-zinc-100 dark:border-zinc-900">
                        <td className="sticky left-0 bg-white py-2 pr-3 dark:bg-zinc-900">
                          <span className="font-medium text-zinc-900 dark:text-zinc-100">{row.code}</span>
                          <span className="ml-1 block text-xs text-zinc-500">{row.name}</span>
                        </td>
                        {previewSteps.map((s) => {
                          const cell: Cell = row.cells[s.id] ?? {
                            state: "NA",
                            target: null,
                            confirmed: false,
                          };
                          return (
                            <Fragment key={s.id}>
                              <td className="px-1 py-2 text-center">
                                <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${getCellClass(cell)}`}>
                                  {getCellLabel(cell)}
                                </span>
                              </td>
                              <td className="px-1 py-2 text-center text-base">
                                <span
                                  className={
                                    cell.state !== "PENDING" && cell.state !== "NA"
                                      ? "text-emerald-600 dark:text-emerald-400"
                                      : "text-zinc-300 dark:text-zinc-700"
                                  }
                                >
                                  {cell.state !== "PENDING" && cell.state !== "NA" ? "☑" : "☐"}
                                </span>
                              </td>
                              <td className="px-1 py-2 text-center">
                                <span
                                  className={
                                    cell.confirmed
                                      ? "text-emerald-600 dark:text-emerald-400"
                                      : "text-zinc-300 dark:text-zinc-700"
                                  }
                                >
                                  {cell.confirmed ? "☑" : "☐"}
                                </span>
                              </td>
                            </Fragment>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-3 text-xs text-zinc-400">
              緑◯/赤☓ = 操作するバルブ(緑=開ける／赤=閉める) ・ グレー = 操作対象外 ・ ✕ NG ・ ／ 対象外
            </p>
          </div>
        </div>
      )}
    </main>
  );
}
