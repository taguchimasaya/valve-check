import type { AreaBox, Facility, NodeKind, Pipe, PNode, ValveState } from "./types";

// DBの系統図テーブル（piping_facilities / piping_diagram_*）の行と、画面で使う Facility の相互変換。

export type DiagramSource = {
  /** db：DBの使用中の版 / builtin：プログラム内の仮想施設（DB未設定・テーブル未作成のとき） */
  source: "db" | "builtin";
  facilityId: string;
  versionId: string | null;
  versionNo: number | null;
  /** builtin になった理由など */
  notice?: string;
};

export type DiagramPayload = DiagramSource & { facility: Facility };

export type FacilityRow = { id: string; name: string; width: number; height: number; meters_per_px: number };
export type AreaRow = { name: string; x: number; y: number; w: number; h: number; sort: number };
export type NodeRow = {
  code: string;
  kind: NodeKind;
  label: string;
  name: string;
  area: string;
  x: number;
  y: number;
  normal: ValveState | null;
  volume_l: number | null;
  drain_size_a: number | null;
  gauge_mountable: boolean | null;
  service: boolean | null;
  fill_line: boolean | null;
  fill_source: boolean | null;
  drain_pump_lpm: number | null;
  drain_route: string[] | null;
  drain_target: string | null;
  drain_system: string | null;
  dir_from: string | null;
  small: boolean | null;
  recovery: boolean | null;
  compact: boolean | null;
  capacity_kl: number | null;
  set_pressure_mpa: number | null;
  sort: number;
};
export type PipeRow = {
  code: string;
  node_a: string;
  node_b: string;
  size_a: number;
  length_m: number | null;
  via: [number, number][] | null;
  sort: number;
};

const num = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));
const flag = (v: boolean | null) => (v ? true : undefined);

/** DBの行から、画面・計算で使う Facility を組み立てる（空欄の項目は省く） */
export function rowsToFacility(f: FacilityRow, areas: AreaRow[], nodes: NodeRow[], pipes: PipeRow[]): Facility {
  const bySort = <T extends { sort: number }>(rows: T[]) => [...rows].sort((a, b) => a.sort - b.sort);
  return {
    name: f.name,
    width: Number(f.width),
    height: Number(f.height),
    metersPerPx: Number(f.meters_per_px),
    areas: bySort(areas).map(
      (a): AreaBox => ({ label: a.name, x: Number(a.x), y: Number(a.y), w: Number(a.w), h: Number(a.h) })
    ),
    nodes: bySort(nodes).map((r) => {
      const n: PNode = { id: r.code, kind: r.kind, label: r.label, name: r.name, x: Number(r.x), y: Number(r.y), area: r.area };
      const set = <K extends keyof PNode>(k: K, v: PNode[K] | undefined) => {
        if (v !== undefined) n[k] = v;
      };
      set("normal", r.normal ?? undefined);
      set("volumeL", num(r.volume_l));
      set("drainSizeA", num(r.drain_size_a));
      set("gaugeMountable", r.gauge_mountable ?? undefined);
      set("service", flag(r.service));
      set("fillLine", flag(r.fill_line));
      set("fillSource", flag(r.fill_source));
      set("drainPumpLpm", num(r.drain_pump_lpm));
      set("drainRoute", r.drain_route?.length ? r.drain_route : undefined);
      set("drainTarget", r.drain_target ?? undefined);
      set("drainSystem", r.drain_system ?? undefined);
      set("dirFrom", r.dir_from ?? undefined);
      set("small", flag(r.small));
      set("recovery", flag(r.recovery));
      set("compact", flag(r.compact));
      set("capacityKL", num(r.capacity_kl));
      set("setPressureMPa", num(r.set_pressure_mpa));
      return n;
    }),
    pipes: bySort(pipes).map((r) => {
      const p: Pipe = { id: r.code, a: r.node_a, b: r.node_b, sizeA: Number(r.size_a) };
      if (r.length_m !== null && r.length_m !== undefined) p.lengthM = Number(r.length_m);
      if (r.via?.length) p.via = r.via.map(([x, y]) => [Number(x), Number(y)] as [number, number]);
      return p;
    }),
  };
}
