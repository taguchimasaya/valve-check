import type { NodeKind } from "./types";
import type { DiagramData, NodeData, PipeData } from "./diagramData";

// 系統図エディタの編集操作。版の中身（DiagramData）を受け取り、変更後の新しい DiagramData を返す（元のデータは変えない）。
// つながり（機器・配管）と図面データ（シートごとの位置・経由点）は分けたまま編集する。
// 既存の機器番号・配管番号は変えない（保存済みのチェックリストは配管番号で範囲を覚えているため）。

export type Point = [number, number];

const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

/** DB から読んだ版の中身の数値（文字列で返る列がある）を数値にそろえる */
export function normalizeDiagram(d: DiagramData): DiagramData {
  return {
    ...d,
    sheets: d.sheets.map((s) => ({ ...s, width: Number(s.width), height: Number(s.height), meters_per_unit: num(s.meters_per_unit) })),
    symbols: d.symbols.map((s) => ({ ...s, x: Number(s.x), y: Number(s.y), rotation: Number(s.rotation ?? 0) })),
    geometries: d.geometries.map((g) => ({ ...g, points: g.points ? g.points.map(([x, y]) => [Number(x), Number(y)] as Point) : null })),
    pipes: d.pipes.map((p) => ({ ...p, size_a: Number(p.size_a), length_m: num(p.length_m) })),
    nodes: d.nodes.map((n) => ({
      ...n,
      volume_l: num(n.volume_l),
      drain_size_a: num(n.drain_size_a),
      drain_pump_lpm: num(n.drain_pump_lpm),
      rated_flow_lpm: num(n.rated_flow_lpm),
      capacity_kl: num(n.capacity_kl),
      set_pressure_mpa: num(n.set_pressure_mpa),
    })),
  };
}

/** 機器の位置（シート上）。位置が無ければ null */
export function symbolOf(d: DiagramData, sheetNo: string, code: string) {
  return d.symbols.find((s) => s.sheet_no === sheetNo && s.node_code === code) ?? null;
}

/** 配管の経由点（シート上）。無ければ空 */
export function viaOf(d: DiagramData, sheetNo: string, pipeCode: string): Point[] {
  return d.geometries.find((g) => g.sheet_no === sheetNo && g.pipe_code === pipeCode)?.points ?? [];
}

/** 機器の位置を変える（位置が無かった機器には位置を作る） */
export function moveNode(d: DiagramData, sheetNo: string, code: string, x: number, y: number): DiagramData {
  const exists = d.symbols.some((s) => s.sheet_no === sheetNo && s.node_code === code);
  return {
    ...d,
    symbols: exists
      ? d.symbols.map((s) => (s.sheet_no === sheetNo && s.node_code === code ? { ...s, x, y } : s))
      : [...d.symbols, { node_code: code, sheet_no: sheetNo, x, y, rotation: 0, show_label: true }],
  };
}

/** 配管の経由点をまとめて置き換える（空なら経由点なし＝両端を直線で結ぶ） */
export function setVia(d: DiagramData, sheetNo: string, pipeCode: string, points: Point[]): DiagramData {
  const rest = d.geometries.filter((g) => !(g.sheet_no === sheetNo && g.pipe_code === pipeCode));
  return { ...d, geometries: points.length ? [...rest, { pipe_code: pipeCode, sheet_no: sheetNo, points }] : rest };
}

/** 配管の描画上の点列（始点の機器 → 経由点 → 終点の機器） */
export function pipePath(d: DiagramData, sheetNo: string, p: PipeData): Point[] {
  const a = symbolOf(d, sheetNo, p.node_a);
  const b = symbolOf(d, sheetNo, p.node_b);
  return [[a?.x ?? 0, a?.y ?? 0], ...viaOf(d, sheetNo, p.code), [b?.x ?? 0, b?.y ?? 0]];
}

function pathLength(pts: Point[]) {
  let len = 0;
  for (let i = 0; i < pts.length - 1; i++) len += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  return len;
}

/** 点に最も近い線分と、その線分上の最も近い点 */
export function nearestOnPath(pts: Point[], x: number, y: number): { segment: number; point: Point; t: number } {
  let best = { segment: 0, point: pts[0], t: 0, dist: Infinity };
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len2)) : 0;
    const px = ax + (bx - ax) * t;
    const py = ay + (by - ay) * t;
    const dist = Math.hypot(x - px, y - py);
    if (dist < best.dist) best = { segment: i, point: [px, py], t, dist };
  }
  return best;
}

