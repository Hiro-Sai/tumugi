// =========================================
// test/safety.test.js
// js/safety.js の単体テスト（実行：npm test）
// =========================================

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("fs");
const path   = require("path");

const {
  CRISIS_KEYWORDS, USER_EMOTIONS, REPLY_SCHEMA, CLASSIFY_SCHEMA, CLASSIFY_INSTRUCTION, CLASSIFY_HISTORY_TURNS,
  hasCrisisKeyword, buildClassifyMessage, parseClassification, parseReply,
} = require("../js/safety");

// -----------------------------------------
// hasCrisisKeyword
// -----------------------------------------
test("hasCrisisKeyword: 前からあった18個のキーワードは、どれも拾う", () => {
  const cases = [
    "死にたい", "死んじゃおう", "死んでしまいたい", "死ねばよかった", "死のうかな",
    "消えたい", "消えてしまいたい", "いなくなりたい",
    "自殺", "首を吊", "飛び降り", "リストカット", "自傷",
    "もう終わりにしたい", "生きていたくない", "生きてる意味がない",
    "もう生きていたくない", "消えてしまえばいい",
  ];
  for (const kw of cases) {
    assert.ok(CRISIS_KEYWORDS.includes(kw), `一覧から消えている：${kw}`);
    assert.equal(hasCrisisKeyword(`なんかもう${kw}って思う`), true, kw);
  }
});

test("hasCrisisKeyword: はっきりした危機の表現を拾う", () => {
  const cases = [
    "生まれてこなければよかった",
    "このまま目が覚めなければいいのに",
    "死ぬ方法を考えてる",
    "電車に飛び込もうかと思った",
    "オーバードーズしちゃった",
    "しにたい",
    "もうきえたい",
    "生きるのがつらい",
    "死ぬしかない",
  ];
  for (const text of cases) {
    assert.equal(hasCrisisKeyword(text), true, text);
  }
});

test("hasCrisisKeyword: 全角・半角の違いや空白があっても拾う", () => {
  const cases = [
    "死に たい",
    "死に　たい",      // 全角の空白
    "消え\nたい",       // 改行
    "ｵｰﾊﾞｰﾄﾞｰｽﾞした", // 半角カナ
  ];
  for (const text of cases) {
    assert.equal(hasCrisisKeyword(text), true, JSON.stringify(text));
  }
});

test("hasCrisisKeyword: 冗談や日常の言い回しには反応しない", () => {
  const cases = [
    "死ぬほど眠い",
    "締め切り前で死にそうなくらい忙しい（笑）",
    "推しのライブが最高すぎて、もう思い残すことはない（笑）",
    "この仕事、今日中に全部終わらせたい！",
    "部長のギャグがつまらなすぎて消えたくなった（笑）",
    "筋トレしすぎて死ぬかと思った",
    "早く家に帰って楽になりたい〜",
    "今日は飛び込み営業で20件回った",
    "病気で死にたくないから健康診断に行く",
    "ドラマの最終回で主人公が遺書を書くシーン、泣いた", // 「遺書」は Ollama の判定に任せる
    "",
  ];
  for (const text of cases) {
    assert.equal(hasCrisisKeyword(text), false, text);
  }
});

test("hasCrisisKeyword: 文字列以外は false を返し、例外を投げない", () => {
  for (const value of [undefined, null, 123, {}, ["死にたい"]]) {
    assert.equal(hasCrisisKeyword(value), false, String(value));
  }
});

test("CRISIS_KEYWORDS: 書き換えられない", () => {
  assert.ok(Object.isFrozen(CRISIS_KEYWORDS));
});

// -----------------------------------------
// REPLY_SCHEMA（返事。安全判定の欄は持たない）
// -----------------------------------------
test("REPLY_SCHEMA: 5つの欄がすべて必須で、安全判定の欄はない", () => {
  assert.equal(REPLY_SCHEMA.type, "object");
  assert.deepEqual([...REPLY_SCHEMA.required].sort(), ["emotion", "line", "question", "share", "user_emotion"]);
  assert.deepEqual(Object.keys(REPLY_SCHEMA.properties).sort(), [...REPLY_SCHEMA.required].sort());
});

test("REPLY_SCHEMA: ユーザーの感情を最初に出させる（返事を書く前に決めさせる）", () => {
  assert.equal(Object.keys(REPLY_SCHEMA.properties)[0], "user_emotion");
});

test("REPLY_SCHEMA: ユーザーの感情とつむぎの表情は決まった値だけ、ほかは文字列", () => {
  const p = REPLY_SCHEMA.properties;
  assert.deepEqual([...p.user_emotion.enum], ["happy", "normal", "tired", "anxious", "angry", "sad"]);
  assert.deepEqual([...p.emotion.enum], ["happy", "sad", "normal", "surprised", "angry", "troubled"]);
  for (const key of ["line", "share", "question"]) assert.equal(p[key].type, "string", key);
});

