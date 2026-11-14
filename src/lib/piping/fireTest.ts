import type { PlanRow } from "./checklist";
import { routeSideValves, shortestPath, type Graph, type Route } from "./graph";
import type { PNode, ValveState } from "./types";

// 消火設備の機能試験チェックリスト。試験対象タンクを選ぶと、次の考え方で弁・ポンプの行を作る。
//  ・対象タンクの冷却散水（水）・発泡装置（泡）は左右とも使う（シリンダー弁を開、手動弁は開を確認）
//  ・対象タンクに隣接するタンク（同じヤードで横に並ぶタンク）は、対象タンク側の冷却散水を使う
//  ・同じヤードのほかのタンクの発泡装置は、シリンダー弁の閉を確認し、下流の手動弁を閉める（誤放出防止）
//  ・試験に使う経路から試験範囲外へ分岐する弁で、普段開いているものは閉めて仕切る（ポンプ室内の弁は待機状態のまま）
//  ・消火栓は対象タンクに近いものから 水4口・泡3口 を使う
// 工程：作業前 → ラインナップ → シリンダー弁開（制御室）→ ポンプ起動 → 水系統試験 → 泡系統試験 → 試験終了 → 復旧

export const FIRE_TEST_STEPS = [
  "作業前",
  "ラインナップ",
  "シリンダー弁開（制御室）",
  "ポンプ起動",
  "水系統試験",
  "泡系統試験",
  "試験終了",
  "復旧",
];
const S = { lineup: 1, cylinder: 2, pumpOn: 3, water: 4, foam: 5, end: 6, restore: 7 } as const;

/** 使う消火栓の数 */
export const FIRE_TEST_HYDRANTS = { water: 4, foam: 3 };

export type FireTestResult = {
  rows: PlanRow[];
  stepNotes: Record<number, string>;
  stepRoutes: Record<number, Route>;
  error?: string;
  /** 画面表示用：試験で使う設備 */
  summary?: {
    sprinklers: string[];
    adjacent: string[];
    foamChambers: string[];
    waterHydrants: string[];
    foamHydrants: string[];
    pump: string;
    foamPump: string | null;
  };
};

const isFoam = (n: PNode) => n.fluid === "foam" || n.fluid === "foamSolution";
const isCylinder = (n: PNode) => n.name.includes("シリンダー") || /^CY/i.test(n.label);

/** タンクに付いている放出口（冷却散水設備・タンク発泡装置）。名称の先頭のタンク番号で判定する */
function tankOutlets(g: Graph, tank: PNode) {
  return g.facility.nodes.filter(
    (n) =>
      (n.kind === "sprinkler" || n.kind === "foamChamber") &&
      (n.name.startsWith(`${tank.id} `) || n.name.startsWith(`${tank.label} `))
  );
}

/** 消火設備の付いたタンク（機能試験の対象にできるタンク） */
export function fireTestTanks(g: Graph) {
  return g.facility.nodes.filter((n) => n.kind === "tank" && tankOutlets(g, n).length > 0).map((n) => n.id);
}

/** 放出口からヘッダー（分岐点）まで遡った枝の弁（放出口側から順に） */
function branchValves(g: Graph, outlet: string) {
  const valves: string[] = [];
  let prev = "";
  let cur = outlet;
  for (let i = 0; i < 50; i++) {
    const next = (g.adj.get(cur) ?? []).filter((a) => a.other !== prev);
    if (cur !== outlet && (g.adj.get(cur) ?? []).length > 2) break;
    if (next.length !== 1) break;
    prev = cur;
    cur = next[0].other;
    if (g.nodeById.get(cur)!.kind === "valve") valves.push(cur);
  }
  return valves;
}

/** 経路を足し合わせる（配管ごとに上流側のノードを持つ） */
function unionRoute(routes: Route[]): Route {
  const up = new Map<string, string>();
  routes.forEach((r) => r.pipeIds.forEach((p, i) => up.has(p) || up.set(p, r.nodeIds[i])));
  return { pipeIds: [...up.keys()], nodeIds: [...up.values()] };
}

