import type { Graph } from "./graph";
import type { PNode } from "./types";

// 当日の運用停止範囲（制御室で入力し、トップ・制御室の図面に明示する）。
// 範囲は施設のエリア（受入系統A など）や機器IDで決める。複数を同時に停止できる。
// 既定：仮想施設は下の8種類、ほかの拠点は区画ごと（キー "area:<区画名>"）に停止できる。
// ③ 制御室の「範囲を設定する」で拠点ごとに範囲を登録すると（piping_store の outageDefs）、既定の代わりにそれを使う。

export type OutageKey = string;

export type OutageDef = {
  key: OutageKey;
  label: string;
  /** 範囲の説明（どの設備が含まれるか） */
  desc: string;
  /** 範囲に含めるノード */
  match: (n: PNode) => boolean;
  /** 範囲の機器から、隣の分岐点までの配管も範囲に含める（共通の吸込・吐出管から分かれる系統など） */
  toJunctions?: boolean;
};

/** 拠点ごとに登録する停止範囲（データとして保存する形） */
export type OutageSetting = {
  key: string;
  label: string;
  desc?: string;
  /** この区画の機器をまとめて含める */
  areas: string[];
  /** 個別に含める機器 */
  nodes: string[];
  /** 区画で含めた機器のうち、外す機器 */
  exclude: string[];
  toJunctions?: boolean;
};

const inArea = (...areas: string[]) => (n: PNode) => areas.includes(n.area);
// 移送ポンプ k 系統：吸込弁〜吐出弁と付属のストレーナー・ドレン・圧力計（共通の吸込・吐出管は除く）
const transferLine = (k: 1 | 2) => (n: PNode) =>
  n.id !== `J-TP${k}` && (n.id === `TP-${k}` || new RegExp(`TP${k}`).test(n.id));
// 払出系統 n：払出ポンプ系統とバイパスライン（ハイドラント送油弁まで）
const issueLine = (k: 1 | 2) => (n: PNode) =>
  n.area === `払出ポンプ系統${k}` || (n.area === "バイパスライン" && new RegExp(`BP${k}`).test(n.id));

export const OUTAGES: OutageDef[] = [
  { key: "recvA", label: "受入A系停止", desc: "受入系統A（受入口A〜ストレーナー・フィルター）と抜取・回収設備", match: inArea("受入系統A", "受入A 抜取・回収設備") },
  { key: "recvB", label: "受入B系停止", desc: "受入系統B（受入口B〜ストレーナー・フィルター）", match: inArea("受入系統B") },
  { key: "issueA", label: "払出A系停止", desc: "払出ポンプ系統1（P-11〜P-13）とバイパスライン1", match: issueLine(1) },
  { key: "issueB", label: "払出B系停止", desc: "払出ポンプ系統2（P-21〜P-23）とバイパスライン2", match: issueLine(2) },
  { key: "transferA", label: "移送A系停止", desc: "移送ポンプ TP-1 系統（吸込弁〜吐出弁）", match: transferLine(1), toJunctions: true },
  { key: "transferB", label: "移送B系停止", desc: "移送ポンプ TP-2 系統（吸込弁〜吐出弁）", match: transferLine(2), toJunctions: true },
  { key: "yard1", label: "第1タンクヤード停止", desc: "T-101〜T-106 と受入・払出・移送ヘッダー", match: inArea("第1ヤード") },
  { key: "yard2", label: "第2タンクヤード停止", desc: "T-201〜T-206 と受入・払出・移送ヘッダー", match: inArea("第2ヤード") },
];

export const OUTAGE_BY_KEY = new Map(OUTAGES.map((o) => [o.key, o]));

/** 区画まるごとの停止範囲（仮想施設以外の拠点） */
export function areaOutage(area: string): OutageDef {
  return { key: `area:${area}`, label: `${area}停止`, desc: `区画「${area}」の機器・配管`, match: (n) => n.area === area };
}

