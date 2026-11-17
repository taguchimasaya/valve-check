// QRコードを画像ファイル（PNG・SVG）として書き出す。
// 用途：Falcon Design Space（レーザー加工機）などのソフトに読み込んでラベルを作る。
// - PNG：QR＋機器番号・名称の入ったラベル画像（白地・黒）
// - SVG：ベクター（拡大しても荒れない）。QR＋文字、または QR だけ
// 並べ方は「縦（QRの下に文字）」と「横（左に文字・右にQR）」。PNG と SVG は同じ配置で作る。
// SVG の QR は黒い部分を1つの輪郭（穴あき）にまとめる（升目ごとの線が出ないように）。
// 画面に描画済みの QRCodeSVG（qrcode.react）の <svg> を元に作るので、QRの中身は印刷と同じ。

export type QrExportItem = {
  code: string; // 機器番号（ファイル名にも使う）
  name: string; // 名称
  sub?: string; // 補足（区画・種別など）
};

export type QrExportFormat = "png" | "svg" | "svg-qr";
export type QrLayout = "vertical" | "horizontal";

const QUIET = 4; // QRの周りの余白（モジュール数）。読み取りに必要
const SVG_QR_MM = 30; // SVG を読み込んだときの QR の大きさ（ソフト側で変更可）
const FONT = `"Noto Sans JP", "Yu Gothic", "YuGothic", "Meiryo", sans-serif`;

/** 画面上の data-qr-export 属性つき要素から、その機器の QR の <svg> を探す */
export function findQrSvg(code: string): SVGSVGElement | null {
  return document.querySelector(`[data-qr-export="${CSS.escape(code)}"] svg`);
}

/** qrcode.react の <svg> から QR の升目（true＝黒）を読み取る */
export function readModules(svg: SVGSVGElement): boolean[][] {
  const n = svg.viewBox.baseVal?.width || Number(svg.getAttribute("viewBox")?.split(/\s+/)[2]) || 0;
  const paths = [...svg.querySelectorAll("path")];
  const d = paths[paths.length - 1]?.getAttribute("d") ?? ""; // 前景（黒）は最後の path
  const m = Array.from({ length: n }, () => Array<boolean>(n).fill(false));
  // 各行の黒の並び：M{x} {y}h{長さ}v1H{x}z（区切りは空白かカンマ）
  for (const r of d.matchAll(/M(\d+)[ ,](\d+)\s*h(\d+)/g)) {
    const [x, y, len] = [Number(r[1]), Number(r[2]), Number(r[3])];
    for (let i = 0; i < len; i++) if (m[y] && x + i < n) m[y][x + i] = true;
  }
  return m;
}

/**
 * 黒い升目をまとめた輪郭の path（升目単位）。黒の外周は時計回り、白い穴は反時計回り（evenodd でも nonzero でも同じ形）。
 * 斜めに接する升目は別々の輪郭にする（右折を優先してたどる）。
 */