/** 経由点を足す：配管上のクリック位置に一番近い線分の途中に入れる */
export function addVia(d: DiagramData, sheetNo: string, pipeCode: string, x: number, y: number): DiagramData {
  const p = d.pipes.find((q) => q.code === pipeCode);
  if (!p) return d;
  const { segment, point } = nearestOnPath(pipePath(d, sheetNo, p), x, y);
  const via = [...viaOf(d, sheetNo, pipeCode)];
  via.splice(segment, 0, point);
  return setVia(d, sheetNo, pipeCode, via);
}

// ───── 番号の付け方 ─────

/** 「V-0123」→ { prefix: "V-", num: 123, digits: 4 } */
function splitCode(code: string) {
  const m = code.match(/^(.*?)(\d+)([^\d]*)$/);
  return m ? { prefix: m[1], num: Number(m[2]), digits: m[2].length, suffix: m[3] } : null;
}

function nextCode(codes: string[], fallbackPrefix: string, fallbackDigits: number, used: Set<string>): string {
  // いちばん多い書き方（接頭辞・桁数）にそろえ、その中の最大の番号 + 1 にする
  const groups = new Map<string, { prefix: string; suffix: string; digits: number; max: number; count: number }>();
  codes.forEach((c) => {
    const s = splitCode(c);
    if (!s) return;
    const key = `${s.prefix}|${s.suffix}`;
    const g = groups.get(key) ?? { prefix: s.prefix, suffix: s.suffix, digits: s.digits, max: 0, count: 0 };
    g.max = Math.max(g.max, s.num);
    g.digits = Math.max(g.digits, s.digits);
    g.count++;
    groups.set(key, g);
  });
  const g = [...groups.values()].sort((a, b) => b.count - a.count)[0];
  const prefix = g?.prefix ?? fallbackPrefix;
  const suffix = g?.suffix ?? "";
  const digits = g?.digits ?? fallbackDigits;
  for (let n = (g?.max ?? 0) + 1; ; n++) {
    const code = `${prefix}${String(n).padStart(digits, "0")}${suffix}`;
    if (!used.has(code)) return code;
  }
}

const KIND_PREFIX: Partial<Record<NodeKind, string>> = {
  valve: "V-",
  check: "CV-",
  drain: "D-",
  gauge: "PG-",
  psv: "PSV-",
  strainer: "ST-",
  filter: "F-",
  sampler: "SMP-",
  junction: "J-",
};

/** 新しい機器番号の候補（同じ種別の機器の番号の続き） */
export function suggestNodeCode(d: DiagramData, kind: NodeKind): string {
  const sameKind = d.nodes.filter((n) => n.kind === kind).map((n) => n.code);
  // 別の種別の機器と番号が重なる場合は、さらに先の番号にする
  return nextCode(sameKind, KIND_PREFIX[kind] ?? `${kind.toUpperCase()}-`, 3, new Set(d.nodes.map((n) => n.code)));
}

/** 新しい配管番号の候補 */
export function suggestPipeCode(d: DiagramData): string {
  const codes = d.pipes.map((p) => p.code);
  return nextCode(codes, "P", 3, new Set(codes));
}

// ───── 配管の途中に機器（弁など）を入れる ─────

export type InsertOptions = {
  kind: NodeKind;
  code: string;
  label?: string;
  name?: string;
  normal?: "open" | "close" | null;
};

export type InsertResult = { data: DiagramData; nodeCode: string; newPipeCode: string };

/**
 * 配管 pipeCode のクリック位置 (x, y) に機器を入れ、配管を2本に分ける。
 * - 元の配管番号は始点側（node_a 側）に残し、終点側を新しい番号にする
 * - 実長が入っている配管は、図面上の長さの比で2本に分ける
 * - 隣の機器の「上流側機器番号」が分けた配管の向こう側を指していたら、新しい機器に付け替える
 */
