import type { SavedPlan } from "./checklist";
import { diagramToFacility, type DiagramData, type NodeData, type PipeData } from "./diagramData";
import { buildGraph, pipeVolumeL, type Graph } from "./graph";

// 系統図の版を切り替えるときの、既存チェックリストへの影響チェック。
// チェックリストは機器番号（弁・機器）と配管番号を保存しているので、作成時の版と新しい版を番号で突き合わせ、
// チェックリストが使う機器・配管の周りに変更があるかを調べて3段階に分ける：
// - none（影響なし）：使う機器・配管がそのまま残っている → 版の記録だけ新しくする
// - drawing（図面だけ変わる）：配管が節点（分岐・曲がり点）で分けられただけ → 配管番号を付け替えて描き直す
// - remake（作り直しが必要）：弁・機器の増減や属性の変更、配管のつながりの変更、容量の変化 → 承認を差し戻す

export type ImpactLevel = "none" | "drawing" | "remake";

/** 図面だけ変わるときの、チェックリストの配管番号の付け替え */
export type PlanPatch = Partial<Pick<SavedPlan, "regionPipeIds" | "sealPipeIds" | "fillPipeIds" | "flushPipeIds" | "targets" | "stepRoutes">>;

export type PlanImpact = {
  level: ImpactLevel;
  reasons: string[];
  patch?: PlanPatch;
};

/** 容量がこの割合を超えて変わったら作り直し（抜取量・時間の目安が変わるため） */
const VOLUME_TOLERANCE = 0.05;

/** 比べる機器の属性（位置・表示名・名称は図面の見た目なので比べない） */
const NODE_FIELDS: [keyof NodeData, string][] = [
  ["kind", "種類"],
  ["normal", "常時の開閉"],
  ["dir_from", "流れの向き"],
  ["service", "操作対象"],
  ["fill_line", "充填ライン"],
  ["fill_source", "充填の供給元"],
  ["drain_route", "抜取用配管"],
  ["drain_target", "回収先"],
  ["drain_system", "抜取系統"],
  ["drain_pump_lpm", "抜取ポンプ能力"],
  ["drain_size_a", "ドレン口径"],
  ["volume_l", "容量"],
  ["capacity_kl", "タンク容量"],
  ["rated_flow_lpm", "定格流量"],
  ["set_pressure_mpa", "設定圧力"],
  ["gauge_mountable", "圧力計取付"],
  ["small", "小型"],
  ["recovery", "回収設備"],
  ["fluid", "流体"],
];

/** false・空配列・undefined は null と同じに扱う（Excel の空欄と同じ意味） */
const norm = (v: unknown) => (v === undefined || v === false || (Array.isArray(v) && v.length === 0) ? null : v);
const same = (a: unknown, b: unknown) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

type Index = {
  nodes: Map<string, NodeData>;
  pipes: Map<string, PipeData>;
  adj: Map<string, PipeData[]>;
  graph: Graph;
};

export function indexDiagram(d: DiagramData): Index {
  const nodes = new Map(d.nodes.map((n) => [n.code, n]));
  const pipes = new Map(d.pipes.map((p) => [p.code, p]));
  const adj = new Map<string, PipeData[]>();
  d.pipes.forEach((p) => [p.node_a, p.node_b].forEach((n) => adj.set(n, [...(adj.get(n) ?? []), p])));
  return { nodes, pipes, adj, graph: buildGraph(diagramToFacility(d)) };
}

const ends = (p: PipeData) => [p.node_a, p.node_b].sort().join("|");

/** チェックリストが使う配管番号（一覧の名前つき） */
function pipeLists(plan: SavedPlan): Record<string, string[]> {
  return {
    regionPipeIds: plan.regionPipeIds ?? [],
    sealPipeIds: plan.sealPipeIds ?? [],
    fillPipeIds: plan.fillPipeIds ?? [],
    flushPipeIds: plan.flushPipeIds ?? [],
    targets: (plan.targets ?? []).filter((t) => t.type === "pipe").map((t) => t.id),
    stepRoutes: Object.values(plan.stepRoutes ?? {}).flatMap((r) => r.pipeIds),
  };
}

