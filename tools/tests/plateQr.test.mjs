// 銘板用QR（Version 5-H 固定）：形式情報の読み取り・符号化モード・容量
// 実行：node --import ./tools/tests/register.mjs --test tools/tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodingMode, PLATE, readFormatInfo } from "../../src/lib/plateQr.ts";

/** qrcodegen と同じ手順で、形式情報だけを置いた 37×37 の升目を作る */
function withFormat(eccBits, mask) {
  const m = Array.from({ length: 37 }, () => Array(37).fill(false));
  const data = (eccBits << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const get = (i) => ((bits >> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) m[i][8] = get(i);
  m[7][8] = get(6);
  m[8][8] = get(7);
  m[8][7] = get(8);
  for (let i = 9; i < 15; i++) m[8][14 - i] = get(i);
  return m;
}

test("形式情報から誤り訂正レベルとマスクを読む（H=2, L=1, M=0, Q=3）", () => {
  assert.deepEqual(readFormatInfo(withFormat(2, 2)), { ecc: "H", mask: 2 });
  assert.deepEqual(readFormatInfo(withFormat(1, 5)), { ecc: "L", mask: 5 });
  assert.deepEqual(readFormatInfo(withFormat(0, 0)), { ecc: "M", mask: 0 });
  assert.deepEqual(readFormatInfo(withFormat(3, 7)), { ecc: "Q", mask: 7 });
});

test("形式情報が壊れていれば読まない（BCH 検査）", () => {
  const m = withFormat(2, 2);
  m[0][8] = !m[0][8];
  m[1][8] = !m[1][8];
  m[2][8] = !m[2][8];
  m[3][8] = !m[3][8];
  assert.equal(readFormatInfo(m), null);
});

test("URL は Byte モード、容量は Version 5-H の 46 バイト", () => {
  assert.equal(encodingMode("https://valve-check.vercel.app/inspect/V-DA1"), "Byte");
  assert.equal(encodingMode("HTTPS://X"), "Alphanumeric");
  assert.equal(PLATE.maxBytes, 46);
  assert.equal(PLATE.modules, 17 + 4 * PLATE.version);
  assert.equal(PLATE.modules + PLATE.quiet * 2, PLATE.totalMm);
  assert.equal(new TextEncoder().encode("https://valve-check.vercel.app/inspect/V-DA1").length, 44);
});
