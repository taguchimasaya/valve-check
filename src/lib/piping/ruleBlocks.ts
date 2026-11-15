import type { PlanRow, RowRole } from "./checklist";
import { routeSections, routeSideValves, secondBlock, shortestPath, type Graph, type Route } from "./graph";
import { branchValves, fireParts, tankOutlets, unionRoute, type FireParts } from "./fireTest";
import { estimateDrain, formatLiters, formatMinutes, GRAVITY_LPM, planIsolation, type IsolationResult } from "./isolation";
import {
  ALL_PUMPS,
  flushPumps,
  flushRoute,
  flushTarget,
  formatMin,
  isolationIssueRoute,
  isolationTransferRoute,
  lineupRows,
  nozzles,
  pumpValve,
  valvesOf,
  type OrderedRoute,
} from "./workTypes";
import { customStepsOf, DEFAULT_CALC, needsCalc, type BlockRelation, type BlockSelector, type CustomWorkType, type RuleBlock } from "./rules";
import type { PNode, ValveState } from "./types";

// ルールブロック（ノーコードで組み立てる「もし〜なら、〜する」）の実行。
//  条件（BlockSelector）で機器を選び、工程ごとに 開／閉（ポンプは 起動／停止）を決めてチェックリストの行にする。
//  既存の作業（燃料抜取など）では、プログラムが作った行に追加・上書きする。ユーザー定義の作業では、これだけで行を作る。

/** チェックリストに載せられる機器（弁・ドレン弁・圧力計元弁・ポンプ） */
const ROW_KINDS = new Set(["valve", "drain", "gauge", "pump", "transferPump"]);
const isPump = (n: PNode) => n.kind === "pump" || n.kind === "transferPump";

export type BlockContext = {
  /** 対象（タンク・機器）。無ければ null */
  target: string | null;
  /** 作業の範囲・経路（既存の作業では経路・抜取範囲、ユーザー定義の作業では「作業の経路」） */
  route: Route | null;
  base: Record<string, ValveState>;
  /** 計算の部品の結果（遮断範囲など）。条件「【遮断範囲】〜」で使う */
  calc?: IsoParts | null;
  /** 計算の部品「循環経路」の結果。条件「【循環経路】〜」で使う */
  flush?: FlushParts | null;
  /** 計算の部品「消火試験の範囲」の結果。条件「【消火試験】〜」で使う */
  fire?: FireParts | null;
  /** 計算の部品「移送経路」の結果。条件「【移送経路】〜」で使う */
  transfer?: TransferParts | null;
};

/** 計算の部品「移送経路（タンク縁切り）」の結果 */
export type TransferParts = {
  tank: string;
  issueRoute: OrderedRoute;
  moveRoute: OrderedRoute;
  nozzles: string[];
  issuePump: string;
  movePump: string;
};

/** 計算の部品「循環経路」の結果（燃料末端部作業のチェックリストと同じ分け方） */
export type FlushParts = {
  route: OrderedRoute;
  routeValves: string[];
  /** 経路から分岐する先の弁（経路上の弁は除く） */
  side: string[];
  /** 分岐先の弁の外側（2ブロック目） */
  second: string[];
  bleed: string[];
  pump: string;
  /** ポンプの吐出側にある最初の弁 */
  pumpValve: string | null;
};

/** 循環経路を、条件で選べる組に分ける（lineupRows と同じ考え方） */
export function flushParts(g: Graph, route: OrderedRoute, pump: string): FlushParts {
  const routeValves = valvesOf(g, route);
  const onRoute = new Set(routeValves);
  const side = routeSideValves(g, route).filter((v) => !onRoute.has(v));
  const sb = secondBlock(g, side, routeSections(g, route));
  const used = new Set([...routeValves, ...side]);
  const second = sb.valves.filter((v) => !used.has(v));
  return { route, routeValves, side, second, bleed: sb.bleeds.filter((d) => !used.has(d) && !second.includes(d)), pump, pumpValve: pumpValve(g, route, pump) };
}

/** 計算の部品「遮断範囲」の結果を、条件で選べる機器の組にしたもの（燃料抜取のチェックリストと同じ分け方） */
export type IsoParts = {
  iso: IsolationResult;
  boundary: string[];
  /** 2ブロック目の弁 */
  second: string[];
  internal: string[];
  /** 抜取に使うドレン口（ドレン弁の無いもの）と、抜取経路の弁 */
  drain: string[];
  drainPump: string[];
  fillLine: string[];
  fillCrack: string[];
  gauge: string[];
  bleed: string[];
  /** 2ブロック目のうち、内側の遮断弁が充填に使う弁のもの（充填工程で一緒に開ける） */
  secondFillLine: string[];
  secondFillCrack: string[];
};

