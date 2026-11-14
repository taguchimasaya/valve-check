// 第2拠点のサンプル「臨海石油基地（仮想）」を、系統図の登録シート（Excel）として書き出す。
//   燃料：タンカー → 桟橋（ローディングアーム・緊急遮断弁）→ 陸側受入設備 → 第1・第2タンクヤード（各4基）→ 出荷ポンプ → ローリー出荷・空港向けパイプライン
//   消火：海水取水口・消火用水槽 → 消火ポンプ（主・予備・補助）→ 消火用水主管 → タンクヤード周囲の消火栓ループ（水・泡）、
//         冷却散水ヘッダー → 1タンク2系統（シリンダー弁 → 手動弁 → 冷却散水設備）
//         泡原液タンク → 泡原液ポンプ → 泡混合器 → 泡水溶液主管 → 発泡装置ヘッダー → 1タンク2系統（シリンダー弁 → 手動弁 → タンク発泡装置）、
//         泡消火栓、桟橋泡モニター
// ④ 系統図データ管理 から取り込むと、拠点「virtual-site-2」の新しい版（下書き）になる。
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
// 図面全体を下へずらす量（タンクヤード上辺の消火栓ループの場所をあける）
const OY = 200;

const blank = {
  label: "", equipment_code: null, normal: null, volume_l: null, drain_size_a: null, gauge_mountable: null,
  service: null, fill_line: null, fill_source: null, drain_pump_lpm: null, drain_route: null, drain_target: null,
  drain_system: null, dir_from: null, small: null, recovery: null, rated_flow_lpm: null, capacity_kl: null,
  set_pressure_mpa: null, data_source: "サンプル（仮の値）", note: null, fluid: null, system: null,
};
function node(code, kind, name, area, x, y, extra = {}) {
  const label = kind === "junction" ? "" : extra.label ?? code;
  nodes.push({ ...blank, code, kind, name, area, ...extra, label });
  symbols.push({ node_code: code, sheet_no: "S1", x, y: y + OY, rotation: 0, show_label: true });
  return code;
}
const J = (code, area, x, y, extra) => node(code, "junction", "分岐点", area, x, y, extra);
const V = (code, name, area, x, y, normal, extra) => node(code, "valve", name, area, x, y, { normal, ...extra });
const D = (code, name, area, x, y, size, extra) =>
  node(code, "drain", name, area, x, y, { normal: "close", drain_size_a: size, gauge_mountable: true, ...extra });
function pipe(a, b, size, via = null, extra = {}) {
  const code = `P2-${String(++seq).padStart(3, "0")}`;
  pipes.push({ code, line_no: extra.line_no ?? null, node_a: a, node_b: b, size_a: size, pipe_spec_id: `${size}A-Sch40`, length_m: null, length_source: "drawing_estimate", note: null, fluid: extra.fluid ?? null });
  if (via) geometries.push({ pipe_code: code, sheet_no: "S1", points: via.map(([x, y]) => [x, y + OY]) });
  return code;
}
const chain = (size, ...ids) => ids.slice(1).forEach((id, i) => pipe(ids[i], id, size));

const fuel = { system: "燃料", fluid: "fuel" };
const water = { system: "消火", fluid: "water" };
const foam = { system: "消火", fluid: "foam" };
const sol = { system: "消火", fluid: "foamSolution" };
const JT = "桟橋", RC = "受入設備（陸側）", YD = "第1タンクヤード", YD2 = "第2タンクヤード", SH = "出荷設備", FP = "消火ポンプ室", FM = "消火配管";

// ═════ 燃料 ═════
// 桟橋：タンカーからローディングアーム2基で荷揚げ → 桟橋ヘッダー → 緊急遮断弁 → 桟橋配管
[["1", 160], ["2", 300]].forEach(([k, y]) => {
  node(`LA-${k}`, "source", `No.${k} ローディングアーム（タンカー側）`, JT, 75, y, { ...fuel, label: `LA-${k}（船）` });
  V(`V-LA${k}`, `No.${k} ローディングアーム 元弁`, JT, 170, y, "close", fuel);
  J(`J-LA${k}`, JT, 300, y, fuel);
  chain(250, `LA-${k}`, `V-LA${k}`, `J-LA${k}`);
});
J("J-JH", JT, 300, 230, fuel);
pipe("J-LA1", "J-JH", 250);
pipe("J-LA2", "J-JH", 250);
V("V-ESD", "桟橋 緊急遮断弁（ESD）", JT, 370, 230, "open", fuel);
J("J-JD", JT, 440, 230, fuel);
D("D-JD", "桟橋配管 低部ドレン（→桟橋スロップ）", JT, 440, 270, 50, fuel);
pipe("J-JH", "V-ESD", 300);
pipe("V-ESD", "J-JD", 300);
pipe("J-JD", "D-JD", 50);

// 陸側受入設備：元弁 → ストレーナー → 受入弁 → 受入ヘッダー
V("V-JS1", "桟橋配管 陸側元弁", RC, 600, 230, "open", fuel);
node("STR-JR", "strainer", "受入ストレーナー", RC, 680, 230, { ...fuel, volume_l: 400 });
D("D-JR", "受入ストレーナー ドレン", RC, 680, 275, 50, fuel);
V("V-JS2", "受入ストレーナー 出口弁", RC, 760, 230, "open", fuel);
J("J-RH", RC, 840, 330, fuel);
pipe("J-JD", "V-JS1", 300);
J("J-RY", RC, 720, 230, fuel);
chain(300, "V-JS1", "STR-JR", "J-RY", "V-JS2");
pipe("STR-JR", "D-JR", 50);
pipe("V-JS2", "J-RH", 300, [[840, 230]]);

