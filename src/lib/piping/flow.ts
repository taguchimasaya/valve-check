import type { SavedPlan } from "./checklist";
import { canFlow, shortestPath, type Graph } from "./graph";
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
    const fillPipes = plan.fillPipeIds ?? [];
    const supplyPipes = plan.fillSupply?.pipeIds ?? [];
    const allowed = new Set([...region, ...fillPipes, ...supplyPipes]);
    // 充填ラインがあれば供給元（移送系統の分岐点）から、無ければ微開する遮断弁から流れ込む
    const source = fillPipes
      .flatMap((pid) => {
        const p = g.pipeById.get(pid)!;
        return [p.a, p.b];
      })
      .find((n) => g.nodeById.get(n)?.fillSource);
    const origins = plan.fillSupply && supplyPipes.length
      ? [plan.fillSupply.tank]
      : source
      ? [source]
      : plan.rows.filter((r) => r.role === "boundary" && r.nodeId && r.states[step] === "open").map((r) => r.nodeId!);
    if (!origins.length) return null;
    return { kind: "fill", directions: spread(g, origins, allowed, state, false), origins };
  }
  return null;
}