/** 遮断範囲の計算結果を、条件で選べる組に分ける（buildPlanRows と同じ考え方） */
export function isoParts(g: Graph, iso: IsolationResult): IsoParts {
  const drainRoute = new Set(iso.drains.flatMap((d) => g.nodeById.get(d)?.drainRoute ?? []));
  const boundary = iso.boundaryValves.filter((v) => !drainRoute.has(v));
  const sb = secondBlock(g, boundary, new Set(iso.regionSectionIds));
  const fillOpen = iso.fill.openValves;
  const second = sb.valves.filter((v) => !fillOpen.includes(v));
  const isFillLine = (v: string) => !!g.nodeById.get(v)?.fillLine;
  const firstOf = (v: string) => sb.ofValve.get(v)!;
  const drain = [...iso.drains.filter((d) => !g.nodeById.get(d)?.drainRoute?.length), ...drainRoute];
  return {
    iso,
    boundary,
    second,
    // 抜取に使う弁（ドレン弁など）は「ドレン」として扱い、範囲内の弁には入れない
    internal: iso.internalValves.filter((v) => !drain.includes(v)),
    drain,
    drainPump: [...new Set(iso.drains.map((d) => g.nodeById.get(d)?.drainSystem).filter((p): p is string => !!p && g.nodeById.has(p)))],
    fillLine: fillOpen.filter((v) => !!g.nodeById.get(v)?.fillLine),
    fillCrack: fillOpen.filter((v) => !g.nodeById.get(v)?.fillLine),
    gauge: [...new Set(iso.sealGroups.flatMap((s) => s.gaugeCandidates))],
    bleed: sb.bleeds,
    secondFillLine: second.filter((v) => fillOpen.includes(firstOf(v)) && isFillLine(firstOf(v))),
    secondFillCrack: second.filter((v) => fillOpen.includes(firstOf(v)) && !isFillLine(firstOf(v))),
  };
}

/** 条件の関係ごとの、チェックリストの行の区分（遮断弁・範囲内弁など。印刷の凡例・遮断弁の数に使う） */
const ROLE_OF: Partial<Record<BlockRelation, RowRole>> = {
  isoBoundary: "boundary",
  isoInternal: "internal",
  isoDrain: "drain",
  isoDrainPump: "pump",
  isoFillLine: "fill",
  isoFillCrack: "boundary",
  isoGauge: "gauge",
  isoBleed: "drain",
  flushPump: "pump",
  firePump: "pump",
  fireFoamPump: "pump",
  transferIssuePump: "pump",
  transferMovePump: "pump",
};

/** 対象から配管をたどって最初に当たる弁（逆止弁の向きは問わない。ドレン口・圧力計・安全弁・タンク・放出口の先へは進まない） */
function firstValvesAround(g: Graph, start: string): string[] {
  const out = new Set<string>();
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const { other } of g.adj.get(cur) ?? []) {
      if (seen.has(other)) continue;
      seen.add(other);
      const n = g.nodeById.get(other)!;
      if (n.kind === "valve") out.add(other);
      else if (["drain", "gauge", "psv", "tank", "source", "sink", "hydrant", "monitor", "sprinkler", "foamChamber"].includes(n.kind)) continue;
      else stack.push(other);
    }
  }
  return [...out];
}

