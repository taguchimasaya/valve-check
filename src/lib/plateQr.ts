// 屋外設備の金属銘板（青色の表面層をレーザーで除去して銀色の下地を出すプレート）用の QR コード。
//
// 仕様（固定）：QR Model 2・Version 5・誤り訂正レベル H・Byte モード・37×37 モジュール・
// 1 モジュール 1.0mm・クワイエットゾーン 4 モジュール（4mm）・全体 45×45mm。
// - バージョン・誤り訂正レベルは自動で変えない。URL が Version 5-H（Byte モード 46 バイト）に収まらなければエラー。
// - 完成品は「暗い青の QR ＋ 明るい銀の背景」（明暗を逆にしない）。
//   暗モジュール＝青色層を残す／明モジュールとクワイエットゾーン＝レーザーで除去（銀色）／45mm の外側＝青色のまま。
// - 出力：完成イメージ SVG（Layer A）・レーザー加工 SVG（Layer B：除去する領域だけ）・確認用 PNG・仕様書。
// - 検証：モジュール数（Version 5）、形式情報から読み取った誤り訂正レベル（H）、寸法、
//   独立したデコーダー（jsQR）で PNG を復号して URL と完全一致すること。1 つでも失敗したら出力しない。
//
// QR の升目は画面に描いた QRCodeSVG（qrcode.react、level="H" minVersion={5} boostLevel={false}）から読む。

import jsQR from "jsqr";
import { modulesToPath, readModules } from "./qrExport";

export const PLATE = {
  version: 5,
  ecc: "H",
  modules: 37,
  quiet: 4,
  moduleMm: 1,
  totalMm: 45,
  /** Version 5-H の Byte モードの容量（バイト） */
  maxBytes: 46,
} as const;

/** 完成イメージの色（実物の色合わせ用ではなく、明暗関係の確認用） */
export const PLATE_COLOR = { blue: "#1E4F91", silver: "#C8CDD3" } as const;
/** 確認用 PNG の解像度（1mm あたりの画素数。1 モジュールを整数の画素にする） */
const PX_PER_MM = 20;

/** QRCodeSVG に渡す設定（画面の QR もこれで描く） */
export const PLATE_QR_PROPS = { level: "H" as const, minVersion: PLATE.version, boostLevel: false };

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/** qrcode.react（qrcodegen）が選ぶ符号化モード。英小文字などを含めば Byte */
export function encodingMode(text: string): "Numeric" | "Alphanumeric" | "Byte" {
  if (/^[0-9]*$/.test(text)) return "Numeric";
  if (/^[A-Z0-9 $%*+\-./:]*$/.test(text)) return "Alphanumeric";
  return "Byte";
}

const ECC_OF_BITS: Record<number, "L" | "M" | "Q" | "H"> = { 1: "L", 0: "M", 3: "Q", 2: "H" };

/**
 * 升目の形式情報（左上の位置検出パターンの周り）から、誤り訂正レベルとマスクを読む。BCH 符号の検査も行う。
 * 形式情報の並び：qrcodegen の drawFormatBits と同じ（bit0〜5 は列8・行0〜5、bit6 は (8,7)、bit7 は (8,8)、bit8 は (7,8)、bit9〜14 は行8・列5〜0）
 */
export function readFormatInfo(m: boolean[][]): { ecc: "L" | "M" | "Q" | "H"; mask: number } | null {
  const at = (x: number, y: number) => (m[y]?.[x] ? 1 : 0);
  let bits = 0;
  for (let i = 0; i <= 5; i++) bits |= at(8, i) << i;
  bits |= at(8, 7) << 6;
  bits |= at(8, 8) << 7;
  bits |= at(7, 8) << 8;
  for (let i = 9; i < 15; i++) bits |= at(14 - i, 8) << i;
  bits ^= 0x5412;
  const data = bits >> 10;
  // BCH(15,5) の検査
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  if (((data << 10) | (rem & 0x3ff)) !== bits) return null;
  return { ecc: ECC_OF_BITS[data >> 3], mask: data & 7 };
}

export type PlateFiles = {
  previewSvg: string;
  laserSvg: string;
  previewPng: Blob;
  spec: string;
  /** ファイル名の頭（例：V-DA1-V5-H） */
  base: string;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function svgHead(title: string, desc: string) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" ` +
    `width="${PLATE.totalMm}mm" height="${PLATE.totalMm}mm" viewBox="0 0 ${PLATE.totalMm} ${PLATE.totalMm}" shape-rendering="crispEdges">\n` +
    `<title>${esc(title)}</title>\n<desc>${esc(desc)}</desc>\n`
  );
}

