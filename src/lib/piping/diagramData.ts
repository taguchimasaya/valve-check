import * as XLSX from "xlsx";
import { rowsToFacilityV2 } from "./diagramDb";
import type { Facility, NodeKind } from "./types";

// 系統図データの入出力（Excel ⇔ DBの行）と入力チェック。
// 1つの「版」の中身をまとめた DiagramData を、DBの行と同じ項目名で持つ（version_id だけ除く）。

export type SheetData = {
  sheet_no: string;
  title: string;
  width: number;
  height: number;
  meters_per_unit: number | null;
  source_doc_no: string | null;
};
export type AreaData = { name: string; sheet_no: string | null; x: number | null; y: number | null; w: number | null; h: number | null };
export type NodeData = {
  code: string;
  kind: NodeKind;
  label: string;
  name: string;
  area: string;
  equipment_code: string | null;
  normal: "open" | "close" | null;
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
  rated_flow_lpm: number | null;
  capacity_kl: number | null;
  set_pressure_mpa: number | null;
  data_source: string | null;
  note: string | null;
};
export type SymbolData = { node_code: string; sheet_no: string; x: number; y: number; rotation: number; show_label: boolean };
export type PipeData = {
  code: string;
  line_no: string | null;
  node_a: string;
  node_b: string;
  size_a: number;
  pipe_spec_id: string | null;
  length_m: number | null;
  length_source: "measured" | "isometric" | "cad" | "drawing_estimate" | null;
  note: string | null;
};
export type GeometryData = { pipe_code: string; sheet_no: string; points: [number, number][] | null };
export type SpecData = {
  id: string;
  size_a: number;
  schedule: string;
  outer_diameter_mm: number;
  inner_diameter_mm: number;
  material: string | null;
};
export type DiagramData = {
  facility_id: string;
  facility_name: string;
  note: string | null;
  sheets: SheetData[];
  areas: AreaData[];
  nodes: NodeData[];
  symbols: SymbolData[];
  pipes: PipeData[];
  geometries: GeometryData[];
  specs: SpecData[];
};

export type Issue = { severity: "error" | "warning"; target_type: "node" | "pipe" | "sheet" | "version"; target_code: string | null; message: string };

// ───── 表記（Excel では日本語で書けるようにする） ─────

export const KIND_LABEL: Record<NodeKind, string> = {
  junction: "分岐点",
  valve: "仕切弁",
  check: "逆止弁",
  tank: "タンク",
  pump: "払出ポンプ",
  transferPump: "移送ポンプ",
  strainer: "ストレーナー",
  filter: "フィルター",
  psv: "安全弁",
  drain: "ドレン口",
  gauge: "圧力計取付口",
  source: "受入口",
  sink: "払出先",
};
const KIND_BY_LABEL = new Map<string, NodeKind>(
  (Object.entries(KIND_LABEL) as [NodeKind, string][]).flatMap(([k, l]) => [
    [l, k],
    [k, k],
    [k.toLowerCase(), k],
  ])
);
const LENGTH_SOURCE_LABEL = { measured: "実測", isometric: "アイソメ", cad: "CAD", drawing_estimate: "図面概算" } as const;
const LENGTH_SOURCE_BY_LABEL = new Map<string, PipeData["length_source"]>(
  Object.entries(LENGTH_SOURCE_LABEL).flatMap(([k, l]) => [
    [l, k as PipeData["length_source"]],
    [k, k as PipeData["length_source"]],
  ])
);

// ───── Excel の列（見出し → 項目） ─────

type Col<T> = {
  head: string;
  key: keyof T;
  /** flagOn：空欄＝はい（○／×で書く） */
  type: "text" | "num" | "flag" | "flagOn" | "list" | "kind" | "normal" | "lsrc" | "points";
  required?: boolean;
  note: string;
};

