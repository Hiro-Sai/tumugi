// =========================================
// js/conversation.js
// 判定用と返事用の会話の履歴。Ollama に送る入力を、前の入力の後ろに足すだけで組み立てる。
// 画面（index.html から prompt.js のあとに読み込む）と、単体テスト（test/conversation.test.js）の両方から使う。
//
// 継ぎ足すだけにしている理由（設計書 2026-10-27-cpu-only-speed の3章）：
//   Ollama は、読ませた入力の状態（キャッシュ）をメモリに持ち、別の入力が来ると
//   いちばん前半が同じものを取り出して使う。前の入力の後ろに足しただけなら、足した分だけを処理すればよいが、
//   途中が1か所でも変わると、そこから後ろをすべて処理し直す。CPU だけの PC では、この差が大きい
//   （20往復の測定で、文字が出るまでの中央値が 26.7秒 → 6.6秒）。
//   そのため、履歴の途中を変えてよいのは、次の3つだけにしている。
//     ・直前の発言からノートを外すこと：ノートは replyMessages の最後の発言にだけ付け、履歴（Item）には残さない
//     ・rebuild による作り直し：要約したあと・記憶を直したあとに、まとめて1回だけ行う
//     ・判定に渡す直近3件がずれること：新しい往復を足すたびに、いちばん古い1件が外れる。
//       そのぶん、返事のあとに判定の整え（judgePrefillMessages）を送って、次の判定でキャッシュが効くようにする
//
// 判定に渡すのを直近の3件（JUDGE_WINDOW_ITEMS）だけにしている理由：
//   会話の全体を渡すと、長い会話のあとで判定が甘くなり、危機の見逃しが増えた。
//   記録した45往復の会話のあとに68文を置いた測定で、短い流れでは1件だった見逃しが、会話の全体を渡すと
//   20往復のあとで2件、39往復のあとで3件になり、直近3件では1件のままだった
//   （設計書の3章「長い会話のあとの判定」）。
//
// 会話は { replySystem, judgeSystem, items } で、Item は { user, assistant, facts }。
//   user：社員の発言（ノートなし）。ログイン時のあいさつは null
//   assistant：つむぎの返事の文（JSON ではなく、line・share・question を全角の空白でつないだもの）
//   facts：その発言の後ろに付けた「新しく分かったこと」の文（factsNote の結果）。なければ ""
//         返事の履歴に残す。履歴に残しておくので、次の入力でも同じ文になる
// 判定用と返事用は、同じ items から別々に組み立てる。履歴の並びがずれないようにするため。
// 判定用は直近の JUDGE_WINDOW_ITEMS 件だけ、返事用と要約用は全部の Item を使う。
// =========================================

