// 充填工程の流れ：供給元（J-FL）→ 充填元弁（V-FLA）→ 充填ライン → 範囲側の充填弁 → 抜取範囲 を描くこと
// （充填元タンク・移送ポンプが未指定でも、分岐点 J-FL から描く）
// 実行：node --import ./tools/tests/register.mjs --test tools/tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFacility } from "../../src/lib/piping/facility.ts";
import { buildGraph, normalValveState } from "../../src/lib/piping/graph.ts";
import { planIsolation, fillSupplyRoute } from "../../src/lib/piping/isolation.ts";
import { buildPlanRows, stateAtStep, PLAN_STEPS } from "../../src/lib/piping/checklist.ts";
import { stepFlow } from "../../src/lib/piping/flow.ts";

/** 充填元弁 V-FLA と供給元 J-FL の間に節点 J-GAP を入れた系統図（本番の系統図の構成） */
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

/** 充填ラインの V-FLA の下流（範囲側）に、V-FLA → 範囲 の向きの逆止弁 CK-FL を入れた系統図 */
function withCheck(base = buildFacility(), reversed = false) {
  const f = base;
  const p = f.pipes.find((x) => [x.a, x.b].includes("V-FLA") && ![x.a, x.b].includes("J-FL") && ![x.a, x.b].includes("J-GAP"));
  const other = p.a === "V-FLA" ? p.b : p.a;
  const fla = f.nodes.find((n) => n.id === "V-FLA");
  f.nodes.push({ ...fla, id: "CK-FL", label: "CK-FL", kind: "check", dirFrom: "V-FLA", fillLine: undefined, service: undefined, normal: undefined, y: fla.y - 20 });
  f.pipes.push({ ...p, id: "P-CK", a: "CK-FL", b: other });
  if (reversed) f.nodes[f.nodes.length - 1].dirFrom = other; // 逆止弁の向きを実際と逆に登録した系統図
  if (p.a === "V-FLA") p.b = "CK-FL";
  else p.a = "CK-FL";
  return f;
}

const STEP = PLAN_STEPS.indexOf("充填");
const ends = (g, pid) => [g.pipeById.get(pid).a, g.pipeById.get(pid).b];

for (const [name, make] of [
  ["試作の系統図", buildFacility],
  ["間に節点がある系統図", withGap],
  ["充填ラインに逆止弁がある系統図", () => withCheck()],
  ["節点と逆止弁がある系統図", () => withCheck(withGap())],
  ["逆止弁の向きが逆に登録された系統図", () => withCheck(withGap(), true)],
]) {
  for (const target of ["STR-RA1", "FLT-RA2"]) {
    test(`${name}・${target}：充填の流れが J-FL から範囲内まで、充填ラインに沿って描ける`, () => {
      const f = make();
      const g = buildGraph(f);
      const base = normalValveState(f);
      const iso = planIsolation(g, [{ type: "node", id: target }], { baseline: base, expandToDrain: true });
      assert.equal(iso.fill.method, "line");
      assert.ok(iso.fill.openValves.includes("V-FLA"));
      // 新しい充填ラインは V-FLA と供給元 J-FL を含む 1 本の線（枝が無い）
      const deg = new Map();
      iso.fill.pipeIds.forEach((p) => ends(g, p).forEach((n) => deg.set(n, (deg.get(n) ?? 0) + 1)));
      assert.ok(deg.has("V-FLA") && deg.has("J-FL"), "充填ラインが V-FLA・J-FL を通らない");
      assert.equal([...deg.values()].filter((d) => d === 1).length, 2, "充填ラインが 1 本の線になっていない");

      const rows = buildPlanRows(g, iso, base, iso.drainIds ?? [], []);
      const st = stateAtStep(base, rows, STEP);
      const region = new Set(iso.regionPipeIds);
      // 保存済みのチェックリストで、充填ラインの一覧に区間全体が入ってしまった場合（本番で起きたもの）
      const sectionsOfLine = [...new Set(iso.fill.pipeIds.map((p) => g.sectionOfPipe?.get?.(p)).filter(Boolean))];
      const bloated = sectionsOfLine.length
        ? sectionsOfLine.flatMap((s) => g.sectionById.get(s).pipeIds)
        : [...g.sections.filter((s) => s.pipeIds.some((p) => iso.fill.pipeIds.includes(p))).flatMap((s) => s.pipeIds)];
      for (const [v, fillPipeIds] of Object.entries({ 新しいチェックリスト: iso.fill.pipeIds, 区間全体が入った一覧: bloated })) {
        const plan = { steps: PLAN_STEPS, rows, regionPipeIds: iso.regionPipeIds, regionNodeIds: iso.regionNodeIds, fillPipeIds };
        const flow = stepFlow(g, plan, STEP, st);
        assert.equal(flow?.kind, "fill", `${v}：流れが無い`);
        assert.deepEqual(flow.origins, ["J-FL"], `${v}：起点が分岐点 J-FL でない`);
        assert.deepEqual(iso.fill.pipeIds.filter((p) => !flow.directions.has(p)), [], `${v}：J-FL から先の充填ラインが描かれていない`);
        const stray = [...flow.directions.keys()].filter((p) => !region.has(p) && !iso.fill.pipeIds.includes(p));
        assert.deepEqual(stray, [], `${v}：充填ラインと範囲の外の配管まで描いている`);
        // 点検当日に充填元タンク・移送ポンプを選んだあと：タンクから範囲までつながる
        const sup = fillSupplyRoute(g, "T-101", "TP-1");
        const st2 = { ...st, ...Object.fromEntries(sup.valves.map((x) => [x, "open"])), "TP-1": "open" };
        const flow2 = stepFlow(g, { ...plan, fillSupply: { tank: "T-101", pump: "TP-1", pipeIds: sup.pipeIds } }, STEP, st2);
        assert.equal(flow2.origins[0], "T-101");
        assert.deepEqual(iso.fill.pipeIds.filter((p) => !flow2.directions.has(p)), [], `${v}：充填元選択後に供給元〜範囲がつながらない`);
      }
    });
  }
}
