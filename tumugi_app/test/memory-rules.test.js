// =========================================
// test/memory-rules.test.js
// js/memory-rules.js の単体テスト（実行：npm test）
// =========================================

const test   = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_ITEMS, MAX_VALUE_CHARS, MAX_KEY_CHARS, normalizeValue, mergeExtracted, cleanLoaded, isFull,
} = require("../js/memory-rules");

// 項目を n 個持つ記憶（k1, k2, …）
function memoryOf(n) {
  const memory = {};
  for (let i = 1; i <= n; i += 1) memory[`k${i}`] = `値${i}`;
  return memory;
}

test("上限：30項目、1項目の値は100文字、項目の名前は20文字", () => {
  assert.equal(MAX_ITEMS, 30);
  assert.equal(MAX_VALUE_CHARS, 100);
  assert.equal(MAX_KEY_CHARS, 20);
});

test("normalizeValue：文字は前後の空白を除き、数字は文字に、配列は「、」でつなぐ", () => {
  assert.equal(normalizeValue("  たろう "), "たろう");
  assert.equal(normalizeValue(25), "25");
  assert.equal(normalizeValue(["音楽", "映画"]), "音楽、映画");
  assert.equal(normalizeValue(["音楽", 3, {}, null, " "]), "音楽、3"); // 配列の中の使えない値と空は除く
});

test("normalizeValue：オブジェクト・true/false・null・空は捨てる（null）", () => {
  for (const value of [{ a: 1 }, true, false, null, undefined, "", "   ", [], [{}], NaN]) {
    assert.equal(normalizeValue(value), null, JSON.stringify(value));
  }
});

test("mergeExtracted：今ある項目は上書きし、値は100文字で切る。変わらない項目は、入れた分に数えない", () => {
  const current = { "名前": "たろう", "趣味": "音楽" };
  const { memory, applied, skipped } = mergeExtracted(current, {
    "名前": "たろちゃん",
    "最近の出来事": "あ".repeat(150),
    "趣味": "音楽", // 今と同じ
  });

  assert.deepEqual(memory, { "名前": "たろちゃん", "趣味": "音楽", "最近の出来事": "あ".repeat(100) });
  assert.deepEqual(applied, { "名前": "たろちゃん", "最近の出来事": "あ".repeat(100) });
  assert.equal(skipped, 0);
  assert.deepEqual(current, { "名前": "たろう", "趣味": "音楽" }); // 元の記憶は書き換えない
});

test("mergeExtracted：名前が使えない項目（空・21文字以上）と、値が使えない項目は捨てる", () => {
  const { memory, applied, skipped } = mergeExtracted({}, {
    "": "x",
    ["あ".repeat(21)]: "x",
    ["い".repeat(20)]: "20文字の名前はよい",
    "  年齢 ": 25,             // 名前の前後の空白は除く
    "趣味": { "音楽": "ロック" }, // オブジェクトは捨てる
  });

  assert.deepEqual(memory, { ["い".repeat(20)]: "20文字の名前はよい", "年齢": "25" });
  assert.deepEqual(applied, memory);
  assert.equal(skipped, 3);
});

test("mergeExtracted：30項目いっぱいのときは、新しい項目を足さず、今ある項目の上書きだけをする", () => {
  const full = mergeExtracted(memoryOf(30), { "k1": "新しい値", "新しい項目": "x" });
  assert.equal(Object.keys(full.memory).length, 30);
  assert.equal(full.memory.k1, "新しい値");
  assert.equal(full.memory["新しい項目"], undefined);
  assert.deepEqual(full.applied, { "k1": "新しい値" });
  assert.equal(full.skipped, 1);

  // 残りが1項目のときは、先に出てきた1つだけを足す
  const almost = mergeExtracted(memoryOf(29), { "一つ目": "a", "二つ目": "b" });
  assert.equal(Object.keys(almost.memory).length, 30);
  assert.equal(almost.memory["一つ目"], "a");
  assert.equal(almost.memory["二つ目"], undefined);
  assert.equal(almost.skipped, 1);
});

test("mergeExtracted：抽出の結果が使えない形（null・配列・文字）なら、何も変えない", () => {
  const current = { "名前": "たろう" };
  for (const extracted of [null, undefined, ["名前"], "名前：たろう"]) {
    const { memory, applied } = mergeExtracted(current, extracted);
    assert.deepEqual(memory, current);
    assert.deepEqual(applied, {});
  }
});

test("cleanLoaded：保存してあった記憶は、形だけそろえ、数と長さは切らない", () => {
  const loaded = cleanLoaded({
    "名前": " たろう ",
    "趣味": ["音楽", "映画"],
    "年齢": 25,
    "謎": { "a": 1 },
    "長い": "あ".repeat(150),
  });
  assert.deepEqual(loaded, { "名前": "たろう", "趣味": "音楽、映画", "年齢": "25", "長い": "あ".repeat(150) });

  assert.equal(Object.keys(cleanLoaded(memoryOf(35))).length, 35);
  assert.deepEqual(cleanLoaded(null), {});
  assert.deepEqual(cleanLoaded(["名前"]), {});
});

test("isFull：30項目からいっぱい", () => {
  assert.equal(isFull(memoryOf(29)), false);
  assert.equal(isFull(memoryOf(30)), true);
  assert.equal(isFull(memoryOf(31)), true);
  assert.equal(isFull(undefined), false);
});
