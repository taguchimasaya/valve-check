// 安全機構：点検を開始できるのは運用していない範囲か、運用停止範囲の中だけ（プログラム内の仮想施設で確かめる）
// 実行：node --import ./tools/tests/register.mjs --test tools/tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph } from "../../src/lib/piping/graph.ts";
import { getFacility } from "../../src/lib/piping/facility.ts";
import { planIsolation } from "../../src/lib/piping/isolation.ts";
import { currentValveState } from "../../src/lib/piping/operations.ts";
import { operationBlockers, operationContext } from "../../src/lib/piping/operationSafety.ts";

const g = buildGraph(getFacility());
const base = currentValveState(g, [], {}).valveState;
const nodeId = (label) => g.facility.nodes.find((n) => n.label === label).id;
// STR-RB1（受入系統B のストレーナー1）の燃料抜取：範囲の配管と、閉める遮断弁
const iso = planIsolation(g, [{ type: "node", id: nodeId("STR-RB1") }], { baseline: base, expandToDrain: true });
const plan = {
  regionPipeIds: iso.regionPipeIds,
  rows: iso.boundaryValves.map((v) => ({ code: g.nodeById.get(v).label, nodeId: v, states: [null, "close", null, null, "open"] })),
};
const receiveB = { id: "r", kind: "receive", system: "B", tank: "T-201", strainers: [1, 2], filters: [1, 2, 3] };
const receiveA = { id: "a", kind: "receive", system: "A", tank: "T-101", strainers: [1, 2], filters: [1, 2, 3] };

test("運用していなければ開始できる", () => {
  assert.deepEqual(operationBlockers(operationContext(g, { operations: [] }), plan), []);
});

test("点検範囲を運用中のラインが通っていれば開始できない", () => {
  const reasons = operationBlockers(operationContext(g, { operations: [receiveB] }), plan);
  assert.ok(reasons.length > 0);
  assert.match(reasons.join(), /受入/);
});

test("関係のない系統の運用なら開始できる", () => {
  assert.deepEqual(operationBlockers(operationContext(g, { operations: [receiveA] }), plan), []);
});

test("点検範囲が運用停止範囲の中なら、運用が入力されていても開始できる", () => {
  const ctx = operationContext(g, { operations: [receiveB], outages: [{ key: "recvB", at: "" }] });
  assert.deepEqual(operationBlockers(ctx, plan), []);
});

test("ほかの範囲の停止では開始できない", () => {
  const ctx = operationContext(g, { operations: [receiveB], outages: [{ key: "recvA", at: "" }] });
  assert.ok(operationBlockers(ctx, plan).length > 0);
});
