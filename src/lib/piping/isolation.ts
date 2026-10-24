import { connectedGroups, otherSide, type Graph, type Section } from "./graph";
import type { ValveState } from "./types";

// 抜取範囲（遮断範囲）の算定と、液封リスクの評価。

export type Target = { type: "node" | "pipe"; id: string };

export type IsolationOptions = {
  /** 作業前の弁状態（待機状態 or 現在の運用状態） */
  baseline: Record<string, ValveState>;
  /**
   * true: 対象区間にドレン口（抜取ポンプ付を含む）が無ければ、最寄りのドレン口のある区間まで広げる
   * false: 対象に隣接するバルブだけで遮断する（抜取方法は別途検討）
   */
  expandToDrain: boolean;
  /** 手動で追加した区間（境界弁をクリックして範囲を広げたもの） */
  extraSectionIds?: string[];
};

export type SealGroup = {
  sectionIds: string[];
  pipeIds: string[];
  volumeL: number;
  /** 圧力計を取り付けられる箇所（ドレン口・圧力計取付口） */
  gaugeCandidates: string[];
  /** 作業前から液封状態だったか（false＝今回の遮断で新たに生じる） */
  preexisting: boolean;
  /** 開けばタンク・安全弁へ逃げ道ができる閉止中のバルブ */
  ventValves: string[];
  /** この区間に接する遮断弁 */
  adjacentBoundary: string[];
};

export type FillPlan = {
  /** line: 充填ラインから充填 / valve: 遮断弁を微開して充填 / none: 充填方法なし */
  method: "line" | "valve" | "none";
  /** 充填のために開ける弁（充填ライン上の弁、または微開する遮断弁） */
  openValves: string[];
  /** 充填に使う配管（図面表示用） */
  pipeIds: string[];
};

export type IsolationResult = {
  targetSectionIds: string[];
  regionSectionIds: string[];
  /** 自動拡張で追加された区間（ドレン口確保のため） */
  expandedSectionIds: string[];
  regionPipeIds: string[];
  regionNodeIds: string[];
  boundaryValves: string[];
  internalValves: string[];
  drains: string[];
  regionGauges: string[];
  regionPsvs: string[];
  volumeL: number;
  sealGroups: SealGroup[];
  fill: FillPlan;
  errors: string[];
  notes: string[];
};

function isDrainable(s: Section) {
  return s.drainIds.length > 0;
}

/** タンクノズル部・施設外接続部は抜取範囲に含められない */
function isExpandable(s: Section) {
  return s.tankIds.length === 0 && !s.external;
}

export function targetSections(g: Graph, targets: Target[], errors: string[]): string[] {
  const out = new Set<string>();
  targets.forEach((t) => {
    if (t.type === "pipe") {
      const s = g.sectionOfPipe.get(t.id);
      if (s) out.add(s);
      return;
    }
    const n = g.nodeById.get(t.id);
    if (!n) return;
    if (n.kind === "tank") {
      errors.push(`${n.label}：タンク本体は対象外です（タンク抜油は別手順）。配管・機器を選択してください。`);
      return;
    }
    if (n.kind === "source" || n.kind === "sink") {
      errors.push(`${n.label}：施設外の設備は対象外です。`);
      return;
    }
    if (n.kind === "valve") {
      (g.valveSides.get(n.id) ?? []).forEach((s) => out.add(s));
      return;
    }
    const s = g.sectionOfNode.get(n.id);
    if (s) out.add(s);
  });
  [...out].forEach((sid) => {
    const s = g.sectionById.get(sid)!;
    if (!isExpandable(s)) {
      out.delete(sid);
      errors.push(
        s.tankIds.length
          ? `タンク元弁より内側（タンクノズル部）は、タンク抜油が必要なため対象外です。`
          : `施設外との接続部は対象外です。`
      );
    }
  });
  return [...out];
}

