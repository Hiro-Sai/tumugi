// =========================================
// test/prompt.test.js
// js/prompt.js の単体テスト（実行：npm test）
// =========================================

const test   = require("node:test");
const assert = require("node:assert/strict");

const {
  NOTE_SEPARATOR, MEMORY_EXTRACT_EVERY,
  withDynamicNote, stripPlaceholders, buildReplySystemPrompt, buildMemoryPrompt, buildGreeting,
} = require("../js/prompt");

// -----------------------------------------
// withDynamicNote
// -----------------------------------------
test("withDynamicNote: ノートがなければ、発言をそのまま返す", () => {
  assert.equal(withDynamicNote("今日も疲れた", ""), "今日も疲れた");
  assert.equal(withDynamicNote("今日も疲れた", undefined), "今日も疲れた");
});

test("withDynamicNote: ノートは発言の後ろに、区切りを入れて付ける", () => {
  const note = "\n【言い方の重複回避】\n直近のlineの終わり方は「…んだね」だった。";
  const result = withDynamicNote("今日も疲れた", note);
  assert.equal(result, "今日も疲れた" + NOTE_SEPARATOR + note);
  assert.ok(result.startsWith("今日も疲れた"), "発言が先頭にない");
  assert.ok(NOTE_SEPARATOR.includes("ユーザーの発言ではない"), "区切りの説明が消えている");
});

// -----------------------------------------
// stripPlaceholders
// -----------------------------------------
test("stripPlaceholders: {{...}} の差し込み口を消す", () => {
  assert.equal(stripPlaceholders("A{{MEMORY_TEXT}}{{DYNAMIC_NOTE}}B{{DISTANCE_NOTE}}C"), "ABC");
});

test("stripPlaceholders: 見本の JSON の波かっこは消さない", () => {
  const template = '出力：{"emotion":"normal","line":"..."}';
  assert.equal(stripPlaceholders(template), template);
});

// -----------------------------------------
// buildReplySystemPrompt
// -----------------------------------------
test("buildReplySystemPrompt: 変わらない部分が先頭、記憶と要約は末尾", () => {
  const prompt = buildReplySystemPrompt("キャラクターの指示{{MEMORY_TEXT}}", "\n【記憶】名前：たろう", "\n【要約】残業の話");
  assert.equal(prompt, "キャラクターの指示\n【記憶】名前：たろう\n【要約】残業の話");
});

test("buildReplySystemPrompt: 記憶も要約もなければ、指示だけ（毎回同じ文になる）", () => {
  assert.equal(buildReplySystemPrompt("キャラクターの指示", "", ""), "キャラクターの指示");
  assert.equal(buildReplySystemPrompt("キャラクターの指示", undefined, undefined), "キャラクターの指示");
});

// -----------------------------------------
// buildMemoryPrompt
// -----------------------------------------
test("MEMORY_EXTRACT_EVERY: 記憶の抽出は3往復に1回", () => {
  assert.equal(MEMORY_EXTRACT_EVERY, 3);
});

test("buildMemoryPrompt: 往復を順番どおりに並べ、既に知っている情報も渡す", () => {
  const prompt = buildMemoryPrompt(
    [["今日も残業だった", "残業だったんだね"], ["上司に急に仕事振られて", "急にか…"], ["断れなかった", "断れなかったんだ…"]],
    { 名前: "たろう" }
  );
  const first  = prompt.indexOf("ユーザー：「今日も残業だった」\nAIの返答：「残業だったんだね」");
  const second = prompt.indexOf("ユーザー：「上司に急に仕事振られて」\nAIの返答：「急にか…」");
  const third  = prompt.indexOf("ユーザー：「断れなかった」\nAIの返答：「断れなかったんだ…」");
  assert.ok(first !== -1 && first < second && second < third, "往復の順番が違う");
  assert.ok(prompt.includes('"名前": "たろう"'), "既に知っている情報がない");
  assert.ok(prompt.includes("新しい情報がなければ {} を返してください"), "指示が欠けている");
});

test("buildMemoryPrompt: まだ何も知らないときは {} を渡す", () => {
  assert.ok(buildMemoryPrompt([["こんにちは", "こんにちは！"]], {}).includes("既に知っている情報：\n{}"));
});

// -----------------------------------------
// buildGreeting（ログイン時のあいさつ）
// -----------------------------------------
test("buildGreeting: 朝（5〜10時）・昼（10〜17時）・夜（17〜5時）で文を変え、名前を入れる", () => {
  assert.equal(buildGreeting(5, "たろう"),  "おはよ〜、たろう。今日はどんな一日になりそう？");
  assert.equal(buildGreeting(9, "たろう"),  "おはよ〜、たろう。今日はどんな一日になりそう？");
  assert.equal(buildGreeting(10, "たろう"), "たろう、おつかれ〜。今日はどう過ごしてる？");
  assert.equal(buildGreeting(16, "たろう"), "たろう、おつかれ〜。今日はどう過ごしてる？");
  assert.equal(buildGreeting(17, "たろう"), "おかえり〜、たろう。今日はどんな一日だった？");
  assert.equal(buildGreeting(23, "たろう"), "おかえり〜、たろう。今日はどんな一日だった？");
  assert.equal(buildGreeting(0, "たろう"),  "おかえり〜、たろう。今日はどんな一日だった？");
  assert.equal(buildGreeting(4, "たろう"),  "おかえり〜、たろう。今日はどんな一日だった？");
});

test("buildGreeting: 名前がないときは、名前の部分を省く", () => {
  assert.equal(buildGreeting(7, undefined), "おはよ〜。今日はどんな一日になりそう？");
  assert.equal(buildGreeting(12, ""),       "おつかれ〜。今日はどう過ごしてる？");
  assert.equal(buildGreeting(20, "  "),     "おかえり〜。今日はどんな一日だった？");
});

test("buildGreeting: 名前の前後の空白は除き、20字を超える名前は省く", () => {
  assert.equal(buildGreeting(12, " たろう "), "たろう、おつかれ〜。今日はどう過ごしてる？");
  assert.equal(buildGreeting(12, "あ".repeat(20)), `${"あ".repeat(20)}、おつかれ〜。今日はどう過ごしてる？`);
  assert.equal(buildGreeting(12, "あ".repeat(21)), "おつかれ〜。今日はどう過ごしてる？");
});
