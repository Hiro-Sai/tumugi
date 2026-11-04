// =========================================
// test/conversation.test.js
// js/conversation.js の単体テスト（実行：npm test）
// =========================================

const test   = require("node:test");
const assert = require("node:assert/strict");

const { withDynamicNote } = require("../js/prompt");
const {
  JUDGE_SPEAKER_PREFIX, JUDGE_WINDOW_ITEMS, FACTS_HEADING,
  SUMMARY_TRIGGER_MESSAGES, SUMMARY_TRIGGER_TOKENS, SUMMARY_KEEP_MESSAGES,
  createConversation, addGreeting, addExchange, factsNote,
  judgeMessages, judgePrefillMessages, replyMessages, replyPrefillMessages, plainMessages,
  messageCount, needsSummary, summaryTarget, rebuild, mergeRebuild,
} = require("../js/conversation");

const NOTE  = "\n【言い方の重複回避】\n直近のlineの終わり方は「…んだね」だった。";
const NOTE2 = "\n【感情の流れ】\n最近は落ち込みが続いている。";

// あいさつ（greeting が true のとき）に続けて、往復を exchanges 個足した会話。
// 発言は u1, u2, ...、返事は a1, a2, ...
function makeConv({ greeting, exchanges, facts = "" }) {
  const conv = createConversation("R", "J");
  if (greeting) addGreeting(conv, "おかえり〜");
  for (let i = 1; i <= exchanges; i++) addExchange(conv, `u${i}`, `a${i}`, facts);
  return conv;
}

// -----------------------------------------
// judgeMessages
// -----------------------------------------
test("judgeMessages: 判定の入力は、前の回の判定の入力に足しただけ", () => {
  const conv = createConversation("R", "J");
  addGreeting(conv, "おかえり〜");

  const prev = judgeMessages(conv, "u1");
  addExchange(conv, "u1", "a1");
  const next = judgeMessages(conv, "u2");

  assert.deepEqual(next.slice(0, prev.length), prev);
  assert.equal(next.length, prev.length + 2);
  assert.deepEqual(next.slice(prev.length), [
    { role: "assistant", content: "つむぎ：a1" },
    { role: "user", content: "u2" },
  ]);
});

// -----------------------------------------
// replyMessages
// -----------------------------------------
test("replyMessages: 返事の入力は、整えの入力に足しただけで、ノートは今回の発言にだけ付く", () => {
  const conv = createConversation("R", "J");
  addGreeting(conv, "おかえり〜");
  const facts = factsNote({ 名前: "さくら" });

  const first = replyMessages(conv, "u1", NOTE);
  assert.deepEqual(first, [
    { role: "system", content: "R" },
    { role: "assistant", content: "おかえり〜" },
    { role: "user", content: withDynamicNote("u1", NOTE) },
  ]);

  addExchange(conv, "u1", "a1", facts);
  const prefill = replyPrefillMessages(conv);
  const second  = replyMessages(conv, "u2", NOTE2);

  assert.deepEqual(second.slice(0, prefill.length), prefill);
  assert.deepEqual(second.at(-1), { role: "user", content: withDynamicNote("u2", NOTE2) });
  // 履歴の中の u1 には、新しく分かったことだけが残り、前の回のノートは残らない
  assert.equal(second[2].content, withDynamicNote("u1", facts));
  assert.ok(!second[2].content.includes(NOTE), "前の回のノートが履歴に残っている");
});

// -----------------------------------------
// 判定用の履歴の中身
// -----------------------------------------
test("judgePrefillMessages: assistant には「つむぎ：」が付き、user はノートなしの発言", () => {
  const conv = createConversation("R", "J");
  addGreeting(conv, "おかえり〜");
  addExchange(conv, "u1", "a1", factsNote({ 名前: "さくら" }));

  assert.equal(JUDGE_SPEAKER_PREFIX, "つむぎ：");
  assert.deepEqual(judgePrefillMessages(conv), [
    { role: "system", content: "J" },
    { role: "assistant", content: "つむぎ：おかえり〜" },
    { role: "user", content: "u1" },
    { role: "assistant", content: "つむぎ：a1" },
  ]);
});

test("judgePrefillMessages: 判定に渡すのは直近の3件だけ（あいさつも1件と数える）", () => {
  assert.equal(JUDGE_WINDOW_ITEMS, 3);

  const conv = makeConv({ greeting: true, exchanges: 2 });
  assert.deepEqual(judgePrefillMessages(conv), [
    { role: "system", content: "J" },
    { role: "assistant", content: "つむぎ：おかえり〜" },
    { role: "user", content: "u1" },
    { role: "assistant", content: "つむぎ：a1" },
    { role: "user", content: "u2" },
    { role: "assistant", content: "つむぎ：a2" },
  ]);

  addExchange(conv, "u3", "a3");
  addExchange(conv, "u4", "a4");
  assert.deepEqual(judgePrefillMessages(conv), [
    { role: "system", content: "J" },
    { role: "user", content: "u2" },
    { role: "assistant", content: "つむぎ：a2" },
    { role: "user", content: "u3" },
    { role: "assistant", content: "つむぎ：a3" },
    { role: "user", content: "u4" },
    { role: "assistant", content: "つむぎ：a4" },
  ]);
  assert.deepEqual(judgeMessages(conv, "u5"), [...judgePrefillMessages(conv), { role: "user", content: "u5" }]);

  // 返事の履歴は、全部の Item を使ったまま
  assert.equal(replyPrefillMessages(conv).filter((m) => m.role === "user").length, 4);
});