const SHEET_COLS: Col<SheetData>[] = [
  { head: "シート番号", key: "sheet_no", type: "text", required: true, note: "例：S1。機器の位置・配管の経由点はこの番号で図面を指す" },
  { head: "名称", key: "title", type: "text", required: true, note: "例：全体系統図" },
  { head: "幅", key: "width", type: "num", required: true, note: "座標の範囲（横）" },
  { head: "高さ", key: "height", type: "num", required: true, note: "座標の範囲（縦、下向きが＋）" },
  { head: "縮尺(m/座標1)", key: "meters_per_unit", type: "num", note: "配管の実長が空欄のとき、図面上の長さ×縮尺で概算" },
  { head: "元の図面番号", key: "source_doc_no", type: "text", note: "図面番号（任意）" },
];
const AREA_COLS: Col<AreaData>[] = [
  { head: "区画名", key: "name", type: "text", required: true, note: "例：受入系統A。機器の「区画」と同じ名前" },
  { head: "シート番号", key: "sheet_no", type: "text", note: "枠を描くシート（枠が不要なら空欄）" },
  { head: "X", key: "x", type: "num", note: "枠の左上" },
  { head: "Y", key: "y", type: "num", note: "" },
  { head: "幅", key: "w", type: "num", note: "" },
  { head: "高さ", key: "h", type: "num", note: "" },
];
const NODE_COLS: Col<NodeData>[] = [
  { head: "機器番号", key: "code", type: "text", required: true, note: "一意の番号。QR・チェックリストの番号。分岐点にも付ける" },
  { head: "種別", key: "kind", type: "kind", required: true, note: Object.values(KIND_LABEL).join("／") },
  { head: "表示ラベル", key: "label", type: "text", note: "図面に出す文字（空欄なら表示しない）" },
  { head: "名称", key: "name", type: "text", required: true, note: "例：T-101 受入弁" },
  { head: "区画", key: "area", type: "text", required: true, note: "区画シートの区画名" },
  { head: "機器マスター番号", key: "equipment_code", type: "text", note: "既存の機器マスターの番号（違う場合のみ）" },
  { head: "待機状態", key: "normal", type: "normal", note: "開／閉（仕切弁・ドレン口・圧力計取付口は必須）" },
  { head: "内容量(L)", key: "volume_l", type: "num", note: "ストレーナー・フィルター・ポンプなど" },
  { head: "ドレン口径(A)", key: "drain_size_a", type: "num", note: "ドレン口のみ" },
  { head: "圧力計取付可", key: "gauge_mountable", type: "flag", note: "○／空欄" },
  { head: "作業用弁", key: "service", type: "flag", note: "充填弁など（運用経路では通らない）" },
  { head: "充填ライン上", key: "fill_line", type: "flag", note: "○／空欄" },
  { head: "充填の供給元", key: "fill_source", type: "flag", note: "○／空欄（分岐点）" },
  { head: "抜取ポンプ能力(L/min)", key: "drain_pump_lpm", type: "num", note: "固定の抜取ポンプがあるドレン口" },
  { head: "抜取経路", key: "drain_route", type: "list", note: "開ける弁の番号をカンマ区切り（ドレン弁 → 抜取ポンプ側）" },
  { head: "抜取先", key: "drain_target", type: "text", note: "回収先タンクの機器番号" },
  { head: "抜取系統", key: "drain_system", type: "text", note: "共有する抜取ポンプの機器番号" },
  { head: "上流側機器番号", key: "dir_from", type: "text", note: "逆止弁・ポンプ・安全弁は必須（流れてくる側の隣の機器）" },
  { head: "小型タンク", key: "small", type: "flag", note: "○／空欄" },
  { head: "回収タンク", key: "recovery", type: "flag", note: "○／空欄（安全弁の逃がし先）" },
  { head: "定格流量(L/min)", key: "rated_flow_lpm", type: "num", note: "ポンプ" },
  { head: "タンク容量(kL)", key: "capacity_kl", type: "num", note: "タンク" },
  { head: "設定圧力(MPa)", key: "set_pressure_mpa", type: "num", note: "安全弁" },
  { head: "諸元の出典", key: "data_source", type: "text", note: "例：機器台帳、メーカー資料、現地確認" },
  { head: "備考", key: "note", type: "text", note: "" },
];
const SYMBOL_COLS: Col<SymbolData>[] = [
  { head: "機器番号", key: "node_code", type: "text", required: true, note: "機器シートの番号" },
  { head: "シート番号", key: "sheet_no", type: "text", required: true, note: "" },
  { head: "X", key: "x", type: "num", required: true, note: "記号の中心" },
  { head: "Y", key: "y", type: "num", required: true, note: "" },
  { head: "回転(度)", key: "rotation", type: "num", note: "空欄なら0" },
  { head: "ラベル表示", key: "show_label", type: "flagOn", note: "○／×（空欄は○）" },
];
const PIPE_COLS: Col<PipeData>[] = [
  { head: "配管番号", key: "code", type: "text", required: true, note: "一意の番号（版をまたいで同じ配管は同じ番号）" },
  { head: "ライン番号", key: "line_no", type: "text", note: "例：150-JA-1001" },
  { head: "始点", key: "node_a", type: "text", required: true, note: "機器番号" },
  { head: "終点", key: "node_b", type: "text", required: true, note: "機器番号" },
  { head: "呼び径(A)", key: "size_a", type: "num", required: true, note: "" },
  { head: "配管仕様ID", key: "pipe_spec_id", type: "text", note: "配管仕様シートのID（空欄なら呼び径のSch40相当）" },
  { head: "実長(m)", key: "length_m", type: "num", note: "空欄なら図面上の長さ×縮尺で概算" },
  { head: "実長の出典", key: "length_source", type: "lsrc", note: "実測／アイソメ／CAD／図面概算" },
  { head: "備考", key: "note", type: "text", note: "" },
];
const GEOMETRY_COLS: Col<GeometryData>[] = [
  { head: "配管番号", key: "pipe_code", type: "text", required: true, note: "" },
  { head: "シート番号", key: "sheet_no", type: "text", required: true, note: "" },
  { head: "経由点", key: "points", type: "points", note: "X,Y;X,Y…（直角に曲げて描く点。直線なら空欄）" },
];
const SPEC_COLS: Col<SpecData>[] = [
  { head: "仕様ID", key: "id", type: "text", required: true, note: "例：150A-Sch40" },
  { head: "呼び径(A)", key: "size_a", type: "num", required: true, note: "" },
  { head: "スケジュール", key: "schedule", type: "text", required: true, note: "例：Sch40" },
  { head: "外径(mm)", key: "outer_diameter_mm", type: "num", required: true, note: "" },
  { head: "内径(mm)", key: "inner_diameter_mm", type: "num", required: true, note: "容量の計算に使う" },
  { head: "材質", key: "material", type: "text", note: "例：STPG370" },
];

