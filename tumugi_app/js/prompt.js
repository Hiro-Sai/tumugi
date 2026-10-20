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
  // 毎回行うと、判定・返事・抽出の3種類の入力で Ollama のキャッシュを奪い合い、
  // どれのキャッシュも効かなくなるため（Ollama が覚えておける入力は2つまで）。
  const MEMORY_EXTRACT_EVERY = 3;

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
    NOTE_SEPARATOR, MEMORY_EXTRACT_EVERY,
    withDynamicNote, stripPlaceholders, buildReplySystemPrompt, buildMemoryPrompt, buildGreeting,
  });

  // テスト（Node）では module.exports、画面では window.TumugiPrompt として使う
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    globalThis.TumugiPrompt = api;
  }
})();
