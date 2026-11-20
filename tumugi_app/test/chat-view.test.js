// =========================================
// test/chat-view.test.js
// js/chat-view.js の単体テスト（実行：npm test）
// 日付は、その PC の時刻（ローカル）で作る
// =========================================

const test   = require("node:test");
const assert = require("node:assert/strict");

const {
  formatTime, formatHeaderDate, dayKey, dayLabel, needsDaySeparator, statusText, STARTERS,
  MAX_INPUT_CHARS, inputLength, isInputTooLong, inputCountText,
} = require("../js/chat-view");

// new Date(年, 月, 日, 時, 分)。月は 1 から数える
const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min);

test("formatTime: 24時間表記で、時と分をゼロ埋めする", () => {
  assert.equal(formatTime(at(2026, 11, 11, 9, 5)), "09:05");
  assert.equal(formatTime(at(2026, 11, 11, 0, 0)), "00:00");
  assert.equal(formatTime(at(2026, 11, 11, 18, 42)), "18:42");
  assert.equal(formatTime(at(2026, 11, 11, 23, 59)), "23:59");
});

test("formatHeaderDate: 月日と曜日を出す（水・日・土）", () => {
  assert.equal(formatHeaderDate(at(2026, 11, 11)), "11月11日（水）");
  assert.equal(formatHeaderDate(at(2026, 11, 15)), "11月15日（日）");
  assert.equal(formatHeaderDate(at(2026, 11, 14)), "11月14日（土）");
  assert.equal(formatHeaderDate(at(2027, 1, 1)), "1月1日（金）");
});

test("dayKey: その PC の日付を YYYY-MM-DD にする", () => {
  assert.equal(dayKey(at(2026, 11, 11, 18, 42)), "2026-11-11");
  assert.equal(dayKey(at(2026, 1, 5, 0, 0)), "2026-01-05");
  assert.equal(dayKey(at(2026, 12, 31, 23, 59)), "2026-12-31");
});

test("dayLabel: 同じ日は「今日」、前の日は「昨日」", () => {
  const now = at(2026, 11, 11, 18, 0);
  assert.equal(dayLabel(at(2026, 11, 11, 0, 1), now), "今日");
  assert.equal(dayLabel(at(2026, 11, 10, 23, 59), now), "昨日");
});

test("dayLabel: それより前は日付の表記、年をまたぐ昨日も「昨日」", () => {
  assert.equal(dayLabel(at(2026, 11, 9, 12, 0), at(2026, 11, 11, 18, 0)), "11月9日（月）");
  assert.equal(dayLabel(at(2026, 12, 31, 23, 0), at(2027, 1, 1, 10, 0)), "昨日");
  assert.equal(dayLabel(at(2026, 10, 31, 12, 0), at(2026, 11, 1, 9, 0)), "昨日");
});

test("needsDaySeparator: 最初の発言と、日が変わったときだけ true", () => {
  assert.equal(needsDaySeparator(null, at(2026, 11, 11, 18, 0)), true);
  assert.equal(needsDaySeparator("2026-11-11", at(2026, 11, 11, 18, 0)), false);
  assert.equal(needsDaySeparator("2026-11-11", at(2026, 11, 11, 23, 59)), false);
  assert.equal(needsDaySeparator("2026-11-11", at(2026, 11, 12, 0, 0)), true);
});

test("statusText: 話している・考えている・聞いている（両方 true なら話している）", () => {
  assert.equal(statusText({ busy: false, speaking: false }), "話を聞いています");
  assert.equal(statusText({ busy: true, speaking: false }), "考えています");
  assert.equal(statusText({ busy: false, speaking: true }), "話しています");
  assert.equal(statusText({ busy: true, speaking: true }), "話しています");
});

test("statusText: ログインの期限が切れたら、ログインを待っている（話しているあいだは、話している）", () => {
  assert.equal(statusText({ busy: false, speaking: false, expired: true }), "ログインを待っています");
  assert.equal(statusText({ busy: true, speaking: false, expired: true }), "ログインを待っています");
  assert.equal(statusText({ busy: false, speaking: true, expired: true }), "話しています");
});

test("STARTERS: 4つあり、label と text が空でなく、書き換えられない", () => {
  assert.equal(STARTERS.length, 4);
  for (const s of STARTERS) {
    assert.equal(typeof s.label, "string");
    assert.equal(typeof s.text, "string");
    assert.ok(s.label.length > 0);
    assert.ok(s.text.length > 0);
    assert.ok(Object.isFrozen(s));
  }
  assert.ok(Object.isFrozen(STARTERS));
  assert.deepEqual(STARTERS.map(s => s.label), ["今日の出来事", "仕事の悩み", "人間関係", "雑談したい"]);
  assert.throws(() => { "use strict"; STARTERS.push({ label: "x", text: "y" }); }, TypeError);
});

// -----------------------------------------
// 入力の文字数（つむぎへの1回の発言は1000文字まで）
// -----------------------------------------
test("inputLength: 送るときと同じく前後の空白を除き、絵文字も1文字と数える", () => {
  assert.equal(inputLength("こんにちは"), 5);
  assert.equal(inputLength("  こんにちは\n"), 5);
  assert.equal(inputLength("　こんにちは　"), 5); // 全角の空白
  assert.equal(inputLength("一行目\n二行目"), 7); // 間の改行は1文字
  assert.equal(inputLength("😊"), 1);              // "😊".length は 2
  assert.equal(inputLength(""), 0);
  assert.equal(inputLength(undefined), 0);
});

test("isInputTooLong: 1000文字までは送れて、1001文字からは送れない", () => {
  assert.equal(MAX_INPUT_CHARS, 1000);
  assert.equal(isInputTooLong("あ".repeat(1000)), false);
  assert.equal(isInputTooLong("あ".repeat(1001)), true);
  assert.equal(isInputTooLong("あ".repeat(1000) + "  \n"), false); // 後ろの空白は数えない
  assert.equal(isInputTooLong("😊".repeat(1000)), false);          // JavaScript の長さでは 2000
});

test("inputCountText: 残りが200文字を切るまでは、何も出さない", () => {
  assert.equal(inputCountText(""), "");
  assert.equal(inputCountText("今日あったことを聞いてほしい。"), "");
  assert.equal(inputCountText("あ".repeat(800)), ""); // 残り200文字
});

test("inputCountText: 残りが200文字を切ったら、残りの文字数を出す", () => {
  assert.equal(inputCountText("あ".repeat(801)), "残り199文字");
  assert.equal(inputCountText("あ".repeat(1000)), "残り0文字");
});

test("inputCountText: 上限を超えたら、上限と、減らす文字数を出す", () => {
  assert.equal(inputCountText("あ".repeat(1001)), "1000文字までです（あと1文字減らしてください）");
  assert.equal(inputCountText("あ".repeat(1030)), "1000文字までです（あと30文字減らしてください）");
});