/** 領域内で、開放した内部弁でつながる区間のまとまり */
function regionComponents(g: Graph, region: Set<string>): string[][] {
  const seen = new Set<string>();
  const comps: string[][] = [];
  region.forEach((sid) => {
    if (seen.has(sid)) return;
    const comp: string[] = [];
    const stack = [sid];
    seen.add(sid);
    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      g.sectionById.get(cur)!.valveIds.forEach((v) => {
        const o = otherSide(g, v, cur);
        if (o && region.has(o) && !seen.has(o)) {
          seen.add(o);
          stack.push(o);
        }
      });
    }
    comps.push(comp);
  });
  return comps;
}

/** ドレン口のある区間までの最小容量経路（区間グラフ上のダイクストラ） */
function pathToDrain(g: Graph, start: string[]): string[] | null {
  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const queue: string[] = [];
  start.forEach((s) => {
    dist.set(s, 0);
    queue.push(s);
  });
  const done = new Set<string>();
  const startSet = new Set(start);
  while (queue.length) {
    queue.sort((a, b) => dist.get(a)! - dist.get(b)!);
    const cur = queue.shift()!;
    if (done.has(cur)) continue;
    done.add(cur);
    const sec = g.sectionById.get(cur)!;
    if (!startSet.has(cur) && isDrainable(sec)) {
      const path: string[] = [];
      let c: string | undefined = cur;
      while (c && !startSet.has(c)) {
        path.push(c);
        c = prev.get(c);
      }
      return path;
    }
    sec.valveIds.forEach((v) => {
      if (g.nodeById.get(v)!.service) return; // 充填ラインなどの作業用弁を越えては広げない
      const o = otherSide(g, v, cur);
      if (!o || done.has(o)) return;
      const os = g.sectionById.get(o)!;
      if (!isExpandable(os)) return;
      const nd = dist.get(cur)! + os.volumeL;
      if (nd < (dist.get(o) ?? Infinity)) {
        dist.set(o, nd);
        prev.set(o, cur);
        queue.push(o);
      }
    });
  }
  return null;
}

/** 区間の中で、2つの弁（または節点）を結ぶ配管だけを取り出す */
function pipesWithinSection(g: Graph, sectionId: string, from: string, to: string): string[] {
  const inSection = new Set(g.sectionById.get(sectionId)!.pipeIds);
  const prev = new Map<string, { node: string; pipe: string }>();
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === to) break;
    if (cur !== from && g.nodeById.get(cur)!.kind === "valve") continue;
    g.adj.get(cur)!.forEach(({ pipe, other }) => {
      if (!inSection.has(pipe.id) || seen.has(other)) return;
      seen.add(other);
      prev.set(other, { node: cur, pipe: pipe.id });
      queue.push(other);
    });
  }
  const out: string[] = [];
  let c = to;
  while (prev.has(c)) {
    out.push(prev.get(c)!.pipe);
    c = prev.get(c)!.node;
  }
  return c === from ? out : [...inSection];
}

/** 充填ライン（充填弁のみ通過）で、供給元（移送系統）まで到達する経路 */
function fillLineRoute(g: Graph, start: string[]): { valves: string[]; pipeIds: string[] } | null {
  const prev = new Map<string, { from: string; valve: string }>();
  const seen = new Set(start);
  const queue = [...start];
  while (queue.length) {
    const cur = queue.shift()!;
    const sec = g.sectionById.get(cur)!;
    if (!start.includes(cur) && sec.nodeIds.some((n) => g.nodeById.get(n)!.fillSource)) {
      const valves: string[] = [];
      // 供給元の区間からは、充填元弁につながる配管だけを表示に含める
      const lastValve = prev.get(cur)!.valve;
      const pipeIds: string[] = sec.pipeIds.filter((pid) => {
        const p = g.pipeById.get(pid)!;
        return p.a === lastValve || p.b === lastValve;
      });
      let c = cur;
      let exitValve = lastValve;
      while (!start.includes(c)) {
        const p = prev.get(c)!;
        valves.push(p.valve);
        if (c !== cur) pipeIds.push(...pipesWithinSection(g, c, p.valve, exitValve));
        exitValve = p.valve;
        c = p.from;
      }
      return { valves: valves.reverse(), pipeIds };
    }
    sec.valveIds.forEach((v) => {
      if (!g.nodeById.get(v)!.fillLine) return;
      const o = otherSide(g, v, cur);
      if (!o || seen.has(o)) return;
      seen.add(o);
      prev.set(o, { from: cur, valve: v });
      queue.push(o);
    });
  }
  return null;
}