export function insertOnPipe(d: DiagramData, sheetNo: string, pipeCode: string, x: number, y: number, opt: InsertOptions): InsertResult | string {
  const p = d.pipes.find((q) => q.code === pipeCode);
  if (!p) return `配管 ${pipeCode} がありません`;
  const code = opt.code.trim();
  if (!code) return "機器番号を入れてください";
  if (d.nodes.some((n) => n.code === code)) return `機器番号「${code}」はすでに使われています`;

  const path = pipePath(d, sheetNo, p);
  const { segment, point } = nearestOnPath(path, x, y);
  const via = viaOf(d, sheetNo, pipeCode);
  const firstVia = via.slice(0, segment);
  const secondVia = via.slice(segment);
  const firstLen = pathLength([path[0], ...firstVia, point]);
  const totalLen = pathLength(path);
  const ratio = totalLen ? firstLen / totalLen : 0.5;

  const a = d.nodes.find((n) => n.code === p.node_a);
  const b = d.nodes.find((n) => n.code === p.node_b);
  const fluid = p.fluid ?? (a?.fluid && a.fluid !== "fuel" ? a.fluid : b?.fluid && b.fluid !== "fuel" ? b.fluid : null);
  const node = makeNode(opt.kind, code, {
    label: opt.label,
    name: opt.name,
    normal: opt.normal,
    area: a?.area ?? b?.area ?? "",
    // 流れの向きが要る機器（逆止弁・ポンプ）は、とりあえず始点側を上流にする（あとで変更できる）
    dir_from: NEEDS_DIRECTION.includes(opt.kind) ? p.node_a : null,
    fluid: fluid ?? null,
    system: a?.system ?? b?.system ?? null,
  });

  const newPipeCode = suggestPipeCode(d);
  const split = (len: number | null, r: number) => (len === null ? null : Math.round(len * r * 100) / 100);
  const first: PipeData = { ...p, node_b: code, length_m: split(p.length_m, ratio) };
  const second: PipeData = { ...p, code: newPipeCode, node_a: code, length_m: split(p.length_m, 1 - ratio) };
  const pipes = d.pipes.flatMap((q) => (q.code === pipeCode ? [first, second] : [q]));

  // 上流側の付け替え（A—B の配管が A—新—B になったので、A を指していた B、B を指していた A は新しい機器を指す）
  const nodes = [
    ...d.nodes.map((n) => {
      if (n.code === p.node_b && n.dir_from === p.node_a) return { ...n, dir_from: code };
      if (n.code === p.node_a && n.dir_from === p.node_b) return { ...n, dir_from: code };
      return n;
    }),
    node,
  ];

  // 図面データ：この版のすべてのシートで、配管を分けた位置に機器を置く（このシート以外は配管の中点）
  let next: DiagramData = { ...d, nodes, pipes };
  d.sheets.forEach((s) => {
    if (s.sheet_no === sheetNo) {
      next = moveNode(next, s.sheet_no, code, Math.round(point[0]), Math.round(point[1]));
      next = setVia(next, s.sheet_no, pipeCode, firstVia);
      next = setVia(next, s.sheet_no, newPipeCode, secondVia);
      return;
    }
    const hasA = symbolOf(d, s.sheet_no, p.node_a);
    const hasB = symbolOf(d, s.sheet_no, p.node_b);
    if (!hasA || !hasB) return;
    const otherPath = pipePath(d, s.sheet_no, p);
    const mid = nearestOnPath(otherPath, (hasA.x + hasB.x) / 2, (hasA.y + hasB.y) / 2);
    const otherVia = viaOf(d, s.sheet_no, pipeCode);
    next = moveNode(next, s.sheet_no, code, Math.round(mid.point[0]), Math.round(mid.point[1]));
    next = setVia(next, s.sheet_no, pipeCode, otherVia.slice(0, mid.segment));
    next = setVia(next, s.sheet_no, newPipeCode, otherVia.slice(mid.segment));
  });
  return { data: next, nodeCode: code, newPipeCode };
}

// ───── 新しい機器の初期値 ─────

/** 流れの向き（上流側機器番号）が必須の種別 */
export const NEEDS_DIRECTION: NodeKind[] = ["check", "pump", "transferPump"];
/** 待機状態（開／閉）が必須の種別 */
export const NEEDS_NORMAL: NodeKind[] = ["valve", "drain", "gauge"];

