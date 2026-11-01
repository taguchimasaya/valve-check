import type { Graph } from "./graph";
import type { PNode } from "./types";

// 当日の運用停止範囲（制御室で入力し、トップ・制御室の図面に明示する）。
// 範囲は施設のエリア（受入系統A など）や機器IDで決める。複数を同時に停止できる。

export type OutageKey = "recvA" | "recvB" | "issueA" | "issueB" | "transferA" | "transferB" | "yard1" | "yard2";

export type OutageDef = {
  key: OutageKey;
  label: string;
  /** 範囲の説明（どの設備が含まれるか） */
  desc: string;
  /** 範囲に含めるノード */
  match: (n: PNode) => boolean;
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
  { key: "transferA", label: "移送A系停止", desc: "移送ポンプ TP-1 系統（吸込弁〜吐出弁）", match: transferLine(1) },
  { key: "transferB", label: "移送B系停止", desc: "移送ポンプ TP-2 系統（吸込弁〜吐出弁）", match: transferLine(2) },
  { key: "yard1", label: "第1タンクヤード停止", desc: "T-101〜T-106 と受入・払出・移送ヘッダー", match: inArea("第1ヤード") },
  { key: "yard2", label: "第2タンクヤード停止", desc: "T-201〜T-206 と受入・払出・移送ヘッダー", match: inArea("第2ヤード") },
];

export const OUTAGE_BY_KEY = new Map(OUTAGES.map((o) => [o.key, o]));

export type OutageRange = {
  def: OutageDef;
  nodeIds: string[];
  pipeIds: string[];
  /** 図面に枠を描く範囲 */
  box: { x: number; y: number; w: number; h: number };
};

/** 停止範囲のノード・配管と、図面上の枠 */
export function outageRange(g: Graph, key: OutageKey): OutageRange | null {
  const def = OUTAGE_BY_KEY.get(key);
  if (!def) return null;
  const nodes = new Set(g.facility.nodes.filter(def.match).map((n) => n.id));
  const pipeIds = g.facility.pipes
    .filter((p) => {
      if (nodes.has(p.a) && nodes.has(p.b)) return true;
      // 移送ポンプ系統は、共通の吸込・吐出管の分岐点までの配管も範囲に含める
      if (!def.key.startsWith("transfer")) return false;
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
