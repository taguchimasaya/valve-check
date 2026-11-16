// NFC UID の正規化・検証のテスト（依存関係を増やさず Node 22 の型除去と組み込みテストで動かす）
// 実行：node --import ./tools/tests/register.mjs --test tools/tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeUid, parseUid, uidFormatError, formatUid } from "../../src/lib/nfcUid.ts";

test("コロン付き・小文字・空白・全角を同じ UID にそろえる", () => {
  const want = "0439B51BD52A81";
  for (const raw of ["04:39:B5:1B:D5:2A:81", "04:39:b5:1b:d5:2a:81", "0439b51bd52a81", " 04 39 B5 1B D5 2A 81 ", "04-39-B5-1B-D5-2A-81", "０４３９Ｂ５１ＢＤ５２Ａ８１"]) {
    assert.equal(normalizeUid(raw), want, raw);
    assert.deepEqual(parseUid(raw), { ok: true, uid: want });
  }
});

test("デモ用タグ 10 枚の UID はすべて有効", () => {
  for (const u of ["0448B51BD52A81", "0449B51BD52A81", "044AB51BD52A81", "044BB51BD52A81", "043FB51BD52A81", "0442B51BD52A81", "0443B51BD52A81", "0437B51BD52A81", "0438B51BD52A81", "0439B51BD52A81"]) {
    assert.equal(uidFormatError(u), null, u);
  }
});

test("形式の誤りを拒否する", () => {
  assert.match(uidFormatError(""), /入力/);
  assert.match(uidFormatError("0439B51BD52A8G"), /16進数/);
  assert.match(uidFormatError("0439B51B"), /8 桁/); // 4 バイト UID は対象外
  assert.match(uidFormatError("0439B51BD52A8100"), /16 桁/);
  assert.equal(parseUid("hello").ok, false);
});

test("表示用にコロン区切りへ戻せる", () => {
  assert.equal(formatUid("0439B51BD52A81"), "04:39:B5:1B:D5:2A:81");
});
