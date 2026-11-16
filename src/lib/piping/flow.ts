import type { SavedPlan } from "./checklist";
import { canFlow, openPath, routeLengthM, shortestPath, type Graph } from "./graph";
import type { ValveState } from "./types";

// 工程ごとの燃料の流れ（抜取：範囲内 → ドレン口、充填：供給元 → 範囲内）を求める。
// 図面では配管ごとに「どちらの端から流れるか」を使って矢印と流れアニメーションを描く。

export type StepFlow = {
  kind: "drain" | "fill" | "route";
  /** 配管ID → 流れの上流側ノードID */
  directions: Map<string, string>;
  /** 流れの起点（抜取：ドレン口、充填：供給元） */
  origins: string[];
};

/**
 * 起点から、許可された配管・開いている弁だけを通って広がる流れを求める。
 * towardOrigin=true なら流れは起点へ向かう（抜取）、false なら起点から外へ向かう（充填）。
 */
function spread(
  g: Graph,
  origins: string[],
  allowedPipes: Set<string>,
  state: Record<string, ValveState>,
  towardOrigin: boolean
): Map<string, string> {
  const directions = new Map<string, string>();
  const seen = new Set(origins);
  const queue = [...origins];
  while (queue.length) {
    const cur = queue.shift()!;
    const node = g.nodeById.get(cur)!;
    // 閉じている弁の先へは流れない（起点の弁自身は除く）
    if (!origins.includes(cur) && node.kind === "valve" && state[cur] !== "open") continue;
    for (const { pipe, other } of g.adj.get(cur)!) {
      if (!allowedPipes.has(pipe.id) || directions.has(pipe.id)) continue;
      // ドレン口・圧力計取付口・安全弁への枝管には燃料が入るが、流れとしては描かない（起点のドレンは除く）
      const kind = g.nodeById.get(other)!.kind;
      if ((kind === "drain" || kind === "gauge" || kind === "psv") && !origins.includes(other)) continue;
      // 逆止弁は順方向にしか流れない（抜取は other → cur、充填は cur → other へ流れる）
      if (towardOrigin ? !canFlow(g, other, cur) : !canFlow(g, cur, other)) continue;
      directions.set(pipe.id, towardOrigin ? other : cur);
      if (!seen.has(other)) {
        seen.add(other);
        queue.push(other);
      }
    }
  }
  return directions;
}

/**
 * 充填ラインの流れ：この工程で開ける充填弁（V-FLA などの充填元弁 → … → 範囲側の充填弁）を、
 * 開いている弁だけを通ってたどる。保存した配管の一覧（fillPipeIds）には頼らない（系統図の作り方によって
 * 区間全体が入っていることがあるため）。範囲側の充填弁からは、範囲内へ流れ込む向きで描く。
 */
function fillLineFlow(
  g: Graph,
  plan: SavedPlan,
  step: number,
  state: Record<string, ValveState>,
  region: Set<string>
): { origin: string; directions: Map<string, string> } | null {
  const valves = [
    ...new Set(
      plan.rows
        .filter((r) => r.role === "fill" && r.nodeId && r.states[step] === "open" && g.nodeById.get(r.nodeId)?.kind === "valve")
        .map((r) => r.nodeId!)
    ),
  ];
  if (valves.length < 2) return null;
  const isOpen = (id: string) => state[id] === "open";
  const allPipes = [...g.pipeById.keys()];
  // 範囲側の充填弁：経路を除いた先が、閉じた弁を越えずに範囲内の配管へつながる弁
  const reachesRegion = (v: string, exclude: Set<string>) => {
    const d = spread(g, [v], new Set(allPipes.filter((p) => !exclude.has(p))), state, false);
    return { touches: [...d.keys()].some((p) => region.has(p)), d };
  };
  // 開いている充填弁どうしを結ぶ経路のうち、最も長いもの（充填元弁 → 範囲側の充填弁）
  let best: { a: string; b: string; route: { nodeIds: string[]; pipeIds: string[] }; len: number } | null = null;
  for (let i = 0; i < valves.length; i++)
    for (let j = i + 1; j < valves.length; j++) {
      const route = openPath(g, valves[i], valves[j], isOpen);
      if (!route) continue;
      const len = routeLengthM(g, route);
      if (!best || len > best.len) best = { a: valves[i], b: valves[j], route, len };
    }
  if (!best) return null;
  const onRoute = new Set(best.route.pipeIds);
  const fromB = reachesRegion(best.b, onRoute);
  const fromA = fromB.touches ? null : reachesRegion(best.a, onRoute);
  if (!fromB.touches && !fromA?.touches) return null;
  // 起点（充填元弁）→ 範囲側の充填弁の向きにそろえる
  const forward = fromB.touches;
  const nodeIds = forward ? best.route.nodeIds : [...best.route.nodeIds].reverse();
  const pipeIds = forward ? best.route.pipeIds : [...best.route.pipeIds].reverse();
  const directions = new Map<string, string>();
  pipeIds.forEach((pid, i) => directions.set(pid, nodeIds[i]));
  // 範囲側の充填弁 → 範囲内の最初の配管までのつなぎ → 範囲内（範囲の外へは広げない）
  const d = forward ? fromB.d : fromA!.d;
  const entry = [...d.keys()].find((p) => region.has(p))!;
  const entryNode = d.get(entry)!;
  const inlet = nodeIds[nodeIds.length - 1];
  const stub = openPath(g, inlet, entryNode, isOpen);
  stub?.pipeIds.forEach((pid, i) => directions.set(pid, stub.nodeIds[i]));
  spread(g, [entryNode], region, state, false).forEach((v, k) => directions.set(k, v));
  return { origin: nodeIds[0], directions };
}