const KIND_NAME: Record<NodeKind, string> = {
  junction: "分岐点",
  valve: "仕切弁",
  check: "逆止弁",
  tank: "タンク",
  pump: "払出ポンプ",
  transferPump: "移送ポンプ",
  strainer: "ストレーナー",
  filter: "フィルター",
  sampler: "サンプリング装置",
  psv: "安全弁",
  drain: "ドレン口",
  gauge: "圧力計取付口",
  source: "受入口",
  sink: "払出先",
  hydrant: "消火栓",
  monitor: "放水銃・泡モニター",
  sprinkler: "散水ヘッド",
  proportioner: "泡混合器",
  foamChamber: "タンク発泡装置",
};

/** 種別ごとの既定の名称 */
function defaultName(kind: NodeKind) {
  return kind === "junction" ? "分岐点" : `${KIND_NAME[kind]}（追加）`;
}

/** 種別ごとの新しい機器の行（属性は空欄・既定値。あとで右の欄で入れる） */
export function makeNode(kind: NodeKind, code: string, o: Partial<NodeData> = {}): NodeData {
  return {
    code,
    kind,
    label: o.label?.trim() || (kind === "junction" ? "" : code),
    name: o.name?.trim() || defaultName(kind),
    area: o.area ?? "",
    equipment_code: null,
    normal: NEEDS_NORMAL.includes(kind) ? o.normal ?? (kind === "valve" ? "open" : "close") : null,
    volume_l: null,
    drain_size_a: kind === "drain" ? 25 : null,
    gauge_mountable: kind === "gauge" ? true : null,
    service: null,
    fill_line: null,
    fill_source: null,
    drain_pump_lpm: null,
    drain_route: null,
    drain_target: null,
    drain_system: null,
    dir_from: o.dir_from ?? null,
    small: null,
    recovery: null,
    rated_flow_lpm: null,
    capacity_kl: kind === "tank" ? 1000 : null,
    set_pressure_mpa: kind === "psv" ? 1 : null,
    data_source: "エディタで追加",
    note: null,
    fluid: o.fluid ?? null,
    system: o.system ?? null,
  };
}

/** 追加できる機器の種別（図面の記号の種類すべて） */
export const ALL_KINDS: NodeKind[] = Object.keys(KIND_NAME) as NodeKind[];

/** 配管の途中に入れるのが普通の種別（それ以外は枝の先・単独で置く） */
export const INLINE_KINDS: NodeKind[] = ["valve", "check", "strainer", "filter", "sampler", "pump", "transferPump", "proportioner", "junction"];

/** 枝管の既定の呼び径（ドレン・圧力計・安全弁は細い管、それ以外は元の配管と同じ） */
function branchSize(kind: NodeKind, parentSize: number) {
  if (kind === "gauge") return 15;
  if (kind === "drain" || kind === "psv") return Math.min(25, parentSize);
  return parentSize;
}

/** 機器のつながっている配管 */
export function pipesOf(d: DiagramData, code: string) {
  return d.pipes.filter((p) => p.node_a === code || p.node_b === code);
}

/** 機器の属性で、まわりの機器から引き継ぐもの（区画・流体・系統） */
function inheritFrom(d: DiagramData, code: string | undefined): Partial<NodeData> {
  const n = code ? d.nodes.find((x) => x.code === code) : undefined;
  return { area: n?.area ?? "", fluid: n?.fluid ?? null, system: n?.system ?? null };
}

// ───── 機器を置く（つながりなし） ─────

export function addNode(d: DiagramData, sheetNo: string, kind: NodeKind, x: number, y: number, near?: string): { data: DiagramData; code: string } {
  const code = suggestNodeCode(d, kind);
  const node = makeNode(kind, code, inheritFrom(d, near));
  return { data: moveNode({ ...d, nodes: [...d.nodes, node] }, sheetNo, code, x, y), code };
}

// ───── 配管を引く ─────

export type PipeOptions = { sizeA?: number; via?: Point[] };

/** 機器 a と機器 b を新しい配管で結ぶ。呼び径は指定が無ければ a（無ければ b）につながる配管と同じ（どちらも無ければ 50A） */
export function connectNodes(d: DiagramData, sheetNo: string, a: string, b: string, o: PipeOptions = {}): { data: DiagramData; code: string } | string {
  if (a === b) return "同じ機器どうしは結べません";
  if (!d.nodes.some((n) => n.code === a) || !d.nodes.some((n) => n.code === b)) return "結ぶ機器が見つかりません";
  if (d.pipes.some((p) => (p.node_a === a && p.node_b === b) || (p.node_a === b && p.node_b === a))) return `${a} と ${b} はすでに配管でつながっています`;
  const near = pipesOf(d, a)[0] ?? pipesOf(d, b)[0];
  const size = o.sizeA ?? near?.size_a ?? 50;
  const code = suggestPipeCode(d);
  const pipe: PipeData = {
    code,
    line_no: near?.line_no ?? null,
    node_a: a,
    node_b: b,
    size_a: size,
    pipe_spec_id: near && near.size_a === size ? near.pipe_spec_id : null,
    length_m: null,
    length_source: null,
    note: null,
    fluid: near?.fluid ?? null,
  };
  return { data: setVia({ ...d, pipes: [...d.pipes, pipe] }, sheetNo, code, o.via ?? []), code };
}

