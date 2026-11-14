// 第2拠点のサンプル「臨海石油基地（仮想）」を、系統図の登録シート（Excel）として書き出す。
//   燃料：タンカー → 桟橋（ローディングアーム・緊急遮断弁）→ 陸側受入設備 → 第1・第2タンクヤード（各4基・2×2配置）→ 出荷ポンプ → ローリー出荷・空港向けパイプライン
//   消火：海水取水口・消火用水槽 → 消火ポンプ（主・予備・補助）→ 消火用水主管 → タンクヤード周囲の消火栓ループ（水・泡）、
//         冷却散水ヘッダー（上段・下段）→ 各タンクの左右に1系統ずつ（シリンダー弁 → 手動弁 → 冷却散水設備）
//         泡原液タンク → 泡原液ポンプ → 泡混合器 → 泡水溶液主管 → 発泡装置ヘッダー（上段・下段）→ 各タンクの左右に1系統ずつ（シリンダー弁 → 手動弁 → タンク発泡装置）、
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
const OY = 320;

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
pipe("J-JD", "V-JS1", 300);
J("J-RY", RC, 720, 230, fuel);
chain(300, "V-JS1", "STR-JR", "J-RY", "V-JS2");
pipe("STR-JR", "D-JR", 50);

// ═════ タンクヤード（2か所とも同じ構成。各ヤードにタンク4基を 2×2 で配置） ═════
// 燃料：受入ヘッダー（y=250）・出荷ヘッダー（y=280）を上下のタンク列の間に通す
// 消火：上段タンクは上側ヘッダー（水 y=-30・泡 y=-60）、下段タンクは下側ヘッダー（水 y=560・泡 y=590）から
//       各タンクの左右それぞれに 冷却散水（水）・発泡装置（泡）を1系統ずつ（ヘッダー → シリンダー弁 → 手動弁 → 放出口）
//       ヤードの周囲に 水の消火栓ループ（内側）と泡消火栓ループ（外側）
const SIDES = [["L", "左側", -1], ["R", "右側", 1]];