/** 条件に合う機器 */
export function selectNodes(g: Graph, sel: BlockSelector, ctx: BlockContext): PNode[] {
  const target = ctx.target ? g.nodeById.get(ctx.target) ?? null : null;
  let ids: string[];
  switch (sel.relation) {
    case "targetBranch": {
      ids = target ? firstValvesAround(g, target.id) : [];
      if (target && sel.depth === 2) {
        // 対象に接する区間の外側（2ブロック目）
        const inside = new Set(
          g.sections.filter((s) => s.tankIds.includes(target.id) || g.sectionOfNode.get(target.id) === s.id).map((s) => s.id)
        );
        ids.push(...secondBlock(g, ids, inside).valves);
      }
      // 対象がポンプ・弁などの場合は対象そのものも含める
      if (target && ROW_KINDS.has(target.kind)) ids.push(target.id);
      break;
    }
    case "targetOutletBranch":
      ids = target ? tankOutlets(g, target).flatMap((o) => branchValves(g, o.id)) : [];
      break;
    case "onRoute":
      ids = ctx.route ? [...new Set(ctx.route.nodeIds)] : [];
      break;
    case "routeBranch":
      ids = ctx.route ? routeSideValves(g, ctx.route) : [];
      if (ctx.route && sel.depth === 2) ids.push(...secondBlock(g, ids, routeSections(g, ctx.route)).valves);
      break;
    case "isoBoundary":
      ids = ctx.calc ? [...ctx.calc.boundary, ...(sel.depth === 2 ? ctx.calc.second : [])] : [];
      break;
    case "isoInternal":
      ids = ctx.calc?.internal ?? [];
      break;
    case "isoDrain":
      ids = ctx.calc?.drain ?? [];
      break;
    case "isoDrainPump":
      ids = ctx.calc?.drainPump ?? [];
      break;
    case "isoFillLine":
      ids = ctx.calc ? [...ctx.calc.fillLine, ...(sel.depth === 2 ? ctx.calc.secondFillLine : [])] : [];
      break;
    case "isoFillCrack":
      ids = ctx.calc ? [...ctx.calc.fillCrack, ...(sel.depth === 2 ? ctx.calc.secondFillCrack : [])] : [];
      break;
    case "isoGauge":
      ids = ctx.calc?.gauge ?? [];
      break;
    case "isoBleed":
      ids = ctx.calc?.bleed ?? [];
      break;
    case "flushRoute":
      ids = ctx.flush?.routeValves ?? [];
      break;
    case "flushSide":
      ids = ctx.flush ? [...ctx.flush.side, ...(sel.depth === 2 ? ctx.flush.second : [])] : [];
      break;
    case "flushPump":
      ids = ctx.flush ? [ctx.flush.pump] : [];
      break;
    case "flushBleed":
      ids = ctx.flush?.bleed ?? [];
      break;
    case "fireWater":
      ids = ctx.fire?.water ?? [];
      break;
    case "fireFoamRoute":
      ids = ctx.fire?.foamOnly ?? [];
      break;
    case "fireSprCylinder":
      ids = ctx.fire?.sprCylinders ?? [];
      break;
    case "fireFoamCylinder":
      ids = ctx.fire?.foamCylinders ?? [];
      break;
    case "fireHydWater":
      ids = ctx.fire?.hydWater ?? [];
      break;
    case "fireHydFoam":
      ids = ctx.fire?.hydFoam ?? [];
      break;
    case "fireIdleOwn":
      ids = ctx.fire?.idleOwn ?? [];
      break;
    case "fireOtherFoamCyl":
      ids = ctx.fire?.otherFoamCyl ?? [];
      break;
    case "fireOtherFoamManual":
      ids = ctx.fire?.otherFoamManual ?? [];
      break;
    case "fireOutside":
      ids = ctx.fire ? [...ctx.fire.outside, ...(sel.depth === 2 ? ctx.fire.outsideSecond : [])] : [];
      break;
    case "fireBleed":
      ids = ctx.fire?.bleeds ?? [];
      break;
    case "firePump":
      ids = ctx.fire ? [ctx.fire.pump.id] : [];
      break;
    case "fireFoamPump":
      ids = ctx.fire?.foamPump ? [ctx.fire.foamPump.id] : [];
      break;
    case "transferNozzle":
      ids = ctx.transfer?.nozzles ?? [];
      break;
    case "transferIssuePump":
      ids = ctx.transfer ? [ctx.transfer.issuePump] : [];
      break;
    case "transferMovePump":
      ids = ctx.transfer ? [ctx.transfer.movePump] : [];
      break;
    case "transferIssueRoute":
      ids = ctx.transfer ? valvesOf(g, ctx.transfer.issueRoute) : [];
      break;
    case "transferMoveRoute":
      ids = ctx.transfer ? valvesOf(g, ctx.transfer.moveRoute) : [];
      break;
    default:
      ids = g.facility.nodes.map((n) => n.id);
  }
  const kinds = sel.kinds.length ? sel.kinds : ["valve"];
  const nameKey = sel.nameIncludes.trim();
  const codeKey = sel.codePrefix.trim().toUpperCase();
  let list = [...new Set(ids)]
    .map((id) => g.nodeById.get(id))
    .filter((n): n is PNode => !!n)
    .filter((n) => kinds.includes(n.kind))
    .filter((n) => !sel.fluids.length || sel.fluids.includes(n.fluid ?? "fuel"))
    .filter((n) => {
      if (sel.area === "any") return true;
      if (sel.area === "same") return !!target && n.area === target.area;
      if (sel.area === "other") return !!target && n.area !== target.area;
      return sel.area.startsWith("area:") ? n.area === sel.area.slice(5) : true;
    })
    .filter((n) => sel.normal === "any" || (ctx.base[n.id] ?? n.normal ?? "close") === sel.normal)
    .filter((n) => !nameKey || n.name.includes(nameKey))
    .filter((n) => !codeKey || n.label.toUpperCase().startsWith(codeKey));
  if (sel.nearest > 0) {
    if (target) list = list.sort((a, b) => Math.hypot(a.x - target.x, a.y - target.y) - Math.hypot(b.x - target.x, b.y - target.y));
    list = list.slice(0, sel.nearest);
  }
  return list;
}

