// 点検・チェックリストの重複の決まり（作業＋対象＋周期の重複、同じ点検の二重開始、ラインの重なり、持ち主）
// 実行：node --import ./tools/tests/register.mjs --test tools/tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { activeExecOfPlan, duplicatePlan, isOwner, lineConflicts, planTargetKey } from "../../src/lib/piping/execRules.ts";

const plan = (id, o = {}) => ({
  id,
  name: id,
  source: "planner",
  targets: [{ type: "node", id: "STR-RA1" }],
  regionPipeIds: [],
  regionNodeIds: [],
  sealPipeIds: [],
  rows: [],
  steps: ["作業前", "ラインナップ"],
  ...o,
});
const exec = (id, planId, status, o = {}) => ({ id, planId, planName: planId, status, startedAt: "", currentStep: 1, records: {}, events: [], ...o });

test("重複：作業・対象・周期が同じなら重複、周期・対象・作業が違えば別", () => {
  const a = plan("a", { period: "月次" });
  assert.equal(duplicatePlan([a], plan("b", { period: "月次" }))?.id, "a");
  assert.equal(duplicatePlan([a], plan("b", { period: " 月次 " }))?.id, "a"); // 前後の空白は同じ扱い
  assert.equal(duplicatePlan([a], plan("b", { period: "年次" })), undefined);
  assert.equal(duplicatePlan([a], plan("b", { period: "月次", targets: [{ type: "node", id: "STR-RA2" }] })), undefined);
  assert.equal(duplicatePlan([a], plan("b", { period: "月次", workType: "fireTest", fireTestTank: "T-101" })), undefined);
  // 自分自身（保存し直し）は重複にしない
  assert.equal(duplicatePlan([a], { ...a, name: "名前だけ変更" }), undefined);
  // 対象の並び順が違っても同じ
  const t2 = [{ type: "node", id: "B" }, { type: "node", id: "A" }];
  assert.equal(planTargetKey(plan("x", { targets: t2 })), planTargetKey(plan("y", { targets: [...t2].reverse() })));
});

test("Excel 取込は弁の並びで同じかを判断", () => {
  const rows = (codes) => codes.map((c) => ({ code: c, name: c, role: "isolate", states: [] }));
  const a = plan("a", { source: "excel", targets: [], rows: rows(["V-1", "V-2"]) });
  assert.equal(duplicatePlan([a], plan("b", { source: "excel", targets: [], rows: rows(["V-2", "V-1"]) }))?.id, "a");
  assert.equal(duplicatePlan([a], plan("b", { source: "excel", targets: [], rows: rows(["V-3"]) })), undefined);
});

test("同じ点検の二重開始：申請中・点検中があれば開始できない（完了は関係ない）", () => {
  const store = { executions: [exec("e1", "a", "completed")] };
  assert.equal(activeExecOfPlan(store, "a"), undefined);
  store.executions.push(exec("e2", "a", "pending"));
  assert.equal(activeExecOfPlan(store, "a")?.id, "e2");
  assert.equal(activeExecOfPlan(store, "a", "e2"), undefined);
});

test("ラインの重なり：配管・弁のどちらかが重なれば警告、同じチェックリスト・完了は除く", () => {
  const row = (code, nodeId) => ({ code, nodeId, name: code, role: "isolate", states: [] });
  const a = plan("a", { regionPipeIds: ["P1", "P2"], rows: [row("V-1", "n1")] });
  const b = plan("b", { name: "作業B", regionPipeIds: ["P2", "P3"], rows: [] });
  const c = plan("c", { regionPipeIds: ["P9"], rows: [row("V-1", "n1")] });
  const d = plan("d", { regionPipeIds: ["P8"], rows: [] });
  const store = {
    plans: [a, b, c, d],
    executions: [exec("eb", "b", "in_progress", { ownerName: "田中" }), exec("ec", "c", "pending"), exec("ed", "d", "in_progress"), exec("ea2", "a", "completed")],
  };
  const hits = lineConflicts(store, a);
  assert.deepEqual(hits.map((h) => h.exec.id).sort(), ["eb", "ec"]);
  assert.equal(hits.find((h) => h.exec.id === "eb").pipes, 1);
  assert.deepEqual(hits.find((h) => h.exec.id === "ec").valves, ["V-1"]);
});

test("持ち主：本人だけ。持ち主の無い古い点検は誰でも", () => {
  assert.ok(isOwner({ ownerId: "u1" }, "u1"));
  assert.ok(!isOwner({ ownerId: "u1" }, "u2"));
  assert.ok(isOwner({}, "u2"));
});

test("同じ対象（機器）を含む点検は、作業名が違っても開始できない", async () => {
  const { startBlocker, targetConflicts, planTargets } = await import("../../src/lib/piping/execRules.ts");
  const a = plan("a", { targets: [{ type: "node", id: "STR-RB1" }] });
  const b = plan("b", { targets: [{ type: "node", id: "STR-RB1" }, { type: "node", id: "STR-RB2" }] });
  const c = plan("c", { targets: [{ type: "node", id: "STR-RB2" }] });
  const store = { plans: [a, b, c], executions: [exec("ea", "a", "in_progress")] };
  assert.deepEqual(targetConflicts(store, b).map((x) => x.exec.id), ["ea"]);
  assert.match(startBlocker(store, b), /同じ機器/);
  assert.equal(startBlocker(store, c), null);
  assert.match(startBlocker(store, a), /実施中/);
  // 完了した点検は関係ない
  store.executions[0].status = "completed";
  assert.equal(startBlocker(store, b), null);
  // タンクを対象とする作業どうし（縁切りと消火試験）も同じ対象
  assert.deepEqual(planTargets(plan("t", { workType: "tankIsolation", isolationTank: "T-101" })), ["tank:T-101"]);
  const iso = plan("iso", { workType: "tankIsolation", isolationTank: "T-101" });
  const fire = plan("fire", { workType: "fireTest", fireTestTank: "T-101" });
  assert.match(startBlocker({ plans: [iso, fire], executions: [exec("ei", "iso", "pending")] }, fire), /同じ機器/);
  // Excel 取込は対象を持たないので、対象では止めない
  assert.deepEqual(planTargets(plan("x", { source: "excel" })), []);
});
