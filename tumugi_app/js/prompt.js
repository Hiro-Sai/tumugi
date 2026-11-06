// =========================================
// js/prompt.js
// Ollama に送る文の組み立て（返事のシステムプロンプト・動的ノート・記憶の抽出の指示）と、
// ログイン時のあいさつの定型文。
// 画面（index.html から script.js より先に読み込む）と、単体テスト（test/prompt.test.js）の両方から使う。
//
// 並べ方は、Ollama の入力のキャッシュが効くように決めている（2026-10-13 の測定）：
//   システムプロンプト：変わらないキャラクターの指示 → ときどき変わる記憶・要約
//   会話の流れ → 最後の発言（毎回変わる動的ノートは、ここの後ろに付ける）
// 先頭に近いところが変わると、そこから後ろをすべて処理し直すことになる。
// 動的ノートがシステムプロンプトの2行目にあった頃は、毎回ほぼ全部を処理し直していた。
// =========================================

(function () {
  "use strict";

  // 動的ノートを発言の後ろに付けるときの区切り。モデルがユーザーの発言と取り違えないようにする
  const NOTE_SEPARATOR = "\n\n（ここから下はつむぎへの指示で、ユーザーの発言ではない）";

  // 記憶の抽出は、この往復数がたまるごとに、まとめて1回行う。
  // 抽出の呼び出しを減らして、そのあいだ判定と返事が待たされる時間を短くするため（とくに CPU だけの PC）。
  // 前は「判定・返事・抽出の入力で Ollama のキャッシュを奪い合い、どれも効かなくなる」ことを理由にしていたが、
  // Ollama 0.40.11 は読ませた入力のキャッシュを何件も持てるので、その奪い合いはほぼ起きない
  // （docs/superpowers/specs/2026-10-27-cpu-only-speed-design.md の3章）。
  const MEMORY_EXTRACT_EVERY = 3;

  // ユーザーの気持ち（TumugiSafety.USER_EMOTIONS）の呼び名
  const EMOTION_LABEL = Object.freeze({
    happy: "嬉しい", normal: "普通", tired: "疲れ",
    anxious: "不安", angry: "怒り・いらだち", sad: "悲しい・落ち込み",
  });

  // 気持ちが同じ向きで続いているか（新しい順の配列）。normal や1回だけなら null
  function detectEmotionStreak(userEmotions) {
    if (userEmotions.length < 2) return null;
    const latest = userEmotions[0];
    if (latest === "normal") return null;

    let streak = 1;
    for (let i = 1; i < userEmotions.length; i++) {
      if (userEmotions[i] === latest) streak++;
      else break;
    }
    if (streak >= 2) return { emotion: latest, streak };
    return null;
  }

  // 文末の3文字。「…」「。」「！」などは除いてから取る（「んだね」と「んだね…」を同じ終わり方として扱うため）
  function extractLineEnding(line) {
    if (!line) return "";
    const trimmed = line.trim().replace(/[…。.．！!〜~\s]+$/u, "");
    return trimmed.slice(-3);
  }

  // 動的ノート（感情の流れ・言い方の重複回避）。毎回変わるので、発言の後ろに付ける（withDynamicNote）
  // recentReplies：{ line, share, question } の配列（新しい順、最大3件）。ない欄は "" として扱う
  // userEmotions：ユーザーの気持ちの配列（新しい順、最大5件）
  function buildDynamicNote({ recentReplies = [], userEmotions = [] } = {}) {
    let note = "";

    const streak = detectEmotionStreak(userEmotions);
    if (streak) {
      const label = EMOTION_LABEL[streak.emotion] || streak.emotion;
      note += `
【感情の流れに注意】
直近${streak.streak}回連続でユーザーの感情が「${label}」傾向。一時的な気分ではなく根深い悩みかもしれない。
いつもより一段深く受け止め、気持ちの想像をより丁寧に行うこと。`;
    }

    // 欄が足りない返事（代わりの返事など）でも動くように、ない欄は "" にそろえる
    const replies = recentReplies.map(x => ({
      line: (x && x.line) || "",
      share: (x && x.share) || "",
      question: (x && x.question) || "",
    }));

    if (replies.length > 0) {
      const endings = replies.map(x => `「…${extractLineEnding(x.line)}」`).join("");
      note += `
【言い方の重複回避】
直近のlineの終わり方は ${endings} だった。今回はこれらと違う終わり方・違う受け止め方にすること。`;

      // 指示では「感じ」を使わない。破ったときの歯止めとして、直近2回の line か question で使っていたら念を押す
      if (replies.slice(0, 2).some(x => x.line.includes("感じ") || x.question.includes("感じ"))) {
        note += `
直近で「感じ」を使ったので、今回は line でも question でも「感じ」を使わないこと。`;
      }

      // 気持ちを当てにいく言い方（「〜な感じかな？」「〜ったりする？」）が続かないようにする
      const lastText = replies[0].line + replies[0].question;
      if (/(感じ|感覚|ったりする|思っちゃった|近い|ってこと)[^。！!、]{0,4}(かな|[？?])/.test(lastText)) {
        note += `
前回は気持ちを想像して問いかけたので、今回は別の受け止め方にすること。`;
      }

      // 気づかいの一言（「暖かくしてね」など）が続かないようにする。share も見る
      const recentText = replies.slice(0, 2).map(x => x.line + x.share + x.question).join("");
      if (/(暖か|あったか|温か|休んで|休もう|寝てね|寝よう|気をつけ|無理し|お大事|水分|とってね|食べてね|冷やさ)/.test(recentText)) {
        note += `
直近で気づかいの一言を言ったので、今回は気づかい以外の返し方（反応・受け止め・問いかけ）にすること。お礼やあいさつには、まずそれに返すこと。`;
      }

      // 問いかけが「今日は〜？」で続かないようにする（直近2回を見る）
      // question：中のどれかの文の頭（先頭か「、」「。」「！」「…」・空白のあと）が「今日」なら当たる。「？」は要らない
      // line：文の頭の「今日」から終わりまで「、」「。」「！」「…」がなく、「？」で終わるなら当たる
      // （2026-11-06 の測定で、軽いひと言の問いかけの半分近くが「今日」で始まっていた）
      const asksAboutToday = (x) =>
        /(^|[、。！!…\s])今日/u.test(x.question) || /(^|[、。！!…\s])今日[^、。！!…]*[？?]\s*$/u.test(x.line);
      if (replies.slice(0, 2).some(asksAboutToday)) {
        note += `
直近の問いかけを「今日」で始めたので、今回は「今日」で始めず、別のことを聞くこと。`;
      }
    }

    return note;
  }

  function withDynamicNote(userText, note) {
    return note ? userText + NOTE_SEPARATOR + note : userText;
  }

  // プリセットに残っている {{MEMORY_TEXT}} などの差し込み口を消す
  function stripPlaceholders(template) {
    return template.replace(/\{\{[A-Z_]+\}\}/g, "");
  }

  function buildReplySystemPrompt(template, memoryText, summaryText) {
    return stripPlaceholders(template) + (memoryText || "") + (summaryText || "");
  }

  // exchanges：[[ユーザーの発言, つむぎの返事], ...]　memory：既に知っている情報
  function buildMemoryPrompt(exchanges, memory) {
    const talk = exchanges.map(([user, ai]) => `ユーザー：「${user}」\nAIの返答：「${ai}」`).join("\n");
    return `以下の会話から、ユーザーに関する新しい情報を抽出してください。

${talk}

既に知っている情報：
${JSON.stringify(memory, null, 2)}

抽出できる情報があれば以下のJSON形式で返してください。新しい情報がなければ {} を返してください。
抽出対象：名前、年齢、職業、趣味、好きなもの、嫌いなもの、最近の出来事、悩み、家族構成など。
既に知っている情報と重複する場合は含めない。より詳しい情報があれば上書きしてよい。

JSON形式のみ出力。説明文不要。
例：{"名前":"たろう","趣味":"ギター"}`;
  }

  // ログイン時のあいさつ（定型文。Ollama には送らない）。時間帯（0〜23時）で文を変え、
  // 名前（記憶の「名前」）が分かっていれば入れる。入力欄から入った名前なので、長すぎるものは使わない
  const GREETING_NAME_MAX = 20;

  function buildGreeting(hour, name) {
    const trimmed = typeof name === "string" ? name.trim() : "";
    const n = trimmed.length <= GREETING_NAME_MAX ? trimmed : "";
    if (hour >= 5 && hour < 10) {
      return n ? `おはよ〜、${n}。今日はどんな一日になりそう？` : "おはよ〜。今日はどんな一日になりそう？";
    }
    if (hour >= 10 && hour < 17) {
      return n ? `${n}、おつかれ〜。今日はどう過ごしてる？` : "おつかれ〜。今日はどう過ごしてる？";
    }
    return n ? `おかえり〜、${n}。今日はどんな一日だった？` : "おかえり〜。今日はどんな一日だった？";
  }

  const api = Object.freeze({
    NOTE_SEPARATOR, MEMORY_EXTRACT_EVERY, EMOTION_LABEL,
    extractLineEnding, buildDynamicNote,
    withDynamicNote, stripPlaceholders, buildReplySystemPrompt, buildMemoryPrompt, buildGreeting,
  });

  // テスト（Node）では module.exports、画面では window.TumugiPrompt として使う
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    globalThis.TumugiPrompt = api;
  }
})();