const TABLES = [
  { sheet: "図面シート", cols: SHEET_COLS, key: "sheets" },
  { sheet: "区画", cols: AREA_COLS, key: "areas" },
  { sheet: "機器", cols: NODE_COLS, key: "nodes" },
  { sheet: "機器の位置", cols: SYMBOL_COLS, key: "symbols" },
  { sheet: "配管", cols: PIPE_COLS, key: "pipes" },
  { sheet: "配管の経由点", cols: GEOMETRY_COLS, key: "geometries" },
  { sheet: "配管仕様", cols: SPEC_COLS, key: "specs" },
] as const;

// ───── 書き出し ─────

function cellOut(type: Col<object>["type"], v: unknown): string | number {
  if (v === null || v === undefined) return "";
  switch (type) {
    case "flag":
      return v ? "○" : "";
    case "flagOn":
      return v ? "○" : "×";
    case "list":
      return (v as string[]).join(",");
    case "kind":
      return KIND_LABEL[v as NodeKind] ?? String(v);
    case "normal":
      return v === "open" ? "開" : "閉";
    case "lsrc":
      return LENGTH_SOURCE_LABEL[v as keyof typeof LENGTH_SOURCE_LABEL] ?? String(v);
    case "points":
      return (v as [number, number][]).map(([x, y]) => `${x},${y}`).join(";");
    default:
      return v as string | number;
  }
}

/** 版の中身を Excel（登録シート）にする */
export function diagramToWorkbook(d: DiagramData): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const guide: (string | number)[][] = [
    ["配管系統図 登録シート"],
    ["このファイルを編集して ④ 系統図データ管理 から取り込むと、新しい版（下書き）として登録されます。"],
    ["見出し行は変えないでください。行の順番は自由です。○ のある列は、空欄＝いいえ です。"],
    [],
    ["施設ID", d.facility_id],
    ["施設名", d.facility_name],
    ["版のメモ", d.note ?? ""],
    [],
    ["シート", "列", "必須", "書き方"],
  ];
  TABLES.forEach((t) => (t.cols as Col<object>[]).forEach((c) => guide.push([t.sheet, c.head, c.required ? "○" : "", c.note])));
  const gs = XLSX.utils.aoa_to_sheet(guide);
  gs["!cols"] = [{ wch: 14 }, { wch: 22 }, { wch: 6 }, { wch: 70 }];
  XLSX.utils.book_append_sheet(wb, gs, "説明");
  TABLES.forEach((t) => {
    const cols = t.cols as Col<object>[];
    const rows = (d[t.key] as object[]).map((r) => cols.map((c) => cellOut(c.type, (r as Record<string, unknown>)[c.key as string])));
    const ws = XLSX.utils.aoa_to_sheet([cols.map((c) => c.head), ...rows]);
    ws["!cols"] = cols.map((c) => ({ wch: Math.max(8, c.head.length * 2 + 2) }));
    XLSX.utils.book_append_sheet(wb, ws, t.sheet);
  });
  return wb;
}