/**
 * ルールブロックをチェックリストの行に当てはめる。
 * 同じ機器の行があれば指定した工程だけ上書きし、無ければ行を追加する。
 */
export function applyBlocks(
  g: Graph,
  rows: PlanRow[],
  steps: string[],
  blocks: RuleBlock[],
  ctx: BlockContext
): { rows: PlanRow[]; warnings: string[] } {
  const enabled = blocks.filter((b) => b.enabled);
  if (!enabled.length) return { rows, warnings: [] };
  const out = rows.map((r) => ({ ...r, states: [...r.states] }));
  const byNode = new Map(out.filter((r) => r.nodeId).map((r) => [r.nodeId!, r]));
  const warnings: string[] = [];
  const last = steps.length - 1;
  enabled.forEach((b) => {
    const opSteps = Object.entries(b.ops)
      .map(([name, s]) => [steps.indexOf(name), s] as const)
      .filter(([i]) => i >= 0);
    const missing = Object.keys(b.ops).filter((name) => !steps.includes(name));
    if (missing.length) warnings.push(`ルール「${b.name}」の工程 ${missing.join("・")} はこの作業にありません`);
    const nodes = selectNodes(g, b.when, ctx).filter((n) => ROW_KINDS.has(n.kind));
    if (!nodes.length) {
      // 計算の部品の結果（抜取ポンプ・充填ラインなど）は、対象によって無いのが普通なので知らせない
      if (!needsCalc(b.when.relation)) warnings.push(`ルール「${b.name}」に当てはまる機器がありません`);
      return;
    }
    nodes.forEach((n) => {
      const base: ValveState = isPump(n) ? "close" : ctx.base[n.id] ?? n.normal ?? "close";
      let row = byNode.get(n.id);
      if (!row) {
        const states: (ValveState | null)[] = Array(steps.length).fill(null);
        states[0] = base;
        row = { code: n.label, nodeId: n.id, name: n.name, role: ROLE_OF[b.when.relation] ?? (isPump(n) ? "pump" : "route"), states };
        out.push(row);
        byNode.set(n.id, row);
      } else if (b.when.relation === "isoFillLine") row.role = "fill";
      opSteps.forEach(([i, s]) => (row!.states[i] = s));
      if (b.restore && last > 0 && !opSteps.some(([i]) => i === last) && opSteps.length) {
        // 「変わった機器だけ戻す」：最後の工程の前の状態が待機状態と同じなら、最後の工程は空欄のまま
        const before = row.states.slice(0, last).reduce<ValveState>((s, x) => x ?? s, base);
        if (!b.restoreIfChanged || before !== base) row.states[last] = base;
      }
      // 消火試験の範囲の弁は、どの放出口の弁かなどの注記を使う
      const note = ctx.fire?.noteOf.get(n.id) ?? (b.note.trim() || b.name);
      if (note && !(row.note ?? "").includes(note)) row.note = row.note ? `${row.note} ／ ${note}` : note;
    });
  });
  return { rows: out, warnings };
}

export type CustomResult = {
  rows: PlanRow[];
  stepNotes: Record<number, string>;
  stepRoutes: Record<number, Route>;
  error?: string;
  warnings: string[];
  route: Route | null;
  /** 計算の部品「移送経路」を使ったときの結果（使った当日の選択） */
  transfer?: { day: TransferDay };
  /** 計算の部品「消火試験の範囲」を使ったときの結果（作成画面の表示用） */
  fire?: { summary: string };
  /** 計算の部品「循環経路」を使ったときの結果（末端部の配管・容量・使った当日の選択） */
  flush?: { pipeIds: string[]; volumeL: number; day: FlushDay };
  /** 計算の部品「遮断範囲」を使ったときの結果（範囲・液封・量と時間） */
  iso?: {
    regionNodeIds: string[];
    regionPipeIds: string[];
    sealPipeIds: string[];
    fillPipeIds: string[];
    volumeL: number;
    drainMinutes: number | null;
    fillMinutes: number | null;
    drains: string[];
    notes: string[];
  };
};

