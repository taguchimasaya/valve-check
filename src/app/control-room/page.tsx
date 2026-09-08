"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Rnd } from "react-rnd";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { getActiveSessions, type InspectionSession } from "@/lib/inspectionSession";
import {
  isStepCompleteAudioEnabled,
  isValveActionAudioEnabled,
  speak,
} from "@/lib/audioSettings";
import { classifyAction, stepCompleteMessage, stepStartMessage, valveActionMessage } from "@/lib/valveAction";

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
type SessionProgress = { fieldDone: number; fieldTotal: number; confirmedDone: number };

// 1セッション分のグリッド・通知state。ControlRoomPageではsession.id単位のRecordとして保持する。
type SessionGridState = {
  checklistId: string | null;
  checklistName: string;
  steps: StepInfo[];
  rows: ValveRow[];
  notifications: Notification[];
  loading: boolean;
};

const EMPTY_GRID_STATE: SessionGridState = {
  checklistId: null,
  checklistName: "",
  steps: [],
  rows: [],
  notifications: [],
  loading: true,
};

// モニター（監視ウィンドウ）1件分の画面上の配置情報。session.id単位でlocalStorageに永続化する。
type MonitorLayout = {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  maximized?: boolean;
};

const LAYOUT_STORAGE_KEY = "control-room-layout-v1";
const DEFAULT_MONITOR_WIDTH = 480;
const DEFAULT_MONITOR_HEIGHT = 420;
const MIN_MONITOR_WIDTH = 320;
const MIN_MONITOR_HEIGHT = 220;

function loadLayoutMap(): Record<string, MonitorLayout> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Record<string, MonitorLayout>;
  } catch {
    // 壊れたデータは無視して空から始める
  }
  return {};
}

function saveLayoutMap(map: Record<string, MonitorLayout>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // localStorageが使えない環境では配置保存を諦める（機能自体は動作継続）
  }
}

// 既存モニターとなるべく重ならない初期位置を、簡易的なグリッド割付けで計算する。
// containerWidthを超えたら折り返す。画面外に完全に出ないよう、折り返し前提で計算する。
function computeInitialLayout(index: number, containerWidth: number): MonitorLayout {
  const margin = 24;
  const cols = Math.max(1, Math.floor((containerWidth - margin) / (DEFAULT_MONITOR_WIDTH + margin)));
  const col = index % cols;
  const row = Math.floor(index / cols);
  return {
    x: margin + col * (DEFAULT_MONITOR_WIDTH + margin),
    y: margin + row * (DEFAULT_MONITOR_HEIGHT + margin),
    width: DEFAULT_MONITOR_WIDTH,
    height: DEFAULT_MONITOR_HEIGHT,
    visible: true,
  };
}

const UNCHECKED_STEP_NAMES = new Set(["作業前"]);
function isCheckableStep(name: string) {
  return !UNCHECKED_STEP_NAMES.has(name);
}

// 行の必須工程を工程順に並べたもの（作業前を含む＝状態比較の起点になる）
function requiredSequence(steps: StepInfo[], row: ValveRow) {
  return steps
    .filter((s) => row.cells[s.id]?.target)
    .map((s) => ({ itemId: s.id, itemNo: s.itemNo, target: row.cells[s.id]!.target! }));
}
function isOperateStep(steps: StepInfo[], row: ValveRow, step: StepInfo): boolean {
  const action = classifyAction(requiredSequence(steps, row), step.id);
  return action ? action.endsWith("-operate") : true;
}
function cellLabel(cell: Cell): string {
  if (cell.state === "NA") return "／";
  if (cell.state === "NG") return "✕";
  return cell.target === "close" ? "☓" : "◯";
}
function cellClass(steps: StepInfo[], row: ValveRow, step: StepInfo): string {
  const cell: Cell = row.cells[step.id] ?? { state: "NA", target: null, confirmed: false };
  if (cell.state === "NA") return "text-zinc-300 dark:text-zinc-700";
  if (cell.state === "NG") {
    return "bg-red-600 text-white ring-2 ring-red-900 dark:ring-red-400";
  }
  if (!isCheckableStep(step.name) || !isOperateStep(steps, row, step)) {
    return "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400";
  }
  const isOpen = cell.target !== "close";
  return isOpen
    ? "bg-emerald-500 text-white dark:bg-emerald-600"
    : "bg-red-500 text-white dark:bg-red-600";
}

