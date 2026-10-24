import type { Facility, Pipe } from "./types";

// 図面上の配置（下絵を見ながら決めた機器の位置）。
// 系統（つながり・諸元）は変えず、描画する位置だけを差し替える。

export type UnderlaySetting = {
  /** 下絵の左上（系統図の座標） */
  x: number;
  y: number;
  /** 下絵の幅・高さ（系統図の座標） */
  width: number;
  height: number;
  opacity: number;
  /** 読み込んだファイル名（表示用） */
  name: string;
};

export type PipingLayout = {
  /** 位置を変えた機器（機器番号 → [x, y]） */
  positions: Record<string, [number, number]>;
  /** まだ図面に合わせて配置していない機器 */
  unplaced: string[];
  underlay?: UnderlaySetting;
};

export const EMPTY_LAYOUT: PipingLayout = { positions: {}, unplaced: [] };

function polylineLength(pts: [number, number][]) {
  let len = 0;
  for (let i = 0; i < pts.length - 1; i++) len += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  return len;
}

/**
 * 配置を反映した施設データを返す。
 * - 動かした機器につながる配管は、折れ点を作り直して直角に引き直す
 * - 配管の実長は動かす前の長さのまま固定する（描き直しで抜取量が変わらないように）
 */
export function applyLayout(base: Facility, layout: PipingLayout | undefined): Facility {
  const moved = layout?.positions ?? {};
  if (!Object.keys(moved).length) return base;
  const byId = new Map(base.nodes.map((n) => [n.id, n]));
  const nodes = base.nodes.map((n) => (moved[n.id] ? { ...n, x: moved[n.id][0], y: moved[n.id][1] } : n));
  const newById = new Map(nodes.map((n) => [n.id, n]));
  const pipes: Pipe[] = base.pipes.map((p) => {
    if (!moved[p.a] && !moved[p.b]) return p;
    const a0 = byId.get(p.a)!;
    const b0 = byId.get(p.b)!;
    const lengthM =
      p.lengthM ?? polylineLength([[a0.x, a0.y], ...(p.via ?? []), [b0.x, b0.y]]) * base.metersPerPx;
    const a = newById.get(p.a)!;
    const b = newById.get(p.b)!;
    const straight = a.x === b.x || a.y === b.y;
    return { ...p, lengthM, via: straight ? undefined : [[b.x, a.y] as [number, number]] };
  });
  return { ...base, nodes, pipes };
}