function buildYard(y) {
  const { x0, nos, area, tag, head, rcvStart, leftWaterY, leftFoamY, hydrantFrom } = y;
  const [tl, tr, bl, br] = nos;
  const tanks = [
    { no: tl, tx: x0 + 180, ty: 110, top: true },
    { no: tr, tx: x0 + 520, ty: 110, top: true },
    { no: bl, tx: x0 + 180, ty: 430, top: false },
    { no: br, tx: x0 + 520, ty: 430, top: false },
  ];

  // ── 燃料 ──
  const rcv = {};
  const iss = {};
  tanks.forEach(({ no, tx, ty, top }) => {
    node(`T-${no}`, "tank", `T-${no} 貯蔵タンク（浮き屋根）`, area, tx, ty, { ...fuel, capacity_kl: 10000 });
    // 上段は下へ、下段は上へ配管を出す。受入はタンク側に逆止弁、出荷はヘッダー側に逆止弁
    const rx = top ? tx - 20 : tx - 35;
    const ix = top ? tx + 20 : tx + 35;
    const at = top ? (a, b) => a : (a, b) => b;
    node(`CV-${no}R`, "check", `T-${no} 受入逆止弁`, area, rx, at(175, 365), { ...fuel, dir_from: `J-${no}RT` });
    J(`J-${no}RT`, area, rx, at(195, 345), fuel);
    V(`V-${no}R`, `T-${no} 受入弁`, area, rx, at(220, 320), "close", fuel);
    rcv[no] = J(`J-${no}R`, area, rx, 250, fuel);
    pipe(`T-${no}`, `CV-${no}R`, 300, [[rx, ty + (top ? 30 : -30)]]);
    chain(300, `CV-${no}R`, `J-${no}RT`, `V-${no}R`, `J-${no}R`);
    V(`V-${no}I`, `T-${no} 出荷弁`, area, ix, at(190, 350), "close", fuel);
    node(`CV-${no}I`, "check", `T-${no} 出荷逆止弁`, area, ix, at(225, 315), { ...fuel, dir_from: `V-${no}I` });
    iss[no] = J(`J-${no}I`, area, ix, 280, fuel);
    pipe(`T-${no}`, `V-${no}I`, 250, [[ix, ty + (top ? 30 : -30)]]);
    chain(250, `V-${no}I`, `CV-${no}I`, `J-${no}I`);
  });
  V(`V-R${tag}H1`, `${head}受入ヘッダー 区分弁（T-${tl}・${bl}／T-${tr}・${br}間）`, area, x0 + 350, 250, "open", fuel);
  J(`J-R${tag}HE`, area, x0 + 640, 250, fuel);
  D(`D-R${tag}H`, `${head}受入ヘッダー 末端ドレン`, area, x0 + 675, 250, 50, fuel);
  chain(300, rcvStart, rcv[bl], rcv[tl], `V-R${tag}H1`, rcv[br], rcv[tr], `J-R${tag}HE`);
  pipe(`J-R${tag}HE`, `D-R${tag}H`, 50);
  const issL = J(`J-I${tag}HS`, area, x0 + 100, 280, fuel);
  const issR = J(`J-I${tag}HE`, area, x0 + 660, 280, fuel);
  chain(250, issL, iss[tl], iss[bl], iss[tr], iss[br], issR);

  // ── 消火：主管からの分岐（ループ元弁・ヘッダー元弁） ──
  const wFeed = J(`J-LPF${tag}`, FM, x0, 700, water);
  const wRiser = J(`J-CWH${tag}0`, FM, x0 + 40, 700, water);
  const fFeed = J(`J-FRF${tag}`, FM, x0 - 20, 1020, sol);
  const fRiser = J(`J-FCH${tag}0`, FM, x0 + 60, 1020, sol);

  // 冷却散水ヘッダー：元弁 → 下側ヘッダー（y=560）→ 上側ヘッダー（y=-30）へ立ち上げ
  V(`V-CWH${tag}`, `${head}冷却散水ヘッダー 元弁`, FM, x0 + 40, 675, "open", water);
  J(`J-CWB${tag}`, area, x0 + 40, 560, water);
  J(`J-CWT${tag}`, area, x0 + 40, -30, water);
  chain(250, wRiser, `V-CWH${tag}`, `J-CWB${tag}`, `J-CWT${tag}`);
  // 発泡装置ヘッダー：元弁 → 下側ヘッダー（y=590）→ 上側ヘッダー（y=-60）へ立ち上げ
  V(`V-FCH${tag}`, `${head}発泡装置ヘッダー 元弁`, FM, x0 + 60, 990, "open", sol);
  J(`J-FCB${tag}`, area, x0 + 60, 590, sol);
  J(`J-FCT${tag}`, area, x0 + 60, -60, sol);
  chain(200, fRiser, `V-FCH${tag}`, `J-FCB${tag}`, `J-FCT${tag}`);

  // 各タンクの左右の系統（位置をまとめてからヘッダーに x の順でつなぐ）
  const lines = { CWT: [], CWB: [], FCT: [], FCB: [] };
  tanks.forEach(({ no, tx, top }) => {
    SIDES.forEach(([s, sName, sign]) => {
      const wx = tx + sign * 95;
      const fx = tx + sign * 70;
      const at = top ? (a, b) => a : (a, b) => b;
      // 冷却散水（水）
      J(`J-CW${no}${s}`, area, wx, at(-30, 560), water);
      V(`CY-CW${no}${s}`, `T-${no} 冷却散水（${sName}）シリンダー弁（遠隔操作）`, area, wx, at(5, 530), "close", { ...water, label: `CY-CW${no}${s}` });
      V(`V-CW${no}${s}`, `T-${no} 冷却散水（${sName}）手動弁`, area, wx, at(40, 500), "open", water);
      node(`SP-${no}${s}`, "sprinkler", `T-${no} 冷却散水設備（${sName}）`, area, wx, at(95, 445), { ...water, label: `SP-${no}${s}` });
      chain(100, `J-CW${no}${s}`, `CY-CW${no}${s}`, `V-CW${no}${s}`, `SP-${no}${s}`);
      lines[top ? "CWT" : "CWB"].push([wx, `J-CW${no}${s}`]);
      // 発泡装置（泡水溶液）
      J(`J-FC${no}${s}`, area, fx, at(-60, 590), sol);
      V(`CY-FC${no}${s}`, `T-${no} 発泡装置（${sName}）シリンダー弁（遠隔操作）`, area, fx, at(22, 515), "close", { ...sol, label: `CY-FC${no}${s}` });
      V(`V-FC${no}${s}`, `T-${no} 発泡装置（${sName}）手動弁`, area, fx, at(57, 480), "open", sol);
      node(`FC-${no}${s}`, "foamChamber", `T-${no} タンク発泡装置（${sName}・固定泡放出口）`, area, fx, at(105, 435), { ...sol, label: `FC-${no}${s}` });
      chain(80, `J-FC${no}${s}`, `CY-FC${no}${s}`, `V-FC${no}${s}`, `FC-${no}${s}`);
      lines[top ? "FCT" : "FCB"].push([fx, `J-FC${no}${s}`]);
    });
  });
  const headers = [
    ["CWT", "冷却散水 上側ヘッダー", -30, 250, water, 650, 50],
    ["CWB", "冷却散水 下側ヘッダー", 560, 250, water, 650, 50],
    ["FCT", "発泡装置 上側ヘッダー", -60, 200, sol, 660, 25],
    ["FCB", "発泡装置 下側ヘッダー", 590, 200, sol, 660, 25],
  ];
  headers.forEach(([k, name, hy, size, fl, ex, dsize]) => {
    J(`J-${k}${tag}E`, area, x0 + ex, hy, fl);
    D(`D-${k}${tag}`, `${head}${name} 末端ドレン`, area, x0 + ex + 28, hy, dsize, fl);
    const ids = lines[k].sort((a, b) => a[0] - b[0]).map((l) => l[1]);
    chain(size, `J-${k}${tag}`, ...ids, `J-${k}${tag}E`);
    pipe(`J-${k}${tag}E`, `D-${k}${tag}`, dsize);
  });

  // 周囲の消火栓ループ：水（内側 x0..x0+700, y -110..630）・泡（外側 x0-20..x0+720, y -130..650）
  function ring({ kind, l, r, t, b, feed, feedValve, feedName, fl, size, jPre, vPre, hPre, hName, hLabel, out, spots, drainX, drainY, drainName }) {
    const left = spots.filter((p) => p.side === "L").sort((p, q) => q.v - p.v);
    const topS = spots.filter((p) => p.side === "T").sort((p, q) => p.v - q.v);
    const right = spots.filter((p) => p.side === "R").sort((p, q) => p.v - q.v);
    let n = hydrantFrom;
    const pts = [];
    const hyd = [];
    const add = (code, x, yy) => {
      J(code, area, x, yy, fl);
      pts.push(code);
    };
    const spot = (p, x, yy, dx, dy) => {
      const k = String(n++);
      add(`J-${jPre}${k}`, x, yy);
      hyd.push([k, `J-${jPre}${k}`, x, yy, dx, dy]);
    };
    add(`J-${kind}${tag}1`, l, b);
    left.forEach((p) => spot(p, l, p.v, -1, 0));
    add(`J-${kind}${tag}2`, l, t);
    topS.forEach((p) => spot(p, x0 + p.v, t, 0, -1));
    add(`J-${kind}${tag}3`, r, t);
    right.forEach((p) => spot(p, r, p.v, 1, 0));
    add(`J-${kind}${tag}4`, r, b);
    add(`J-${kind}${tag}D`, drainX, b);
    V(`V-${kind}${tag}F`, feedName, FM, l, feedValve, "open", fl);
    pipe(feed, `V-${kind}${tag}F`, size);
    pipe(`V-${kind}${tag}F`, pts[0], size);
    pts.forEach((c, i) => pipe(c, pts[(i + 1) % pts.length], size));
    D(`D-${kind}${tag}`, drainName, area, drainX, drainY, 50, fl);
    pipe(`J-${kind}${tag}D`, `D-${kind}${tag}`, 50);
    hyd.forEach(([k, j, x, yy, dx, dy]) => {
      V(`V-${vPre}${k}`, `${hName} No.${k} 開閉弁`, area, x + dx * out[0], yy + dy * out[0], "close", fl);
      node(`${hPre}-${k}`, "hydrant", `${hName} No.${k}`, area, x + dx * out[1], yy + dy * out[1], { ...fl, label: `${hLabel}-${k}` });
      chain(80, j, `V-${vPre}${k}`, `${hPre}-${k}`);
    });
  }
  ring({
    kind: "LP", l: x0, r: x0 + 700, t: -110, b: 630, feed: wFeed, feedValve: 675, feedName: `${head}タンクヤード消火栓ループ 元弁`,
    fl: water, size: 200, jPre: "YH", vPre: "YH", hPre: "YH", hName: `${head}タンクヤード消火栓`, hLabel: "YH", out: [45, 85],
    spots: [
      { side: "L", v: leftWaterY[0] }, { side: "L", v: leftWaterY[1] },
      { side: "T", v: 240 }, { side: "T", v: 460 },
      { side: "R", v: 40 }, { side: "R", v: 500 },
    ],
    drainX: x0 + 330, drainY: 610, drainName: `${head}タンクヤード消火栓ループ 低部ドレン`,
  });
  ring({
    kind: "FR", l: x0 - 20, r: x0 + 720, t: -130, b: 650, feed: fFeed, feedValve: 990, feedName: `${head}タンクヤード泡消火栓ループ 元弁`,
    fl: sol, size: 150, jPre: "FY", vPre: "FY", hPre: "FY", hName: `${head}タンクヤード泡消火栓`, hLabel: "泡FY", out: [25, 65],
    spots: [
      { side: "L", v: leftFoamY[0] }, { side: "L", v: leftFoamY[1] },
      { side: "T", v: 120 }, { side: "T", v: 580 },
      { side: "R", v: 130 }, { side: "R", v: 580 },
    ],
    drainX: x0 + 370, drainY: 675, drainName: `${head}タンクヤード泡消火栓ループ 低部ドレン`,
  });

  return { issL, issR, wFeed, wRiser, fFeed, fRiser };
}

