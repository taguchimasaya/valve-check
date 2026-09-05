"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import {
  ensureActiveSession,
  startNewSession,
  getActiveSessions,
  setCurrentStep,
  type InspectionSession,
} from "@/lib/inspectionSession";
import {
  clearActiveChecklist,
  getActiveChecklist,
  setActiveChecklist,
  type ActiveChecklist,
} from "@/lib/activeChecklist";
import { classifyAction, valveActionMessage, stepCompleteMessage, stepStartMessage } from "@/lib/valveAction";
import { speak, isStepCompleteAudioEnabled } from "@/lib/audioSettings";

// OK/NG時の音を再生（Web Audio API）
async function playResultBeep(type: "OK" | "NG") {
  try {
    if (typeof window === "undefined" || !("AudioContext" in window || "webkitAudioContext" in window)) {
      console.warn("AudioContext not available");
      return;
    }

    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();

    // iOS/Android対策：ユーザーインタラクション後のみ再生可能なため、リジューム完了を待つ
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    const now = audioContext.currentTime;

    if (type === "OK") {
      // OK: ピッ（高音、短い）
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.connect(gain);
      gain.connect(audioContext.destination);
      osc.frequency.value = 1200; // 高い音
      osc.type = "sine";
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
      osc.start(now);
      osc.stop(now + 0.15);
    } else {
      // NG: ブブー（低音、複数回）
      const playTone = (startTime: number, duration: number) => {
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        osc.connect(gain);
        gain.connect(audioContext.destination);
        osc.frequency.value = 500; // 低い音
        osc.type = "sine";
        gain.gain.setValueAtTime(0.2, startTime);
        gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
        osc.start(startTime);
        osc.stop(startTime + duration);
      };
      playTone(now, 0.15);
      playTone(now + 0.25, 0.15);
    }
  } catch (err) {
    console.warn("Beep could not be played:", err);
  }
}

type TemplateOption = {
  id: string;
  name: string;
  itemCount: number;
};

type StepInfo = { id: string; itemNo: number; name: string };

type CellState = "NA" | "PENDING" | "OK" | "NG";
type TargetState = "open" | "close";

type Cell = { state: CellState; target: TargetState | null; confirmed: boolean };

