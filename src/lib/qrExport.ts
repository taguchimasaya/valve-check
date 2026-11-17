// QRコードを画像ファイル（PNG・SVG）として書き出す。
// 用途：Falcon Design Space（レーザー加工機）などのソフトに読み込んでラベルを作る。
// - PNG：QR＋機器番号＋名称の入ったラベル画像（白地・黒、約1200px）
// - SVG：QRだけのベクター（拡大しても荒れない。文字はソフト側で入れる）
// 画面に描画済みの QRCodeSVG（qrcode.react）の <svg> を元に作るので、QRの中身は印刷と同じ。

export type QrExportItem = {
  code: string; // 機器番号（ファイル名にも使う）
  name: string; // 名称
  sub?: string; // 補足（区画・種別など）
};

export type QrExportFormat = "png" | "svg";

const QUIET = 4; // QRの周りの余白（モジュール数）。読み取りに必要
const SVG_SIZE_MM = 30; // SVG を読み込んだときの初期サイズ（ソフト側で変更可）

/** 画面上の data-qr-export 属性つき要素から、その機器の QR の <svg> を探す */
export function findQrSvg(code: string): SVGSVGElement | null {
  return document.querySelector(`[data-qr-export="${CSS.escape(code)}"] svg`);
}

/** QR の <svg> から、モジュール数と「黒」の path を取り出す */
function readQr(svg: SVGSVGElement) {
  const n = svg.viewBox.baseVal?.width || Number(svg.getAttribute("viewBox")?.split(/\s+/)[2]) || 0;
  const paths = [...svg.querySelectorAll("path")];
  // qrcode.react は背景（白）と前景（黒）の2本の path を出す。前景は最後の path
  const fg = paths[paths.length - 1]?.getAttribute("d") ?? "";
  return { n, fg };
}

/** QRだけのベクター SVG（余白つき・白地・黒） */
export function buildQrSvg(svg: SVGSVGElement): string {
  const { n, fg } = readQr(svg);
  const total = n + QUIET * 2;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_SIZE_MM}mm" height="${SVG_SIZE_MM}mm" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="#FFFFFF"/>` +
    `<path transform="translate(${QUIET} ${QUIET})" fill="#000000" d="${fg}"/>` +
    `</svg>\n`
  );
}

/** 横幅に収まるまで文字を小さくして描く */
function fitText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, size: number, weight: string) {
  let s = size;
  do {
    ctx.font = `${weight} ${s}px "Noto Sans JP", "Yu Gothic", "Meiryo", sans-serif`;
    if (ctx.measureText(text).width <= maxW) break;
    s -= 2;
  } while (s > 12);
  ctx.fillText(text, x, y, maxW);
  return s;
}

/** QR＋文字のラベル PNG（白地・黒） */
export async function buildQrPng(svg: SVGSVGElement, item: QrExportItem): Promise<Blob> {
  const { n } = readQr(svg);
  const scale = Math.max(4, Math.floor(1000 / (n + QUIET * 2))); // 1モジュールを整数 px にして境目をくっきりさせる
  const qrPx = n * scale;
  const pad = QUIET * scale;
  const width = qrPx + pad * 2;
  const lines = [item.code, item.name, item.sub].filter(Boolean) as string[];
  const textH = lines.length ? Math.round(width * 0.09) + (lines.length - 1) * Math.round(width * 0.06) + pad : 0;
  const height = width + textH;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas が使えません");
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, width, height);

  // 画面の <svg> を高解像度で描き直す
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(qrPx));
  clone.setAttribute("height", String(qrPx));
  clone.setAttribute("shape-rendering", "crispEdges");
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, pad, pad, qrPx, qrPx);
  } finally {
    URL.revokeObjectURL(url);
  }

  ctx.fillStyle = "#000000";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const maxW = width - pad * 2;
  let y = width - Math.round(pad * 0.4);
  lines.forEach((t, i) => {
    const size = i === 0 ? Math.round(width * 0.08) : Math.round(width * 0.05);
    fitText(ctx, t, width / 2, y, maxW, size, i === 0 ? "bold" : "normal");
    y += i === 0 ? Math.round(width * 0.09) : Math.round(width * 0.06);
  });

  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("画像を作れませんでした"))), "image/png")
  );
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
export async function exportQrImages(items: QrExportItem[], format: QrExportFormat, zipName: string) {
  const files: { name: string; blob: Blob }[] = [];
  const used = new Set<string>();
  for (const item of items) {
    const svg = findQrSvg(item.code);
    if (!svg) continue;
    const blob =
      format === "svg"
        ? new Blob([buildQrSvg(svg)], { type: "image/svg+xml" })
        : await buildQrPng(svg, item);
    let base = safeFileName(item.code);
    for (let i = 2; used.has(base); i++) base = `${safeFileName(item.code)}_${i}`;
    used.add(base);
    files.push({ name: `${base}.${format}`, blob });
  }
  if (files.length === 0) return 0;
  if (files.length === 1) downloadBlob(files[0].blob, files[0].name);
  else downloadBlob(await buildZip(files), `${safeFileName(zipName)}.zip`);
  return files.length;
}