// 第1タンクヤード：受入設備の受入ヘッダーから。出荷は右（出荷設備）へ
J("J-RH", RC, 840, 250, fuel);
pipe("V-JS2", "J-RH", 300, [[840, 230]]);
const Y1 = buildYard({ x0: 880, nos: ["401", "402", "403", "404"], area: YD, tag: "", head: "", rcvStart: "J-RH", leftWaterY: [40, 500], leftFoamY: [130, 580], hydrantFrom: 1 });
D("D-IH", "出荷ヘッダー 始端ドレン", YD, 980, 305, 50, fuel);
pipe(Y1.issL, "D-IH", 50);

// 第2タンクヤード：受入は陸側受入設備から図面上部（y=-280）を回して入る。出荷は y=620 を回して出荷ポンプの吸込へ
const X2 = 2480;
V("V-RY2", "第2タンクヤード 受入元弁", RC, 720, 150, "open", fuel);
J("J-RY1", RC, 720, -280, fuel);
J("J-RY2", YD2, 2350, -280, fuel);
J("J-RYD", YD2, 2350, 100, fuel);
D("D-RY2", "第2ヤード受入配管 低部ドレン", YD2, 2315, 100, 50, fuel);
J("J-RYC", YD2, 2350, 250, fuel);
J("J-R2H", YD2, X2 - 40, 250, fuel);
chain(250, "J-RY", "V-RY2", "J-RY1", "J-RY2", "J-RYD", "J-RYC", "J-R2H");
pipe("J-RYD", "D-RY2", 50);
const Y2 = buildYard({ x0: X2, nos: ["501", "502", "503", "504"], area: YD2, tag: "2", head: "第2ヤード", rcvStart: "J-R2H", leftWaterY: [20, 160], leftFoamY: [90, 200], hydrantFrom: 7 });
D("D-I2H", "第2ヤード出荷ヘッダー 末端ドレン", YD2, X2 + 660, 305, 50, fuel);
pipe(Y2.issR, "D-I2H", 50);
J("J-I2W", YD2, X2 - 40, 280, fuel);
J("J-I2S", SH, X2 - 40, 620, fuel);
V("V-I2", "第2タンクヤード 出荷元弁", SH, 2100, 620, "open", fuel);
J("J-I2P", SH, 1780, 620, fuel);
chain(250, Y2.issL, "J-I2W", "J-I2S", "V-I2", "J-I2P");