// タンクヤード：タンク4基（受入ヘッダー y=330、出荷ヘッダー y=400）
const TANKS = [["401", 1000], ["402", 1200], ["403", 1400], ["404", 1600]];
const rJ = [];
const iJ = [];
TANKS.forEach(([no, x]) => {
  node(`T-${no}`, "tank", `T-${no} 貯蔵タンク（浮き屋根）`, YD, x, 120, { ...fuel, capacity_kl: 10000 });
  // 受入：タンク側に逆止弁（タンクへ流れる向き）
  node(`CV-${no}R`, "check", `T-${no} 受入逆止弁`, YD, x - 20, 180, { ...fuel, dir_from: `J-${no}RT` });
  J(`J-${no}RT`, YD, x - 20, 210, fuel);
  V(`V-${no}R`, `T-${no} 受入弁`, YD, x - 20, 260, "close", fuel);
  J(`J-${no}R`, YD, x - 20, 330, fuel);
  pipe(`T-${no}`, `CV-${no}R`, 300, [[x - 20, 140]]);
  chain(300, `CV-${no}R`, `J-${no}RT`, `V-${no}R`, `J-${no}R`);
  // 出荷：ヘッダー側に逆止弁（タンクから出る向き）
  V(`V-${no}I`, `T-${no} 出荷弁`, YD, x + 20, 260, "close", fuel);
  node(`CV-${no}I`, "check", `T-${no} 出荷逆止弁`, YD, x + 20, 300, { ...fuel, dir_from: `V-${no}I` });
  J(`J-${no}I`, YD, x + 20, 400, fuel);
  pipe(`T-${no}`, `V-${no}I`, 250, [[x + 20, 140]]);
  chain(250, `V-${no}I`, `CV-${no}I`, `J-${no}I`);
  rJ.push(`J-${no}R`);
  iJ.push(`J-${no}I`);
});
V("V-RH1", "受入ヘッダー 区分弁（T-402／T-403間）", YD, 1300, 330, "open", fuel);
J("J-RHE", YD, 1680, 330, fuel);
D("D-RH", "受入ヘッダー 末端ドレン", YD, 1680, 370, 50, fuel);
chain(300, "J-RH", rJ[0], rJ[1], "V-RH1", rJ[2], rJ[3], "J-RHE");
pipe("J-RHE", "D-RH", 50);
J("J-IHS", YD, 940, 400, fuel);
D("D-IH", "出荷ヘッダー 始端ドレン", YD, 940, 440, 50, fuel);
pipe("J-IHS", "D-IH", 50);
J("J-IHE", YD, 1700, 400, fuel);
chain(250, "J-IHS", iJ[0], iJ[1], iJ[2], iJ[3], "J-IHE");

// 出荷設備：出荷ポンプ2台 → ローリー出荷場2レーン・空港向けパイプライン
J("J-SP", SH, 1780, 400, fuel);
pipe("J-IHE", "J-SP", 250);
const disc = [];
[["41", 460], ["42", 540]].forEach(([k, y]) => {
  const js = J(`J-SP${k}`, SH, 1780, y, fuel);
  V(`V-P${k}S`, `出荷ポンプ P-${k} 吸込弁`, SH, 1830, y, "open", fuel);
  node(`STR-P${k}`, "strainer", `出荷ポンプ P-${k} ストレーナー`, SH, 1880, y, { ...fuel, volume_l: 120 });
  D(`D-P${k}S`, `出荷ポンプ P-${k} ストレーナードレン`, SH, 1880, y + 35, 25, fuel);
  node(`P-${k}`, "pump", `出荷ポンプ P-${k}`, SH, 1940, y, { ...fuel, volume_l: 50, rated_flow_lpm: 2000, dir_from: `STR-P${k}` });
  node(`CV-P${k}`, "check", `出荷ポンプ P-${k} 逆止弁`, SH, 1990, y, { ...fuel, dir_from: `P-${k}` });
  J(`J-P${k}D`, SH, 2020, y, fuel);
  D(`D-P${k}D`, `出荷ポンプ P-${k} 吐出側ドレン`, SH, 2020, y + 35, 25, fuel);
  V(`V-P${k}D`, `出荷ポンプ P-${k} 吐出弁`, SH, 2060, y, "open", fuel);
  const jd = J(`J-SD${k}`, SH, 2120, y, fuel);
  chain(150, `V-P${k}S`, `STR-P${k}`, `P-${k}`, `CV-P${k}`, `J-P${k}D`, `V-P${k}D`, jd);
  pipe(`STR-P${k}`, `D-P${k}S`, 25);
  pipe(`J-P${k}D`, `D-P${k}D`, 25);
  disc.push([js, jd]);
});
pipe("J-SP", disc[0][0], 250);
pipe(disc[0][0], disc[1][0], 250);
pipe(`V-P41S`, disc[0][0], 150);
pipe(`V-P42S`, disc[1][0], 150);
J("J-SD", SH, 2120, 400, fuel);
pipe("J-SD", disc[0][1], 200);
pipe(disc[0][1], disc[1][1], 200);
// ローリー出荷場
V("V-LR", "ローリー出荷 元弁", SH, 2190, 400, "close", fuel);
J("J-LR", SH, 2250, 400, fuel);
pipe("J-SD", "V-LR", 150);
pipe("V-LR", "J-LR", 150);
[["1", 340], ["2", 460]].forEach(([k, y]) => {
  V(`V-LB${k}`, `ローリー出荷 No.${k} レーン弁`, SH, 2250, y === 340 ? 360 : 440, "close", fuel);
  node(`LB-${k}`, "sink", `ローリー出荷 No.${k}`, SH, 2320, y, { ...fuel, label: `出荷No.${k}` });
  pipe("J-LR", `V-LB${k}`, 100);
  pipe(`V-LB${k}`, `LB-${k}`, 100, [[2250, y]]);
});
// 空港向けパイプライン
V("V-PL", "空港向けパイプライン 送油弁", SH, 2190, 540, "close", fuel);
node("PL-1", "sink", "空港向けパイプライン", SH, 2300, 560, { ...fuel, label: "空港PL" });
pipe(disc[1][1], "V-PL", 200);
pipe("V-PL", "PL-1", 200, [[2240, 540], [2240, 560]]);

