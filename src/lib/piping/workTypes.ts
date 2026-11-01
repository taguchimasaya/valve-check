import type { PlanRow, SavedPlan } from "./checklist";
import { shortestPath, type Graph } from "./graph";
import type { ValveState } from "./types";

// チェックリストを使う作業の種類と、当日の選択（タンク・ポンプ）から作るチェックリスト。
//  1. 燃料抜取（機器点検・交換等）     … 作業前 → ラインナップ → 抜取 → 充填 → 復旧
//  2. 燃料末端部作業（不使用ラインの循環）… 作業前 → ラインナップ → 循環 → 復旧
//  3. タンク縁切り作業（タンク開放のため）… 作業前 → 払出系統で移送 → 移送系統で移送 → 縁切り

export type WorkType = "drain" | "flush" | "tankIsolation";

export const WORK_TYPES: Record<WorkType, { label: string; desc: string }> = {
  drain: { label: "燃料抜取（機器点検・交換等）", desc: "機器・配管の燃料を抜き取り、作業後に充填する" },
  flush: { label: "燃料末端部作業（循環）", desc: "通常使用しないライン（末端部）の燃料をポンプで循環させる" },
  tankIsolation: { label: "タンク縁切り作業", desc: "タンク開放のため、燃料を別タンクへ移送して縁切りする" },
};

export const DRAIN_SUBTYPES = [
  "燃料抜取（機器点検）",
  "燃料抜取（配管工事）",
  "フィルターエレメント交換",
  "ストレーナー清掃",
  "バルブ交換",
];

export const FLUSH_STEPS = ["作業前", "ラインナップ", "循環", "復旧"];
export const ISOLATION_STEPS = ["作業前", "払出系統で移送", "移送系統で移送", "縁切り"];

/** 循環量の目安：末端部の配管容量の何倍を流すか */
export const FLUSH_TURNOVER = 3;

/** ポンプ能力の目安（L/min）。時間の試算用 */
export function pumpLpm(g: Graph, pump: string) {
  return g.nodeById.get(pump)?.kind === "transferPump" ? 1000 : 2000;
}

export function workTypeOf(plan: Pick<SavedPlan, "workType">): WorkType {
  return plan.workType ?? "drain";
}

/** 当日のタンク・ポンプ選択が必要な作業か（燃料抜取は充填ラインを使う場合のみ・別扱い） */
export function needsDayParams(plan: Pick<SavedPlan, "workType">) {
  return workTypeOf(plan) !== "drain";
}

export type OrderedRoute = { nodeIds: string[]; pipeIds: string[] };

/** 経由点を順に結んだ経路（各区間は最短経路、同じ所は二度通らない）。blocked は区間ごとに通らないノード */
function chainPath(g: Graph, points: string[], blocked: (string[] | undefined)[] = []): OrderedRoute | null {
  const nodeIds: string[] = [];
  const pipeIds: string[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const avoid = new Set([...(blocked[i] ?? []), ...nodeIds.filter((n) => n !== points[i]), ...points.slice(i + 2)]);
    const r = shortestPath(g, points[i], points[i + 1], avoid);
    if (!r) return null;
    nodeIds.push(...(i === 0 ? r.nodeIds : r.nodeIds.slice(1)));
    pipeIds.push(...r.pipeIds);
  }
  return { nodeIds, pipeIds };
}

const no = (tank: string) => tank.replace("T-", "");
const nozzles = (tank: string) => ({ R: `V-${no(tank)}R`, I: `V-${no(tank)}I`, T: `V-${no(tank)}T` });
const routeLength = (g: Graph, r: OrderedRoute) => r.pipeIds.reduce((a, p) => a + (g.pipeLengthM.get(p) ?? 0), 0);
const valvesOf = (g: Graph, r: OrderedRoute) => r.nodeIds.filter((n) => g.nodeById.get(n)?.kind === "valve");

/** 経路上で、ポンプの吐出側にある最初の弁（ポンプ起動の注記を付ける） */
function pumpValve(g: Graph, r: OrderedRoute, pump: string) {
  const i = r.nodeIds.indexOf(pump);
  return i < 0 ? null : r.nodeIds.slice(i).find((n) => g.nodeById.get(n)?.kind === "valve") ?? null;
}

export const ALL_PUMPS = (g: Graph) =>
  g.facility.nodes.filter((n) => n.kind === "pump" || n.kind === "transferPump").map((n) => n.id);

// ───────────── 燃料末端部作業（循環）─────────────