// -----------------------------------------
// あいさつなし
// -----------------------------------------
test("あいさつがなくても始められる（チャット画面を読み込み直したとき）", () => {
  const conv = createConversation("R", "J");

  assert.deepEqual(judgeMessages(conv, "x"), [
    { role: "system", content: "J" },
    { role: "user", content: "x" },
  ]);
  assert.deepEqual(replyPrefillMessages(conv), [{ role: "system", content: "R" }]);
});

// -----------------------------------------
// 危機の回
// -----------------------------------------
test("危機の回の案内も、判定用と返事用の両方の履歴に入る", () => {
  const conv = createConversation("R", "J");
  addExchange(conv, "消えたい", "案内1　案内2");

  assert.deepEqual(judgePrefillMessages(conv), [
    { role: "system", content: "J" },
    { role: "user", content: "消えたい" },
    { role: "assistant", content: "つむぎ：案内1　案内2" },
  ]);
  assert.deepEqual(replyPrefillMessages(conv), [
    { role: "system", content: "R" },
    { role: "user", content: "消えたい" },
    { role: "assistant", content: "案内1　案内2" },
  ]);
});

// -----------------------------------------
// factsNote
// -----------------------------------------
test("factsNote: 見出しと「・項目：値」の並び。値が空の項目は除き、残りがなければ空の文字列", () => {
  assert.equal(
    factsNote({ 名前: "さくら", 趣味: "" }),
    "\n【このユーザーについて新しく分かったこと】\n・名前：さくら"
  );
  assert.equal(
    factsNote({ 名前: "さくら", 趣味: "ギター" }),
    "\n【このユーザーについて新しく分かったこと】\n・名前：さくら\n・趣味：ギター"
  );
  assert.equal(factsNote({}), "");
  assert.equal(factsNote({ 趣味: "" }), "");
  assert.equal(FACTS_HEADING, "【このユーザーについて新しく分かったこと】");
});

// -----------------------------------------
// needsSummary
// -----------------------------------------
test("needsSummary: 要約のきっかけは、80件を超えたときか、6000語を超えたとき", () => {
  assert.equal(SUMMARY_TRIGGER_MESSAGES, 80);
  assert.equal(SUMMARY_TRIGGER_TOKENS, 6000);

  // あいさつは1件、往復は2件。偶数の件数は、あいさつなしで作る
  const c79 = makeConv({ greeting: true,  exchanges: 39 });
  const c80 = makeConv({ greeting: false, exchanges: 40 });
  const c81 = makeConv({ greeting: true,  exchanges: 40 });
  assert.equal(messageCount(c79), 79);
  assert.equal(messageCount(c80), 80);
  assert.equal(messageCount(c81), 81);
  assert.equal(needsSummary(c79, 0), false);
  assert.equal(needsSummary(c80, 0), false);
  assert.equal(needsSummary(c81, 0), true);

  // 語数だけで決まるよう、件数は80件以下にしておく
  const small = makeConv({ greeting: true, exchanges: 2 });
  assert.equal(needsSummary(small, 6000), false);
  assert.equal(needsSummary(small, 6001), true);
});

// -----------------------------------------
// summaryTarget
// -----------------------------------------
test("summaryTarget: 要約するのは、最後の10件より前", () => {
  assert.equal(SUMMARY_KEEP_MESSAGES, 10);

  // あいさつ1件＋往復41個＝83件。後ろから往復5個（10件）を残し、その前の37個（あいさつ＋往復36個）を要約する
  const conv = makeConv({ greeting: true, exchanges: 41 });
  assert.equal(messageCount(conv), 83);
  const target = summaryTarget(conv);
  assert.equal(target.dropItems, 37);
  assert.equal(target.messages.length, 73);
  assert.deepEqual(target.messages[0], { role: "assistant", content: "おかえり〜" });
  assert.deepEqual(target.messages.at(-1), { role: "assistant", content: "a36" });

  // 往復5個以下（あいさつなし）なら、要約するものがない
  assert.equal(summaryTarget(makeConv({ greeting: false, exchanges: 5 })), null);
  assert.equal(summaryTarget(makeConv({ greeting: false, exchanges: 3 })), null);
  assert.equal(summaryTarget(createConversation("R", "J")), null);
});

