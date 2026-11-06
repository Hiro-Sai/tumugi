// =========================================
// test/prompt.test.js
// js/prompt.js の単体テスト（実行：npm test）
// =========================================

const test   = require("node:test");
const assert = require("node:assert/strict");

const {
  NOTE_SEPARATOR, MEMORY_EXTRACT_EVERY,
  withDynamicNote, stripPlaceholders, buildReplySystemPrompt, buildMemoryPrompt, buildGreeting,
  extractLineEnding, buildDynamicNote,
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

// -----------------------------------------
// extractLineEnding
// -----------------------------------------
test("extractLineEnding: 終わりの「…」「！」などを除いて、最後の3文字", () => {
  assert.equal(extractLineEnding("雨降ってきたんだね…"), "んだね");
  assert.equal(extractLineEnding("それは大変だね！"), "変だね");
  assert.equal(extractLineEnding("え、4時間も？"), "間も？");
  assert.equal(extractLineEnding(""), "");
  assert.equal(extractLineEnding(undefined), "");
});

// -----------------------------------------
// buildDynamicNote
// -----------------------------------------
// 返事 { line, share, question } を作る（新しい順に並べて渡す）
const r = (line, question = "", share = "") => ({ line, share, question });

test("buildDynamicNote: 返事も気持ちもなければ空", () => {
  assert.equal(buildDynamicNote({ recentReplies: [], userEmotions: [] }), "");
  assert.equal(buildDynamicNote(), "");
});

test("buildDynamicNote: 文末の一覧は新しい順", () => {
  const note = buildDynamicNote({ recentReplies: [r("雨降ってきたんだね…"), r("それは大変だね！")] });
  assert.ok(
    note.includes("【言い方の重複回避】\n直近のlineの終わり方は 「…んだね」「…変だね」 だった。今回はこれらと違う終わり方・違う受け止め方にすること。"),
    "文末の一覧が新しい順になっていない"
  );
});

test("buildDynamicNote: 直近2回の line か question に「感じ」があれば、line でも question でも使わない文を付ける", () => {
  const sentence = "今回は line でも question でも「感じ」を使わないこと。";
  const twoBack = buildDynamicNote({ recentReplies: [r("そっか"), r("眠いんだね", "どんな感じ？")] });
  assert.ok(twoBack.includes(sentence), "2回前の question の「感じ」を見ていない");
  const prev = buildDynamicNote({ recentReplies: [r("いい感じじゃん")] });
  assert.ok(prev.includes(sentence), "前回の line の「感じ」を見ていない");
  const threeBack = buildDynamicNote({ recentReplies: [r("そっか"), r("うん"), r("いい感じじゃん")] });
  assert.ok(!threeBack.includes(sentence), "3回前の「感じ」まで見ている");
});

test("buildDynamicNote: 前回の当てにいく言い方には、別の受け止め方にする文を付ける", () => {
  const sentence = "前回は気持ちを想像して問いかけたので、今回は別の受け止め方にすること。";
  assert.ok(buildDynamicNote({ recentReplies: [r("体が重たい感じなのかな")] }).includes(sentence), "「感じなのかな」に当たっていない");
  assert.ok(
    buildDynamicNote({ recentReplies: [r("ミスしちゃったんだ…まだそのことが頭から離れなかったりする？")] }).includes(sentence),
    "「ったりする？」に当たっていない"
  );
  assert.ok(
    !buildDynamicNote({ recentReplies: [r("そっか"), r("体が重たい感じなのかな")] }).includes(sentence),
    "2回前だけなのに文が付いている"
  );
  assert.ok(
    !buildDynamicNote({ recentReplies: [r("仕事が辛いんだね…", "どんなことがあったの？")] }).includes(sentence),
    "ふつうの問いかけに文が付いている"
  );
});

test("buildDynamicNote: 直近2回に気づかいの言葉があれば（share も見る）、気づかい以外の返し方にする文を付ける", () => {
  const sentence = "今回は気づかい以外の返し方（反応・受け止め・問いかけ）にすること。";
  const inShare = buildDynamicNote({ recentReplies: [r("そっか"), r("寒いのかぁ", "", "ちゃんと暖かくしてね")] });
  assert.ok(inShare.includes(sentence), "2回前の share を見ていない");
  const threeBack = buildDynamicNote({ recentReplies: [r("そっか"), r("うん"), r("寒いのかぁ、ちゃんと暖かくしてね")] });
  assert.ok(!threeBack.includes(sentence), "3回前の気づかいまで見ている");
});

test("buildDynamicNote: 気づかい以外の返し方にする文のあとに、お礼やあいさつに返す文を付ける", () => {
  const sentence = "今回は気づかい以外の返し方（反応・受け止め・問いかけ）にすること。お礼やあいさつには、まずそれに返すこと。";
  assert.ok(
    buildDynamicNote({ recentReplies: [r("寒いのかぁ、ちゃんと暖かくしてね")] }).includes(sentence),
    "気づかいの文のあとに、お礼やあいさつに返す文がない"
  );
  assert.ok(
    !buildDynamicNote({ recentReplies: [r("そっか"), r("うん")] }).includes("お礼やあいさつには"),
    "気づかいがないのに、お礼やあいさつに返す文が付いている"
  );
});

test("buildDynamicNote: 直近2回の問いかけが「今日」で始まっていれば（？で終わる line も見る）、「今日」で始めない文を付ける", () => {
  const sentence = "直近の問いかけを「今日」で始めたので、今回は「今日」で始めず、別のことを聞くこと。";
  assert.ok(
    buildDynamicNote({ recentReplies: [r("そっか"), r("寒いのかぁ", "今日は外にいたの？")] }).includes(sentence),
    "2回前の question の「今日」を見ていない"
  );
  assert.ok(
    buildDynamicNote({ recentReplies: [r("眠いんだね…今日はどんな一日だったの？")] }).includes(sentence),
    "？で終わる line の「今日」を見ていない"
  );
  assert.ok(
    !buildDynamicNote({ recentReplies: [r("そっか"), r("うん"), r("寒いのかぁ", "今日は外にいたの？")] }).includes(sentence),
    "3回前の「今日」まで見ている"
  );
  assert.ok(
    !buildDynamicNote({ recentReplies: [r("今日も寒いんだね", "何か飲んでる？")] }).includes(sentence),
    "問いかけでない line の「今日」に文が付いている"
  );
  assert.ok(
    buildDynamicNote({ recentReplies: [r("寒いね", "そっか、今日は何してたの？")] }).includes(sentence),
    "question の読点のあとの「今日」を見ていない"
  );
  assert.ok(
    buildDynamicNote({ recentReplies: [r("寒いね", "今日は何してたの")] }).includes(sentence),
    "「？」のない question の「今日」を見ていない"
  );
  assert.ok(
    !buildDynamicNote({ recentReplies: [r("今日は寒いね、外にいたの？")] }).includes(sentence),
    "line の最後の問いが「今日」で始まらないのに文が付いている"
  );
});

test("buildDynamicNote: 感情の流れは、今と同じ条件で付ける", () => {
  const header = "【感情の流れに注意】";
  assert.ok(
    buildDynamicNote({ userEmotions: ["tired", "tired", "normal"] }).includes(
      "\n【感情の流れに注意】\n直近2回連続でユーザーの感情が「疲れ」傾向。一時的な気分ではなく根深い悩みかもしれない。\nいつもより一段深く受け止め、気持ちの想像をより丁寧に行うこと。"
    ),
    "疲れが2回連続の文が違う"
  );
  assert.ok(
    buildDynamicNote({ userEmotions: ["sad", "sad", "sad"] }).includes("直近3回連続でユーザーの感情が「悲しい・落ち込み」傾向。"),
    "悲しいが3回連続の文が違う"
  );
  assert.ok(!buildDynamicNote({ userEmotions: ["normal", "tired", "tired"] }).includes(header), "先頭が違うのに付いている");
  assert.ok(!buildDynamicNote({ userEmotions: ["anxious", "sad"] }).includes(header), "感情が違うのに付いている");
  assert.ok(!buildDynamicNote({ userEmotions: ["tired"] }).includes(header), "1回だけなのに付いている");
});

test("buildDynamicNote: 欄が足りない返事（代わりの返事など）でも動く", () => {
  let note;
  assert.doesNotThrow(() => { note = buildDynamicNote({ recentReplies: [{ line: "そっか" }] }); });
  assert.ok(note.includes("「…そっか」"), "line だけの返事の文末が一覧にない");
});
