import { innerDiameterM } from "./facility";
import type { Facility, PNode, Pipe, ValveState } from "./types";

// 配管グラフの解析（隣接関係・区間分割・経路探索）。

export type Adjacent = { pipe: Pipe; other: string };

/** 区間 = バルブ（仕切弁）・タンク・施設外接続点で区切られた、ひと続きの配管範囲 */
export type Section = {
  id: string;
  pipeIds: string[];
  /** 区間内のノード（分岐点・機器・ドレン口・安全弁・圧力計取付口） */
  nodeIds: string[];
  /** 区間の境界にあるバルブ */
  valveIds: string[];
  /** 区間に接しているタンク */
  tankIds: string[];
  /** 施設外（受入口・ハイドラント）に接しているか */
  external: boolean;
  volumeL: number;
  drainIds: string[];
  gaugeIds: string[];
  psvIds: string[];
};

export type Graph = {
  facility: Facility;
  nodeById: Map<string, PNode>;
  pipeById: Map<string, Pipe>;
  adj: Map<string, Adjacent[]>;
  pipeLengthM: Map<string, number>;
  sections: Section[];
  sectionById: Map<string, Section>;
  sectionOfPipe: Map<string, string>;
  /** 非区切りノード → 所属区間 */
  sectionOfNode: Map<string, string>;
  /** バルブ → 両側の区間 */
  valveSides: Map<string, string[]>;
};

/** バルブをまたぐ逃し弁（入口側→出口側へ圧力を逃がす。通常は流れない） */
export function isBypassRelief(n: PNode) {
  return n.kind === "psv" && !!n.dirFrom;
}

/** 区間を区切るノード（ここで配管が分断されるとみなす） */
export function isSeparator(n: PNode) {
  return (
    n.kind === "valve" ||
    n.kind === "tank" ||
    n.kind === "source" ||
    n.kind === "sink" ||
    isBypassRelief(n) ||
    isLinedDrain(n)
  );
}

/** 先が抜取用配管につながっているドレン口（ドレン弁が容器側と抜取配管側を区切る） */
export function isLinedDrain(n: PNode) {
  return n.kind === "drain" && !!n.drainTo;
}

export function pipePoints(g: Pick<Graph, "nodeById">, p: Pipe): [number, number][] {
  const a = g.nodeById.get(p.a)!;
  const b = g.nodeById.get(p.b)!;
  return [[a.x, a.y], ...(p.via ?? []), [b.x, b.y]];
}

function polylineLength(pts: [number, number][]) {
  let len = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    len += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  }
  return len;
}

export function pipeVolumeL(p: Pipe, lengthM: number) {
  const d = innerDiameterM(p.sizeA);
  return (Math.PI / 4) * d * d * lengthM * 1000;
}

