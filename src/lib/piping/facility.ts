import type { AreaBox, Facility, NodeKind, PNode, Pipe, ValveState } from "./types";

// 仮想空港給油施設（ローカル試作用）の配管系統。
//
//  受入系統A ─┐                    ┌─ 第1ヤード（T-101〜106）─┐            ┌─ 払出ポンプ系統1 → ハイドラント1
//             ├ 受入連絡管 ─ 移送ポンプ ─ 移送吸込管 ┤  払出連絡管 ┤
//  受入系統B ─┘                    └─ 第2ヤード（T-201〜206）─┘            └─ 払出ポンプ系統2 → ハイドラント2
//
// 各タンクは「受入」「払出」「移送」の3系統の配管を持つ。
// 第2ヤード・受入系統B・払出系統2は、第1側を上下反転した配置で描く（y' = H - y）。

const W = 2700;
const H = 1500;

// タンク中心のx座標（1ヤード6基）
const TANK_X = [840, 1010, 1180, 1350, 1520, 1690];

// 呼び径(A) → 内径(m)（Sch40相当の概算値）
const INNER_DIAMETER_M: Record<number, number> = {
  25: 0.0266,
  40: 0.0409,
  50: 0.0527,
  80: 0.0781,
  100: 0.1023,
  150: 0.1541,
  200: 0.2027,
  250: 0.2545,
  300: 0.3048,
};

export function innerDiameterM(sizeA: number): number {
  return INNER_DIAMETER_M[sizeA] ?? sizeA / 1000;
}