// ═════ 消火 ═════
// 消火ポンプ室：海水取水口・消火用水槽 → 主・予備・補助ポンプ → 吐出ヘッダー
node("SW-1", "source", "海水取水口", FP, 75, 700, { ...water, label: "海水取水" });
V("V-SW1", "海水取水 元弁", FP, 160, 700, "open", water);
node("WT-1", "tank", "消火用水槽（淡水）", FP, 110, 900, { ...water, capacity_kl: 1000, small: true });
V("V-WT1", "消火用水槽 出口弁", FP, 190, 900, "open", water);
J("J-FS1", FP, 250, 700, water);
J("J-FS2", FP, 250, 800, water);
J("J-FS3", FP, 250, 900, water);
chain(300, "SW-1", "V-SW1", "J-FS1");
pipe("WT-1", "V-WT1", 150);
pipe("V-WT1", "J-FS3", 150);
chain(300, "J-FS1", "J-FS2", "J-FS3");
const firePumps = [
  ["FP-1", "消火ポンプ（主・電動）", "J-FS1", 700, 250, 6000],
  ["FP-2", "消火ポンプ（予備・ディーゼル）", "J-FS2", 800, 250, 6000],
  ["JP-1", "補助加圧ポンプ", "J-FS3", 900, 50, 150],
];
firePumps.forEach(([code, name, from, y, size, flow]) => {
  const k = code.replace("-", "");
  V(`V-${k}S`, `${name} 吸込弁`, FP, 310, y, "open", water);
  node(code, "pump", name, FP, 370, y, { ...water, volume_l: 60, rated_flow_lpm: flow, dir_from: `V-${k}S` });
  node(`CV-${k}`, "check", `${name} 逆止弁`, FP, 430, y, { ...water, dir_from: code });
  V(`V-${k}D`, `${name} 吐出弁`, FP, 490, y, "open", water);
  J(`J-FD${y}`, FP, 560, y, water);
  pipe(from, `V-${k}S`, size);
  chain(size, `V-${k}S`, code, `CV-${k}`, `V-${k}D`, `J-FD${y}`);
});
chain(300, "J-FD700", "J-FD800", "J-FD900");
// 締切運転の安全弁（吐出 → 海へ放流）
node("PSV-FP", "psv", "消火ポンプ吐出 安全弁（→海へ放流）", FP, 600, 650, { ...water, set_pressure_mpa: 1.2, dir_from: "J-FD700" });
node("OF-1", "sink", "放流口（海）", FP, 700, 650, { ...water, label: "海へ放流" });
pipe("J-FD700", "PSV-FP", 80, [[560, 650]]);
pipe("PSV-FP", "OF-1", 80);
J("J-FDD", FP, 620, 700, water);
D("D-FD", "消火ポンプ吐出ヘッダー ドレン", FP, 620, 740, 50, water);
pipe("J-FD700", "J-FDD", 300);
pipe("J-FDD", "D-FD", 50);

// 泡原液：タンク → 泡原液ポンプ → 泡混合器（吐出ヘッダーから送水）→ 泡水溶液主弁
node("FT-1", "tank", "泡原液タンク", FP, 110, 1020, { ...foam, capacity_kl: 30, small: true });
V("V-FT1", "泡原液タンク 出口弁", FP, 190, 1020, "close", foam);
node("FCP-1", "pump", "泡原液ポンプ", FP, 260, 1020, { ...foam, volume_l: 10, rated_flow_lpm: 300, dir_from: "V-FT1" });
node("CV-FCP1", "check", "泡原液ポンプ 逆止弁", FP, 320, 1020, { ...foam, dir_from: "FCP-1" });
V("V-FCP1D", "泡原液ポンプ 吐出弁", FP, 380, 1020, "close", foam);
V("V-PRW", "泡混合器 送水弁", FP, 560, 960, "close", water);
node("PR-1", "proportioner", "泡混合器（プレッシャープロポーショナー）", FP, 560, 1020, { ...sol, volume_l: 80, label: "PR-1" });
D("D-PR1", "泡混合器 ドレン", FP, 560, 1065, 25, sol);
V("V-FSM", "泡水溶液 主弁", FP, 650, 1020, "close", sol);
pipe("FT-1", "V-FT1", 80, null, { fluid: "foam" });
chain(80, "V-FT1", "FCP-1", "CV-FCP1", "V-FCP1D");
pipe("V-FCP1D", "PR-1", 80, null, { fluid: "foam" });
pipe("J-FD900", "V-PRW", 200, [[560, 930]]);
pipe("V-PRW", "PR-1", 200);
pipe("PR-1", "D-PR1", 25);
pipe("PR-1", "V-FSM", 200);

