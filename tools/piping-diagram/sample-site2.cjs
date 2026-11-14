// 第2拠点のサンプル（燃料の小さな系統＋消火用水・泡の系統）を、系統図の登録シート（Excel）として書き出す。
// ④ 系統図データ管理 から取り込むと、拠点「virtual-site-2」の第1版（下書き）になる。
// 使い方（プロジェクト直下で）:
//   npx tsc --outDir .tmp-piping --module commonjs --target es2020 --skipLibCheck --esModuleInterop src/lib/piping/diagramData.ts src/lib/piping/diagramDb.ts src/lib/piping/types.ts
//   node tools/piping-diagram/sample-site2.cjs .tmp-piping/diagramData.js 系統図_第2拠点サンプル.xlsx
const path = require("path");
const XLSX = require("xlsx");

const [, , compiled, out] = process.argv;
const { diagramToWorkbook, validateDiagram } = require(path.resolve(compiled));

const nodes = [];
const symbols = [];
const pipes = [];
const geometries = [];
let seq = 0;

const blank = {
  label: "", equipment_code: null, normal: null, volume_l: null, drain_size_a: null, gauge_mountable: null,
  service: null, fill_line: null, fill_source: null, drain_pump_lpm: null, drain_route: null, drain_target: null,
  drain_system: null, dir_from: null, small: null, recovery: null, rated_flow_lpm: null, capacity_kl: null,
  set_pressure_mpa: null, data_source: "サンプル（仮の値）", note: null, fluid: null, system: null,
};
function node(code, kind, name, area, x, y, extra = {}) {
  const label = kind === "junction" ? "" : extra.label ?? code;
  nodes.push({ ...blank, code, kind, name, area, label, ...extra, label });
  symbols.push({ node_code: code, sheet_no: "S1", x, y, rotation: 0, show_label: true });
  return code;
}
const J = (code, area, x, y, extra = {}) => node(code, "junction", "分岐点", area, x, y, extra);
const V = (code, name, area, x, y, normal, extra = {}) => node(code, "valve", name, area, x, y, { normal, ...extra });
function pipe(a, b, size, via = null, extra = {}) {
  const code = `P2-${String(++seq).padStart(3, "0")}`;
  pipes.push({ code, line_no: extra.line_no ?? null, node_a: a, node_b: b, size_a: size, pipe_spec_id: `${size}A-Sch40`, length_m: null, length_source: "drawing_estimate", note: null, fluid: extra.fluid ?? null });
  if (via) geometries.push({ pipe_code: code, sheet_no: "S1", points: via });
  return code;
}
const chain = (size, ...ids) => ids.slice(1).forEach((id, i) => pipe(ids[i], id, size));

// ───── 燃料：受入設備 → タンクヤード（2基）→ 払出ポンプ → 払出先 ─────
const fuel = { system: "燃料", fluid: "fuel" };
const R = "受入設備", Y = "タンクヤード", I = "払出ポンプ";
node("SRC-21", "source", "受入口（第2拠点）", R, 60, 180, { ...fuel, label: "受入口" });
V("V-21R01", "受入元弁", R, 110, 180, "close", fuel);
node("STR-21R", "strainer", "受入ストレーナー", R, 190, 180, { ...fuel, volume_l: 80 });
node("D-21R", "drain", "受入ストレーナー ドレン", R, 190, 230, { ...fuel, normal: "close", drain_size_a: 25, gauge_mountable: true });
V("V-21R02", "受入出口弁", R, 260, 180, "open", fuel);
J("J-21RH", R, 330, 320, fuel);
chain(150, "SRC-21", "V-21R01", "STR-21R", "V-21R02");
pipe("STR-21R", "D-21R", 25);
pipe("V-21R02", "J-21RH", 150, [[330, 180]]);

// 受入ヘッダー（y=320）と払出ヘッダー（y=380）
J("J-21HD", Y, 440, 320, fuel);
node("D-21H", "drain", "受入ヘッダー ドレン", Y, 440, 355, { ...fuel, normal: "close", drain_size_a: 40, gauge_mountable: true });
pipe("J-21HD", "D-21H", 40);
V("V-21H1", "受入ヘッダー 区分弁", Y, 690, 320, "open", fuel);
J("J-21IHD", Y, 730, 380, fuel);
node("D-21IH", "drain", "払出ヘッダー ドレン", Y, 730, 415, { ...fuel, normal: "close", drain_size_a: 40, gauge_mountable: true });
pipe("J-21IHD", "D-21IH", 40);

