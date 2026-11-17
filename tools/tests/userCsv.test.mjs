// ユーザー管理の CSV 入出力：出力 → 取り込みで変更なし、差分の作り方、エラー
// 実行：node --import ./tools/tests/register.mjs --test tools/tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsvText, planImport, usersToCsv } from "../../src/lib/userCsv.ts";

const facilities = [
  { id: "airport", name: "仮想空港" },
  { id: "site2", name: "第2拠点" },
];
const base = { envAdmin: false, disabled: false, testMailDone: false, testMail: null, notifyEmail: "" };
const users = [
  { ...base, id: "u1", loginId: "tanaka", name: "田中", roles: ["worker", "approver"], siteRoles: { airport: ["worker"], site2: ["approver"] }, notifyEmail: "t@example.com", testMailDone: true, testMail: { to: "t@example.com", at: "2026-11-17T00:00:00Z" } },
  { ...base, id: "u2", loginId: "old", name: "旧", roles: ["control"], siteRoles: null },
  { ...base, id: "u3", loginId: "boss", name: "管理", roles: ["admin"], siteRoles: {} },
  { ...base, id: "u4", loginId: "gone", name: "退職", roles: ["worker"], siteRoles: { airport: ["worker"] }, disabled: true },
];

test("出力した CSV をそのまま取り込むと変更なし（カンマ・改行・引用符を含む名前も）", () => {
  const us = [...users, { ...base, id: "u5", loginId: "q", name: 'A, "B"\nC', roles: ["vendor"], siteRoles: { site2: ["vendor"] } }];
  const rows = parseCsvText(usersToCsv(us, facilities));
  assert.equal(rows.length, us.length + 1);
  assert.equal(rows[5][1], 'A, "B"\nC');
  const plan = planImport(rows, us, facilities);
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.changes.length, 0);
  assert.equal(plan.unchanged, us.length);
});

test("テストメールの列：送信済み・未送信・通知先なし", () => {
  const rows = parseCsvText(usersToCsv(users, facilities));
  assert.match(rows[1].at(-1), /^送信済み/);
  assert.equal(rows[2].at(-1), "通知先なし");
});

test("差分：権限・名前・状態・新規作成", () => {
  const csv = [
    "ログインID,表示名,通知先メール,状態,管理者,権限:仮想空港(airport),権限:第2拠点(site2),初期パスワード",
    "tanaka,田中太郎,t@example.com,有効,,作業者・制御室,チームリーダー,",
    "old,旧,,無効,,制御室,制御室,",
    "gone,退職,,有効,,作業者,,",
    "newbie,新人,n@example.com,,,外部ベンダー,,password1",
  ].join("\n");
  const plan = planImport(parseCsvText(csv), users, facilities);
  assert.deepEqual(plan.errors, []);
  const by = Object.fromEntries(plan.changes.map((c) => [c.loginId, c]));
  assert.equal(by.tanaka.body.name, "田中太郎");
  assert.deepEqual(by.tanaka.body.siteRoles, { airport: ["worker", "control"], site2: ["approver"] });
  // 共通の権限の人：同じ権限を全拠点に並べただけなら権限は変更なし、状態だけ
  assert.equal(by.old.body, null);
  assert.equal(by.old.status, "disable");
  assert.equal(by.gone.status, "enable");
  assert.equal(by.newbie.kind, "create");
  assert.deepEqual(by.newbie.body.siteRoles, { airport: ["vendor"] });
  assert.equal(plan.unchanged, 0);
});

test("CSV に無い拠点の列は今のまま", () => {
  const csv = "ログインID,権限:仮想空港(airport)\ntanaka,作業者・G長";
  const [c] = planImport(parseCsvText(csv), users, facilities).changes;
  assert.deepEqual(c.body.siteRoles, { airport: ["worker", "manager"], site2: ["approver"] });
});

test("エラー：分からない権限・パスワード無しの新規・権限が全部なくなる・重複・列が無い", () => {
  const csv = [
    "ログインID,状態,管理者,権限:仮想空港(airport),権限:第2拠点(site2),初期パスワード",
    "tanaka,,,作業者・社長,,",
    "nobody,,,作業者,,",
    "gone,,,,,",
    "gone,,,,,",
    "old,休止,,,,",
  ].join("\n");
  const plan = planImport(parseCsvText(csv), users, facilities);
  assert.equal(plan.changes.length, 0);
  const msgs = plan.errors.map((e) => `${e.line}:${e.message}`).join("\n");
  assert.match(msgs, /2:.*社長/);
  assert.match(msgs, /3:.*初期パスワード/);
  assert.match(msgs, /4:.*権限がすべて無くなります/);
  assert.match(msgs, /5:.*重複/);
  assert.match(msgs, /6:.*状態/);
  assert.match(planImport(parseCsvText("名前\nx"), users, facilities).errors[0].message, /ログインID/);
});