// 消火用水主管（y=700）：タンクヤード周囲の消火栓ループ・冷却散水ヘッダー・出荷設備の消火栓
V("V-FM1", "消火用水主管 元弁", FM, 700, 700, "open", water);
J("J-FM", FM, 820, 700, water);
pipe("J-FDD", "V-FM1", 300);
pipe("V-FM1", "J-FM", 300);

// タンクヤード周囲の消火栓ループ（左辺 x=880、上辺 y=10、右辺 x=1730、下辺 y=500）
J("J-LPF", FM, 880, 700, water);
V("V-LPF", "タンクヤード消火栓ループ 元弁", FM, 880, 610, "open", water);
const ring = [
  ["J-LP1", 880, 500],
  ["J-YH1", 880, 440],
  ["J-YH2", 880, 110],
  ["J-LP2", 880, 10],
  ["J-YH3", 1100, 10],
  ["J-YH4", 1500, 10],
  ["J-LP3", 1730, 10],
  ["J-YH5", 1730, 150],
  ["J-YH6", 1730, 260],
  ["J-LP4", 1730, 500],
  ["J-LPD", 1150, 500],
];
ring.forEach(([code, x, y]) => J(code, YD, x, y, water));
pipe("J-FM", "J-LPF", 300);
pipe("J-LPF", "V-LPF", 200);
pipe("V-LPF", "J-LP1", 200);
ring.forEach(([code], i) => pipe(code, ring[(i + 1) % ring.length][0], 200));
D("D-LP", "タンクヤード消火栓ループ 低部ドレン", YD, 1150, 530, 50, water);
pipe("J-LPD", "D-LP", 50);
// 消火栓：ループの外側に置く（左辺は左へ、上辺は上へ、右辺は右へ）
[
  ["1", "J-YH1", -1, 0],
  ["2", "J-YH2", -1, 0],
  ["3", "J-YH3", 0, -1],
  ["4", "J-YH4", 0, -1],
  ["5", "J-YH5", 1, 0],
  ["6", "J-YH6", 1, 0],
].forEach(([k, j, dx, dy]) => {
  const [, x, y] = ring.find((r) => r[0] === j);
  // 外側の泡消火栓ループをまたいで、その外に置く
  V(`V-YH${k}`, `タンクヤード消火栓 No.${k} 開閉弁`, YD, x + dx * 45, y + dy * 45, "close", water);
  node(`YH-${k}`, "hydrant", `タンクヤード消火栓 No.${k}`, YD, x + dx * 85, y + dy * 85, { ...water, label: `YH-${k}` });
  chain(80, j, `V-YH${k}`, `YH-${k}`);
});

// 冷却散水ヘッダー（y=640）：1タンク2系統。ヘッダー → シリンダー弁（常時閉）→ 手動弁（常時開）→ 冷却散水設備
J("J-CWH0", FM, 920, 700, water);
V("V-CWH", "冷却散水ヘッダー 元弁", FM, 920, 670, "open", water);
pipe("J-LPF", "J-CWH0", 300);
pipe("J-CWH0", "V-CWH", 250);
let prevC = "V-CWH";
J("J-CWH", FM, 920, 640, water);
pipe(prevC, "J-CWH", 250);
prevC = "J-CWH";
// 泡のヘッダーも同じ並びで作るため、タンクごとの系統の位置をまとめておく
const LINES = [];
TANKS.forEach(([no, x]) => {
  LINES.push({ no, sys: "A", wx: x - 90, wy: 95, fx: x + 70, fy: 95 });
  LINES.push({ no, sys: "B", wx: x - 70, wy: 150, fx: x + 90, fy: 150 });
});
LINES.forEach(({ no, sys, wx, wy }) => {
  const j = J(`J-CW${no}${sys}`, FM, wx, 640, water);
  V(`CY-CW${no}${sys}`, `T-${no} 冷却散水 ${sys}系 シリンダー弁（遠隔操作）`, FM, wx, 595, "close", { ...water, label: `CY-CW${no}${sys}` });
  V(`V-CW${no}${sys}`, `T-${no} 冷却散水 ${sys}系 手動弁`, YD, wx, 545, "open", water);
  node(`SP-${no}${sys}`, "sprinkler", `T-${no} 冷却散水設備 ${sys}系`, YD, wx, wy, { ...water, label: `SP-${no}${sys}` });
  pipe(prevC, j, 250);
  chain(100, j, `CY-CW${no}${sys}`, `V-CW${no}${sys}`, `SP-${no}${sys}`);
  prevC = j;
});
J("J-CWHE", FM, 1720, 640, water);
D("D-CWH", "冷却散水ヘッダー 末端ドレン", FM, 1760, 640, 50, water);
pipe(prevC, "J-CWHE", 250);
pipe("J-CWHE", "D-CWH", 50);