// 出荷設備：出荷ポンプ2台 → ローリー出荷場2レーン・空港向けパイプライン
J("J-SP", SH, 1780, 400, fuel);
pipe("J-IHE", "J-SP", 250, [[1780, 280]]);
pipe("J-I2P", "J-SP42", 250);
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
// 消火用水主管（y=700）：各ヤードの消火栓ループ・冷却散水ヘッダーへ分岐、出荷設備の消火栓
V("V-FM1", "消火用水主管 元弁", FM, 700, 700, "open", water);
J("J-FM", FM, 820, 700, water);
pipe("J-FDD", "V-FM1", 300);
pipe("V-FM1", "J-FM", 300);
J("J-WH1", FM, 1800, 700, water);
V("V-WH1", "消火栓 No.1 開閉弁", FM, 1800, 745, "close", water);
node("WH-1", "hydrant", "消火栓 No.1（出荷設備）", FM, 1800, 785, { ...water, label: "WH-1" });
chain(80, "J-WH1", "V-WH1", "WH-1");
J("J-FME", FM, 1900, 700, water);
D("D-FME", "消火用水主管 低部ドレン", FM, 1900, 740, 50, water);
pipe("J-FME", "D-FME", 50);
J("J-FME2", FM, 3280, 700, water);
D("D-FME2", "消火用水主管 末端ドレン", FM, 3280, 740, 50, water);
pipe("J-FME2", "D-FME2", 50);
chain(300, "J-FM", Y1.wFeed, Y1.wRiser, "J-WH1", "J-FME", Y2.wFeed, Y2.wRiser, "J-FME2");