/** 流れの線の色（抜取：青、充填：緑、循環・移送：紫） */
export function flowColor(kind: StepFlow["kind"]) {
  return kind === "drain" ? "#0284c7" : kind === "fill" ? "#0d9488" : "#9333ea";
}

export function stepFlow(
  g: Graph,
  plan: SavedPlan,
  step: number,
  state: Record<string, ValveState>
): StepFlow | null {
  const name = plan.steps[step];
  // 当日の選択で決まった経路（末端部の循環・タンク縁切りの移送）は、その順に流れとして描く
  const route = plan.stepRoutes?.[step];
  if (route?.pipeIds.length) {
    const directions = new Map<string, string>();
    route.pipeIds.forEach((pid, i) => directions.set(pid, route.nodeIds[i]));
    return { kind: "route", directions, origins: [route.nodeIds[0]] };
  }
  const region = new Set(plan.regionPipeIds);
  if (!region.size) return null;

  if (name === "抜取") {
    const openDrainRows = new Set(
      plan.rows.filter((r) => r.role === "drain" && r.nodeId && r.states[step] === "open").map((r) => r.nodeId!)
    );
    // 抜取用配管つきのドレン口は、ドレン弁（ルートの最初の弁）が開いていれば起点にする
    const origins = [
      ...[...openDrainRows].filter((id) => g.nodeById.get(id)?.kind === "drain"),
      ...g.facility.nodes
        .filter((n) => n.drainRoute?.length && openDrainRows.has(n.drainRoute[0]) && plan.regionNodeIds.includes(n.id))
        .map((n) => n.id),
    ];
    if (!origins.length) return null;
    const directions = spread(g, origins, region, state, true);
    // 抜取用配管につながるドレン口は、その先（ドレン弁 → 抜取ポンプ → 回収先タンク）も流れとして描く
    origins.forEach((d) => {
      const target = g.nodeById.get(d)?.drainTarget;
      const route = target ? shortestPath(g, d, target) : null;
      // ドレン口〜ドレン弁の配管は抜取範囲にも含まれるが、向きは抜取ポンプ側へ流れる向きを優先する
      route?.pipeIds.forEach((pid, i) => directions.set(pid, route.nodeIds[i]));
    });
    return { kind: "drain", directions, origins };
  }

  if (name === "充填") {
    const supplyPipes = plan.fillSupply?.pipeIds ?? [];
    const line = fillLineFlow(g, plan, step, state, region);
    if (line) {
      const directions = new Map(line.directions);
      const origins = [line.origin];
      // 当日に充填元タンク・移送ポンプを選んでいれば、充填元タンク → 移送ポンプ → 供給元 → 充填元弁 も描く
      if (plan.fillSupply && supplyPipes.length) {
        spread(g, [plan.fillSupply.tank], new Set(supplyPipes), state, false).forEach((v, k) => directions.set(k, v));
        const source = supplyPipes
          .flatMap((pid) => [g.pipeById.get(pid)?.a, g.pipeById.get(pid)?.b])
          .find((n) => n && g.nodeById.get(n)?.fillSource);
        const toLine = source ? openPath(g, source, line.origin, (id) => state[id] === "open") : null;
        toLine?.pipeIds.forEach((pid, i) => directions.set(pid, toLine.nodeIds[i]));
        origins.unshift(plan.fillSupply.tank);
      }
      return { kind: "fill", directions, origins };
    }
    // 充填ラインが無いときは、微開する遮断弁から範囲内へ流れ込む
    const fillPipes = plan.fillPipeIds ?? [];
    const allowed = new Set([...region, ...fillPipes, ...supplyPipes]);
    const origins = plan.rows.filter((r) => r.role === "boundary" && r.nodeId && r.states[step] === "open").map((r) => r.nodeId!);
    if (!origins.length) return null;
    return { kind: "fill", directions: spread(g, origins, allowed, state, false), origins };
  }
  return null;
}