// 出荷設備の消火栓と主管の末端
J("J-WH1", FM, 1800, 700, water);
V("V-WH1", "消火栓 No.1 開閉弁", FM, 1800, 745, "close", water);
node("WH-1", "hydrant", "消火栓 No.1（出荷設備）", FM, 1800, 785, { ...water, label: "WH-1" });
pipe("J-CWH0", "J-WH1", 300);
chain(80, "J-WH1", "V-WH1", "WH-1");
J("J-FME", FM, 1900, 700, water);
D("D-FME", "消火用水主管 末端ドレン", FM, 1900, 740, 50, water);
pipe("J-WH1", "J-FME", 250);
pipe("J-FME", "D-FME", 50);

// 泡水溶液主管（y=1020）：タンク発泡装置ヘッダー・泡消火栓
J("J-FSJ", FM, 740, 1020, sol);
J("J-FSM", FM, 820, 1020, sol);
pipe("V-FSM", "J-FSJ", 200);
pipe("J-FSJ", "J-FSM", 200);
// 発泡装置ヘッダー（y=960）：1タンク2系統。ヘッダー → シリンダー弁（常時閉）→ 手動弁（常時開）→ タンク発泡装置
J("J-FCH0", FM, 920, 1020, sol);
// 主管 → 泡消火栓ループの分岐 → 発泡装置ヘッダーの分岐 の順に並ぶ
V("V-FCH", "発泡装置ヘッダー 元弁", FM, 920, 990, "open", sol);
J("J-FCH", FM, 920, 960, sol);
pipe("J-FSM", "J-FRF", 200);
pipe("J-FRF", "J-FCH0", 200);
chain(200, "J-FCH0", "V-FCH", "J-FCH");
let prevF = "J-FCH";
[...LINES].sort((a, b) => a.fx - b.fx).forEach(({ no, sys, fx, fy }) => {
  const j = J(`J-FC${no}${sys}`, FM, fx, 960, sol);
  V(`CY-FC${no}${sys}`, `T-${no} 発泡装置 ${sys}系 シリンダー弁（遠隔操作）`, FM, fx, 915, "close", { ...sol, label: `CY-FC${no}${sys}` });
  V(`V-FC${no}${sys}`, `T-${no} 発泡装置 ${sys}系 手動弁`, FM, fx, 870, "open", sol);
  node(`FC-${no}${sys}`, "foamChamber", `T-${no} タンク発泡装置 ${sys}系（固定泡放出口）`, YD, fx, fy, { ...sol, label: `FC-${no}${sys}` });
  pipe(prevF, j, 200);
  chain(80, j, `CY-FC${no}${sys}`, `V-FC${no}${sys}`, `FC-${no}${sys}`);
  prevF = j;
});
J("J-FCHE", FM, 1720, 960, sol);
D("D-FCH", "発泡装置ヘッダー 末端ドレン", FM, 1760, 960, 25, sol);
pipe(prevF, "J-FCHE", 200);
pipe("J-FCHE", "D-FCH", 25);

// タンクヤード周囲の泡消火栓ループ（水の消火栓ループの外側：左辺 x=860、上辺 y=-10、右辺 x=1750、下辺 y=520）
J("J-FRF", FM, 860, 1020, sol);
V("V-FRF", "タンクヤード泡消火栓ループ 元弁", FM, 860, 930, "open", sol);
const fring = [
  ["J-FR1", 860, 520],
  ["J-FY1", 860, 480],
  ["J-FY2", 860, 60],
  ["J-FR2", 860, -10],
  ["J-FY3", 1300, -10],
  ["J-FY4", 1650, -10],
  ["J-FR3", 1750, -10],
  ["J-FY5", 1750, 80],
  ["J-FY6", 1750, 205],
  ["J-FR4", 1750, 520],
  ["J-FRD", 1200, 520],
];
fring.forEach(([code, x, y]) => J(code, YD, x, y, sol));
pipe("J-FRF", "V-FRF", 150);
pipe("V-FRF", "J-FR1", 150);
fring.forEach(([code], i) => pipe(code, fring[(i + 1) % fring.length][0], 150));
D("D-FR", "タンクヤード泡消火栓ループ 低部ドレン", YD, 1200, 550, 50, sol);
pipe("J-FRD", "D-FR", 50);
[
  ["1", "J-FY1", -1, 0],
  ["2", "J-FY2", -1, 0],
  ["3", "J-FY3", 0, -1],
  ["4", "J-FY4", 0, -1],
  ["5", "J-FY5", 1, 0],
  ["6", "J-FY6", 1, 0],
].forEach(([k, j, dx, dy]) => {
  const [, x, y] = fring.find((r) => r[0] === j);
  V(`V-FY${k}`, `タンクヤード泡消火栓 No.${k} 開閉弁`, YD, x + dx * 25, y + dy * 25, "close", sol);
  node(`FY-${k}`, "hydrant", `タンクヤード泡消火栓 No.${k}`, YD, x + dx * 65, y + dy * 65, { ...sol, label: `泡FY-${k}` });
  chain(80, j, `V-FY${k}`, `FY-${k}`);
});

// 泡消火栓（主管 y=1020 から）
let prevH = "J-FCH0";
[["1", 1150], ["2", 1550], ["3", 1950]].forEach(([k, x]) => {
  const j = J(`J-FH${k}`, FM, x, 1020, sol);
  V(`V-FH${k}`, `泡消火栓 No.${k} 開閉弁`, FM, x, 1070, "close", sol);
  node(`FH-${k}`, "hydrant", `泡消火栓 No.${k}`, FM, x, 1110, { ...sol, label: `泡FH-${k}` });
  pipe(prevH, j, 150);
  chain(80, j, `V-FH${k}`, `FH-${k}`);
  prevH = j;
});
J("J-FSE", FM, 2050, 1020, sol);
D("D-FSE", "泡水溶液主管 末端ドレン", FM, 2050, 1060, 50, sol);
pipe(prevH, "J-FSE", 150);
pipe("J-FSE", "D-FSE", 50);