/** 2点を直角に結ぶときの曲がり角（横 → 縦の順。縦横どちらかがそろっていれば曲がらない） */
export function elbow(a: Point, b: Point): Point[] {
  return Math.abs(a[0] - b[0]) < 1 || Math.abs(a[1] - b[1]) < 1 ? [] : [[b[0], a[1]]];
}

/** 配管の途中に分岐点を作る（配管の途中から枝を出す・配管を引く始点／終点にするとき） */
export function junctionOnPipe(d: DiagramData, sheetNo: string, pipeCode: string, x: number, y: number): InsertResult | string {
  return insertOnPipe(d, sheetNo, pipeCode, x, y, { kind: "junction", code: suggestNodeCode(d, "junction") });
}

/**
 * 既存の機器、または配管の途中（分岐点を作る）から枝を出し、その先に新しい機器を置く。
 * 枝の向きは、配管が横向きなら下、縦向きなら右（機器から出すときは下）。
 */
export function branchFrom(
  d: DiagramData,
  sheetNo: string,
  from: { type: "node"; id: string } | { type: "pipe"; id: string; x: number; y: number },
  kind: NodeKind,
  offset = 60
): { data: DiagramData; code: string; pipeCode: string } | string {
  let data = d;
  let origin: string;
  let dir: Point = [0, 1];
  let parentSize = 50;
  if (from.type === "pipe") {
    const p = d.pipes.find((q) => q.code === from.id);
    if (!p) return `配管 ${from.id} がありません`;
    parentSize = p.size_a;
    const path = pipePath(d, sheetNo, p);
    const { segment } = nearestOnPath(path, from.x, from.y);
    const [s0, s1] = [path[segment], path[segment + 1]];
    dir = Math.abs(s1[0] - s0[0]) >= Math.abs(s1[1] - s0[1]) ? [0, 1] : [1, 0];
    const j = junctionOnPipe(d, sheetNo, from.id, from.x, from.y);
    if (typeof j === "string") return j;
    data = j.data;
    origin = j.nodeCode;
  } else {
    origin = from.id;
    parentSize = pipesOf(d, from.id)[0]?.size_a ?? 50;
  }
  const o = symbolOf(data, sheetNo, origin);
  if (!o) return `機器 ${origin} の位置がこのシートにありません`;
  const added = addNode(data, sheetNo, kind, o.x + dir[0] * offset, o.y + dir[1] * offset, origin);
  // 逆止弁・ポンプは枝の元を上流にする
  const withDir = NEEDS_DIRECTION.includes(kind) ? updateNode(added.data, added.code, { dir_from: origin }) : added.data;
  const c = connectNodes(withDir, sheetNo, origin, added.code, { sizeA: branchSize(kind, parentSize) });
  if (typeof c === "string") return c;
  return { data: c.data, code: added.code, pipeCode: c.code };
}

// ───── 削除 ─────

/** 機器を消すと一緒に消える・変わるもの（確認の表示用） */
export function deleteImpact(d: DiagramData, code: string) {
  const pipes = pipesOf(d, code);
  const refs = d.nodes.filter(
    (n) => n.code !== code && (n.dir_from === code || n.drain_target === code || n.drain_system === code || n.drain_route?.includes(code))
  );
  return { pipes: pipes.map((p) => p.code), refs: refs.map((n) => n.code), canReconnect: pipes.length === 2 };
}

/**
 * 機器を消す。
 * - reconnect = true（つながる配管が2本のときだけ）：両側の配管を1本にまとめる（弁を撤去して配管はそのまま、など）。
 *   まとめた配管は1本目の配管の番号を使い、実長は両方入っていれば足し合わせる。
 * - reconnect = false：機器と、つながっている配管をすべて消す（設備ごと撤去）。
 * ほかの機器からの参照（上流側・抜取経路・抜取先）は外す（まとめたときの上流側は、向こう側の機器に付け替える）。
 */
