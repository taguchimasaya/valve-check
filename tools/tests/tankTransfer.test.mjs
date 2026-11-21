// タンク間移送（ドレンタンク → スロップタンクなど）と、仮想空港のドレン設備（プログラム内の仮想施設で確かめる）
// 実行：node --import ./tools/tests/register.mjs --test tools/tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, normalValveState } from "../../src/lib/piping/graph.ts";
import { getFacility } from "../../src/lib/piping/facility.ts";
import { buildTankTransfer, manualStepsOf, tankTransferPumps, tankTransferRoute, TRANSFER_STEPS } from "../../src/lib/piping/workTypes.ts";
import { planTargetKey, planTargets } from "../../src/lib/piping/execRules.ts";

const g = buildGraph(getFacility());
const base = normalValveState(g.facility);
const rowOf = (rows, id) => rows.find((r) => r.nodeId === id);

test("各ヤードにドレンタンク1基、各タンクにサンプリング装置があり、ドレンタンクにつながる", () => {
  for (const y of [1, 2]) {
    assert.equal(g.nodeById.get(`DT-${y}`)?.kind, "tank");
    for (let i = 1; i <= 6; i++) {
      const no = `${y}0${i}`;
      assert.equal(g.nodeById.get(`SMP-${no}`)?.kind, "sampler");
      // 貯蔵タンク → サンプリング元弁 → サンプリング装置 → サンプリングドレン弁 → ドレンタンク（自然流下）
      const r = tankTransferRoute(g, `T-${no}`, `DT-${y}`, null);
      assert.ok(r, `T-${no} → DT-${y}`);
      assert.deepEqual(
        r.nodeIds.filter((n) => g.nodeById.get(n).kind !== "junction").slice(0, 4),
        [`T-${no}`, `V-S${no}`, `SMP-${no}`, `V-SD${no}`]
      );
    }
  }
  assert.equal(g.nodeById.get("SLP-1")?.kind, "tank");
});

test("ドレンタンク → ドレンポンプ → ドレンフィルター → スロップタンク", () => {
  assert.deepEqual(tankTransferPumps(g, "DT-1", "SLP-1"), ["DP-1"]);
  assert.deepEqual(tankTransferPumps(g, "DT-2", "SLP-1"), ["DP-2"]);
  const r = tankTransferRoute(g, "DT-1", "SLP-1", "DP-1");
  assert.deepEqual(r.nodeIds, ["DT-1", "V-DT1O", "DP-1", "CV-DP1", "FLT-DT1", "V-DT1S", "SLP-1"]);
  // 逆向き（スロップタンク → ドレンタンク）は逆止弁・ポンプの向きで送れない
  assert.deepEqual(tankTransferPumps(g, "SLP-1", "DT-1"), []);
});

test("タンク間移送のチェックリスト：ラインナップで開、移送でポンプ起動、復旧で停止・元に戻す", () => {
  const r = buildTankTransfer(g, { src: "DT-1", dest: "SLP-1", pump: "DP-1" }, base);
  assert.equal(r.error, undefined);
  assert.deepEqual(rowOf(r.rows, "V-DT1O").states, ["close", "open", null, "close"]);
  assert.deepEqual(rowOf(r.rows, "V-DT1S").states, ["close", "open", null, "close"]);
  assert.deepEqual(rowOf(r.rows, "DP-1").states, ["close", null, "open", "close"]);
  // 経路の分岐先：もう一方のヤードのスロップ送油弁と、ドレンタンクへ入るサンプリングドレン弁は閉
  assert.equal(rowOf(r.rows, "V-DT2S").states[1], "close");
  assert.equal(rowOf(r.rows, "V-SD101").states[1], "close");
  assert.ok(r.stepRoutes[2].pipeIds.length > 0);
  assert.match(r.stepNotes[2], /DP-1 を起動/);
});

test("貯蔵タンクどうしはポンプの経路を先に出し、自然流下は最後", () => {
  const opts = tankTransferPumps(g, "T-101", "T-102");
  assert.ok(opts.length > 1);
  assert.notEqual(opts[0], null);
  // ポンプなしで送れない組み合わせ（ポンプを通らないと届かない）
  assert.equal(tankTransferRoute(g, "T-101", "SLP-1", null), null);
});

test("同じタンクを対象とする作業との重複・作業の種類と対象のキー", () => {
  const plan = { workType: "tankTransfer", source: "planner", targets: [], tankTransfer: { src: "DT-1", dest: "SLP-1", pump: "DP-1" }, rows: [] };
  assert.deepEqual(planTargets(plan), ["tank:DT-1", "tank:SLP-1"]);
  assert.equal(planTargetKey(plan), "tankTransfer:DT-1>SLP-1");
  assert.deepEqual(manualStepsOf(plan), [2]);
  assert.equal(TRANSFER_STEPS.length, 4);
});