const dist = (a: PNode, b: PNode) => Math.hypot(a.x - b.x, a.y - b.y);

export function buildFireTestChecklist(g: Graph, tankId: string, base: Record<string, ValveState>): FireTestResult {
  const fail = (error: string): FireTestResult => ({ rows: [], stepNotes: {}, stepRoutes: {}, error });
  const tank = g.nodeById.get(tankId);
  if (!tank || tank.kind !== "tank") return fail("試験対象のタンクを選んでください");
  const outlets = tankOutlets(g, tank);
  const sprinklers = outlets.filter((n) => n.kind === "sprinkler");
  const chambers = outlets.filter((n) => n.kind === "foamChamber");
  if (!sprinklers.length && !chambers.length) return fail(`${tank.label} には冷却散水設備・発泡装置がありません`);
  const side = (n: PNode, t: PNode) => (n.x < t.x ? "左側" : "右側");

  // 同じヤードのタンクと、横に隣り合うタンク（左右それぞれ最も近いもの）
  const yardTanks = g.facility.nodes.filter(
    (n) => n.kind === "tank" && n.id !== tank.id && n.area === tank.area && tankOutlets(g, n).length > 0
  );
  const row = yardTanks.filter((n) => Math.abs(n.y - tank.y) < 60);
  const nearest = (list: PNode[]) => list.sort((a, b) => dist(a, tank) - dist(b, tank))[0];
  const neighbours = [nearest(row.filter((n) => n.x < tank.x)), nearest(row.filter((n) => n.x > tank.x))].filter(
    (n): n is PNode => !!n
  );
  // 隣接タンクの、対象タンク側の冷却散水
  const adjacent = neighbours.flatMap((nb) =>
    tankOutlets(g, nb).filter((o) => o.kind === "sprinkler" && (nb.x < tank.x ? o.x > nb.x : o.x < nb.x))
  );

  // 主消火ポンプ（水）と取水元
  const waterPumps = g.facility.nodes.filter((n) => n.kind === "pump" && n.fluid === "water");
  const firstTarget = sprinklers[0] ?? chambers[0];
  const pumpCands = [
    ...waterPumps.filter((p) => p.name.includes("主")),
    ...waterPumps.filter((p) => !p.name.includes("主") && !/補助|予備/.test(p.name)),
    ...waterPumps.filter((p) => /予備/.test(p.name)),
  ];
  const pump = pumpCands.find((p) => shortestPath(g, p.id, firstTarget.id));
  if (!pump) return fail("試験対象タンクへ送水できる消火ポンプが見つかりません");
  const sources = g.facility.nodes.filter((n) => (n.kind === "source" || n.kind === "tank") && n.fluid === "water");
  const srcRoute = sources
    .map((s) => shortestPath(g, s.id, pump.id))
    .filter((r): r is Route => !!r)
    .sort((a, b) => a.pipeIds.length - b.pipeIds.length)[0];
  if (!srcRoute) return fail(`${pump.label} の取水元が見つかりません`);

  // 消火栓：同じヤードのものを優先し、対象タンクに近いものから（送水できるものだけ）
  const pickHydrants = (foam: boolean, count: number) =>
    g.facility.nodes
      .filter((n) => n.kind === "hydrant" && isFoam(n) === foam)
      .sort((a, b) => Number(a.area !== tank.area) - Number(b.area !== tank.area) || dist(a, tank) - dist(b, tank))
      .map((h) => ({ h, r: shortestPath(g, pump.id, h.id) }))
      .filter((x): x is { h: PNode; r: Route } => !!x.r)
      .slice(0, count);
  const waterHydrants = pickHydrants(false, FIRE_TEST_HYDRANTS.water);
  const foamHydrants = pickHydrants(true, FIRE_TEST_HYDRANTS.foam);

  // 水系統の経路（取水元 → ポンプ → 冷却散水・消火栓）
  const sprRoutes: Route[] = [];
  for (const o of [...sprinklers, ...adjacent]) {
    const r = shortestPath(g, pump.id, o.id);
    if (!r) return fail(`${o.label} へ送水する経路が見つかりません`);
    sprRoutes.push(r);
  }
  const waterRoute = unionRoute([srcRoute, ...sprRoutes, ...waterHydrants.map((x) => x.r)]);

  // 泡系統の経路（ポンプ → 泡混合器 → 発泡装置・泡消火栓）と、泡原液（泡原液タンク → 泡原液ポンプ → 泡混合器）
  const foamRoutes: Route[] = [];
  for (const o of chambers) {
    const r = shortestPath(g, pump.id, o.id);
    if (!r) return fail(`${o.label} へ泡水溶液を送る経路が見つかりません`);
    foamRoutes.push(r);
  }
  foamRoutes.push(...foamHydrants.map((x) => x.r));
  const proportioner = foamRoutes[0]?.nodeIds.find((n) => g.nodeById.get(n)!.kind === "proportioner");
  let concRoute: Route | null = null;
  let foamPump: PNode | null = null;
  if (proportioner) {
    concRoute =
      g.facility.nodes
        .filter((n) => n.kind === "tank" && n.fluid === "foam")
        .map((t) => shortestPath(g, t.id, proportioner))
        .filter((r): r is Route => !!r)
        .sort((a, b) => a.pipeIds.length - b.pipeIds.length)[0] ?? null;
    const fp = concRoute?.nodeIds.find((n) => g.nodeById.get(n)!.kind === "pump");
    foamPump = fp ? g.nodeById.get(fp)! : null;
  }
  const foamRoute = unionRoute([srcRoute, ...foamRoutes, ...(concRoute ? [concRoute] : [])]);

  // ───── 弁の区分 ─────
  const N = FIRE_TEST_STEPS.length;
  const b = (v: string) => base[v] ?? "close";
  const rows = new Map<string, { states: (ValveState | null)[]; note: string }>();
  const set = (v: string, note: string, changes: Record<number, ValveState>) => {
    if (rows.has(v)) return;
    const st: (ValveState | null)[] = Array(N).fill(null);
    st[0] = b(v);
    Object.entries(changes).forEach(([i, s]) => (st[Number(i)] = s));
    rows.set(v, { states: st, note });
  };
  const valvesOn = (r: Route) => [...new Set(r.nodeIds)].filter((n) => g.nodeById.get(n)!.kind === "valve");
  const label = (id: string) => g.nodeById.get(id)!.label;

  // 1) シリンダー弁：対象タンク（水・泡）と隣接タンクの対象側（水）→ 制御室で開、試験終了で閉
  const cylinders: string[] = [];
  const manualOpen: string[] = [];
  const outletNote = new Map<string, string>();
  sprinklers.forEach((o) => outletNote.set(o.id, `${tank.label} 冷却散水（${side(o, tank)}）`));
  chambers.forEach((o) => outletNote.set(o.id, `${tank.label} 発泡装置（${side(o, tank)}）`));
  adjacent.forEach((o) => {
    const nb = neighbours.find((t) => o.name.startsWith(`${t.id} `) || o.name.startsWith(`${t.label} `))!;
    outletNote.set(o.id, `隣接タンク ${nb.label} の ${tank.label} 側の冷却散水（${side(o, nb)}）`);
  });
  [...sprinklers, ...adjacent, ...chambers].forEach((o) => {
    branchValves(g, o.id).forEach((v) => {
      if (isCylinder(g.nodeById.get(v)!)) cylinders.push(v);
      else manualOpen.push(v);
      outletNote.set(v, outletNote.get(o.id)!);
    });
  });
  // 2) 消火栓の開閉弁（消火栓の直前の弁）：水は水系統試験、泡は泡系統試験で開け、試験終了で閉
  const hydValveOf = (x: { h: PNode; r: Route }) => {
    const v = x.r.nodeIds[x.r.nodeIds.length - 2];
    return g.nodeById.get(v)!.kind === "valve" ? v : null;
  };

  const pumpRows: PlanRow[] = [];
  const pumpRow = (p: PNode, on: number, note: string): PlanRow => {
    const st: (ValveState | null)[] = Array(N).fill(null);
    st[0] = "close";
    st[on] = "open";
    st[S.end] = "close";
    return { code: p.label, nodeId: p.id, name: p.name, role: "pump", states: st, note };
  };
  pumpRows.push(pumpRow(pump, S.pumpOn, "ポンプ起動の工程で起動、試験終了で停止"));
  if (foamPump) pumpRows.push(pumpRow(foamPump, S.foam, "泡系統試験で起動、試験終了で停止"));

  // 経路上の弁（シリンダー弁・消火栓の弁以外）
  const hydWater = waterHydrants.map(hydValveOf).filter((v): v is string => !!v);
  const hydFoam = foamHydrants.map(hydValveOf).filter((v): v is string => !!v);
  const special = new Set([...cylinders, ...hydWater, ...hydFoam]);
  const waterValves = valvesOn(waterRoute).filter((v) => !special.has(v));
  const waterSet = new Set(waterValves);
  const foamOnly = valvesOn(foamRoute).filter((v) => !special.has(v) && !waterSet.has(v));

  // ラインナップ：水系統の経路の弁（閉のものは開ける）
  waterValves.forEach((v) =>
    set(v, outletNote.get(v) ? `${outletNote.get(v)} の手動弁` : "水系統の経路", b(v) === "open" ? { [S.lineup]: "open" } : { [S.lineup]: "open", [S.restore]: b(v) })
  );
  // 泡系統の経路の弁：普段開のものはラインナップで確認、普段閉のもの（混合器送水弁・泡水溶液主弁・泡原液系統）は泡系統試験で開ける
  foamOnly.forEach((v) =>
    set(
      v,
      outletNote.get(v) ? `${outletNote.get(v)} の手動弁` : b(v) === "open" ? "泡系統の経路" : "泡系統試験で開、試験終了で閉",
      b(v) === "open" ? { [S.lineup]: "open" } : { [S.lineup]: "close", [S.foam]: "open", [S.end]: "close" }
    )
  );
  cylinders.forEach((v) =>
    set(v, `${outletNote.get(v)}：制御室で電磁弁を開操作`, { [S.lineup]: "close", [S.cylinder]: "open", [S.end]: "close" })
  );
  hydWater.forEach((v, i) =>
    set(v, `使用する消火栓（水）${i + 1}口目`, { [S.lineup]: "close", [S.water]: "open", [S.end]: "close" })
  );
  hydFoam.forEach((v, i) =>
    set(v, `使用する泡消火栓 ${i + 1}口目`, { [S.lineup]: "close", [S.foam]: "open", [S.end]: "close" })
  );

  // 同じヤードのほかのタンクの発泡装置：シリンダー弁の閉を確認、下流の手動弁を閉（復旧で開）
  const others = yardTanks.flatMap((t) => tankOutlets(g, t).filter((o) => o.kind === "foamChamber").map((o) => ({ t, o })));
  others.forEach(({ t, o }) => {
    branchValves(g, o.id).forEach((v) => {
      const cy = isCylinder(g.nodeById.get(v)!);
      const what = `同じヤードの ${t.label} 発泡装置（${side(o, t)}）`;
      set(v, cy ? `${what}：シリンダー弁の閉を確認` : `${what}：誤放出防止のため閉`, cy ? { [S.lineup]: "close" } : { [S.lineup]: "close", [S.restore]: b(v) });
    });
  });

  // 試験範囲外への分岐：普段開の弁は閉めて仕切る（ポンプ室内の弁は待機状態を保つため除く）。普段閉の弁は閉を確認
  const pumpArea = pump.area;
  const sideOf = (r: Route) => routeSideValves(g, r).filter((v) => g.nodeById.get(v)!.area !== pumpArea);
  [...sideOf(waterRoute), ...sideOf(foamRoute)].forEach((v) => {
    if (special.has(v) || waterSet.has(v)) return;
    set(
      v,
      b(v) === "open" ? "試験範囲外との仕切り（復旧で開）" : "試験範囲外との仕切り（閉を確認）",
      b(v) === "open" ? { [S.lineup]: "close", [S.restore]: "open" } : { [S.lineup]: "close" }
    );
  });

  const order: Record<string, number> = {};
  const rank = (v: string) => {
    const r = rows.get(v)!;
    const first = r.states.findIndex((s, i) => i > 0 && s !== null && s !== r.states[0]);
    return first < 0 ? 0 : first;
  };
  [...rows.keys()].forEach((v, i) => (order[v] = i));
  const valveRows: PlanRow[] = [...rows.entries()]
    .sort(([a], [c]) => rank(a) - rank(c) || order[a] - order[c])
    .map(([v, r]) => {
      const n = g.nodeById.get(v)!;
      return { code: n.label, nodeId: v, name: n.name, role: "route", states: r.states, note: r.note };
    });

  const names = (list: PNode[]) => list.map((n) => n.label).join("・");
  const ids = (list: string[]) => list.map(label).join("・");
  const sprAll = [...sprinklers, ...adjacent];
  const foamNames = names(foamHydrants.map((x) => x.h));
  return {
    rows: [...pumpRows, ...valveRows],
    stepRoutes: { [S.pumpOn]: waterRoute, [S.water]: waterRoute, [S.foam]: foamRoute },
    stepNotes: {
      [S.lineup]: `${tank.label} の機能試験のラインナップ。試験に使う経路の弁の開、シリンダー弁・消火栓の閉を確認し、同じヤードのほかのタンクの発泡装置の手動弁と、試験範囲外へ分岐する弁を閉めます。`,
      [S.cylinder]: `制御室でシリンダー弁（電磁弁）を開操作：${ids(cylinders)}`,
      [S.pumpOn]: `取水元を確認して ${pump.label}（${pump.name}）を起動します。冷却散水（${names(sprAll)}）から放水が始まります。`,
      [S.water]: `水系統試験：冷却散水 ${names(sprAll)} の放水状況を確認し、消火栓 ${names(waterHydrants.map((x) => x.h))}（${waterHydrants.length}口）を開けて放水します。終わったら「試験完了」を押してください。`,
      [S.foam]: `泡系統試験：${foamPump ? `${foamPump.label} を起動し、` : ""}泡混合器の送水弁・泡水溶液の弁を開けて、発泡装置 ${names(chambers)} と泡消火栓 ${foamNames}（${foamHydrants.length}口）から泡を放射します。終わったら「試験完了」を押してください。`,
      [S.end]: `試験終了：${[pump, ...(foamPump ? [foamPump] : [])].map((p) => p.label).join("・")} を停止し、シリンダー弁（制御室）・消火栓・泡系統の弁を閉めます。泡水溶液が残った配管・消火栓は必要に応じて清水で洗浄します。`,
      [S.restore]: "復旧：ラインナップで閉めた弁（ほかのタンクの発泡装置の手動弁・試験範囲外との仕切り弁）を開け、待機状態に戻します。",
    },
    summary: {
      sprinklers: sprinklers.map((n) => n.label),
      adjacent: adjacent.map((n) => n.label),
      foamChambers: chambers.map((n) => n.label),
      waterHydrants: waterHydrants.map((x) => x.h.label),
      foamHydrants: foamHydrants.map((x) => x.h.label),
      pump: pump.label,
      foamPump: foamPump?.label ?? null,
    },
  };
}