export function deleteNode(d: DiagramData, code: string, reconnect: boolean): DiagramData | string {
  if (!d.nodes.some((n) => n.code === code)) return `機器 ${code} がありません`;
  const pipes = pipesOf(d, code);
  let next: DiagramData = d;

  if (reconnect) {
    if (pipes.length !== 2) return "つながる配管が2本の機器だけ、配管をつないだまま消せます";
    const [p1, p2] = pipes;
    const end1 = p1.node_a === code ? p1.node_b : p1.node_a;
    const end2 = p2.node_a === code ? p2.node_b : p2.node_a;
    if (end1 === end2) return "両側が同じ機器のため、配管をつなげません";
    if (d.pipes.some((p) => (p.node_a === end1 && p.node_b === end2) || (p.node_a === end2 && p.node_b === end1)))
      return `${end1} と ${end2} はすでに別の配管でつながっています`;
    const bothLen = p1.length_m !== null && p2.length_m !== null;
    const merged: PipeData = {
      ...p1,
      node_a: end1,
      node_b: end2,
      length_m: bothLen ? Math.round((p1.length_m! + p2.length_m!) * 100) / 100 : null,
      length_source: bothLen ? p1.length_source : null,
    };
    // シートごとの経由点：end1 → (p1 の経由点) → 消した機器の位置 → (p2 の経由点) → end2
    const geometries = d.sheets.flatMap((s) => {
      const sym = symbolOf(d, s.sheet_no, code);
      const v1 = viaOf(d, s.sheet_no, p1.code);
      const v2 = viaOf(d, s.sheet_no, p2.code);
      const along1 = p1.node_a === end1 ? v1 : [...v1].reverse();
      const along2 = p2.node_a === code ? v2 : [...v2].reverse();
      const points: Point[] = [...along1, ...(sym ? [[sym.x, sym.y] as Point] : []), ...along2];
      return points.length ? [{ pipe_code: p1.code, sheet_no: s.sheet_no, points }] : [];
    });
    next = {
      ...d,
      pipes: d.pipes.filter((p) => p.code !== p2.code).map((p) => (p.code === p1.code ? merged : p)),
      geometries: [...d.geometries.filter((g) => g.pipe_code !== p1.code && g.pipe_code !== p2.code), ...geometries],
      nodes: d.nodes.map((n) =>
        n.dir_from === code && (n.code === end1 || n.code === end2) ? { ...n, dir_from: n.code === end1 ? end2 : end1 } : n
      ),
    };
  } else {
    const gone = new Set(pipes.map((p) => p.code));
    next = { ...d, pipes: d.pipes.filter((p) => !gone.has(p.code)), geometries: d.geometries.filter((g) => !gone.has(g.pipe_code)) };
  }

  const clear = (v: string | null) => (v === code ? null : v);
  // 配管の向こう側の分岐点が取り残されたら一緒に消す
  return pruneOrphanJunctions({
    ...next,
    nodes: next.nodes
      .filter((n) => n.code !== code)
      .map((n) => ({
        ...n,
        dir_from: clear(n.dir_from),
        drain_target: clear(n.drain_target),
        drain_system: clear(n.drain_system),
        drain_route: n.drain_route ? n.drain_route.filter((v) => v !== code) : n.drain_route,
      })),
    symbols: next.symbols.filter((s) => s.node_code !== code),
  });
}

/** どの配管にもつながっていない分岐点（配管の削除などで取り残されたもの） */
export function orphanJunctions(d: DiagramData): string[] {
  const used = new Set(d.pipes.flatMap((p) => [p.node_a, p.node_b]));
  return d.nodes.filter((n) => n.kind === "junction" && !used.has(n.code)).map((n) => n.code);
}

/** 取り残された分岐点を消す（分岐点は配管のつなぎ目なので、配管が無ければ意味がない） */
export function pruneOrphanJunctions(d: DiagramData): DiagramData {
  const gone = new Set(orphanJunctions(d));
  if (!gone.size) return d;
  return { ...d, nodes: d.nodes.filter((n) => !gone.has(n.code)), symbols: d.symbols.filter((s) => !gone.has(s.node_code)) };
}

