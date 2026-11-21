// 本番の系統図（④ の Excel 書出し）にドレン設備を足すスクリプトの確認。
// 前の版（ドレン設備なし）の書出しを作り、足して Excel で往復させ、プログラム内の仮想施設と同じになることを確かめる
import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { buildFacility } from "../../src/lib/piping/facility.ts";
import { buildGraph } from "../../src/lib/piping/graph.ts";
import { diagramToFacility, diagramToWorkbook, validateDiagram, workbookToDiagram } from "../../src/lib/piping/diagramData.ts";
import { tankTransferPumps } from "../../src/lib/piping/workTypes.ts";
import { addDrainTanks, DRAIN_NODE, nodeRow } from "../piping-diagram/add-drain-tanks.mjs";

const f = buildFacility();
// 前の版：ドレン設備の機器・配管を除き、ヤードの区画枠を元の大きさにする
const drain = new Set(f.nodes.filter((n) => DRAIN_NODE(n.id)).map((n) => n.id));
const oldPipes = f.pipes.filter((p) => !drain.has(p.a) && !drain.has(p.b));
const exported = {
  facility_id: "virtual-airport",
  facility_name: f.name,
  note: "第1版",
  sheets: [{ sheet_no: "S1", title: "全体", width: f.width, height: f.height, meters_per_unit: f.metersPerPx, source_doc_no: null }],
  areas: f.areas.map((a) => {
    const m = /^第([12])ヤード（/.exec(a.label);
    const box = m ? { y: m[1] === "1" ? 80 : f.height - 440, h: 360 } : {};
    return { name: a.label, sheet_no: "S1", x: a.x, y: a.y, w: a.w, h: a.h, ...box };
  }),
  nodes: f.nodes.filter((n) => !drain.has(n.id)).map(nodeRow),
  symbols: f.nodes.filter((n) => !drain.has(n.id)).map((n) => ({ node_code: n.id, sheet_no: "S1", x: n.x, y: n.y, rotation: 0, show_label: !n.compact })),
  pipes: oldPipes.map((p) => ({ code: p.id, line_no: null, node_a: p.a, node_b: p.b, size_a: p.sizeA, pipe_spec_id: null, length_m: null, length_source: "drawing_estimate", note: null, fluid: null })),
  geometries: oldPipes.filter((p) => p.via).map((p) => ({ pipe_code: p.id, sheet_no: "S1", points: p.via })),
  specs: [],
};

test("書出しにドレン設備を足すと、プログラム内の仮想施設と同じつながり・位置になる（Excel で往復しても同じ）", () => {
  const added = addDrainTanks(exported);
  const wb = XLSX.read(XLSX.write(diagramToWorkbook(added), { type: "buffer", bookType: "xlsx" }));
  const { data, issues } = workbookToDiagram(wb);
  assert.deepEqual(issues.filter((i) => i.severity === "error"), []);
  assert.deepEqual(validateDiagram(data).filter((i) => i.severity === "error"), []);
  const got = diagramToFacility(data);
  assert.equal(got.nodes.length, f.nodes.length);
  assert.equal(got.pipes.length, f.pipes.length);
  // 既存の配管の番号はそのまま、追加の配管は続きの番号
  oldPipes.forEach((p) => assert.equal(got.pipes.find((q) => q.id === p.id)?.a, p.a));
  const key = (p) => [p.a, p.b, p.sizeA, JSON.stringify(p.via ?? null)].join("|");
  assert.deepEqual(got.pipes.map(key).sort(), f.pipes.map(key).sort());
  const pos = (n) => `${n.id}@${n.x},${n.y}:${n.kind}:${n.area}`;
  assert.deepEqual(got.nodes.map(pos).sort(), f.nodes.map(pos).sort());
  assert.equal(got.nodes.find((n) => n.id === "SMP-101").kind, "sampler");
  // 区画枠は広げた大きさ
  assert.deepEqual(got.areas.find((a) => a.label.startsWith("第1ヤード")), f.areas.find((a) => a.label.startsWith("第1ヤード")));
  // 取り込んだ系統図でも、ドレンタンク → スロップタンクの移送ができる
  assert.deepEqual(tankTransferPumps(buildGraph(got), "DT-2", "SLP-1"), ["DP-2"]);
});

test("追加済みの書出しには足さない", () => {
  assert.throws(() => addDrainTanks(addDrainTanks(exported)), /すでにある機器番号/);
});