/** 当日の選択などで決まる経路の種類（循環・移送・消火試験・ユーザー定義の作業の経路） */
export type RouteFlowKind = "flush" | "transfer" | "fire" | "route";

/** 図面・凡例に出す流れ（同じ経路を使う工程はまとめる） */
export type RouteFlowGroup = {
  key: string;
  /** 凡例の名前（使う工程つき） */
  label: string;
  color: string;
  /** この経路を使う工程の番号 */
  steps: number[];
  pipeIds: string[];
  /** 配管ID → 流れの上流側ノードID */
  directions: Map<string, string>;
};

/** 経路ごとの流れの色（燃料抜取の抜取：青・充填：緑と同じく、流れの種類ごとに色を分ける） */
export const ROUTE_FLOW_COLORS = {
  flush: "#9333ea",
  issue: "#9333ea",
  move: "#d97706",
  water: "#2563eb",
  foam: "#ea580c",
  route: "#9333ea",
} as const;

/**
 * 工程ごとの経路（stepRoutes）を、流れの種類ごとにまとめて名前と色を付ける。
 * 燃料抜取の「抜取の流れ（抜取系統）」「充填ライン」と同じく、図面では種類ごとの色と向きで描き、凡例に並べる。
 */
export function routeFlowGroups(
  stepRoutes: Record<number, { nodeIds: string[]; pipeIds: string[] }> | undefined,
  steps: string[],
  kind: RouteFlowKind
): RouteFlowGroup[] {
  const groups: (RouteFlowGroup & { id: string })[] = [];
  Object.entries(stepRoutes ?? {})
    .map(([i, r]) => [Number(i), r] as const)
    .filter(([, r]) => r.pipeIds.length)
    .sort(([a], [b]) => a - b)
    .forEach(([i, r]) => {
      const id = `${r.nodeIds[0]}|${r.pipeIds.join(",")}`;
      const same = groups.find((x) => x.id === id);
      if (same) return void same.steps.push(i);
      const directions = new Map<string, string>();
      r.pipeIds.forEach((pid, k) => directions.set(pid, r.nodeIds[k]));
      groups.push({ id, key: `route-${groups.length}`, label: "", color: "", steps: [i], pipeIds: r.pipeIds, directions });
    });
  return groups.map((grp, n) => {
    const names = grp.steps.map((i) => steps[i] ?? `工程${i}`);
    const foam = names.some((s) => s.includes("泡"));
    const [name, color] =
      kind === "flush"
        ? ["循環の流れ（循環経路）", ROUTE_FLOW_COLORS.flush]
        : kind === "transfer"
          ? n === 0
            ? ["移送の流れ（払出系統）", ROUTE_FLOW_COLORS.issue]
            : ["移送の流れ（移送系統）", ROUTE_FLOW_COLORS.move]
          : kind === "fire"
            ? foam
              ? ["泡の流れ（泡系統）", ROUTE_FLOW_COLORS.foam]
              : ["水の流れ（水系統）", ROUTE_FLOW_COLORS.water]
            : [groups.length > 1 ? `作業の流れ${n + 1}` : "作業の流れ", ROUTE_FLOW_COLORS.route];
    const { key, steps: used, pipeIds, directions } = grp;
    return { key, label: `${name}：${names.join("・")}`, color, steps: used, pipeIds, directions };
  });
}