export function modulesToPath(m: boolean[][], offset = 0): string {
  const n = m.length;
  const dark = (x: number, y: number) => x >= 0 && y >= 0 && y < n && x < n && m[y][x];
  type E = { x1: number; y1: number; x2: number; y2: number; used?: boolean };
  const out = new Map<string, E[]>();
  const add = (x1: number, y1: number, x2: number, y2: number) => {
    const k = `${x1},${y1}`;
    const e: E = { x1, y1, x2, y2 };
    out.set(k, [...(out.get(k) ?? []), e]);
  };
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (!m[y][x]) continue;
      if (!dark(x, y - 1)) add(x, y, x + 1, y);
      if (!dark(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!dark(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!dark(x - 1, y)) add(x, y + 1, x, y);
    }
  const parts: string[] = [];
  for (const list of out.values())
    for (const start of list) {
      if (start.used) continue;
      const pts: [number, number][] = [];
      let e = start;
      while (!e.used) {
        e.used = true;
        pts.push([e.x1, e.y1]);
        const dx = e.x2 - e.x1;
        const dy = e.y2 - e.y1;
        const next = (out.get(`${e.x2},${e.y2}`) ?? []).filter((c) => !c.used);
        if (!next.length) break;
        // 右折 → 直進 → 左折 の順（画面座標で右折は (-dy, dx)）
        const order = [
          [-dy, dx],
          [dx, dy],
          [dy, -dx],
        ];
        e = order.map(([ax, ay]) => next.find((c) => c.x2 - c.x1 === ax && c.y2 - c.y1 === ay)).find(Boolean) ?? next[0];
      }
      // 一直線に並ぶ点を省く
      const simple = pts.filter((p, i) => {
        const a = pts[(i - 1 + pts.length) % pts.length];
        const b = pts[(i + 1) % pts.length];
        return (b[0] - a[0]) * (p[1] - a[1]) !== (b[1] - a[1]) * (p[0] - a[0]);
      });
      parts.push("M" + simple.map(([x, y]) => `${x + offset} ${y + offset}`).join("L") + "Z");
    }
  return parts.join("");
}

// ───── 配置（PNG と SVG で共通。単位は px） ─────

type TextItem = { text: string; x: number; y: number; size: number; bold: boolean; anchor: "start" | "middle" };
type Layout = { width: number; height: number; qrX: number; qrY: number; scale: number; n: number; texts: TextItem[] };

let measureCtx: CanvasRenderingContext2D | null = null;
function measure(text: string, size: number, bold: boolean) {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * size;
  measureCtx.font = `${bold ? "bold " : ""}${size}px ${FONT}`;
  return measureCtx.measureText(text).width;
}

/** 幅に収まるよう、文字を小さくし、それでも長ければ2行に分ける */
function fitLines(text: string, maxW: number, size: number, bold: boolean, minRatio = 0.6): { lines: string[]; size: number } {
  for (let s = size; s >= size * minRatio; s -= Math.max(1, size * 0.04)) if (measure(text, s, bold) <= maxW) return { lines: [text], size: s };
  const s = size * minRatio;
  // 2行に分ける（できるだけ均等に。空白・括弧の前で切れれば優先）
  let best = Math.ceil(text.length / 2);
  for (let i = best - 4; i <= best + 4; i++) if (i > 0 && i < text.length && /[\s（(・]/.test(text[i])) best = i;
  const lines = [text.slice(0, best).trim(), text.slice(best).trim()];
  let s2 = s;
  while (s2 > 8 && lines.some((l) => measure(l, s2, bold) > maxW)) s2 -= 1;
  return { lines, size: s2 };
}

function layoutOf(n: number, item: QrExportItem | null, mode: QrLayout): Layout {
  const scale = Math.max(4, Math.floor(1000 / (n + QUIET * 2))); // 1升目を整数 px にして境目をくっきり
  const block = (n + QUIET * 2) * scale; // 余白を含む QR の大きさ
  const pad = QUIET * scale;
  const raw = item ? ([item.code, item.name, item.sub].filter(Boolean) as string[]) : [];
  if (!raw.length) return { width: block, height: block, qrX: pad, qrY: pad, scale, n, texts: [] };

  if (mode === "horizontal") {
    // 左に文字（左寄せ・上下中央）、右に QR
    const textW = Math.round(block * 1.3);
    const maxW = textW - pad;
    const blocks = raw.map((t, i) => {
      const r = fitLines(t, maxW, i === 0 ? block * 0.14 : block * 0.075, i === 0);
      return { ...r, bold: i === 0, gap: (i === 0 ? 0.35 : 0.25) * r.size };
    });
    const lineH = (b: { size: number }) => b.size * 1.25;
    const total = blocks.reduce((s, b) => s + b.lines.length * lineH(b) + b.gap, 0) - blocks[blocks.length - 1].gap;
    let y = (block - total) / 2;
    const texts: TextItem[] = [];
    for (const b of blocks) {
      for (const l of b.lines) {
        texts.push({ text: l, x: pad, y: y + b.size * 0.88, size: b.size, bold: b.bold, anchor: "start" });
        y += lineH(b);
      }
      y += b.gap;
    }
    return { width: textW + block, height: block, qrX: textW + pad, qrY: pad, scale, n, texts };
  }

  // 縦：QR の下に文字（中央寄せ）
  const maxW = block - pad * 2;
  const texts: TextItem[] = [];
  let y = block - pad * 0.4;
  raw.forEach((t, i) => {
    const r = fitLines(t, maxW, i === 0 ? block * 0.08 : block * 0.05, i === 0);
    for (const l of r.lines) {
      texts.push({ text: l, x: block / 2, y: y + r.size * 0.88, size: r.size, bold: i === 0, anchor: "middle" });
      y += r.size * 1.2;
    }
    y += i === 0 ? r.size * 0.1 : 0;
  });
  return { width: block, height: Math.round(y + pad * 0.6), qrX: pad, qrY: pad, scale, n, texts };
}

// ───── 書き出し ─────

/** ベクター SVG（QR は輪郭の path、文字は <text>）。文字なしなら QR だけ */
export function buildQrSvg(svg: SVGSVGElement, item: QrExportItem | null, mode: QrLayout = "vertical"): string {
  const m = readModules(svg);
  const L = layoutOf(m.length, item, mode);
  const mmPerPx = SVG_QR_MM / ((m.length + QUIET * 2) * L.scale);
  const mm = (v: number) => `${+(v * mmPerPx).toFixed(2)}mm`;
  const escXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const texts = L.texts
    .map(
      (t) =>
        `<text x="${t.x.toFixed(1)}" y="${t.y.toFixed(1)}" font-family='${FONT}' font-size="${t.size.toFixed(1)}"${t.bold ? ' font-weight="bold"' : ""} text-anchor="${t.anchor}" fill="#000000">${escXml(t.text)}</text>`
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${mm(L.width)}" height="${mm(L.height)}" viewBox="0 0 ${L.width} ${Math.round(L.height)}">` +
    `<rect width="${L.width}" height="${Math.round(L.height)}" fill="#FFFFFF"/>` +
    `<path transform="translate(${L.qrX} ${L.qrY}) scale(${L.scale})" fill="#000000" fill-rule="evenodd" d="${modulesToPath(m)}"/>` +
    texts +
    `</svg>\n`
  );
}

/** QR＋文字のラベル PNG（白地・黒） */
export async function buildQrPng(svg: SVGSVGElement, item: QrExportItem, mode: QrLayout = "vertical"): Promise<Blob> {
  const m = readModules(svg);
  const L = layoutOf(m.length, item, mode);
  const canvas = document.createElement("canvas");
  canvas.width = L.width;
  canvas.height = Math.round(L.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas が使えません");
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000000";
  // 升目を整数 px の四角で塗る（にじまない）
  m.forEach((row, y) => row.forEach((on, x) => on && ctx.fillRect(L.qrX + x * L.scale, L.qrY + y * L.scale, L.scale, L.scale)));
  ctx.textBaseline = "alphabetic";
  for (const t of L.texts) {
    ctx.font = `${t.bold ? "bold " : ""}${t.size}px ${FONT}`;
    ctx.textAlign = t.anchor === "middle" ? "center" : "left";
    ctx.fillText(t.text, t.x, t.y);
  }
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("画像を作れませんでした"))), "image/png"));
}