/** 末端部（選んだ配管の区間）の配管と、区間の出入口になる弁 */
export function flushTarget(g: Graph, targetPipeIds: string[]) {
  const sections = [...new Set(targetPipeIds.map((p) => g.sectionOfPipe.get(p)).filter((s): s is string => !!s))];
  const set = new Set(sections);
  const pipeIds = sections.flatMap((s) => g.sectionById.get(s)!.pipeIds);
  const volumeL = sections.reduce((a, s) => a + g.sectionById.get(s)!.volumeL, 0);
  const ends = [
    ...new Set(
      sections.flatMap((s) =>
        g.sectionById.get(s)!.valveIds.filter((v) => (g.valveSides.get(v) ?? []).some((o) => !set.has(o)))
      )
    ),
  ];
  return { pipeIds, volumeL, ends };
}

/**
 * 循環経路：充填元（送り元）タンク → ポンプ → 末端部 → 戻り先タンク。
 * 末端部がポンプの吸込側にある場合（払出ヘッダー間の連絡管など）は、タンク → 末端部 → ポンプ → 戻り先 とする。
 */
export function flushRoute(
  g: Graph,
  targetPipeIds: string[],
  srcTank: string,
  pump: string,
  returnTank: string
): OrderedRoute | null {
  const target = flushTarget(g, targetPipeIds);
  const inTarget = new Set(target.pipeIds);
  const transfer = g.nodeById.get(pump)?.kind === "transferPump";
  const src = nozzles(srcTank);
  const out = transfer ? src.T : src.I;
  const others = transfer ? [src.R, src.I] : [src.R, src.T];
  const ret = nozzles(returnTank);
  const retOthers = [ret.I, ret.T];
  let best: OrderedRoute | null = null;
  for (const a of target.ends) {
    for (const b of target.ends) {
      if (a === b) continue;
      const inner = shortestPath(g, a, b);
      if (!inner || !inner.pipeIds.every((p) => inTarget.has(p))) continue;
      const options = [
        // 吐出側：タンク → ポンプ → 末端部 → 戻り先
        [srcTank, out, pump, a, b, ret.R, returnTank],
        // 吸込側：タンク → 末端部 → ポンプ → 戻り先
        [srcTank, out, a, b, pump, ret.R, returnTank],
      ];
      for (const pts of options) {
        const blocked = pts.map((_, i) => (i === 0 ? others : i === pts.length - 2 ? retOthers : undefined));
        const r = chainPath(g, pts, blocked);
        if (!r || !inner.pipeIds.every((p) => r.pipeIds.includes(p))) continue;
        if (!best || routeLength(g, r) < routeLength(g, best)) best = r;
      }
    }
  }
  return best;
}

/** 末端部へ届くポンプ（送り元・戻り先タンクを選んだときに使えるもの） */
export function flushPumps(g: Graph, targetPipeIds: string[], srcTank: string, returnTank: string) {
  return ALL_PUMPS(g).filter((p) => flushRoute(g, targetPipeIds, srcTank, p, returnTank));
}

// ───────────── タンク縁切り作業 ─────────────

/** 払出系統での移送：対象タンクの払出弁 → 払出ポンプ → バイパス → 受入ライン → 移送先タンク */
export function isolationIssueRoute(g: Graph, tank: string, destTank: string, issuePump: string) {
  const sys = issuePump.replace("P-", "")[0];
  const s = nozzles(tank);
  const d = nozzles(destTank);
  return chainPath(
    g,
    [tank, s.I, issuePump, `V-BP${sys}`, d.R, destTank],
    [[s.R, s.T], undefined, [`V-H${sys}`], undefined, [d.I, d.T]]
  );
}

/** 移送系統での移送：対象タンクの移送弁 → 移送ポンプ → 受入ライン → 移送先タンク */
export function isolationTransferRoute(g: Graph, tank: string, destTank: string, transferPump: string) {
  const s = nozzles(tank);
  const d = nozzles(destTank);
  return chainPath(g, [tank, s.T, transferPump, d.R, destTank], [[s.R, s.I], undefined, undefined, [d.I, d.T]]);
}

// ───────────── 当日の選択からチェックリストを作る ─────────────

export type DayParams =
  | { kind: "flush"; srcTank: string; pump: string; returnTank: string }
  | { kind: "tankIsolation"; destTank: string; issuePump: string; transferPump: string };

export type DayResult = {
  rows: PlanRow[];
  stepNotes: Record<number, string>;
  stepRoutes: Record<number, OrderedRoute>;
  error?: string;
};

function row(g: Graph, id: string, states: (ValveState | null)[], note?: string): PlanRow {
  const n = g.nodeById.get(id)!;
  return { code: n.label, nodeId: id, name: n.name, role: "route", states, ...(note ? { note } : {}) };
}

function formatMin(min: number) {
  if (!isFinite(min)) return "—";
  return min < 60 ? `約${Math.ceil(min)}分` : `約${Math.floor(min / 60)}時間${Math.ceil(min % 60)}分`;
}