/** チェックリストが使う機器番号（弁の行・範囲・対象・当日の既定のタンク／ポンプ） */
function nodeRefs(plan: SavedPlan): string[] {
  return [
    ...plan.rows.map((r) => r.nodeId).filter((id): id is string => !!id),
    ...(plan.regionNodeIds ?? []),
    ...(plan.targets ?? []).filter((t) => t.type === "node").map((t) => t.id),
    ...[plan.isolationTank, plan.fireTestTank, plan.customTarget].filter((x): x is string => !!x),
    ...Object.entries(plan.dayDefaults ?? {})
      .filter(([k]) => k !== "kind")
      .map(([, v]) => String(v)),
  ];
}

/**
 * 新しい版で、配管 old（端 a〜b）の代わりになる経路：新しく増えた節点（分岐・曲がり点）だけを通り、
 * 途中で枝分かれしない経路。配管を節点で分けただけ（弁などは入れていない）ときに見つかる。
 */
function splitPath(oldI: Index, newI: Index, old: PipeData, from: string): { nodeIds: string[]; pipeIds: string[] } | null {
  const to = from === old.node_a ? old.node_b : old.node_a;
  const prev = new Map<string, { node: string; pipe: string }>();
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === to) break;
    if (cur !== from) {
      const n = newI.nodes.get(cur);
      // 途中の点は、新しく増えた節点で、枝分かれしていないものだけ
      if (!n || n.kind !== "junction" || oldI.nodes.has(cur) || (newI.adj.get(cur)?.length ?? 0) !== 2) continue;
    }
    for (const p of newI.adj.get(cur) ?? []) {
      // 使える配管は、元の番号か、新しく増えた番号だけ
      if (p.code !== old.code && oldI.pipes.has(p.code)) continue;
      const other = p.node_a === cur ? p.node_b : p.node_a;
      if (seen.has(other)) continue;
      seen.add(other);
      prev.set(other, { node: cur, pipe: p.code });
      queue.push(other);
    }
  }
  if (!prev.has(to)) return null;
  const nodeIds: string[] = [];
  const pipeIds: string[] = [];
  for (let c = to; prev.has(c); c = prev.get(c)!.node) {
    pipeIds.unshift(prev.get(c)!.pipe);
    nodeIds.unshift(prev.get(c)!.node);
  }
  return { nodeIds, pipeIds };
}

const volumeOf = (i: Index, pipeIds: string[]) =>
  pipeIds.reduce((sum, id) => {
    const p = i.graph.pipeById.get(id);
    return p ? sum + pipeVolumeL(p, i.graph.pipeLengthM.get(id) ?? 0) : sum;
  }, 0);

/**
 * チェックリスト1件の影響を判定する。
 * @param oldD 作成時の版の系統図（版の記録が無い古いチェックリストは null）
 * @param newD 新しい版の系統図
 */
