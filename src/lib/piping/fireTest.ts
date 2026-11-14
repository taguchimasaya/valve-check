import type { PlanRow } from "./checklist";
import { routeSections, routeSideValves, secondBlock, shortestPath, type Graph, type Route } from "./graph";
import { DEFAULT_BLOCK_METHOD, DEFAULT_FIRE_TEST_RULES, fireTestSteps, type BlockMethod, type FireTestRules } from "./rules";
import type { PNode, ValveState } from "./types";

// 消火設備の機能試験チェックリスト。試験対象タンクを選ぶと、拠点ごとに登録したルール（rules.ts）に従って弁・ポンプの行を作る。
// 既定のルール：
//  ・対象タンクは発泡装置（泡）を使う（シリンダー弁を開、手動弁は開を確認）。対象タンクの冷却散水からは散水しない（閉を確認）
//  ・隣接タンク（同じヤードで上下・左右に並ぶタンク）は、対象タンクに向いた側の冷却散水を使う
//  ・同じヤードのほかのタンクの発泡装置は、シリンダー弁の閉を確認し、下流の手動弁を閉める（誤放出防止）
//  ・試験に使う経路から試験範囲外へ分岐する弁で、普段開いているものは閉めて仕切る（ポンプ室内の弁は待機状態のまま）
//  ・消火栓は同じヤードを優先し、対象タンクに近いものから 水4口・泡3口 を使う
//  ・工程：作業前 → ラインナップ → シリンダー弁開（制御室）→ ポンプ起動 → 泡系統試験 → 水系統試験 → 試験終了 → 復旧

/** 既定のルールの工程（ルールで順番が変わる） */
export const FIRE_TEST_STEPS = fireTestSteps(DEFAULT_FIRE_TEST_RULES);