/** 完成イメージ（Layer A）：銀色の背景（クワイエットゾーンを含む 45mm 角）に、青い暗モジュール */
export function buildPreviewSvg(m: boolean[][], url: string): string {
  const dark = modulesToPath(m, PLATE.quiet);
  return (
    svgHead(
      `QR 完成イメージ（Version 5-H・45mm）`,
      `Layer A：完成イメージ確認用（加工には使わない）。青＝青色の表面層を残す暗モジュール、銀＝レーザーで除去した下地（明モジュール・クワイエットゾーン）。格納URL：${url}`
    ) +
    `<g id="layer-A-preview" inkscape:groupmode="layer" inkscape:label="A_完成イメージ（加工しない）">\n` +
    `<rect id="silver-background" x="0" y="0" width="${PLATE.totalMm}" height="${PLATE.totalMm}" fill="${PLATE_COLOR.silver}"/>\n` +
    `<path id="dark-modules-blue" fill="${PLATE_COLOR.blue}" fill-rule="evenodd" d="${dark}"/>\n` +
    `</g>\n</svg>\n`
  );
}

/**
 * レーザー加工（Layer B）：レーザーで除去する領域だけ（明モジュール＋クワイエットゾーン）を、黒の塗りつぶし 1 つで表す。
 * 45mm 角から暗モジュールをくり抜いた形（evenodd）。暗モジュール（残す部分）には図形を置かない。
 */
export function buildLaserSvg(m: boolean[][], url: string): string {
  const s = PLATE.totalMm;
  const dark = modulesToPath(m, PLATE.quiet);
  return (
    svgHead(
      `QR レーザー加工データ（除去領域のみ・Version 5-H・45mm）`,
      `Layer B：レーザー加工用。黒の塗りつぶし＝レーザーを照射して青色の表面層を除去する領域（明モジュールとクワイエットゾーン）。` +
        `図形の無い部分（暗モジュール）は加工しない＝青色層を残す。45mm 角の外側は加工しない。` +
        `加工ソフトでは塗りつぶし（フィル）彫刻として扱い、黒＝加工の解釈になっていることを必ず確認すること。格納URL：${url}`
    ) +
    `<g id="layer-B-laser-remove" inkscape:groupmode="layer" inkscape:label="B_レーザー除去（照射する）">\n` +
    `<path id="laser-remove-area" fill="#000000" fill-rule="evenodd" d="M0 0H${s}V${s}H0Z${dark}"/>\n` +
    `</g>\n</svg>\n`
  );
}

/** 完成イメージの PNG（確認用）。1 モジュールを整数の画素で塗る */
async function previewPng(m: boolean[][]): Promise<{ blob: Blob; image: ImageData }> {
  const n = m.length;
  const px = PX_PER_MM * PLATE.moduleMm;
  const size = PLATE.totalMm * PX_PER_MM;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas が使えません");
  ctx.fillStyle = PLATE_COLOR.silver;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = PLATE_COLOR.blue;
  const q = PLATE.quiet * px;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) ctx.fillRect(q + x * px, q + y * px, px, px);
  const image = ctx.getImageData(0, 0, size, size);
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("PNG を作れませんでした"))), "image/png"));
  return { blob, image };
}

/** SVG を画像にして画素を読む（レーザー加工データの形の検証用） */
async function rasterizeSvg(svg: string, sizePx: number): Promise<ImageData> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = sizePx;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, sizePx, sizePx);
    ctx.drawImage(img, 0, 0, sizePx, sizePx);
    return ctx.getImageData(0, 0, sizePx, sizePx);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 読み取る。invert のときは画素の明暗を反転してから読む（jsQR の onlyInvert は不具合で例外になるため自前で反転） */
function decode(img: ImageData, invert = false) {
  const data = invert ? new Uint8ClampedArray(img.data) : img.data;
  if (invert) for (let i = 0; i < data.length; i += 4) [data[i], data[i + 1], data[i + 2]] = [255 - data[i], 255 - data[i + 1], 255 - data[i + 2]];
  return jsQR(data, img.width, img.height, { inversionAttempts: "dontInvert" });
}