/** ユーザー定義の作業：工程とルールブロックだけでチェックリストを作る */
export function buildCustomChecklist(
  g: Graph,
  def: CustomWorkType,
  target: string | null,
  base: Record<string, ValveState>,
  /** 自然流下の抜取能力（口径別 L/min。⑤ 燃料抜取の設定）、循環経路の末端部の配管と当日のタンク・ポンプ */
  env: CustomEnv = {}
): CustomResult {
  const steps = customStepsOf(def);
  const empty = { rows: [], stepNotes: {}, stepRoutes: {}, warnings: [], route: null };
  const calc = { ...DEFAULT_CALC, ...(def.calc ?? {}) };
  if (calc.kind === "flush") return buildFlushChecklist(g, def, base, calc, env, steps);
  if (def.target !== "none" && !target) return { ...empty, error: "図面で対象を選んでください" };
  if (calc.kind === "isolation") return buildIsolationChecklist(g, def, target!, base, calc, env, steps);
  if (calc.kind === "fireTest") return buildFireChecklist(g, def, target!, base, calc, steps);
  if (calc.kind === "transfer") return buildTransferChecklist(g, def, target!, base, calc, env, steps);
  // 作業の経路：条件に合う機器のうち、対象へ届く最も近いものから対象まで
  let route: Route | null = null;
  if (def.route.enabled && target) {
    const t = g.nodeById.get(target)!;
    const froms = selectNodes(g, { ...def.route.from, relation: "any", nearest: 0 }, { target, route: null, base })
      .sort((a, b) => Math.hypot(a.x - t.x, a.y - t.y) - Math.hypot(b.x - t.x, b.y - t.y));
    for (const f of froms) {
      route = shortestPath(g, f.id, target);
      if (route) break;
    }
    if (!route) return { ...empty, error: "作業の経路が見つかりません（経路の起点の条件を確認してください）" };
  }
  const { rows, warnings } = applyBlocks(g, [], steps, def.blocks, { target, route, base });
  if (!rows.length) return { ...empty, route, warnings, error: "ルールに当てはまる弁・ポンプがありません" };
  const stepNotes: Record<number, string> = {};
  def.steps.forEach((s, i) => s.note.trim() && (stepNotes[i + 1] = s.note.trim()));
  const stepRoutes: Record<number, Route> = {};
  if (route) def.route.showAt.forEach((name) => steps.indexOf(name) > 0 && (stepRoutes[steps.indexOf(name)] = route!));
  return { rows, stepNotes, stepRoutes, warnings, route };
}

