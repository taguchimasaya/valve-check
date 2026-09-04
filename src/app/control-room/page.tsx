"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { ensureActiveSession, type InspectionSession } from "@/lib/inspectionSession";
import {
  isStepCompleteAudioEnabled,
  isValveActionAudioEnabled,
  speak,
} from "@/lib/audioSettings";
import { classifyAction, stepCompleteMessage, valveActionMessage } from "@/lib/valveAction";

type TemplateOption = { id: string; name: string; itemCount: number };
type StepInfo = { id: string; itemNo: number; name: string };
type CellState = "NA" | "PENDING" | "OK" | "NG";
type TargetState = "open" | "close";
type Cell = { state: CellState; target: TargetState | null };
type ValveRow = {
  equipmentId: string;
  code: string;
  name: string;
  cells: Record<string, Cell>;
};
type Notification = {
  id: string;
  item_id: string;
  item_name: string;
  notified_at: string;
};

// フィールド側（/inspect）と合わせ、「作業前」は進捗・確認の対象から除外する
const UNCHECKED_STEP_NAMES = new Set(["作業前"]);
function isCheckableStep(name: string) {
  return !UNCHECKED_STEP_NAMES.has(name);
}

export default function ControlRoomPage() {
  const [session, setSession] = useState<InspectionSession | null>(null);

  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [searchText, setSearchText] = useState("");
  const [checklistId, setChecklistId] = useState<string | null>(null);
  const [checklistName, setChecklistName] = useState<string>("");

  const [steps, setSteps] = useState<StepInfo[]>([]);
  const [rows, setRows] = useState<ValveRow[]>([]);
  const [loadingGrid, setLoadingGrid] = useState(false);
  const rowsRef = useRef<ValveRow[]>([]);
  const stepsRef = useRef<StepInfo[]>([]);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  useEffect(() => {
    stepsRef.current = steps;
  }, [steps]);

  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  useEffect(() => {
    ensureActiveSession().then(setSession);
    loadTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadTemplates() {
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
  }

  const loadGrid = useCallback(async () => {
    if (!checklistId || !session) return;
    setLoadingGrid(true);

    const { data: items } = await supabase
      .from("checklist_items")
      .select("id, item_no, item_name")
      .eq("template_id", checklistId)
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
  }, [checklistId, session]);

  const loadNotifications = useCallback(async () => {
    if (!checklistId || !session) return;
    const { data } = await supabase
      .from("step_notifications")
      .select("id, item_id, item_name, notified_at")
      .eq("session_id", session.id)
      .eq("template_id", checklistId)
      .order("notified_at", { ascending: false });
    setNotifications(data ?? []);
  }, [checklistId, session]);

  useEffect(() => {
    loadGrid();
    loadNotifications();
  }, [loadGrid, loadNotifications]);

  // リアルタイム購読: 現場側のチェックと工程完了通知を即座に反映する
  useEffect(() => {
    if (!checklistId || !session) return;

    const channel = supabase
      .channel(`control-room-${session.id}-${checklistId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "inspection_results", filter: `session_id=eq.${session.id}` },
        (payload) => {
          const changed = payload.new as {
            equipment_id?: string;
            item_id?: string;
            result?: string;
          };
          if (
            changed.result === "OK" &&
            changed.equipment_id &&
            changed.item_id &&
            isValveActionAudioEnabled()
          ) {
            const row = rowsRef.current.find((r) => r.equipmentId === changed.equipment_id);
            const step = stepsRef.current.find((s) => s.id === changed.item_id);
            if (row && step) {
              const requiredSequence = stepsRef.current
                .filter((s) => row.cells[s.id]?.target)
                .map((s) => ({ itemId: s.id, itemNo: s.itemNo, target: row.cells[s.id]!.target! }));
              const action = classifyAction(requiredSequence, step.id);
              if (action) speak(valveActionMessage(row.code, action));
            }
          }
          loadGrid();
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "step_notifications", filter: `session_id=eq.${session.id}` },
        (payload) => {
          const created = payload.new as { item_name?: string };
          if (created.item_name && isStepCompleteAudioEnabled()) {
            speak(stepCompleteMessage(created.item_name));
          }
          loadNotifications();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [checklistId, session, loadGrid, loadNotifications]);

  async function confirmValve(row: ValveRow) {
    if (!session) return;
    setConfirmingId(row.equipmentId);
    const doneItemIds = steps
      .filter(
        (s) =>
          isCheckableStep(s.name) &&
          (row.cells[s.id]?.state === "OK" || row.cells[s.id]?.state === "NG")
      )
      .map((s) => s.id);
    if (doneItemIds.length > 0) {
      await supabase
        .from("inspection_results")
        .update({ confirmed_at: new Date().toISOString(), confirmed_by: "制御室" })
        .eq("session_id", session.id)
        .eq("equipment_id", row.equipmentId)
        .in("item_id", doneItemIds);
    }
    setConfirmingId(null);
    loadGrid();
  }

  const filteredTemplates = templates.filter((t) =>
    t.name.toLowerCase().includes(searchText.trim().toLowerCase())
  );

  function cellLabel(cell: Cell): string {
    if (cell.state === "NA") return "／";
    const targetLabel = cell.target === "close" ? "閉" : "開";
    if (cell.state === "NG") return "✕";
    return targetLabel; // PENDING or OK
  }
  function cellClass(cell: Cell): string {
    if (cell.state === "NA") return "text-zinc-300 dark:text-zinc-700";
    if (cell.state === "PENDING") return "text-zinc-400 dark:text-zinc-600";
    if (cell.state === "NG") return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300";
    return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300"; // OK
  }

  const checkableSteps = steps.filter((s) => isCheckableStep(s.name));
  const totalRequired = rows.reduce(
    (sum, r) =>
      sum + checkableSteps.filter((s) => r.cells[s.id] && r.cells[s.id]?.state !== "NA").length,
    0
  );
  const totalDone = rows.reduce(
    (sum, r) =>
      sum +
      checkableSteps.filter((s) => r.cells[s.id]?.state === "OK" || r.cells[s.id]?.state === "NG")
        .length,
    0
  );

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 dark:bg-black">
      <div className="mx-auto max-w-5xl">
        <div className="flex items-center justify-between">
          <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400">
            ← ホームに戻る
          </Link>
          <Link href="/settings" className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400">
            音声設定 ⚙
          </Link>
        </div>
        <h1 className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          点検ダッシュボード（制御室）
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          セッション: {session?.title ?? "読み込み中..."}
        </p>

        {!checklistId ? (
          <div className="mt-6 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              監視する作業（チェックリスト）を選択してください
            </p>
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="作業名で検索（例: 第1系統）"
              className="mt-2 w-full max-w-sm rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
            <div className="mt-3 flex flex-col gap-2 sm:max-w-sm">
              {loadingTemplates ? (
                <p className="text-sm text-zinc-500">読み込み中...</p>
              ) : filteredTemplates.length === 0 ? (
                <p className="text-sm text-zinc-500">該当する作業が見つかりません。</p>
              ) : (
                filteredTemplates.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => {
                      setChecklistId(t.id);
                      setChecklistName(t.name);
                    }}
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
          <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_320px]">
            <div className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-xs text-zinc-500">監視中の作業</p>
                  <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                    {checklistName}
                  </p>
                  <p className="text-sm text-zinc-500">
                    進捗 {totalDone}/{totalRequired}
                  </p>
                </div>
                <button
                  onClick={() => setChecklistId(null)}
                  className="text-sm text-zinc-500 hover:underline"
                >
                  作業を変更
                </button>
              </div>

              {loadingGrid ? (
                <p className="mt-4 text-sm text-zinc-500">読み込み中...</p>
              ) : rows.length === 0 ? (
                <p className="mt-4 text-sm text-zinc-500">対象バルブがありません。</p>
              ) : (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[560px] border-collapse text-sm">
                    <thead>
                      <tr>
                        <th className="sticky left-0 bg-white py-2 pr-3 text-left dark:bg-zinc-950">
                          バルブ
                        </th>
                        {steps.map((s) => (
                          <th key={s.id} className="px-2 py-2 text-center text-xs font-medium text-zinc-500">
                            {s.name}
                          </th>
                        ))}
                        <th className="py-2 pl-3 text-right text-xs font-medium text-zinc-500">確認</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => {
                        const doneCount = checkableSteps.filter(
                          (s) => row.cells[s.id]?.state === "OK" || row.cells[s.id]?.state === "NG"
                        ).length;
                        const requiredCount = checkableSteps.filter(
                          (s) => row.cells[s.id] && row.cells[s.id]?.state !== "NA"
                        ).length;
                        const complete = doneCount === requiredCount && requiredCount > 0;
                        return (
                          <tr key={row.equipmentId} className="border-t border-zinc-100 dark:border-zinc-900">
                            <td className="sticky left-0 bg-white py-2 pr-3 dark:bg-zinc-950">
                              <span className="font-medium text-zinc-900 dark:text-zinc-100">{row.code}</span>
                              <span className="ml-1 block text-xs text-zinc-500">{row.name}</span>
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
                            <td className="py-2 pl-3 text-right">
                              <button
                                onClick={() => confirmValve(row)}
                                disabled={!complete || confirmingId === row.equipmentId}
                                className="rounded-lg border border-emerald-600 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-30 dark:text-emerald-400 dark:hover:bg-emerald-950"
                              >
                                確認
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
              <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">工程完了通知</p>
              {notifications.length === 0 ? (
                <p className="mt-3 text-sm text-zinc-500">まだ通知はありません。</p>
              ) : (
                <ul className="mt-3 flex flex-col gap-2">
                  {notifications.map((n, i) => (
                    <li
                      key={n.id}
                      className={`rounded-lg p-3 text-sm ${
                        i === 0
                          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
                          : "bg-zinc-50 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400"
                      }`}
                    >
                      <p className="font-medium">「{n.item_name}」が完了しました</p>
                      <p className="mt-0.5 text-xs opacity-70">
                        {new Date(n.notified_at).toLocaleTimeString("ja-JP")}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