/**
 * 銘板用の一式を作り、すべて検証する。どれか 1 つでも失敗したら例外（出力しない）。
 * svg は画面の QRCodeSVG（PLATE_QR_PROPS で描いたもの）
 */
export async function buildPlateFiles(svg: SVGSVGElement, code: string, url: string, issuedBy?: string): Promise<PlateFiles> {
  const bytes = utf8Bytes(url);
  if (bytes > PLATE.maxBytes) {
    throw new Error(`URL が Version 5-H に収まりません（${bytes}バイト／上限 ${PLATE.maxBytes}バイト）。バージョンは変更していません：${url}`);
  }
  const mode = encodingMode(url);
  if (mode !== "Byte") throw new Error(`Byte モードになりません（${mode}）：${url}`);
  const m = readModules(svg);
  const checks: string[] = [];
  const fail = (t: string) => {
    throw new Error(`${code}：${t}（出力しません）`);
  };
  // 規格の検証
  if (m.length !== PLATE.modules) fail(`モジュール数が ${m.length}×${m.length} です（Version 5 は 37×37）`);
  checks.push(`[OK] モジュール数 ${m.length}×${m.length} → Version ${(m.length - 17) / 4}`);
  const fmt = readFormatInfo(m);
  if (!fmt) fail("形式情報（誤り訂正レベル・マスク）を読み取れません");
  if (fmt!.ecc !== PLATE.ecc) fail(`誤り訂正レベルが ${fmt!.ecc} です（H であること）`);
  checks.push(`[OK] 形式情報から読んだ誤り訂正レベル ${fmt!.ecc}（BCH 検査一致）・マスクパターン ${fmt!.mask}`);
  checks.push(`[OK] 符号化モード ${mode}（${bytes}バイト／Version 5-H の容量 ${PLATE.maxBytes}バイト）`);
  // 位置検出パターン（7×7）とタイミングパターン
  const finderOk = [
    [0, 0],
    [m.length - 7, 0],
    [0, m.length - 7],
  ].every(([fx, fy]) => {
    for (let y = 0; y < 7; y++)
      for (let x = 0; x < 7; x++) {
        const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
        if (m[fy + y][fx + x] !== (ring !== 2)) return false;
      }
    return true;
  });
  if (!finderOk) fail("位置検出パターンが規格と一致しません");
  const timingOk = Array.from({ length: m.length - 16 }, (_, i) => i + 8).every((i) => m[6][i] === (i % 2 === 0) && m[i][6] === (i % 2 === 0));
  if (!timingOk) fail("タイミングパターンが規格と一致しません");
  // Version 5 のアライメントパターン（中心 30,30 の 5×5）
  const alignOk = (() => {
    for (let y = -2; y <= 2; y++)
      for (let x = -2; x <= 2; x++) if (m[30 + y][30 + x] !== (Math.max(Math.abs(x), Math.abs(y)) !== 1)) return false;
    return true;
  })();
  if (!alignOk) fail("アライメントパターンが規格と一致しません");
  checks.push("[OK] 位置検出パターン（3か所）・タイミングパターン・アライメントパターン（中心 30,30）が規格どおり");

  const previewSvg = buildPreviewSvg(m, url);
  const laserSvg = buildLaserSvg(m, url);
  // 寸法の検証（SVG の実寸と viewBox、1 モジュール＝1mm）
  const dimOk =
    previewSvg.includes(`width="45mm" height="45mm" viewBox="0 0 45 45"`) && laserSvg.includes(`width="45mm" height="45mm" viewBox="0 0 45 45"`);
  if (!dimOk || PLATE.quiet * 2 + m.length !== PLATE.totalMm) fail("SVG の寸法が仕様と一致しません");
  checks.push(`[OK] 寸法：1モジュール ${PLATE.moduleMm}mm、QR本体 ${m.length}mm角、クワイエットゾーン ${PLATE.quiet}mm、全体 ${PLATE.totalMm}mm角（width/height=45mm・viewBox 0 0 45 45）`);

  // 読み取りの検証（独立したデコーダー jsQR）
  const png = await previewPng(m);
  const r1 = decode(png.image);
  if (!r1) fail("完成イメージ PNG を読み取れません");
  if (r1!.data !== url) fail(`完成イメージ PNG の復号結果が一致しません（${r1!.data}）`);
  if (r1!.version !== PLATE.version) fail(`復号したバージョンが ${r1!.version} です`);
  checks.push(`[OK] 完成イメージ PNG を jsQR で復号：「${r1!.data}」＝指定URLと完全一致（Version ${r1!.version}）`);
  const sw = await rasterizeSvg(previewSvg, PLATE.totalMm * PX_PER_MM);
  const r2 = decode(sw);
  if (!r2 || r2.data !== url) fail("完成イメージ SVG を画像にして読み取れない、または一致しません");
  checks.push("[OK] 完成イメージ SVG を画像にして jsQR で復号：指定URLと完全一致");
  // レーザー加工データは「黒＝除去（銀になる）」なので、明暗を反転して読む（形が正しいかの確認）
  const lw = await rasterizeSvg(laserSvg, PLATE.totalMm * PX_PER_MM);
  const r3 = decode(lw, true);
  if (!r3 || r3.data !== url) fail("レーザー加工 SVG（除去領域）を反転して読み取れない、または一致しません");
  checks.push("[OK] レーザー加工 SVG の除去領域を反転（加工後の明暗）して jsQR で復号：指定URLと完全一致");

  const base = `${code}-V5-H`;
  const spec = [
    "QRコード仕様書（屋外設備 金属銘板・レーザー刻印用）",
    "================================================",
    `機器番号        : ${code}`,
    `格納URL         : ${url}`,
    `データ長        : ${bytes} バイト（UTF-8）`,
    "QRコード規格    : Model 2",
    `バージョン      : Version ${PLATE.version}（固定。自動変更なし）`,
    `誤り訂正レベル  : ${PLATE.ecc}（約30%復元。固定。自動変更なし）`,
    `データ形式      : ${mode} Mode`,
    `マスクパターン  : ${fmt!.mask}（規格のペナルティ評価で自動選択）`,
    `モジュール数    : ${PLATE.modules} × ${PLATE.modules}`,
    `モジュール寸法  : ${PLATE.moduleMm.toFixed(1)} mm`,
    `QRコード本体    : ${PLATE.modules} × ${PLATE.modules} mm`,
    `クワイエットゾーン: ${PLATE.quiet} モジュール（${PLATE.quiet} mm）`,
    `全体寸法        : ${PLATE.totalMm} × ${PLATE.totalMm} mm`,
    "",
    "配色・加工",
    "  暗モジュール      : 青色の表面層を残す（加工しない）",
    "  明モジュール      : レーザーで青色層を除去（銀色の下地）",
    "  クワイエットゾーン: レーザーで青色層を除去（銀色の下地）",
    "  45mm角の外側      : 青色のプレートのまま（加工しない）",
    "  → 完成品は「暗い青のQR＋明るい銀の背景」（明暗の反転なし）",
    "",
    "ファイル",
    `  ${base}-preview.svg : Layer A 完成イメージ確認用（加工に使わない）`,
    `  ${base}-laser.svg   : Layer B レーザー加工用。黒の塗りつぶし＝除去（照射）する領域だけ。図形の無い所は加工しない`,
    `  ${base}-preview.png : 目視確認用（${PLATE.totalMm * PX_PER_MM}×${PLATE.totalMm * PX_PER_MM}px、1mm=${PX_PER_MM}px）`,
    "",
    "検証結果",
    ...checks.map((c) => `  ${c}`),
    "",
    "製造時に確認すること（加工条件は未確定のため、加工前に必ず確認）",
    "  - 加工ソフトに読み込んだ寸法が 45.0 × 45.0 mm であること（読み込み時の拡大縮小・DPI 設定）",
    "  - レーザー加工 SVG を「塗りつぶし（フィル）彫刻」で加工すること（ライン彫刻では輪郭だけになる）",
    "  - 加工ソフトが「黒＝加工」と解釈していること（ソフトにより白黒の解釈が異なる）",
    "  - 出力・速度・走査間隔・パス回数などの加工条件（未指定。試し加工で青色層が完全に除去されることを確認）",
    "  - ビーム径・熱による広がりで暗モジュールが細らないこと（必要なら補正量を試し加工で決める）",
    "  - 試し加工品をスマートフォンなど複数の読み取り機で、屋外の明るさ・角度でも読めること",
    "",
    `作成日時        : ${new Date().toLocaleString("ja-JP")}${issuedBy ? `（${issuedBy}）` : ""}`,
    "",
  ].join("\r\n");

  return { previewSvg, laserSvg, previewPng: png.blob, spec, base };
}