/** 計算の部品「遮断範囲（燃料抜取）」を使うユーザー定義の作業 */
function buildIsolationChecklist(
  g: Graph,
  def: CustomWorkType,
  target: string,
  base: Record<string, ValveState>,
  calc: typeof DEFAULT_CALC,
  env: { gravity?: Record<number, number> },
  steps: string[]
): CustomResult {
  const empty = { rows: [], stepNotes: {}, stepRoutes: {}, warnings: [], route: null };
  const iso = planIsolation(g, [{ type: "node", id: target }], { baseline: base, expandToDrain: calc.expandToDrain });
  if (iso.errors.length) return { ...empty, error: iso.errors.join("／") };
  const parts = isoParts(g, iso);
  const route: Route = { nodeIds: iso.regionNodeIds, pipeIds: iso.regionPipeIds };
  const { rows, warnings } = applyBlocks(g, [], steps, def.blocks, { target, route, base, calc: parts });
  if (!rows.length) return { ...empty, route, warnings, error: "ルールに当てはまる弁・ポンプがありません" };
  const est = estimateDrain(g, iso.drains, iso.volumeL, calc.portableLpm, env.gravity ?? GRAVITY_LPM);
  const fillMinutes = calc.fillLpm > 0 ? iso.volumeL / calc.fillLpm : null;
  const drainLabels = iso.drains.map((d) => g.nodeById.get(d)?.label ?? d).join("・") || "なし";
  // 工程の注記の差し込み：{抜取量} {抜取時間} {充填時間} {ドレン口}
  const fill = (s: string) =>
    s
      .replaceAll("{抜取量}", formatLiters(iso.volumeL))
      .replaceAll("{抜取時間}", formatMinutes(est.minutes))
      .replaceAll("{充填時間}", formatMinutes(fillMinutes))
      .replaceAll("{ドレン口}", drainLabels);
  const stepNotes: Record<number, string> = {};
  def.steps.forEach((s, i) => s.note.trim() && (stepNotes[i + 1] = fill(s.note.trim())));
  // 遮断範囲は流れの経路ではないので、工程ごとの流れの表示はしない（範囲は作成画面・図面で別に表示する）
  const stepRoutes: Record<number, Route> = {};
  const newSeals = iso.sealGroups.filter((s) => !s.preexisting);
  const extra = [
    ...iso.notes,
    ...(newSeals.length ? [`液封の恐れがある区間が ${newSeals.length} か所あります（圧力計の取付・逃し方を確認してください）`] : []),
    ...(iso.drains.length ? [] : ["遮断範囲にドレン口がありません（抜取方法を別に決めてください）"]),
  ];
  return {
    rows,
    stepNotes,
    stepRoutes,
    warnings: [...warnings, ...extra],
    route,
    iso: {
      regionNodeIds: iso.regionNodeIds,
      regionPipeIds: iso.regionPipeIds,
      sealPipeIds: newSeals.flatMap((s) => s.pipeIds),
      fillPipeIds: iso.fill.pipeIds,
      volumeL: iso.volumeL,
      drainMinutes: est.minutes,
      fillMinutes,
      drains: iso.drains,
      notes: [`抜取量 ${formatLiters(iso.volumeL)}・抜取時間 ${formatMinutes(est.minutes)}・充填時間 ${formatMinutes(fillMinutes)}（ドレン口：${drainLabels}）`],
    },
  };
}

// ───────────── 計算の部品「循環経路（燃料末端部作業）」 ─────────────

export type CustomEnv = {
  /** 自然流下の抜取能力（口径別 L/min。⑤ 燃料抜取の設定） */
  gravity?: Record<number, number>;
  /** 循環経路：末端部として選んだ配管 */
  flushPipes?: string[];
  /** 循環経路：当日のタンク・ポンプ（無ければ、経路が作れる組み合わせを1つ選んで試す） */
  day?: FlushDay;
  /** 移送経路：当日の移送先・ポンプ（無ければ、経路が作れる組み合わせを1つ選んで試す） */
  transferDay?: TransferDay;
};

export type TransferDay = { destTank: string; issuePump: string; transferPump: string };

export type FlushDay = { srcTank: string; pump: string; returnTank: string };

/** 試しに作るときの当日の選択：末端部へ届く送り元・戻り先タンクとポンプの組み合わせを1つ探す */
export function exampleFlushDay(g: Graph, pipes: string[]): FlushDay | null {
  const tanks = g.facility.nodes
    .filter((n) => n.kind === "tank" && !n.small && !n.recovery)
    .map((n) => n.id)
    .sort((a, b) => a.localeCompare(b, "ja"))
    .slice(0, 8);
  for (const srcTank of tanks) {
    for (const returnTank of tanks) {
      if (returnTank === srcTank) continue;
      const pump = flushPumps(g, pipes, srcTank, returnTank)[0];
      if (pump) return { srcTank, pump, returnTank };
    }
  }
  return null;
}