const tankR = [];
const tankI = [];
[["301", 560], ["302", 820]].forEach(([no, x]) => {
  const t = node(`T-${no}`, "tank", `T-${no} 貯蔵タンク`, Y, x, 120, { ...fuel, capacity_kl: 3000 });
  // 受入：タンク側に逆止弁（タンクへ流れる向き）
  const cvR = node(`CV-${no}R`, "check", `T-${no} 受入逆止弁`, Y, x - 20, 175, { ...fuel, label: `CV-${no}R`, dir_from: `J-${no}RT` });
  J(`J-${no}RT`, Y, x - 20, 205, fuel);
  V(`V-${no}R`, `T-${no} 受入弁`, Y, x - 20, 250, "close", fuel);
  const hr = J(`J-${no}R`, Y, x - 20, 320, fuel);
  pipe(t, cvR, 150, [[x - 20, 140]]);
  chain(150, cvR, `J-${no}RT`, `V-${no}R`, hr);
  // 払出：ヘッダー側に逆止弁（タンクから出る向き）
  V(`V-${no}I`, `T-${no} 払出弁`, Y, x + 20, 250, "close", fuel);
  const cvI = node(`CV-${no}I`, "check", `T-${no} 払出逆止弁`, Y, x + 20, 300, { ...fuel, dir_from: `V-${no}I` });
  const hi = J(`J-${no}I`, Y, x + 20, 380, fuel);
  pipe(t, `V-${no}I`, 150, [[x + 20, 140]]);
  chain(150, `V-${no}I`, cvI, hi);
  tankR.push(hr);
  tankI.push(hi);
});
chain(150, "J-21RH", "J-21HD", tankR[0], "V-21H1", tankR[1]);
J("J-21IX", Y, 960, 380, fuel);
chain(150, tankI[0], "J-21IHD", tankI[1], "J-21IX");

// 払出ポンプ
V("V-P31S", "払出P-31 吸込弁", I, 1080, 380, "open", fuel);
node("STR-P31", "strainer", "払出P-31 ストレーナー", I, 1130, 380, { ...fuel, volume_l: 100 });
node("D-P31S", "drain", "払出P-31 ストレーナードレン", I, 1130, 425, { ...fuel, normal: "close", drain_size_a: 25, gauge_mountable: true });
node("P-31", "pump", "払出ポンプ P-31", I, 1190, 380, { ...fuel, volume_l: 40, rated_flow_lpm: 1500, dir_from: "STR-P31" });
node("CV-P31", "check", "払出P-31 逆止弁", I, 1240, 380, { ...fuel, dir_from: "P-31" });
J("J-P31D", I, 1270, 380, fuel);
node("D-P31D", "drain", "払出P-31 吐出側ドレン", I, 1270, 425, { ...fuel, normal: "close", drain_size_a: 25, gauge_mountable: true });
V("V-P31D", "払出P-31 吐出弁", I, 1310, 380, "open", fuel);
V("V-H21", "払出先 送油弁", I, 1420, 380, "close", fuel);
node("HYD-21", "sink", "払出先（ハイドラント）", I, 1500, 380, { ...fuel, label: "払出先" });
pipe("J-21IX", "V-P31S", 150);
chain(100, "V-P31S", "STR-P31", "P-31", "CV-P31", "J-P31D", "V-P31D");
pipe("STR-P31", "D-P31S", 25);
pipe("J-P31D", "D-P31D", 25);
chain(150, "V-P31D", "V-H21", "HYD-21");

// ───── 消火：水槽 → 消火ポンプ（主・補助）→ 消火主管 → 消火栓、泡原液タンク → 泡混合器 → 放水銃・散水ヘッド ─────
const water = { system: "消火", fluid: "water" };
const foam = { system: "消火", fluid: "foam" };
const sol = { system: "消火", fluid: "foamSolution" };
const FP = "消火ポンプ室", FM = "消火配管";
node("WT-1", "tank", "消火用水槽", FP, 110, 560, { ...water, capacity_kl: 500, small: true });
V("V-WT1", "消火用水槽 出口弁", FP, 200, 620, "open", water);
J("J-FS", FP, 260, 620, water);
J("J-FS2", FP, 260, 720, water);
pipe("WT-1", "V-WT1", 200, [[110, 620]]);
chain(200, "V-WT1", "J-FS", "J-FS2");
// 主ポンプ（y=620）と補助ポンプ（y=720）
[["FP-1", "消火ポンプ（主）", 620, 200, 3000], ["JP-1", "補助加圧ポンプ", 720, 50, 100]].forEach(([code, name, y, size, flow]) => {
  const s = V(`V-${code.replace("-", "")}S`, `${name} 吸込弁`, FP, 320, y, "open", water);
  node(code, "pump", name, FP, 380, y, { ...water, rated_flow_lpm: flow, volume_l: 30, dir_from: s });
  node(`CV-${code.replace("-", "")}`, "check", `${name} 逆止弁`, FP, 440, y, { ...water, dir_from: code });
  V(`V-${code.replace("-", "")}D`, `${name} 吐出弁`, FP, 500, y, "open", water);
  pipe(y === 620 ? "J-FS" : "J-FS2", s, size);
  chain(size, s, code, `CV-${code.replace("-", "")}`, `V-${code.replace("-", "")}D`);
});
J("J-FD", FP, 560, 620, water);
J("J-FD2", FP, 560, 720, water);
pipe("V-FP1D", "J-FD", 200);
pipe("V-JP1D", "J-FD2", 50);
pipe("J-FD2", "J-FD", 50);
// 締切運転の安全弁（吐出 → 水槽へ戻す）
node("PSV-FP", "psv", "消火ポンプ吐出 安全弁（→水槽）", FP, 560, 540, { ...water, set_pressure_mpa: 1.2, dir_from: "J-FD" });
pipe("J-FD", "PSV-FP", 50);
pipe("PSV-FP", "WT-1", 50, [[560, 500], [110, 500]]);
J("J-FDD", FP, 600, 620, water);
node("D-FD", "drain", "消火ポンプ吐出 ドレン", FP, 600, 660, { ...water, normal: "close", drain_size_a: 40, gauge_mountable: true });
pipe("J-FD", "J-FDD", 200);
pipe("J-FDD", "D-FD", 40);