// -----------------------------------------
// rebuild
// -----------------------------------------
test("rebuild: 要約した分を消し、あとから足した分は残し、新しく分かったことを消す", () => {
  const facts = factsNote({ 名前: "さくら" });
  const conv  = makeConv({ greeting: true, exchanges: 41, facts });

  // 要約を頼んだあとに、往復が2個足された
  const { dropItems } = summaryTarget(conv);
  addExchange(conv, "u42", "a42", facts);
  addExchange(conv, "u43", "a43", facts);
  const before = JSON.parse(JSON.stringify(conv));

  const next = rebuild(conv, { replySystem: "R2", dropItems });

  assert.equal(next.items.length, 7);
  assert.deepEqual(next.items.map((item) => item.user), ["u37", "u38", "u39", "u40", "u41", "u42", "u43"]);
  assert.equal(next.replySystem, "R2");
  assert.equal(next.judgeSystem, "J");

  const replyUsers = replyPrefillMessages(next).filter((m) => m.role === "user");
  assert.equal(replyUsers.length, 7);
  assert.ok(replyUsers.every((m) => !m.content.includes(FACTS_HEADING)), "新しく分かったことが残っている");

  // 元の会話は変わらない
  assert.deepEqual(conv, before);
  assert.ok(
    replyPrefillMessages(conv).some((m) => m.role === "user" && m.content.includes(FACTS_HEADING)),
    "元の会話から、新しく分かったことが消えている"
  );
});

test("rebuild: 記憶を直したときの作り直し（dropItems 0）は、履歴を短くしない", () => {
  const facts = factsNote({ 名前: "さくら" });
  const conv  = makeConv({ greeting: true, exchanges: 3, facts });

  const next = rebuild(conv, { replySystem: "R3", dropItems: 0 });

  assert.equal(next.items.length, conv.items.length);
  assert.deepEqual(
    next.items.map(({ user, assistant }) => ({ user, assistant })),
    conv.items.map(({ user, assistant }) => ({ user, assistant }))
  );
  assert.ok(next.items.every((item) => item.facts === ""), "新しく分かったことが残っている");
  assert.equal(next.replySystem, "R3");
  assert.equal(next.judgeSystem, "J");
  assert.equal(conv.replySystem, "R");
  assert.ok(conv.items.some((item) => item.facts !== ""), "元の会話から、新しく分かったことが消えている");
});

test("rebuild: 判定に渡す直近3件は、作り直しても変わらない", () => {
  const conv = makeConv({ greeting: true, exchanges: 41 });
  const { dropItems } = summaryTarget(conv);
  addExchange(conv, "u42", "a42");

  const next = rebuild(conv, { replySystem: "R2", dropItems });
  assert.deepEqual(judgePrefillMessages(next), judgePrefillMessages(conv));
  assert.deepEqual(judgePrefillMessages(rebuild(conv, { replySystem: "R3", dropItems: 0 })), judgePrefillMessages(conv));

  // 往復を足さずに作り直しても、判定に渡す3件は変わらない（実際の流れ）
  const conv0 = makeConv({ greeting: true, exchanges: 41 });
  assert.deepEqual(
    judgePrefillMessages(rebuild(conv0, { replySystem: "R2", dropItems: summaryTarget(conv0).dropItems })),
    judgePrefillMessages(conv0)
  );
  // 要約で残す件数が、判定に渡す Item の2倍以上あること（applyPendingRebuild の judge: false の前提）
  assert.ok(SUMMARY_KEEP_MESSAGES >= JUDGE_WINDOW_ITEMS * 2);
});

// -----------------------------------------
// mergeRebuild
// -----------------------------------------
test("mergeRebuild: 作り直しの頼みは1回にまとめる", () => {
  assert.deepEqual(
    mergeRebuild(null, { summary: "S", dropItems: 3 }),
    { summary: "S", dropItems: 3 }
  );
  // 記憶を直した頼み（要約なし・dropItems 0）が、先に届いた要約の頼みを消さない
  assert.deepEqual(
    mergeRebuild({ summary: "S", dropItems: 3 }, { summary: null, dropItems: 0 }),
    { summary: "S", dropItems: 3 }
  );
  assert.deepEqual(
    mergeRebuild({ summary: null, dropItems: 0 }, { summary: "T", dropItems: 5 }),
    { summary: "T", dropItems: 5 }
  );
});

// -----------------------------------------
// plainMessages
// -----------------------------------------
test("plainMessages: 要約の文に使う並びには、ノートも「つむぎ：」も入らない", () => {
  const conv = createConversation("R", "J");
  addGreeting(conv, "おかえり〜");
  addExchange(conv, "u1", "a1", factsNote({ 名前: "さくら" }));

  assert.deepEqual(plainMessages(conv), [
    { role: "assistant", content: "おかえり〜" },
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
  ]);
  assert.equal(messageCount(conv), 3);
});
