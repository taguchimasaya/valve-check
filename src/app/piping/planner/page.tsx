"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import PipingDiagram, { DiagramLegend, type DiagramHandle, type NodeMark, type PipeLayer } from "@/components/piping/PipingDiagram";
import { normalValveState, otherSide } from "@/lib/piping/graph";
import {
  estimateDrain,
  formatLiters,
  formatMinutes,
  DEFAULT_FILL_LPM,
  GRAVITY_LPM,
  planIsolation,
  type Target,
} from "@/lib/piping/isolation";
import { currentValveState, describeOperation, OPERATION_META, TANKS, type OperationKind } from "@/lib/piping/operations";
import { planConflicts } from "@/lib/piping/execution";
import { flowColor, stepFlow } from "@/lib/piping/flow";
import {
  ALL_PUMPS,
  buildDayChecklist,
  FLUSH_STEPS,
  FLUSH_TURNOVER,
  flushPumps,
  flushTarget,
  ISOLATION_STEPS,
  isolationIssueRoute,
  isolationTransferRoute,
  WORK_TYPES,
  workTypeOf,
  type DayParams,
  type WorkType,
} from "@/lib/piping/workTypes";
import {
  buildPlanRows,
  downloadWorkbook,
  isOperateCell,
  newId,
  PLAN_STEPS,
  planToEquipmentWorkbook,
  planToWorkbook,
  ROLE_LABEL,
  stateAtStep,
  rowGlyph,
  type SavedPlan,
} from "@/lib/piping/checklist";
import { useGraph, usePipingStore } from "@/lib/piping/usePiping";
import type { NodeKind } from "@/lib/piping/types";

const TARGET_KINDS: NodeKind[] = ["strainer", "filter", "pump", "transferPump", "valve", "check", "tank"];
const STEPS_OF: Record<WorkType, string[]> = { drain: PLAN_STEPS, flush: FLUSH_STEPS, tankIsolation: ISOLATION_STEPS };
const yardOf = (tank: string) => tank.slice(2, 3);

