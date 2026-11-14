import type { PlanRow } from "./checklist";
import { routeSections, routeSideValves, secondBlock, shortestPath, type Graph, type Route } from "./graph";
import { branchValves, tankOutlets } from "./fireTest";
import { customStepsOf, type BlockSelector, type CustomWorkType, type RuleBlock } from "./rules";
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
      warnings.push(`ルール「${b.name}」に当てはまる機器がありません`);
      return;
    }
    nodes.forEach((n) => {
      const base: ValveState = isPump(n) ? "close" : ctx.base[n.id] ?? n.normal ?? "close";
      let row = byNode.get(n.id);
      if (!row) {
        const states: (ValveState | null)[] = Array(steps.length).fill(null);
        states[0] = base;
        row = { code: n.label, nodeId: n.id, name: n.name, role: isPump(n) ? "pump" : "route", states };
        out.push(row);
        byNode.set(n.id, row);
      }
      opSteps.forEach(([i, s]) => (row!.states[i] = s));
      if (b.restore && last > 0 && !opSteps.some(([i]) => i === last) && opSteps.length) row.states[last] = base;
      const note = b.note.trim() || b.name;
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
};

/** ユーザー定義の作業：工程とルールブロックだけでチェックリストを作る */
export function buildCustomChecklist(
  g: Graph,
  def: CustomWorkType,
  target: string | null,
  base: Record<string, ValveState>
): CustomResult {
  const steps = customStepsOf(def);
  const empty = { rows: [], stepNotes: {}, stepRoutes: {}, warnings: [], route: null };
  if (def.target !== "none" && !target) return { ...empty, error: "図面で対象を選んでください" };
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