export type FireTestResult = {
  rows: PlanRow[];
  stepNotes: Record<number, string>;
  stepRoutes: Record<number, Route>;
  error?: string;
  /** 画面表示用：試験で使う設備 */
  summary?: {
    /** 対象タンクの冷却散水（ルールで散水しない場合） */
    idleSprinklers: string[];
    /** 対象タンクの冷却散水（ルールで散水する場合） */
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

/** シリンダー弁か（名称に含む語、または番号の先頭で判定） */
function cylinderTest(keywords: string) {
  const keys = keywords
    .split(/[,、]/)
    .map((k) => k.trim())
    .filter(Boolean);
  return (n: PNode) => keys.some((k) => n.name.includes(k) || n.label.toUpperCase().startsWith(k.toUpperCase()));
}

/** タンクに付いている放出口（冷却散水設備・タンク発泡装置）。名称の先頭のタンク番号で判定する */
export function tankOutlets(g: Graph, tank: PNode) {
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
export function branchValves(g: Graph, outlet: string) {
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
export function unionRoute(routes: Route[]): Route {
  const up = new Map<string, string>();
  routes.forEach((r) => r.pipeIds.forEach((p, i) => up.has(p) || up.set(p, r.nodeIds[i])));
  return { pipeIds: [...up.keys()], nodeIds: [...up.values()] };
}

const dist = (a: PNode, b: PNode) => Math.hypot(a.x - b.x, a.y - b.y);

export function buildFireTestChecklist(
  g: Graph,
  tankId: string,
  base: Record<string, ValveState>,
  rules: FireTestRules = DEFAULT_FIRE_TEST_RULES,
  method: BlockMethod = DEFAULT_BLOCK_METHOD
): FireTestResult {
  const fail = (error: string): FireTestResult => ({ rows: [], stepNotes: {}, stepRoutes: {}, error });
  const steps = fireTestSteps(rules);
  const S = {
    lineup: 1,
    cylinder: 2,
    pumpOn: 3,
    foam: steps.indexOf("泡系統試験"),
    water: steps.indexOf("水系統試験"),
    end: steps.indexOf("試験終了"),
    restore: steps.indexOf("復旧"),
  };
  const isCylinder = cylinderTest(rules.cylinderKeywords);
  const tank = g.nodeById.get(tankId);
  if (!tank || tank.kind !== "tank") return fail("試験対象のタンクを選んでください");
  const outlets = tankOutlets(g, tank);
  const sprinklers = outlets.filter((n) => n.kind === "sprinkler");
  const chambers = outlets.filter((n) => n.kind === "foamChamber");
  const usedOwn = rules.testTankSprinkle ? sprinklers : [];
  // 放出口がタンクのどちら側にあるか（上下左右）
  const side = (n: PNode, t: PNode) => {
    const dx = n.x - t.x;
    const dy = n.y - t.y;
    return Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? "左側" : "右側") : dy < 0 ? "上側" : "下側";
  };

  // 同じヤードのタンクと、隣り合うタンク（ルールで選んだ並びの、それぞれの向きで最も近いもの）
  const yardTanks = g.facility.nodes.filter(
    (n) => n.kind === "tank" && n.id !== tank.id && n.area === tank.area && tankOutlets(g, n).length > 0
  );
  const near = 60;
  const sameRow = (n: PNode) => Math.abs(n.y - tank.y) < near;
  const sameCol = (n: PNode) => Math.abs(n.x - tank.x) < near;
  const nearest = (list: PNode[]) => [...list].sort((a, b) => dist(a, tank) - dist(b, tank))[0];
  const { horizontal, vertical, diagonal } = rules.adjacency;
  const neighbours = [
    ...(horizontal
      ? [nearest(yardTanks.filter((n) => sameRow(n) && n.x < tank.x)), nearest(yardTanks.filter((n) => sameRow(n) && n.x > tank.x))]
      : []),
    ...(vertical
      ? [nearest(yardTanks.filter((n) => sameCol(n) && n.y < tank.y)), nearest(yardTanks.filter((n) => sameCol(n) && n.y > tank.y))]
      : []),
    ...(diagonal
      ? [-1, 1].flatMap((sx) =>
          [-1, 1].map((sy) =>
            nearest(yardTanks.filter((n) => !sameRow(n) && !sameCol(n) && Math.sign(n.x - tank.x) === sx && Math.sign(n.y - tank.y) === sy))
          )
        )
      : []),
  ].filter((n): n is PNode => !!n);
  // 隣接タンクの冷却散水（向いた側だけ：隣接タンクから見て対象タンクの方向に最も近い向きのもの）
  const adjacent =
    rules.adjacentLines === "none"
      ? []
      : neighbours.flatMap((nb) => {
          const list = tankOutlets(g, nb).filter((o) => o.kind === "sprinkler");
          if (rules.adjacentLines === "all") return list;
          const tx = tank.x - nb.x;
          const ty = tank.y - nb.y;
          const tl = Math.hypot(tx, ty);
          const facing = (o: PNode) => ((o.x - nb.x) * tx + (o.y - nb.y) * ty) / (tl * (Math.hypot(o.x - nb.x, o.y - nb.y) || 1));
          const best = [...list].sort((a, b) => facing(b) - facing(a))[0];
          return best ? [best] : [];
        });
  const sprUsed = [...usedOwn, ...adjacent];
  if (!chambers.length && !sprUsed.length) return fail(`${tank.label} の試験で使う発泡装置・冷却散水がありません（ルールを確認してください）`);

  // 主消火ポンプ（水）と取水元
  const waterPumps = g.facility.nodes.filter((n) => n.kind === "pump" && n.fluid === "water");
  const firstTarget = chambers[0] ?? sprUsed[0];
  const key = rules.mainPumpKeyword.trim();
  const isMain = (p: PNode) => !!key && p.name.includes(key);
  const pumpCands = [
    ...waterPumps.filter(isMain),
    ...waterPumps.filter((p) => !isMain(p) && !/補助|予備/.test(p.name)),
    ...waterPumps.filter((p) => !isMain(p) && /予備/.test(p.name)),
  ];
  const pump = pumpCands.find((p) => shortestPath(g, p.id, firstTarget.id));
  if (!pump) return fail("試験対象タンクへ送水できる消火ポンプが見つかりません");
  const sources = g.facility.nodes.filter((n) => (n.kind === "source" || n.kind === "tank") && n.fluid === "water");
  const srcRoute = sources
    .map((s) => shortestPath(g, s.id, pump.id))
    .filter((r): r is Route => !!r)
    .sort((a, b) => a.pipeIds.length - b.pipeIds.length)[0];
  if (!srcRoute) return fail(`${pump.label} の取水元が見つかりません`);

  // 消火栓：（ルールにより同じヤードを優先し）対象タンクに近いものから（送水できるものだけ）
  const areaRank = (n: PNode) => (rules.hydrantSameAreaFirst ? Number(n.area !== tank.area) : 0);
  const pickHydrants = (foam: boolean, count: number) =>
    g.facility.nodes
      .filter((n) => n.kind === "hydrant" && isFoam(n) === foam)
      .sort((a, b) => areaRank(a) - areaRank(b) || dist(a, tank) - dist(b, tank))
      .map((h) => ({ h, r: shortestPath(g, pump.id, h.id) }))
      .filter((x): x is { h: PNode; r: Route } => !!x.r)
      .slice(0, count);
  const waterHydrants = pickHydrants(false, rules.waterHydrants);
  const foamHydrants = pickHydrants(true, rules.foamHydrants);

  // 水系統の経路（取水元 → ポンプ → 冷却散水・消火栓）
  const sprRoutes: Route[] = [];
  for (const o of sprUsed) {
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
  const N = steps.length;
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

  // 1) 試験で使う放出口の枝の弁：シリンダー弁は開ける、手動弁は開を確認
  const sprCylinders: string[] = [];
  const foamCylinders: string[] = [];
  const outletNote = new Map<string, string>();
  usedOwn.forEach((o) => outletNote.set(o.id, `${tank.label} 冷却散水（${side(o, tank)}）`));
  chambers.forEach((o) => outletNote.set(o.id, `${tank.label} 発泡装置（${side(o, tank)}）`));
  adjacent.forEach((o) => {
    const nb = neighbours.find((t) => o.name.startsWith(`${t.id} `) || o.name.startsWith(`${t.label} `))!;
    outletNote.set(o.id, `隣接タンク ${nb.label} の冷却散水（${side(o, nb)}）`);
  });
  [...sprUsed, ...chambers].forEach((o) => {
    branchValves(g, o.id).forEach((v) => {
      if (isCylinder(g.nodeById.get(v)!)) (o.kind === "sprinkler" ? sprCylinders : foamCylinders).push(v);
      outletNote.set(v, outletNote.get(o.id)!);
    });
  });
  // 2) 消火栓の開閉弁（消火栓の直前の弁）
  const hydValveOf = (x: { h: PNode; r: Route }) => {
    const v = x.r.nodeIds[x.r.nodeIds.length - 2];
    return g.nodeById.get(v)!.kind === "valve" ? v : null;
  };

  const pumpRow = (p: PNode, on: number, note: string): PlanRow => {
    const st: (ValveState | null)[] = Array(N).fill(null);
    st[0] = "close";
    st[on] = "open";
    st[S.end] = "close";
    return { code: p.label, nodeId: p.id, name: p.name, role: "pump", states: st, note };
  };
  const pumpRows: PlanRow[] = [pumpRow(pump, S.pumpOn, "ポンプ起動の工程で起動、試験終了で停止")];
  if (foamPump) pumpRows.push(pumpRow(foamPump, S.foam, "泡系統試験で起動、試験終了で停止"));

  // 経路上の弁（シリンダー弁・消火栓の弁以外）
  const hydWater = waterHydrants.map(hydValveOf).filter((v): v is string => !!v);
  const hydFoam = foamHydrants.map(hydValveOf).filter((v): v is string => !!v);
  const special = new Set([...sprCylinders, ...foamCylinders, ...hydWater, ...hydFoam]);
  const waterValves = valvesOn(waterRoute).filter((v) => !special.has(v));
  const waterSet = new Set(waterValves);
  const foamOnly = valvesOn(foamRoute).filter((v) => !special.has(v) && !waterSet.has(v));

  // ラインナップ：水系統の経路の弁（閉のものは開ける）
  waterValves.forEach((v) =>
    set(
      v,
      outletNote.get(v) ? `${outletNote.get(v)} の手動弁` : "水系統の経路",
      b(v) === "open" ? { [S.lineup]: "open" } : { [S.lineup]: "open", [S.restore]: b(v) }
    )
  );
  // 泡系統の経路の弁：普段開のものはラインナップで確認、普段閉のもの（混合器送水弁・泡水溶液主弁・泡原液系統）は泡系統試験で開ける
  foamOnly.forEach((v) =>
    set(
      v,
      outletNote.get(v) ? `${outletNote.get(v)} の手動弁` : b(v) === "open" ? "泡系統の経路" : "泡系統試験で開、試験終了で閉",
      b(v) === "open" ? { [S.lineup]: "open" } : { [S.lineup]: "close", [S.foam]: "open", [S.end]: "close" }
    )
  );
  const sprOpenStep = rules.sprinklerOpenAt === "waterStep" ? S.water : S.cylinder;
  sprCylinders.forEach((v) =>
    set(v, `${outletNote.get(v)}：${sprOpenStep === S.cylinder ? "制御室で電磁弁を開操作" : "水系統試験で電磁弁を開操作（制御室）"}`, {
      [S.lineup]: "close",
      [sprOpenStep]: "open",
      [S.end]: "close",
    })
  );
  foamCylinders.forEach((v) =>
    set(v, `${outletNote.get(v)}：制御室で電磁弁を開操作`, { [S.lineup]: "close", [S.cylinder]: "open", [S.end]: "close" })
  );
  hydWater.forEach((v, i) => set(v, `使用する消火栓（水）${i + 1}口目`, { [S.lineup]: "close", [S.water]: "open", [S.end]: "close" }));
  hydFoam.forEach((v, i) => set(v, `使用する泡消火栓 ${i + 1}口目`, { [S.lineup]: "close", [S.foam]: "open", [S.end]: "close" }));
  // 対象タンクの冷却散水を使わない場合：シリンダー弁の閉を確認
  if (!rules.testTankSprinkle) {
    sprinklers.forEach((o) =>
      branchValves(g, o.id)
        .filter((v) => isCylinder(g.nodeById.get(v)!))
        .forEach((v) => set(v, `${tank.label} 冷却散水（${side(o, tank)}）：試験タンクは散水しない（閉を確認）`, { [S.lineup]: "close" }))
    );
  }

  // 同じヤードのほかのタンクの発泡装置：シリンダー弁の閉を確認、（ルールにより）下流の手動弁を閉（復旧で開）
  yardTanks
    .flatMap((t) => tankOutlets(g, t).filter((o) => o.kind === "foamChamber").map((o) => ({ t, o })))
    .forEach(({ t, o }) => {
      branchValves(g, o.id).forEach((v) => {
        const cy = isCylinder(g.nodeById.get(v)!);
        const what = `同じヤードの ${t.label} 発泡装置（${side(o, t)}）`;
        if (cy) set(v, `${what}：シリンダー弁の閉を確認`, { [S.lineup]: "close" });
        else if (rules.closeOtherFoam) set(v, `${what}：誤放出防止のため閉`, { [S.lineup]: "close", [S.restore]: b(v) });
      });
    });

  // 試験範囲外への分岐：普段閉の弁は閉を確認、（ルールにより）普段開の弁は閉めて仕切る
  const sideOf = (r: Route) =>
    routeSideValves(g, r).filter((v) => !rules.keepPumpArea || g.nodeById.get(v)!.area !== pump.area);
  const firstSides = [...new Set([...sideOf(waterRoute), ...sideOf(foamRoute)])].filter((v) => !special.has(v) && !waterSet.has(v));
  firstSides.forEach((v) => {
    if (b(v) !== "open") set(v, "試験範囲外との仕切り（閉を確認）", { [S.lineup]: "close" });
    else if (rules.isolateOutside) set(v, "試験範囲外との仕切り（復旧で開）", { [S.lineup]: "close", [S.restore]: "open" });
  });
  // 2ブロック：仕切り弁の外側の弁も閉める（ブリードならその間のドレン口を開けて確認）
  if (method.blocks === 2 && rules.isolateOutside && firstSides.length) {
    const inside = new Set([...routeSections(g, waterRoute), ...routeSections(g, foamRoute)]);
    const sb = secondBlock(g, firstSides, inside);
    sb.valves
      .filter((v) => !special.has(v) && !waterSet.has(v) && (!rules.keepPumpArea || g.nodeById.get(v)!.area !== pump.area))
      .forEach((v) => {
        const what = `2ブロック目（${label(sb.ofValve.get(v)!)} の外側）`;
        if (b(v) !== "open") set(v, `${what}：閉を確認`, { [S.lineup]: "close" });
        else set(v, `${what}：復旧で開`, { [S.lineup]: "close", [S.restore]: "open" });
      });
    if (method.bleed)
      sb.bleeds
        .filter((d) => !rules.keepPumpArea || g.nodeById.get(d)!.area !== pump.area)
        .forEach((d) => set(d, "ブリード：2ブロックの間を抜いて漏れを確認", { [S.lineup]: "open", [S.restore]: b(d) }));
  }

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
  const sprayAtStart = sprUsed.length > 0 && sprOpenStep === S.cylinder;
  const sprWhat = `冷却散水（${names(sprUsed)}）`;
  const noOwn = !rules.testTankSprinkle && sprinklers.length ? `試験タンク ${tank.label} の冷却散水からは散水しません。` : "";
  const cylAtStep2 = [...(sprOpenStep === S.cylinder ? sprCylinders : []), ...foamCylinders];
  return {
    rows: [...pumpRows, ...valveRows],
    stepRoutes: {
      ...(sprayAtStart ? { [S.pumpOn]: waterRoute } : {}),
      [S.water]: waterRoute,
      [S.foam]: foamRoute,
    },
    stepNotes: {
      [S.lineup]: (() => {
        const closes = [
          ...(rules.closeOtherFoam ? ["同じヤードのほかのタンクの発泡装置の手動弁"] : []),
          ...(rules.isolateOutside ? ["試験範囲外へ分岐する弁"] : []),
        ];
        const head = `${tank.label} の機能試験のラインナップ。試験に使う経路の弁の開、シリンダー弁・消火栓の閉を確認`;
        return closes.length ? `${head}し、${closes.join("と、")}を閉めます。` : `${head}します。`;
      })(),
      [S.cylinder]: cylAtStep2.length ? `制御室でシリンダー弁（電磁弁）を開操作：${ids(cylAtStep2)}` : "この工程で開けるシリンダー弁はありません。",
      [S.pumpOn]: `取水元を確認して ${pump.label}（${pump.name}）を起動します。${sprayAtStart ? `${sprWhat}から放水が始まります。` : ""}${noOwn}`,
      [S.foam]: `泡系統試験：${foamPump ? `${foamPump.label} を起動し、` : ""}泡混合器の送水弁・泡水溶液の弁を開けて、発泡装置 ${
        names(chambers) || "—"
      } と泡消火栓 ${names(foamHydrants.map((x) => x.h)) || "—"}（${foamHydrants.length}口）から泡を放射します。終わったら「試験完了」を押してください。`,
      [S.water]: `水系統試験：${
        sprUsed.length ? (sprOpenStep === S.water ? `制御室で冷却散水のシリンダー弁 ${ids(sprCylinders)} を開け、` : "") + `${sprWhat}の放水状況を確認し、` : ""
      }消火栓 ${names(waterHydrants.map((x) => x.h)) || "—"}（${waterHydrants.length}口）を開けて放水します。終わったら「試験完了」を押してください。`,
      [S.end]: `試験終了：${[pump, ...(foamPump ? [foamPump] : [])].map((p) => p.label).join("・")} を停止し、シリンダー弁（制御室）・消火栓・泡系統の弁を閉めます。泡水溶液が残った配管・消火栓は必要に応じて清水で洗浄します。`,
      [S.restore]: "復旧：ラインナップで閉めた弁を開け、待機状態に戻します。",
    },
    summary: {
      idleSprinklers: rules.testTankSprinkle ? [] : sprinklers.map((n) => n.label),
      sprinklers: usedOwn.map((n) => n.label),
      adjacent: adjacent.map((n) => n.label),
      foamChambers: chambers.map((n) => n.label),
      waterHydrants: waterHydrants.map((x) => x.h.label),
      foamHydrants: foamHydrants.map((x) => x.h.label),
      pump: pump.label,
      foamPump: foamPump?.label ?? null,
    },
  };
}