export default function PlannerPage() {
  const g = useGraph();
  const { store, act } = usePipingStore(0);

  const [name, setName] = useState("");
  const [workType, setWorkType] = useState<WorkType>("drain");
  // 燃料末端部作業：末端部として選んだ配管、タンク縁切り：対象タンク
  const [flushPipes, setFlushPipes] = useState<string[]>([]);
  const [isoTank, setIsoTank] = useState<string | null>(null);
  // 当日の選択の例（保存すると現場・制御室の選択欄の初期値になる）
  const [flushSrc, setFlushSrc] = useState("T-101");
  const [flushRet, setFlushRet] = useState("T-102");
  const [flushPump, setFlushPump] = useState("P-11");
  const [destTank, setDestTank] = useState("T-102");
  const [issuePump, setIssuePump] = useState("P-11");
  const [transferPump, setTransferPump] = useState("TP-1");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [expandToDrain, setExpandToDrain] = useState(true);
  const [baselineMode, setBaselineMode] = useState<"normal" | "operation">("normal");
  const [extraSectionIds, setExtraSectionIds] = useState<string[]>([]);
  const [excludedDrains, setExcludedDrains] = useState<string[]>([]);
  const [gaugeIds, setGaugeIds] = useState<string[]>([]);
  const [portableLpm, setPortableLpm] = useState(300);
  const [fillLpm, setFillLpm] = useState(DEFAULT_FILL_LPM);
  const [mode, setMode] = useState<"target" | "expand">("target");
  const [previewStep, setPreviewStep] = useState(0);
  const [focusSeal, setFocusSeal] = useState<number | null>(null);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const diagramRef = useRef<DiagramHandle>(null);

  const storeOps = store?.operations;
  const operations = useMemo(() => storeOps ?? [], [storeOps]);
  const storeOverrides = store?.valveOverrides;
  const overrides = useMemo(() => storeOverrides ?? {}, [storeOverrides]);
  const opState = useMemo(() => currentValveState(g, operations, overrides), [g, operations, overrides]);
  const hasCurrentState = operations.length > 0 || Object.keys(overrides).length > 0;
  const baseline = useMemo(
    () => (baselineMode === "operation" && hasCurrentState ? opState.valveState : normalValveState(g.facility)),
    [g, baselineMode, hasCurrentState, opState]
  );

  const isDay = workType !== "drain";
  const steps = STEPS_OF[workType];
  const iso = useMemo(
    () =>
      !isDay && (targets.length || extraSectionIds.length)
        ? planIsolation(g, targets, { baseline, expandToDrain, extraSectionIds })
        : null,
    [g, isDay, targets, baseline, expandToDrain, extraSectionIds]
  );

  // ───── 燃料末端部作業・タンク縁切り：当日の選択（例）から作るチェックリスト ─────
  const flushT = useMemo(
    () => (workType === "flush" && flushPipes.length ? flushTarget(g, flushPipes) : null),
    [g, workType, flushPipes]
  );
  const flushPumpOptions = useMemo(
    () => (flushT ? flushPumps(g, flushPipes, flushSrc, flushRet) : []),
    [g, flushT, flushPipes, flushSrc, flushRet]
  );
  const effFlushPump = flushPumpOptions.includes(flushPump) ? flushPump : flushPumpOptions[0];
  const effDest =
    isoTank && destTank === isoTank ? TANKS.find((t) => t !== isoTank && yardOf(t) === yardOf(isoTank))! : destTank;
  const issuePumpOptions = useMemo(
    () =>
      isoTank
        ? ALL_PUMPS(g).filter((p) => g.nodeById.get(p)!.kind === "pump" && isolationIssueRoute(g, isoTank, effDest, p))
        : [],
    [g, isoTank, effDest]
  );
  const transferPumpOptions = useMemo(
    () =>
      isoTank
        ? ALL_PUMPS(g).filter((p) => g.nodeById.get(p)!.kind === "transferPump" && isolationTransferRoute(g, isoTank, effDest, p))
        : [],
    [g, isoTank, effDest]
  );
  const effIssuePump = issuePumpOptions.includes(issuePump) ? issuePump : issuePumpOptions[0];
  const effTransferPump = transferPumpOptions.includes(transferPump) ? transferPump : transferPumpOptions[0];
  const dayParams: DayParams | null =
    workType === "flush" && flushT && effFlushPump
      ? { kind: "flush", srcTank: flushSrc, pump: effFlushPump, returnTank: flushRet }
      : workType === "tankIsolation" && isoTank && effIssuePump && effTransferPump
        ? { kind: "tankIsolation", destTank: effDest, issuePump: effIssuePump, transferPump: effTransferPump }
        : null;
  const dayKey = JSON.stringify(dayParams);
  const dayResult = useMemo(() => {
    const params = JSON.parse(dayKey) as DayParams | null;
    if (!params) return null;
    return buildDayChecklist(
      g,
      {
        steps,
        flushPipeIds: flushPipes,
        isolationTank: isoTank ?? undefined,
        summary: { volumeL: flushT?.volumeL ?? null, drainMinutes: null, drains: [], warnings: [], notes: [] },
      },
      params,
      baseline
    );
  }, [g, dayKey, steps, flushPipes, isoTank, flushT, baseline]);
  const dayError =
    workType === "flush" && flushT && !effFlushPump
      ? "送り元・戻り先タンクから末端部へ届くポンプがありません"
      : workType === "tankIsolation" && isoTank && (!effIssuePump || !effTransferPump)
        ? "移送先タンクへの移送経路が見つかりません"
        : dayResult?.error;

  const drains = useMemo(
    () => (iso ? iso.drains.filter((d) => !excludedDrains.includes(d)) : []),
    [iso, excludedDrains]
  );
  // 液封区間の圧力計は、候補として残っているものだけ採用する
  const activeGauges = useMemo(() => {
    if (!iso) return [];
    const candidates = new Set(iso.sealGroups.flatMap((s) => s.gaugeCandidates));
    return gaugeIds.filter((id) => candidates.has(id));
  }, [iso, gaugeIds]);

  const drainRows = useMemo(
    () => (iso ? buildPlanRows(g, iso, baseline, drains, activeGauges) : []),
    [g, iso, baseline, drains, activeGauges]
  );
  const dayRows = dayResult?.rows;
  const rows = useMemo(() => (isDay ? dayRows ?? [] : drainRows), [isDay, dayRows, drainRows]);
  // 制御室で入力中の運用との干渉
  const conflicts = useMemo(
    () =>
      iso && hasCurrentState
        ? planConflicts({ rows, regionPipeIds: iso.regionPipeIds }, opState, (k) => OPERATION_META[k as OperationKind].label)
        : [],
    [iso, rows, hasCurrentState, opState]
  );
  const estimate = useMemo(
    () => (iso ? estimateDrain(g, drains, iso.volumeL, portableLpm) : null),
    [g, iso, drains, portableLpm]
  );
  const equipmentVolume = useMemo(
    () => (iso ? iso.regionNodeIds.reduce((a, id) => a + (g.nodeById.get(id)!.volumeL ?? 0), 0) : 0),
    [g, iso]
  );

  // ───── 図面表示 ─────
  const previewState = useMemo(() => stateAtStep(baseline, rows, previewStep), [baseline, rows, previewStep]);
  // 燃料の抜取系統：抜取工程で燃料が流れる経路（範囲内 → ドレン口 → ドレン弁 → 抜取ポンプ → 回収先タンク）
  const drainFlow = useMemo(() => {
    if (!iso) return null;
    const step = PLAN_STEPS.indexOf("抜取");
    const plan = { steps: PLAN_STEPS, rows, regionPipeIds: iso.regionPipeIds, regionNodeIds: iso.regionNodeIds } as Parameters<typeof stepFlow>[1];
    return stepFlow(g, plan, step, stateAtStep(baseline, rows, step));
  }, [g, iso, rows, baseline]);
  const layers: PipeLayer[] = [];
  const marks: Record<string, NodeMark> = {};
  if (iso) {
    layers.push({ key: "region", pipeIds: iso.regionPipeIds, color: "#ef4444", opacity: 0.4 });
    layers.push({ key: "fill", pipeIds: iso.fill.pipeIds, color: "#0d9488", opacity: 0.6 });
    if (drainFlow) {
      layers.push({
        key: "drain-flow",
        pipeIds: [...drainFlow.directions.keys()],
        directions: drainFlow.directions,
        color: "#0284c7",
        width: 5,
        flow: true,
      });
    }
    iso.sealGroups.forEach((s, i) =>
      layers.push({
        key: `seal-${i}`,
        pipeIds: s.pipeIds,
        color: "#f59e0b",
        opacity: focusSeal === null || focusSeal === i ? 0.55 : 0.15,
        blink: focusSeal === i,
      })
    );
    iso.boundaryValves.forEach((v) => (marks[v] = "boundary"));
    iso.internalValves.forEach((v) => (marks[v] = "internal"));
    drains.forEach((d) => (marks[d] = "drain"));
    // 抜取で開ける弁（ドレン弁・抜取ポンプ側の弁）
    rows.filter((r) => r.role === "drain" && r.nodeId).forEach((r) => (marks[r.nodeId!] = "drain"));
    activeGauges.forEach((d) => (marks[d] = "gauge"));
    iso.fill.openValves.forEach((v) => (marks[v] = "fill"));
    if (focusSeal !== null) iso.sealGroups[focusSeal]?.ventValves.forEach((v) => (marks[v] = "vent"));
  }
  if (isDay) {
    if (flushT) layers.push({ key: "flush-target", pipeIds: flushT.pipeIds, color: "#06b6d4", opacity: 0.5 });
    const routes = dayResult?.stepRoutes ?? {};
    const route = routes[previewStep];
    const shown = route ? [route] : Object.values(routes);
    shown.forEach((r, i) => {
      const directions = new Map<string, string>();
      r.pipeIds.forEach((pid, k) => directions.set(pid, r.nodeIds[k]));
      layers.push({
        key: `route-${i}`,
        pipeIds: r.pipeIds,
        directions,
        color: flowColor("route"),
        width: 5,
        opacity: route ? 1 : 0.35,
        flow: !!route,
      });
    });
    // 作業前：チェックリストの弁・ポンプすべて。各工程：開操作（緑）・閉操作（赤）・確認（水色）
    rows.forEach((r) => {
      if (!r.nodeId) return;
      if (previewStep === 0) {
        marks[r.nodeId] = "selected";
        return;
      }
      const s = r.states[previewStep];
      if (!s) return;
      marks[r.nodeId] = !isOperateCell(r, previewStep) ? "selected" : s === "open" ? "internal" : "boundary";
    });
    if (isoTank) marks[isoTank] = "selected";
  }
  const targetPipes = targets.filter((t) => t.type === "pipe").map((t) => t.id);
  if (targetPipes.length) layers.push({ key: "targets", pipeIds: targetPipes, color: "#06b6d4", opacity: 0.8 });
  targets.filter((t) => t.type === "node").forEach((t) => (marks[t.id] = "selected"));

  function toggleTarget(t: Target) {
    setTargets((prev) =>
      prev.some((p) => p.type === t.type && p.id === t.id)
        ? prev.filter((p) => !(p.type === t.type && p.id === t.id))
        : [...prev, t]
    );
  }

  function handleNodeClick(id: string) {
    const n = g.nodeById.get(id)!;
    if (workType === "tankIsolation") {
      if (n.kind === "tank" && TANKS.includes(id)) setIsoTank(id);
      return;
    }
    if (workType === "flush") return;
    if (mode === "expand") {
      if (!iso || n.kind !== "valve") return;
      const region = new Set(iso.regionSectionIds);
      const sides = g.valveSides.get(id) ?? [];
      const inside = sides.find((s) => region.has(s));
      const outside = inside ? otherSide(g, id, inside) : null;
      if (outside && !region.has(outside)) setExtraSectionIds((p) => [...p, outside]);
      return;
    }
    toggleTarget({ type: "node", id });
  }

  function handlePipeClick(pid: string) {
    if (workType === "flush") {
      setFlushPipes((p) => (p.includes(pid) ? p.filter((x) => x !== pid) : [...p, pid]));
      return;
    }
    if (mode === "expand") {
      const sid = g.sectionOfPipe.get(pid)!;
      setExtraSectionIds((p) => (p.includes(sid) ? p.filter((s) => s !== sid) : [...p, sid]));
      return;
    }
    toggleTarget({ type: "pipe", id: pid });
  }

  function targetLabel(t: Target) {
    if (t.type === "node") {
      const n = g.nodeById.get(t.id)!;
      return `${n.label}（${n.name}）`;
    }
    const p = g.pipeById.get(t.id)!;
    const a = g.nodeById.get(p.a)!;
    const b = g.nodeById.get(p.b)!;
    const area = a.area === b.area ? a.area : `${a.area}〜${b.area}`;
    return `配管 ${p.sizeA}A（${area}）`;
  }

  function reset() {
    setEditingId(null);
    setName("");
    setTargets([]);
    setFlushPipes([]);
    setIsoTank(null);
    setExtraSectionIds([]);
    setExcludedDrains([]);
    setGaugeIds([]);
    setPreviewStep(0);
    setFocusSeal(null);
  }

  function buildDayPlan(): SavedPlan | null {
    if (!dayResult || dayResult.error || !dayParams || !rows.length) return null;
    const flush = workType === "flush";
    const auto = flush
      ? `燃料末端部作業（${flushT!.ends.slice(0, 3).join("・")}${flushT!.ends.length > 3 ? "ほか" : ""}）`
      : `タンク縁切り（${isoTank}）`;
    return {
      id: editingId ?? newId(),
      name: name.trim() || auto,
      workType,
      purpose: WORK_TYPES[workType].label,
      flushPipeIds: flush ? flushPipes : undefined,
      isolationTank: flush ? undefined : isoTank!,
      createdAt: new Date().toISOString(),
      source: "planner",
      targets: flush ? flushPipes.map((id) => ({ type: "pipe" as const, id })) : [{ type: "node", id: isoTank! }],
      regionPipeIds: flush ? flushT!.pipeIds : [],
      regionNodeIds: flush ? [] : [isoTank!],
      sealPipeIds: [],
      steps,
      rows,
      stepNotes: dayResult.stepNotes,
      stepRoutes: dayResult.stepRoutes,
      dayDefaults: dayParams,
      planner: { expandToDrain, baselineMode, extraSectionIds: [], excludedDrains: [], gaugeIds: [], portableLpm, fillLpm },
      summary: {
        volumeL: flush ? flushT!.volumeL : null,
        drainMinutes: null,
        drains: [],
        warnings: [],
        notes: [
          "タンク・ポンプは当日の運用に合わせて ② 現場点検・③ 制御室で選び直します（ここで選んだものは初期値）。",
        ],
      },
    };
  }

  function buildPlan(): SavedPlan | null {
    if (isDay) return buildDayPlan();
    if (!iso || !rows.length) return null;
    const warnings = [
      ...iso.errors,
      ...conflicts.map((c) => `運用との干渉：${c}`),
      ...iso.sealGroups.map(
        (s) =>
          `${s.preexisting ? "既存の" : ""}液封区間（${formatLiters(s.volumeL)}）：遮断弁 ${s.adjacentBoundary.join("・")} に隣接。安全弁・タンクへの逃げ道がありません。`
      ),
    ];
    return {
      id: editingId ?? newId(),
      name: name.trim() || `燃料抜取（${targets.map((t) => (t.type === "node" ? g.nodeById.get(t.id)!.label : "配管")).join("・")}）`,
      purpose: WORK_TYPES.drain.label,
      createdAt: new Date().toISOString(),
      source: "planner",
      targets,
      regionPipeIds: iso.regionPipeIds,
      regionNodeIds: iso.regionNodeIds,
      sealPipeIds: iso.sealGroups.flatMap((s) => s.pipeIds),
      fillPipeIds: iso.fill.pipeIds,
      steps: PLAN_STEPS,
      rows,
      planner: { expandToDrain, baselineMode, extraSectionIds, excludedDrains, gaugeIds: activeGauges, portableLpm, fillLpm },
      summary: {
        volumeL: iso.volumeL,
        drainMinutes: estimate?.minutes ?? null,
        fillMinutes: fillLpm > 0 ? iso.volumeL / fillLpm : null,
        drains,
        warnings,
        notes: iso.notes,
      },
    };
  }

  async function save() {
    const plan = buildPlan();
    if (!plan) return;
    try {
      await act({ action: "savePlan", plan });
      setEditingId(plan.id);
      setName(plan.name);
      setMessage({ type: "ok", text: `「${plan.name}」を保存しました。現場点検画面から実施できます。` });
    } catch (e) {
      setMessage({ type: "err", text: e instanceof Error ? e.message : String(e) });
    }
  }

  function exportExcel() {
    const plan = buildPlan();
    if (!plan) return;
    downloadWorkbook(planToWorkbook(plan), `${plan.name}.xlsx`);
  }

  function exportEquipment() {
    const plan = buildPlan();
    if (!plan) return;
    downloadWorkbook(planToEquipmentWorkbook(g, plan), `${plan.name}_機器マスター.xlsx`);
  }

  function loadPlan(p: SavedPlan) {
    setEditingId(p.id);
    setName(p.name);
    const type = workTypeOf(p);
    setWorkType(type);
    setTargets(type === "drain" ? p.targets : []);
    setFlushPipes(p.flushPipeIds ?? []);
    setIsoTank(p.isolationTank ?? null);
    const d = p.dayDefaults;
    if (d?.kind === "flush") {
      setFlushSrc(d.srcTank);
      setFlushRet(d.returnTank);
      setFlushPump(d.pump);
    } else if (d?.kind === "tankIsolation") {
      setDestTank(d.destTank);
      setIssuePump(d.issuePump);
      setTransferPump(d.transferPump);
    }
    if (p.planner) {
      setExpandToDrain(p.planner.expandToDrain ?? true);
      setBaselineMode(p.planner.baselineMode);
      setExtraSectionIds(p.planner.extraSectionIds);
      setExcludedDrains(p.planner.excludedDrains);
      setGaugeIds(p.planner.gaugeIds);
      setPortableLpm(p.planner.portableLpm);
      setFillLpm(p.planner.fillLpm ?? DEFAULT_FILL_LPM);
    }
    setPreviewStep(0);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const plannerPlans = (store?.plans ?? []).filter((p) => p.source === "planner");

  return (
    <main className="min-h-screen bg-zinc-50 px-4 py-6 dark:bg-black">
      <div className="mx-auto max-w-[1800px]">
        <Link href="/piping" className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400">
          ← 配管系統図メニュー
        </Link>
        <h1 className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">① チェックリスト作成</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          {workType === "drain"
            ? "図面上で抜取対象の機器・配管をクリックしてください。ドレン口のある区間まで遮断範囲を自動算定し、操作バルブ・液封リスク・抜取量を表示します。"
            : workType === "flush"
              ? "図面上で末端部（通常使用しないライン）の配管をクリックしてください。つながっているラインのポンプで循環させる経路と操作バルブを作ります。"
              : "図面上で縁切りするタンクをクリックしてください。払出系統 → 移送系統の順に別のタンクへ移送し、ノズル弁を閉止して縁切りします。"}
        </p>

        <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_440px]">
          <div className="min-w-0 space-y-3">
            <PipingDiagram
              ref={diagramRef}
              graph={g}
              valveState={previewState}
              layers={layers}
              marks={marks}
              onNodeClick={handleNodeClick}
              onPipeClick={workType === "tankIsolation" ? undefined : handlePipeClick}
              clickableKinds={
                workType === "flush" ? [] : workType === "tankIsolation" ? ["tank"] : mode === "expand" ? ["valve"] : TARGET_KINDS
              }
              height="74vh"
              toolbar={
                <>
                  <div
                    className={`flex overflow-hidden rounded-lg border border-zinc-300 text-xs dark:border-zinc-700 ${isDay ? "hidden" : ""}`}
                  >
                    <button
                      onClick={() => setMode("target")}
                      className={`px-2.5 py-1 ${mode === "target" ? "bg-cyan-600 text-white" : ""}`}
                    >
                      対象を選択
                    </button>
                    <button
                      onClick={() => setMode("expand")}
                      disabled={!iso}
                      className={`px-2.5 py-1 disabled:opacity-40 ${mode === "expand" ? "bg-red-600 text-white" : ""}`}
                    >
                      範囲を手動調整
                    </button>
                  </div>
                  <label className="flex items-center gap-1 text-xs">
                    表示：
                    <select
                      value={previewStep}
                      onChange={(e) => setPreviewStep(Number(e.target.value))}
                      className="rounded border border-zinc-300 bg-transparent px-1 py-0.5 dark:border-zinc-700"
                    >
                      {steps.map((s, i) => (
                        <option key={s} value={i}>
                          {i === 0 ? "作業前の状態" : `${s} 後の状態`}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              }
            />
            <DiagramLegend
              items={isDay ? [
                { color: "#06b6d4", label: workType === "flush" ? "末端部（選択した区間）" : "縁切りするタンク", kind: workType === "flush" ? "line" : "ring" },
                { color: flowColor("route"), label: workType === "flush" ? "循環経路" : "移送経路（表示中の工程）" },
                { color: "#16a34a", label: "開操作・ポンプ起動", kind: "ring" },
                { color: "#dc2626", label: "閉操作・ポンプ停止", kind: "ring" },
                { color: "#06b6d4", label: previewStep === 0 ? "チェックリストの弁・ポンプ" : "確認（状態変化なし）", kind: "ring" },
              ] : [
                { color: "#06b6d4", label: "選択した対象", kind: "ring" },
                { color: "#ef4444", label: "抜取範囲（遮断範囲）" },
                { color: "#dc2626", label: "遮断弁（閉）", kind: "ring" },
                { color: "#16a34a", label: "範囲内弁（開）", kind: "ring" },
                { color: "#0284c7", label: "使用ドレン・抜取で開ける弁", kind: "ring" },
                { color: "#0284c7", label: "抜取の流れ（抜取系統）" },
                { color: "#0d9488", label: "充填ライン・充填弁" },
                { color: "#f59e0b", label: "液封の恐れ" },
                { color: "#a855f7", label: "圧力計取付", kind: "ring" },
              ]}
            />
            {mode === "expand" && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-950 dark:text-red-200">
                手動調整モード：赤枠の遮断弁をクリックすると、その先の区間まで範囲を広げます。配管をクリックすると、その区間を追加／除外します。
              </p>
            )}
          </div>

          <aside className="space-y-3">
            {message && (
              <div
                className={`rounded-lg px-3 py-2 text-sm ${
                  message.type === "ok"
                    ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                    : "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200"
                }`}
              >
                {message.text}
              </div>
            )}

            <Panel title="作業内容">
              <div className="mb-2 grid grid-cols-3 gap-1">
                {(Object.keys(WORK_TYPES) as WorkType[]).map((t) => (
                  <button
                    key={t}
                    title={WORK_TYPES[t].desc}
                    onClick={() => {
                      if (t === workType) return;
                      setWorkType(t);
                      setEditingId(null);
                      setPreviewStep(0);
                      setMode("target");
                    }}
                    className={`rounded-lg border px-2 py-1.5 text-xs leading-tight ${
                      workType === t
                        ? "border-cyan-600 bg-cyan-600 font-semibold text-white"
                        : "border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                    }`}
                  >
                    {WORK_TYPES[t].label}
                  </button>
                ))}
              </div>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="作業名（空欄なら自動）"
                className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm dark:border-zinc-700"
              />
              {isDay ? (
                <DayTargetPanel
                  g={g}
                  workType={workType}
                  flushPipes={flushPipes}
                  setFlushPipes={setFlushPipes}
                  flushT={flushT}
                  isoTank={isoTank}
                  pipeLabel={(id) => targetLabel({ type: "pipe", id })}
                />
              ) : (
              <div className="mt-3">
                <p className="text-xs font-medium text-zinc-500">抜取対象（図面をクリック）</p>
                {targets.length === 0 ? (
                  <p className="mt-1 text-sm text-zinc-400">未選択（例：フィルター F・ポンプ・ストレーナー・配管）</p>
                ) : (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {targets.map((t) => (
                      <button
                        key={`${t.type}-${t.id}`}
                        onClick={() => toggleTarget(t)}
                        className="rounded-full bg-cyan-100 px-2.5 py-0.5 text-xs text-cyan-900 hover:bg-cyan-200 dark:bg-cyan-950 dark:text-cyan-200"
                      >
                        {targetLabel(t)} ×
                      </button>
                    ))}
                  </div>
                )}
              </div>
              )}
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <label className={`flex items-start gap-1.5 pt-4 ${isDay ? "invisible" : ""}`}>
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={expandToDrain}
                    onChange={(e) => setExpandToDrain(e.target.checked)}
                  />
                  <span>
                    ドレン口まで広げる
                    <span className="block text-[11px] text-zinc-400">外すと隣接弁のみで遮断</span>
                  </span>
                </label>
                <label className="space-y-1">
                  <span className="text-zinc-500">作業前の弁状態</span>
                  <select
                    value={baselineMode}
                    onChange={(e) => setBaselineMode(e.target.value as "normal" | "operation")}
                    className="w-full rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
                  >
                    <option value="normal">待機状態</option>
                    <option value="operation">現在の状態（制御室の運用・弁操作）</option>
                  </select>
                </label>
              </div>
              {baselineMode === "operation" && (
                <p className="mt-2 text-xs text-zinc-500">
                  {hasCurrentState
                    ? [
                        ...operations.map((o) => describeOperation(o)),
                        ...(Object.keys(overrides).length ? [`手動変更 ${Object.keys(overrides).length}弁`] : []),
                      ].join(" ／ ")
                    : "制御室で運用・弁操作が入力されていないため、待機状態を使用しています。"}
                </p>
              )}
              <div className="mt-3 flex gap-2">
                <button onClick={reset} className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs dark:border-zinc-700">
                  新規（クリア）
                </button>
                {extraSectionIds.length > 0 && (
                  <button
                    onClick={() => setExtraSectionIds([])}
                    className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs dark:border-zinc-700"
                  >
                    手動調整を解除（{extraSectionIds.length}区間）
                  </button>
                )}
              </div>
            </Panel>

            {iso && (
              <>
                <Panel title="遮断範囲の算定結果">
                  {iso.errors.map((e) => (
                    <p key={e} className="mb-1 rounded bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
                      {e}
                    </p>
                  ))}
                  {iso.notes.map((n) => (
                    <p key={n} className="mb-1 rounded bg-sky-50 px-2 py-1 text-xs text-sky-800 dark:bg-sky-950 dark:text-sky-200">
                      {n}
                    </p>
                  ))}
                  <dl className="grid grid-cols-3 gap-2 text-center">
                    <Stat label="遮断弁（閉）" value={iso.boundaryValves.length} color="text-red-600" />
                    <Stat label="範囲内弁（開）" value={iso.internalValves.length} color="text-emerald-600" />
                    <Stat label="ドレン口" value={iso.drains.length} color="text-sky-600" />
                  </dl>
                  <p className="mt-2 text-xs text-zinc-500">遮断弁：{iso.boundaryValves.join("、") || "—"}</p>
                  {conflicts.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {conflicts.map((c) => (
                        <li key={c} className="rounded bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
                          ⚠ 運用との干渉：{c}
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>

                <Panel title={`液封チェック（${iso.sealGroups.length ? `${iso.sealGroups.length}区間に注意` : "問題なし"}）`}>
                  {iso.sealGroups.length === 0 ? (
                    <p className="text-sm text-emerald-700 dark:text-emerald-400">
                      遮断後も、隣接区間はすべて安全弁またはタンクに逃げ道があります。
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {iso.sealGroups.map((s, i) => (
                        <li
                          key={i}
                          onMouseEnter={() => setFocusSeal(i)}
                          onMouseLeave={() => setFocusSeal(null)}
                          onClick={() => setFocusSeal(focusSeal === i ? null : i)}
                          className={`cursor-pointer rounded-lg border p-2 text-xs ${
                            focusSeal === i ? "border-amber-500 bg-amber-50 dark:bg-amber-950" : "border-amber-200 dark:border-amber-900"
                          }`}
                        >
                          <p className="font-medium text-amber-800 dark:text-amber-300">
                            {s.preexisting ? "既存の液封区間" : "遮断により液封区間が発生"}（{formatLiters(s.volumeL)}）
                          </p>
                          <p className="mt-0.5 text-zinc-600 dark:text-zinc-400">
                            隣接する遮断弁：{s.adjacentBoundary.join("、")}。安全弁・タンクへの逃げ道がなく、温度上昇で圧力が上がる恐れがあります。
                          </p>
                          {s.ventValves.length > 0 && (
                            <p className="mt-0.5 text-zinc-600 dark:text-zinc-400">
                              回避策：{s.ventValves.slice(0, 4).join("、")}
                              {s.ventValves.length > 4 ? ` ほか${s.ventValves.length - 4}弁` : ""} のいずれかを開けるとタンク／安全弁側へ逃がせます。
                            </p>
                          )}
                          <div className="mt-1">
                            <span className="text-zinc-500">圧力計取付候補：</span>
                            {s.gaugeCandidates.length === 0 ? (
                              <span className="font-medium text-red-600"> 取付可能な箇所がありません（要検討）</span>
                            ) : (
                              s.gaugeCandidates.map((c) => (
                                <label key={c} className="ml-2 inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                                  <input
                                    type="checkbox"
                                    checked={gaugeIds.includes(c)}
                                    onChange={(e) =>
                                      setGaugeIds((p) => (e.target.checked ? [...p, c] : p.filter((x) => x !== c)))
                                    }
                                  />
                                  {c}
                                </label>
                              ))
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>

                <Panel title="抜取量・抜取時間の試算">
                  <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
                    {formatLiters(iso.volumeL)}
                    <span className="ml-2 text-xs font-normal text-zinc-500">
                      （配管 {formatLiters(iso.volumeL - equipmentVolume)} ＋ 機器 {formatLiters(equipmentVolume)}）
                    </span>
                  </p>
                  <table className="mt-2 w-full text-xs">
                    <thead className="text-zinc-500">
                      <tr>
                        <th className="text-left font-normal">使用</th>
                        <th className="text-left font-normal">ドレン口</th>
                        <th className="text-left font-normal">方式</th>
                        <th className="text-right font-normal">能力</th>
                      </tr>
                    </thead>
                    <tbody>
                      {iso.drains.map((d) => {
                        const n = g.nodeById.get(d)!;
                        const on = !excludedDrains.includes(d);
                        return (
                          <tr key={d} className="border-t border-zinc-100 dark:border-zinc-800">
                            <td>
                              <input
                                type="checkbox"
                                checked={on}
                                onChange={(e) =>
                                  setExcludedDrains((p) => (e.target.checked ? p.filter((x) => x !== d) : [...p, d]))
                                }
                              />
                            </td>
                            <td title={n.name}>{d}</td>
                            <td>{n.drainPumpLpm ? "抜取ポンプ" : `自然流下 ${n.drainSizeA}A`}</td>
                            <td className="text-right">{n.drainPumpLpm ?? GRAVITY_LPM[n.drainSizeA ?? 50]} L/min</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {estimate && (
                    <div className="mt-2 space-y-1 text-sm">
                      <p>
                        設置設備での抜取：<b>{formatMinutes(estimate.minutes)}</b>
                        <span className="text-xs text-zinc-500">（合計 {estimate.totalLpm} L/min）</span>
                      </p>
                      <p className="flex items-center gap-1">
                        可搬ポンプ使用時：<b>{formatMinutes(estimate.portableMinutes)}</b>
                        <input
                          type="number"
                          value={portableLpm}
                          min={10}
                          step={10}
                          onChange={(e) => setPortableLpm(Number(e.target.value))}
                          className="ml-2 w-20 rounded border border-zinc-300 bg-transparent px-1 text-xs dark:border-zinc-700"
                        />
                        <span className="text-xs text-zinc-500">L/min</span>
                      </p>
                      <p className="text-xs text-zinc-500">
                        受け容器の目安：ドラム缶（200L）{estimate.drums}本 ／ ローリー（16kL）{estimate.lorries}台
                      </p>
                      <div className="mt-2 border-t border-zinc-100 pt-2 dark:border-zinc-800">
                        <p className="text-xs font-semibold text-teal-700 dark:text-teal-400">作業後の充填</p>
                        {iso.fill.method === "none" ? (
                          <p className="text-xs text-red-600">充填方法が見つかりません（仮設ラインなどを検討してください）。</p>
                        ) : (
                          <>
                            <p className="text-xs text-zinc-600 dark:text-zinc-400">
                              {iso.fill.method === "line"
                                ? `充填ライン：${iso.fill.openValves.join(" → ")}（移送ポンプで送油）`
                                : `遮断弁の微開：${iso.fill.openValves.join("・")}`}
                            </p>
                            {iso.fill.method === "line" && (
                              <p className="text-xs text-teal-700 dark:text-teal-400">
                                充填元タンク・移送ポンプは、当日の運用に合わせて ② 現場点検・③ 制御室で選択します。
                              </p>
                            )}
                            <p className="flex items-center gap-1">
                              充填時間：<b>{formatMinutes(fillLpm > 0 ? iso.volumeL / fillLpm : null)}</b>
                              <input
                                type="number"
                                value={fillLpm}
                                min={10}
                                step={10}
                                onChange={(e) => setFillLpm(Number(e.target.value))}
                                className="ml-2 w-20 rounded border border-zinc-300 bg-transparent px-1 text-xs dark:border-zinc-700"
                              />
                              <span className="text-xs text-zinc-500">L/min</span>
                            </p>
                            <p className="text-[11px] text-zinc-400">
                              ※静電気対策のため初期は低流速、エア抜きしながら充填する前提の目安です。
                            </p>
                          </>
                        )}
                      </div>
                      <p className="text-[11px] text-zinc-400">
                        ※配管長は図面縮尺（1px＝{g.facility.metersPerPx}m）からの概算、内径はSch40相当。自然流下の能力は口径別の目安値です。
                      </p>
                    </div>
                  )}
                </Panel>

              </>
            )}


            {isDay && (
              <Panel title="当日の運用（例）">
                {workType === "flush" ? (
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <PickSelect label="送り元タンク" value={flushSrc} options={TANKS} onChange={setFlushSrc} />
                    <PickSelect
                      label="使用ポンプ"
                      value={effFlushPump ?? ""}
                      options={flushPumpOptions}
                      onChange={setFlushPump}
                    />
                    <PickSelect label="戻り先タンク" value={flushRet} options={TANKS} onChange={setFlushRet} />
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <PickSelect
                      label="移送先タンク"
                      value={effDest}
                      options={TANKS.filter((t) => t !== isoTank)}
                      onChange={setDestTank}
                    />
                    <PickSelect label="払出ポンプ" value={effIssuePump ?? ""} options={issuePumpOptions} onChange={setIssuePump} />
                    <PickSelect
                      label="移送ポンプ"
                      value={effTransferPump ?? ""}
                      options={transferPumpOptions}
                      onChange={setTransferPump}
                    />
                  </div>
                )}
                <p className="mt-2 text-[11px] text-zinc-500">
                  {workType === "flush"
                    ? "ポンプは末端部につながっているラインのもの（払出・移送を問わず）から選べます。"
                    : "払出系統（払出ポンプ → バイパス → 受入ライン）で移送し、吸えなくなったら移送系統（移送ポンプ → 受入ライン）で残りを移送します。"}
                  実際のタンク・ポンプは当日の運用に合わせて ② 現場点検・③ 制御室で選び直せます（ここでの選択は初期値）。
                </p>
                {workType === "flush" && flushT && (
                  <p className="mt-2 text-sm">
                    末端部の容量 <b>{formatLiters(flushT.volumeL)}</b> ／ 循環量の目安（{FLUSH_TURNOVER}倍）
                    <b> {formatLiters(flushT.volumeL * FLUSH_TURNOVER)}</b>
                  </p>
                )}
                {dayError && (
                  <p className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">{dayError}</p>
                )}
                {dayResult && !dayResult.error && (
                  <ol className="mt-2 space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
                    {steps.map((st, i) =>
                      dayResult.stepNotes[i] ? (
                        <li key={st}>
                          <b className="text-zinc-800 dark:text-zinc-200">{st}：</b>
                          {dayResult.stepNotes[i]}
                        </li>
                      ) : null
                    )}
                  </ol>
                )}
              </Panel>
            )}

            {rows.length > 0 && (
              <>
                <Panel title={`チェックリスト（${rows.length}弁）`}>
                  <div className="max-h-80 overflow-auto">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-white text-zinc-500 dark:bg-zinc-950">
                        <tr>
                          <th className="py-1 text-left font-normal">バルブ</th>
                          <th className="text-left font-normal">区分</th>
                          {steps.map((s) => (
                            <th key={s} className="text-center font-normal">
                              {s}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.code} className="border-t border-zinc-100 dark:border-zinc-800">
                            <td className="py-1" title={r.note ? `${r.name}（${r.note}）` : r.name}>
                              <button
                                onClick={() => r.nodeId && diagramRef.current?.focusNode(r.nodeId)}
                                className="text-sky-700 hover:underline dark:text-sky-400"
                              >
                                {r.code}
                              </button>
                              {r.note && <span className="ml-0.5 text-amber-600">※</span>}
                            </td>
                            <td className="text-zinc-500">{ROLE_LABEL[r.role]}</td>
                            {r.states.map((s, i) => (
                              <td key={i} className="text-center">
                                <span
                                  className={`inline-block w-6 rounded ${
                                    !s
                                      ? "text-zinc-300 dark:text-zinc-700"
                                      : isOperateCell(r, i)
                                        ? s === "open"
                                          ? "bg-emerald-500 text-white"
                                          : "bg-red-500 text-white"
                                        : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800"
                                  }`}
                                >
                                  {rowGlyph(r, s, i)}
                                </span>
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-1 text-[11px] text-zinc-400">色付き＝その工程で操作（状態が変わる）、灰色＝確認のみ。</p>
                </Panel>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={save}
                    disabled={!rows.length}
                    className="col-span-2 rounded-lg bg-emerald-700 py-2.5 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
                  >
                    {editingId ? "チェックリストを上書き保存" : "チェックリストとして保存"}
                  </button>
                  <button
                    onClick={exportExcel}
                    disabled={!rows.length}
                    className="rounded-lg border border-zinc-300 py-2 text-xs dark:border-zinc-700"
                  >
                    Excel出力（既存の手順チェックリスト形式）
                  </button>
                  <button
                    onClick={exportEquipment}
                    disabled={!rows.length}
                    className="rounded-lg border border-zinc-300 py-2 text-xs dark:border-zinc-700"
                  >
                    Excel出力（機器マスター形式）
                  </button>
                </div>
              </>
            )}

            <Panel title={`保存済みチェックリスト（${plannerPlans.length}）`}>
              {plannerPlans.length === 0 ? (
                <p className="text-sm text-zinc-400">まだありません。</p>
              ) : (
                <ul className="space-y-1.5">
                  {plannerPlans.map((p) => (
                    <li key={p.id} className="flex items-center gap-2 text-sm">
                      <span className="shrink-0 rounded bg-zinc-100 px-1.5 text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                        {workTypeOf(p) === "drain" ? "抜取" : workTypeOf(p) === "flush" ? "末端部" : "縁切り"}
                      </span>
                      <button onClick={() => loadPlan(p)} className="flex-1 truncate text-left hover:underline" title={p.name}>
                        {p.name}
                      </button>
                      <span className="text-xs text-zinc-500">{p.summary.volumeL ? formatLiters(p.summary.volumeL) : ""}</span>
                      <a href={`/piping/print?plan=${p.id}`} target="_blank" rel="noreferrer" className="text-xs text-sky-700 underline">
                        PDF
                      </a>
                      <button
                        onClick={() => {
                          if (confirm(`「${p.name}」を削除しますか？（元に戻せません）`)) act({ action: "deletePlan", id: p.id });
                        }}
                        className="text-xs text-red-600"
                      >
                        削除
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <Link href="/piping/field" className="mt-3 block text-center text-sm text-emerald-700 hover:underline dark:text-emerald-400">
                → 現場点検（図面ビュー）へ
              </Link>
            </Panel>
          </aside>
        </div>
      </div>
    </main>
  );
}

function PickSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="space-y-1">
      <span className="text-zinc-500">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={!options.length}
        className="w-full rounded border border-zinc-300 bg-transparent px-1.5 py-1 disabled:opacity-40 dark:border-zinc-700"
      >
        {!options.length && <option value="">（なし）</option>}
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    </label>
  );
}

/** 末端部の配管・縁切りするタンクの選択状況 */
function DayTargetPanel({
  g,
  workType,
  flushPipes,
  setFlushPipes,
  flushT,
  isoTank,
  pipeLabel,
}: {
  g: ReturnType<typeof useGraph>;
  workType: WorkType;
  flushPipes: string[];
  setFlushPipes: (f: (p: string[]) => string[]) => void;
  flushT: ReturnType<typeof flushTarget> | null;
  isoTank: string | null;
  pipeLabel: (id: string) => string;
}) {
  if (workType === "tankIsolation") {
    return (
      <div className="mt-3">
        <p className="text-xs font-medium text-zinc-500">縁切りするタンク（図面のタンクをクリック）</p>
        <p className="mt-1 text-sm">
          {isoTank ? (
            <span className="rounded-full bg-cyan-100 px-2.5 py-0.5 text-cyan-900 dark:bg-cyan-950 dark:text-cyan-200">
              {g.nodeById.get(isoTank)!.name}
            </span>
          ) : (
            <span className="text-zinc-400">未選択</span>
          )}
        </p>
      </div>
    );
  }
  return (
    <div className="mt-3">
      <p className="text-xs font-medium text-zinc-500">末端部（図面の配管をクリック。弁で区切られた区間ごとに選ばれます）</p>
      {flushPipes.length === 0 ? (
        <p className="mt-1 text-sm text-zinc-400">未選択（例：払出系統のバイパスライン、払出連絡管）</p>
      ) : (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {flushPipes.map((id) => (
            <button
              key={id}
              onClick={() => setFlushPipes((p) => p.filter((x) => x !== id))}
              className="rounded-full bg-cyan-100 px-2.5 py-0.5 text-xs text-cyan-900 hover:bg-cyan-200 dark:bg-cyan-950 dark:text-cyan-200"
            >
              {pipeLabel(id)} ×
            </button>
          ))}
        </div>
      )}
      {flushT && <p className="mt-1 text-xs text-zinc-500">区間の出入口の弁：{flushT.ends.join("、")}</p>}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <h2 className="mb-2 text-sm font-semibold text-zinc-800 dark:text-zinc-200">{title}</h2>
      {children}
    </section>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-lg bg-zinc-50 py-2 dark:bg-zinc-900">
      <dd className={`text-xl font-semibold ${color}`}>{value}</dd>
      <dt className="text-[11px] text-zinc-500">{label}</dt>
    </div>
  );
}
