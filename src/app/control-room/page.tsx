"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { getActiveSessions, type InspectionSession } from "@/lib/inspectionSession";
import {
  isStepCompleteAudioEnabled,
  isValveActionAudioEnabled,
  speak,
} from "@/lib/audioSettings";
import { classifyAction, stepCompleteMessage, stepStartMessage, valveActionMessage } from "@/lib/valveAction";

type TemplateOption = { id: string; name: string; itemCount: number };
type StepInfo = { id: string; itemNo: number; name: string };
type CellState = "NA" | "PENDING" | "OK" | "NG";
type TargetState = "open" | "close";
type Cell = { state: CellState; target: TargetState | null; confirmed: boolean };
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

const UNCHECKED_STEP_NAMES = new Set(["作業前"]);
function isCheckableStep(name: string) {
  return !UNCHECKED_STEP_NAMES.has(name);
}

export default function ControlRoomPage() {
  const [sessions, setSessions] = useState<InspectionSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(true);

  const [templates, setTemplates] = useState<TemplateOption[]>([]);
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
  const playedEventsRef = useRef<Set<string>>(new Set());
  const [sessionProgress, setSessionProgress] = useState<
    Record<string, { fieldDone: number; fieldTotal: number; confirmedDone: number } | null>
  >({});

  const selectedSession = sessions.find((s) => s.id === selectedSessionId);

  const loadSessions = useCallback(async () => {
    setLoadingSessions(true);
    const data = await getActiveSessions();
    setSessions(data);
    setLoadingSessions(false);
  }, []);

  useEffect(() => {
    if (selectedSession?.current_checklist_template_id) {
      setChecklistId(selectedSession.current_checklist_template_id);
      const template = templates.find((t) => t.id === selectedSession.current_checklist_template_id);
      if (template) {
        setChecklistName(template.name);
      }
    }
  }, [selectedSession, templates]);

  useEffect(() => {
    if (sessions.length === 0) return;

    const loadAllProgress = async () => {
      const progress: Record<string, { fieldDone: number; fieldTotal: number; confirmedDone: number } | null> = {};
      for (const session of sessions) {
        progress[session.id] = await getSessionProgress(session);
      }
      setSessionProgress(progress);
    };

    loadAllProgress();
  }, [sessions]);

  useEffect(() => {
    loadSessions();
    const loadTemplates = async () => {
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
    };
    loadTemplates();
  }, [loadSessions]);

  const loadGrid = useCallback(async () => {
    if (!checklistId || !selectedSession) return;
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
      .select("equipment_id, item_id, result, confirmed_at")
      .eq("session_id", selectedSession.id)
      .in("item_id", itemIds);

    const resultMap = new Map(
      (results ?? []).map((r) => [
        `${r.equipment_id}:${r.item_id}`,
        { state: r.result as CellState, confirmed: !!r.confirmed_at },
      ])
    );

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

    setRows(Array.from(rowMap.values()).sort((a, b) => a.code.localeCompare(b.code)));
    setLoadingGrid(false);
  }, [checklistId, selectedSession]);

  const loadNotifications = useCallback(async () => {
    if (!checklistId || !selectedSession) return;
    const { data } = await supabase
      .from("step_notifications")
      .select("id, item_id, item_name, notified_at")
      .eq("session_id", selectedSession.id)
      .eq("template_id", checklistId)
      .order("notified_at", { ascending: false });
    setNotifications(data ?? []);
  }, [checklistId, selectedSession]);

  useEffect(() => {
    loadGrid();
    loadNotifications();
  }, [loadGrid, loadNotifications]);

  useEffect(() => {
    if (selectedSession?.current_checklist_template_id) {
      setChecklistId(selectedSession.current_checklist_template_id);
      const template = templates.find((t) => t.id === selectedSession.current_checklist_template_id);
      if (template) {
        setChecklistName(template.name);
      }
    }
  }, [selectedSession, templates]);

  useEffect(() => {
    if (!selectedSession) return;

    const sessionChannel = supabase
      .channel(`session-${selectedSession.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "inspection_sessions", filter: `id=eq.${selectedSession.id}` },
        (payload) => {
          const updated = payload.new as {
            current_checklist_template_id?: string | null;
            current_item_id?: string | null;
          };

          if (updated.current_checklist_template_id) {
            setChecklistId(updated.current_checklist_template_id);
            const template = templates.find((t) => t.id === updated.current_checklist_template_id);
            if (template) {
              setChecklistName(template.name);
            }
          }

          if (updated.current_item_id !== undefined) {
            setSessions((prev) =>
              prev.map((s) =>
                s.id === selectedSession.id
                  ? { ...s, current_item_id: updated.current_item_id ?? null }
                  : s
              )
            );
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(sessionChannel);
    };
  }, [selectedSession, templates]);

  useEffect(() => {
    if (!checklistId || !selectedSession) return;

    const channel = supabase
      .channel(`control-room-${selectedSession.id}-${checklistId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "inspection_results", filter: `session_id=eq.${selectedSession.id}` },
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
            const eventId = `valve-${selectedSession.id}-${changed.equipment_id}-${changed.item_id}`;
            const row = rowsRef.current.find((r) => r.equipmentId === changed.equipment_id);
            const step = stepsRef.current.find((s) => s.id === changed.item_id);
            if (row && step && !playedEventsRef.current.has(eventId)) {
              playedEventsRef.current.add(eventId);
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
        { event: "INSERT", schema: "public", table: "step_notifications", filter: `session_id=eq.${selectedSession.id}` },
        (payload) => {
          const created = payload.new as { id?: string; item_name?: string; template_name?: string; session_id?: string };
          const eventId = `complete-${created.session_id}-${created.id}`;
          if (
            created.item_name &&
            created.template_name &&
            isStepCompleteAudioEnabled() &&
            !playedEventsRef.current.has(eventId)
          ) {
            playedEventsRef.current.add(eventId);
            speak(stepCompleteMessage(created.template_name, created.item_name));
          }
          loadNotifications();
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "step_start_notifications", filter: `session_id=eq.${selectedSession.id}` },
        (payload) => {
          const created = payload.new as { id?: string; item_name?: string; template_name?: string; session_id?: string };
          const eventId = `start-${created.session_id}-${created.id}`;
          if (
            created.item_name &&
            created.template_name &&
            isStepCompleteAudioEnabled() &&
            !playedEventsRef.current.has(eventId)
          ) {
            playedEventsRef.current.add(eventId);
            speak(stepStartMessage(created.template_name, created.item_name));
          }
          loadNotifications();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [checklistId, selectedSession, loadGrid, loadNotifications]);

  useEffect(() => {
    const globalStartChannel = supabase
      .channel("inspection-start-notifications-global")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "inspection_start_notifications" },
        async (payload) => {
          const created = payload.new as {
            id?: string;
            session_id?: string;
            template_name?: string;
            template_id?: string;
          };
          if (!created.session_id) return;

          const { data: updatedSession } = await supabase
            .from("inspection_sessions")
            .select("id, title, session_date, status, current_item_id, current_checklist_template_id")
            .eq("id", created.session_id)
            .single();

          if (updatedSession) {
            setSessions((prev) => {
              const exists = prev.some((s) => s.id === created.session_id);
              if (exists) {
                return prev.map((s) => s.id === created.session_id ? updatedSession : s);
              }
              return [updatedSession, ...prev];
            });
          }

          if (selectedSessionId === created.session_id && isValveActionAudioEnabled()) {
            const eventId = `inspection_start-${created.session_id}-${created.template_id}`;
            if (!playedEventsRef.current.has(eventId)) {
              playedEventsRef.current.add(eventId);
              if (created.template_name) {
                speak(`${created.template_name} 点検開始しました`);
              }
            }
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(globalStartChannel);
    };
  }, [selectedSessionId]);

  useEffect(() => {
    const newSessionChannel = supabase
      .channel("inspection-sessions-new")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "inspection_sessions" },
        (payload) => {
          const newSession = payload.new as InspectionSession;
          setSessions((prev) => {
            const exists = prev.some((s) => s.id === newSession.id);
            if (exists) return prev;
            return [newSession, ...prev];
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(newSessionChannel);
    };
  }, []);

  async function toggleConfirm(row: ValveRow, step: StepInfo) {
    if (!selectedSession) return;
    const cell = row.cells[step.id];
    if (!cell || (cell.state !== "OK" && cell.state !== "NG")) return;

    const cellKey = `${row.equipmentId}:${step.id}`;
    setConfirmingId(cellKey);

    await supabase
      .from("inspection_results")
      .update({
        confirmed_at: cell.confirmed ? null : new Date().toISOString(),
        confirmed_by: cell.confirmed ? null : "制御室",
      })
      .eq("session_id", selectedSession.id)
      .eq("equipment_id", row.equipmentId)
      .eq("item_id", step.id);

    setConfirmingId(null);
    loadGrid();
  }

  function requiredSequence(row: ValveRow) {
    return steps
      .filter((s) => row.cells[s.id]?.target)
      .map((s) => ({ itemId: s.id, itemNo: s.itemNo, target: row.cells[s.id]!.target! }));
  }

  function isOperateStep(row: ValveRow, step: StepInfo): boolean {
    const action = classifyAction(requiredSequence(row), step.id);
    return action ? action.endsWith("-operate") : true;
  }

  function cellLabel(cell: Cell): string {
    if (cell.state === "NA") return "／";
    if (cell.state === "NG") return "✕";
    return cell.target === "close" ? "☓" : "◯";
  }

  function cellClass(row: ValveRow, step: StepInfo): string {
    const cell: Cell = row.cells[step.id] ?? { state: "NA", target: null, confirmed: false };
    if (cell.state === "NA") return "text-zinc-300 dark:text-zinc-700";
    if (cell.state === "NG") {
      return "bg-red-600 text-white ring-2 ring-red-900 dark:ring-red-400";
    }
    if (!isCheckableStep(step.name) || !isOperateStep(row, step)) {
      return "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400";
    }
    const isOpen = cell.target !== "close";
    return isOpen
      ? "bg-emerald-500 text-white dark:bg-emerald-600"
      : "bg-red-500 text-white dark:bg-red-600";
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
  const totalConfirmed = rows.reduce(
    (sum, r) =>
      sum +
      checkableSteps.filter((s) => r.cells[s.id]?.confirmed)
        .length,
    0
  );

  async function getSessionProgress(session: InspectionSession) {
    if (!session.current_checklist_template_id) return { fieldDone: 0, fieldTotal: 0, confirmedDone: 0 };

    const { data: items } = await supabase
      .from("checklist_items")
      .select("id")
      .eq("template_id", session.current_checklist_template_id);

    if (!items || items.length === 0) return { fieldDone: 0, fieldTotal: 0, confirmedDone: 0 };

    const itemIds = items.map((i) => i.id);

    const { data: mappings } = await supabase
      .from("checklist_item_equipment")
      .select("item_id, equipment_id")
      .in("item_id", itemIds);

    if (!mappings || mappings.length === 0) return { fieldDone: 0, fieldTotal: 0, confirmedDone: 0 };

    const { data: results } = await supabase
      .from("inspection_results")
      .select("item_id, result, confirmed_at")
      .eq("session_id", session.id)
      .in("item_id", itemIds);

    const fieldDone = (results ?? []).filter((r) => r.result !== "PENDING" && r.result !== "NA").length;
    const confirmedDone = (results ?? []).filter((r) => r.confirmed_at).length;
    const fieldTotal = mappings.length;

    return { fieldDone, fieldTotal, confirmedDone };
  }

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

        {!selectedSession ? (
          <div className="mt-6 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              監視する点検セッションを選択してください
            </p>
            {loadingSessions ? (
              <p className="mt-3 text-sm text-zinc-500">読み込み中...</p>
            ) : sessions.length === 0 ? (
              <p className="mt-3 text-sm text-zinc-500">実行中の点検セッションがありません。</p>
            ) : (
              <div className="mt-3 flex flex-col gap-3">
                {sessions.map((s) => {
                  const currentTemplate = templates.find((t) => t.id === s.current_checklist_template_id);
                  const progress = sessionProgress[s.id];
                  let currentStepName = "-";
                  if (s.current_item_id && checklistId === s.current_checklist_template_id) {
                    const step = steps.find((st) => st.id === s.current_item_id);
                    if (step) currentStepName = step.name;
                  } else if (s.current_item_id) {
                    currentStepName = "(工程読み込み中)";
                  } else if (s.current_checklist_template_id) {
                    currentStepName = "準備中";
                  }

                  return (
                    <div
                      key={s.id}
                      className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 space-y-2">
                          <div>
                            <p className="font-medium text-zinc-900 dark:text-zinc-100">{s.title}</p>
                            <p className="text-xs text-zinc-500">
                              開始: {new Date(s.session_date).toLocaleTimeString("ja-JP")}
                            </p>
                          </div>

                          {s.current_checklist_template_id && (
                            <div className="pt-1">
                              <p className="text-xs text-zinc-600 dark:text-zinc-400">
                                <span className="font-medium">作業:</span> {currentTemplate?.name ?? "?"}
                              </p>
                              <p className="text-xs text-zinc-600 dark:text-zinc-400">
                                <span className="font-medium">現在工程:</span> {currentStepName}
                              </p>
                              {progress ? (
                                <>
                                  <p className="text-xs text-zinc-600 dark:text-zinc-400">
                                    <span className="font-medium">現場進捗:</span> {progress.fieldDone}/{progress.fieldTotal}
                                  </p>
                                  <p className="text-xs text-zinc-600 dark:text-zinc-400">
                                    <span className="font-medium">確認済み:</span> {progress.confirmedDone}/{progress.fieldTotal}
                                  </p>
                                </>
                              ) : (
                                <>
                                  <p className="text-xs text-zinc-500">読み込み中...</p>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                        <button
                          onClick={() => {
                            setSelectedSessionId(s.id);
                            setChecklistId(null);
                          }}
                          className="whitespace-nowrap rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600 dark:bg-emerald-600"
                        >
                          この点検を監視する
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <>
            {!checklistId ? (
              <div className="mt-6 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  現場側でチェックリストを選択するまでお待ちください...
                </p>
                <p className="mt-3 text-xs text-zinc-500">
                  現在監視中: {selectedSession?.title}
                </p>
                <button
                  onClick={() => {
                    setSelectedSessionId(null);
                    setChecklistId(null);
                  }}
                  className="mt-4 text-sm text-zinc-500 hover:underline"
                >
                  セッションを変更
                </button>
              </div>
            ) : (
              <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_320px]">
                <div className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-xs text-zinc-500">監視中のセッション</p>
                      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                        {selectedSession.title}
                      </p>
                      {checklistName && (
                        <>
                          <p className="mt-1 text-xs text-zinc-500">監視中の作業</p>
                          <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                            {checklistName}
                          </p>
                          <p className="text-sm text-zinc-500">
                            進捗: 現場 {totalDone}/{totalRequired} ・ 確認済み {totalConfirmed}/{totalRequired}
                          </p>
                          {selectedSession.current_item_id && (
                            <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                              現在工程: {steps.find((s) => s.id === selectedSession.current_item_id)?.name ?? "?"}
                            </p>
                          )}
                        </>
                      )}
                    </div>
                    <button
                      onClick={() => {
                        setSelectedSessionId(null);
                        setChecklistId(null);
                      }}
                      className="text-xs text-zinc-500 hover:underline"
                    >
                      セッションを変更
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
                            <th rowSpan={2} className="sticky left-0 bg-white py-2 pr-3 text-left align-bottom dark:bg-zinc-950">
                              バルブ
                            </th>
                            {steps.map((s) => (
                              <th key={s.id} colSpan={isCheckableStep(s.name) ? 3 : 1} className="px-2 py-1 text-center text-xs font-medium text-zinc-500">
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
                                {isCheckableStep(s.name) && (
                                  <>
                                    <th className="px-1 pb-1 text-center text-[10px] font-normal text-zinc-400">
                                      現場
                                    </th>
                                    <th className="px-1 pb-1 text-center text-[10px] font-normal text-zinc-400">
                                      確認
                                    </th>
                                  </>
                                )}
                              </Fragment>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((row) => (
                            <tr key={row.equipmentId} className="border-t border-zinc-100 dark:border-zinc-900">
                              <td className="sticky left-0 bg-white py-2 pr-3 dark:bg-zinc-950">
                                <span className="font-medium text-zinc-900 dark:text-zinc-100">{row.code}</span>
                                <span className="ml-1 block text-xs text-zinc-500">{row.name}</span>
                              </td>
                              {steps.map((s) => {
                                const cell: Cell = row.cells[s.id] ?? {
                                  state: "NA",
                                  target: null,
                                  confirmed: false,
                                };
                                const clickable = cell.state === "OK" || cell.state === "NG";
                                const cellKey = `${row.equipmentId}:${s.id}`;
                                return (
                                  <Fragment key={s.id}>
                                    <td className="px-1 py-2 text-center">
                                      <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${cellClass(row, s)}`}>
                                        {cellLabel(cell)}
                                      </span>
                                    </td>
                                    {isCheckableStep(s.name) && (
                                      <>
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
                                          <button
                                            onClick={() => clickable && toggleConfirm(row, s)}
                                            disabled={!clickable || confirmingId === cellKey}
                                            title={
                                              clickable
                                                ? cell.confirmed
                                                  ? "確認済み（クリックで取り消し）"
                                                  : "クリックで確認"
                                                : undefined
                                            }
                                            className={`text-base ${
                                              cell.confirmed
                                                ? "text-emerald-600 dark:text-emerald-400"
                                                : "text-zinc-300 dark:text-zinc-700"
                                            } ${clickable ? "cursor-pointer hover:scale-110" : "cursor-default"}`}
                                          >
                                            {cell.confirmed ? "☑" : "☐"}
                                          </button>
                                        </td>
                                      </>
                                    )}
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
                    緑◯/赤☓ = 操作するバルブ(緑=開ける／赤=閉める) ・ グレー = 状態が変わらない確認のみの工程 ・ ✕ NG ・ ／ 対象外。操作済みのマスをクリックすると確認済みになります（枠線がつきます）。もう一度クリックすると取り消せます。
                  </p>
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
          </>
        )}
      </div>
    </main>
  );
}