function buildFlushChecklist(
  g: Graph,
  def: CustomWorkType,
  base: Record<string, ValveState>,
  calc: typeof DEFAULT_CALC,
  env: CustomEnv,
  steps: string[]
): CustomResult {
  const empty = { rows: [], stepNotes: {}, stepRoutes: {}, warnings: [], route: null };
  const pipes = env.flushPipes ?? [];
  if (!pipes.length) return { ...empty, error: "図面で末端部の配管を選んでください" };
  const target = flushTarget(g, pipes);
  const day = env.day ?? exampleFlushDay(g, pipes);
  if (!day) return { ...empty, error: "末端部へ届くタンク・ポンプの組み合わせが見つかりません" };
  const route = flushRoute(g, pipes, day.srcTank, day.pump, day.returnTank);
  if (!route) return { ...empty, error: "選んだタンク・ポンプでは末端部を通る経路が見つかりません" };
  const parts = flushParts(g, route, day.pump);
  const { rows, warnings } = applyBlocks(g, [], steps, def.blocks, { target: null, route, base, flush: parts });
  if (!rows.length) return { ...empty, route, warnings, error: "ルールに当てはまる弁・ポンプがありません" };
  // ポンプの吐出側の最初の弁に注記（燃料末端部作業と同じ）
  const pv = parts.pumpValve ? rows.find((r) => r.nodeId === parts.pumpValve) : undefined;
  if (pv && !(pv.note ?? "").includes("吐出弁")) pv.note = pv.note ? `${day.pump} の吐出弁 ／ ${pv.note}` : `${day.pump} の吐出弁`;
  const vol = target.volumeL * calc.turnover;
  const lpm = g.nodeById.get(day.pump)?.kind === "transferPump" ? calc.transferPumpLpm : calc.pumpLpm;
  const fill = (s: string) =>
    s
      .replaceAll("{送り元}", day.srcTank)
      .replaceAll("{ポンプ}", day.pump)
      .replaceAll("{戻り先}", day.returnTank)
      .replaceAll("{循環量}", `${(vol / 1000).toFixed(2)} kL`)
      .replaceAll("{循環時間}", lpm > 0 ? formatMin(vol / lpm) : "—")
      .replaceAll("{末端部容量}", formatLiters(target.volumeL));
  const stepNotes: Record<number, string> = {};
  def.steps.forEach((s, i) => s.note.trim() && (stepNotes[i + 1] = fill(s.note.trim())));
  const stepRoutes: Record<number, Route> = {};
  def.route.showAt.forEach((name) => steps.indexOf(name) > 0 && (stepRoutes[steps.indexOf(name)] = route));
  return {
    rows,
    stepNotes,
    stepRoutes,
    warnings: env.day ? warnings : [...warnings, `当日のタンク・ポンプの例：${day.srcTank} → ${day.pump} → 末端部 → ${day.returnTank}（点検の当日に選び直せます）`],
    route,
    flush: { pipeIds: target.pipeIds, volumeL: target.volumeL, day },
  };
}

// ───────────── 計算の部品「消火試験の範囲」 ─────────────

function buildFireChecklist(
  g: Graph,
  def: CustomWorkType,
  target: string,
  base: Record<string, ValveState>,
  calc: typeof DEFAULT_CALC,
  steps: string[]
): CustomResult {
  const empty = { rows: [], stepNotes: {}, stepRoutes: {}, warnings: [], route: null };
  const parts = fireParts(g, target, base, calc.fire, calc.fireMethod);
  if ("error" in parts) return { ...empty, error: parts.error };
  const route = unionRoute([parts.waterRoute, parts.foamRoute]);
  const { rows, warnings } = applyBlocks(g, [], steps, def.blocks, { target, route, base, fire: parts });
  if (!rows.length) return { ...empty, route, warnings, error: "ルールに当てはまる弁・ポンプがありません" };
  const names = (list: { label: string }[]) => list.map((n) => n.label).join("・") || "—";
  const label = (id: string) => g.nodeById.get(id)?.label ?? id;
  const fill = (s: string) =>
    s
      .replaceAll("{試験タンク}", parts.tank.label)
      .replaceAll("{消火ポンプ}", parts.pump.label)
      .replaceAll("{泡原液ポンプ}", parts.foamPump?.label ?? "—")
      .replaceAll("{発泡装置}", names(parts.chambers))
      .replaceAll("{冷却散水}", names(parts.sprUsed))
      .replaceAll("{消火栓（水）}", names(parts.waterHydrants.map((x) => x.h)))
      .replaceAll("{泡消火栓}", names(parts.foamHydrants.map((x) => x.h)))
      .replaceAll("{シリンダー弁}", [...parts.sprCylinders, ...parts.foamCylinders].map(label).join("・") || "—");
  const stepNotes: Record<number, string> = {};
  def.steps.forEach((s, i) => s.note.trim() && (stepNotes[i + 1] = fill(s.note.trim())));
  // 流れの表示：工程名に「泡」を含む工程は泡系統、それ以外は水系統の経路
  const stepRoutes: Record<number, Route> = {};
  def.route.showAt.forEach((name) => {
    const i = steps.indexOf(name);
    if (i > 0) stepRoutes[i] = name.includes("泡") ? parts.foamRoute : parts.waterRoute;
  });
  return {
    rows,
    stepNotes,
    stepRoutes,
    warnings,
    route,
    fire: {
      summary: `消火ポンプ ${parts.pump.label}${parts.foamPump ? `・泡原液ポンプ ${parts.foamPump.label}` : ""}／発泡装置 ${names(parts.chambers)}／冷却散水 ${names(parts.sprUsed)}／消火栓（水）${parts.waterHydrants.length}口・泡消火栓 ${parts.foamHydrants.length}口`,
    },
  };
}