// ───── 取り込み ─────

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

/** Excel（登録シート）を読み込む。読めない値は issues に入れる */
export function workbookToDiagram(wb: XLSX.WorkBook): { data: DiagramData; issues: Issue[] } {
  const issues: Issue[] = [];
  const err = (target_type: Issue["target_type"], target_code: string | null, message: string) =>
    issues.push({ severity: "error", target_type, target_code, message });

  // 説明シートの施設ID・施設名・版のメモ
  const info = new Map<string, string>();
  const gs = wb.Sheets["説明"];
  if (gs) {
    (XLSX.utils.sheet_to_json<unknown[]>(gs, { header: 1, blankrows: false }) as unknown[][]).forEach((r) => {
      if (r.length >= 2 && ["施設ID", "施設名", "版のメモ"].includes(str(r[0]))) info.set(str(r[0]), str(r[1]));
    });
  }
  const data: DiagramData = {
    facility_id: info.get("施設ID") || "",
    facility_name: info.get("施設名") || "",
    note: info.get("版のメモ") || null,
    sheets: [],
    areas: [],
    nodes: [],
    symbols: [],
    pipes: [],
    geometries: [],
    specs: [],
  };
  if (!data.facility_id) err("version", null, "説明シートに「施設ID」がありません");

  TABLES.forEach((t) => {
    const ws = wb.Sheets[t.sheet];
    if (!ws) {
      if (t.key !== "geometries" && t.key !== "areas") err("version", null, `シート「${t.sheet}」がありません`);
      return;
    }
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false, defval: "" }) as unknown[][];
    const head = (aoa[0] ?? []).map(str);
    const cols = t.cols as Col<object>[];
    const idx = cols.map((c) => head.indexOf(c.head));
    cols.forEach((c, i) => {
      if (idx[i] < 0 && c.required) err("version", null, `シート「${t.sheet}」に列「${c.head}」がありません`);
    });
    aoa.slice(1).forEach((r, ri) => {
      if (r.every((v) => str(v) === "")) return;
      const line = `${t.sheet} ${ri + 2}行目`;
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => {
        const raw = idx[i] >= 0 ? r[idx[i]] : "";
        const s = str(raw);
        let v: unknown = null;
        if (s !== "") {
          switch (c.type) {
            case "num": {
              const n = Number(s);
              if (Number.isFinite(n)) v = n;
              else err("version", null, `${line}：「${c.head}」が数値ではありません（${s}）`);
              break;
            }
            case "flag":
            case "flagOn":
              v = !["×", "x", "X", "no", "false", "0", "いいえ"].includes(s);
              break;
            case "list":
              v = s.split(/[,、，\s]+/).filter(Boolean);
              break;
            case "kind":
              v = KIND_BY_LABEL.get(s) ?? KIND_BY_LABEL.get(s.toLowerCase()) ?? null;
              if (!v) err("version", null, `${line}：種別「${s}」は使えません（${Object.values(KIND_LABEL).join("・")}）`);
              break;
            case "normal":
              v = ["開", "open", "O"].includes(s) ? "open" : ["閉", "close", "C"].includes(s) ? "close" : null;
              if (!v) err("version", null, `${line}：待機状態は「開」か「閉」で書いてください（${s}）`);
              break;
            case "lsrc":
              v = LENGTH_SOURCE_BY_LABEL.get(s) ?? null;
              if (!v) err("version", null, `${line}：実長の出典は 実測／アイソメ／CAD／図面概算 のどれかです（${s}）`);
              break;
            case "points": {
              const pts = s.split(";").filter(Boolean).map((p) => p.split(",").map((n) => Number(n.trim())));
              if (pts.every((p) => p.length === 2 && p.every(Number.isFinite))) v = pts as [number, number][];
              else err("version", null, `${line}：経由点は X,Y;X,Y… の形で書いてください`);
              break;
            }
            default:
              v = s;
          }
        } else if (c.required) {
          err("version", null, `${line}：「${c.head}」が空欄です`);
        }
        row[c.key as string] = v;
      });
      if (t.key === "nodes") {
        row.label ??= "";
      }
      if (t.key === "symbols") {
        row.rotation ??= 0;
        row.show_label ??= true;
      }
      (data[t.key] as unknown[]).push(row);
    });
  });
  if (!data.facility_name) data.facility_name = data.facility_id;
  return { data, issues };
}

