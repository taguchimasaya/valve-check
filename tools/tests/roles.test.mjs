// 権限×機能の表：既定の表が今までの動きと同じこと、保存値の整え方、表を変えたときの判定
// 実行：node --import ./tools/tests/register.mjs --test tools/tests/*.test.mjs
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { can, canOpen, DEFAULT_GRANTS, parseGrants, setGrants, siteAccess, deniedMessage } from "../../src/lib/roles.ts";
import { canApproveStage, isApprover } from "../../src/lib/piping/approval.ts";

afterEach(() => setGrants(null));

test("既定の表：作成は作業者だけ、承認の各段は担当ロールと管理者", () => {
  assert.ok(can(["worker"], "create"));
  for (const r of ["approver", "manager", "control", "admin"]) assert.ok(!can([r], "create"), r);
  assert.ok(canApproveStage(["approver"], "leader") && !canApproveStage(["approver"], "manager"));
  assert.ok(canApproveStage(["manager"], "manager") && !canApproveStage(["manager"], "control"));
  assert.ok(canApproveStage(["control"], "control") && !canApproveStage(["control"], "leader"));
  for (const s of ["leader", "manager", "control"]) assert.ok(canApproveStage(["admin"], s), s);
  assert.ok(!isApprover(["worker"]));
});

test("既定の表：ページの入口は今までどおり", () => {
  assert.ok(canOpen(["admin"], "/admin/users") && canOpen(["admin"], "/admin/roles"));
  assert.ok(!canOpen(["worker"], "/admin/roles"));
  assert.ok(canOpen(["admin"], "/piping/data") && canOpen(["admin"], "/piping/rules") && canOpen(["admin"], "/equipment"));
  assert.ok(canOpen(["control"], "/piping/planner") && canOpen(["control"], "/piping/control"));
  assert.ok(!canOpen(["control"], "/piping/field"));
  assert.ok(canOpen(["worker"], "/piping/field") && canOpen(["worker"], "/equipment/print"));
});

test("保存値の整え方：知らない機能は捨て、無いロールは既定、管理者のユーザー管理は外せない", () => {
  const g = parseGrants({ worker: ["create", "nope"], admin: [] });
  assert.deepEqual(g.worker, ["create"]);
  assert.deepEqual(g.approver, DEFAULT_GRANTS.approver);
  assert.deepEqual(g.admin, ["users"]);
  assert.equal(parseGrants(null), null);
  assert.equal(parseGrants([]), null);
});

test("表を変えると、画面・承認の判定が変わる", () => {
  setGrants(parseGrants({ ...DEFAULT_GRANTS, approver: ["checklist", "qr", "approveLeader", "rules"], control: ["control"] }));
  assert.ok(canOpen(["approver"], "/piping/rules"));
  assert.ok(!canApproveStage(["control"], "control"));
  // 制御室の承認を外しても、制御室の人はほかの拠点を表示だけできる
  assert.equal(siteAccess({ roles: ["control"], siteRoles: { a: ["control"] } }, "b"), "view");
  assert.match(deniedMessage(["rules"]), /チームリーダー/);
});

test("外部ベンダー：ユーザー管理・権限の設定だけができない（表で付けても外れる）", () => {
  assert.ok(!canOpen(["vendor"], "/admin/users") && !canOpen(["vendor"], "/admin/roles"));
  for (const p of ["/piping/planner", "/piping/field", "/piping/control", "/piping/qr", "/piping/data", "/piping/rules", "/equipment", "/equipment/print", "/checklists", "/inspect", "/control-room"])
    assert.ok(canOpen(["vendor"], p), p);
  assert.ok(can(["vendor"], "create"));
  for (const s of ["leader", "manager", "control"]) assert.ok(canApproveStage(["vendor"], s), s);
  const g = parseGrants({ ...DEFAULT_GRANTS, vendor: ["users", "qr"] });
  assert.deepEqual(g.vendor, ["qr"]);
  assert.ok(!deniedMessage(["diagram"]).includes("外部ベンダー"));
});