export function assessPlanImpact(plan: SavedPlan, oldI: Index | null, newI: Index): PlanImpact {
  const reasons: string[] = [];
  if (!oldI) {
    return {
      level: "remake",
      reasons: ["系統図の版を記録する前に作られたため、配管・機器の対応を確かめられません"],
    };
  }

  // 1) 使う機器：無くなっていないか、属性が変わっていないか
  const refs = [...new Set(nodeRefs(plan))];
  refs.forEach((code) => {
    const o = oldI.nodes.get(code);
    const n = newI.nodes.get(code);
    if (!n) return void reasons.push(`機器 ${code} が新しい版にありません`);
    if (!o) return;
    const changed = NODE_FIELDS.filter(([k]) => !same(o[k], n[k])).map(([, label]) => label);
    if (changed.length) reasons.push(`機器 ${code} の${changed.join("・")}が変わりました`);
  });

  // 2) 使う配管：そのまま残っているか、節点で分けられただけか
  const lists = pipeLists(plan);
  const allPipes = [...new Set(Object.values(lists).flat())];
  const remap = new Map<string, PipeData>(); // 付け替えが要る配管（作成時の版での形）
  const explained = new Set<string>(); // 付け替えで説明がつく配管番号
  allPipes.forEach((code) => {
    const o = oldI.pipes.get(code);
    if (!o) return void reasons.push(`配管 ${code} が作成時の版にありません（作成時の版と食い違っています）`);
    const n = newI.pipes.get(code);
    if (n && ends(n) === ends(o)) return;
    const path = splitPath(oldI, newI, o, o.node_a);
    if (!path) return void reasons.push(`配管 ${code}（${o.node_a}〜${o.node_b}）のつながりが変わりました`);
    remap.set(code, o);
    explained.add(code);
    path.pipeIds.forEach((p) => explained.add(p));
  });

  // 3) 使う機器・配管の端に、配管が増えたり外れたりしていないか（範囲や流れる先が変わる）
  const touch = new Set(refs);
  allPipes.forEach((code) => {
    const o = oldI.pipes.get(code);
    if (o) [o.node_a, o.node_b].forEach((n) => touch.add(n));
  });
  touch.forEach((code) => {
    if (!oldI.nodes.has(code) || !newI.nodes.has(code)) return;
    const before = new Map((oldI.adj.get(code) ?? []).map((p) => [p.code, p]));
    const after = new Map((newI.adj.get(code) ?? []).map((p) => [p.code, p]));
    after.forEach((p, k) => {
      if (explained.has(k)) return;
      const b = before.get(k);
      if (!b) reasons.push(`機器 ${code} に配管 ${k} が新しくつながりました`);
      else if (ends(b) !== ends(p)) reasons.push(`機器 ${code} につながる配管 ${k} の相手が変わりました`);
    });
    before.forEach((_, k) => {
      if (!after.has(k) && !explained.has(k)) reasons.push(`機器 ${code} から配管 ${k} が外れました`);
    });
  });

  // 4) 抜取範囲の容量（配管の口径・長さの変更で、抜取量・時間の目安が変わる）
  const patch = remap.size ? makePatch(plan, lists, oldI, newI, remap) : undefined;
  if (lists.regionPipeIds.length && !reasons.length) {
    const before = volumeOf(oldI, lists.regionPipeIds);
    const after = volumeOf(newI, patch?.regionPipeIds ?? lists.regionPipeIds);
    if (before > 0 && Math.abs(after - before) / before > VOLUME_TOLERANCE) {
      reasons.push(`抜取範囲の配管の容量が ${Math.round(before)} L → ${Math.round(after)} L に変わります（配管の口径・長さの変更）`);
    }
  }

  const unique = [...new Set(reasons)];
  if (unique.length) return { level: "remake", reasons: unique };
  if (patch) {
    return {
      level: "drawing",
      reasons: [`配管 ${[...remap.keys()].join("・")} が節点で分けられたため、図面の配管番号を付け替えます`],
      patch,
    };
  }
  return { level: "none", reasons: [] };
}

