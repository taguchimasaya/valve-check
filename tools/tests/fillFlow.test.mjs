// 充填工程の流れ（供給元 → 充填ライン → 抜取範囲）が、充填元弁と供給元の間に節点がある系統図でも描けること
// 実行：node --import ./tools/tests/register.mjs --test tools/tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFacility } from "../../src/lib/piping/facility.ts";
import { buildGraph, normalValveState } from "../../src/lib/piping/graph.ts";
import { planIsolation, fillSupplyRoute } from "../../src/lib/piping/isolation.ts";
import { buildPlanRows, stateAtStep, PLAN_STEPS } from "../../src/lib/piping/checklist.ts";
import { stepFlow } from "../../src/lib/piping/flow.ts";

/** 充填元弁 V-FLA と供給元 J-FL の間に節点 J-GAP を入れた系統図 */
function withGap() {
  const f = buildFacility();
  const p = f.pipes.find((x) => [x.a, x.b].includes("V-FLA") && [x.a, x.b].includes("J-FL"));
  const fl = f.nodes.find((n) => n.id === "J-FL");
  f.nodes.push({ ...fl, id: "J-GAP", fillSource: undefined, y: fl.y - 30 });
  f.pipes.push({ ...p, id: "P-GAP", a: "J-GAP", b: "J-FL" });
  if (p.a === "J-FL") p.a = "J-GAP";
  else p.b = "J-GAP";
  return f;
}

const STEP = PLAN_STEPS.indexOf("充填");

for (const [name, make] of [["試作の系統図", buildFacility], ["間に節点がある系統図", withGap]]) {
  for (const target of ["STR-RA1", "FLT-RA2"]) {
    test(`${name}・${target}：充填の流れが充填ライン全体に描ける`, () => {
      const f = make();
      const g = buildGraph(f);
      const base = normalValveState(f);
      const iso = planIsolation(g, [{ type: "node", id: target }], { baseline: base, expandToDrain: true });
      assert.equal(iso.fill.method, "line");
      const rows = buildPlanRows(g, iso, base, iso.drainIds ?? [], []);
      const st = stateAtStep(base, rows, STEP);
      const variants = {
        新しいチェックリスト: iso.fill.pipeIds,
        // 修正前の計算で保存したチェックリスト（充填ラインが供給元まで届いていない）
        保存済みのチェックリスト: iso.fill.pipeIds.filter((p) => p !== "P-GAP"),
      };
      for (const [v, fillPipeIds] of Object.entries(variants)) {
        const plan = { steps: PLAN_STEPS, rows, regionPipeIds: iso.regionPipeIds, regionNodeIds: iso.regionNodeIds, fillPipeIds };
        const flow = stepFlow(g, plan, STEP, st);
        assert.equal(flow?.kind, "fill", `${v}：流れが無い`);
        assert.deepEqual(fillPipeIds.filter((p) => !flow.directions.has(p)), [], `${v}：流れが届かない充填ラインがある`);
        // 点検当日に充填元タンク・移送ポンプを選んだあと
        const sup = fillSupplyRoute(g, "T-101", "TP-1");
        const st2 = { ...st, ...Object.fromEntries(sup.valves.map((x) => [x, "open"])) };
        const flow2 = stepFlow(g, { ...plan, fillSupply: { tank: "T-101", pump: "TP-1", pipeIds: sup.pipeIds } }, STEP, st2);
        assert.deepEqual(fillPipeIds.filter((p) => !flow2?.directions.has(p)), [], `${v}：充填元選択後に流れが届かない`);
      }
    });
  }
}