export function buildDayChecklist(
  g: Graph,
  plan: Pick<SavedPlan, "steps" | "flushPipeIds" | "isolationTank" | "summary">,
  params: DayParams,
  base: Record<string, ValveState>
): DayResult {
  if (params.kind === "flush") {
    const route = flushRoute(g, plan.flushPipeIds ?? [], params.srcTank, params.pump, params.returnTank);
    if (!route) return { rows: [], stepNotes: {}, stepRoutes: {}, error: "選んだタンク・ポンプでは末端部を通る経路が見つかりません" };
    const pv = pumpValve(g, route, params.pump);
    const rows = valvesOf(g, route).map((v) => {
      const b = base[v] ?? "close";
      // 0 作業前 / 1 ラインナップ（開） / 2 循環（弁操作なし） / 3 復旧（閉じていた弁を閉に戻す）
      return row(g, v, [b, "open", null, b === "close" ? "close" : null], v === pv ? `${params.pump} の吐出弁（循環工程でポンプを起動）` : undefined);
    });
    const vol = (plan.summary.volumeL ?? 0) * FLUSH_TURNOVER;
    const lpm = pumpLpm(g, params.pump);
    return {
      rows,
      stepRoutes: { 2: route },
      stepNotes: {
        1: `循環経路を構成します：${params.srcTank} → ${params.pump} → 末端部 → ${params.returnTank}`,
        2: `${params.pump} を起動し、${params.srcTank} → 末端部 → ${params.returnTank} へ循環。目標：末端部の配管容量の${FLUSH_TURNOVER}倍 ${(vol / 1000).toFixed(2)} kL（${lpm} L/min で${formatMin(vol / lpm)}）。完了したら ${params.pump} を停止して「循環完了」を押してください。`,
        3: "循環経路の弁を元の状態に戻します。",
      },
    };
  }

  const tank = plan.isolationTank!;
  const r1 = isolationIssueRoute(g, tank, params.destTank, params.issuePump);
  const r2 = isolationTransferRoute(g, tank, params.destTank, params.transferPump);
  if (!r1 || !r2) {
    return { rows: [], stepNotes: {}, stepRoutes: {}, error: "選んだタンク・ポンプでは移送経路が見つかりません" };
  }
  const v1 = new Set(valvesOf(g, r1));
  const v2 = new Set(valvesOf(g, r2));
  const nz = Object.values(nozzles(tank));
  const all = [...new Set([...v1, ...v2, ...nz])];
  const p1 = pumpValve(g, r1, params.issuePump);
  const p2 = pumpValve(g, r2, params.transferPump);
  const rows = all.map((v) => {
    const b = base[v] ?? "close";
    // 0 作業前 / 1 払出系統で移送 / 2 移送系統で移送 / 3 縁切り
    // 対象タンクの受入弁は最初に閉じる（受入ラインへ送った燃料が戻らないように）
    const s1: ValveState | null = v1.has(v) ? "open" : v === nozzles(tank).R ? "close" : null;
    const s2: ValveState | null = v2.has(v) ? "open" : v1.has(v) && b === "close" ? "close" : null;
    const s3: ValveState | null = nz.includes(v) ? "close" : v2.has(v) && b === "close" ? "close" : null;
    const note =
      v === p1
        ? `${params.issuePump} の吐出弁（払出系統で移送：ポンプ起動 → 吸えなくなったら停止）`
        : v === p2
          ? `${params.transferPump} の吐出弁（移送系統で移送：ポンプ起動 → 移送後に停止）`
          : nz.includes(v)
            ? `${tank} のノズル弁（縁切りで全閉）`
            : undefined;
    return row(g, v, [b, s1, s2, s3], note);
  });
  return {
    rows,
    stepRoutes: { 1: r1, 2: r2 },
    stepNotes: {
      1: `${params.issuePump} を起動し、${tank} → 払出系統 → バイパス → 受入ライン → ${params.destTank} へ移送。払出配管で吸えなくなったら ${params.issuePump} を停止して「移送完了」を押してください。`,
      2: `払出系統の弁を閉じ、${params.transferPump} を起動して ${tank} → 移送系統 → 受入ライン → ${params.destTank} へ残油を移送。終わったら ${params.transferPump} を停止して「移送完了」を押してください。`,
      3: `${tank} の受入・払出・移送弁をすべて閉止して縁切りします（必要に応じて仕切板を挿入）。`,
    },
  };
}

/** 弁の記録に加えて「完了」ボタンで終える工程（循環・移送） */
export function manualStepsOf(plan: Pick<SavedPlan, "workType">): number[] {
  const t = workTypeOf(plan);
  if (t === "flush") return [2];
  if (t === "tankIsolation") return [1, 2];
  return [];
}

export function manualStepLabel(plan: Pick<SavedPlan, "workType">) {
  return workTypeOf(plan) === "flush" ? "循環完了" : "移送完了";
}