(function () {
  "use strict";

  // テスト（Node）では require、画面では window.TumugiPrompt を使う（prompt.js を先に読み込んでおく）
  const { withDynamicNote } =
    (typeof module !== "undefined" && module.exports) ? require("./prompt") : globalThis.TumugiPrompt;

  // 判定用の履歴では、つむぎの返事の前にこれを付ける（判定の指示が「つむぎ：」で始まる assistant を返事として読む）
  const JUDGE_SPEAKER_PREFIX = "つむぎ：";

  // 判定に渡す、直近の Item の数（ログイン時のあいさつも1件、1往復も1件と数える）。理由は先頭のコメント
  const JUDGE_WINDOW_ITEMS = 3;

  // 新しく分かったことを、次の発言の後ろに付けるときの見出し
  const FACTS_HEADING = "【このユーザーについて新しく分かったこと】";

  // 要約のきっかけ：会話の流れがこの件数を超えたとき、または返事の入力がこの語数（トークン）を超えたとき
  const SUMMARY_TRIGGER_MESSAGES = 80;
  const SUMMARY_TRIGGER_TOKENS   = 6000;

  // 要約のとき、最後のこの件数（発言の数）以上は、そのまま履歴に残す。
  // 最後の10件（往復5個）は残るので、判定に渡す直近の3 Item は、作り直しても変わらない。
  // JUDGE_WINDOW_ITEMS を5より大きくするときは、ここと script.js の applyPendingRebuild の judge: false を見直す
  const SUMMARY_KEEP_MESSAGES = 10;

  // -----------------------------------------
  // 会話をつくる・足す
  // -----------------------------------------
  function createConversation(replySystem, judgeSystem) {
    return { replySystem, judgeSystem, items: [] };
  }

  // ログイン時のあいさつ（社員の発言より前にあるので、user は null）
  function addGreeting(conv, text) {
    conv.items.push({ user: null, assistant: text, facts: "" });
  }

  // 1回の往復を足す。facts：その発言の後ろに付けた「新しく分かったこと」の文
  function addExchange(conv, userText, assistantText, facts = "") {
    conv.items.push({ user: userText, assistant: assistantText, facts });
  }

  // 新しく分かったこと（{項目: 値}）を、発言の後ろに付ける文にする。値が空の項目は除く
  function factsNote(facts) {
    const lines = Object.entries(facts || {})
      .filter(([, value]) => value != null && String(value).trim() !== "")
      .map(([key, value]) => `・${key}：${value}`);
    return lines.length ? `\n${FACTS_HEADING}\n${lines.join("\n")}` : "";
  }

  // -----------------------------------------
  // 履歴の組み立て（Item を発言の並びにする）
  // -----------------------------------------
  function isGreeting(item) {
    return item.user === null;
  }

  // 判定用の履歴：直近の JUDGE_WINDOW_ITEMS 件の Item だけを並べる（Item がそれ以下なら全部）
  function judgeHistory(conv) {
    return conv.items.slice(-JUDGE_WINDOW_ITEMS).flatMap((item) => {
      const reply = { role: "assistant", content: JUDGE_SPEAKER_PREFIX + item.assistant };
      return isGreeting(item) ? [reply] : [{ role: "user", content: item.user }, reply];
    });
  }

  function replyHistory(conv) {
    return conv.items.flatMap((item) => {
      const reply = { role: "assistant", content: item.assistant };
      return isGreeting(item)
        ? [reply]
        : [{ role: "user", content: withDynamicNote(item.user, item.facts) }, reply];
    });
  }

  // ノートも「つむぎ：」も付けない並び（要約の文に使う）
  function plainOf(items) {
    return items.flatMap((item) => {
      const reply = { role: "assistant", content: item.assistant };
      return isGreeting(item) ? [reply] : [{ role: "user", content: item.user }, reply];
    });
  }

  // 判定の入力：[判定の指示, 判定用の履歴（直近の3件）…, 今回の発言]。今回の発言にノートは付けない
  function judgeMessages(conv, userText) {
    return [...judgePrefillMessages(conv), { role: "user", content: userText }];
  }

  // 判定の先読み・整え用：judgeMessages から今回の発言を除いたもの（最後は assistant か system）。
  // 返事のあとに送る整えは、これで次の判定の入力の前半を読ませておく（直近3件がずれたあとの形になる）
  function judgePrefillMessages(conv) {
    return [{ role: "system", content: conv.judgeSystem }, ...judgeHistory(conv)];
  }

  // 返事の入力：[返事のシステムプロンプト, 返事の履歴…, 今回の発言＋ノート]
  function replyMessages(conv, userText, note) {
    return [...replyPrefillMessages(conv), { role: "user", content: withDynamicNote(userText, note) }];
  }

  // 返事の先読み・整え用：replyMessages から今回の発言を除いたもの
  function replyPrefillMessages(conv) {
    return [{ role: "system", content: conv.replySystem }, ...replyHistory(conv)];
  }

  function plainMessages(conv) {
    return plainOf(conv.items);
  }

  function messageCount(conv) {
    return plainMessages(conv).length;
  }

  // -----------------------------------------
  // 要約と、履歴の作り直し
  // -----------------------------------------
  function needsSummary(conv, lastPromptTokens) {
    return messageCount(conv) > SUMMARY_TRIGGER_MESSAGES || lastPromptTokens > SUMMARY_TRIGGER_TOKENS;
  }

  // 要約に使う分。後ろから Item の発言の数を足していき、SUMMARY_KEEP_MESSAGES 以上になったところまでを残す。
  // それより前の Item が要約する分（dropItems 個）。要約するものがなければ null
  function summaryTarget(conv) {
    let keptItems = 0;
    let keptMessages = 0;
    for (let i = conv.items.length - 1; i >= 0 && keptMessages < SUMMARY_KEEP_MESSAGES; i--) {
      keptMessages += isGreeting(conv.items[i]) ? 1 : 2;
      keptItems++;
    }
    const dropItems = conv.items.length - keptItems;
    if (dropItems <= 0) return null;
    return { messages: plainOf(conv.items.slice(0, dropItems)), dropItems };
  }

  // 履歴の作り直し。先頭の dropItems 個の Item を消し、残した Item の「新しく分かったこと」も消す
  // （記憶は新しい replySystem に入るため）。元の会話は変えない。
  // 記憶を直したときは dropItems を 0 にして、履歴を短くしない
  function rebuild(conv, { replySystem, dropItems }) {
    return {
      replySystem,
      judgeSystem: conv.judgeSystem,
      items: conv.items.slice(dropItems).map((item) => ({ ...item, facts: "" })),
    };
  }

  // 社員の発言を処理している途中に届いた作り直しの頼み（pending）を、新しい頼み（next）と1回にまとめる。
  // 要約は新しいほうを使い（なければ前のまま）、消す Item の数は大きいほうを使う
  function mergeRebuild(pending, next) {
    return {
      summary: next.summary ?? pending?.summary ?? null,
      dropItems: Math.max(pending?.dropItems ?? 0, next.dropItems),
    };
  }

  const api = Object.freeze({
    JUDGE_SPEAKER_PREFIX, JUDGE_WINDOW_ITEMS, FACTS_HEADING,
    SUMMARY_TRIGGER_MESSAGES, SUMMARY_TRIGGER_TOKENS, SUMMARY_KEEP_MESSAGES,
    createConversation, addGreeting, addExchange, factsNote,
    judgeMessages, judgePrefillMessages, replyMessages, replyPrefillMessages, plainMessages,
    messageCount, needsSummary, summaryTarget, rebuild, mergeRebuild,
  });

  // テスト（Node）では module.exports、画面では window.TumugiConversation として使う
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    globalThis.TumugiConversation = api;
  }
})();
