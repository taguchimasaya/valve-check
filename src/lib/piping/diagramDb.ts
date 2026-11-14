import type { AreaBox, Facility, Fluid, NodeKind, Pipe, PNode, ValveState } from "./types";

// DBの系統図テーブル（piping_facilities / piping_diagram_*）の行と、画面で使う Facility の相互変換。

export type DiagramSource = {
  /** db：DBの使用中の版 / builtin：プログラム内の仮想施設（DB未設定・テーブル未作成のとき）/ none：その拠点に使用中の版が無い */
  source: "db" | "builtin" | "none";
  facilityId: string;
  versionId: string | null;
  versionNo: number | null;
  /** 表示している図面シート（本番想定の構造のとき）と、版のシート数 */
  sheet?: string;
  sheetCount?: number;
  /** builtin になった理由、位置の無い機器など */
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
  /** 消火設備などの追加項目（DBに列が無い版では undefined） */
  fluid?: Fluid | null;
  system?: string | null;
  sort: number;
};
export type PipeRow = {
  code: string;
  node_a: string;
  node_b: string;
  size_a: number;
  length_m: number | null;
  via: [number, number][] | null;
  fluid?: Fluid | null;
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
      set("fluid", r.fluid ?? undefined);
      set("system", r.system ?? undefined);
      return n;
    }),
    pipes: bySort(pipes).map((r) => {
      const p: Pipe = { id: r.code, a: r.node_a, b: r.node_b, sizeA: Number(r.size_a) };
      if (r.length_m !== null && r.length_m !== undefined) p.lengthM = Number(r.length_m);
      if (r.via?.length) p.via = r.via.map(([x, y]) => [Number(x), Number(y)] as [number, number]);
      if (r.fluid) p.fluid = r.fluid;
      return p;
    }),
  };
}

// ───── 本番想定の構造（論理データと図面データを分けたもの） ─────

export type SheetRow = { id: string; sheet_no: string; title: string; width: number; height: number; meters_per_unit: number | null };
export type AreaRowV2 = { name: string; sheet_id: string | null; x: number | null; y: number | null; w: number | null; h: number | null; sort: number };
export type NodeRowV2 = Omit<NodeRow, "x" | "y" | "compact"> & { rated_flow_lpm: number | null };
export type SymbolRow = { node_code: string; x: number; y: number; show_label: boolean };
export type PipeRowV2 = {
  code: string;
  node_a: string;
  node_b: string;
  size_a: number;
  pipe_spec_id: string | null;
  length_m: number | null;
  fluid?: Fluid | null;
  sort: number;
};
export type GeometryRow = { pipe_code: string; points: [number, number][] | null };
export type PipeSpecRow = { id: string; inner_diameter_mm: number };

/**
 * 論理データ（機器・配管）と、1枚の図面シートの図面データ（記号の位置・配管の経由点）から Facility を組み立てる。
 * そのシートに記号が無い機器は図面の左上に置き、件数を返す（計算には使える）。
 */
export function rowsToFacilityV2(
  facilityName: string,
  sheet: SheetRow,
  areas: AreaRowV2[],
  nodes: NodeRowV2[],
  symbols: SymbolRow[],
  pipes: PipeRowV2[],
  geometries: GeometryRow[],
  specs: PipeSpecRow[]
): { facility: Facility; unplaced: number } {
  const sym = new Map(symbols.map((s) => [s.node_code, s]));
  const geo = new Map(geometries.map((g) => [g.pipe_code, g.points]));
  const spec = new Map(specs.map((s) => [s.id, Number(s.inner_diameter_mm) / 1000]));
  let unplaced = 0;
  const base = rowsToFacility(
    { id: "", name: facilityName, width: sheet.width, height: sheet.height, meters_per_px: sheet.meters_per_unit ?? 0 },
    areas
      .filter((a) => a.sheet_id === sheet.id && a.x !== null && a.y !== null && a.w !== null && a.h !== null)
      .map((a) => ({ name: a.name, x: a.x!, y: a.y!, w: a.w!, h: a.h!, sort: a.sort })),
    nodes.map((n) => {
      const s = sym.get(n.code);
      if (!s) unplaced++;
      return { ...n, x: s?.x ?? 0, y: s?.y ?? 0, compact: s ? !s.show_label : null };
    }),
    pipes.map((p) => ({
      code: p.code,
      node_a: p.node_a,
      node_b: p.node_b,
      size_a: p.size_a,
      length_m: p.length_m,
      via: geo.get(p.code) ?? null,
      fluid: p.fluid ?? null,
      sort: p.sort,
    }))
  );
  const specOf = new Map(pipes.map((p) => [p.code, p.pipe_spec_id ? spec.get(p.pipe_spec_id) : undefined]));
  base.pipes.forEach((p) => {
    const d = specOf.get(p.id);
    if (d) p.innerDiameterM = d;
  });
  return { facility: base, unplaced };
}