/** 配管を消す（両端の機器は残る。両端の分岐点が取り残されたら一緒に消す。ほかの機器がつながらなくなれば入力チェックでエラーになる） */
export function deletePipe(d: DiagramData, code: string): DiagramData {
  return pruneOrphanJunctions({ ...d, pipes: d.pipes.filter((p) => p.code !== code), geometries: d.geometries.filter((g) => g.pipe_code !== code) });
}

// ───── 属性の変更 ─────

export function updateNode(d: DiagramData, code: string, patch: Partial<NodeData>): DiagramData {
  return { ...d, nodes: d.nodes.map((n) => (n.code === code ? { ...n, ...patch, code: n.code } : n)) };
}

export function updatePipe(d: DiagramData, code: string, patch: Partial<PipeData>): DiagramData {
  return { ...d, pipes: d.pipes.map((p) => (p.code === code ? { ...p, ...patch, code: p.code, node_a: p.node_a, node_b: p.node_b } : p)) };
}

/**
 * 機器番号を変える（このエディタで追加した機器だけに使う。既存の機器の番号は過去のチェックリストとのつながりのため変えない）。
 * 配管の両端・位置・上流側・抜取経路などの参照もいっしょに変える。
 */
export function renameNode(d: DiagramData, from: string, to: string): DiagramData | string {
  const code = to.trim();
  if (!code) return "機器番号を入れてください";
  if (code === from) return d;
  if (d.nodes.some((n) => n.code === code)) return `機器番号「${code}」はすでに使われています`;
  const r = (v: string | null) => (v === from ? code : v);
  return {
    ...d,
    nodes: d.nodes.map((n) => ({
      ...n,
      code: n.code === from ? code : n.code,
      label: n.code === from && n.label === from ? code : n.label,
      dir_from: r(n.dir_from),
      drain_target: r(n.drain_target),
      drain_system: r(n.drain_system),
      drain_route: n.drain_route ? n.drain_route.map((v) => (v === from ? code : v)) : n.drain_route,
    })),
    pipes: d.pipes.map((p) => ({ ...p, node_a: p.node_a === from ? code : p.node_a, node_b: p.node_b === from ? code : p.node_b })),
    symbols: d.symbols.map((s) => (s.node_code === from ? { ...s, node_code: code } : s)),
  };
}

// ───── 変更点のまとめ（保存前の確認用） ─────

export type DiagramDiff = {
  addedNodes: string[];
  addedPipes: string[];
  removedNodes: string[];
  removedPipes: string[];
  changedNodes: string[];
  changedPipes: string[];
  moved: number;
  /** 追加・変更・削除した区画枠 */
  areas: number;
};

export function diffDiagram(before: DiagramData, after: DiagramData): DiagramDiff {
  const bn = new Map(before.nodes.map((n) => [n.code, JSON.stringify(n)]));
  const bp = new Map(before.pipes.map((p) => [p.code, JSON.stringify(p)]));
  const bs = new Map(before.symbols.map((s) => [`${s.sheet_no}|${s.node_code}`, `${s.x},${s.y}`]));
  const bg = new Map(before.geometries.map((g) => [`${g.sheet_no}|${g.pipe_code}`, JSON.stringify(g.points)]));
  const addedNodes = after.nodes.filter((n) => !bn.has(n.code)).map((n) => n.code);
  const addedPipes = after.pipes.filter((p) => !bp.has(p.code)).map((p) => p.code);
  const an = new Set(after.nodes.map((n) => n.code));
  const ap = new Set(after.pipes.map((p) => p.code));
  const removedNodes = before.nodes.filter((n) => !an.has(n.code)).map((n) => n.code);
  const removedPipes = before.pipes.filter((p) => !ap.has(p.code)).map((p) => p.code);
  const changedNodes = after.nodes.filter((n) => bn.has(n.code) && bn.get(n.code) !== JSON.stringify(n)).map((n) => n.code);
  const changedPipes = after.pipes.filter((p) => bp.has(p.code) && bp.get(p.code) !== JSON.stringify(p)).map((p) => p.code);
  const moved =
    after.symbols.filter((s) => an.has(s.node_code) && bs.has(`${s.sheet_no}|${s.node_code}`) && bs.get(`${s.sheet_no}|${s.node_code}`) !== `${s.x},${s.y}`).length +
    after.geometries.filter((g) => bg.get(`${g.sheet_no}|${g.pipe_code}`) !== JSON.stringify(g.points)).length +
    before.geometries.filter((g) => ap.has(g.pipe_code) && !after.geometries.some((h) => h.sheet_no === g.sheet_no && h.pipe_code === g.pipe_code)).length;
  const ba = new Map(before.areas.map((a) => [a.name, JSON.stringify(a)]));
  const aa = new Map(after.areas.map((a) => [a.name, JSON.stringify(a)]));
  const areas = [...new Set([...ba.keys(), ...aa.keys()])].filter((k) => ba.get(k) !== aa.get(k)).length;
  return { addedNodes, addedPipes, removedNodes, removedPipes, changedNodes, changedPipes, moved, areas };
}