export function buildFacility(): Facility {
  const nodes: PNode[] = [];
  const pipes: Pipe[] = [];
  const areas: AreaBox[] = [];
  let pipeSeq = 0;

  function add(
    id: string,
    kind: NodeKind,
    x: number,
    y: number,
    area: string,
    extra: Partial<PNode> = {}
  ): string {
    nodes.push({ id, kind, label: id, name: extra.name ?? id, x, y, area, ...extra });
    return id;
  }
  const J = (id: string, x: number, y: number, area: string) =>
    add(id, "junction", x, y, area, { label: "" });
  const V = (id: string, name: string, x: number, y: number, normal: ValveState, area: string) =>
    add(id, "valve", x, y, area, { name, normal });

  function pipe(a: string, b: string, sizeA: number, via?: [number, number][]) {
    pipes.push({ id: `P${String(++pipeSeq).padStart(3, "0")}`, a, b, sizeA, via });
  }
  function chain(sizeA: number, ...ids: string[]) {
    for (let i = 0; i < ids.length - 1; i++) pipe(ids[i], ids[i + 1], sizeA);
  }
  function setDir(id: string, upstream: string) {
    const n = nodes.find((v) => v.id === id);
    if (n) n.dirFrom = upstream;
  }
  function drain(
    id: string,
    name: string,
    x: number,
    y: number,
    area: string,
    opts: { sizeA?: number; gauge?: boolean; pumpLpm?: number } = {}
  ) {
    return add(id, "drain", x, y, area, {
      name,
      normal: "close",
      drainSizeA: opts.sizeA ?? 50,
      gaugeMountable: opts.gauge ?? true,
      drainPumpLpm: opts.pumpLpm,
    });
  }

  // ───────────── 受入系統（A / B）─────────────
  function receiving(sys: "A" | "B", Y: (y: number) => number, headerJ: string): string {
    const area = `受入系統${sys}`;
    const p = `R${sys}`; // コード接頭辞
    const src = add(`SRC-${sys}`, "source", 40, Y(300), area, {
      label: `受入口${sys}`,
      name: `受入口${sys}（パイプライン）`,
    });
    const v01 = V(`V-${p}01`, `受入${sys} 受入元弁`, 95, Y(300), "close", area);
    const j1 = J(`J-${p}1`, 140, Y(300), area);
    const psv = add(`PSV-${p}1`, "psv", 140, Y(245), area, {
      name: `受入${sys} 安全弁`,
      setPressureMPa: 1.0,
    });
    pipe(j1, psv, 50);
    const j2 = J(`J-${p}2`, 180, Y(300), area);
    const pi = add(`PI-${p}1`, "gauge", 180, Y(350), area, {
      name: `受入${sys} 圧力計取付口`,
      normal: "close",
      gaugeMountable: true,
    });
    pipe(j2, pi, 25);
    const j3 = J(`J-${p}3`, 220, Y(300), area);
    chain(250, src, v01, j1, j2, j3);

    // ストレーナー 2基（並列）
    const j4 = J(`J-${p}4`, 430, Y(300), area);
    [230, 370].forEach((y, i) => {
      const k = i + 1;
      const vin = V(`V-${p}S${k}I`, `受入${sys} ストレーナー${k} 入口弁`, 265, Y(y), "open", area);
      const str = add(`STR-${p}${k}`, "strainer", 325, Y(y), area, {
        name: `受入${sys} ストレーナー${k}`,
        volumeL: 400,
      });
      const vout = V(`V-${p}S${k}O`, `受入${sys} ストレーナー${k} 出口弁`, 385, Y(y), "open", area);
      const d = drain(`D-${p}S${k}`, `受入${sys} ストレーナー${k} ドレン`, 325, Y(y + 40), area, {
        sizeA: 40,
      });
      pipe(j3, vin, 200, [[220, Y(y)]]);
      chain(200, vin, str, vout);
      pipe(vout, j4, 200, [[430, Y(y)]]);
      fillBranch(`${p}S${k}`, `受入${sys} ストレーナー${k}`, str, d, 325, y, 22, k === 1 ? -1 : 1, k === 1 ? 295 : 358, Y, area);
    });

    // フィルター 3基（並列）
    const j5 = J(`J-${p}5`, 470, Y(300), area);
    pipe(j4, j5, 250);
    const j6 = J(`J-${p}6`, 685, Y(300), area);
    [190, 300, 410].forEach((y, i) => {
      const k = i + 1;
      const straight = y === 300;
      const vin = V(`V-${p}F${k}I`, `受入${sys} フィルター${k} 入口弁`, 510, Y(y), "open", area);
      const flt = add(`FLT-${p}${k}`, "filter", 575, Y(y), area, {
        name: `受入${sys} フィルター${k}`,
        volumeL: 2500,
      });
      const vout = V(`V-${p}F${k}O`, `受入${sys} フィルター${k} 出口弁`, 640, Y(y), "open", area);
      const d = drain(`D-${p}F${k}`, `受入${sys} フィルター${k} ドレン`, 575, Y(y + 46), area, {
        sizeA: 50,
      });
      pipe(j5, vin, 150, straight ? undefined : [[470, Y(y)]]);
      chain(150, vin, flt, vout);
      pipe(vout, j6, 150, straight ? undefined : [[685, Y(y)]]);
      fillBranch(`${p}F${k}`, `受入${sys} フィルター${k}`, flt, d, 575, y, 28, k === 2 ? 1 : -1, [530, 610, 545][i], Y, area);
    });
    pipe(j6, headerJ, 250);

    // 充填ヘッダー：各ストレーナー・フィルターの充填弁を束ね、移送系統へつなぐ
    const fillJ = [...fillHeader].sort((a, b) => a.x - b.x).map((f) => f.j);
    fillHeader.length = 0;
    const fillEnd = J(`J-FL${sys}H`, 700, Y(490), area);
    chain(50, ...fillJ, fillEnd);
    const trv = add(`PSV-FL${sys}`, "psv", 700, Y(465), area, {
      name: `受入${sys} 充填ヘッダー 熱膨張逃し弁`,
      setPressureMPa: 1.0,
    });
    pipe(fillEnd, trv, 25);

    areas.push({ x: 20, y: Math.min(Y(150), Y(515)), w: 690, h: 365, label: `受入系統${sys}` });
    return fillEnd;
  }

  // 容器（ストレーナー・フィルター）下部の分岐 → ドレン口／充填弁 → 充填ヘッダー（y=490）
  const fillHeader: { x: number; j: string }[] = [];
  function fillBranch(
    code: string,
    name: string,
    vessel: string,
    drainId: string,
    vx: number,
    vy: number,
    dt: number,
    side: -1 | 1,
    downX: number,
    Y: (y: number) => number,
    area: string
  ) {
    const tee = J(`J-${code}D`, vx, Y(vy + dt), area);
    pipe(vessel, tee, 50);
    pipe(tee, drainId, 50);
    const fv = add(`V-F${code}`, "valve", vx + side * 18, Y(vy + dt), area, {
      name: `${name} 充填弁`,
      normal: "close",
      service: true,
      fillLine: true,
    });
    pipe(tee, fv, 25);
    const hj = J(`J-F${code}`, downX, Y(490), area);
    pipe(fv, hj, 25, [[downX, Y(vy + dt)]]);
    fillHeader.push({ x: downX, j: hj });
  }

  // ───────────── 貯蔵ヤード（1 / 2）─────────────
  // 返り値：各ヘッダーの端点ジャンクション
  function yard(n: 1 | 2, Y: (y: number) => number) {
    const area = `第${n}ヤード`;
    const rJ: string[] = [];
    const iJ: string[] = [];
    const tJ: string[] = [];

    TANK_X.forEach((tx, i) => {
      const no = `${n}0${i + 1}`;
      const tank = add(`T-${no}`, "tank", tx, Y(140), area, {
        name: `T-${no} 貯蔵タンク`,
        capacityKL: 5000,
      });
      const lines: { key: "R" | "I" | "T"; dx: number; vy: number; hy: number; label: string; arr: string[]; size: number }[] = [
        { key: "R", dx: -40, vy: 225, hy: 300, label: "受入弁", arr: rJ, size: 200 },
        { key: "I", dx: 0, vy: 250, hy: 360, label: "払出弁", arr: iJ, size: 200 },
        { key: "T", dx: 40, vy: 275, hy: 420, label: "移送弁", arr: tJ, size: 150 },
      ];
      lines.forEach((l) => {
        const x = tx + l.dx;
        const v = V(`V-${no}${l.key}`, `T-${no} ${l.label}`, x, Y(l.vy), "close", area);
        const hj = J(`J-${no}${l.key}`, x, Y(l.hy), area);
        if (l.key === "T") {
          pipe(tank, v, l.size, [[x, Y(150)]]);
          pipe(v, hj, l.size);
        } else {
          // 受入弁・払出弁には、ヘッダー側（下流）の圧力をタンク側（上流）へ逃がす逃し弁をバイパスで設ける
          const jt = J(`J-${no}${l.key}T`, x, Y(l.vy - 16), area);
          const jh = J(`J-${no}${l.key}H`, x, Y(l.vy + 16), area);
          const psv = add(`PSV-${no}${l.key}`, "psv", x - 14, Y(l.vy), area, {
            name: `T-${no} ${l.label} 逃し弁（ヘッダー側→タンク側）`,
            setPressureMPa: 1.0,
            dirFrom: jh,
          });
          pipe(tank, jt, l.size, [[x, Y(150)]]);
          chain(l.size, jt, v, jh, hj);
          pipe(jh, psv, 25, [[x - 14, Y(l.vy + 16)]]);
          pipe(psv, jt, 25, [[x - 14, Y(l.vy - 16)]]);
        }
        l.arr.push(hj);
      });
    });

    // 受入ヘッダー：受入連絡管との分岐 → 各タンク → 末端（抜取ポンプ付ドレン）→ バイパス戻り
    const rStart = J(`J-RH${n}`, 730, Y(300), area);
    const rDrainJ = J(`J-RH${n}D`, 1775, Y(300), area);
    const rEnd = J(`J-RH${n}E`, 1800, Y(300), area);
    const rDrain = drain(`D-RH${n}`, `受入ヘッダー${n} 低部ドレン（抜取ポンプ付）`, 1775, Y(255), area, {
      sizeA: 50,
      pumpLpm: 500,
    });
    chain(250, rStart, ...rJ, rDrainJ, rEnd);
    pipe(rDrainJ, rDrain, 50);

    // 払出ヘッダー：始端ドレン → 各タンク → 払出連絡管分岐 → 払出ポンプ吸込マニホールド
    const iStart = J(`J-IH${n}W`, 780, Y(360), area);
    const iDrain = drain(`D-IH${n}`, `払出ヘッダー${n} 始端ドレン（抜取ポンプ付）`, 780, Y(395), area, {
      sizeA: 50,
      pumpLpm: 500,
    });
    pipe(iStart, iDrain, 50);
    const ix = J(`J-IX${n}`, 1880, Y(360), area);
    chain(300, iStart, ...iJ, ix);

    // 移送ヘッダー：始端ドレン → 各タンク → 移送吸込管へ
    const tStart = J(`J-TH${n}W`, 850, Y(420), area);
    const tDrain = drain(`D-TH${n}`, `移送ヘッダー${n} 始端ドレン`, 850, Y(455), area, { sizeA: 40 });
    pipe(tStart, tDrain, 40);
    const tEnd = J(`J-TH${n}E`, 1760, Y(420), area);
    chain(150, tStart, ...tJ, tEnd);

    areas.push({ x: 745, y: Math.min(Y(80), Y(440)), w: 1000, h: 360, label: `第${n}ヤード（T-${n}01〜${n}06）` });
    return { rStart, rEnd, ix, tEnd };
  }

  // ───────────── 払出ポンプ系統（1 / 2）─────────────
  function issueStation(n: 1 | 2, Y: (y: number) => number, ix: string, rEnd: string) {
    const area = `払出ポンプ系統${n}`;
    const rows = [140, 250, 360];
    const suction = rows.map((y, i) =>
      i === 2 ? J(`J-PS${n}`, 1940, Y(y), area) : J(`J-PS${n}${"ab"[i]}`, 1940, Y(y), area)
    );
    pipe(ix, suction[2], 300);
    chain(300, suction[2], suction[1], suction[0]);
    const discharge = rows.map((y, i) => J(`J-PD${n}${i + 1}`, 2390, Y(y), area));
    chain(300, discharge[0], discharge[1], discharge[2]);

    rows.forEach((y, i) => {
      const k = `${n}${i + 1}`;
      const vs = V(`V-P${k}S`, `払出P-${k} 吸込弁`, 1985, Y(y), "open", area);
      const str = add(`STR-P${k}`, "strainer", 2040, Y(y), area, {
        name: `払出P-${k} ストレーナー`,
        volumeL: 150,
      });
      const pump = add(`P-${k}`, "pump", 2105, Y(y), area, { name: `払出ポンプ P-${k}`, volumeL: 60 });
      const cv = add(`CV-P${k}`, "check", 2160, Y(y), area, { name: `払出P-${k} 逆止弁` });
      const vd = V(`V-P${k}D`, `払出P-${k} 吐出弁`, 2205, Y(y), "open", area);
      const flt = add(`FLT-P${k}`, "filter", 2275, Y(y), area, {
        name: `払出P-${k} フィルター`,
        volumeL: 1500,
      });
      const vf = V(`V-P${k}F`, `払出P-${k} フィルター出口弁`, 2340, Y(y), "open", area);
      pipe(suction[i], vs, 200);
      chain(200, vs, str, pump);
      chain(150, pump, cv, vd, flt, vf);
      pipe(vf, discharge[i], 150);
      setDir(pump, str);
      setDir(cv, pump);
      const ds = drain(`D-P${k}S`, `払出P-${k} ストレーナードレン`, 2040, Y(y + 35), area, { sizeA: 25 });
      const df = drain(`D-P${k}F`, `払出P-${k} フィルタードレン`, 2275, Y(y + 42), area, { sizeA: 40 });
      pipe(str, ds, 25);
      pipe(flt, df, 40);
    });

    const out = J(`J-PD${n}O`, 2440, Y(250), area);
    const psv = add(`PSV-P${n}`, "psv", 2440, Y(195), area, {
      name: `払出系統${n} 吐出安全弁`,
      setPressureMPa: 1.4,
    });
    const g = J(`J-PD${n}G`, 2475, Y(250), area);
    const pi = add(`PI-P${n}`, "gauge", 2475, Y(295), area, {
      name: `払出系統${n} 吐出圧力計取付口`,
      normal: "close",
      gaugeMountable: true,
    });
    const vh = V(`V-H${n}`, `ハイドラント${n} 送油弁`, 2530, Y(250), "close", area);
    const sink = add(`HYD-${n}`, "sink", 2615, Y(250), area, {
      label: `ハイドラント${n}`,
      name: `給油ハイドラント系統${n}（エプロン）`,
    });
    chain(300, discharge[1], out, g, vh, sink);
    pipe(out, psv, 50);
    pipe(g, pi, 25);

    // バイパスライン：払出ポンプ吐出 → 受入ヘッダー末端
    const vbp = V(`V-BP${n}`, `払出系統${n} → 受入ヘッダー${n} バイパス弁`, 2390, Y(420), "close", "バイパスライン");
    pipe(discharge[2], vbp, 150);
    pipe(vbp, rEnd, 150, [
      [2390, Y(470)],
      [1800, Y(470)],
    ]);

    areas.push({ x: 1905, y: Math.min(Y(95), Y(440)), w: 690, h: 345, label: `払出ポンプ系統${n}` });
  }

  const top = (y: number) => y;
  const bottom = (y: number) => H - y;

  const y1 = yard(1, top);
  const y2 = yard(2, bottom);
  const fillA = receiving("A", top, y1.rStart);
  const fillB = receiving("B", bottom, y2.rStart);
  issueStation(1, top, y1.ix, y1.rEnd);
  issueStation(2, bottom, y2.ix, y2.rEnd);

  // ───────────── 受入連絡管（第1⇔第2ヤード、移送ポンプ吐出の合流点）─────────────
  const rx = J("J-RX", 730, 750, "受入連絡管");
  const vrx1 = V("V-RX1", "受入連絡弁（第1ヤード側）", 730, 520, "close", "受入連絡管");
  const vrx2 = V("V-RX2", "受入連絡弁（第2ヤード側）", 730, 980, "close", "受入連絡管");
  chain(250, y1.rStart, vrx1, rx, vrx2, y2.rStart);

  // ───────────── 払出連絡管 ─────────────
  const vix = V("V-IX", "払出連絡弁（系統1⇔系統2）", 1880, 750, "close", "払出連絡管");
  chain(300, y1.ix, vix, y2.ix);

  // ───────────── 移送ポンプ設備 ─────────────
  const ta = "移送ポンプ設備";
  const ts = J("J-TS", 1760, 750, ta);
  const vts1 = V("V-TS1", "移送吸込弁（第1ヤード）", 1760, 560, "open", ta);
  const vts2 = V("V-TS2", "移送吸込弁（第2ヤード）", 1760, 940, "open", ta);
  chain(150, y1.tEnd, vts1, ts);
  chain(150, y2.tEnd, vts2, ts);
  const tsd = J("J-TSD", 1680, 750, ta);
  const dts = drain("D-TS", "移送吸込管 ドレン", 1680, 790, ta, { sizeA: 50 });
  pipe(tsd, dts, 50);
  const tp1 = J("J-TP1", 1580, 750, ta);
  const tp2 = J("J-TP2", 1300, 750, ta);
  chain(150, ts, tsd, tp1);
  [700, 800].forEach((y, i) => {
    const k = i + 1;
    const vs = V(`V-TP${k}S`, `移送ポンプ${k} 吸込弁`, 1530, y, "open", ta);
    const pump = add(`TP-${k}`, "transferPump", 1460, y, ta, { name: `移送ポンプ TP-${k}`, volumeL: 30 });
    const cv = add(`CV-TP${k}`, "check", 1400, y, ta, { name: `移送ポンプ${k} 逆止弁` });
    const vd = V(`V-TP${k}D`, `移送ポンプ${k} 吐出弁`, 1350, y, "open", ta);
    pipe(tp1, vs, 100, [[1580, y]]);
    chain(100, vs, pump, cv, vd);
    pipe(vd, tp2, 100, [[1300, y]]);
    setDir(pump, vs);
    setDir(cv, pump);
  });
  const td = J("J-TD", 1240, 750, ta);
  const psvTp = add("PSV-TP", "psv", 1240, 700, ta, { name: "移送ポンプ吐出 安全弁", setPressureMPa: 1.0 });
  pipe(td, psvTp, 50);
  const tdg = J("J-TDG", 1200, 750, ta);
  const piTd = add("PI-TD", "gauge", 1200, 795, ta, {
    name: "移送ポンプ吐出 圧力計取付口",
    normal: "close",
    gaugeMountable: true,
  });
  pipe(tdg, piTd, 25);
  const vtdm = V("V-TDM", "移送吐出主弁（→受入連絡管）", 1000, 750, "open", ta);
  // 充填ライン：移送ポンプ吐出から受入系統A・Bのストレーナー・フィルターへ
  const jfl = add("J-FL", "junction", 1100, 750, ta, { label: "", fillSource: true });
  chain(150, tp2, td, tdg, jfl, vtdm, rx);
  ([["A", fillA, 490], ["B", fillB, 1010]] as const).forEach(([sys, end, y]) => {
    const v = add(`V-FL${sys}`, "valve", 900, y, "充填ライン", {
      name: `受入${sys} 充填元弁（移送系統より）`,
      normal: "close",
      service: true,
      fillLine: true,
    });
    pipe(end, v, 50);
    pipe(v, jfl, 50, [[1100, y]]);
  });
  areas.push({ x: 1170, y: 660, w: 560, h: 180, label: "移送ポンプ設備" });

  return {
    name: "仮想空港 給油施設（ローカル試作）",
    width: W,
    height: H,
    metersPerPx: 0.15,
    nodes,
    pipes,
    areas,
  };
}

let cached: Facility | null = null;
export function getFacility(): Facility {
  if (!cached) cached = buildFacility();
  return cached;
}