// 桟橋泡モニター：泡水溶液主管から桟橋へ立ち上げ（x=740 → y=590 → 桟橋）
J("J-JF", FM, 740, 590, sol);
V("V-JF", "桟橋泡 送液弁", FM, 740, 800, "close", sol);
pipe("J-FSJ", "V-JF", 150);
pipe("V-JF", "J-JF", 150);
let prevJ = "J-JF";
[["1", 440], ["2", 220]].forEach(([k, x]) => {
  const j = J(`J-JM${k}`, JT, x, 590, sol);
  V(`V-JM${k}`, `桟橋泡モニター No.${k} 開閉弁`, JT, x, 550, "close", sol);
  node(`JM-${k}`, "monitor", `桟橋泡モニター No.${k}（タワー型）`, JT, x, 510, { ...sol, label: `桟橋モニターNo.${k}` });
  pipe(prevJ, j, 150);
  chain(100, j, `V-JM${k}`, `JM-${k}`);
  prevJ = j;
});
D("D-JF", "桟橋泡配管 末端ドレン", JT, 120, 590, 25, sol);
pipe(prevJ, "D-JF", 25);

// ═════ 第2タンクヤード（第1タンクヤードと同じ構成。出荷設備の右側、x を +1700 ずらす） ═════
const DX = 1700;
const TANKS2 = [["501", 1000 + DX], ["502", 1200 + DX], ["503", 1400 + DX], ["504", 1600 + DX]];

// 受入：陸側受入設備のストレーナー出口から分岐し、図面上部（y=-150）を回して第2ヤードへ
V("V-RY2", "第2タンクヤード 受入元弁", RC, 720, 150, "open", fuel);
J("J-RY1", RC, 720, -150, fuel);
J("J-RY2", YD2, 2420, -150, fuel);
J("J-R2H", YD2, 2420, 330, fuel);
pipe("J-RY", "V-RY2", 250);
pipe("V-RY2", "J-RY1", 250);
pipe("J-RY1", "J-RY2", 250);
// 第2ヤードへの受入配管の低部ドレン
J("J-RYD", YD2, 2420, 100, fuel);
D("D-RY2", "第2ヤード受入配管 低部ドレン", YD2, 2385, 100, 50, fuel);
pipe("J-RY2", "J-RYD", 250);
pipe("J-RYD", "J-R2H", 250);
pipe("J-RYD", "D-RY2", 50);

const rJ2 = [];
const iJ2 = [];
TANKS2.forEach(([no, x]) => {
  node(`T-${no}`, "tank", `T-${no} 貯蔵タンク（浮き屋根）`, YD2, x, 120, { ...fuel, capacity_kl: 10000 });
  node(`CV-${no}R`, "check", `T-${no} 受入逆止弁`, YD2, x - 20, 180, { ...fuel, dir_from: `J-${no}RT` });
  J(`J-${no}RT`, YD2, x - 20, 210, fuel);
  V(`V-${no}R`, `T-${no} 受入弁`, YD2, x - 20, 260, "close", fuel);
  J(`J-${no}R`, YD2, x - 20, 330, fuel);
  pipe(`T-${no}`, `CV-${no}R`, 300, [[x - 20, 140]]);
  chain(300, `CV-${no}R`, `J-${no}RT`, `V-${no}R`, `J-${no}R`);
  V(`V-${no}I`, `T-${no} 出荷弁`, YD2, x + 20, 260, "close", fuel);
  node(`CV-${no}I`, "check", `T-${no} 出荷逆止弁`, YD2, x + 20, 300, { ...fuel, dir_from: `V-${no}I` });
  J(`J-${no}I`, YD2, x + 20, 400, fuel);
  pipe(`T-${no}`, `V-${no}I`, 250, [[x + 20, 140]]);
  chain(250, `V-${no}I`, `CV-${no}I`, `J-${no}I`);
  rJ2.push(`J-${no}R`);
  iJ2.push(`J-${no}I`);
});
V("V-R2H1", "第2ヤード受入ヘッダー 区分弁（T-502／T-503間）", YD2, 1300 + DX, 330, "open", fuel);
J("J-R2HE", YD2, 1680 + DX, 330, fuel);
D("D-R2H", "第2ヤード受入ヘッダー 末端ドレン", YD2, 1680 + DX, 370, 50, fuel);
chain(300, "J-R2H", rJ2[0], rJ2[1], "V-R2H1", rJ2[2], rJ2[3], "J-R2HE");
pipe("J-R2HE", "D-R2H", 50);
// 出荷：第2ヤード出荷ヘッダー → 出荷設備の下（y=620）を回して出荷ポンプの吸込へ
J("J-I2W", YD2, 2440, 400, fuel);
D("D-I2H", "第2ヤード出荷ヘッダー 始端ドレン", YD2, 2470, 440, 50, fuel);
J("J-I2D", YD2, 2470, 400, fuel);
chain(250, "J-I2W", "J-I2D", iJ2[0], iJ2[1], iJ2[2], iJ2[3]);
pipe("J-I2D", "D-I2H", 50);
J("J-I2S", SH, 2440, 620, fuel);
V("V-I2", "第2タンクヤード 出荷元弁", SH, 2100, 620, "open", fuel);
J("J-I2P", SH, 1780, 620, fuel);
pipe("J-I2W", "J-I2S", 250);
pipe("J-I2S", "V-I2", 250);
pipe("V-I2", "J-I2P", 250);
pipe("J-I2P", "J-SP42", 250);