/** 登録した停止範囲 → 判定用の定義 */
export function settingToDef(s: OutageSetting): OutageDef {
  const areas = new Set(s.areas);
  const nodes = new Set(s.nodes);
  const exclude = new Set(s.exclude);
  return {
    key: s.key,
    label: s.label,
    desc:
      s.desc ||
      [s.areas.length ? `区画：${s.areas.join("・")}` : "", s.nodes.length ? `個別の機器 ${s.nodes.length} 件` : ""].filter(Boolean).join("、"),
    match: (n) => !exclude.has(n.id) && (areas.has(n.area) || nodes.has(n.id)),
    toJunctions: s.toJunctions,
  };
}

/** キーから停止範囲の定義を引く（登録した範囲があればそれを使う） */
export function outageDefOf(key: OutageKey, custom?: OutageSetting[] | null): OutageDef | undefined {
  if (custom?.length) {
    const s = custom.find((c) => c.key === key);
    return s ? settingToDef(s) : undefined;
  }
  return OUTAGE_BY_KEY.get(key) ?? (key.startsWith("area:") ? areaOutage(key.slice(5)) : undefined);
}

/** 既定の停止範囲：仮想施設は8種類、ほかの拠点は区画ごと */
export function defaultOutageDefs(facilityId: string, g: Graph): OutageDef[] {
  if (facilityId === "virtual-airport") return OUTAGES;
  return [...new Set(g.facility.nodes.filter((n) => n.kind !== "junction").map((n) => n.area))].map(areaOutage);
}

/** 拠点で選べる停止範囲：登録した範囲があればそれ、無ければ既定 */
export function outageDefsFor(facilityId: string, g: Graph, custom?: OutageSetting[] | null): OutageDef[] {
  return custom?.length ? custom.map(settingToDef) : defaultOutageDefs(facilityId, g);
}

/** 既定の停止範囲を、編集できる形（登録する範囲）にする。区画で決まる範囲は区画、それ以外は今の系統図の機器を個別に入れる */
export function defaultsAsSettings(facilityId: string, g: Graph): OutageSetting[] {
  const areas = new Set(g.facility.nodes.map((n) => n.area));
  return defaultOutageDefs(facilityId, g).map((d) => {
    const nodes = g.facility.nodes.filter(d.match);
    // 範囲の機器が区画まるごとと一致すれば区画で持つ（設備を足しても自動で入る）
    const whole = [...areas].filter((a) => {
      const inA = g.facility.nodes.filter((n) => n.area === a);
      return inA.length > 0 && inA.every(d.match);
    });
    const byArea = new Set(nodes.filter((n) => whole.includes(n.area)).map((n) => n.id));
    return {
      key: d.key,
      label: d.label,
      desc: d.desc,
      areas: whole,
      nodes: nodes.filter((n) => !byArea.has(n.id)).map((n) => n.id),
      exclude: [],
      toJunctions: d.toJunctions,
    };
  });
}

export type OutageRange = {
  def: OutageDef;
  nodeIds: string[];
  pipeIds: string[];
  /** 図面に枠を描く範囲 */
  box: { x: number; y: number; w: number; h: number };
};

/** 定義から、停止範囲のノード・配管と、図面上の枠を求める */
export function rangeOfDef(g: Graph, def: OutageDef): OutageRange {
  const nodes = new Set(g.facility.nodes.filter(def.match).map((n) => n.id));
  const pipeIds = g.facility.pipes
    .filter((p) => {
      if (nodes.has(p.a) && nodes.has(p.b)) return true;
      // 共通の吸込・吐出管の分岐点までの配管も範囲に含める（移送ポンプ系統など）
      if (!def.toJunctions) return false;
      const other = nodes.has(p.a) ? p.b : nodes.has(p.b) ? p.a : null;
      return !!other && g.nodeById.get(other)!.kind === "junction";
    })
    .map((p) => p.id);
  const xs: number[] = [];
  const ys: number[] = [];
  nodes.forEach((id) => {
    const n = g.nodeById.get(id)!;
    xs.push(n.x);
    ys.push(n.y);
  });
  const pad = 30;
  const box = xs.length
    ? { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 }
    : { x: 0, y: 0, w: 0, h: 0 };
  return { def, nodeIds: [...nodes], pipeIds, box };
}

/** 停止範囲のノード・配管と、図面上の枠 */
export function outageRange(g: Graph, key: OutageKey, custom?: OutageSetting[] | null): OutageRange | null {
  const def = outageDefOf(key, custom);
  return def ? rangeOfDef(g, def) : null;
}