export function buildGraph(facility: Facility): Graph {
  const nodeById = new Map(facility.nodes.map((n) => [n.id, n]));
  const pipeById = new Map(facility.pipes.map((p) => [p.id, p]));
  const adj = new Map<string, Adjacent[]>();
  facility.nodes.forEach((n) => adj.set(n.id, []));
  const pipeLengthM = new Map<string, number>();
  facility.pipes.forEach((p) => {
    adj.get(p.a)!.push({ pipe: p, other: p.b });
    adj.get(p.b)!.push({ pipe: p, other: p.a });
    const px = polylineLength(pipePoints({ nodeById }, p));
    pipeLengthM.set(p.id, p.lengthM ?? px * facility.metersPerPx);
  });

  // 区切りでないノードを介してつながる配管同士を同じ区間にまとめる（Union-Find）
  const parent = new Map<string, string>();
  facility.pipes.forEach((p) => parent.set(p.id, p.id));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  facility.nodes.forEach((n) => {
    if (isSeparator(n)) return;
    const list = adj.get(n.id)!;
    for (let i = 1; i < list.length; i++) {
      const ra = find(list[0].pipe.id);
      const rb = find(list[i].pipe.id);
      if (ra !== rb) parent.set(ra, rb);
    }
  });

  const groups = new Map<string, string[]>();
  facility.pipes.forEach((p) => {
    const r = find(p.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(p.id);
  });

  const sections: Section[] = [];
  const sectionOfPipe = new Map<string, string>();
  const sectionOfNode = new Map<string, string>();
  const valveSides = new Map<string, string[]>();
  let seq = 0;
  groups.forEach((pipeIds) => {
    const id = `S${String(++seq).padStart(3, "0")}`;
    const nodeSet = new Set<string>();
    const valveSet = new Set<string>();
    const tankSet = new Set<string>();
    const reliefSet = new Set<string>();
    const linedDrainSet = new Set<string>();
    let external = false;
    let volumeL = 0;
    pipeIds.forEach((pid) => {
      sectionOfPipe.set(pid, id);
      const p = pipeById.get(pid)!;
      volumeL += pipeVolumeL(p, pipeLengthM.get(pid)!);
      [p.a, p.b].forEach((nid) => {
        const n = nodeById.get(nid)!;
        if (n.kind === "valve") valveSet.add(nid);
        else if (n.kind === "tank") tankSet.add(nid);
        else if (isBypassRelief(n)) {
          // 逃し弁の入口側の区間だけが、その逃し弁で保護される
          if ((p.a === nid ? p.b : p.a) === n.dirFrom) reliefSet.add(nid);
        } else if (isLinedDrain(n)) {
          // 容器側（抜取配管ではない側）の区間だけが、このドレン口から抜き取れる
          if ((p.a === nid ? p.b : p.a) !== n.drainTo) linedDrainSet.add(nid);
        } else if (n.kind === "source" || n.kind === "sink") external = true;
        else nodeSet.add(nid);
      });
    });
    const nodeIds = [...nodeSet];
    nodeIds.forEach((nid) => {
      sectionOfNode.set(nid, id);
      volumeL += nodeById.get(nid)!.volumeL ?? 0;
    });
    valveSet.forEach((vid) => {
      if (!valveSides.has(vid)) valveSides.set(vid, []);
      valveSides.get(vid)!.push(id);
    });
    const ofKind = (k: PNode["kind"]) => nodeIds.filter((nid) => nodeById.get(nid)!.kind === k);
    sections.push({
      id,
      pipeIds,
      nodeIds,
      valveIds: [...valveSet],
      tankIds: [...tankSet],
      external,
      volumeL,
      drainIds: [...ofKind("drain"), ...linedDrainSet],
      gaugeIds: ofKind("gauge"),
      psvIds: [...ofKind("psv"), ...reliefSet],
    });
  });

  return {
    facility,
    nodeById,
    pipeById,
    adj,
    pipeLengthM,
    sections,
    sectionById: new Map(sections.map((s) => [s.id, s])),
    sectionOfPipe,
    sectionOfNode,
    valveSides,
  };
}

/** バルブを挟んだ反対側の区間 */
export function otherSide(g: Graph, valveId: string, sectionId: string): string | null {
  const sides = g.valveSides.get(valveId) ?? [];
  return sides.find((s) => s !== sectionId) ?? null;
}

/** 弁状態を反映して、開いているバルブでつながる区間の集まり（連結成分）を求める */
export function connectedGroups(
  g: Graph,
  valveState: Record<string, ValveState>,
  exclude: Set<string> = new Set()
): string[][] {
  const seen = new Set<string>();
  const groups: string[][] = [];
  g.sections.forEach((s) => {
    if (seen.has(s.id) || exclude.has(s.id)) return;
    const comp: string[] = [];
    const stack = [s.id];
    seen.add(s.id);
    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      g.sectionById.get(cur)!.valveIds.forEach((vid) => {
        if (valveState[vid] !== "open") return;
        const o = otherSide(g, vid, cur);
        if (o && !seen.has(o) && !exclude.has(o)) {
          seen.add(o);
          stack.push(o);
        }
      });
    }
    groups.push(comp);
  });
  return groups;
}

export type Route = { nodeIds: string[]; pipeIds: string[] };

/**
 * ノード間の最短経路（配管長基準）。
 * タンク・施設外接続点は始点/終点以外では通過しない。ポンプ・逆止弁は上流側からのみ進入できる。
 */
export function shortestPath(
  g: Graph,
  from: string,
  to: string,
  blocked: Set<string> = new Set()
): Route | null {
  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, { node: string; pipe: string }>();
  const done = new Set<string>();
  const queue: string[] = [from];
  while (queue.length) {
    queue.sort((a, b) => dist.get(a)! - dist.get(b)!);
    const cur = queue.shift()!;
    if (done.has(cur)) continue;
    done.add(cur);
    if (cur === to) break;
    const curNode = g.nodeById.get(cur)!;
    if (cur !== from && (curNode.kind === "tank" || curNode.kind === "source" || curNode.kind === "sink")) continue;
    for (const { pipe, other } of g.adj.get(cur)!) {
      if (done.has(other) || blocked.has(other)) continue;
      const on = g.nodeById.get(other)!;
      if (on.kind === "drain" || on.kind === "gauge" || on.kind === "psv") continue;
      if (on.service && other !== to) continue; // 充填弁などの作業用ラインは運用経路にしない
      if (on.dirFrom && on.dirFrom !== cur) continue;
      if (curNode.dirFrom && other === curNode.dirFrom) continue;
      const nd = dist.get(cur)! + g.pipeLengthM.get(pipe.id)!;
      if (nd < (dist.get(other) ?? Infinity)) {
        dist.set(other, nd);
        prev.set(other, { node: cur, pipe: pipe.id });
        queue.push(other);
      }
    }
  }
  if (!dist.has(to)) return null;
  const nodeIds = [to];
  const pipeIds: string[] = [];
  let c = to;
  while (c !== from) {
    const p = prev.get(c)!;
    pipeIds.push(p.pipe);
    nodeIds.push(p.node);
    c = p.node;
  }
  return { nodeIds: nodeIds.reverse(), pipeIds: pipeIds.reverse() };
}

export function normalValveState(f: Facility): Record<string, ValveState> {
  const state: Record<string, ValveState> = {};
  f.nodes.forEach((n) => {
    if (n.normal) state[n.id] = n.normal;
  });
  return state;
}
