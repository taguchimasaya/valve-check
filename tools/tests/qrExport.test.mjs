// QR の SVG 出力：黒い升目を1つの輪郭にまとめる処理（穴・斜めに接する升目）
// 実行：node --import ./tools/tests/register.mjs --test tools/tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { modulesToPath } from "../../src/lib/qrExport.ts";

const grid = (rows) => rows.map((r) => [...r].map((c) => c === "#"));
const count = (d) => (d.match(/M/g) ?? []).length;

test("1升目は4点の四角1つ", () => {
  assert.equal(modulesToPath(grid(["#"])), "M0 0L1 0L1 1L0 1Z");
});

test("つながった升目は1つの輪郭（升目の境目の線は出ない）", () => {
  assert.equal(modulesToPath(grid(["##", "##"])), "M0 0L2 0L2 2L0 2Z");
  assert.equal(count(modulesToPath(grid(["###", "#..", "#.."]))), 1);
});

test("穴あき（QR の位置合わせの枠）は外周と穴の2つ", () => {
  const d = modulesToPath(grid(["###", "#.#", "###"]));
  assert.equal(count(d), 2);
});

test("斜めに接する升目は別々の輪郭", () => {
  assert.equal(count(modulesToPath(grid(["#.", ".#"]))), 2);
});