// 消火用水主管・泡水溶液主管を東へ延長
J("J-LPF2", FM, 880 + DX, 700, water);
J("J-CWH20", FM, 920 + DX, 700, water);
J("J-FME2", FM, 1900 + DX, 700, water);
D("D-FME2", "消火用水主管（第2ヤード側）末端ドレン", FM, 1900 + DX, 740, 50, water);
chain(300, "J-FME", "J-LPF2", "J-CWH20");
pipe("J-CWH20", "J-FME2", 250);
pipe("J-FME2", "D-FME2", 50);
J("J-FRF2", FM, 860 + DX, 1020, sol);
J("J-FCH20", FM, 920 + DX, 1020, sol);
J("J-FSE2", FM, 1900 + DX, 1020, sol);
D("D-FSE2", "泡水溶液主管（第2ヤード側）末端ドレン", FM, 1900 + DX, 1060, 50, sol);
chain(200, "J-FSE", "J-FRF2", "J-FCH20");
pipe("J-FCH20", "J-FSE2", 150);
pipe("J-FSE2", "D-FSE2", 50);

// 第2ヤード周囲の消火栓ループ（水・泡）。第1ヤードと同じ形で x を +1700
function hydrantRing({ feed, feedValve, feedValveName, ring, drain, drainName, hydrants, fluid, prefix, nameHead, inner }) {
  const [fx, fy] = feedValve;
  V(`V-${prefix}F`, feedValveName, FM, fx, fy, "open", fluid);
  ring.forEach(([code, x, y]) => J(code, YD2, x, y, fluid));
  pipe(feed, `V-${prefix}F`, 200);
  pipe(`V-${prefix}F`, ring[0][0], 200);
  ring.forEach(([code], i) => pipe(code, ring[(i + 1) % ring.length][0], 200));
  D(drain[0], drainName, YD2, drain[1], drain[2], 50, fluid);
  pipe(drain[3], drain[0], 50);
  hydrants.forEach(([k, j, dx, dy]) => {
    const [, x, y] = ring.find((r) => r[0] === j);
    const vOff = inner ? 45 : 25;
    const hOff = inner ? 85 : 65;
    V(`V-${prefix}${k}`, `${nameHead} No.${k} 開閉弁`, YD2, x + dx * vOff, y + dy * vOff, "close", fluid);
    node(`${prefix}-${k}`, "hydrant", `${nameHead} No.${k}`, YD2, x + dx * hOff, y + dy * hOff, { ...fluid, label: `${prefix}-${k}` });
    chain(80, j, `V-${prefix}${k}`, `${prefix}-${k}`);
  });
}
hydrantRing({
  feed: "J-LPF2",
  feedValve: [880 + DX, 610],
  feedValveName: "第2タンクヤード消火栓ループ 元弁",
  ring: [
    ["J-LP21", 880 + DX, 500],
    ["J-YH27", 880 + DX, 440],
    ["J-YH28", 880 + DX, 110],
    ["J-LP22", 880 + DX, 10],
    ["J-YH29", 1100 + DX, 10],
    ["J-YH210", 1500 + DX, 10],
    ["J-LP23", 1730 + DX, 10],
    ["J-YH211", 1730 + DX, 150],
    ["J-YH212", 1730 + DX, 260],
    ["J-LP24", 1730 + DX, 500],
    ["J-LP2D", 1150 + DX, 500],
  ],
  drain: ["D-LP2", 1150 + DX, 530, "J-LP2D"],
  drainName: "第2タンクヤード消火栓ループ 低部ドレン",
  hydrants: [["7", "J-YH27", -1, 0], ["8", "J-YH28", -1, 0], ["9", "J-YH29", 0, -1], ["10", "J-YH210", 0, -1], ["11", "J-YH211", 1, 0], ["12", "J-YH212", 1, 0]],
  fluid: water,
  prefix: "YH",
  nameHead: "第2タンクヤード消火栓",
  inner: true,
});
hydrantRing({
  feed: "J-FRF2",
  feedValve: [860 + DX, 930],
  feedValveName: "第2タンクヤード泡消火栓ループ 元弁",
  ring: [
    ["J-FR21", 860 + DX, 520],
    ["J-FY27", 860 + DX, 480],
    ["J-FY28", 860 + DX, 60],
    ["J-FR22", 860 + DX, -10],
    ["J-FY29", 1300 + DX, -10],
    ["J-FY210", 1650 + DX, -10],
    ["J-FR23", 1750 + DX, -10],
    ["J-FY211", 1750 + DX, 80],
    ["J-FY212", 1750 + DX, 205],
    ["J-FR24", 1750 + DX, 520],
    ["J-FR2D", 1200 + DX, 520],
  ],
  drain: ["D-FR2", 1200 + DX, 550, "J-FR2D"],
  drainName: "第2タンクヤード泡消火栓ループ 低部ドレン",
  hydrants: [["7", "J-FY27", -1, 0], ["8", "J-FY28", -1, 0], ["9", "J-FY29", 0, -1], ["10", "J-FY210", 0, -1], ["11", "J-FY211", 1, 0], ["12", "J-FY212", 1, 0]],
  fluid: sol,
  prefix: "FY",
  nameHead: "第2タンクヤード泡消火栓",
  inner: false,
});

