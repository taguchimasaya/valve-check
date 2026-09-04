"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import {
  ensureActiveSession,
  startNewSession,
  type InspectionSession,
} from "@/lib/inspectionSession";
import {
  clearActiveChecklist,
  getActiveChecklist,
  setActiveChecklist,
  type ActiveChecklist,
} from "@/lib/activeChecklist";
import { classifyAction, valveActionMessage } from "@/lib/valveAction";

type TemplateOption = {
  id: string;
  name: string;
  itemCount: number;
};

type StepInfo = { id: string; itemNo: number; name: string };

type CellState = "NA" | "PENDING" | "OK" | "NG";
type TargetState = "open" | "close";

type Cell = { state: CellState; target: TargetState | null };

type ValveRow = {
  equipmentId: string;
  code: string;
  name: string;
  cells: Record<string, Cell>; // itemId -> cell
};

type FlashMessage = { type: "success" | "error" | "info"; text: string };

// 「作業前」はチェックリスト上は表示するが、QRスキャンでの完了対象・
// 工程完了通知の対象からは除外する（現場での確認が不要なため）。
const UNCHECKED_STEP_NAMES = new Set(["作業前"]);
function isCheckableStep(name: string) {
  return !UNCHECKED_STEP_NAMES.has(name);
}

export default function InspectScannerPage() {
  const [session, setSession] = useState<InspectionSession | null>(null);
  const [checklist, setChecklist] = useState<ActiveChecklist | null>(null);

  // 作業選択
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [searchText, setSearchText] = useState("");

  // 選択中の作業（バルブ×工程表）
  const [steps, setSteps] = useState<StepInfo[]>([]);
  const [rows, setRows] = useState<ValveRow[]>([]);
  const [loadingGrid, setLoadingGrid] = useState(false);

  // スキャナー
  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [flash, setFlash] = useState<FlashMessage | null>(null);
  const scannerRef = useRef<import("html5-qrcode").Html5Qrcode | null>(null);
  const startingRef = useRef(false);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // グリッドのマスをタップしたときの確認ポップアップ
  const [tapConfirm, setTapConfirm] = useState<{ row: ValveRow; step: StepInfo } | null>(null);
  const [tapSaving, setTapSaving] = useState(false);

  useEffect(() => {
    ensureActiveSession().then(setSession);
    setChecklist(getActiveChecklist());
    return () => {
      stopScanner();
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadTemplates = useCallback(async () => {
    setLoadingTemplates(true);
    const { data } = await supabase
      .from("checklist_templates")
      .select("id, name, checklist_items(count)")
      .order("created_at", { ascending: false });
    if (data) {
      setTemplates(
        data.map((t) => ({
          id: t.id,
          name: t.name,
          itemCount: (t.checklist_items as { count: number }[])[0]?.count ?? 0,
        }))
      );
    }
    setLoadingTemplates(false);
  }, []);

  useEffect(() => {
    if (!checklist) loadTemplates();
  }, [checklist, loadTemplates]);

  const loadGrid = useCallback(async () => {
    if (!checklist || !session) return;
    setLoadingGrid(true);

    const { data: items } = await supabase
      .from("checklist_items")
      .select("id, item_no, item_name")
      .eq("template_id", checklist.id)
      .order("item_no", { ascending: true });

    const stepList: StepInfo[] = (items ?? []).map((i) => ({
      id: i.id,
      itemNo: i.item_no,
      name: i.item_name,
    }));
    setSteps(stepList);
    const itemIds = stepList.map((s) => s.id);

    if (itemIds.length === 0) {
      setRows([]);
      setLoadingGrid(false);
      return;
    }

    const { data: mappings } = await supabase
      .from("checklist_item_equipment")
      .select("item_id, equipment_id, target_state, equipment(code, name)")
      .in("item_id", itemIds);

    const { data: results } = await supabase
      .from("inspection_results")
      .select("equipment_id, item_id, result")
      .eq("session_id", session.id)
      .in("item_id", itemIds);

    const resultMap = new Map(
      (results ?? []).map((r) => [`${r.equipment_id}:${r.item_id}`, r.result as CellState])
    );

    const rowMap = new Map<string, ValveRow>();
    (mappings ?? []).forEach((m) => {
      const eq = m.equipment as unknown as { code: string; name: string } | null;
      if (!eq) return;
      const row =
        rowMap.get(m.equipment_id) ??
        ({ equipmentId: m.equipment_id, code: eq.code, name: eq.name, cells: {} } as ValveRow);
      row.cells[m.item_id] = {
        state: resultMap.get(`${m.equipment_id}:${m.item_id}`) ?? "PENDING",
        target: m.target_state === "close" ? "close" : m.target_state === "open" ? "open" : null,
      };
      rowMap.set(m.equipment_id, row);
    });

    setRows(Array.from(rowMap.values()).sort((a, b) => a.code.localeCompare(b.code)));
    setLoadingGrid(false);
  }, [checklist, session]);

  useEffect(() => {
    loadGrid();
  }, [loadGrid]);

  function showFlash(msg: FlashMessage) {
    setFlash(msg);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlash(null), 5000);
  }

  function selectChecklist(t: TemplateOption) {
    setActiveChecklist({ id: t.id, name: t.name });
    setChecklist({ id: t.id, name: t.name });
  }

  function changeChecklist() {
    stopScanner();
    clearActiveChecklist();
    setChecklist(null);
    setSteps([]);
    setRows([]);
  }

  // 指定したバルブの「次の未完了工程」を割り出す（作業前は対象外）。
  function findNextStep(row: ValveRow): StepInfo | null {
    return (
      steps.find((s) => isCheckableStep(s.name) && row.cells[s.id]?.state === "PENDING") ?? null
    );
  }

  // QRコード（または手入力）を読み取ったバルブを「操作済み」として記録する。
  // そのバルブが必要とする工程のうち、まだ済んでいない最も早い工程をOKにする。
  // 全て終わっていれば完了済みの旨を伝える。工程が完了したら制御室へ通知する。
  async function handleScan(rawText: string) {
    if (!session || !checklist) return;
    const marker = "/inspect/";
    const trimmed = rawText.trim();
    const idx = trimmed.indexOf(marker);
    const code = (idx >= 0 ? trimmed.slice(idx + marker.length) : trimmed).trim();
    if (!code) return;

    const row = rows.find((r) => r.code === code);
    if (!row) {
      showFlash({
        type: "error",
        text: `${code} は選択中の作業「${checklist.name}」には含まれていません。`,
      });
      return;
    }

    const nextStep = findNextStep(row);
    if (!nextStep) {
      showFlash({ type: "info", text: `${code}（${row.name}）はすべて操作済みです。` });
      return;
    }

    await completeStep(row, nextStep);
  }

  // タップ確認ポップアップ、またはQR/手入力の記録先から呼ばれる、実際の記録処理。
  async function completeStep(row: ValveRow, nextStep: StepInfo) {
    if (!session || !checklist) return;
    const code = row.code;

    const { error } = await supabase.from("inspection_results").upsert(
      {
        session_id: session.id,
        equipment_id: row.equipmentId,
        item_id: nextStep.id,
        result: "OK",
        checked_at: new Date().toISOString(),
      },
      { onConflict: "session_id,equipment_id,item_id" }
    );

    if (error) {
      showFlash({ type: "error", text: `記録に失敗しました: ${error.message}` });
      return;
    }

    // ローカルの表示を即時更新
    setRows((prev) =>
      prev.map((r) =>
        r.equipmentId === row.equipmentId
          ? {
              ...r,
              cells: {
                ...r.cells,
                [nextStep.id]: { ...r.cells[nextStep.id], state: "OK" },
              },
            }
          : r
      )
    );

    // この工程が必要な全バルブが完了したかを確認し、完了していれば制御室へ通知する
    const requiredRows = rows.filter((r) => nextStep.id in r.cells);
    const allDone = requiredRows.every((r) =>
      r.equipmentId === row.equipmentId ? true : r.cells[nextStep.id]?.state !== "PENDING"
    );

    const requiredSequence = steps
      .filter((s) => row.cells[s.id]?.target)
      .map((s) => ({ itemId: s.id, itemNo: s.itemNo, target: row.cells[s.id]!.target! }));
    const action = classifyAction(requiredSequence, nextStep.id);
    const actionText = action ? valveActionMessage(code, action) : `${code}を記録しました`;

    if (allDone) {
      const { error: notifyError } = await supabase.from("step_notifications").upsert(
        {
          session_id: session.id,
          item_id: nextStep.id,
          item_name: nextStep.name,
          template_id: checklist.id,
          template_name: checklist.name,
        },
        { onConflict: "session_id,item_id", ignoreDuplicates: true }
      );
      if (!notifyError) {
        showFlash({
          type: "success",
          text: `${actionText}。工程「${nextStep.name}」が完了したので制御室に通知しました。`,
        });
        return;
      }
    }

    showFlash({ type: "success", text: `${actionText}（工程: ${nextStep.name}）` });
  }

  // グリッドのマスをタップ：そのバルブの次の未完了工程を確認ポップアップで表示する
  function openTapConfirm(row: ValveRow) {
    const nextStep = findNextStep(row);
    if (!nextStep) {
      showFlash({ type: "info", text: `${row.code}（${row.name}）はすべて操作済みです。` });
      return;
    }
    setTapConfirm({ row, step: nextStep });
  }

  async function confirmTap() {
    if (!tapConfirm) return;
    setTapSaving(true);
    await completeStep(tapConfirm.row, tapConfirm.step);
    setTapSaving(false);
    setTapConfirm(null);
  }

  async function startScanner() {
    if (startingRef.current) return;
    startingRef.current = true;
    setCameraError(null);
    try {
      const { Html5Qrcode } = await import("html5-qrcode");
      const scanner = new Html5Qrcode("qr-reader");
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        (decodedText) => {
          handleScan(decodedText);
        },
        undefined
      );
      setScanning(true);
    } catch {
      setCameraError(
        "カメラを起動できませんでした。ブラウザのカメラ許可設定を確認するか、下の一覧でバルブの丸をタップして記録してください。"
      );
    } finally {
      startingRef.current = false;
    }
  }

  function stopScanner() {
    const scanner = scannerRef.current;
    if (scanner) {
      scanner
        .stop()
        .then(() => scanner.clear())
        .catch(() => {});
      scannerRef.current = null;
    }
    setScanning(false);
  }

  async function handleStartNewSession() {
    stopScanner();
    const next = await startNewSession();
    setSession(next);
  }

  const filteredTemplates = templates.filter((t) =>
    t.name.toLowerCase().includes(searchText.trim().toLowerCase())
  );

  // 行の必須工程を工程順に並べたもの（作業前を含む＝状態比較の起点になる）
  function requiredSequence(row: ValveRow) {
    return steps
      .filter((s) => row.cells[s.id]?.target)
      .map((s) => ({ itemId: s.id, itemNo: s.itemNo, target: row.cells[s.id]!.target! }));
  }
  // 直前の必須工程から開閉状態が変わる工程＝「操作する」工程かどうか
  function isOperateStep(row: ValveRow, step: StepInfo): boolean {
    const action = classifyAction(requiredSequence(row), step.id);
    return action ? action.endsWith("-operate") : true;
  }

  function cellLabel(cell: Cell): string {
    if (cell.state === "NA") return "／";
    if (cell.state === "NG") return "✕";
    return cell.target === "close" ? "☓" : "◯"; // PENDING or OK
  }
  // 済んだかどうかは色ではなく、隣のチェック欄（☐→☑）で示す。
  // 「作業前」は操作対象ではないため、チェック欄自体を出さない。
  function checkGlyph(cell: Cell, step: StepInfo): string {
    if (cell.state === "NA" || !isCheckableStep(step.name)) return "";
    return cell.state === "PENDING" ? "☐" : "☑";
  }
  // 色を付けるのは「前の工程から開閉状態が変わる＝実際に操作するバルブ」の工程だけ。
  // 状態が変わらない（確認だけでよい）工程はグレーのまま。
  function cellClass(row: ValveRow, step: StepInfo): string {
    const cell: Cell = row.cells[step.id] ?? { state: "NA", target: null };
    if (cell.state === "NA") return "text-zinc-300 dark:text-zinc-700";
    if (cell.state === "NG") {
      return "bg-red-600 text-white ring-2 ring-red-900 dark:ring-red-400";
    }
    // 「作業前」は初期状態の記録であり操作対象ではないため、常に色をつけない
    if (!isCheckableStep(step.name) || !isOperateStep(row, step)) {
      return "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400";
    }
    const isOpen = cell.target !== "close";
    return isOpen
      ? "bg-emerald-500 text-white dark:bg-emerald-600"
      : "bg-red-500 text-white dark:bg-red-600";
  }

  return (
    <main className="min-h-screen bg-zinc-50 px-4 py-8 dark:bg-black">
      <div className="mx-auto max-w-3xl">
        <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400">
          ← ホームに戻る
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          現場チェック
        </h1>

        <div className="mt-4 flex items-center justify-between rounded-xl border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div>
            <p className="text-zinc-500">実施中のセッション</p>
            <p className="font-medium text-zinc-900 dark:text-zinc-100">
              {session?.title ?? "準備中..."}
            </p>
          </div>
          <button
            onClick={handleStartNewSession}
            className="text-emerald-700 hover:underline dark:text-emerald-400"
          >
            新しい点検を開始
          </button>
        </div>

        {!checklist ? (
          <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              作業（チェックリスト）を選択してください
            </p>
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="作業名で検索（例: 第1系統）"
              className="mt-2 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />

            <div className="mt-3 flex flex-col gap-2">
              {loadingTemplates ? (
                <p className="text-sm text-zinc-500">読み込み中...</p>
              ) : filteredTemplates.length === 0 ? (
                <p className="text-sm text-zinc-500">
                  該当する作業が見つかりません。
                  <Link href="/checklists" className="ml-1 text-emerald-700 hover:underline dark:text-emerald-400">
                    チェックリストを取り込む
                  </Link>
                </p>
              ) : (
                filteredTemplates.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => selectChecklist(t)}
                    className="rounded-lg border border-zinc-200 p-3 text-left hover:border-emerald-400 hover:bg-emerald-50 dark:border-zinc-800 dark:hover:bg-emerald-950"
                  >
                    <p className="font-medium text-zinc-900 dark:text-zinc-100">{t.name}</p>
                    <p className="text-xs text-zinc-500">{t.itemCount}工程</p>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs text-zinc-500">選択中の作業</p>
                  <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                    {checklist.name}
                  </p>
                </div>
                <button
                  onClick={changeChecklist}
                  className="whitespace-nowrap text-sm text-zinc-500 hover:underline"
                >
                  作業を変更
                </button>
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
              <div id="qr-reader" className="overflow-hidden rounded-lg" />
              {!scanning && (
                <button
                  onClick={startScanner}
                  className="mt-4 w-full rounded-lg bg-zinc-900 py-3 text-base font-semibold text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
                >
                  カメラでQRコードを読み取る
                </button>
              )}
              {scanning && (
                <button
                  onClick={stopScanner}
                  className="mt-4 w-full rounded-lg border border-zinc-300 py-3 text-base font-medium text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
                >
                  スキャンを中止
                </button>
              )}
              {cameraError && (
                <p className="mt-3 text-sm text-red-600 dark:text-red-400">{cameraError}</p>
              )}

              <p className="mt-3 text-center text-xs text-zinc-400">
                読み取れない場合は、下の一覧でバルブの丸をタップしても記録できます。
              </p>

              {flash && (
                <p
                  className={`mt-3 rounded-lg p-3 text-sm ${
                    flash.type === "success"
                      ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                      : flash.type === "error"
                      ? "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"
                      : "bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                  }`}
                >
                  {flash.text}
                </p>
              )}
            </div>

            <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
              <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                作業手順（{rows.length}台）
              </p>
              {loadingGrid ? (
                <p className="mt-2 text-sm text-zinc-500">読み込み中...</p>
              ) : rows.length === 0 ? (
                <p className="mt-2 text-sm text-zinc-500">
                  このチェックリストに紐づくバルブがありません。
                </p>
              ) : (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[560px] border-collapse text-sm">
                    <thead>
                      <tr>
                        <th
                          rowSpan={2}
                          className="sticky left-0 bg-white py-2 pr-3 text-left align-bottom dark:bg-zinc-950"
                        >
                          バルブ
                        </th>
                        {steps.map((s) => (
                          <th
                            key={s.id}
                            colSpan={2}
                            className="px-2 py-1 text-center text-xs font-medium text-zinc-500"
                          >
                            {s.name}
                          </th>
                        ))}
                      </tr>
                      <tr>
                        {steps.map((s) => (
                          <Fragment key={s.id}>
                            <th className="px-1 pb-1 text-center text-[10px] font-normal text-zinc-400">
                              状態
                            </th>
                            <th className="px-1 pb-1 text-center text-[10px] font-normal text-zinc-400">
                              済
                            </th>
                          </Fragment>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.equipmentId} className="border-t border-zinc-100 dark:border-zinc-900">
                          <td className="sticky left-0 bg-white py-2 pr-3 dark:bg-zinc-950">
                            <Link
                              href={`/inspect/${encodeURIComponent(row.code)}`}
                              className="hover:underline"
                            >
                              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                                {row.code}
                              </span>
                              <span className="ml-1 block text-xs text-zinc-500">{row.name}</span>
                            </Link>
                          </td>
                          {steps.map((s) => {
                            const cell: Cell = row.cells[s.id] ?? { state: "NA", target: null };
                            const clickable = cell.state === "PENDING" && isCheckableStep(s.name);
                            return (
                              <Fragment key={s.id}>
                                <td className="px-1 py-2 text-center">
                                  <button
                                    onClick={() => clickable && openTapConfirm(row)}
                                    disabled={!clickable}
                                    className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold ${cellClass(
                                      row,
                                      s
                                    )} ${clickable ? "cursor-pointer active:scale-95" : "cursor-default"}`}
                                  >
                                    {cellLabel(cell)}
                                  </button>
                                </td>
                                <td className="px-1 py-2 text-center text-base">
                                  <span
                                    onClick={() => clickable && openTapConfirm(row)}
                                    className={
                                      clickable
                                        ? "cursor-pointer text-zinc-400"
                                        : cell.state === "NA"
                                        ? "text-zinc-200 dark:text-zinc-800"
                                        : "text-emerald-600 dark:text-emerald-400"
                                    }
                                  >
                                    {checkGlyph(cell, s)}
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
                色つき◯/☓ = 操作するバルブ(緑=開ける／赤=閉める) ・ グレー = 状態が変わらない確認のみの工程 ・ ✕ NG ・ ／ 対象外 ・ ☑ 記録済み。◯/☓か☐をタップすると記録できます。バルブ名をタップすると詳細を確認できます。
              </p>
            </div>
          </>
        )}
      </div>

      {tapConfirm && (
        <div
          className="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !tapSaving && setTapConfirm(null)}
        >
          <div
            className="w-full max-w-xs rounded-xl bg-white p-6 text-center dark:bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-xs text-zinc-500">{tapConfirm.step.name}</p>
            <p className="mt-1 text-xl font-bold text-zinc-900 dark:text-zinc-100">
              {tapConfirm.row.code}
            </p>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">{tapConfirm.row.name}</p>
            <p className="mt-3 text-lg font-semibold">
              {(() => {
                const target = tapConfirm.row.cells[tapConfirm.step.id]?.target;
                const action = classifyAction(
                  requiredSequence(tapConfirm.row),
                  tapConfirm.step.id
                );
                const isClose = target === "close";
                const verb = action?.endsWith("confirm") ? "確認" : "操作";
                const label = `${isClose ? "閉" : "開"}${verb}（${isClose ? "☓" : "◯"}）`;
                return (
                  <span className={isClose ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}>
                    {label}
                  </span>
                );
              })()}
            </p>
            <div className="mt-5 flex gap-2">
              <button
                onClick={() => setTapConfirm(null)}
                disabled={tapSaving}
                className="flex-1 rounded-lg border border-zinc-300 py-2.5 text-sm font-medium text-zinc-700 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"
              >
                キャンセル
              </button>
              <button
                onClick={confirmTap}
                disabled={tapSaving}
                className="flex-1 rounded-lg bg-zinc-900 py-2.5 text-sm font-semibold text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
              >
                {tapSaving ? "記録中..." : "記録する"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