type ValveRow = {
  equipmentId: string;
  code: string;
  name: string;
  qrIssuedAt: string | null;
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
  const [sessions, setSessions] = useState<InspectionSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [checklist, setChecklist] = useState<ActiveChecklist | null>(null);

  // 作業選択
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [searchText, setSearchText] = useState("");

  // 選択中の作業（バルブ×工程表）
  const [steps, setSteps] = useState<StepInfo[]>([]);
  const [rows, setRows] = useState<ValveRow[]>([]);
  const [loadingGrid, setLoadingGrid] = useState(false);
  const [qrNotIssuedEquipment, setQrNotIssuedEquipment] = useState<ValveRow[]>([]);
  const [displayMode, setDisplayMode] = useState<"current" | "all">("current");

  const selectedSession = sessions.find((s) => s.id === selectedSessionId);

  // Stale closure 対策：QRコールバック内で常に最新の state を参照する
  const selectedSessionRef = useRef<InspectionSession | undefined>(undefined);
  const rowsRef = useRef<ValveRow[]>([]);
  const stepsRef = useRef<StepInfo[]>([]);
  const checklistRef = useRef<ActiveChecklist | null>(null);

  // スキャナー
  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [flash, setFlash] = useState<FlashMessage | null>(null);
  const scannerRef = useRef<import("html5-qrcode").Html5Qrcode | null>(null);
  const startingRef = useRef(false);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 同一QRの連続検出防止：処理中〜一定時間は再スキャンを無視する
  const scanLockRef = useRef(false);

  // グリッドのマスをタップしたときの確認ポップアップ
  const [tapConfirm, setTapConfirm] = useState<{ row: ValveRow; step: StepInfo } | null>(null);
  const [tapSaving, setTapSaving] = useState(false);
  const [startingNextStep, setStartingNextStep] = useState(false);
  const [sessionCompleted, setSessionCompleted] = useState(false);
  const [sessionProgress, setSessionProgress] = useState<
    Record<string, { currentStepName: string; fieldDone: number; fieldTotal: number; confirmedDone: number } | null>
  >({});

  const loadSessions = useCallback(async () => {
    setLoadingSessions(true);
    const data = await getActiveSessions();
    setSessions(data);
    setLoadingSessions(false);
  }, []);

  useEffect(() => {
    loadSessions();
    const saved = localStorage.getItem("inspectDisplayMode") as "current" | "all" | null;
    if (saved) setDisplayMode(saved);

    // 制御室での更新を反映するため、定期的にグリッドをリロード
    const interval = setInterval(() => {
      loadGrid();
    }, 1000); // 1秒ごと

    return () => {
      stopScanner();
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stale closure 対策：最新の state を ref に同期
  // QRスキャンコールバック内で常に最新の current_item_id を参照できるように
  useEffect(() => {
    selectedSessionRef.current = selectedSession;
  }, [selectedSession]);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    stepsRef.current = steps;
  }, [steps]);

  useEffect(() => {
    checklistRef.current = checklist;
  }, [checklist]);

  // 最後の工程完了を定期的に検出してセッション終了
  useEffect(() => {
    if (sessionCompleted) return; // 既に完了している場合はスキップ

    let completionCheckInterval: ReturnType<typeof setInterval>;

    const startCompletionCheck = async () => {
      completionCheckInterval = setInterval(async () => {
        if (selectedSession && steps.length > 0 && rows.length > 0) {
          const checkableSteps = steps.filter((s) => isCheckableStep(s.name));
          if (checkableSteps.length === 0) return;
          const lastStep = checkableSteps[checkableSteps.length - 1];
          const requiredRows = rows.filter((r) => lastStep.id in r.cells && r.cells[lastStep.id]?.state !== "NA");
          const allComplete = requiredRows.length > 0 && requiredRows.every((r) => r.cells[lastStep.id]?.state !== "PENDING");

          if (allComplete) {
            // セッションを完了状態に更新
            const { error: updateError } = await supabase
              .from("inspection_sessions")
              .update({ status: "completed" })
              .eq("id", selectedSession.id);

            if (updateError) {
              console.error("Failed to update session status:", updateError);
              clearInterval(completionCheckInterval);
              return;
            }

            setSessionCompleted(true);
            clearInterval(completionCheckInterval);
          }
        }
      }, 2000);
    };

    startCompletionCheck();

    return () => {
      clearInterval(completionCheckInterval);
    };
  }, [selectedSession, steps, rows, sessionCompleted]);

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
    if (!checklist || !selectedSession) return;
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
      .select("item_id, equipment_id, target_state")
      .in("item_id", itemIds);

    // equipment の code, name, qr_issued_at を別途取得
    const equipmentIds = (mappings ?? []).map((m) => m.equipment_id);
    const { data: equipmentData } = await supabase
      .from("equipment")
      .select("id, code, name, qr_issued_at")
      .in("id", equipmentIds);
    const equipmentMap = new Map(
      (equipmentData ?? []).map((e) => [e.id, { code: e.code, name: e.name, qrIssuedAt: e.qr_issued_at }])
    );

    const { data: results } = await supabase
      .from("inspection_results")
      .select("equipment_id, item_id, result, confirmed_at")
      .eq("session_id", selectedSession.id)
      .in("item_id", itemIds);

    const resultMap = new Map(
      (results ?? []).map((r) => [`${r.equipment_id}:${r.item_id}`, { state: r.result as CellState, confirmed: !!r.confirmed_at }])
    );

    const rowMap = new Map<string, ValveRow>();
    const notIssuedList: ValveRow[] = [];

    (mappings ?? []).forEach((m) => {
      const eq = equipmentMap.get(m.equipment_id);
      if (!eq) return;
      const row =
        rowMap.get(m.equipment_id) ??
        ({ equipmentId: m.equipment_id, code: eq.code, name: eq.name, qrIssuedAt: eq.qrIssuedAt, cells: {} } as ValveRow);
      const resultData = resultMap.get(`${m.equipment_id}:${m.item_id}`);
      row.cells[m.item_id] = {
        state: resultData?.state ?? "PENDING",
        target: m.target_state === "close" ? "close" : m.target_state === "open" ? "open" : null,
        confirmed: resultData?.confirmed ?? false,
      };
      rowMap.set(m.equipment_id, row);

      // QR未発行を検出
      if (!eq.qrIssuedAt && !notIssuedList.find((r) => r.equipmentId === m.equipment_id)) {
        notIssuedList.push(row);
      }
    });

    const sortedRows = Array.from(rowMap.values()).sort((a, b) => a.code.localeCompare(b.code));
    setRows(sortedRows);
    setQrNotIssuedEquipment(notIssuedList.sort((a, b) => a.code.localeCompare(b.code)));
    setLoadingGrid(false);
  }, [checklist, selectedSession]);

  useEffect(() => {
    loadGrid();
  }, [loadGrid]);

  // 工程が切り替わったときにグリッドを再ロード
  useEffect(() => {
    if (selectedSession?.current_item_id && checklist) {
      loadGrid();
    }
  }, [selectedSession?.current_item_id]);

  function showFlash(msg: FlashMessage) {
    setFlash(msg);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlash(null), 5000);
  }

  async function selectChecklist(t: TemplateOption) {
    if (!selectedSession) return;
    setActiveChecklist({ id: t.id, name: t.name });
    setChecklist({ id: t.id, name: t.name });

    // 最初のチェック可能な工程を取得
    const { data: items } = await supabase
      .from("checklist_items")
      .select("id, item_no, item_name")
      .eq("template_id", t.id)
      .order("item_no", { ascending: true });

    if (!items || items.length === 0) return;

    // 最初のチェック可能な工程を探す（「作業前」をスキップ）
    const firstCheckableItem = items.find((item) => !UNCHECKED_STEP_NAMES.has(item.item_name)) || items[0];

    // セッションの現在工程を設定
    const { error: stepError } = await supabase
      .from("inspection_sessions")
      .update({
        current_checklist_template_id: t.id,
        current_item_id: firstCheckableItem.id,
      })
      .eq("id", selectedSession.id);

    if (!stepError) {
      // Stale closure 対策：useEffectのコミットを待たず、同期的に即座にrefへ反映する。
      // これによりQRスキャンcallbackが直後に発火しても最新のcurrent_item_idを参照できる。
      const updatedSession: InspectionSession = {
        ...selectedSession,
        current_item_id: firstCheckableItem.id,
        current_checklist_template_id: t.id,
      };
      selectedSessionRef.current = updatedSession;

      setSessions((prev) =>
        prev.map((s) => (s.id === selectedSession.id ? updatedSession : s))
      );

      // 制御室に通知を送信
      await supabase
        .from("inspection_start_notifications")
        .insert({ session_id: selectedSession.id, template_id: t.id, template_name: t.name });
    }
  }

  function changeChecklist() {
    stopScanner();
    clearActiveChecklist();
    setChecklist(null);
    setSteps([]);
    setRows([]);
  }

  // QRコード（または手入力）を読み取ったバルブの「現在工程」を記録する。
  // QRスキャン時は常に inspection_sessions.current_item_id を現在工程として使用する。
  // Stale closure 対策：最新の ref を使用して最新の state を参照
  async function handleScan(rawText: string) {
    // 同一QRの連続検出防止：処理中は無視する
    // （html5-qrcodeはfps設定に応じて視界内のQRを連続検出し続けるため、
    // 　1回目の記録処理が完了する前に2回目の検出が発生し、
    // 　「既に記録済み」判定になってビープ音が鳴らないケースがあった）
    if (scanLockRef.current) return;

    // 常に最新の state を参照するため、ref から取得
    const currentSession = selectedSessionRef.current;
    const currentRows = rowsRef.current;
    const currentSteps = stepsRef.current;
    const currentChecklist = checklistRef.current;

    if (!currentSession || !currentChecklist) return;
    const marker = "/inspect/";
    const trimmed = rawText.trim();
    const idx = trimmed.indexOf(marker);
    const code = (idx >= 0 ? trimmed.slice(idx + marker.length) : trimmed).trim();
    if (!code) return;

    const row = currentRows.find((r) => r.code === code);
    if (!row) {
      showFlash({
        type: "error",
        text: `${code} は選択中の作業「${currentChecklist.name}」には含まれていません。`,
      });
      return;
    }

    // 現在工程で対象か確認（安全チェック）
    // 常に inspection_sessions.current_item_id を使用
    const currentStepId = currentSession.current_item_id;
    if (!currentStepId) {
      showFlash({
        type: "error",
        text: "現在工程が確定していません。画面を再度読み込んでください。",
      });
      return;
    }

    const currentStepCell = row.cells[currentStepId];
    if (!currentStepCell) {
      const currentStep = currentSteps.find((s) => s.id === currentStepId);
      showFlash({
        type: "error",
        text: `${code}（${row.name}）は現在の工程「${currentStep?.name ?? "不明"}」の対象ではありません。`,
      });
      return;
    }

    // 既にOK で完了済みか確認
    if (currentStepCell.state === "OK") {
      showFlash({
        type: "info",
        text: `${code}（${row.name}）は現在の工程で既に記録済みです。`,
      });
      return;
    }

    // 現在工程に対応する StepInfo を取得
    const currentStep = currentSteps.find((s) => s.id === currentStepId);
    if (!currentStep) {
      showFlash({
        type: "error",
        text: "現在工程が見つかりません。画面を再度読み込んでください。",
      });
      return;
    }

    // QRスキャン時は常に現在工程を記録する（結果音のみ、読み上げ音声はなし）
    // 記録処理中〜完了後しばらくは同一QRの再検出をロックし、ビープ音の再生を妨げないようにする
    scanLockRef.current = true;
    try {
      await completeStep(row, currentStep);
    } finally {
      setTimeout(() => {
        scanLockRef.current = false;
      }, 1500);
    }
  }

  // タップ確認ポップアップ、またはQR/手入力の記録先から呼ばれる、実際の記録処理。
  // Stale closure 対策：state を直接参照せず、常に ref から最新値を取得する
  async function completeStep(row: ValveRow, nextStep: StepInfo, result: "OK" | "NG" = "OK") {
    const currentSession = selectedSessionRef.current;
    const currentChecklist = checklistRef.current;
    const currentSteps = stepsRef.current;

    if (!currentSession || !currentChecklist) return;
    const code = row.code;

    // 結果音を再生（内部でresume完了を待つが、DB保存はブロックしない）
    void playResultBeep(result);

    const { error } = await supabase.from("inspection_results").upsert(
      {
        session_id: currentSession.id,
        equipment_id: row.equipmentId,
        item_id: nextStep.id,
        result: result,
        checked_at: new Date().toISOString(),
      },
      { onConflict: "session_id,equipment_id,item_id" }
    );

    if (error) {
      showFlash({ type: "error", text: `記録に失敗しました: ${error.message}` });
      return;
    }

    // ローカルの表示を即時更新（updater関数で常に最新のprevを使用、かつrefにも同期反映）
    setRows((prev) => {
      const updated = prev.map((r) =>
        r.equipmentId === row.equipmentId
          ? {
              ...r,
              cells: {
                ...r.cells,
                [nextStep.id]: { ...r.cells[nextStep.id], state: result },
              },
            }
          : r
      );
      rowsRef.current = updated;
      return updated;
    });

    // この工程が必要な全バルブが完了したかを確認し、完了していれば制御室へ通知する
    // rowsRef は setRows の直後に即座に同期済みなので最新値を使える
    const currentRows = rowsRef.current;
    const requiredRows = currentRows.filter((r) => nextStep.id in r.cells);
    const allDone = requiredRows.every((r) =>
      r.equipmentId === row.equipmentId ? true : r.cells[nextStep.id]?.state !== "PENDING"
    );

    const requiredSequence = currentSteps
      .filter((s) => row.cells[s.id]?.target)
      .map((s) => ({ itemId: s.id, itemNo: s.itemNo, target: row.cells[s.id]!.target! }));
    const action = classifyAction(requiredSequence, nextStep.id);
    const actionText = action ? valveActionMessage(code, action) : `${code}を記録しました`;

    if (allDone) {
      const { error: notifyError } = await supabase.from("step_notifications").upsert(
        {
          session_id: currentSession.id,
          item_id: nextStep.id,
          item_name: nextStep.name,
          template_id: currentChecklist.id,
          template_name: currentChecklist.name,
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
    if (!selectedSession || !selectedSession.current_item_id) return;
    const currentStep = steps.find((s) => s.id === selectedSession.current_item_id);
    if (!currentStep) return;
    const cell = row.cells[currentStep.id];
    if (!cell || cell.state !== "PENDING") {
      showFlash({ type: "info", text: `${row.code}（${row.name}）は既に操作済みです。` });
      return;
    }
    setTapConfirm({ row, step: currentStep });
  }

  async function confirmTap() {
    if (!tapConfirm) return;
    setTapSaving(true);
    // 結果音（ピッ/ブブー）のみ。読み上げ音声はなし
    await completeStep(tapConfirm.row, tapConfirm.step);
    setTapSaving(false);
    setTapConfirm(null);
  }

  // 現在工程のインデックスを取得
  function getCurrentStepIndex(): number {
    if (!selectedSession || !steps) return -1;
    return steps.findIndex((s) => isCheckableStep(s.name) && s.id === selectedSession.current_item_id);
  }

  // 全バルブが完了したかを判定
  function isCurrentStepComplete(): boolean {
    if (!selectedSession || !steps) return false;
    const currentStep = steps.find((s) => s.id === selectedSession.current_item_id);
    if (!currentStep) return false;
    const requiredRows = rows.filter((r) => currentStep.id in r.cells && r.cells[currentStep.id]?.state !== "NA");
    return requiredRows.length > 0 && requiredRows.every((r) => r.cells[currentStep.id]?.state !== "PENDING");
  }

  // 最後の工程がすべて完了したかを判定（セッション終了判定用）
  function isLastStepComplete(): boolean {
    if (!steps.length || !rows.length) return false;
    const lastStep = steps[steps.length - 1];
    const requiredRows = rows.filter((r) => lastStep.id in r.cells && r.cells[lastStep.id]?.state !== "NA");
    return requiredRows.length > 0 && requiredRows.every((r) => r.cells[lastStep.id]?.state !== "PENDING");
  }

  // 次工程を開始
  async function startNextStep() {
    try {
      setStartingNextStep(true);
      if (!selectedSession || !checklist) return;
      const currentIndex = getCurrentStepIndex();
      if (currentIndex === -1) {
        showFlash({ type: "error", text: "現在工程が見つかりません" });
        return;
      }

      const nextStep = steps[currentIndex + 1];
      if (!nextStep) {
        showFlash({ type: "info", text: "すべての工程が完了しました" });
        return;
      }

      // DB 更新
      const success = await setCurrentStep(selectedSession.id, checklist.id, nextStep.id);
      if (!success) {
        showFlash({ type: "error", text: "次工程への遷移に失敗しました" });
        return;
      }

      // Stale closure 対策：useEffectのコミットを待たず、同期的に即座にrefへ反映する。
      // これにより、この直後にQRを読んでもhandleScan()が最新のcurrent_item_idを参照できる。
      const updatedSession: InspectionSession = {
        ...selectedSession,
        current_item_id: nextStep.id,
        current_checklist_template_id: checklist.id,
      };
      selectedSessionRef.current = updatedSession;

      // ローカル state 更新
      setSessions((prev) =>
        prev.map((s) => (s.id === selectedSession.id ? updatedSession : s))
      );

      // 通知を挿入
      await supabase.from("step_start_notifications").upsert(
        {
          session_id: selectedSession.id,
          item_id: nextStep.id,
          item_name: nextStep.name,
          template_id: checklist.id,
          template_name: checklist.name,
        },
        { onConflict: "session_id,item_id", ignoreDuplicates: true }
      );

      // 音声再生
      if (isStepCompleteAudioEnabled()) {
        speak(stepStartMessage(checklist.name, nextStep.name));
      }

      showFlash({
        type: "success",
        text: `${nextStep.name}を開始しました`,
      });

      // 工程変更後、グリッドデータを即座に再ロード
      // これにより、QRスキャン時に正しい工程のデータを使用できる
      await loadGrid();
    } finally {
      setStartingNextStep(false);
    }
  }

  async function startScanner() {
    if (startingRef.current) return;
    startingRef.current = true;
    scanLockRef.current = false;
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
    if (next) {
      setSessionCompleted(false);
      setSelectedSessionId(next.id);
      setChecklist(null);
      clearActiveChecklist();
      setSteps([]);
      setRows([]);
      setQrNotIssuedEquipment([]);
      setSessions((prev) => [next, ...prev]);
    }
  }

  async function getSessionProgress(session: InspectionSession) {
    if (!session.current_checklist_template_id || !session.current_item_id) {
      return { currentStepName: "準備中", fieldDone: 0, fieldTotal: 0, confirmedDone: 0 };
    }

    const { data: items } = await supabase
      .from("checklist_items")
      .select("id, item_name")
      .eq("template_id", session.current_checklist_template_id);

    if (!items || items.length === 0) {
      return { currentStepName: "?", fieldDone: 0, fieldTotal: 0, confirmedDone: 0 };
    }

    const currentItem = items.find((i) => i.id === session.current_item_id);
    const currentStepName = currentItem?.item_name ?? "?";
    const checkableItemIds = items
      .filter((i) => !UNCHECKED_STEP_NAMES.has(i.item_name))
      .map((i) => i.id);

    const { data: mappings } = await supabase
      .from("checklist_item_equipment")
      .select("item_id, equipment_id")
      .in("item_id", checkableItemIds);

    if (!mappings || mappings.length === 0) {
      return { currentStepName, fieldDone: 0, fieldTotal: 0, confirmedDone: 0 };
    }

    const { data: results } = await supabase
      .from("inspection_results")
      .select("item_id, result, confirmed_at")
      .eq("session_id", session.id)
      .eq("item_id", session.current_item_id);

    const fieldDone = (results ?? []).filter((r) => r.result !== "PENDING" && r.result !== "NA").length;
    const confirmedDone = (results ?? []).filter((r) => r.confirmed_at).length;
    const fieldTotal = mappings.filter((m) => m.item_id === session.current_item_id).length;

    return { currentStepName, fieldDone, fieldTotal, confirmedDone };
  }

  useEffect(() => {
    if (sessions.length === 0) return;

    const loadAllProgress = async () => {
      const progress: Record<
        string,
        { currentStepName: string; fieldDone: number; fieldTotal: number; confirmedDone: number } | null
      > = {};
      for (const session of sessions) {
        progress[session.id] = await getSessionProgress(session);
      }
      setSessionProgress(progress);
    };

    loadAllProgress();
  }, [sessions]);

  useEffect(() => {
    if (!selectedSession) return;

    const restoreFromSession = async () => {
      if (!selectedSession.current_checklist_template_id) return;

      const { data: template } = await supabase
        .from("checklist_templates")
        .select("id, name")
        .eq("id", selectedSession.current_checklist_template_id)
        .single();

      if (template) {
        setChecklist({ id: template.id, name: template.name });
        setActiveChecklist({ id: template.id, name: template.name });
      }
    };

    restoreFromSession();
  }, [selectedSession?.id]);

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

        {!selectedSession ? (
          <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              点検セッションを選択してください
            </p>
            {loadingSessions ? (
              <p className="mt-2 text-sm text-zinc-500">読み込み中...</p>
            ) : sessions.length === 0 ? (
              <div className="mt-3">
                <p className="text-sm text-zinc-500">セッションがありません。</p>
                <button
                  onClick={handleStartNewSession}
                  className="mt-3 w-full rounded-lg bg-emerald-700 py-2.5 text-sm font-semibold text-white hover:bg-emerald-600 dark:bg-emerald-600"
                >
                  新しい点検を開始
                </button>
              </div>
            ) : (
              <div className="mt-3 flex flex-col gap-4">
                <div className="space-y-3">
                  <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">【点検中の作業】</p>
                  {sessions.map((s) => {
                    const progress = sessionProgress[s.id];
                    return (
                      <div
                        key={s.id}
                        className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-700 dark:bg-emerald-950"
                      >
                        <p className="font-medium text-zinc-900 dark:text-zinc-100">{s.title}</p>
                        <p className="text-xs text-zinc-600 dark:text-zinc-400">
                          開始：{new Date(s.session_date).toLocaleTimeString("ja-JP")}
                        </p>
                        {progress ? (
                          <>
                            <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                              現在工程：{progress.currentStepName}
                            </p>
                            <p className="text-xs text-zinc-600 dark:text-zinc-400">
                              現場進捗：{progress.fieldDone} / {progress.fieldTotal}
                            </p>
                            <p className="text-xs text-zinc-600 dark:text-zinc-400">
                              制御室確認：{progress.confirmedDone} / {progress.fieldTotal}
                            </p>
                          </>
                        ) : (
                          <p className="mt-1 text-xs text-zinc-500">読み込み中...</p>
                        )}
                        <button
                          onClick={() => setSelectedSessionId(s.id)}
                          className="mt-3 w-full rounded-lg bg-emerald-700 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-600 dark:bg-emerald-600"
                        >
                          この点検を再開
                        </button>
                      </div>
                    );
                  })}
                </div>

                <div className="border-t border-zinc-200 pt-3 dark:border-zinc-800">
                  <button
                    onClick={handleStartNewSession}
                    className="w-full rounded-lg bg-zinc-700 py-2.5 text-sm font-semibold text-white hover:bg-zinc-600 dark:bg-zinc-600"
                  >
                    新しい点検を開始
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="mt-4 flex items-center justify-between rounded-xl border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-950">
            <div>
              <p className="text-zinc-500">実施中のセッション</p>
              <p className="font-medium text-zinc-900 dark:text-zinc-100">
                {selectedSession.title}
              </p>
            </div>
            <button
              onClick={() => setSelectedSessionId(null)}
              className="text-sm text-zinc-500 hover:underline"
            >
              セッションを変更
            </button>
          </div>
        )}

        {selectedSession && !checklist ? (
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
                  <div
                    key={t.id}
                    className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
                  >
                    <p className="font-medium text-zinc-900 dark:text-zinc-100">{t.name}</p>
                    <p className="text-xs text-zinc-500">{t.itemCount}工程</p>
                    <button
                      onClick={() => selectChecklist(t)}
                      className="mt-2 w-full rounded-lg bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800 dark:bg-emerald-600 dark:hover:bg-emerald-700"
                    >
                      点検開始
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : selectedSession && checklist && sessionCompleted ? (
          <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-8 text-center dark:border-emerald-900 dark:bg-emerald-950">
            <p className="text-3xl">✓</p>
            <p className="mt-4 text-xl font-semibold text-emerald-900 dark:text-emerald-100">
              セッション完了！
            </p>
            <p className="mt-2 text-sm text-emerald-800 dark:text-emerald-300">
              復旧状態まですべての工程が完了しました。
            </p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
              <button
                onClick={handleStartNewSession}
                className="rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-600 dark:bg-emerald-600"
              >
                新規セッションを開始
              </button>
              <Link
                href="/"
                className="rounded-lg border border-emerald-700 px-4 py-2.5 text-center text-sm font-semibold text-emerald-700 hover:bg-emerald-50 dark:border-emerald-400 dark:text-emerald-400 dark:hover:bg-emerald-950"
              >
                ホームに戻る
              </Link>
            </div>
          </div>
        ) : selectedSession && checklist ? (
          <>
            <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs text-zinc-500">選択中の作業</p>
                  <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                    {checklist!.name}
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

            {qrNotIssuedEquipment.length > 0 && (
              <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950">
                <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                  ⚠️ QRコード未発行の対象があります
                </p>
                <div className="mt-2 flex flex-col gap-2">
                  {qrNotIssuedEquipment.map((eq) => (
                    <p key={eq.equipmentId} className="text-sm text-amber-800 dark:text-amber-300">
                      {eq.code} {eq.name}
                    </p>
                  ))}
                </div>
                <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                  点検前にQRコードを発行・貼付してください。
                </p>
              </div>
            )}

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

            {selectedSession && checklist && steps.length > 0 && (
              <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex items-start justify-between gap-3 mb-4">
                  <div>
                    {selectedSession.current_item_id && (
                      <>
                        <p className="text-xs text-zinc-500">現在工程</p>
                        <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                          {steps.find((s) => s.id === selectedSession.current_item_id)?.name}
                        </p>
                        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                          現場進捗：
                          {(() => {
                            const currentStep = steps.find((s) => s.id === selectedSession.current_item_id);
                            if (!currentStep) return "N/A";
                            if (!isCheckableStep(currentStep.name)) return "対象外";
                            const requiredRows = rows.filter((r) => currentStep.id in r.cells && r.cells[currentStep.id]?.state !== "NA");
                            const completedRows = requiredRows.filter((r) => r.cells[currentStep.id]?.state !== "PENDING");
                            return `${completedRows.length} / ${requiredRows.length}`;
                          })()}
                        </p>
                      </>
                    )}
                  </div>
                  <button
                    onClick={startNextStep}
                    disabled={!isCurrentStepComplete() || startingNextStep}
                    className={`whitespace-nowrap rounded-lg py-2.5 px-4 text-sm font-semibold text-white ${
                      isCurrentStepComplete() && !startingNextStep
                        ? "bg-emerald-700 hover:bg-emerald-600 dark:bg-emerald-600"
                        : "bg-zinc-400 cursor-not-allowed dark:bg-zinc-700"
                    }`}
                  >
                    ▶ 次工程を開始
                  </button>
                </div>

                {steps.length > 0 && (
                  <div className="overflow-x-auto -mx-4 px-4">
                    <div className="flex gap-2 pb-2">
                      {steps.map((step, idx) => {
                        const isCurrent = step.id === selectedSession.current_item_id;
                        const isCheckable = isCheckableStep(step.name);
                        const isPast = idx < getCurrentStepIndex();
                        const isFuture = idx > getCurrentStepIndex();

                        return (
                          <button
                            key={step.id}
                            onClick={() => {
                              if (isPast || isCurrent || isFuture) return;
                              setCurrentStep(selectedSession.id, checklist.id, step.id).then(() => {
                                // Stale closure 対策：同期的に即座にrefへ反映
                                const updatedSession: InspectionSession = {
                                  ...selectedSession,
                                  current_item_id: step.id,
                                  current_checklist_template_id: checklist.id,
                                };
                                selectedSessionRef.current = updatedSession;
                                setSessions((prev) =>
                                  prev.map((s) => (s.id === selectedSession.id ? updatedSession : s))
                                );
                              });
                            }}
                            disabled={isFuture}
                            className={`flex-shrink-0 rounded-lg px-3 py-2 text-xs font-medium whitespace-nowrap border ${
                              isCurrent
                                ? "bg-emerald-100 border-emerald-300 text-emerald-800 dark:bg-emerald-950 dark:border-emerald-700 dark:text-emerald-200 cursor-default"
                                : isPast
                                ? "bg-zinc-100 border-zinc-300 text-zinc-700 dark:bg-zinc-800 dark:border-zinc-600 dark:text-zinc-300 cursor-default"
                                : isFuture
                                ? "bg-zinc-50 border-zinc-200 text-zinc-400 dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-600 cursor-not-allowed"
                                : "bg-zinc-100 border-zinc-300 text-zinc-700 dark:bg-zinc-800 dark:border-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 cursor-pointer"
                            }`}
                          >
                            {isCurrent ? "●" : isPast ? "✓" : isCheckable ? "○" : "‐"} {step.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
              {selectedSession && selectedSession.current_item_id && (
                <>
                  {displayMode === "current" ? (
                    <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                      {steps.find((s) => s.id === selectedSession.current_item_id)?.name}（{rows.length}台）
                    </p>
                  ) : (
                    <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                      作業手順一覧（{rows.length}台）
                    </p>
                  )}
                  {loadingGrid ? (
                    <p className="mt-2 text-sm text-zinc-500">読み込み中...</p>
                  ) : rows.length === 0 ? (
                    <p className="mt-2 text-sm text-zinc-500">
                      このチェックリストに紐づくバルブがありません。
                    </p>
                  ) : displayMode === "current" ? (
                    <div className="mt-3 overflow-x-auto border border-zinc-200 dark:border-zinc-800">
                      <table className="w-full border-collapse text-sm">
                        <thead>
                          <tr>
                            <th className="sticky left-0 bg-white py-2 pr-3 text-left dark:bg-zinc-950">
                              バルブ
                            </th>
                            <th colSpan={isCheckableStep(steps.find((s) => s.id === selectedSession.current_item_id)?.name ?? "") ? 3 : 1} className="px-2 py-2 text-center text-xs font-medium text-zinc-500">
                              {steps.find((s) => s.id === selectedSession.current_item_id)?.name}
                            </th>
                          </tr>
                          <tr>
                            <th></th>
                            <th className="px-1 pb-1 text-center text-[10px] font-normal text-zinc-400">
                              状態
                            </th>
                            {isCheckableStep(steps.find((s) => s.id === selectedSession.current_item_id)?.name ?? "") && (
                              <>
                                <th className="px-1 pb-1 text-center text-[10px] font-normal text-zinc-400">
                                  現場
                                </th>
                                <th className="px-1 pb-1 text-center text-[10px] font-normal text-zinc-400">
                                  制御室
                                </th>
                              </>
                            )}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((row) => {
                            const cell: Cell = selectedSession.current_item_id ? (row.cells[selectedSession.current_item_id] ?? { state: "NA", target: null, confirmed: false }) : { state: "NA", target: null, confirmed: false };
                            const clickable = selectedSession.current_item_id && cell.state === "PENDING" && isCheckableStep(steps.find((s) => s.id === selectedSession.current_item_id)?.name ?? "");
                            return (
                              <tr key={row.equipmentId} className="border-t border-zinc-100 dark:border-zinc-900">
                                <td className="sticky left-0 bg-white py-2 pr-3 dark:bg-zinc-950">
                                  <span className="font-medium text-zinc-900 dark:text-zinc-100">
                                    {row.code}
                                  </span>
                                  <span className="ml-1 block text-xs text-zinc-500">
                                    {row.name}
                                    {row.qrIssuedAt ? (
                                      <span className="ml-1 text-emerald-600 dark:text-emerald-400">QR✓</span>
                                    ) : (
                                      <span className="ml-1 text-amber-600 dark:text-amber-400">QR⚠️</span>
                                    )}
                                  </span>
                                </td>
                                <td className="px-1 py-2 text-center">
                                  {(() => {
                                    const currentStep = steps.find((s) => s.id === selectedSession.current_item_id);
                                    if (!currentStep) return null;
                                    return (
                                      <button
                                        onClick={() => clickable && openTapConfirm(row)}
                                        disabled={!clickable}
                                        className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold ${cellClass(
                                          row,
                                          currentStep
                                        )} ${clickable ? "cursor-pointer active:scale-95" : "cursor-default"}`}
                                      >
                                        {cellLabel(cell)}
                                      </button>
                                    );
                                  })()}
                                </td>
                                {(() => {
                                  const currentStep = steps.find((s) => s.id === selectedSession.current_item_id);
                                  if (!isCheckableStep(currentStep?.name ?? "")) return null;
                                  return (
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
                                        {checkGlyph(cell, currentStep!)}
                                      </span>
                                    </td>
                                  );
                                })()}
                                {(() => {
                                  const currentStep = steps.find((s) => s.id === selectedSession.current_item_id);
                                  if (!isCheckableStep(currentStep?.name ?? "")) return null;
                                  return (
                                    <Fragment key="confirm">
                                      <td className="px-1 py-2 text-center text-base">
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
                                })() as any}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="mt-3 overflow-x-auto border border-zinc-200 dark:border-zinc-800">
                      <table className="w-full border-collapse text-sm">
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
                                      制御室
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
                                <span className="font-medium text-zinc-900 dark:text-zinc-100">
                                  {row.code}
                                </span>
                                <span className="ml-1 block text-xs text-zinc-500">
                                  {row.name}
                                  {row.qrIssuedAt ? (
                                    <span className="ml-1 text-emerald-600 dark:text-emerald-400">QR✓</span>
                                  ) : (
                                    <span className="ml-1 text-amber-600 dark:text-amber-400">QR⚠️</span>
                                  )}
                                </span>
                              </td>
                              {steps.map((step) => {
                                const cell: Cell = row.cells[step.id] ?? { state: "NA", target: null, confirmed: false };
                                const clickable = cell.state === "PENDING" && isCheckableStep(step.name);
                                return (
                                  <Fragment key={step.id}>
                                    <td className="px-1 py-2 text-center">
                                      <button
                                        onClick={() => clickable && setTapConfirm({ row, step })}
                                        disabled={!clickable}
                                        className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold ${cellClass(
                                          row,
                                          step
                                        )} ${clickable ? "cursor-pointer active:scale-95" : "cursor-default"}`}
                                      >
                                        {cellLabel(cell)}
                                      </button>
                                    </td>
                                    {isCheckableStep(step.name) && (
                                      <td className="px-1 py-2 text-center text-base">
                                        <span
                                          onClick={() => clickable && setTapConfirm({ row, step })}
                                          className={
                                            clickable
                                              ? "cursor-pointer text-zinc-400"
                                              : cell.state === "NA"
                                              ? "text-zinc-200 dark:text-zinc-800"
                                              : "text-emerald-600 dark:text-emerald-400"
                                          }
                                        >
                                          {checkGlyph(cell, step)}
                                        </span>
                                      </td>
                                    )}
                                    {isCheckableStep(step.name) && (
                                      <td className="px-1 py-2 text-center text-base">
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
                </>
              )}
              <p className="mt-3 text-xs text-zinc-400">
                色つき◯/☓ = 操作するバルブ(緑=開ける／赤=閉める) ・ グレー = 状態が変わらない確認のみの工程 ・ ✕ NG ・ ／ 対象外 ・ ☑ 記録済み。◯/☓か☐をタップすると記録できます。バルブ名をタップすると詳細を確認できます。
              </p>
            </div>
          </>
        ) : null}
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
                className={`flex-1 rounded-lg border-2 py-2.5 text-sm font-semibold disabled:opacity-50 ${
                  tapConfirm.row.cells[tapConfirm.step.id]?.target === "close"
                    ? "border-red-600 bg-red-600 text-white dark:border-red-500 dark:bg-red-500"
                    : "border-emerald-600 bg-emerald-600 text-white dark:border-emerald-500 dark:bg-emerald-500"
                }`}
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