function isProtected(g: Graph, sectionIds: string[]) {
  return sectionIds.some((sid) => {
    const s = g.sectionById.get(sid)!;
    return s.psvIds.length > 0 || s.tankIds.length > 0 || s.external;
  });
}

export function planIsolation(g: Graph, targets: Target[], opts: IsolationOptions): IsolationResult {
  const errors: string[] = [];
  const notes: string[] = [];
  const tSections = targetSections(g, targets, errors);
  const region = new Set<string>(tSections);
  (opts.extraSectionIds ?? []).forEach((s) => {
    if (g.sectionById.has(s) && isExpandable(g.sectionById.get(s)!)) region.add(s);
  });
  const expanded: string[] = [];

  // ドレン口（抜取設備）を含むまで、最小の容量で範囲を広げる
  for (let guard = 0; opts.expandToDrain && guard < 50; guard++) {
    const lacking = regionComponents(g, region).find(
      (comp) => !comp.some((sid) => isDrainable(g.sectionById.get(sid)!))
    );
    if (!lacking) break;
    const path = pathToDrain(g, lacking);
    if (!path) {
      errors.push("抜取設備（ドレン口）のある区間まで遮断範囲を広げられませんでした。");
      break;
    }
    path.forEach((s) => {
      if (!region.has(s)) {
        region.add(s);
        expanded.push(s);
      }
    });
  }

  const boundary = new Set<string>();
  const internal = new Set<string>();
  const regionPipeIds: string[] = [];
  const regionNodeIds: string[] = [];
  let volumeL = 0;
  const drains: string[] = [];
  const gauges: string[] = [];
  const psvs: string[] = [];
  region.forEach((sid) => {
    const s = g.sectionById.get(sid)!;
    regionPipeIds.push(...s.pipeIds);
    regionNodeIds.push(...s.nodeIds);
    volumeL += s.volumeL;
    drains.push(...s.drainIds);
    gauges.push(...s.gaugeIds);
    psvs.push(...s.psvIds);
    s.valveIds.forEach((v) => {
      const o = otherSide(g, v, sid);
      if (o && region.has(o)) internal.add(v);
      else boundary.add(v);
    });
  });
  internal.forEach((v) => boundary.delete(v));

  if (expanded.length) {
    const expandedSet = new Set(expanded);
    const opened = [...internal].filter((v) =>
      (g.valveSides.get(v) ?? []).some((s) => expandedSet.has(s))
    );
    const viaDrains = expanded.flatMap((s) => g.sectionById.get(s)!.drainIds);
    notes.push(
      `対象区間にドレン口が無いため、${opened.join("・")} を開けて ${viaDrains.join("・")} から抜き取る範囲にしました（隣接弁だけで遮断する場合は「ドレン口まで広げる」を外してください）。`
    );
  }
  if (region.size > 0 && drains.length === 0) {
    errors.push("抜取範囲内にドレン口がありません。抜取方法（仮設の抜取口など）を別途検討してください。");
  }

  // 液封評価：遮断後の弁状態で、領域外の区間がタンク・安全弁に逃げられるか
  const after: Record<string, ValveState> = { ...opts.baseline };
  boundary.forEach((v) => (after[v] = "close"));
  internal.forEach((v) => (after[v] = "open"));
  const afterGroups = connectedGroups(g, after, region);
  const groupOf = new Map<string, number>();
  afterGroups.forEach((grp, i) => grp.forEach((s) => groupOf.set(s, i)));
  const protectedGroup = afterGroups.map((grp) => isProtected(g, grp));

  const beforeGroups = connectedGroups(g, opts.baseline);
  const beforeGroupOf = new Map<string, number>();
  beforeGroups.forEach((grp, i) => grp.forEach((s) => beforeGroupOf.set(s, i)));
  const beforeProtected = beforeGroups.map((grp) => isProtected(g, grp));

  const sealGroups: SealGroup[] = [];
  afterGroups.forEach((grp, gi) => {
    if (protectedGroup[gi]) return;
    const adjacentBoundary = new Set<string>();
    grp.forEach((sid) =>
      g.sectionById.get(sid)!.valveIds.forEach((v) => {
        if (boundary.has(v)) adjacentBoundary.add(v);
      })
    );
    if (adjacentBoundary.size === 0) return; // 今回の遮断と無関係な区間は対象外
    const ventValves = new Set<string>();
    const pipeIds: string[] = [];
    const gaugeCandidates: string[] = [];
    let vol = 0;
    grp.forEach((sid) => {
      const s = g.sectionById.get(sid)!;
      pipeIds.push(...s.pipeIds);
      vol += s.volumeL;
      s.drainIds.forEach((d) => g.nodeById.get(d)!.gaugeMountable && gaugeCandidates.push(d));
      gaugeCandidates.push(...s.gaugeIds);
      s.valveIds.forEach((v) => {
        if (after[v] === "open" || boundary.has(v)) return;
        const o = otherSide(g, v, sid);
        if (o && groupOf.has(o) && protectedGroup[groupOf.get(o)!]) ventValves.add(v);
      });
    });
    const preexisting = grp.every((sid) => {
      const bi = beforeGroupOf.get(sid);
      return bi !== undefined && !beforeProtected[bi];
    });
    sealGroups.push({
      sectionIds: grp,
      pipeIds,
      volumeL: vol,
      gaugeCandidates,
      preexisting,
      ventValves: [...ventValves],
      adjacentBoundary: [...adjacentBoundary],
    });
  });

  // 作業後の充填方法：充填ラインがあればそこから、無ければ遮断弁の微開で充填する
  const fill: FillPlan = { method: "none", openValves: [], pipeIds: [] };
  regionComponents(g, region).forEach((comp) => {
    const route = fillLineRoute(g, comp);
    if (route) {
      fill.method = "line";
      fill.openValves.push(...route.valves);
      fill.pipeIds.push(...route.pipeIds);
      return;
    }
    // 逆止弁・ポンプの下流側にある弁からは逆流させられないので除く
    const againstFlow = (v: string) =>
      g.adj.get(v)!.some(({ other }) => {
        const n = g.nodeById.get(other)!;
        return !!n.dirFrom && n.kind !== "psv" && n.dirFrom !== v;
      });
    // タンクにつながる弁、次に弁のすぐ外側の液量が多い弁を、充填の供給元として優先する
    // （外側の区間の先は逆止弁で塞がれている場合があるため、隣の区間の量で比べる）
    const supplyScore = (v: string) => {
      const inside = comp.find((sid) => g.sectionById.get(sid)!.valveIds.includes(v))!;
      const o = otherSide(g, v, inside);
      const gi = o ? groupOf.get(o) : undefined;
      if (!o || gi === undefined) return -1;
      const tank = afterGroups[gi].some((sid) => g.sectionById.get(sid)!.tankIds.length > 0) ? 1e9 : 0;
      return tank + g.sectionById.get(o)!.volumeL;
    };
    const pick = comp
      .flatMap((sid) => g.sectionById.get(sid)!.valveIds)
      .filter((v) => boundary.has(v) && !g.nodeById.get(v)!.service && !againstFlow(v))
      .sort((a, b) => supplyScore(b) - supplyScore(a))[0];
    if (pick) {
      if (fill.method === "none") fill.method = "valve";
      fill.openValves.push(pick);
    }
  });
  fill.openValves = [...new Set(fill.openValves)];
  if (fill.method === "line") {
    notes.push(
      `作業後は充填ライン（${fill.openValves.join("・")}）から、移送ポンプで低流速・エア抜きしながら充填します。`
    );
  } else if (fill.method === "valve") {
    notes.push(`充填ラインが無いため、作業後は遮断弁 ${fill.openValves.join("・")} を微開して徐々に充填します。`);
  }

  if (region.size > 0 && psvs.length === 0) {
    notes.push(
      "抜取範囲内に安全弁がありません。遮断後〜抜取完了までは液封状態となるため、速やかに抜取を開始してください。"
    );
  }

  return {
    targetSectionIds: tSections,
    regionSectionIds: [...region],
    expandedSectionIds: expanded,
    regionPipeIds,
    regionNodeIds,
    boundaryValves: [...boundary].sort(),
    internalValves: [...internal].sort(),
    drains: drains.sort(),
    regionGauges: gauges,
    regionPsvs: psvs,
    volumeL,
    sealGroups,
    fill,
    errors,
    notes,
  };
}

