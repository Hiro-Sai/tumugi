// =========================================
// test/password.test.js
// js/password.js の単体テスト（実行：npm test）
// =========================================

const test   = require("node:test");
const assert = require("node:assert/strict");

const { validateNewPassword } = require("../js/password");

const CURRENT = "current-pass-1";

// 「もう一度」は、指定しなければ新しいパスワードと同じにする
function check(next, confirm = next, current = CURRENT) {
  return validateNewPassword({ current, next, confirm });
}

test("今のパスワードが空なら、入れるように言う", () => {
  assert.deepEqual(check("new-pass-123", "new-pass-123", ""), { ok: false, message: "今のパスワードを入れてください" });
  assert.deepEqual(validateNewPassword({}), { ok: false, message: "今のパスワードを入れてください" });
});

test("新しいパスワードは8文字以上（7文字はだめ、8文字は通る）", () => {
  assert.deepEqual(check("abcdefg"), { ok: false, message: "新しいパスワードは8文字以上にしてください" });
  assert.deepEqual(check("abcdefgh"), { ok: true });
});

test("絵文字は1つを1文字と数える（JavaScript の length では2になる）", () => {
  assert.deepEqual(check("😀😀😀😀😀😀😀a"), { ok: true });
  assert.deepEqual(check("😀😀😀😀😀😀a"), { ok: false, message: "新しいパスワードは8文字以上にしてください" });
});

test("72バイトまで（全角24文字は通り、25文字は長すぎる）", () => {
  assert.deepEqual(check("あ".repeat(24)), { ok: true });
  assert.deepEqual(check("あ".repeat(25)), { ok: false, message: "新しいパスワードが長すぎます（72バイトまで。全角なら24文字程度）" });
});

test("今と同じパスワードにはできない", () => {
  assert.deepEqual(check(CURRENT), { ok: false, message: "今と同じパスワードにはできません" });
});

test("「もう一度」が違えば、一致しないと言う", () => {
  assert.deepEqual(check("new-pass-123", "new-pass-124"), { ok: false, message: "新しいパスワード（もう一度）が一致しません" });
});

test("決まりは上から順に確かめる（短くて一致しないときは、8文字の方を言う）", () => {
  assert.deepEqual(check("short", "other"), { ok: false, message: "新しいパスワードは8文字以上にしてください" });
});