test("REPLY_SCHEMA: 書き換えられない", () => {
  assert.ok(Object.isFrozen(REPLY_SCHEMA));
  assert.ok(Object.isFrozen(REPLY_SCHEMA.properties));
  assert.ok(Object.isFrozen(REPLY_SCHEMA.properties.emotion.enum));
  assert.ok(Object.isFrozen(REPLY_SCHEMA.properties.user_emotion.enum));
  assert.ok(Object.isFrozen(USER_EMOTIONS));
});

test("USER_EMOTIONS: サーバーのスコアの表（emotion_scores.php）と同じ分類", () => {
  const php = fs.readFileSync(path.join(__dirname, "..", "..", "tumugi_server", "includes", "emotion_scores.php"), "utf8");
  const table = php.match(/const EMOTION_SCORES = \[([\s\S]*?)\];/);
  assert.ok(table, "EMOTION_SCORES の表が見つからない");
  const keys = [...table[1].matchAll(/'([a-z]+)'\s*=>/g)].map(m => m[1]);
  assert.deepEqual([...keys].sort(), [...USER_EMOTIONS].sort());
});

// -----------------------------------------
// parseReply（返事の読み取り。壊れた返事は null）
// -----------------------------------------
test("parseReply: 正しい返事は、5つの欄を読み取る", () => {
  assert.deepEqual(
    parseReply('{"user_emotion":"tired","emotion":"sad","line":"今日も、か…","share":"","question":"何があったの？"}'),
    { userEmotion: "tired", emotion: "sad", line: "今日も、か…", share: "", question: "何があったの？" }
  );
});

test("parseReply: 特殊トークンが混ざった返事は、JSON として読めても使わない", () => {
  // 2026-10-15 の測定で実際に出たもの
  assert.equal(
    parseReply('{"user_emotion":"normal","emotion":"normal","line":"お昼はコンビニのパスタだったんだね","share":"","question":"他に何か食べた？」}<tool_call|>};]from_system_prompt}<tool_call|>{"}'),
    null
  );
  assert.equal(parseReply('{"user_emotion":"normal","emotion":"normal","line":"<|turn>そっか","share":"","question":""}'), null);
  assert.equal(parseReply('{"user_emotion":"normal","emotion":"normal","line":"そっか<end_of_turn>","share":"","question":""}'), null);
});

test("parseReply: 途中で切れた返事や、JSON でない返事は使わない", () => {
  assert.equal(parseReply('{"user_emotion":"normal","emotion":"normal","line":"お昼はコンビニのパスタだったんだ","share":"","question":"他に何か食べた？」}'), null);
  assert.equal(parseReply("そっか、それは大変だったね"), null);
});

test("parseReply: line が空の返事は使わない", () => {
  assert.equal(parseReply('{"user_emotion":"normal","emotion":"normal","line":"  ","share":"","question":"どうしたの？"}'), null);
  assert.equal(parseReply('{"user_emotion":"normal","emotion":"normal","share":"","question":""}'), null);
});

test("parseReply: ユーザーの感情が分類にないときは null にし、返事は使う", () => {
  const r = parseReply('{"user_emotion":"surprised","emotion":"surprised","line":"え、4時間も？","share":"","question":""}');
  assert.equal(r.userEmotion, null);
  assert.equal(r.emotion, "surprised");
  assert.equal(r.line, "え、4時間も？");
});

test("parseReply: 表情が決まった値でないときは normal、share と question がないときは空にする", () => {
  assert.deepEqual(
    parseReply('{"user_emotion":"sad","emotion":"crying","line":"そっか…"}'),
    { userEmotion: "sad", emotion: "normal", line: "そっか…", share: "", question: "" }
  );
});

test("parseReply: 文字列以外は使わない", () => {
  for (const value of [undefined, null, 123, {}]) assert.equal(parseReply(value), null, String(value));
});

// -----------------------------------------
// CLASSIFY_SCHEMA / CLASSIFY_INSTRUCTION（判定専用の呼び出し）
// -----------------------------------------
test("CLASSIFY_SCHEMA: 理由・危機・ハラスメントの順に並び、すべて必須", () => {
  // 欄の順番は生成の順番なので、理由を書いてから判定させるために reason を先頭にする
  assert.deepEqual(Object.keys(CLASSIFY_SCHEMA.properties), ["reason", "crisis", "harassment"]);
  assert.deepEqual([...CLASSIFY_SCHEMA.required], ["reason", "crisis", "harassment"]);
  const p = CLASSIFY_SCHEMA.properties;
  assert.equal(p.reason.type, "string");
  assert.equal(p.crisis.type, "boolean");
  assert.deepEqual([...p.harassment.enum], ["none", "received", "said"]);
});

