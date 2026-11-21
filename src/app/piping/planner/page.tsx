"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import PlanApproval from "@/components/piping/PlanApproval";
import ApprovalBoard from "@/components/piping/ApprovalBoard";
import { approvalStages, isApprover } from "@/lib/piping/approval";
import { PERIOD_MAX, periodOptions } from "@/lib/piping/period";
import { useMe } from "@/lib/auth";
import { can } from "@/lib/roles";
import PipingDiagram, { DiagramLegend, type DiagramHandle, type NodeMark, type PipeLayer } from "@/components/piping/PipingDiagram";
import PlanPreview from "@/components/piping/PlanPreview";
import { normalValveState, otherSide } from "@/lib/piping/graph";
import {
  estimateDrain,
  formatLiters,
  formatMinutes,
  DEFAULT_FILL_LPM,
  planIsolation,
  type Target,
} from "@/lib/piping/isolation";
import { currentValveState, describeOperation, OPERATION_META, TANKS, type OperationKind } from "@/lib/piping/operations";
import { planConflicts } from "@/lib/piping/execution";
import { flowColor, routeFlowGroups, stepFlow, type RouteFlowKind } from "@/lib/piping/flow";
import {
  ALL_PUMPS,
  buildDayChecklist,
  FLUSH_STEPS,
  flushPumps,
  flushTarget,
  ISOLATION_STEPS,
  isolationIssueRoute,
  isolationTransferRoute,
  buildTankTransfer,
  tankTransferPumps,
  transferTanks,
  TRANSFER_STEPS,
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
import { DEFAULT_FACILITY, useDiagramInfo, useGraph, usePipingStore, useSiteRoles } from "@/lib/piping/usePiping";
import { buildFireTestChecklist, FIRE_TEST_STEPS, fireTestTanks } from "@/lib/piping/fireTest";
import {
  blockMethodOf,
  blocksOf,
  customStepsOf,
  drainRulesOf,
  fireTestRulesOf,
  fireTestSteps,
  flushRulesOf,
  isolationRulesOf,
  type CustomWorkType,
} from "@/lib/piping/rules";
import { applyBlocks, buildCustomChecklist, isoParts } from "@/lib/piping/ruleBlocks";
import { unionRoute } from "@/lib/piping/fireTest";
import type { NodeKind } from "@/lib/piping/types";

const TARGET_KINDS: NodeKind[] = ["strainer", "filter", "sampler", "pump", "transferPump", "valve", "check", "tank"];
const STEPS_OF: Record<WorkType, string[]> = {
  drain: PLAN_STEPS,
  flush: FLUSH_STEPS,
  tankIsolation: ISOLATION_STEPS,
  tankTransfer: TRANSFER_STEPS,
  fireTest: FIRE_TEST_STEPS,
  custom: [],
};
const TYPE_TAG: Record<WorkType, string> = {
  drain: "抜取",
  flush: "末端部",
  tankIsolation: "縁切り",
  tankTransfer: "移送",
  fireTest: "消火試験",
  custom: "独自",
};
const yardOf = (tank: string) => tank.slice(2, 3);

export default function PlannerPage() {
  // ⑤ ルールへのリンクは管理者だけに出す
  const me = useMe();
  // 権限は選択中の拠点での権限（拠点ごとに担当者が違う）
  const siteRoles = useSiteRoles();
  const isAdmin = can(siteRoles, "rules");
  // ① の作成は作業者（現場担当者）だけ。チームリーダー・G長・制御室は承認の画面になる
  const canCreate = can(siteRoles, "create");
  const g = useGraph();
  const diagramInfo = useDiagramInfo();
  const { store, act } = usePipingStore(0);
  // チェックリスト作成のルール（⑤ で拠点ごとに登録。未登録の項目は既定値）
  const storeRules = store?.rules;
  const fireRules = useMemo(() => fireTestRulesOf(storeRules), [storeRules]);
  const drainRules = useMemo(() => drainRulesOf(storeRules), [storeRules]);
  const flushRules = useMemo(() => flushRulesOf(storeRules), [storeRules]);
  const isoRules = useMemo(() => isolationRulesOf(storeRules), [storeRules]);
  const blockMethod = useMemo(() => blockMethodOf(storeRules), [storeRules]);
  const customTypes = useMemo(() => storeRules?.customTypes ?? [], [storeRules]);

  const [name, setName] = useState("");
  // 点検の周期（月次・年次など。② で「機器名×周期」で探すのに使う）
  const [period, setPeriod] = useState("");
  const [workType, setWorkType] = useState<WorkType>("drain");
  // 燃料末端部作業：末端部として選んだ配管、タンク縁切り：対象タンク
  const [flushPipes, setFlushPipes] = useState<string[]>([]);
  const [isoTank, setIsoTank] = useState<string | null>(null);
  // 消火設備機能試験：試験対象タンク
  const [fireTank, setFireTank] = useState<string | null>(null);
  // タンク間移送：移送元・移送先タンクと使うポンプ（undefined＝自動で選ぶ、null＝ポンプなし（自然流下））
  const [trSrc, setTrSrc] = useState<string | null>(null);
  const [trDest, setTrDest] = useState<string | null>(null);
  const [trPump, setTrPump] = useState<string | null | undefined>(undefined);
  // ユーザー定義の作業：選んだ作業・対象（保存済みを開いたときは、その時点の定義も持つ）
  const [customId, setCustomId] = useState<string | null>(null);
  const [customTarget, setCustomTarget] = useState<string | null>(null);
  const [loadedCustom, setLoadedCustom] = useState<CustomWorkType | null>(null);
  // 当日の選択の例（保存すると現場・制御室の選択欄の初期値になる）
  const [flushSrc, setFlushSrc] = useState("T-101");
  const [flushRet, setFlushRet] = useState("T-102");
  const [flushPump, setFlushPump] = useState("P-11");
  const [destTank, setDestTank] = useState("T-102");
  const [issuePump, setIssuePump] = useState("P-11");
  const [transferPump, setTransferPump] = useState("TP-1");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [expandToDrainS, setExpandToDrain] = useState<boolean | null>(null);
  const [baselineMode, setBaselineMode] = useState<"normal" | "operation">("normal");
  const [extraSectionIds, setExtraSectionIds] = useState<string[]>([]);
  const [excludedDrains, setExcludedDrains] = useState<string[]>([]);
  const [gaugeIds, setGaugeIds] = useState<string[]>([]);
  const [lorryLpmS, setLorryLpm] = useState<number | null>(null);
  const [fillLpmS, setFillLpm] = useState<number | null>(null);
  // 未入力ならルールの値
  const expandToDrain = expandToDrainS ?? drainRules.expandToDrain;
  const lorryLpm = lorryLpmS ?? drainRules.lorryLpm;
  const fillLpm = fillLpmS ?? drainRules.fillLpm;
  // ローリーの設定（台数・容量は ⑤、抜取能力はここで変えられる）
  const lorry = useMemo(
    () => ({ lpm: lorryLpm, capacityKL: drainRules.lorryCapacityKL, count: drainRules.lorryCount }),
    [lorryLpm, drainRules]
  );
  const [mode, setMode] = useState<"target" | "expand">("target");
  const [previewStep, setPreviewStep] = useState(0);
  const [focusSeal, setFocusSeal] = useState<number | null>(null);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  // ② 現場点検と同じ表示で、作成中のチェックリストを確認する
  const [previewPlan, setPreviewPlan] = useState<SavedPlan | null>(null);
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

  const customDef = customTypes.find((t) => t.id === customId) ?? (loadedCustom?.id === customId ? loadedCustom : null);
  const isDay = workType !== "drain";
  // ユーザー定義の作業で計算の部品「循環経路」を使うもの（末端部の配管を選び、当日のタンク・ポンプを選ぶ）
  const customFlush = workType === "custom" && customDef?.calc?.kind === "flush";
  // ユーザー定義の作業で計算の部品「移送経路」を使うもの（対象タンクを選び、当日の移送先・ポンプを選ぶ）
  const customTransfer = workType === "custom" && customDef?.calc?.kind === "transfer";
  const steps = useMemo(
    () =>
      workType === "fireTest" ? fireTestSteps(fireRules) : workType === "custom" ? (customDef ? customStepsOf(customDef) : ["作業前"]) : STEPS_OF[workType],
    [workType, fireRules, customDef]
  );
  const iso = useMemo(
    () =>
      !isDay && (targets.length || extraSectionIds.length)
        ? planIsolation(g, targets, { baseline, expandToDrain, extraSectionIds })
        : null,
    [g, isDay, targets, baseline, expandToDrain, extraSectionIds]
  );

  // ───── 燃料末端部作業・タンク縁切り：当日の選択（例）から作るチェックリスト ─────
  const flushT = useMemo(
    () => ((workType === "flush" || customFlush) && flushPipes.length ? flushTarget(g, flushPipes) : null),
    [g, workType, customFlush, flushPipes]
  );
  const flushPumpOptions = useMemo(
    () => (flushT ? flushPumps(g, flushPipes, flushSrc, flushRet) : []),
    [g, flushT, flushPipes, flushSrc, flushRet]
  );
  const effFlushPump = flushPumpOptions.includes(flushPump) ? flushPump : flushPumpOptions[0];
  // 移送経路を使う作業の対象タンク（タンク縁切り、または計算の部品「移送経路」を使うユーザー定義の作業）
  const tTank = workType === "tankIsolation" ? isoTank : customTransfer ? customTarget : null;
  const effDest =
    tTank && destTank === tTank ? TANKS.find((t) => t !== tTank && yardOf(t) === yardOf(tTank)) ?? destTank : destTank;
  const issuePumpOptions = useMemo(
    () =>
      tTank
        ? ALL_PUMPS(g).filter((p) => g.nodeById.get(p)!.kind === "pump" && isolationIssueRoute(g, tTank, effDest, p))
        : [],
    [g, tTank, effDest]
  );
  const transferPumpOptions = useMemo(
    () =>
      tTank
        ? ALL_PUMPS(g).filter((p) => g.nodeById.get(p)!.kind === "transferPump" && isolationTransferRoute(g, tTank, effDest, p))
        : [],
    [g, tTank, effDest]
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
  const fireTanks = useMemo(() => fireTestTanks(g), [g]);
  // ───── タンク間移送：移送元 → ポンプ → 移送先 の経路（作成時に決める） ─────
  const allTanks = useMemo(() => transferTanks(g), [g]);
  const trPumpOptions = useMemo(
    () => (workType === "tankTransfer" && trSrc && trDest ? tankTransferPumps(g, trSrc, trDest) : []),
    [g, workType, trSrc, trDest]
  );
  const effTrPump: string | null | undefined = trPumpOptions.length
    ? trPump !== undefined && trPumpOptions.includes(trPump)
      ? trPump
      : trPumpOptions[0]
    : undefined;
  const transferResult = useMemo(
    () =>
      workType === "tankTransfer" && trSrc && trDest && effTrPump !== undefined
        ? buildTankTransfer(g, { src: trSrc, dest: trDest, pump: effTrPump }, baseline, { blockMethod })
        : null,
    [g, workType, trSrc, trDest, effTrPump, baseline, blockMethod]
  );
  const fireResult = useMemo(
    () => (workType === "fireTest" && fireTank ? buildFireTestChecklist(g, fireTank, baseline, fireRules, blockMethod) : null),
    [g, workType, fireTank, baseline, fireRules, blockMethod]
  );
  const dayResultOf = useMemo(() => {
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
      baseline,
      { flush: flushRules, tankIsolation: isoRules, blockMethod }
    );
  }, [g, dayKey, steps, flushPipes, isoTank, flushT, baseline, flushRules, isoRules, blockMethod]);
  const customResult = useMemo(
    () =>
      workType === "custom" && customDef
        ? buildCustomChecklist(g, customDef, customTarget, baseline, {
            lorry,
            flushPipes,
            day: customFlush && effFlushPump ? { srcTank: flushSrc, pump: effFlushPump, returnTank: flushRet } : undefined,
            transferDay:
              customTransfer && effIssuePump && effTransferPump ? { destTank: effDest, issuePump: effIssuePump, transferPump: effTransferPump } : undefined,
          })
        : null,
    [g, workType, customDef, customTarget, baseline, lorry, flushPipes, customFlush, effFlushPump, flushSrc, flushRet, customTransfer, effDest, effIssuePump, effTransferPump]
  );
  const dayResult =
    workType === "fireTest" ? fireResult : workType === "custom" ? customResult : workType === "tankTransfer" ? transferResult : dayResultOf;
  const dayError =
    workType === "tankTransfer" && trSrc && trDest && effTrPump === undefined
      ? "移送元から移送先へ送る経路が見つかりません（ポンプ・逆止弁の向きと、つながりを確認してください）"
      : (workType === "flush" || customFlush) && flushT && !effFlushPump
      ? "送り元・戻り先タンクから末端部へ届くポンプがありません"
      : (workType === "tankIsolation" || customTransfer) && tTank && (!effIssuePump || !effTransferPump)
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
    () => {
      if (!iso) return { rows: [], warnings: [] as string[] };
      const warnings: string[] = [];
      const rows = buildPlanRows(g, iso, baseline, drains, activeGauges, {
        openInternal: drainRules.openInternal,
        crackFillWithoutLine: drainRules.crackFillWithoutLine,
        blockMethod,
        warnings,
      });
      return { rows, warnings };
    },
    [g, iso, baseline, drains, activeGauges, drainRules, blockMethod]
  );
  const dayRows = dayResult?.rows;
  const rawRows = useMemo(() => (isDay ? dayRows ?? [] : drainRows.rows), [isDay, dayRows, drainRows]);
  // 作業種別ごとの追加ルール（ブロック）を当てはめる（ユーザー定義の作業は作成時に当てはめ済み）
  // タンク間移送には ⑤ の追加ルールが無い
  const builtinBlocks = useMemo(
    () => (workType === "custom" || workType === "tankTransfer" ? [] : blocksOf(storeRules, workType)),
    [workType, storeRules]
  );
  const blockTarget =
    workType === "fireTest"
      ? fireTank
      : workType === "tankIsolation"
        ? isoTank
        : workType === "drain"
          ? targets.find((t) => t.type === "node")?.id ?? null
          : null;
  const dayRoutes = dayResult?.stepRoutes;
  const blockApplied = useMemo(() => {
    if (!builtinBlocks.length || !rawRows.length) return { rows: rawRows, warnings: [] as string[] };
    const routes = Object.values(dayRoutes ?? {});
    const route =
      workType === "drain" && iso
        ? { nodeIds: iso.regionNodeIds, pipeIds: iso.regionPipeIds }
        : routes.length
          ? unionRoute(routes)
          : null;
    // 燃料抜取では、遮断範囲の計算結果（遮断弁・ドレン口など）も追加ルールの条件に使える
    const calc = workType === "drain" && iso ? isoParts(g, iso) : null;
    return applyBlocks(g, rawRows, steps, builtinBlocks, { target: blockTarget, route, base: baseline, calc });
  }, [g, rawRows, steps, builtinBlocks, blockTarget, dayRoutes, workType, iso, baseline]);
  const rows = blockApplied.rows;
  const boundaryRows = rows.filter((r) => r.role === "boundary" || r.role === "fill").filter((r) => r.states[1] === "close");
  const ruleWarnings = [...(isDay ? [] : drainRows.warnings), ...blockApplied.warnings, ...(customResult?.warnings ?? [])];
  const appliedRules = { flush: flushRules, tankIsolation: isoRules, blocks: builtinBlocks, blockMethod };
  // 制御室で入力中の運用との干渉
  const conflicts = useMemo(
    () =>
      iso && hasCurrentState
        ? planConflicts({ rows, regionPipeIds: iso.regionPipeIds }, opState, (k) => OPERATION_META[k as OperationKind].label)
        : [],
    [iso, rows, hasCurrentState, opState]
  );
  const estimate = useMemo(
    () => (iso ? estimateDrain(g, drains, iso.volumeL, lorry) : null),
    [g, iso, drains, lorry]
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
  // 燃料末端部作業・タンク縁切り・消火設備機能試験・ユーザー定義の作業：工程ごとの経路を流れの種類ごとにまとめる
  const routeKind: RouteFlowKind =
    workType === "flush" || customFlush
      ? "flush"
      : workType === "tankTransfer"
        ? "tankTransfer"
      : workType === "tankIsolation" || customTransfer
        ? "transfer"
        : workType === "fireTest" || (workType === "custom" && customDef?.calc?.kind === "fireTest")
          ? "fire"
          : "route";
  const dayStepRoutes = dayResult?.stepRoutes;
  const routeFlows = useMemo(
    () => (isDay ? routeFlowGroups(dayStepRoutes, steps, routeKind) : []),
    [isDay, dayStepRoutes, steps, routeKind]
  );
  // ユーザー定義の作業で計算の部品「遮断範囲」を使うとき：工程名が「抜取」「充填」の工程の流れ（燃料抜取と同じ求め方）
  const customIsoR = workType === "custom" ? customResult?.iso : undefined;
  const customIsoFlows = useMemo(() => {
    if (!customIsoR) return [];
    const plan = {
      steps,
      rows,
      regionPipeIds: customIsoR.regionPipeIds,
      regionNodeIds: customIsoR.regionNodeIds,
      fillPipeIds: customIsoR.fillPipeIds,
    } as Parameters<typeof stepFlow>[1];
    // 抜取（青）・充填（緑）の工程の流れ。燃料抜取の工程ごとのプレビューと同じ求め方
    return steps.flatMap((name, i) => {
      if (name !== "抜取" && name !== "充填") return [];
      const f = stepFlow(g, plan, i, stateAtStep(baseline, rows, i));
      return f ? [{ key: `flow-${i}`, color: flowColor(f.kind), directions: f.directions }] : [];
    });
  }, [g, customIsoR, steps, rows, baseline]);
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
    // 2ブロック目など、チェックリストで遮断弁として閉める弁もすべて表示する
    rows.filter((r) => r.role === "boundary" && r.nodeId).forEach((r) => (marks[r.nodeId!] = "boundary"));
    iso.internalValves.forEach((v) => (marks[v] = "internal"));
    drains.forEach((d) => (marks[d] = "drain"));
    // 抜取で開ける弁（ドレン弁・抜取ポンプ側の弁）
    rows.filter((r) => r.role === "drain" && r.nodeId).forEach((r) => (marks[r.nodeId!] = "drain"));
    activeGauges.forEach((d) => (marks[d] = "gauge"));
    iso.fill.openValves.forEach((v) => (marks[v] = "fill"));
    if (focusSeal !== null) iso.sealGroups[focusSeal]?.ventValves.forEach((v) => (marks[v] = "vent"));
  }
  // ユーザー定義の作業で計算の部品「遮断範囲」を使うとき：範囲・充填・液封の区間を表示する
  const customIso = customIsoR;
  if (customIso) {
    layers.push({ key: "c-region", pipeIds: customIso.regionPipeIds, color: "#ef4444", opacity: 0.4 });
    layers.push({ key: "c-fill", pipeIds: customIso.fillPipeIds, color: "#0d9488", opacity: 0.6 });
    layers.push({ key: "c-seal", pipeIds: customIso.sealPipeIds, color: "#f59e0b", opacity: 0.55 });
    // 燃料抜取と同じく、抜取・充填の流れを向き付きで描く
    customIsoFlows.forEach((f) =>
      layers.push({ key: `c-${f.key}`, pipeIds: [...f.directions.keys()], directions: f.directions, color: f.color, width: 5, flow: true })
    );
  }
  if (isDay) {
    if (flushT) layers.push({ key: "flush-target", pipeIds: flushT.pipeIds, color: "#06b6d4", opacity: 0.5 });
    // 燃料抜取の「抜取の流れ」「充填ライン」と同じく、経路ごとの流れを種類別の色・向き付きで常に描く。
    // 表示中の工程が経路を使うときは、その経路を手前に強調し、ほかの経路は薄くする
    const active = routeFlows.find((f) => f.steps.includes(previewStep));
    [...routeFlows.filter((f) => f !== active), ...(active ? [active] : [])].forEach((f) =>
      layers.push({
        key: f.key,
        pipeIds: f.pipeIds,
        directions: f.directions,
        color: f.color,
        width: 5,
        opacity: !active || f === active ? 1 : 0.3,
        flow: !active || f === active,
      })
    );
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
    if (isoTank && workType === "tankIsolation") marks[isoTank] = "selected";
    if (fireTank && workType === "fireTest") marks[fireTank] = "selected";
    if (workType === "tankTransfer") [trSrc, trDest].forEach((t) => t && (marks[t] = "selected"));
    if (customTarget && workType === "custom") marks[customTarget] = "selected";
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
    if (workType === "fireTest") {
      if (fireTanks.includes(id)) setFireTank(id);
      return;
    }
    if (workType === "tankTransfer") {
      if (n.kind !== "tank") return;
      // 1回目のクリックで移送元、2回目で移送先。両方決まっていれば移送元から選び直す
      if (!trSrc || (trDest && trSrc !== id)) {
        setTrSrc(id);
        setTrDest(null);
      } else if (id !== trSrc) setTrDest(id);
      setTrPump(undefined);
      return;
    }
    if (workType === "custom") {
      if (customDef?.target === "tank" ? n.kind === "tank" : customDef?.target === "equipment" && TARGET_KINDS.includes(n.kind))
        setCustomTarget(id);
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
    if (workType === "flush" || customFlush) {
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
    setPeriod("");
    setTargets([]);
    setFlushPipes([]);
    setIsoTank(null);
    setFireTank(null);
    setTrSrc(null);
    setTrDest(null);
    setTrPump(undefined);
    setCustomTarget(null);
    setExtraSectionIds([]);
    setExcludedDrains([]);
    setGaugeIds([]);
    setPreviewStep(0);
    setFocusSeal(null);
  }

  function buildDayPlan(): SavedPlan | null {
    if (workType === "fireTest") return buildFirePlan();
    if (workType === "custom") return buildCustomPlan();
    if (workType === "tankTransfer") return buildTransferPlan();
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
      appliedRules,
      diagramVersionId: diagramInfo.versionId,
      targets: flush ? flushPipes.map((id) => ({ type: "pipe" as const, id })) : [{ type: "node", id: isoTank! }],
      regionPipeIds: flush ? flushT!.pipeIds : [],
      regionNodeIds: flush ? [] : [isoTank!],
      sealPipeIds: [],
      steps,
      rows,
      stepNotes: dayResult.stepNotes,
      stepRoutes: dayResult.stepRoutes,
      dayDefaults: dayParams,
      planner: { expandToDrain, baselineMode, extraSectionIds: [], excludedDrains: [], gaugeIds: [], lorryLpm, fillLpm },
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

  function buildCustomPlan(): SavedPlan | null {
    if (!customDef || !customResult || customResult.error || !rows.length) return null;
    const t = customTarget ? g.nodeById.get(customTarget) : null;
    return {
      id: editingId ?? newId(),
      name: name.trim() || `${customDef.name}${t ? `（${t.label}）` : ""}`,
      workType: "custom",
      purpose: customDef.name,
      customType: customDef,
      customTarget,
      createdAt: new Date().toISOString(),
      source: "planner",
      appliedRules,
      diagramVersionId: diagramInfo.versionId,
      targets: customResult.flush
        ? flushPipes.map((id) => ({ type: "pipe" as const, id }))
        : customTarget
          ? [{ type: "node", id: customTarget }]
          : [],
      // 循環経路：末端部の配管と、現場・制御室の選択欄の初期値（当日のタンク・ポンプ）
      ...(customResult.flush ? { flushPipeIds: flushPipes, dayDefaults: { kind: "flush" as const, ...customResult.flush.day } } : {}),
      // 移送経路：対象タンクと、現場・制御室の選択欄の初期値（当日の移送先・ポンプ）
      ...(customResult.transfer && customTarget
        ? { isolationTank: customTarget, dayDefaults: { kind: "tankIsolation" as const, ...customResult.transfer.day } }
        : {}),
      regionPipeIds: customResult.flush?.pipeIds ?? customResult.iso?.regionPipeIds ?? customResult.route?.pipeIds ?? [],
      regionNodeIds: customResult.iso?.regionNodeIds ?? (customTarget ? [customTarget] : []),
      sealPipeIds: customResult.iso?.sealPipeIds ?? [],
      // 遮断範囲で充填ラインを使うときは、燃料抜取と同じく当日に充填元を選ぶ
      ...(customResult.iso?.fillPipeIds.length ? { fillPipeIds: customResult.iso.fillPipeIds } : {}),
      steps,
      rows,
      stepNotes: customResult.stepNotes,
      stepRoutes: customResult.stepRoutes,
      planner: { expandToDrain, baselineMode, extraSectionIds: [], excludedDrains: [], gaugeIds: [], lorryLpm, fillLpm },
      summary: {
        volumeL: customResult.iso?.volumeL ?? customResult.flush?.volumeL ?? null,
        drainMinutes: customResult.iso?.drainMinutes ?? null,
        fillMinutes: customResult.iso?.fillMinutes ?? null,
        drains: customResult.iso?.drains ?? [],
        warnings: customResult.warnings,
        notes: [...(customDef.desc ? [customDef.desc] : []), ...(customResult.iso?.notes ?? []), ...(customResult.fire ? [customResult.fire.summary] : [])],
      },
    };
  }

  function buildTransferPlan(): SavedPlan | null {
    if (!transferResult || transferResult.error || !trSrc || !trDest || effTrPump === undefined || !rows.length) return null;
    const label = (id: string) => g.nodeById.get(id)?.label ?? id;
    const route = transferResult.stepRoutes[2];
    return {
      id: editingId ?? newId(),
      name: name.trim() || `タンク間移送（${label(trSrc)} → ${label(trDest)}）`,
      workType: "tankTransfer",
      purpose: WORK_TYPES.tankTransfer.label,
      tankTransfer: { src: trSrc, dest: trDest, pump: effTrPump },
      createdAt: new Date().toISOString(),
      source: "planner",
      appliedRules,
      diagramVersionId: diagramInfo.versionId,
      targets: [
        { type: "node", id: trSrc },
        { type: "node", id: trDest },
      ],
      // 移送経路の配管（運用中のライン・ほかの点検との重なりの判定に使う）
      regionPipeIds: route?.pipeIds ?? [],
      regionNodeIds: [trSrc, trDest],
      sealPipeIds: [],
      steps,
      rows,
      stepNotes: transferResult.stepNotes,
      stepRoutes: transferResult.stepRoutes,
      planner: { expandToDrain, baselineMode, extraSectionIds: [], excludedDrains: [], gaugeIds: [], lorryLpm, fillLpm },
      summary: {
        volumeL: null,
        drainMinutes: null,
        drains: [],
        warnings: [],
        notes: [
          `移送：${label(trSrc)} → ${label(trDest)}（${effTrPump ? `ポンプ ${label(effTrPump)}` : "ポンプなし・自然流下"}）。移送量は当日の液位で確認してください。`,
        ],
      },
    };
  }

  function buildFirePlan(): SavedPlan | null {
    if (!fireResult || fireResult.error || !fireTank || !rows.length) return null;
    const tankLabel = g.nodeById.get(fireTank)?.label ?? fireTank;
    const s = fireResult.summary!;
    return {
      id: editingId ?? newId(),
      name: name.trim() || `消火設備機能試験（${tankLabel}）`,
      workType: "fireTest",
      purpose: WORK_TYPES.fireTest.label,
      fireTestTank: fireTank,
      createdAt: new Date().toISOString(),
      source: "planner",
      appliedRules,
      diagramVersionId: diagramInfo.versionId,
      targets: [{ type: "node", id: fireTank }],
      regionPipeIds: [],
      regionNodeIds: [fireTank],
      sealPipeIds: [],
      steps,
      rows,
      stepNotes: fireResult.stepNotes,
      stepRoutes: fireResult.stepRoutes,
      planner: { expandToDrain, baselineMode, extraSectionIds: [], excludedDrains: [], gaugeIds: [], lorryLpm, fillLpm },
      summary: {
        volumeL: null,
        drainMinutes: null,
        drains: [],
        warnings: [],
        notes: [
          `使用設備：発泡装置 ${s.foamChambers.join("・")}／冷却散水 ${[...s.sprinklers, ...s.adjacent].join("・") || "なし"}／消火栓（水）${s.waterHydrants.join("・")}／泡消火栓 ${s.foamHydrants.join("・")}／ポンプ ${[s.pump, s.foamPump].filter(Boolean).join("・")}`,
        ],
      },
    };
  }

  /** チェックリストを組み立て、入力した周期を付ける */
  function buildPlan(): SavedPlan | null {
    const plan = buildPlanBody();
    const p = period.trim().slice(0, PERIOD_MAX);
    return plan && p ? { ...plan, period: p } : plan;
  }

  function buildPlanBody(): SavedPlan | null {
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
      appliedRules,
      diagramVersionId: diagramInfo.versionId,
      targets,
      regionPipeIds: iso.regionPipeIds,
      regionNodeIds: iso.regionNodeIds,
      sealPipeIds: iso.sealGroups.flatMap((s) => s.pipeIds),
      fillPipeIds: iso.fill.pipeIds,
      steps: PLAN_STEPS,
      rows,
      planner: { expandToDrain, baselineMode, extraSectionIds, excludedDrains, gaugeIds: activeGauges, lorryLpm, fillLpm },
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
      setMessage({ type: "ok", text: `「${plan.name}」を承認依頼しました（${approvalStages(store?.rules).length ? "チームリーダーの承認待ち" : ""}）。差し戻されたときは、この画面に表示されます。` });
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
    setPeriod(p.period ?? "");
    const type = workTypeOf(p);
    setWorkType(type);
    setTargets(type === "drain" ? p.targets : []);
    setFlushPipes(p.flushPipeIds ?? []);
    setIsoTank(p.isolationTank ?? null);
    setFireTank(p.fireTestTank ?? null);
    setTrSrc(p.tankTransfer?.src ?? null);
    setTrDest(p.tankTransfer?.dest ?? null);
    setTrPump(p.tankTransfer ? p.tankTransfer.pump : undefined);
    if (type === "custom" && p.customType) {
      setLoadedCustom(p.customType);
      setCustomId(p.customType.id);
      setCustomTarget(p.customTarget ?? null);
    }
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
      setLorryLpm(p.planner.lorryLpm ?? null);
      setFillLpm(p.planner.fillLpm ?? DEFAULT_FILL_LPM);
    }
    setPreviewStep(0);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }


  // 作成しない人（チームリーダー・G長・制御室）：承認の画面だけ
  if (me && siteRoles && !canCreate) {
    return (
      <main className="min-h-screen bg-zinc-50 px-4 py-6 dark:bg-black">
        <div className="mx-auto max-w-4xl">
          <Link href="/piping" className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400">
            ← 配管系統図メニュー
          </Link>
          <h1 className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">① チェックリスト確認・承認</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">現場担当者が作成したチェックリストを確認して、承認または差し戻しします。</p>
          <div className="mt-4">
            <ApprovalBoard graph={g} store={store} base={baseline} act={act} />
          </div>
        </div>
      </main>
    );
  }
  // 差し戻されたチェックリスト（作成者が直して承認依頼し直す）
  const rejectedPlans = (store?.plans ?? []).filter((p) => p.rejection);

  return (
    <main className="min-h-screen bg-zinc-50 px-4 py-6 dark:bg-black">
      <div className="mx-auto max-w-[1800px]">
        <Link href="/piping" className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400">
          ← 配管系統図メニュー
        </Link>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">① チェックリスト作成</h1>
          {/* プレビューは右上に置き、チェックリストが長くてもスクロールせずに押せるようにする */}
          <button
            onClick={() => setPreviewPlan(buildPlan())}
            disabled={!rows.length}
            title={rows.length ? "② 現場点検と同じ表示で、工程ごとに確認します" : "図面で対象を選ぶとプレビューできます"}
            className="rounded-lg border border-emerald-700 bg-white px-4 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-50 disabled:opacity-40 dark:bg-zinc-950 dark:text-emerald-300 dark:hover:bg-emerald-950"
          >
            👁 プレビュー（工程ごとに確認）
          </button>
        </div>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          {workType === "drain"
            ? "図面上で抜取対象の機器・配管をクリックしてください。ドレン口のある区間まで遮断範囲を自動算定し、操作バルブ・液封リスク・抜取量を表示します。"
            : workType === "flush"
              ? "図面上で末端部（通常使用しないライン）の配管をクリックしてください。つながっているラインのポンプで循環させる経路と操作バルブを作ります。"
              : workType === "custom"
                ? `${customDef?.name ?? "ユーザー定義の作業"}：${
                    customDef?.target === "tank" ? "図面上で対象のタンクをクリックしてください。" : customDef?.target === "equipment" ? "図面上で対象の機器をクリックしてください。" : customDef?.target === "pipes" ? "図面上で末端部の配管をクリックしてください。" : ""
                  }⑤ で組み立てた工程とルールでチェックリストを作ります。${customDef?.desc ? `（${customDef.desc}）` : ""}`
              : workType === "tankTransfer"
                ? "図面上で移送元のタンク、続けて移送先のタンクをクリックしてください（右の欄でも選べます）。ポンプ・逆止弁の向きに沿った移送経路を探し、経路の弁の開・分岐先の弁の閉、ポンプの起動・停止と復旧の操作を作ります。"
              : workType === "fireTest"
                ? `図面上で試験対象タンクをクリックしてください。登録したルール（⑤ チェックリスト作成のルール）に従い、発泡装置・冷却散水・近くの消火栓（泡${fireRules.foamHydrants}口・水${fireRules.waterHydrants}口）を使う試験の操作バルブを作ります。`
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
              onPipeClick={
                workType === "tankIsolation" || workType === "tankTransfer" || workType === "fireTest" || (workType === "custom" && !customFlush)
                  ? undefined
                  : handlePipeClick
              }
              clickableKinds={
                workType === "flush"
                  ? []
                  : workType === "custom"
                    ? customDef?.target === "tank"
                      ? ["tank"]
                      : customDef?.target === "equipment"
                        ? TARGET_KINDS
                        : []
                    : workType === "tankIsolation" || workType === "tankTransfer" || workType === "fireTest"
                      ? ["tank"]
                      : mode === "expand"
                        ? ["valve"]
                        : TARGET_KINDS
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
                { color: "#06b6d4", label: workType === "flush" ? "末端部（選択した区間）" : workType === "fireTest" ? "試験対象タンク" : workType === "custom" ? "対象" : "縁切りするタンク", kind: workType === "flush" ? "line" : "ring" },
                // 経路ごとの流れ（燃料抜取の「抜取の流れ（抜取系統）」と同じく、流れの種類と使う工程を並べる）
                ...routeFlows.map((f) => ({ color: f.color, label: f.label })),
                ...(customIso
                  ? [
                      { color: "#ef4444", label: "抜取範囲（遮断範囲）" },
                      ...(customIsoFlows.length ? [{ color: "#0284c7", label: "抜取の流れ（抜取系統）" }] : []),
                      { color: "#0d9488", label: "充填ライン" },
                      { color: "#f59e0b", label: "液封の恐れ" },
                    ]
                  : []),
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
                {(Object.keys(WORK_TYPES) as WorkType[])
                  // 末端部作業・タンク縁切りはタンク・ポンプの番号の付け方に合わせて作ってあるため、仮想施設だけ。
                  // 消火設備機能試験は、冷却散水・発泡装置の付いたタンクがある拠点だけ。ユーザー定義の作業は下に並べる
                  .filter((t) =>
                    t === "custom"
                      ? false
                      : t === "drain"
                        ? true
                        : t === "fireTest"
                          ? fireTanks.length > 0
                          : t === "tankTransfer"
                            ? allTanks.length >= 2
                            : diagramInfo.facilityId === DEFAULT_FACILITY
                  )
                  .map((t) => (
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
                {customTypes.map((c) => (
                  <button
                    key={c.id}
                    title={c.desc || "⑤ で作ったユーザー定義の作業"}
                    onClick={() => {
                      if (workType === "custom" && customId === c.id) return;
                      setWorkType("custom");
                      setCustomId(c.id);
                      setCustomTarget(null);
                      setEditingId(null);
                      setPreviewStep(0);
                      setMode("target");
                    }}
                    className={`rounded-lg border border-dashed px-2 py-1.5 text-xs leading-tight ${
                      workType === "custom" && customId === c.id
                        ? "border-cyan-600 bg-cyan-600 font-semibold text-white"
                        : "border-zinc-400 hover:bg-zinc-50 dark:border-zinc-600 dark:hover:bg-zinc-900"
                    }`}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
              {isAdmin && (
                <p className="mb-2 text-right text-[11px]">
                  <Link href="/piping/rules" className="text-sky-700 hover:underline dark:text-sky-400">
                    ⑤ ルールの変更・作業の追加
                  </Link>
                </p>
              )}
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="作業名（空欄なら自動）"
                className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm dark:border-zinc-700"
              />
              <div className="mt-1.5 flex items-center gap-2">
                <label htmlFor="plan-period" className="shrink-0 text-xs text-zinc-500">
                  周期
                </label>
                <input
                  id="plan-period"
                  list="plan-period-options"
                  value={period}
                  maxLength={PERIOD_MAX}
                  onChange={(e) => setPeriod(e.target.value)}
                  placeholder="月次・年次など（選ぶか入力）"
                  className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm dark:border-zinc-700"
                />
                <datalist id="plan-period-options">
                  {periodOptions(store?.plans ?? []).map((o) => (
                    <option key={o} value={o} />
                  ))}
                </datalist>
              </div>
              {workType === "custom" ? (
                <div className="mt-3">
                  <p className="text-xs font-medium text-zinc-500">
                    対象（{customDef?.target === "tank" ? "図面のタンクをクリック" : customDef?.target === "equipment" ? "図面の機器をクリック" : "選択不要"}）
                  </p>
                  <p className="mt-1 text-sm">
                    {customTarget ? (
                      <span className="rounded-full bg-cyan-100 px-2.5 py-0.5 text-cyan-900 dark:bg-cyan-950 dark:text-cyan-200">
                        {g.nodeById.get(customTarget)?.label}（{g.nodeById.get(customTarget)?.name}）
                      </span>
                    ) : (
                      <span className="text-zinc-400">{customDef?.target === "none" ? "—" : "未選択"}</span>
                    )}
                  </p>
                </div>
              ) : workType === "tankTransfer" ? (
                <TransferPanel
                  g={g}
                  tanks={allTanks}
                  src={trSrc}
                  dest={trDest}
                  pump={effTrPump}
                  pumpOptions={trPumpOptions}
                  onSrc={(t) => {
                    setTrSrc(t);
                    if (t === trDest) setTrDest(null);
                    setTrPump(undefined);
                  }}
                  onDest={(t) => {
                    setTrDest(t);
                    setTrPump(undefined);
                  }}
                  onPump={setTrPump}
                  error={dayError}
                  notes={
                    transferResult && !transferResult.error
                      ? steps.flatMap((st, i) => (transferResult.stepNotes[i] ? [[st, transferResult.stepNotes[i]] as const] : []))
                      : []
                  }
                />
              ) : isDay ? (
                <DayTargetPanel
                  g={g}
                  workType={workType}
                  flushPipes={flushPipes}
                  setFlushPipes={setFlushPipes}
                  flushT={flushT}
                  isoTank={workType === "fireTest" ? fireTank : isoTank}
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
                    <Stat label="遮断弁（閉）" value={boundaryRows.length} color="text-red-600" />
                    <Stat label="範囲内弁（開）" value={iso.internalValves.length} color="text-emerald-600" />
                    <Stat label="ドレン口" value={iso.drains.length} color="text-sky-600" />
                  </dl>
                  <p className="mt-2 text-xs text-zinc-500">
                    遮断弁：{boundaryRows.filter((r) => !r.note?.startsWith("2ブロック目")).map((r) => r.code).join("、") || "—"}
                  </p>
                  {boundaryRows.some((r) => r.note?.startsWith("2ブロック目")) && (
                    <p className="mt-1 text-xs text-zinc-500">
                      2ブロック目：{boundaryRows.filter((r) => r.note?.startsWith("2ブロック目")).map((r) => r.code).join("、")}
                    </p>
                  )}
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
                            <td>{n.drainPumpLpm ? "抜取ポンプ" : "ローリー"}</td>
                            <td className="text-right">{n.drainPumpLpm ?? lorryLpm} L/min</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {estimate && (
                    <div className="mt-2 space-y-1 text-sm">
                      <p>
                        抜取方法：
                        <b>{estimate.method === "pump" ? "抜取ポンプ" : estimate.method === "lorry" ? "ドレン口からローリー" : "なし"}</b>
                        {estimate.method === "pump" && (
                          <span className="text-xs text-zinc-500">
                            （{g.nodeById.get(estimate.pumpDrain!)?.label}・{estimate.rateLpm} L/min。抜き取りは1か所で行うため、ポンプのあるドレン口を使います）
                          </span>
                        )}
                      </p>
                      <p className="flex flex-wrap items-center gap-1">
                        抜取時間：<b>{formatMinutes(estimate.minutes)}</b>
                        {estimate.method === "lorry" && (
                          <>
                            <span className="ml-2 text-xs text-zinc-500">ローリーの抜取能力</span>
                            <input
                              type="number"
                              value={lorryLpm}
                              min={10}
                              step={10}
                              onChange={(e) => setLorryLpm(Number(e.target.value))}
                              className="w-20 rounded border border-zinc-300 bg-transparent px-1 text-xs dark:border-zinc-700"
                            />
                            <span className="text-xs text-zinc-500">L/min</span>
                          </>
                        )}
                      </p>
                      {estimate.method === "lorry" && (
                        <p className={`text-xs ${estimate.lorriesNeeded > estimate.lorry.count ? "font-semibold text-amber-700 dark:text-amber-400" : "text-zinc-500"}`}>
                          ローリー（{estimate.lorry.capacityKL}kL）：必要 {estimate.lorriesNeeded}台 ／ 用意 {estimate.lorry.count}台
                          {estimate.lorriesNeeded > estimate.lorry.count && "（台数が足りません。往復するか、⑤ で台数を見直してください）"}
                          {estimate.lorriesNeeded > 1 && "。1台ずつ順に抜き取る前提の時間です（入れ替えの時間は含みません）"}
                        </p>
                      )}
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
                        ※配管長は図面縮尺（1px＝{g.facility.metersPerPx}m）からの概算、内径はSch40相当。ローリーの台数・容量・抜取能力は ⑤ 燃料抜取のルールで設定します。
                      </p>
                    </div>
                  )}
                </Panel>

              </>
            )}


            {workType === "fireTest" && fireTank && (
              <Panel title="試験の内容">
                {fireResult?.error ? (
                  <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">{fireResult.error}</p>
                ) : fireResult?.summary ? (
                  <>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                      <dt className="text-zinc-500">発泡装置</dt>
                      <dd>{fireResult.summary.foamChambers.join("・") || "—"}</dd>
                      <dt className="text-zinc-500">冷却散水</dt>
                      <dd>
                        {fireResult.summary.sprinklers.length > 0 && <span className="block">試験タンク {fireResult.summary.sprinklers.join("・")}</span>}
                        隣接タンク側 {fireResult.summary.adjacent.join("・") || "—"}
                        {fireResult.summary.idleSprinklers.length > 0 && (
                          <span className="block text-zinc-500">
                            試験タンクの冷却散水（{fireResult.summary.idleSprinklers.join("・")}）からは散水しません
                          </span>
                        )}
                      </dd>
                      <dt className="text-zinc-500">消火栓（水）</dt>
                      <dd>{fireResult.summary.waterHydrants.join("・")}</dd>
                      <dt className="text-zinc-500">泡消火栓</dt>
                      <dd>{fireResult.summary.foamHydrants.join("・")}</dd>
                      <dt className="text-zinc-500">ポンプ</dt>
                      <dd>{[fireResult.summary.pump, fireResult.summary.foamPump].filter(Boolean).join("・")}</dd>
                    </dl>
                    <ol className="mt-2 space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
                      {steps.map((st, i) =>
                        fireResult.stepNotes[i] ? (
                          <li key={st}>
                            <b className="text-zinc-800 dark:text-zinc-200">{st}：</b>
                            {fireResult.stepNotes[i]}
                          </li>
                        ) : null
                      )}
                    </ol>
                    <p className="mt-2 text-[11px] text-zinc-500">
                      隣接タンク・消火栓の選び方、試験の順番などは{" "}
                      {isAdmin ? (
                        <Link href="/piping/rules" className="text-sky-700 underline dark:text-sky-400">
                          ⑤ チェックリスト作成のルール
                        </Link>
                      ) : (
                        "⑤ チェックリスト作成のルール（管理者）"
                      )}{" "}
                      で拠点ごとに変更できます。
                    </p>
                  </>
                ) : null}
              </Panel>
            )}

            {workType === "custom" && customResult && (customResult.error || Object.keys(customResult.stepNotes).length > 0) && (
              <Panel title="作業の内容">
                {customResult.error ? (
                  <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">{customResult.error}</p>
                ) : (
                  <ol className="space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
                    {steps.map((st, i) =>
                      customResult.stepNotes[i] ? (
                        <li key={st}>
                          <b className="text-zinc-800 dark:text-zinc-200">{st}：</b>
                          {customResult.stepNotes[i]}
                        </li>
                      ) : null
                    )}
                  </ol>
                )}
              </Panel>
            )}

            {ruleWarnings.length > 0 && (
              <Panel title="ルールの注意">
                <ul className="space-y-1">
                  {ruleWarnings.map((w) => (
                    <li key={w} className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                      {w}
                    </li>
                  ))}
                </ul>
              </Panel>
            )}

            {isDay && workType !== "fireTest" && workType !== "tankTransfer" && (workType !== "custom" || customFlush || customTransfer) && (
              <Panel title="当日の運用（例）">
                {workType === "flush" || customFlush ? (
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
                      options={TANKS.filter((t) => t !== tTank)}
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
                  {workType === "flush" || customFlush
                    ? "ポンプは末端部につながっているラインのもの（払出・移送を問わず）から選べます。"
                    : "払出系統（払出ポンプ → バイパス → 受入ライン）で移送し、吸えなくなったら移送系統（移送ポンプ → 受入ライン）で残りを移送します。"}
                  実際のタンク・ポンプは当日の運用に合わせて ② 現場点検・③ 制御室で選び直せます（ここでの選択は初期値）。
                </p>
                {(workType === "flush" || customFlush) && flushT && (
                  <p className="mt-2 text-sm">
                    末端部の容量 <b>{formatLiters(flushT.volumeL)}</b> ／ 循環量の目安（{customFlush ? customDef?.calc?.turnover : flushRules.turnover}倍）
                    <b> {formatLiters(flushT.volumeL * ((customFlush ? customDef?.calc?.turnover : flushRules.turnover) ?? 3))}</b>
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
                    {editingId ? "直して承認依頼する" : "承認依頼する"}
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

            {rejectedPlans.length > 0 && (
              <Panel title={`差し戻されたチェックリスト（${rejectedPlans.length}）`}>
                <ul className="space-y-2">
                  {rejectedPlans.map((p) => (
                    <li key={p.id} className="text-sm">
                      <div className="flex items-center gap-2">
                        <span className="shrink-0 rounded bg-zinc-100 px-1.5 text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                          {p.source === "excel" ? "Excel" : TYPE_TAG[workTypeOf(p)]}
                        </span>
                        <span className="flex-1 truncate" title={p.name}>
                          {p.name}
                        </span>
                        {p.source === "planner" ? (
                          <button onClick={() => loadPlan(p)} className="rounded border border-emerald-600 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                            直す
                          </button>
                        ) : (
                          <span className="text-[11px] text-zinc-500">② で取り込み直す</span>
                        )}
                      </div>
                      <div className="mt-0.5">
                        <PlanApproval plan={p} stages={approvalStages(store?.rules)} />
                      </div>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}
          </aside>
        </div>
      </div>
      {isApprover(siteRoles) && (
        <div className="mx-auto mt-6 max-w-[1800px]">
          <ApprovalBoard graph={g} store={store} base={baseline} act={act} />
        </div>
      )}
      {previewPlan && (
        <PlanPreview
          graph={g}
          plan={previewPlan}
          base={baseline}
          onClose={() => setPreviewPlan(null)}
          startLabel={editingId ? "直して承認依頼する" : "承認依頼する"}
          onStart={() => {
            setPreviewPlan(null);
            save();
          }}
          pdfHref={null}
        />
      )}
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

/** タンク間移送：移送元・移送先タンクとポンプの選択、工程の説明 */
function TransferPanel({
  g,
  tanks,
  src,
  dest,
  pump,
  pumpOptions,
  onSrc,
  onDest,
  onPump,
  error,
  notes,
}: {
  g: ReturnType<typeof useGraph>;
  tanks: string[];
  src: string | null;
  dest: string | null;
  pump: string | null | undefined;
  pumpOptions: (string | null)[];
  onSrc: (t: string | null) => void;
  onDest: (t: string | null) => void;
  onPump: (p: string | null) => void;
  error?: string;
  notes: (readonly [string, string])[];
}) {
  const name = (id: string) => {
    const n = g.nodeById.get(id);
    return n ? (n.name.startsWith(n.label) ? n.name : `${n.label}（${n.name}）`) : id;
  };
  const NONE = "__none__";
  const sel = "w-full rounded border border-zinc-300 bg-transparent px-1.5 py-1 disabled:opacity-40 dark:border-zinc-700";
  return (
    <div className="mt-3 space-y-2 text-xs">
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="text-zinc-500">移送元タンク（1回目のクリック）</span>
          <select value={src ?? ""} onChange={(e) => onSrc(e.target.value || null)} className={sel}>
            <option value="">未選択</option>
            {tanks.map((t) => (
              <option key={t} value={t}>
                {name(t)}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-zinc-500">移送先タンク（2回目のクリック）</span>
          <select value={dest ?? ""} onChange={(e) => onDest(e.target.value || null)} disabled={!src} className={sel}>
            <option value="">未選択</option>
            {tanks
              .filter((t) => t !== src)
              .map((t) => (
                <option key={t} value={t}>
                  {name(t)}
                </option>
              ))}
          </select>
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-zinc-500">使うポンプ（経路のあるものだけ。ポンプは短い経路の順）</span>
        <select
          value={pump === undefined ? "" : pump === null ? NONE : pump}
          onChange={(e) => onPump(e.target.value === NONE ? null : e.target.value)}
          disabled={!pumpOptions.length}
          className={sel}
        >
          {!pumpOptions.length && <option value="">（なし）</option>}
          {pumpOptions.map((p) => (
            <option key={p ?? NONE} value={p ?? NONE}>
              {p ? name(p) : "ポンプを使わない（自然流下）"}
            </option>
          ))}
        </select>
      </label>
      {error && <p className="rounded bg-red-50 px-2 py-1 text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
      {notes.length > 0 && (
        <ol className="space-y-1 text-zinc-600 dark:text-zinc-400">
          {notes.map(([st, n]) => (
            <li key={st}>
              <b className="text-zinc-800 dark:text-zinc-200">{st}：</b>
              {n}
            </li>
          ))}
        </ol>
      )}
    </div>
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
  if (workType === "tankIsolation" || workType === "fireTest") {
    return (
      <div className="mt-3">
        <p className="text-xs font-medium text-zinc-500">
          {workType === "fireTest" ? "試験対象タンク" : "縁切りするタンク"}（図面のタンクをクリック）
        </p>
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
