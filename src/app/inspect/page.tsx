"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  const [manualCode, setManualCode] = useState("");
  const [flash, setFlash] = useState<FlashMessage | null>(null);
  const scannerRef = useRef<import("html5-qrcode").Html5Qrcode | null>(null);
  const startingRef = useRef(false);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

    const nextStep = steps.find(
      (s) => isCheckableStep(s.name) && row.cells[s.id]?.state === "PENDING"
    );
    if (!nextStep) {
      showFlash({ type: "info", text: `${code}（${row.name}）はすべて操作済みです。` });
      return;
    }

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
        "カメラを起動できませんでした。ブラウザのカメラ許可設定を確認するか、下の欄に機器番号を直接入力してください。"
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

  function cellLabel(cell: Cell): string {
    if (cell.state === "NA") return "／";
    if (cell.state === "NG") return "✕";
    return cell.target === "close" ? "☓" : "◯"; // PENDING or OK
  }
  function cellClass(cell: Cell): string {
    if (cell.state === "NA") return "text-zinc-300 dark:text-zinc-700";
    if (cell.state === "PENDING") return "text-zinc-400 dark:text-zinc-600";
    if (cell.state === "NG") return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300";
    // OK: 開＝緑、閉＝赤
    return cell.target === "close"
      ? "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300"
      : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300";
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

              <div className="mt-4 flex gap-2">
                <input
                  type="text"
                  value={manualCode}
                  onChange={(e) => setManualCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && manualCode.trim()) {
                      handleScan(manualCode);
                      setManualCode("");
                    }
                  }}
                  placeholder="読み取れない場合はバルブ名を直接入力（例: V-1001）"
                  className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                />
                <button
                  onClick={() => {
                    if (manualCode.trim()) {
                      handleScan(manualCode);
                      setManualCode("");
                    }
                  }}
                  className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
                >
                  記録
                </button>
              </div>

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
                  <table className="w-full min-w-[480px] border-collapse text-sm">
                    <thead>
                      <tr>
                        <th className="sticky left-0 bg-white py-2 pr-3 text-left dark:bg-zinc-950">
                          バルブ
                        </th>
                        {steps.map((s) => (
                          <th
                            key={s.id}
                            className="px-2 py-2 text-center text-xs font-medium text-zinc-500"
                          >
                            {s.name}
                          </th>
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
                            return (
                              <td key={s.id} className="px-2 py-2 text-center">
                                <span
                                  className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${cellClass(cell)}`}
                                >
                                  {cellLabel(cell)}
                                </span>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-3 text-xs text-zinc-400">
                緑◯ 開操作済み ・ 赤☓ 閉操作済み ・ ✕ NG ・ グレーの◯/☓ 未操作（目標状態） ・ ／ 対象外。バルブ名をタップすると詳細を確認できます。
              </p>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
