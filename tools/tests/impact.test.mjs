// 系統図の版を切り替えるときの、既存チェックリストへの影響チェック
// 実行：node --import ./tools/tests/register.mjs --test tools/tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { assessPlanImpact, assessImpacts, indexDiagram } from "../../src/lib/piping/impact.ts";
import { insertOnPipe, updateNode } from "../../src/lib/piping/diagramEdit.ts";

const node = (code, kind, x, extra = {}) => ({
  code, kind, label: code, name: code, area: "A", equipment_code: null, normal: kind === "valve" ? "open" : null,
  volume_l: null, drain_size_a: null, gauge_mountable: null, service: null, fill_line: null, fill_source: null,
  drain_pump_lpm: null, drain_route: null, drain_target: null, drain_system: null, dir_from: null, small: null,
  recovery: null, rated_flow_lpm: null, capacity_kl: null, set_pressure_mpa: null, data_source: null, note: null, ...extra,
});
const pipe = (code, a, b, size = 100) => ({ code, line_no: null, node_a: a, node_b: b, size_a: size, pipe_spec_id: null, length_m: 10, length_source: null, note: null });

/** 受入口 → V1 → J1（ドレン D1）→ STR → V2 → 受入先。範囲は V1〜V2 の間 */
function base() {
  const nodes = [
    node("SRC", "source", 0), node("V1", "valve", 100), node("J1", "junction", 200), node("D1", "drain", 200),
    node("STR", "strainer", 300), node("V2", "valve", 400), node("SNK", "sink", 500), node("VX", "valve", 700), node("JX", "junction", 800),
  ];
  const pipes = [
    pipe("P001", "SRC", "V1"), pipe("P002", "V1", "J1"), pipe("P003", "J1", "STR"), pipe("P004", "STR", "V2"),
    pipe("P005", "V2", "SNK"), pipe("P006", "J1", "D1", 40), pipe("P007", "VX", "JX"),
  ];
  return {
    facility_id: "t", facility_name: "テスト", note: null,
    sheets: [{ sheet_no: "S1", title: "", width: 1000, height: 500, meters_per_unit: null, source_doc_no: null }],
    areas: [], nodes, pipes,
    symbols: nodes.map((n, i) => ({ node_code: n.code, sheet_no: "S1", x: [0, 100, 200, 200, 300, 400, 500, 700, 800][i], y: n.code === "D1" ? 100 : 50, rotation: 0, show_label: true })),
    geometries: [], specs: [],
  };
}

const row = (code, role) => ({ code, name: code, nodeId: code, role, states: ["open", "close", "close", "open", "open"] });
const plan = (extra = {}) => ({
  id: "p1", name: "燃料抜取（STR）", purpose: "", createdAt: "", source: "planner", diagramVersionId: "v1",
  targets: [{ type: "node", id: "STR" }], regionPipeIds: ["P002", "P003", "P004", "P006"], regionNodeIds: ["J1", "STR", "D1"],
  sealPipeIds: [], steps: ["作業前", "ラインナップ", "抜取", "充填", "復旧"],
  rows: [row("V1", "boundary"), row("V2", "boundary"), row("D1", "drain")],
  summary: { volumeL: 100, drainMinutes: null, drains: [], warnings: [], notes: [] }, ...extra,
});
const judge = (d2, p = plan()) => assessPlanImpact(p, indexDiagram(base()), indexDiagram(d2));
const must = (r) => (typeof r === "string" ? assert.fail(r) : r.data);

test("範囲と関係ない場所の変更は「影響なし」", () => {
  const d = base();
  d.nodes.find((n) => n.code === "VX").normal = "close";
  d.pipes.push(pipe("P008", "JX", "VX"));
  assert.equal(judge(d).level, "none");
});

test("範囲の配管を節点で分けただけなら「図面だけ」で、配管番号を付け替える", () => {
  const d = must(insertOnPipe(base(), "S1", "P003", 250, 50, { kind: "junction", code: "J9" }));
  const r = judge(d);
  assert.equal(r.level, "drawing", r.reasons.join("\n"));
  assert.deepEqual(r.patch.regionPipeIds, ["P002", "P003", "P008", "P004", "P006"]);
});

test("範囲の配管に弁を入れたら「作り直し」", () => {
  const d = must(insertOnPipe(base(), "S1", "P003", 250, 50, { kind: "valve", code: "V9", normal: "open" }));
  const r = judge(d);
  assert.equal(r.level, "remake");
  assert.ok(r.reasons.some((x) => x.includes("P003")), r.reasons.join("\n"));
});

test("使う弁の常時の開閉が変わったら「作り直し」", () => {
  const r = judge(updateNode(base(), "V1", { normal: "close" }));
  assert.equal(r.level, "remake");
  assert.ok(r.reasons.some((x) => x.includes("V1") && x.includes("常時の開閉")));
});

test("範囲の節点に配管が増えたら「作り直し」", () => {
  const d = base();
  d.nodes.push(node("D2", "drain", 210));
  d.symbols.push({ node_code: "D2", sheet_no: "S1", x: 210, y: 120, rotation: 0, show_label: true });
  d.pipes.push(pipe("P008", "J1", "D2", 40));
  const r = judge(d);
  assert.equal(r.level, "remake");
  assert.ok(r.reasons.some((x) => x.includes("J1") && x.includes("P008")));
});

test("使う弁が無くなったら「作り直し」", () => {
  const d = base();
  d.nodes = d.nodes.filter((n) => n.code !== "V2");
  d.pipes = d.pipes.filter((p) => p.code !== "P004" && p.code !== "P005");
  assert.equal(judge(d).level, "remake");
});

test("消した配管の番号が別の場所で使われたら「作り直し」", () => {
  const d = base();
  d.pipes = d.pipes.filter((p) => p.code !== "P006");
  d.pipes.push(pipe("P006", "VX", "JX"));
  assert.equal(judge(d).level, "remake");
});

test("範囲の配管の口径が変わって容量が変わったら「作り直し」", () => {
  const d = base();
  d.pipes.find((p) => p.code === "P003").size_a = 200;
  const r = judge(d);
  assert.equal(r.level, "remake");
  assert.ok(r.reasons.some((x) => x.includes("容量")));
});

test("版の記録が無い古いチェックリストは「作り直し」、同じ版のものは対象外", () => {
  const versions = new Map([["v1", base()]]);
  const list = assessImpacts(
    [plan({ id: "old", diagramVersionId: undefined }), plan({ id: "same", diagramVersionId: "v2" }), plan({ id: "ok" })],
    new Set(["ok"]),
    "v2",
    base(),
    versions
  );
  assert.deepEqual(list.map((x) => [x.planId, x.level, x.inProgress]), [["old", "remake", false], ["ok", "none", true]]);
});
