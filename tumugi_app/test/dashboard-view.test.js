// =========================================
// test/dashboard-view.test.js
// js/dashboard-view.js の単体テスト（実行：npm test）
// =========================================

const test   = require("node:test");
const assert = require("node:assert/strict");

const { barPercent, scoreText, rareEventText } = require("../js/dashboard-view");

test("barPercent: 文字列の数も数として読む", () => {
  assert.equal(barPercent("38.2"), 38.2);
  assert.equal(barPercent(38.2), 38.2);
  assert.equal(barPercent("7"), 7);
});

test("barPercent: 0 と 100 はそのまま", () => {
  assert.equal(barPercent(0), 0);
  assert.equal(barPercent("0.0"), 0);
  assert.equal(barPercent(100), 100);
});

test("barPercent: 0〜100 の外は収める（-5 → 0、150 → 100）", () => {
  assert.equal(barPercent(-5), 0);
  assert.equal(barPercent(150), 100);
  assert.equal(barPercent("150"), 100);
});

test("barPercent: 数でなければ 0（null・undefined・'abc'・空文字・NaN・Infinity）", () => {
  assert.equal(barPercent(null), 0);
  assert.equal(barPercent(undefined), 0);
  assert.equal(barPercent("abc"), 0);
  assert.equal(barPercent(""), 0);
  assert.equal(barPercent(NaN), 0);
  assert.equal(barPercent(Infinity), 0);
  assert.equal(barPercent({}), 0);
});

test("scoreText: 小数1桁にそろえる（'38.2' → '38.2'、7 → '7.0'）", () => {
  assert.equal(scoreText("38.2"), "38.2");
  assert.equal(scoreText(7), "7.0");
  assert.equal(scoreText("24"), "24.0");
  assert.equal(scoreText(0), "0.0");
  assert.equal(scoreText("100.0"), "100.0");
});

test("scoreText: 数でなければ '—'（null・undefined・'abc'・空文字・NaN）", () => {
  assert.equal(scoreText(null), "—");
  assert.equal(scoreText(undefined), "—");
  assert.equal(scoreText("abc"), "—");
  assert.equal(scoreText(""), "—");
  assert.equal(scoreText(NaN), "—");
});

test("rareEventText: none は「なし」、flag_only は人数を出さない", () => {
  assert.equal(rareEventText("none"), "なし");
  assert.equal(rareEventText("flag_only"), "あり（人数は非表示）");
  // flag_only のときは、件数が渡されても出さない
  assert.equal(rareEventText("flag_only", 12), "あり（人数は非表示）");
});

test("rareEventText: count は件数を入れる（0 件も、件数が無いときも）", () => {
  assert.equal(rareEventText("count", 12), "12件");
  assert.equal(rareEventText("count", 0), "0件");
  assert.equal(rareEventText("count"), "0件");
  assert.equal(rareEventText("count", "30"), "30件");
});

test("rareEventText: 知らない値は「なし」にせず '—'", () => {
  assert.equal(rareEventText("other"), "—");
  assert.equal(rareEventText(undefined), "—");
  assert.equal(rareEventText(null, 3), "—");
});