// ───────────── 抜取量・抜取時間の試算 ─────────────

/** 自然流下での概算排出量（L/min）。口径別の目安値。 */
export const GRAVITY_LPM: Record<number, number> = { 25: 40, 40: 90, 50: 150, 80: 350 };

export type DrainEstimate = {
  perDrain: { id: string; method: "pump" | "gravity"; rateLpm: number }[];
  totalLpm: number;
  minutes: number | null;
  portableMinutes: number | null;
  drums: number;
  lorries: number;
};

export function estimateDrain(
  g: Graph,
  drainIds: string[],
  volumeL: number,
  portableLpm: number
): DrainEstimate {
  const perDrain = drainIds.map((id) => {
    const n = g.nodeById.get(id)!;
    if (n.drainPumpLpm) return { id, method: "pump" as const, rateLpm: n.drainPumpLpm };
    return { id, method: "gravity" as const, rateLpm: GRAVITY_LPM[n.drainSizeA ?? 50] ?? 100 };
  });
  // 同じ抜取ポンプにつながるドレン口が複数あっても、ポンプの能力は1台分
  const pumpSystems = new Map<string, number>();
  let totalLpm = 0;
  perDrain.forEach((d) => {
    const sys = g.nodeById.get(d.id)!.drainSystem;
    if (d.method === "pump" && sys) pumpSystems.set(sys, Math.max(pumpSystems.get(sys) ?? 0, d.rateLpm));
    else totalLpm += d.rateLpm;
  });
  pumpSystems.forEach((lpm) => (totalLpm += lpm));
  return {
    perDrain,
    totalLpm,
    minutes: totalLpm > 0 ? volumeL / totalLpm : null,
    portableMinutes: portableLpm > 0 ? volumeL / portableLpm : null,
    drums: Math.ceil(volumeL / 200),
    lorries: Math.ceil(volumeL / 16000),
  };
}

/** 充填の標準速度（L/min）。静電気対策で初期は低流速とするための目安 */
export const DEFAULT_FILL_LPM = 200;

export function formatMinutes(min: number | null) {
  if (min === null || !isFinite(min)) return "—";
  if (min < 60) return `約${Math.ceil(min)}分`;
  const h = Math.floor(min / 60);
  const m = Math.ceil(min - h * 60);
  return `約${h}時間${m}分`;
}

export function formatLiters(l: number) {
  if (l >= 1000) return `${(l / 1000).toFixed(2)} kL`;
  return `${Math.round(l)} L`;
}