// 進捗計算ロジックは既存のまま変更しない
async function getSessionProgress(session: InspectionSession): Promise<SessionProgress> {
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

export default function ControlRoomPage() {
  const [sessions, setSessions] = useState<InspectionSession[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [sessionGridStates, setSessionGridStates] = useState<Record<string, SessionGridState>>({});
  const [sessionProgress, setSessionProgress] = useState<Record<string, SessionProgress | null>>({});
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [layoutMap, setLayoutMap] = useState<Record<string, MonitorLayout>>({});
  const [layoutLoaded, setLayoutLoaded] = useState(false);

  const desktopRef = useRef<HTMLDivElement>(null);
  const [desktopSize, setDesktopSize] = useState({ width: 1400, height: 800 });

  // デスクトップ領域のサイズをリサイズ追従させる（全画面表示モニターのサイズ計算に使う）
  useEffect(() => {
    const el = desktopRef.current;
    if (!el) return;
    const update = () => setDesktopSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Stale closure 対策：Realtimeコールバックは常にrefから最新値を読む
  const sessionsRef = useRef<InspectionSession[]>([]);
  const rowsRef = useRef<Record<string, ValveRow[]>>({});
  const stepsRef = useRef<Record<string, StepInfo[]>>({});
  const playedEventsRef = useRef<Set<string>>(new Set());
  // session.id -> このsessionのために張っているRealtime channel群
  const channelsRef = useRef<Record<string, RealtimeChannel[]>>({});
  const layoutMapRef = useRef<Record<string, MonitorLayout>>({});

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  // 初回マウント時にlocalStorageから配置を復元する
  useEffect(() => {
    const map = loadLayoutMap();
    layoutMapRef.current = map;
    setLayoutMap(map);
    setLayoutLoaded(true);
  }, []);

  const loadSessions = useCallback(async () => {
    setLoadingSessions(true);
    const data = await getActiveSessions();
    setSessions(data);
    setLoadingSessions(false);
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  // 現在アクティブな全セッションの進捗をまとめて再計算する（既存ロジック：sessions変化時にフル再計算）
  useEffect(() => {
    if (sessions.length === 0) {
      setSessionProgress({});
      return;
    }
    let cancelled = false;
    const loadAllProgress = async () => {
      const progress: Record<string, SessionProgress | null> = {};
      for (const session of sessions) {
        progress[session.id] = await getSessionProgress(session);
      }
      if (!cancelled) setSessionProgress(progress);
    };
    loadAllProgress();
    return () => {
      cancelled = true;
    };
  }, [sessions]);

  // 特定の1セッションだけ進捗を再取得する（Realtimeイベント発生時用。他セッションのstateには触れない）
  const refreshSessionProgress = useCallback((sessionId: string) => {
    const session = sessionsRef.current.find((s) => s.id === sessionId);
    if (!session) return;
    getSessionProgress(session).then((progress) => {
      setSessionProgress((prev) => ({ ...prev, [sessionId]: progress }));
    });
  }, []);

  // 指定したsessionId・checklistTemplateIdだけを対象にグリッドを再構築する。
  // state引数ではなくsessionId/checklistTemplateIdを直接受け取ることでstale closureを避ける。
  const loadGrid = useCallback(async (sessionId: string, checklistTemplateId: string | null) => {
    if (!checklistTemplateId) {
      stepsRef.current[sessionId] = [];
      rowsRef.current[sessionId] = [];
      setSessionGridStates((prev) => ({
        ...prev,
        [sessionId]: {
          checklistId: null,
          checklistName: "",
          steps: [],
          rows: [],
          notifications: prev[sessionId]?.notifications ?? [],
          loading: false,
        },
      }));
      return;
    }

    setSessionGridStates((prev) => ({
      ...prev,
      [sessionId]: { ...(prev[sessionId] ?? EMPTY_GRID_STATE), loading: true },
    }));

    const { data: template } = await supabase
      .from("checklist_templates")
      .select("name")
      .eq("id", checklistTemplateId)
      .single();
    const checklistName = template?.name ?? "";

    const { data: items } = await supabase
      .from("checklist_items")
      .select("id, item_no, item_name")
      .eq("template_id", checklistTemplateId)
      .order("item_no", { ascending: true });

    const stepList: StepInfo[] = (items ?? []).map((i) => ({
      id: i.id,
      itemNo: i.item_no,
      name: i.item_name,
    }));
    stepsRef.current[sessionId] = stepList;
    const itemIds = stepList.map((s) => s.id);

    if (itemIds.length === 0) {
      rowsRef.current[sessionId] = [];
      setSessionGridStates((prev) => ({
        ...prev,
        [sessionId]: {
          checklistId: checklistTemplateId,
          checklistName,
          steps: stepList,
          rows: [],
          notifications: prev[sessionId]?.notifications ?? [],
          loading: false,
        },
      }));
      return;
    }

    const { data: mappings } = await supabase
      .from("checklist_item_equipment")
      .select("item_id, equipment_id, target_state, equipment(code, name)")
      .in("item_id", itemIds);

    const { data: results } = await supabase
      .from("inspection_results")
      .select("equipment_id, item_id, result, confirmed_at")
      .eq("session_id", sessionId)
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

    const rows = Array.from(rowMap.values()).sort((a, b) => a.code.localeCompare(b.code));
    rowsRef.current[sessionId] = rows;

    setSessionGridStates((prev) => ({
      ...prev,
      [sessionId]: {
        checklistId: checklistTemplateId,
        checklistName,
        steps: stepList,
        rows,
        notifications: prev[sessionId]?.notifications ?? [],
        loading: false,
      },
    }));
  }, []);

  const loadNotifications = useCallback(async (sessionId: string, checklistTemplateId: string | null) => {
    if (!checklistTemplateId) return;
    const { data } = await supabase
      .from("step_notifications")
      .select("id, item_id, item_name, notified_at")
      .eq("session_id", sessionId)
      .eq("template_id", checklistTemplateId)
      .order("notified_at", { ascending: false });
    setSessionGridStates((prev) => ({
      ...prev,
      [sessionId]: { ...(prev[sessionId] ?? EMPTY_GRID_STATE), notifications: data ?? [] },
    }));
  }, []);

  // 指定セッション専用のRealtime channel（inspection_sessions UPDATE / 各種通知）を作成する。
  // 内部で参照するのはstableな ref / setState / useCallback([]) 済み関数のみのため、
  // クロージャが古いレンダーの値を保持し続けることはない。
  const createChannelsForSession = useCallback(
    (session: InspectionSession): RealtimeChannel[] => {
      const sessionChannel = supabase
        .channel(`session-${session.id}`)
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "inspection_sessions", filter: `id=eq.${session.id}` },
          (payload) => {
            const updated = payload.new as {
              current_checklist_template_id?: string | null;
              current_item_id?: string | null;
              status?: string;
            };

            if (updated.status && updated.status !== "in_progress") {
              setSessions((prev) => prev.filter((s) => s.id !== session.id));
              return;
            }

            setSessions((prev) =>
              prev.map((s) =>
                s.id === session.id
                  ? {
                      ...s,
                      current_item_id:
                        updated.current_item_id !== undefined ? updated.current_item_id : s.current_item_id,
                      current_checklist_template_id:
                        updated.current_checklist_template_id !== undefined
                          ? updated.current_checklist_template_id
                          : s.current_checklist_template_id,
                    }
                  : s
              )
            );

            if (updated.current_checklist_template_id !== undefined) {
              const nextChecklistId = updated.current_checklist_template_id ?? null;
              loadGrid(session.id, nextChecklistId);
              loadNotifications(session.id, nextChecklistId);
            }
          }
        )
        .subscribe();

      const dataChannel = supabase
        .channel(`control-room-data-${session.id}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "inspection_results", filter: `session_id=eq.${session.id}` },
          (payload) => {
            const changed = payload.new as { equipment_id?: string; item_id?: string; result?: string };
            // 開閉音声は「現場が新しく記録した瞬間」だけに鳴らす。制御室の確認操作（confirmed_atの更新）は
            // resultを変えずにUPDATEイベントを発生させるため、eventTypeで見分けないと、
            // 制御室を閉じている間に現場が記録 → 後で開いて確認、という操作のタイミングで
            // UPDATEイベントとして音声が誤って鳴ってしまう。
            if (
              payload.eventType === "INSERT" &&
              changed.result === "OK" &&
              changed.equipment_id &&
              changed.item_id &&
              isValveActionAudioEnabled()
            ) {
              const eventId = `valve-${session.id}-${changed.equipment_id}-${changed.item_id}`;
              const rows = rowsRef.current[session.id] ?? [];
              const steps = stepsRef.current[session.id] ?? [];
              const row = rows.find((r) => r.equipmentId === changed.equipment_id);
              const step = steps.find((s) => s.id === changed.item_id);
              if (row && step && !playedEventsRef.current.has(eventId)) {
                playedEventsRef.current.add(eventId);
                const sequence = requiredSequence(steps, row);
                const action = classifyAction(sequence, step.id);
                if (action) speak(valveActionMessage(row.code, action));
              }
            }
            const currentChecklistId =
              sessionsRef.current.find((s) => s.id === session.id)?.current_checklist_template_id ?? null;
            loadGrid(session.id, currentChecklistId);
            refreshSessionProgress(session.id);
          }
        )
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "step_notifications", filter: `session_id=eq.${session.id}` },
          (payload) => {
            const created = payload.new as {
              id?: string;
              item_name?: string;
              template_name?: string;
              session_id?: string;
            };
            const eventId = `complete-${session.id}-${created.id}`;
            if (
              created.item_name &&
              created.template_name &&
              isStepCompleteAudioEnabled() &&
              !playedEventsRef.current.has(eventId)
            ) {
              playedEventsRef.current.add(eventId);
              speak(stepCompleteMessage(created.template_name, created.item_name));
            }
            const currentChecklistId =
              sessionsRef.current.find((s) => s.id === session.id)?.current_checklist_template_id ?? null;
            loadNotifications(session.id, currentChecklistId);
          }
        )
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "step_start_notifications", filter: `session_id=eq.${session.id}` },
          (payload) => {
            const created = payload.new as {
              id?: string;
              item_name?: string;
              template_name?: string;
              session_id?: string;
            };
            const eventId = `start-${session.id}-${created.id}`;
            if (
              created.item_name &&
              created.template_name &&
              isStepCompleteAudioEnabled() &&
              !playedEventsRef.current.has(eventId)
            ) {
              playedEventsRef.current.add(eventId);
              speak(stepStartMessage(created.template_name, created.item_name));
            }
            const currentChecklistId =
              sessionsRef.current.find((s) => s.id === session.id)?.current_checklist_template_id ?? null;
            loadNotifications(session.id, currentChecklistId);
          }
        )
        .subscribe();

      return [sessionChannel, dataChannel];
    },
    [loadGrid, loadNotifications, refreshSessionProgress]
  );

  // sessionIdに対応するlayoutが無ければ、衝突を避けた初期位置で新規追加する
  const ensureLayout = useCallback((sessionId: string) => {
    if (layoutMapRef.current[sessionId]) return;
    const containerWidth = desktopRef.current?.clientWidth || 1400;
    const index = Object.keys(layoutMapRef.current).length;
    const next = { ...layoutMapRef.current, [sessionId]: computeInitialLayout(index, containerWidth) };
    layoutMapRef.current = next;
    setLayoutMap(next);
    saveLayoutMap(next);
  }, []);

  const updateLayout = useCallback((sessionId: string, patch: Partial<MonitorLayout>) => {
    const current = layoutMapRef.current[sessionId];
    if (!current) return;
    const next = { ...layoutMapRef.current, [sessionId]: { ...current, ...patch } };
    layoutMapRef.current = next;
    setLayoutMap(next);
    saveLayoutMap(next);
  }, []);

  // sessions配列に現れた/消えたIDだけを見て、Realtime channelとgrid stateを追加・cleanupする。
  // 依存配列はID集合の文字列表現のみなので、同じセッション群のままレンダーが起きても再実行されない。
  const sessionIdsKey = sessions.map((s) => s.id).sort().join(",");
  useEffect(() => {
    if (!layoutLoaded) return;
    const currentIds = new Set(sessions.map((s) => s.id));

    Object.keys(channelsRef.current).forEach((id) => {
      if (!currentIds.has(id)) {
        channelsRef.current[id].forEach((ch) => supabase.removeChannel(ch));
        delete channelsRef.current[id];
        delete rowsRef.current[id];
        delete stepsRef.current[id];
        setSessionGridStates((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
        // レイアウトは「点検終了」時のみ削除する（一時非表示とは区別する）
        if (layoutMapRef.current[id]) {
          const nextLayout = { ...layoutMapRef.current };
          delete nextLayout[id];
          layoutMapRef.current = nextLayout;
          setLayoutMap(nextLayout);
          saveLayoutMap(nextLayout);
        }
      }
    });

    sessions.forEach((session) => {
      if (!channelsRef.current[session.id]) {
        channelsRef.current[session.id] = createChannelsForSession(session);
        loadGrid(session.id, session.current_checklist_template_id);
        loadNotifications(session.id, session.current_checklist_template_id);
      }
      ensureLayout(session.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionIdsKey, layoutLoaded]);

  // コンポーネントunmount時に残っている全channelを確実にcleanupする
  useEffect(() => {
    return () => {
      Object.values(channelsRef.current).forEach((chs) => chs.forEach((ch) => supabase.removeChannel(ch)));
      channelsRef.current = {};
    };
  }, []);

  // 新規セッションの発生を検知するグローバルchannel（session_idでフィルタしようがないため全体購読）
  useEffect(() => {
    const newSessionChannel = supabase
      .channel("inspection-sessions-new")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "inspection_sessions" },
        (payload) => {
          const newSession = payload.new as InspectionSession;
          if (newSession.status !== "in_progress") return;
          setSessions((prev) => {
            if (prev.some((s) => s.id === newSession.id)) return prev;
            return [newSession, ...prev];
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(newSessionChannel);
    };
  }, []);

  // 現場で作業（チェックリスト）が選択/変更されたことを検知するグローバルchannel。
  // 新規セッションの初出現も、既存セッションの作業変更も、両方ここで拾う。
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

          if (!updatedSession || updatedSession.status !== "in_progress") return;

          const alreadyTracked = sessionsRef.current.some((s) => s.id === created.session_id);
          setSessions((prev) => {
            const exists = prev.some((s) => s.id === created.session_id);
            if (exists) {
              return prev.map((s) => (s.id === created.session_id ? updatedSession : s));
            }
            return [updatedSession, ...prev];
          });

          // 既に監視中セッションの「作業変更」の場合は、そのセッションのgrid/通知だけを明示的に再取得する
          // （新規セッションはID一覧変化を検知するeffect側でloadGridされる）
          if (alreadyTracked) {
            loadGrid(created.session_id, updatedSession.current_checklist_template_id ?? null);
            loadNotifications(created.session_id, updatedSession.current_checklist_template_id ?? null);
          }

          if (isValveActionAudioEnabled()) {
            const eventId = `inspection_start-${created.session_id}-${created.template_id}`;
            if (!playedEventsRef.current.has(eventId) && created.template_name) {
              playedEventsRef.current.add(eventId);
              speak(`${created.template_name} 点検開始しました`);
            }
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(globalStartChannel);
    };
  }, [loadGrid, loadNotifications]);

  async function toggleConfirm(session: InspectionSession, row: ValveRow, step: StepInfo) {
    const cell = row.cells[step.id];
    if (!cell || (cell.state !== "OK" && cell.state !== "NG")) return;

    const cellKey = `${session.id}:${row.equipmentId}:${step.id}`;
    setConfirmingId(cellKey);

    await supabase
      .from("inspection_results")
      .update({
        confirmed_at: cell.confirmed ? null : new Date().toISOString(),
        confirmed_by: cell.confirmed ? null : "制御室",
      })
      .eq("session_id", session.id)
      .eq("equipment_id", row.equipmentId)
      .eq("item_id", step.id);

    setConfirmingId(null);
    const currentChecklistId =
      sessionsRef.current.find((s) => s.id === session.id)?.current_checklist_template_id ??
      session.current_checklist_template_id;
    await loadGrid(session.id, currentChecklistId);
    refreshSessionProgress(session.id);
  }

  function closeMonitor(sessionId: string) {
    updateLayout(sessionId, { visible: false });
  }

  function reopenMonitor(sessionId: string) {
    updateLayout(sessionId, { visible: true });
  }

  function resetLayout() {
    const containerWidth = desktopRef.current?.clientWidth || 1400;
    const next: Record<string, MonitorLayout> = {};
    sessions.forEach((session, index) => {
      next[session.id] = computeInitialLayout(index, containerWidth);
    });
    layoutMapRef.current = next;
    setLayoutMap(next);
    saveLayoutMap(next);
  }

  // 表示中の全モニターを縦方向（上下）に画面いっぱいへ均等分割配置する。
  // バルブ数が少ない点検を並べて常時監視したい場合向けのモード。
  function tileLayoutVertically() {
    const containerWidth = desktopRef.current?.clientWidth || desktopSize.width;
    const containerHeight = desktopRef.current?.clientHeight || desktopSize.height;
    const visibleSessions = sessions.filter((s) => layoutMap[s.id]?.visible !== false);
    if (visibleSessions.length === 0) return;
    const margin = 8;
    const n = visibleSessions.length;
    const height = Math.max(
      MIN_MONITOR_HEIGHT,
      Math.floor((containerHeight - margin * (n + 1)) / n)
    );
    const next = { ...layoutMapRef.current };
    visibleSessions.forEach((session, index) => {
      next[session.id] = {
        ...(next[session.id] ?? { visible: true }),
        x: margin,
        y: margin + index * (height + margin),
        width: containerWidth - margin * 2,
        height,
        visible: true,
        maximized: false,
      };
    });
    layoutMapRef.current = next;
    setLayoutMap(next);
    saveLayoutMap(next);
  }

  // 1モニターだけをデスクトップ全体に広げる/元のサイズへ戻す
  function toggleMaximize(sessionId: string) {
    const current = layoutMapRef.current[sessionId];
    if (!current) return;
    updateLayout(sessionId, { maximized: !current.maximized });
  }

  // ブラウザ全体をFullscreen APIで全画面表示にする（制御室PCでアドレスバー等を隠す用途）
  function toggleBrowserFullscreen() {
    if (typeof document === "undefined") return;
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }

  const hiddenSessions = sessions.filter((s) => layoutMap[s.id] && layoutMap[s.id].visible === false);
  const anyMaximized = Object.values(layoutMap).some((l) => l.maximized);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-100 dark:bg-black">
      {/* 上部ツールバー：固定高さ、ここだけは通常のページ要素 */}
      <div className="flex-none border-b border-zinc-200 bg-white px-6 py-3 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center justify-between">
          <div>
            <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400">
              ← ホームに戻る
            </Link>
            <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
              点検ダッシュボード（制御室）
            </h1>
          </div>
          <div className="flex items-center gap-3">
            {hiddenSessions.length > 0 && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-zinc-500">非表示中:</span>
                {hiddenSessions.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => reopenMonitor(s.id)}
                    className="rounded-full border border-zinc-300 px-3 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    {sessionGridStates[s.id]?.checklistName || s.title} を表示
                  </button>
                ))}
              </div>
            )}
            {sessions.length > 1 && !anyMaximized && (
              <button
                onClick={tileLayoutVertically}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                title="バルブ数の少ない点検を並べて常時監視したい場合に使用します"
              >
                上下に並べる
              </button>
            )}
            <button
              onClick={resetLayout}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              配置リセット
            </button>
            <button
              onClick={toggleBrowserFullscreen}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              title="ブラウザ全体を全画面表示にします（制御室PC向け）"
            >
              全画面表示
            </button>
            <Link href="/settings" className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400">
              音声設定 ⚙
            </Link>
          </div>
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          {loadingSessions
            ? "読み込み中..."
            : sessions.length === 0
            ? "実行中の点検セッションがありません。"
            : `${sessions.length}件の点検が実行中です`}
        </p>
      </div>

      {/* デスクトップ領域：ページ自体はスクロールしない。各モニター内部だけがスクロールする。 */}
      <div ref={desktopRef} className="relative flex-1 overflow-hidden">
        {layoutLoaded &&
          sessions.map((session) => {
            const layout = layoutMap[session.id];
            if (!layout || layout.visible === false) return null;
            // 他のモニターが最大化されている間は、それ以外を隠す
            if (anyMaximized && !layout.maximized) return null;
            const isMaximized = !!layout.maximized;
            return (
              <Rnd
                key={session.id}
                size={isMaximized ? { width: desktopSize.width, height: desktopSize.height } : { width: layout.width, height: layout.height }}
                position={isMaximized ? { x: 0, y: 0 } : { x: layout.x, y: layout.y }}
                minWidth={MIN_MONITOR_WIDTH}
                minHeight={MIN_MONITOR_HEIGHT}
                bounds="parent"
                dragHandleClassName="monitor-drag-handle"
                cancel=".monitor-no-drag"
                disableDragging={isMaximized}
                enableResizing={!isMaximized}
                onDragStop={(_e, d) => updateLayout(session.id, { x: d.x, y: d.y })}
                onResizeStop={(_e, _dir, ref, _delta, position) =>
                  updateLayout(session.id, {
                    width: parseInt(ref.style.width, 10),
                    height: parseInt(ref.style.height, 10),
                    x: position.x,
                    y: position.y,
                  })
                }
                className={isMaximized ? "z-20" : "z-0"}
              >
                <SessionMonitor
                  session={session}
                  gridState={sessionGridStates[session.id] ?? EMPTY_GRID_STATE}
                  progress={sessionProgress[session.id] ?? null}
                  confirmingId={confirmingId}
                  isMaximized={isMaximized}
                  onToggleConfirm={(row, step) => toggleConfirm(session, row, step)}
                  onClose={() => closeMonitor(session.id)}
                  onToggleMaximize={() => toggleMaximize(session.id)}
                />
              </Rnd>
            );
          })}
      </div>
    </div>
  );
}

function SessionMonitor({
  session,
  gridState,
  progress,
  confirmingId,
  isMaximized,
  onToggleConfirm,
  onClose,
  onToggleMaximize,
}: {
  session: InspectionSession;
  gridState: SessionGridState;
  progress: SessionProgress | null;
  confirmingId: string | null;
  isMaximized: boolean;
  onToggleConfirm: (row: ValveRow, step: StepInfo) => void;
  onClose: () => void;
  onToggleMaximize: () => void;
}) {
  const { steps, rows, notifications, loading, checklistName } = gridState;
  const hasChecklist = !!session.current_checklist_template_id;
  const currentStepName = session.current_item_id
    ? steps.find((s) => s.id === session.current_item_id)?.name ?? "…"
    : null;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      {/* ドラッグ領域：タイトルバー。ここをつまんでモニターを移動する */}
      <div className="monitor-drag-handle flex flex-none cursor-move items-center justify-between border-b border-zinc-200 bg-zinc-50 px-3 py-1.5 dark:border-zinc-800 dark:bg-zinc-900">
        <span className="flex items-center gap-2 text-xs text-zinc-400">
          <span aria-hidden>≡</span>
          <span className="truncate">{checklistName || session.title}</span>
        </span>
        <span className="flex items-center gap-1">
          <button
            onClick={onToggleMaximize}
            className="monitor-no-drag rounded px-1.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
            title={isMaximized ? "元のサイズに戻す" : "このモニターを全画面表示にする"}
          >
            {isMaximized ? "⤢" : "⛶"}
          </button>
          {!isMaximized && (
            <button
              onClick={onClose}
              className="monitor-no-drag rounded px-1.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
              title="このモニターを非表示にする（点検は継続します）"
            >
              ×
            </button>
          )}
        </span>
      </div>

      {/* 固定ヘッダー：作業名を最も大きく、点検タイトルを補助情報として表示 */}
      <div className="monitor-no-drag flex-none border-b border-zinc-100 px-4 py-3 dark:border-zinc-900">
        {hasChecklist ? (
          <p className="truncate text-lg font-bold text-zinc-900 dark:text-zinc-50">
            {checklistName || "（読み込み中）"}
          </p>
        ) : (
          <p className="text-lg font-bold text-amber-600 dark:text-amber-400">作業名：選択待ち</p>
        )}
        <p className="truncate text-xs text-zinc-500">点検：{session.title}</p>

        {hasChecklist ? (
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-zinc-600 dark:text-zinc-400">
            <p>
              <span className="font-medium">現在工程：</span>
              {currentStepName ?? "-"}
            </p>
            <p>
              <span className="font-medium">現場：</span>
              {progress ? `${progress.fieldDone} / ${progress.fieldTotal}` : "…"}
            </p>
            <p>
              <span className="font-medium">確認済み：</span>
              {progress ? `${progress.confirmedDone} / ${progress.fieldTotal}` : "…"}
            </p>
          </div>
        ) : (
          <p className="mt-1.5 text-xs text-zinc-500">現在：現場側で作業を選択しています</p>
        )}
      </div>

      {/* 本文：ここだけが内部スクロール対象（縦・横とも）。150バルブ規模でもモニター外へは影響しない */}
      <div className="monitor-no-drag flex-1 overflow-auto px-4 py-3">
        {hasChecklist && (
          <>
            {loading ? (
              <p className="text-sm text-zinc-500">読み込み中...</p>
            ) : rows.length === 0 ? (
              <p className="text-sm text-zinc-500">対象バルブがありません。</p>
            ) : (
              <table className="w-full min-w-[560px] border-collapse text-sm">
                <thead>
                  <tr>
                    <th
                      rowSpan={2}
                      className="sticky left-0 top-0 z-10 bg-white py-2 pr-3 text-left align-bottom dark:bg-zinc-950"
                    >
                      バルブ
                    </th>
                    {steps.map((s) => (
                      <th
                        key={s.id}
                        colSpan={isCheckableStep(s.name) ? 3 : 1}
                        className="sticky top-0 z-[5] bg-white px-2 py-1 text-center text-xs font-medium text-zinc-500 dark:bg-zinc-950"
                      >
                        {s.name}
                      </th>
                    ))}
                  </tr>
                  <tr>
                    {steps.map((s) => (
                      <Fragment key={s.id}>
                        <th className="sticky top-[26px] z-[5] bg-white px-1 pb-1 text-center text-[10px] font-normal text-zinc-400 dark:bg-zinc-950">
                          状態
                        </th>
                        {isCheckableStep(s.name) && (
                          <>
                            <th className="sticky top-[26px] z-[5] bg-white px-1 pb-1 text-center text-[10px] font-normal text-zinc-400 dark:bg-zinc-950">
                              現場
                            </th>
                            <th className="sticky top-[26px] z-[5] bg-white px-1 pb-1 text-center text-[10px] font-normal text-zinc-400 dark:bg-zinc-950">
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
                        const cellKey = `${session.id}:${row.equipmentId}:${s.id}`;
                        return (
                          <Fragment key={s.id}>
                            <td className="px-1 py-2 text-center">
                              <span
                                className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${cellClass(
                                  steps,
                                  row,
                                  s
                                )}`}
                              >
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
                                    onClick={() => clickable && onToggleConfirm(row, s)}
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
            )}

            <div className="mt-4 border-t border-zinc-100 pt-3 dark:border-zinc-900">
              <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">工程完了通知</p>
              {notifications.length === 0 ? (
                <p className="mt-2 text-sm text-zinc-500">まだ通知はありません。</p>
              ) : (
                <ul className="mt-2 flex flex-col gap-2">
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
          </>
        )}
      </div>
    </div>
  );
}