test("CLASSIFY_SCHEMA: 書き換えられない", () => {
  assert.ok(Object.isFrozen(CLASSIFY_SCHEMA));
  assert.ok(Object.isFrozen(CLASSIFY_SCHEMA.properties));
  assert.ok(Object.isFrozen(CLASSIFY_SCHEMA.properties.harassment.enum));
});

test("CLASSIFY_INSTRUCTION: 判定の決め方の大事な部分が残っている", () => {
  for (const phrase of ["【判定する発言】", "【これまでの会話】", "迷ったら true にする", "\"received\"", "\"said\"", "\"reason\""]) {
    assert.ok(CLASSIFY_INSTRUCTION.includes(phrase), phrase);
  }
});

// -----------------------------------------
// buildClassifyMessage
// -----------------------------------------
const turn = (u, a) => [{ role: "user", content: u }, { role: "assistant", content: a }];

test("buildClassifyMessage: 会話の流れがなければ、今回の発言だけを渡す", () => {
  assert.equal(buildClassifyMessage([], "今日も疲れた"), "【判定する発言】\n今日も疲れた");
  assert.equal(buildClassifyMessage(undefined, "今日も疲れた"), "【判定する発言】\n今日も疲れた");
});

test("buildClassifyMessage: 直前の往復を【これまでの会話】として前に付ける", () => {
  const history = turn("最近ほとんど眠れてない", "眠れてないんだ…");
  assert.equal(
    buildClassifyMessage(history, "眠れる薬、もうけっこう集めてある"),
    "【これまでの会話】\nユーザー：最近ほとんど眠れてない\nつむぎ：眠れてないんだ…\n\n【判定する発言】\n眠れる薬、もうけっこう集めてある"
  );
});

test("buildClassifyMessage: 渡すのは直前の CLASSIFY_HISTORY_TURNS 往復だけ", () => {
  assert.equal(CLASSIFY_HISTORY_TURNS, 2);
  const history = [...turn("1つ目", "返事1"), ...turn("2つ目", "返事2"), ...turn("3つ目", "返事3")];
  const message = buildClassifyMessage(history, "今回");
  assert.ok(!message.includes("1つ目"), "古い往復が入っている");
  assert.ok(message.includes("ユーザー：2つ目\nつむぎ：返事2\nユーザー：3つ目\nつむぎ：返事3"));
});

test("buildClassifyMessage: 中身が文字列でないものや、ユーザーとつむぎ以外の発言は飛ばす", () => {
  const history = [
    { role: "system", content: "設定" },
    { role: "user", content: null },
    { role: "user", content: "疲れた" },
    { role: "assistant", content: "疲れたんだね" },
  ];
  assert.equal(
    buildClassifyMessage(history, "今回"),
    "【これまでの会話】\nユーザー：疲れた\nつむぎ：疲れたんだね\n\n【判定する発言】\n今回"
  );
});

// -----------------------------------------
// parseClassification
// -----------------------------------------
test("parseClassification: 正しい JSON から危機とハラスメントを読み取る", () => {
  assert.deepEqual(
    parseClassification('{"reason":"薬を集めている","crisis":true,"harassment":"none"}'),
    { crisis: true, harassment: "none" }
  );
  assert.deepEqual(
    parseClassification('{"reason":"上司に怒鳴られている","crisis":false,"harassment":"received"}'),
    { crisis: false, harassment: "received" }
  );
});

test("parseClassification: JSON の前後に余計な文字があっても読み取る", () => {
  assert.deepEqual(
    parseClassification('```json\n{"reason":"","crisis":false,"harassment":"said"}\n```'),
    { crisis: false, harassment: "said" }
  );
});

test("parseClassification: 決まった値でないものは、危機なし・ハラスメントなしとして扱う", () => {
  assert.deepEqual(
    parseClassification('{"reason":"","crisis":"true","harassment":"power"}'),
    { crisis: false, harassment: "none" }
  );
});

test("parseClassification: JSON が途中で切れていても、crisis が true なら拾う", () => {
  assert.deepEqual(
    parseClassification('{"reason":"別れのあいさつのように見える","crisis": true,"harass'),
    { crisis: true, harassment: "none" }
  );
  assert.deepEqual(
    parseClassification('{"reason":"…","crisis":false,"harassment":"received"'),
    { crisis: false, harassment: "received" }
  );
});

test("parseClassification: 読み取れないものや文字列以外は、危機なし・ハラスメントなし", () => {
  for (const value of ["", "わかりません", undefined, null, 123]) {
    assert.deepEqual(parseClassification(value), { crisis: false, harassment: "none" }, String(value));
  }
});