// ───── 入力チェック ─────

const NEEDS_NORMAL: NodeKind[] = ["valve", "drain", "gauge"];
const NEEDS_DIRECTION: NodeKind[] = ["check", "pump", "transferPump"];

/** 系統図として使えるかの確認。error があると登録できない */
export function validateDiagram(d: DiagramData): Issue[] {
  const issues: Issue[] = [];
  const add = (severity: Issue["severity"], target_type: Issue["target_type"], target_code: string | null, message: string) =>
    issues.push({ severity, target_type, target_code, message });
  const dup = <T>(rows: T[], key: (r: T) => string, type: Issue["target_type"], label: string) => {
    const seen = new Set<string>();
    rows.forEach((r) => {
      const k = key(r);
      if (seen.has(k)) add("error", type, k, `${label}「${k}」が重複しています`);
      seen.add(k);
    });
  };

  if (!d.sheets.length) add("error", "version", null, "図面シートが1枚もありません");
  if (!d.nodes.length) add("error", "version", null, "機器が1件もありません");
  dup(d.sheets, (s) => s.sheet_no, "sheet", "シート番号");
  dup(d.nodes, (n) => n.code, "node", "機器番号");
  dup(d.pipes, (p) => p.code, "pipe", "配管番号");
  dup(d.symbols, (s) => `${s.node_code}@${s.sheet_no}`, "node", "機器の位置");
  dup(d.areas, (a) => a.name, "version", "区画名");

  const sheets = new Set(d.sheets.map((s) => s.sheet_no));
  const nodes = new Map(d.nodes.map((n) => [n.code, n]));
  const pipes = new Set(d.pipes.map((p) => p.code));
  const specs = new Map(d.specs.map((s) => [s.id, s]));
  const areaNames = new Set(d.areas.map((a) => a.name));

  // つながり：機器ごとの隣
  const neighbors = new Map<string, Set<string>>();
  d.pipes.forEach((p) => {
    [
      [p.node_a, p.node_b],
      [p.node_b, p.node_a],
    ].forEach(([a, b]) => {
      if (!neighbors.has(a)) neighbors.set(a, new Set());
      neighbors.get(a)!.add(b);
    });
    if (!nodes.has(p.node_a)) add("error", "pipe", p.code, `配管 ${p.code} の始点「${p.node_a}」が機器にありません`);
    if (!nodes.has(p.node_b)) add("error", "pipe", p.code, `配管 ${p.code} の終点「${p.node_b}」が機器にありません`);
    if (p.node_a === p.node_b) add("error", "pipe", p.code, `配管 ${p.code} の始点と終点が同じです`);
    if (p.pipe_spec_id && !specs.has(p.pipe_spec_id)) add("error", "pipe", p.code, `配管 ${p.code} の配管仕様「${p.pipe_spec_id}」が配管仕様シートにありません`);
    const spec = p.pipe_spec_id ? specs.get(p.pipe_spec_id) : undefined;
    if (spec && spec.size_a !== p.size_a) add("warning", "pipe", p.code, `配管 ${p.code} の呼び径（${p.size_a}A）と配管仕様（${spec.size_a}A）が違います`);
    if (p.length_m === null && !d.sheets.some((s) => s.meters_per_unit)) add("warning", "pipe", p.code, `配管 ${p.code} は実長も縮尺も無いため、容量を計算できません`);
  });

  d.nodes.forEach((n) => {
    const nb = neighbors.get(n.code);
    if (!nb || nb.size === 0) add("error", "node", n.code, `機器 ${n.code} はどの配管にもつながっていません`);
    // 抜取用配管につながるドレン口は、開閉をドレン弁（抜取経路の弁）で持つ
    if (NEEDS_NORMAL.includes(n.kind) && !n.normal && !(n.kind === "drain" && n.drain_route?.length)) add("error", "node", n.code, `${KIND_LABEL[n.kind]} ${n.code} の待機状態（開／閉）が空欄です`);
    if (NEEDS_DIRECTION.includes(n.kind) && !n.dir_from) add("error", "node", n.code, `${KIND_LABEL[n.kind]} ${n.code} の上流側機器番号が空欄です（流れの向きが決まりません）`);
    if (n.dir_from && !(nb && nb.has(n.dir_from))) add("error", "node", n.code, `機器 ${n.code} の上流側「${n.dir_from}」が、配管で隣り合う機器ではありません`);
    if ((n.kind === "strainer" || n.kind === "filter") && n.volume_l === null) add("warning", "node", n.code, `${KIND_LABEL[n.kind]} ${n.code} の内容量が空欄です（抜取量に入りません）`);
    if (n.kind === "drain" && n.drain_size_a === null && n.drain_pump_lpm === null) add("warning", "node", n.code, `ドレン口 ${n.code} の口径が空欄です（抜取時間を計算できません）`);
    (n.drain_route ?? []).forEach((v) => {
      if (!nodes.has(v)) add("error", "node", n.code, `ドレン口 ${n.code} の抜取経路「${v}」が機器にありません`);
    });
    [n.drain_target, n.drain_system].forEach((v) => {
      if (v && !nodes.has(v)) add("error", "node", n.code, `機器 ${n.code} の抜取先・抜取系統「${v}」が機器にありません`);
    });
  });

  // 区画シートに無い区画（枠を描かないだけで、計算には影響しない）
  const unknownAreas = new Map<string, number>();
  d.nodes.forEach((n) => {
    if (areaNames.size && ![...areaNames].some((a) => a === n.area || a.startsWith(`${n.area}（`))) {
      unknownAreas.set(n.area, (unknownAreas.get(n.area) ?? 0) + 1);
    }
  });
  unknownAreas.forEach((cnt, area) => add("warning", "version", area, `区画「${area}」（機器 ${cnt} 件）が区画シートにありません（図面に枠が出ません）`));

  // 図面データ
  const placed = new Map<string, Set<string>>();
  d.symbols.forEach((s) => {
    if (!nodes.has(s.node_code)) add("error", "node", s.node_code, `機器の位置「${s.node_code}」が機器にありません`);
    if (!sheets.has(s.sheet_no)) add("error", "sheet", s.sheet_no, `機器 ${s.node_code} の位置のシート「${s.sheet_no}」がありません`);
    if (!placed.has(s.sheet_no)) placed.set(s.sheet_no, new Set());
    placed.get(s.sheet_no)!.add(s.node_code);
  });
  const first = d.sheets[0]?.sheet_no;
  if (first) {
    const missing = d.nodes.filter((n) => !placed.get(first)?.has(n.code)).length;
    if (missing) add("warning", "sheet", first, `シート ${first} に位置が無い機器が ${missing} 件あります（図面の左上に表示されます）`);
  }
  d.geometries.forEach((g) => {
    if (!pipes.has(g.pipe_code)) add("error", "pipe", g.pipe_code, `経由点の配管「${g.pipe_code}」が配管にありません`);
    if (!sheets.has(g.sheet_no)) add("error", "sheet", g.sheet_no, `配管 ${g.pipe_code} の経由点のシート「${g.sheet_no}」がありません`);
  });
  d.areas.forEach((a) => {
    if (a.sheet_no && !sheets.has(a.sheet_no)) add("error", "sheet", a.sheet_no, `区画 ${a.name} のシート「${a.sheet_no}」がありません`);
  });
  return issues;
}

/** 版の中身を、図面シート1枚分の Facility にする（プレビュー用） */
export function diagramToFacility(d: DiagramData, sheetNo?: string): Facility {
  const sheet = d.sheets.find((s) => s.sheet_no === sheetNo) ?? d.sheets[0];
  const id = sheet?.sheet_no ?? "";
  return rowsToFacilityV2(
    d.facility_name,
    { id, sheet_no: id, title: sheet?.title ?? "", width: sheet?.width ?? 1000, height: sheet?.height ?? 600, meters_per_unit: sheet?.meters_per_unit ?? null },
    d.areas.map((a, i) => ({ ...a, sheet_id: a.sheet_no, sort: i })),
    d.nodes.map((n, i) => ({ ...n, sort: i })),
    d.symbols.filter((s) => s.sheet_no === id).map((s) => ({ node_code: s.node_code, x: s.x, y: s.y, show_label: s.show_label })),
    d.pipes.map((p, i) => ({ ...p, sort: i })),
    d.geometries.filter((g) => g.sheet_no === id).map((g) => ({ pipe_code: g.pipe_code, points: g.points })),
    d.specs.map((s) => ({ id: s.id, inner_diameter_mm: s.inner_diameter_mm }))
  ).facility;
}