export function isEmptyDiff(x: DiagramDiff) {
  return !x.areas && !x.addedNodes.length && !x.addedPipes.length && !x.removedNodes.length && !x.removedPipes.length && !x.changedNodes.length && !x.changedPipes.length && !x.moved;
}

// ───── 区画枠 ─────

export type Box = { x: number; y: number; w: number; h: number };

/** 枠の名前が機器の区画名に当たるか（「第1ヤード（T-101〜106）」の枠は区画「第1ヤード」の機器の枠） */
export function areaMatches(frameName: string, nodeArea: string) {
  return frameName === nodeArea || frameName.startsWith(`${nodeArea}（`);
}

/** このシートに枠がある区画 */
export function framesOf(d: DiagramData, sheetNo: string) {
  return d.areas.filter((a) => a.sheet_no === sheetNo && a.x !== null && a.y !== null && a.w !== null && a.h !== null);
}

/** 機器の区画欄にあるのに、このシートに枠が無い区画（機器の件数つき） */
export function unframedAreas(d: DiagramData, sheetNo: string): { name: string; count: number }[] {
  const frames = framesOf(d, sheetNo);
  const m = new Map<string, number>();
  d.nodes.forEach((n) => {
    if (!n.area || frames.some((a) => areaMatches(a.name, n.area))) return;
    m.set(n.area, (m.get(n.area) ?? 0) + 1);
  });
  return [...m.entries()].map(([name, count]) => ({ name, count }));
}

/** 区画の機器がすべて入る枠（余白つき）。位置のある機器が無ければ null */
export function fitBox(d: DiagramData, sheetNo: string, area: string, pad = 40): Box | null {
  const codes = new Set(d.nodes.filter((n) => areaMatches(area, n.area)).map((n) => n.code));
  const pts = d.symbols.filter((s) => s.sheet_no === sheetNo && codes.has(s.node_code));
  if (!pts.length) return null;
  const xs = pts.map((s) => s.x);
  const ys = pts.map((s) => s.y);
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
}

/** 区画枠の位置・大きさを決める（枠が無ければ作る） */
export function setAreaBox(d: DiagramData, sheetNo: string, name: string, b: Box): DiagramData {
  const box = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) };
  const exists = d.areas.some((a) => a.name === name);
  return {
    ...d,
    areas: exists ? d.areas.map((a) => (a.name === name ? { ...a, sheet_no: sheetNo, ...box } : a)) : [...d.areas, { name, sheet_no: sheetNo, ...box }],
  };
}

/** 区画枠を消す（機器の区画欄はそのまま。枠が描かれなくなるだけ） */
export function deleteArea(d: DiagramData, name: string): DiagramData {
  return { ...d, areas: d.areas.filter((a) => a.name !== name) };
}

/**
 * 区画枠の名前を変える。alsoNodes のときは、区画欄がその名前の機器も同じ名前に変える
 * （区画欄は運用停止範囲・消火試験の「同じヤード」の判定にも使うため、変えるかどうかは選べるようにする）。
 */
export function renameArea(d: DiagramData, from: string, to: string, alsoNodes: boolean): DiagramData | string {
  const name = to.trim();
  if (!name) return "区画名を入れてください";
  if (name === from) return d;
  if (d.areas.some((a) => a.name === name)) return `区画「${name}」はすでにあります`;
  return {
    ...d,
    areas: d.areas.map((a) => (a.name === from ? { ...a, name } : a)),
    nodes: alsoNodes ? d.nodes.map((n) => (n.area === from ? { ...n, area: name } : n)) : d.nodes,
  };
}
