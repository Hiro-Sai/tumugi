// =========================================
// js/safety.js
// 安全判定（危機検知・ハラスメント検知）の部品：
//   - 危機のキーワード（hasCrisisKeyword）：Ollama を呼ぶ前に、すぐ判定する安全網
//   - 判定専用の呼び出しの指示・JSON スキーマ・送る文の組み立て・結果の読み取り
//   - 返事の JSON スキーマ（REPLY_SCHEMA）：返事の5つの欄を必ず出させる
//   - 返事の読み取り（parseReply）：壊れた返事を見分ける
// 画面（index.html から script.js より先に読み込む）と、単体テスト（test/safety.test.js）の両方から使う。
// =========================================

(function () {
  "use strict";

  // -----------------------------------------
  // 危機のキーワード
  // 一致したら Ollama を呼ばずに、すぐ相談先を案内する。
  // 見逃しを減らすことを優先するが、仕事の話でもよく出る言い回し
  // （「楽になりたい」「終わらせたい」「飛び込み（営業）」など）は入れず、Ollama の判定に任せる。
  // 遠回しな表現（身辺整理・保険金など）も Ollama の判定に任せる。
  // 「遺書」も、ドラマや小説の話でも出るため入れない（2026-10-13 の測定で、Ollama は
  // 「遺書みたいなものを書いてみた」を拾い、ドラマの遺書のシーンの話は危機と判定しなかった）。
  // -----------------------------------------
  const CRISIS_KEYWORDS = Object.freeze([
    // 前からあったもの（消さない）
    "死にたい", "死んじゃおう", "死んでしまいたい", "死ねばよかった", "死のうかな",
    "消えたい", "消えてしまいたい", "いなくなりたい",
    "自殺", "首を吊", "飛び降り", "リストカット", "自傷",
    "もう終わりにしたい", "生きていたくない", "生きてる意味がない",
    "もう生きていたくない", "消えてしまえばいい",
    // ひらがなで書いたもの
    "しにたい", "きえたい", "じさつ",
    // 死にたい気持ち（「死にたくない」に反応しないよう「死にたくな」にはしない）
    "死にたくなる", "死にたくなっ", "死ぬしかない", "死んだら楽", "楽に死ね",
    "生まれてこなければ", "目が覚めなければ",
    "生きるのがつらい", "生きるのが辛い", "生きるのがしんどい",
    "生きる意味がない", "生きている意味がない",
    // 方法
    "死ぬ方法", "死に方を", "死に場所",
    "首吊", "首つり", "リスカ", "手首を切", "身を投げ", "練炭",
    "電車に飛び込", "線路に飛び込", "オーバードーズ", "薬を大量に",
  ]);

  // 照合の前に、全角・半角の違い（NFKC）と空白・改行をならす
  function normalizeForMatch(text) {
    return text.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  }

  const NORMALIZED_KEYWORDS = CRISIS_KEYWORDS.map(normalizeForMatch);

  function hasCrisisKeyword(text) {
    if (typeof text !== "string" || text === "") return false;
    const normalized = normalizeForMatch(text);
    return NORMALIZED_KEYWORDS.some(kw => normalized.includes(kw));
  }

  // つむぎの表情（立ち絵の画像 images/<表情>_open.png と対応）
  const EMOTIONS         = Object.freeze(["happy", "sad", "normal", "surprised", "angry", "troubled"]);
  // ユーザーの気持ち（感情ログに送る）。サーバーの includes/emotion_scores.php の表と同じ分類にすること
  const USER_EMOTIONS    = Object.freeze(["happy", "normal", "tired", "anxious", "angry", "sad"]);
  const HARASSMENT_TYPES = Object.freeze(["none", "received", "said"]);

  // -----------------------------------------
  // 判定専用の呼び出し
  // 返事とは別に Ollama を呼び、crisis と harassment だけを決めさせる。
  // 2026-10-13 の測定（返事と一緒に判定する方式・考えるモードとの比較）で、
  // 理由を先に書かせて直前の2往復を渡すこの方式が、いちばん見逃しが少なかった。
  // 指示の文を変えたら、測定し直すこと（言い回し1つで拾える文が入れ替わる）。
  // -----------------------------------------
  const CLASSIFY_HISTORY_TURNS = 2; // 直前の何往復を一緒に渡すか

  const CLASSIFY_INSTRUCTION = `あなたは、相談アプリ「つむぎ」の会話を読んで、安全判定だけを行う係です。ユーザーへの返事は書きません。
【判定する発言】がユーザーの今回の発言です。【これまでの会話】がある場合は、その流れも踏まえて今回の発言の意味を読み取ること。

"crisis": 今回の発言（とそこまでの流れ）に、死にたい気持ち・自殺・自傷をほのめかす内容があれば true、なければ false。
  - 「死」「自殺」という言葉がなくても、次のような遠回しな表現なら true にする。
    ・自分はいないほうがいい、いなくても誰も困らない、生まれてこなければよかった、と自分の存在を否定する
    ・このまま目が覚めなければいい、消えてしまいたい、と死を望む
    ・高い所や駅・線路に引き寄せられる、飛び降りや飛び込みを思い浮かべる
    ・遺書や別れのあいさつを書く・伝える、身の回りを整理する
    ・死ぬ方法を調べる、そのための物を用意する
  - 迷ったら true にする（見逃すほうが危険なため）。
  - 「（笑）」がついた冗談や、「死ぬほど眠い」「死にそうなくらい忙しい」のような明らかに大げさな言い方は false。

"harassment": 今回の発言が職場でのハラスメント（パワハラ・セクハラ等）に関する内容の場合、以下のいずれかを設定する。それ以外は "none"。
  - "received": 自分がハラスメントを受けた（された・言われた）という内容
  - "said": 自分が他者にハラスメント的な言動をしてしまったという内容

"reason": crisis と harassment を決める前に、判断の理由を40字以内で書く。

出力例：{"reason":"...","crisis":false,"harassment":"none"}`;

  // 欄の順番は、生成される順番でもある（理由を書いてから crisis と harassment を決めさせる）
  const CLASSIFY_SCHEMA = Object.freeze({
    type: "object",
    properties: Object.freeze({
      reason:     Object.freeze({ type: "string" }),
      crisis:     Object.freeze({ type: "boolean" }),
      harassment: Object.freeze({ type: "string", enum: HARASSMENT_TYPES }),
    }),
    required: Object.freeze(["reason", "crisis", "harassment"]),
  });

  const SPEAKER = Object.freeze({ user: "ユーザー", assistant: "つむぎ" });

  // history は今回の発言を含まない会話の流れ（[{ role, content }, ...]）
  function buildClassifyMessage(history, userText) {
    const recent = (Array.isArray(history) ? history : [])
      .filter(m => m && SPEAKER[m.role] && typeof m.content === "string")
      .slice(-CLASSIFY_HISTORY_TURNS * 2);
    const past = recent.length
      ? "【これまでの会話】\n" + recent.map(m => `${SPEAKER[m.role]}：${m.content}`).join("\n") + "\n\n"
      : "";
    return past + "【判定する発言】\n" + userText;
  }

  // 読み取れないときは、危機なし・ハラスメントなしにする（キーワードの安全網は別にある）。
  // ただし JSON が途中で切れていても、"crisis": true が見えていれば危機として拾う。
  function parseClassification(raw) {
    const none = { crisis: false, harassment: "none" };
    if (typeof raw !== "string") return none;

    const first = raw.indexOf("{");
    const last  = raw.lastIndexOf("}");
    if (first !== -1 && last > first) {
      try {
        const parsed = JSON.parse(raw.slice(first, last + 1));
        return {
          crisis:     parsed.crisis === true,
          harassment: HARASSMENT_TYPES.includes(parsed.harassment) ? parsed.harassment : "none",
        };
      } catch (e) {
        // 下の救出へ
      }
    }

    const harassment = raw.match(/"harassment"\s*:\s*"(none|received|said)"/);
    return {
      crisis:     /"crisis"\s*:\s*true/.test(raw),
      harassment: harassment ? harassment[1] : "none",
    };
  }

  // -----------------------------------------
  // 返事の JSON スキーマ
  // 安全判定は判定専用の呼び出しで行うので、返事には判定の欄を持たせない。
  // user_emotion はユーザーの気持ち（感情ログと「感情の流れに注意」に使う）、
  // emotion はつむぎの表情（立ち絵に使う）。以前は emotion が両方を兼ねていて、
  // 感情ログにつむぎの表情が記録されていた（「4時間も残業」→ surprised など）。
  // 欄の順番は、生成される順番でもある。ユーザーの気持ちは、返事を書く前に決めさせる。
  // ユーザーの気持ちを判定の呼び出しで決める案は、危機の見逃しが増えたので採用しなかった（2026-10-13 の測定）。
  // -----------------------------------------
  const REPLY_SCHEMA = Object.freeze({
    type: "object",
    properties: Object.freeze({
      user_emotion: Object.freeze({ type: "string", enum: USER_EMOTIONS }),
      emotion:      Object.freeze({ type: "string", enum: EMOTIONS }),
      line:         Object.freeze({ type: "string" }),
      share:        Object.freeze({ type: "string" }),
      question:     Object.freeze({ type: "string" }),
    }),
    required: Object.freeze(["user_emotion", "emotion", "line", "share", "question"]),
  });

  // -----------------------------------------
  // 返事の読み取り
  // 使えるのは、JSON として読めて、line があり、モデルの特殊トークン（<tool_call|> など）が
  // 混ざっていない返事だけ。それ以外は null を返す（呼ぶ側で作り直す）。
  // 2026-10-15 の測定で、まれに特殊トークンを出力の上限まで出し続けたり、欄の中に
  // 「」}<tool_call|>};]from_system_prompt…」のような文字が混ざったりした。
  // ユーザーの気持ちが分類にないときは userEmotion を null にする（返事は使い、感情ログは送らない）。
  // -----------------------------------------
  const SPECIAL_TOKEN = /<\|[a-z_]+\|?>|<[a-z_]+\|>|<(?:start|end)_of_turn>/i;

  function parseReply(raw) {
    if (typeof raw !== "string" || SPECIAL_TOKEN.test(raw)) return null;

    const first = raw.indexOf("{");
    const last  = raw.lastIndexOf("}");
    if (first === -1 || last <= first) return null;

    let parsed;
    try {
      parsed = JSON.parse(raw.slice(first, last + 1));
    } catch (e) {
      return null;
    }

    const text = (value) => (typeof value === "string" ? value.trim() : "");
    const line = text(parsed?.line);
    if (!line) return null;

    return {
      userEmotion: USER_EMOTIONS.includes(parsed.user_emotion) ? parsed.user_emotion : null,
      emotion:     EMOTIONS.includes(parsed.emotion) ? parsed.emotion : "normal",
      line,
      share:       text(parsed.share),
      question:    text(parsed.question),
    };
  }

  const api = Object.freeze({
    CRISIS_KEYWORDS, EMOTIONS, USER_EMOTIONS, HARASSMENT_TYPES, REPLY_SCHEMA, parseReply,
    CLASSIFY_HISTORY_TURNS, CLASSIFY_INSTRUCTION, CLASSIFY_SCHEMA,
    hasCrisisKeyword, buildClassifyMessage, parseClassification,
  });

  // テスト（Node）では module.exports、画面では window.TumugiSafety として使う
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    globalThis.TumugiSafety = api;
  }
})();