// ───────────── 計算の部品「移送経路（タンク縁切り）」 ─────────────

/** 試しに作るときの当日の選択：対象タンクから移送できる移送先と、払出ポンプ・移送ポンプの組み合わせを1つ探す（同じ区画のタンクを優先） */
export function exampleTransferDay(g: Graph, tank: string): TransferDay | null {
  const t = g.nodeById.get(tank);
  const tanks = g.facility.nodes
    .filter((n) => n.kind === "tank" && !n.small && !n.recovery && n.id !== tank)
    .sort((a, b) => Number(a.area !== t?.area) - Number(b.area !== t?.area) || a.id.localeCompare(b.id, "ja"));
  for (const d of tanks) {
    const issuePump = ALL_PUMPS(g).find((p) => g.nodeById.get(p)!.kind === "pump" && isolationIssueRoute(g, tank, d.id, p));
    const transferPump = ALL_PUMPS(g).find((p) => g.nodeById.get(p)!.kind === "transferPump" && isolationTransferRoute(g, tank, d.id, p));
    if (issuePump && transferPump) return { destTank: d.id, issuePump, transferPump };
  }
  return null;
}

function buildTransferChecklist(
  g: Graph,
  def: CustomWorkType,
  tank: string,
  base: Record<string, ValveState>,
  calc: typeof DEFAULT_CALC,
  env: CustomEnv,
  steps: string[]
): CustomResult {
  const empty = { rows: [], stepNotes: {}, stepRoutes: {}, warnings: [], route: null };
  const day = env.transferDay ?? exampleTransferDay(g, tank);
  if (!day) return { ...empty, error: "対象タンクから移送できる移送先・ポンプが見つかりません" };
  const r1 = isolationIssueRoute(g, tank, day.destTank, day.issuePump);
  const r2 = isolationTransferRoute(g, tank, day.destTank, day.transferPump);
  if (!r1 || !r2) return { ...empty, error: "選んだタンク・ポンプでは移送経路が見つかりません" };
  const i1 = steps.indexOf(calc.issueStep ?? "");
  const i2 = steps.indexOf(calc.moveStep ?? "");
  if (i1 <= 0 || i2 <= 0) return { ...empty, error: "計算の設定で、払出系統・移送系統で移送する工程を選んでください" };
  // 工程ごとの経路：経路の弁を開け、分岐先を閉め、次の工程で使わない弁は戻す（燃料末端部作業・タンク縁切りと同じ動き）
  const notes: Record<string, string> = {};
  const p1 = pumpValve(g, r1, day.issuePump);
  const p2 = pumpValve(g, r2, day.transferPump);
  if (p1) notes[p1] = `${day.issuePump} の吐出弁`;
  if (p2) notes[p2] = `${day.transferPump} の吐出弁`;
  const lineup = lineupRows(g, steps.length, { [i1]: r1, [i2]: r2 }, base, [], [], notes, calc.closeSide ?? true, calc.lineupMethod);
  const parts: TransferParts = {
    tank,
    issueRoute: r1,
    moveRoute: r2,
    nozzles: Object.values(nozzles(tank)).filter((v) => g.nodeById.has(v)),
    issuePump: day.issuePump,
    movePump: day.transferPump,
  };
  const route = unionRoute([r1, r2]);
  const { rows, warnings } = applyBlocks(g, lineup, steps, def.blocks, { target: tank, route, base, transfer: parts });
  const label = g.nodeById.get(tank)?.label ?? tank;
  const fill = (s: string) =>
    s.replaceAll("{対象タンク}", label).replaceAll("{移送先}", day.destTank).replaceAll("{払出ポンプ}", day.issuePump).replaceAll("{移送ポンプ}", day.transferPump);
  const stepNotes: Record<number, string> = {};
  def.steps.forEach((s, i) => s.note.trim() && (stepNotes[i + 1] = fill(s.note.trim())));
  return {
    rows,
    stepNotes,
    stepRoutes: { [i1]: r1, [i2]: r2 },
    warnings: env.transferDay ? warnings : [...warnings, `当日の選択の例：移送先 ${day.destTank}・払出ポンプ ${day.issuePump}・移送ポンプ ${day.transferPump}（点検の当日に選び直せます）`],
    route,
    transfer: { day },
  };
}