/** ファイル名に使えない文字を置き換える */
export function safeFileName(s: string) {
  return s.replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^\.+/, "") || "qr";
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- ZIP（無圧縮）。PNG/SVG をまとめて1ファイルでダウンロードするため ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export async function buildZip(files: { name: string; blob: Blob }[]): Promise<Blob> {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;

  for (const f of files) {
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const name = enc.encode(f.name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // ファイル名は UTF-8
    lv.setUint16(8, 0, true); // 無圧縮
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, data);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);
    offset += local.length + data.length;
  }

  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}

/** 1件ならそのファイル、複数なら ZIP でダウンロードする */
export async function exportQrImages(items: QrExportItem[], format: QrExportFormat, zipName: string, layout: QrLayout = "vertical") {
  const files: { name: string; blob: Blob }[] = [];
  const used = new Set<string>();
  const ext = format === "png" ? "png" : "svg";
  for (const item of items) {
    const svg = findQrSvg(item.code);
    if (!svg) continue;
    const blob =
      format === "png"
        ? await buildQrPng(svg, item, layout)
        : new Blob([buildQrSvg(svg, format === "svg" ? item : null, layout)], { type: "image/svg+xml" });
    let base = safeFileName(item.code);
    for (let i = 2; used.has(base); i++) base = `${safeFileName(item.code)}_${i}`;
    used.add(base);
    files.push({ name: `${base}.${ext}`, blob });
  }
  if (files.length === 0) return 0;
  if (files.length === 1) downloadBlob(files[0].blob, files[0].name);
  else downloadBlob(await buildZip(files), `${safeFileName(zipName)}.zip`);
  return files.length;
}