function makePatch(
  plan: SavedPlan,
  lists: Record<string, string[]>,
  oldI: Index,
  newI: Index,
  remap: Map<string, PipeData>
): PlanPatch {
  const swap = (ids: string[]) => ids.flatMap((id) => (remap.has(id) ? splitPath(oldI, newI, remap.get(id)!, remap.get(id)!.node_a)!.pipeIds : [id]));
  const patch: PlanPatch = {};
  if (lists.regionPipeIds.some((p) => remap.has(p))) patch.regionPipeIds = swap(plan.regionPipeIds);
  if (lists.sealPipeIds.some((p) => remap.has(p))) patch.sealPipeIds = swap(plan.sealPipeIds);
  if (lists.fillPipeIds.some((p) => remap.has(p))) patch.fillPipeIds = swap(plan.fillPipeIds ?? []);
  if (lists.flushPipeIds.some((p) => remap.has(p))) patch.flushPipeIds = swap(plan.flushPipeIds ?? []);
  if (lists.targets.some((p) => remap.has(p))) {
    patch.targets = plan.targets.flatMap((t) =>
      t.type === "pipe" && remap.has(t.id) ? swap([t.id]).map((id) => ({ type: "pipe" as const, id })) : [t]
    );
  }
  if (lists.stepRoutes.some((p) => remap.has(p))) {
    // 経路は「配管ごとの上流側の機器」も持つので、流れの向きに分けた配管を並べ直す
    patch.stepRoutes = Object.fromEntries(
      Object.entries(plan.stepRoutes ?? {}).map(([step, r]) => {
        const nodeIds: string[] = [];
        const pipeIds: string[] = [];
        r.pipeIds.forEach((pid, i) => {
          const o = remap.get(pid);
          if (!o) {
            nodeIds.push(r.nodeIds[i]);
            pipeIds.push(pid);
            return;
          }
          const path = splitPath(oldI, newI, o, r.nodeIds[i])!;
          nodeIds.push(...path.nodeIds);
          pipeIds.push(...path.pipeIds);
        });
        // 最後の機器（経路の終点）は配管の数より1つ多い
        if (r.nodeIds.length > r.pipeIds.length) nodeIds.push(...r.nodeIds.slice(r.pipeIds.length));
        return [Number(step), { nodeIds, pipeIds }];
      })
    );
  }
  return patch;
}

/**
 * 使用中の版と違う版で作られたチェックリストの注意文（同じ版、または系統図が版管理でない場合は null）。
 * 版の記録が無い古いチェックリストも、版管理の系統図を使っていれば注意する。
 */
export function versionMismatch(plan: Pick<SavedPlan, "diagramVersionId">, currentVersionId: string | null | undefined): string | null {
  if (!currentVersionId || plan.diagramVersionId === currentVersionId) return null;
  return plan.diagramVersionId ? "現在と違う版の系統図で作成されています。" : "系統図の版を記録する前に作成されています。";
}

/** 影響チェックの1件分（画面の一覧と、保存する操作に使う） */
export type PlanImpactResult = PlanImpact & {
  planId: string;
  planName: string;
  /** 作成時の版（版の記録が無ければ null） */
  fromVersionId: string | null;
  /** 点検中の記録があるか（点検中のものは差し戻しても止まらないので知らせる） */
  inProgress: boolean;
};

/**
 * 全チェックリストの影響を判定する。版が target と同じものは対象外。
 * @param versions 版ID → 系統図（作成時の版を読み込んだもの）
 */
export function assessImpacts(
  plans: SavedPlan[],
  inProgressPlanIds: Set<string>,
  targetVersionId: string,
  target: DiagramData,
  versions: Map<string, DiagramData>
): PlanImpactResult[] {
  const newI = indexDiagram(target);
  const cache = new Map<string, Index>();
  const indexOf = (id: string) => {
    if (!cache.has(id)) cache.set(id, indexDiagram(versions.get(id)!));
    return cache.get(id)!;
  };
  return plans
    .filter((p) => p.diagramVersionId !== targetVersionId)
    .map((p) => {
      const from = p.diagramVersionId ?? null;
      const oldI = from && versions.has(from) ? indexOf(from) : null;
      const r =
        from && !versions.has(from)
          ? { level: "remake" as const, reasons: [`作成時の版（${from}）が見つかりません`] }
          : assessPlanImpact(p, oldI, newI);
      return { ...r, planId: p.id, planName: p.name, fromVersionId: from, inProgress: inProgressPlanIds.has(p.id) };
    });
}