// 泡水溶液主管（y=1020）：各ヤードの泡消火栓ループ・発泡装置ヘッダーへ分岐、泡消火栓
J("J-FSJ", FM, 740, 1020, sol);
J("J-FSM", FM, 820, 1020, sol);
pipe("V-FSM", "J-FSJ", 200);
pipe("J-FSJ", "J-FSM", 200);
const fh = [["1", 1150], ["2", 1550], ["3", 1950]].map(([k, x]) => {
  const j = J(`J-FH${k}`, FM, x, 1020, sol);
  V(`V-FH${k}`, `泡消火栓 No.${k} 開閉弁`, FM, x, 1070, "close", sol);
  node(`FH-${k}`, "hydrant", `泡消火栓 No.${k}`, FM, x, 1110, { ...sol, label: `泡FH-${k}` });
  chain(80, j, `V-FH${k}`, `FH-${k}`);
  return j;
});
J("J-FSE", FM, 2050, 1020, sol);
D("D-FSE", "泡水溶液主管 低部ドレン", FM, 2050, 1060, 50, sol);
pipe("J-FSE", "D-FSE", 50);
J("J-FSE2", FM, 3280, 1020, sol);
D("D-FSE2", "泡水溶液主管 末端ドレン", FM, 3280, 1060, 50, sol);
pipe("J-FSE2", "D-FSE2", 50);
chain(200, "J-FSM", Y1.fFeed, Y1.fRiser, ...fh, "J-FSE", Y2.fFeed, Y2.fRiser, "J-FSE2");

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

const sch40 = [[25, 34.0, 26.6], [40, 48.6, 40.9], [50, 60.5, 52.7], [80, 89.1, 78.1], [100, 114.3, 102.3], [150, 165.2, 154.1], [200, 216.3, 202.7], [250, 267.4, 254.5], [300, 318.5, 304.8]];
const data = {
  facility_id: "virtual-site-2",
  facility_name: "臨海石油基地（仮想・第2拠点）",
  note: "サンプル：臨海石油基地。タンクヤード2か所（各タンク4基を2×2配置）。各タンクの左右に冷却散水・発泡装置を1系統ずつ（ヘッダー → シリンダー弁 → 手動弁）、各ヤード周囲に消火栓ループ（水・泡）",
  sheets: [{ sheet_no: "S1", title: "全体系統図（燃料・消火）", width: 3380, height: 1500, meters_per_unit: 0.25, source_doc_no: null }],
  areas: [
    { name: JT, sheet_no: "S1", x: 30, y: 110 + OY, w: 490, h: 520 },
    { name: RC, sheet_no: "S1", x: 560, y: 180 + OY, w: 300, h: 200 },
    { name: YD, sheet_no: "S1", x: 770, y: -235 + OY, w: 920, h: 900 },
    { name: YD2, sheet_no: "S1", x: 2370, y: -235 + OY, w: 920, h: 900 },
    { name: SH, sheet_no: "S1", x: 1760, y: 300 + OY, w: 610, h: 300 },
    { name: FP, sheet_no: "S1", x: 30, y: 640 + OY, w: 680, h: 470 },
    { name: FM, sheet_no: "S1", x: 730, y: 685 + OY, w: 2600, h: 475 },
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
