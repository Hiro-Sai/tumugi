// =========================================
// test/safety.test.js
// js/safety.js の単体テスト（実行：npm test）
// =========================================

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("fs");
const path   = require("path");

const {
  CRISIS_KEYWORDS, USER_EMOTIONS, REPLY_SCHEMA, CLASSIFY_SCHEMA, CLASSIFY_INSTRUCTION,
  hasCrisisKeyword, parseClassification, keywordTurnRecord, parseReply, extractStreamingLine,
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

// 部分一致なので、危機ではない文でも当たる（レビューの A1）。
// 当たったら相談先はすぐ案内するが、記録は判定で確かめてから送る（keywordTurnRecord）
test("hasCrisisKeyword: 危機ではない文でも当たることがある（記録は判定で確かめる）", () => {
  const cases = [
    "不安が消えたいい一日だった",   // 「消えた」＋「い」
    "鍵をさがしにたいへん苦労した", // 「…しに」＋「たい」
    "自殺防止の研修を受けた",
    "練炭で焼き肉をした",
  ];
  for (const text of cases) {
    assert.equal(hasCrisisKeyword(text), true, text);
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
  const phrases = [
    "「つむぎ：」", "判定するのは、今回の発言だけです", "今回の判定には入れない",
    "迷ったら true にする", "\"received\"", "\"said\"", "\"reason\"",
  ];
  for (const phrase of phrases) {
    assert.ok(CLASSIFY_INSTRUCTION.includes(phrase), phrase);
  }
});

test("CLASSIFY_INSTRUCTION: 最初の4行は会話の読み方で、5行目は空、そのあとは今の決め方", () => {
  // 測定（2026-10-27）の c2 と同じ文。4行目までが会話の読み方、5行目から後ろは前からある判定の決め方
  const lines = CLASSIFY_INSTRUCTION.split("\n");
  assert.deepEqual(lines.slice(0, 4), [
    "あなたは、相談アプリ「つむぎ」の会話を読んで、安全判定だけを行う係です。ユーザーへの返事は書きません。",
    "これから渡す会話で、user はアプリを使っている社員、assistant（「つむぎ：」で始まる文）は相談アプリ「つむぎ」の返事です（あなたの発言ではありません）。",
    "会話の最後の user の発言が「今回の発言」です。判定するのは、今回の発言だけです。",
    "それより前のやり取りは、今回の発言の意味を読み取るために使うこと。前のやり取りに危機やハラスメントの話があっても、今回の発言がその話の続きでなければ、今回の判定には入れない。",
  ]);
  assert.equal(lines[4], "");
  assert.ok(lines[5].startsWith('"crisis": 今回の発言（とそこまでの流れ）に、'), lines[5]);
  assert.equal(lines[lines.length - 1], '出力例：{"reason":"...","crisis":false,"harassment":"none"}');
});

test("CLASSIFY_INSTRUCTION: 判定用の履歴と同じ『つむぎ：』を使う", () => {
  // 判定用の履歴の assistant の発言は、この文字で始まる（js/conversation.js）。指示の中の呼び方とそろえておく
  const { JUDGE_SPEAKER_PREFIX } = require("../js/conversation");
  assert.ok(CLASSIFY_INSTRUCTION.includes("「" + JUDGE_SPEAKER_PREFIX + "」"));
});

// -----------------------------------------
// parseClassification
// -----------------------------------------
// readable は、答えから crisis の値（true か false）が読めたか
test("parseClassification: 正しい JSON から危機とハラスメントを読み取る", () => {
  assert.deepEqual(
    parseClassification('{"reason":"薬を集めている","crisis":true,"harassment":"none"}'),
    { crisis: true, harassment: "none", readable: true }
  );
  assert.deepEqual(
    parseClassification('{"reason":"上司に怒鳴られている","crisis":false,"harassment":"received"}'),
    { crisis: false, harassment: "received", readable: true }
  );
});

test("parseClassification: JSON の前後に余計な文字があっても読み取る", () => {
  assert.deepEqual(
    parseClassification('```json\n{"reason":"","crisis":false,"harassment":"said"}\n```'),
    { crisis: false, harassment: "said", readable: true }
  );
});

test("parseClassification: 決まった値でないものは、危機なし・ハラスメントなしとして扱う（crisis は読めない扱い）", () => {
  assert.deepEqual(
    parseClassification('{"reason":"","crisis":"true","harassment":"power"}'),
    { crisis: false, harassment: "none", readable: false }
  );
});

test("parseClassification: JSON が途中で切れていても、crisis が true なら拾う", () => {
  assert.deepEqual(
    parseClassification('{"reason":"別れのあいさつのように見える","crisis": true,"harass'),
    { crisis: true, harassment: "none", readable: true }
  );
  assert.deepEqual(
    parseClassification('{"reason":"…","crisis":false,"harassment":"received"'),
    { crisis: false, harassment: "received", readable: true }
  );
});

test("parseClassification: crisis が見えなければ、読めない扱い", () => {
  // JSON としては読めるが、crisis がない
  assert.deepEqual(
    parseClassification('{"reason":"…","harassment":"received"}'),
    { crisis: false, harassment: "received", readable: false }
  );
  // crisis の手前で切れている
  assert.deepEqual(
    parseClassification('{"reason":"途中で'),
    { crisis: false, harassment: "none", readable: false }
  );
});

test("parseClassification: 読み取れないものや文字列以外は、危機なし・ハラスメントなし", () => {
  for (const value of ["", "わかりません", undefined, null, 123]) {
    assert.deepEqual(parseClassification(value), { crisis: false, harassment: "none", readable: false }, String(value));
  }
});

// -----------------------------------------
// keywordTurnRecord（キーワードに当たった回の記録を、判定の答えで決める。レビューの A1）
// -----------------------------------------
test("keywordTurnRecord: 判定に失敗した・答えが読めない・答えがないときは、危機として送る（ハラスメントはなし）", () => {
  const cases = [
    { ok: false, crisis: false, harassment: "none" },                     // 呼び出しに失敗（classifySafety の失敗の形）
    { ok: true, readable: false, crisis: false, harassment: "none" },     // 答えが読めない
    { ok: true, readable: false, crisis: false, harassment: "received" }, // 読めない答えのハラスメントは当てにしない
    null,
    undefined,
  ];
  for (const judgment of cases) {
    assert.deepEqual(keywordTurnRecord(judgment), { send: true, harassment: "none" }, JSON.stringify(judgment));
  }
});

test("keywordTurnRecord: 判定が危機なら、危機として送る（ハラスメントは判定の答え）", () => {
  assert.deepEqual(
    keywordTurnRecord({ ok: true, readable: true, crisis: true, harassment: "none" }),
    { send: true, harassment: "none" }
  );
  assert.deepEqual(
    keywordTurnRecord({ ok: true, readable: true, crisis: true, harassment: "received" }),
    { send: true, harassment: "received" }
  );
});

test("keywordTurnRecord: 危機ではなくても、ハラスメントがあれば危機として送る", () => {
  for (const harassment of ["received", "said"]) {
    assert.deepEqual(
      keywordTurnRecord({ ok: true, readable: true, crisis: false, harassment }),
      { send: true, harassment }
    );
  }
});

test("keywordTurnRecord: 危機でもハラスメントでもなければ、送らない", () => {
  assert.deepEqual(
    keywordTurnRecord({ ok: true, readable: true, crisis: false, harassment: "none" }),
    { send: false }
  );
});

test("keywordTurnRecord: ハラスメントが決まった値でなければ、なしとして扱う", () => {
  assert.deepEqual(
    keywordTurnRecord({ ok: true, readable: true, crisis: false, harassment: "power" }),
    { send: false }
  );
  assert.deepEqual(
    keywordTurnRecord({ ok: true, readable: true, crisis: true, harassment: "power" }),
    { send: true, harassment: "none" }
  );
});

test("keywordTurnRecord: parseClassification の答えを、classifySafety と同じ形で渡せる", () => {
  // classifySafety は、呼び出しに成功すると { ok: true, ...parseClassification(答え) } を返す
  const record = (raw) => keywordTurnRecord({ ok: true, ...parseClassification(raw) });
  assert.deepEqual(record('{"reason":"研修の話","crisis":false,"harassment":"none"}'), { send: false });
  assert.deepEqual(record('{"reason":"死を望んでいる","crisis":true,"harassment":"none"}'), { send: true, harassment: "none" });
  assert.deepEqual(record('{"reason":"言われた","crisis":false,"harassment":"received"}'), { send: true, harassment: "received" });
  assert.deepEqual(record("わかりません"), { send: true, harassment: "none" });
});

// -----------------------------------------
// extractStreamingLine（書きかけの返事の JSON から、line をいま届いたところまで取り出す）
// -----------------------------------------
test("extractStreamingLine: line の値がまだ始まっていなければ null", () => {
  assert.equal(extractStreamingLine('{"user_emotion":"tired","emotion":"sad"'), null);
  assert.equal(extractStreamingLine('{"user_emotion":"tired","emotion":"sad","line":'), null);
});

test("extractStreamingLine: 書きかけの line は、届いたところまで", () => {
  assert.equal(extractStreamingLine('{"user_emotion":"tired","emotion":"sad","line":"月末で毎日'), "月末で毎日");
  assert.equal(extractStreamingLine('"line" : "a'), "a");
});

test("extractStreamingLine: 書き終えた line は、閉じる引用符まで", () => {
  assert.equal(
    extractStreamingLine('{"user_emotion":"tired","emotion":"sad","line":"そうなんだ","share":"x'),
    "そうなんだ"
  );
});

test("extractStreamingLine: エスケープを読む", () => {
  assert.equal(extractStreamingLine('"line":"「a」\\"b\\"\\nc\\u3042"'), '「a」"b"\ncあ');
  assert.equal(extractStreamingLine('"line":"a\\\\b\\/c\\td\\re\\bf\\fg"'), "a\\b/c\td\re\bf\fg");
});

test("extractStreamingLine: エスケープの途中で切れたら、その手前まで", () => {
  assert.equal(extractStreamingLine('"line":"abc\\'), "abc");
  assert.equal(extractStreamingLine('"line":"abc\\u30'), "abc");
});

test("extractStreamingLine: サロゲートペアの片方だけなら除く", () => {
  assert.equal(extractStreamingLine('"line":"x\\ud83d'), "x");
  assert.equal(extractStreamingLine('"line":"x\\ud83d\\ude00"'), "x😀");
});

test("extractStreamingLine: 文字列以外は null", () => {
  for (const value of [undefined, 42, null, ""]) {
    assert.equal(extractStreamingLine(value), null, String(value));
  }
});
