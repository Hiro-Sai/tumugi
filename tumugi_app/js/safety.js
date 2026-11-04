// =========================================
// js/safety.js
// 安全判定（危機検知・ハラスメント検知）の部品：
//   - 危機のキーワード（hasCrisisKeyword）：Ollama を呼ぶ前に、すぐ判定する安全網
//   - 判定専用の呼び出しの指示・JSON スキーマ・結果の読み取り（送る会話の組み立ては js/conversation.js）
//   - 返事の JSON スキーマ（REPLY_SCHEMA）：返事の5つの欄を必ず出させる
//   - 返事の読み取り（parseReply）：壊れた返事を見分ける
//   - 書きかけの返事から line を取り出す（extractStreamingLine）：返事を少しずつ受け取る途中で、吹き出しに出す文字を得る
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
  // 入力は [この指示（system）, 判定用の履歴, 今回の発言（user）]。判定用の履歴は、assistant の発言の前に
  // 「つむぎ：」を付けた会話の、直近の3件（js/conversation.js の JUDGE_WINDOW_ITEMS）。
  // 返事のあとに送る判定の整えの後ろに、今回の発言を足すだけで組み立てる。
  // 2026-11-02 の測定で、会話の全体を渡すと長い会話のあとで見逃しが増えたので、直近の3件にした
  // （設計書 docs/superpowers/specs/2026-10-27-cpu-only-speed-design.md の3章「長い会話のあとの判定」）。
  // 2026-10-13 の測定（返事と一緒に判定する方式・考えるモードとの比較）で、
  // 理由を先に書かせるこの方式が、いちばん見逃しが少なかった。
  // 2026-10-27 の測定（68文）で、直前の2往復を1つの文にして渡す今までの形より、会話そのものを渡して
  // 最初の4行を足したこの形（c2）が、見逃しも誤検知も同じか少なかった。
  // 4行目の後半（話の続きでなければ今回の判定には入れない）を除いた形（c）では、
  // 前に出たハラスメントの話が、話題が変わったあとも判定に残った。それを防ぐための1文。
  // 5行目から後ろ（判定の決め方）は、2026-10-13 に決めたものから変えていない。
  // 指示の文を変えたら、測定し直すこと（言い回し1つで拾える文が入れ替わる）。
  // -----------------------------------------
  const CLASSIFY_INSTRUCTION = `あなたは、相談アプリ「つむぎ」の会話を読んで、安全判定だけを行う係です。ユーザーへの返事は書きません。
これから渡す会話で、user はアプリを使っている社員、assistant（「つむぎ：」で始まる文）は相談アプリ「つむぎ」の返事です（あなたの発言ではありません）。
会話の最後の user の発言が「今回の発言」です。判定するのは、今回の発言だけです。
それより前のやり取りは、今回の発言の意味を読み取るために使うこと。前のやり取りに危機やハラスメントの話があっても、今回の発言がその話の続きでなければ、今回の判定には入れない。

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

  // -----------------------------------------
  // 書きかけの返事から line を取り出す
  // 返事を少しずつ受け取っている途中で、吹き出しに出す line を、いま届いているところまで取り出す。
  // 取り出すのは "line" の値の文字列だけ（user_emotion・emotion などの前の欄は読み飛ばす）。
  // JSON のエスケープ（\" \\ \/ \n \t \r \b \f \uXXXX）は読んだ文字にして返す。
  // 文の終わりがエスケープの途中（「\」だけ、「\u30」など）のときは、その手前までを返す。
  // 絵文字の上位サロゲート（\ud83d）だけが届いて下位がまだのときも、壊れた文字を出さないよう除く。
  // 正しくないエスケープに出会ったときも、そこで読むのをやめる（最後の parseReply が使えるかを決める）。
  // 値がまだ始まっていない・文字列でないときは null。
  // -----------------------------------------
  const LINE_VALUE_START = /"line"\s*:\s*"/;
  const SIMPLE_ESCAPES = Object.freeze({ '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" });
  const UNICODE_ESCAPE_DIGITS = /^[0-9a-fA-F]{4}$/;
  const TRAILING_HIGH_SURROGATE = /[\uD800-\uDBFF]$/;

  function extractStreamingLine(raw) {
    if (typeof raw !== "string") return null;
    const start = LINE_VALUE_START.exec(raw);
    if (!start) return null;

    let text = "";
    let i = start.index + start[0].length;
    while (i < raw.length) {
      const ch = raw[i];
      if (ch === '"') break; // line の値の終わり
      if (ch !== "\\") {
        text += ch;
        i += 1;
        continue;
      }

      const next = raw[i + 1];
      if (next === "u") {
        const digits = raw.slice(i + 2, i + 6);
        if (!UNICODE_ESCAPE_DIGITS.test(digits)) break; // 4桁に満たない（まだ届いていない）
        text += String.fromCharCode(parseInt(digits, 16));
        i += 6;
      } else if (next !== undefined && Object.prototype.hasOwnProperty.call(SIMPLE_ESCAPES, next)) {
        text += SIMPLE_ESCAPES[next];
        i += 2;
      } else {
        break; // 「\」だけ届いている、または正しくないエスケープ
      }
    }

    return text.replace(TRAILING_HIGH_SURROGATE, "");
  }

  const api = Object.freeze({
    CRISIS_KEYWORDS, EMOTIONS, USER_EMOTIONS, HARASSMENT_TYPES, REPLY_SCHEMA, parseReply, extractStreamingLine,
    CLASSIFY_INSTRUCTION, CLASSIFY_SCHEMA,
    hasCrisisKeyword, parseClassification,
  });

  // テスト（Node）では module.exports、画面では window.TumugiSafety として使う
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    globalThis.TumugiSafety = api;
  }
})();