// 消火主管と消火栓
V("V-FM1", "消火主管 元弁", FM, 700, 620, "open", water);
J("J-FM", FM, 780, 620, water);
pipe("J-FDD", "V-FM1", 200);
pipe("V-FM1", "J-FM", 200);
let prev = "J-FM";
[["1", 900], ["2", 1040]].forEach(([k, x]) => {
  const j = J(`J-HY${k}`, FM, x, 620, water);
  V(`V-HY${k}`, `消火栓${k} 開閉弁`, FM, x, 570, "close", water);
  node(`HY-${k}`, "hydrant", `消火栓${k}`, FM, x, 525, water);
  pipe(prev, j, 150);
  chain(80, j, `V-HY${k}`, `HY-${k}`);
  prev = j;
});
J("J-FME", FM, 1200, 620, water);
node("D-FME", "drain", "消火主管 末端ドレン", FM, 1200, 660, { ...water, normal: "close", drain_size_a: 50, gauge_mountable: true });
pipe(prev, "J-FME", 150);
pipe("J-FME", "D-FME", 50);

// 泡：泡原液タンク → 泡混合器（消火主管から分岐）→ 放水銃・散水ヘッド
V("V-FM2", "泡混合器 入口弁", FM, 820, 700, "close", water);
node("FT-1", "tank", "泡原液タンク", FM, 700, 800, { ...foam, capacity_kl: 10, small: true });
V("V-FT1", "泡原液タンク 出口弁", FM, 790, 800, "close", foam);
node("PR-1", "proportioner", "泡混合器", FM, 880, 760, { ...sol, volume_l: 20 });
node("D-PR1", "drain", "泡混合器 ドレン", FM, 840, 760, { ...sol, normal: "close", drain_size_a: 25, gauge_mountable: true });
pipe("PR-1", "D-PR1", 25);
V("V-FS1", "泡水溶液 送水弁", FM, 960, 760, "close", sol);
J("J-FSOL", FM, 1060, 760, sol);
V("V-MO1", "泡モニター 開閉弁", FM, 1140, 760, "close", sol);
node("MO-1", "monitor", "泡モニター", FM, 1220, 760, sol);
V("V-SP1", "散水ヘッド 開閉弁", FM, 1060, 820, "close", sol);
node("SP-1", "sprinkler", "散水ヘッド", FM, 1060, 860, sol);
pipe("J-FM", "V-FM2", 100, [[780, 700]]);
pipe("V-FM2", "PR-1", 100, [[880, 700]]);
pipe("FT-1", "V-FT1", 50, null, { fluid: "foam" });
pipe("V-FT1", "PR-1", 50, [[880, 800]], { fluid: "foam" });
chain(100, "PR-1", "V-FS1", "J-FSOL", "V-MO1", "MO-1");
chain(80, "J-FSOL", "V-SP1", "SP-1");

const sch40 = [[25, 34.0, 26.6], [40, 48.6, 40.9], [50, 60.5, 52.7], [80, 89.1, 78.1], [100, 114.3, 102.3], [150, 165.2, 154.1], [200, 216.3, 202.7], [250, 267.4, 254.5], [300, 318.5, 304.8]];
const data = {
  facility_id: "virtual-site-2",
  facility_name: "第2拠点（仮想・燃料＋消火）",
  note: "サンプル：燃料の受入・貯蔵・払出と、消火用水・泡の系統",
  sheets: [{ sheet_no: "S1", title: "全体系統図", width: 1600, height: 900, meters_per_unit: 0.2, source_doc_no: null }],
  areas: [
    { name: R, sheet_no: "S1", x: 30, y: 140, w: 360, h: 210 },
    { name: Y, sheet_no: "S1", x: 410, y: 60, w: 600, h: 380 },
    { name: I, sheet_no: "S1", x: 1040, y: 330, w: 520, h: 120 },
    { name: FP, sheet_no: "S1", x: 30, y: 480, w: 610, h: 290 },
    { name: FM, sheet_no: "S1", x: 660, y: 480, w: 620, h: 410 },
  ],
  nodes,
  symbols,
  pipes,
  geometries,
  specs: sch40.map(([s, od, id]) => ({ id: `${s}A-Sch40`, size_a: s, schedule: "Sch40", outer_diameter_mm: od, inner_diameter_mm: id, material: "STPG370" })),
};

const issues = validateDiagram(data);
issues.forEach((i) => console.log(`${i.severity}: ${i.message}`));
XLSX.writeFile(diagramToWorkbook(data), out);
console.log(`nodes ${nodes.length}, pipes ${pipes.length} -> ${out}`);