// 冷却散水ヘッダー・発泡装置ヘッダー：1タンク2系統（シリンダー弁 → 手動弁）
V("V-CWH2", "第2ヤード冷却散水ヘッダー 元弁", FM, 920 + DX, 670, "open", water);
J("J-CWH2", FM, 920 + DX, 640, water);
chain(250, "J-CWH20", "V-CWH2", "J-CWH2");
V("V-FCH2", "第2ヤード発泡装置ヘッダー 元弁", FM, 920 + DX, 990, "open", sol);
J("J-FCH2", FM, 920 + DX, 960, sol);
chain(200, "J-FCH20", "V-FCH2", "J-FCH2");
const LINES2 = [];
TANKS2.forEach(([no, x]) => {
  LINES2.push({ no, sys: "A", wx: x - 90, wy: 95, fx: x + 70, fy: 95 });
  LINES2.push({ no, sys: "B", wx: x - 70, wy: 150, fx: x + 90, fy: 150 });
});
let prevC2 = "J-CWH2";
LINES2.forEach(({ no, sys, wx, wy }) => {
  const j = J(`J-CW${no}${sys}`, FM, wx, 640, water);
  V(`CY-CW${no}${sys}`, `T-${no} 冷却散水 ${sys}系 シリンダー弁（遠隔操作）`, FM, wx, 595, "close", { ...water, label: `CY-CW${no}${sys}` });
  V(`V-CW${no}${sys}`, `T-${no} 冷却散水 ${sys}系 手動弁`, YD2, wx, 545, "open", water);
  node(`SP-${no}${sys}`, "sprinkler", `T-${no} 冷却散水設備 ${sys}系`, YD2, wx, wy, { ...water, label: `SP-${no}${sys}` });
  pipe(prevC2, j, 250);
  chain(100, j, `CY-CW${no}${sys}`, `V-CW${no}${sys}`, `SP-${no}${sys}`);
  prevC2 = j;
});
J("J-CWH2E", FM, 1720 + DX, 640, water);
D("D-CWH2", "第2ヤード冷却散水ヘッダー 末端ドレン", FM, 1760 + DX, 640, 50, water);
pipe(prevC2, "J-CWH2E", 250);
pipe("J-CWH2E", "D-CWH2", 50);
let prevF2 = "J-FCH2";
[...LINES2].sort((a, b) => a.fx - b.fx).forEach(({ no, sys, fx, fy }) => {
  const j = J(`J-FC${no}${sys}`, FM, fx, 960, sol);
  V(`CY-FC${no}${sys}`, `T-${no} 発泡装置 ${sys}系 シリンダー弁（遠隔操作）`, FM, fx, 915, "close", { ...sol, label: `CY-FC${no}${sys}` });
  V(`V-FC${no}${sys}`, `T-${no} 発泡装置 ${sys}系 手動弁`, FM, fx, 870, "open", sol);
  node(`FC-${no}${sys}`, "foamChamber", `T-${no} タンク発泡装置 ${sys}系（固定泡放出口）`, YD2, fx, fy, { ...sol, label: `FC-${no}${sys}` });
  pipe(prevF2, j, 200);
  chain(80, j, `CY-FC${no}${sys}`, `V-FC${no}${sys}`, `FC-${no}${sys}`);
  prevF2 = j;
});
J("J-FCH2E", FM, 1720 + DX, 960, sol);
D("D-FCH2", "第2ヤード発泡装置ヘッダー 末端ドレン", FM, 1760 + DX, 960, 25, sol);
pipe(prevF2, "J-FCH2E", 200);
pipe("J-FCH2E", "D-FCH2", 25);

const sch40 = [[25, 34.0, 26.6], [40, 48.6, 40.9], [50, 60.5, 52.7], [80, 89.1, 78.1], [100, 114.3, 102.3], [150, 165.2, 154.1], [200, 216.3, 202.7], [250, 267.4, 254.5], [300, 318.5, 304.8]];
const data = {
  facility_id: "virtual-site-2",
  facility_name: "臨海石油基地（仮想・第2拠点）",
  note: "サンプル：臨海石油基地。タンクヤード2か所（各タンク4基）。冷却散水・発泡装置はヘッダーから1タンク2系統（シリンダー弁＋手動弁）、各ヤード周囲に消火栓ループ（水・泡）",
  sheets: [{ sheet_no: "S1", title: "全体系統図（燃料・消火）", width: 3560, height: 1390, meters_per_unit: 0.25, source_doc_no: null }],
  areas: [
    { name: JT, sheet_no: "S1", x: 30, y: 110 + OY, w: 490, h: 520 },
    { name: RC, sheet_no: "S1", x: 560, y: 180 + OY, w: 300, h: 200 },
    { name: YD, sheet_no: "S1", x: 780, y: -100 + OY, w: 1000, h: 670 },
    { name: YD2, sheet_no: "S1", x: 780 + DX, y: -100 + OY, w: 1000, h: 670 },
    { name: SH, sheet_no: "S1", x: 1760, y: 300 + OY, w: 610, h: 300 },
    { name: FP, sheet_no: "S1", x: 30, y: 640 + OY, w: 680, h: 470 },
    { name: FM, sheet_no: "S1", x: 730, y: 560 + OY, w: 2740, h: 600 },
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
