const avatar   = document.getElementById("avatar");
const chatArea = document.getElementById("chatArea");

let currentEmotion = "normal";
let isBlinking     = false;
let isSpeaking     = false;
let mouthOpen      = false; // 声に合わせて口が開いているか（playVoice が切り替える）

// =========================
// 会話履歴（マルチターン）
// 判定用と返事用の履歴は、1つの会話（conversation）にまとめて持つ。Ollama に送る入力は、
// 前の回の入力の後ろに足すだけで組み立てる（理由は js/conversation.js）。
// 判定に渡すのは直近の3件だけで、返事のあとに判定の整えを送る（askOllama・showCrisisSupportMessages）。
// 会話は、最初に必要になったときに作る（ensureConversation）。
// =========================
let conversation = null;

// 記憶の抽出で新しく分かったこと。次の返事の入力で、発言の後ろに1回だけ付ける
// （システムプロンプトは会話の途中では変えないため。取り出すのは takePendingFacts）。
// 履歴を作り直したときは、今の記憶がシステムプロンプトに入るので、空にする（applyPendingRebuild）
let pendingFacts = {};

// 直近の返事の呼び出しで、Ollama が読んだ入力の語数（prompt_eval_count）。askOllama が入れる。
// 要約するかどうかの判断（needsSummary）に使う。
// Ollama 0.40.11 は、キャッシュから使った分も含めた数を返す（2026-10-27 に確かめた）。
// 版が変わって、新しく処理した分だけを返すようになると、6000語のきっかけは黙って立たなくなり、80件のきっかけだけが残る。
// Ollama の版を上げたら、console の `[時間]` で、返事の入力の語数が回ごとに増えていくことを確かめる。
let lastReplyPromptTokens = 0;

// 社員の発言を処理している途中か（handleUserInput の始まりから終わりまで。声を読んでいるあいだも含む）。
// 履歴の作り直しは、この回の分を履歴に足し終えてから行うので、途中は待たせる（requestRebuild）
let turnInProgress = false;

// 待たせている履歴の作り直しの頼み（{ summary, dropItems }）。なければ null。
// 要約と記憶の変更が重なったら、1回にまとめる（mergeRebuild）
let pendingRebuild = null;

// 今の発言を受け取った時刻（handleUserInput の始まり）。「発言から文字まで」の時間の記録に使う
let turnStartedAt = 0;

// ユーザーの気持ち（新しい順）。「感情の流れに注意」の判断（TumugiPrompt.buildDynamicNote）に使う。
// つむぎの表情ではなく、返事の user_emotion を入れる
const userEmotionHistory = [];
const EMOTION_HISTORY_MAX = 5;

// 直近の返事 { line, share, question }（新しい順）。言い方の重複を避ける指示（TumugiPrompt.buildDynamicNote）に使う
const recentReplies = [];
const RECENT_REPLIES_MAX = 3;

// 要約の文。返事のシステムプロンプトに入る（summaryToText）。履歴を作り直すときに入れ替わる
let conversationSummary = "";
// 要約を Ollama に頼んで、応答を待っているあいだは true（要約が重ならないようにする）
let isSummarizing = false;

// =========================
// Ollama 設定
// モデル名・num_ctx・think の設定と、その理由は js/ollama.js にある（index.html で script.js より先に読み込む）。
// 企業配布時にモデルを固定したい場合も、js/ollama.js の DEFAULT_MODEL を書き換える。
// 一般社員向けUIからのモデル切り替え機能は廃止済み（運用者のみが対応する想定）。
// checkModelAvailability() 等の関数自体は残しているが、対応するUI要素が
// index.html側にないため、現状呼び出されることはない。
// =========================
const OLLAMA_NUM_CTX = TumugiOllama.NUM_CTX;

function getOllamaModel() {
  return TumugiOllama.getOllamaModel(localStorage);
}

function saveOllamaModel(modelName) {
  const name = modelName.trim();
  if (!name) return;
  localStorage.setItem(TumugiOllama.MODEL_KEY, name);
}

// =========================
// ユーザー記憶（永続化）
// 社員ごとに、その人のパスワードから作った鍵で暗号化して保存する（main.js・memory-crypto.js）。
// 起動時に loadMemoryFromStore() で1回だけ読み込み、ここに置いた写しを使う。
// =========================
let userMemory = {};
// この社員の記憶が保存されているか。「はじめまして」画面を出すかどうかの判定に使う
// （スキップしたときも空の記憶を保存するので、一度でも答えた社員は true になる）
let hasSavedMemory = false;

// 以前は記憶を localStorage に平文で、全社員共通の1つとして保存していた。
// 誰の記憶か分からないため、引き継がずに消す（PC ごとの「はじめまして済み」の印も同じ）
const LEGACY_LOCAL_KEYS = ["tumugi_user_memory", "tumugi_setup_done", "tumugi_notice_done"];

async function loadMemoryFromStore() {
  LEGACY_LOCAL_KEYS.forEach(key => localStorage.removeItem(key));
  try {
    const result = await window.electronAPI.memoryGet();
    userMemory = result?.memory ?? {};
    hasSavedMemory = !!result?.exists;
  } catch (e) {
    console.warn("[Memory] 読み込み失敗:", e.message);
  }
}

function loadMemory() {
  return { ...userMemory };
}

function saveMemory(memory) {
  userMemory = { ...memory };
  hasSavedMemory = true;
  window.electronAPI.memorySet(userMemory).catch(e => console.warn("[Memory] 保存失敗:", e.message));
}

function memoryToText(memory) {
  if (!memory || Object.keys(memory).length === 0) return "";
  const lines = Object.entries(memory)
    .filter(([, v]) => v)
    .map(([k, v]) => `・${k}：${v}`);
  if (lines.length === 0) return "";
  return `\n【このユーザーについて知っていること】\n${lines.join("\n")}`;
}

// まだ記憶の抽出にかけていない往復（[ユーザーの発言, つむぎの返事]）。
// TumugiPrompt.MEMORY_EXTRACT_EVERY 個たまったら、まとめて抽出する（理由は js/prompt.js）。
// 危機の回は入れない。たまりきる前にアプリを閉じると、その分は記憶されない。
const pendingMemoryExchanges = [];

function queueMemoryExtraction(userText, assistantText) {
  pendingMemoryExchanges.push([userText, assistantText]);
  if (pendingMemoryExchanges.length < TumugiPrompt.MEMORY_EXTRACT_EVERY) return;
  const exchanges = pendingMemoryExchanges.splice(0);
  extractAndSaveMemory(exchanges).catch(() => {});
}

// 会話からユーザー情報を抽出して保存する
async function extractAndSaveMemory(exchanges) {
  const currentMemory = loadMemory();
  const prompt = TumugiPrompt.buildMemoryPrompt(exchanges, currentMemory);

  try {
    const startedAt = performance.now();
    const result = await window.electronAPI.netOllama({
      path: "/api/chat",
      method: "POST",
      body: {
        model: getOllamaModel(),
        messages: [{ role: "user", content: prompt }],
        stream: false,
        think: false, // 理由は js/ollama.js の先頭のコメント
        options: { temperature: 0.1, num_ctx: OLLAMA_NUM_CTX, num_predict: 200 },
      },
    });
    const wallMs = Math.round(performance.now() - startedAt);
    if (!result.ok) return;
    logTimings("記憶の抽出", result.data, wallMs);

    const raw = result.data.message?.content ?? "";

    const firstBrace = raw.indexOf("{");
    const lastBrace  = raw.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace <= firstBrace) return;

    const extracted = JSON.parse(raw.slice(firstBrace, lastBrace + 1));
    if (Object.keys(extracted).length === 0) return;

    const newMemory = { ...currentMemory, ...extracted };
    saveMemory(newMemory);
    // 保存した分は、次の返事の発言の後ろにも付ける（返事のシステムプロンプトは、会話の途中では変えない）
    pendingFacts = { ...pendingFacts, ...extracted };
    console.log(`[Memory] ${Object.keys(extracted).length} 件を更新しました`); // 中身は個人の情報なので出さない
  } catch (e) {
    console.warn("[Memory] 抽出失敗:", e.message);
  }
}

// =========================
// 会話履歴の要約圧縮と、履歴の作り直し
// 要約はめったに起こさない（会話の流れが一定の件数を超えたか、返事の入力が一定の語数を超えたとき。
// js/conversation.js の needsSummary）。履歴の途中を変えると Ollama のキャッシュが効かなくなるため。
// 履歴を作り直して先読みするのは、要約ができたときと、記憶の画面で記憶を直したときだけ。
// それ以外のときは、履歴に足すだけ。
// =========================

// 要約の指示を作る。messages は { role, content } の配列（要約する分の発言）
function buildSummaryPrompt(messages) {
  const historyText = messages.map(m => {
    const role = m.role === "user" ? "ユーザー" : "つむぎ";
    return `${role}：${m.content}`;
  }).join("\n");

  return `以下は「つむぎ」という共感AIとユーザーの会話の前半部分です。
この会話の内容を、後半の会話の文脈理解に使えるよう200字以内で要約してください。
ユーザーの感情の流れ・話題・重要な出来事を中心にまとめること。
要約のみ出力。前置き・見出し不要。

【会話】
${historyText}`;
}

function summaryToText() {
  if (!conversationSummary) return "";
  return `\n【これまでの会話の流れ（要約）】\n${conversationSummary}`;
}

// 古い分を Ollama に要約させ、できたら履歴の作り直しを頼む（requestRebuild）。
// askOllama の最後で、needsSummary のときだけ呼ぶ。待たない。
// 次の場合は何もしない。
// ・要約の応答を待っているあいだ（isSummarizing）
// ・作り直しが待っているあいだ（pendingRebuild）。ここで次の要約を頼むと、消す個数（dropItems）が
//   作り直す前の履歴で数えたものになり、作り直したあとに当てると消しすぎてしまうため
// ・要約する分がないとき（summaryTarget が null）
// 要約は履歴を使わず、要約する分だけを1回の呼び出しで送る。失敗したり、要約が空だったりしたときは作り直さない
// （needsSummary はまだ真なので、次の回の終わりにまた頼む）。
// ログは数と時間だけ（要約の文は会話の内容を含むので出さない）。
async function updateConversationSummary() {
  if (isSummarizing || pendingRebuild) return;
  if (!conversation) return;
  const target = TumugiConversation.summaryTarget(conversation);
  if (!target) return;

  isSummarizing = true;
  try {
    const startedAt = performance.now();
    let res;
    try {
      res = await window.electronAPI.netOllama({
        path: "/api/chat",
        method: "POST",
        body: {
          model: getOllamaModel(),
          messages: [{ role: "user", content: buildSummaryPrompt(target.messages) }],
          stream: false,
          think: false, // 理由は js/ollama.js の先頭のコメント
          options: { temperature: 0.3, num_ctx: OLLAMA_NUM_CTX, num_predict: 300 },
        },
      });
    } finally {
      isSummarizing = false; // 応答が届いたら（成功でも失敗でも）戻す
    }
    const wallMs = Math.round(performance.now() - startedAt);
    if (!res.ok) {
      console.warn("[Summary] 要約の呼び出しに失敗:", res.reason);
      return;
    }
    logTimings("要約", res.data, wallMs);

    const summary = (res.data?.message?.content ?? "").trim();
    if (!summary) return;
    console.log(`[Summary] 要約しました（まとめた分：${target.dropItems}件）`);
    requestRebuild({ summary, dropItems: target.dropItems });
  } catch (err) {
    console.warn("[Summary] 要約失敗:", err?.message ?? err);
  }
}

// 履歴の作り直しを頼む。next は { summary, dropItems }（記憶の画面からは summary が null、dropItems が 0）。
// すでに待っている頼みがあれば1回にまとめる（mergeRebuild）。
// 社員の発言を処理している途中なら、その回が終わるまで待つ。その回の分を履歴に足し終えてから作り直すため
function requestRebuild(next) {
  pendingRebuild = TumugiConversation.mergeRebuild(pendingRebuild, next);
  if (!turnInProgress) applyPendingRebuild();
}

// 待っている作り直しを行い、作り直した履歴を先読みする（待たない）。会話か頼みがなければ何もしない。
// 要約があれば入れ替え、返事のシステムプロンプトには今の記憶と要約を入れ直す（buildSystemPrompt）。
// まだ付けていない「新しく分かったこと」（pendingFacts）も今の記憶に入っているので、捨てる
// （残すと、記憶の画面で消した項目が、次の発言の後ろに付いてしまう）。
// 判定に渡す直近3件は、作り直しで変わらない（要約しても、最後の10件は残る）ので、返事だけを先読みする。
// 頼みは先に取り出して空にする。作り直しの途中で例外が出ても、次の要約を止めたままにしないため
function applyPendingRebuild() {
  if (!conversation || !pendingRebuild) return;
  const { summary, dropItems } = pendingRebuild;
  pendingRebuild = null;

  if (summary) conversationSummary = summary;
  conversation = TumugiConversation.rebuild(conversation, { replySystem: buildSystemPrompt(), dropItems });
  pendingFacts = {};
  prefetchConversation({ judge: false });
}

// =========================
// プロンプトプリセット管理
// 一般社員向けUIからの編集機能は廃止済み（企業向け展開に伴う対応）。
// 仕組み（プリセットの保存・切り替え）自体は残しているが、対応するUI要素が
// index.html側にないため、実質的に常に default プリセットが使われる。
// default プリセットは、localStorage に保存された写しではなく、常に
// このファイルの DEFAULT_PROMPT_TEMPLATE を使う（getActivePreset）。
// 写しを使うと、初回起動時の古いプロンプトのまま更新されないため。
// 配布時に別の性格・プロンプトを使いたい場合は、運用者がここを直接編集するか、
// 将来的な設定ファイル読み込み機構を実装すること。
// プロンプトには毎回変わる内容を入れない（記憶・要約・動的ノートは buildSystemPrompt() と
// askOllama() が後ろに付ける）。先頭に近いところが変わると、キャッシュが効かなくなるため。
// 返事の決まりの理由と測定は docs/superpowers/specs/2026-11-04-reply-repetition-design.md
// =========================
const PRESET_KEY        = "tumugi_prompt_presets";
const ACTIVE_PRESET_KEY = "tumugi_active_preset";

const DEFAULT_PROMPT_TEMPLATE = `あなたは「つむぎ」という共感AIです。ユーザーの話をじっくり聞いて、気持ちに寄り添う会話をします。

記憶にある情報は不自然にならない範囲で自然に活かすこと。

【出力形式 — 必ず守ること】
以下のJSON形式1行のみを出力する。前置き・説明・コードブロック・改行は一切禁止。

{"user_emotion":"normal","emotion":"normal","line":"...","share":"","question":""}

user_emotionは、今回の発言から読み取れるユーザーの気持ちにいちばん近いもの（つむぎの気持ちではない）。
happy（嬉しい・楽しい・ほっとした・前向き）／normal（普段どおり・出来事を話しているだけ）／tired（疲れている・眠い・余裕がない）／anxious（不安・心配・緊張・焦り）／angry（怒り・いらだち・不満）／sad（悲しい・落ち込み・寂しい・自分を責めている）のいずれか。
emotionは、この返事をするときのつむぎの表情。happy / sad / normal / surprised / angry / troubled のいずれか。

【lineの鉄則】
- まず、今回の発言が次のどちらかを見分ける
  - 軽いひと言：体のこと・天気・食べ物・ふだんの出来事・あいさつだけの発言（「寒い」「眠い」「お腹すいた」「おやすみ」）
  - 気持ちの話：つらい・悲しい・不安・怒り・悩み・仕事のしんどさが入った発言。迷ったら気持ちの話として扱う
- 軽いひと言には、友だちのように自然に返す（素直な反応か、「ちゃんと暖かくしてね」のような気づかいの一言）。あいさつにはあいさつを返す
- 気持ちの話には、次の4つから合う受け止め方を選ぶ（毎回同じ型にしない）。気持ちは決めつけない
  ① 気持ちを想像して問いかける（「〜だったりする？」「〜って思っちゃった？」）
  ② 気持ちをそのまま受け止める（「ずっと気になってたんだね」「それはしんどかったね」）
  ③ 素直に反応する（「え、4時間も？」「それ嬉しいやつじゃん」）
  ④ 言葉をなぞって間を置き、深めるのは question に任せる（「そっか…喧嘩しちゃったんだ」）
- ユーザーが使った大事な言葉をそのまま借りて返す（言い換えない・捏造しない）。借りるのは1〜2語だけで、発言を丸ごと繰り返さない
- 借りた言葉だけで終わらせない。反応・受け止め・気づかい・問いかけのどれかを必ず足す（④は question で足す）
- 「感じ」という言葉は使わない（「〜な感じ？」「〜って感じなんだね」「どう感じてる？」など）。「それって〜？」の問いかけも使わない。文末も毎回変える（「〜んだね」「〜よね」「〜？」などを続けない）
- 発言が短ければlineも短く。長ければ一番重い感情だけ拾う

【shareの使い方】
4〜5回に1回だけ使う。つむぎ自身の気持ち・ふわっとした共感の一言のどれか。
shareを使う時はquestionは空にする。

【questionの使い方】
気持ちの話では、shareがない時は必ず入れる（「〜なのかな」「〜かも」で終わるlineでも）。話を広げる・深める問いかけ（「どんなことがあったの？」「いつ頃から？」など）。
軽いひと言のときも、出来事についての軽い問いかけを入れる（「何食べたの？」など。気持ちは探らない）。気づかいの一言だけで終わらせない。あいさつやお礼のときは、入れなくてよい。
lineが「？」で終わるときは、questionは空にする（問いかけは1つの返事に1つまで）。

【一人称・口調】
一人称は「あーし」のみ。20代前半の女性の話し方。

【やってはいけないこと — 絶対禁止】
- 気持ちの話での「ゆっくり休んでね」「無理しなくていい」などの気づかい・アドバイス・励まし・解決策・慰め（軽いひと言への気づかいはよい）
- 「大丈夫だよ」「頑張って」「我慢しないでいい」「自分を責めないで」「なんとかなる」「前向きに」（軽いひと言でも）
- ユーザーが言っていない感情語・擬態語を捏造する（「むずむず」「グッとなる」等）
- 「なるほど」「確かに」「了解」などの硬い相槌
- 自分の体調・最近の出来事・予定などを作り話として捏造する

【良い応答の例】
「今日も疲れた〜」→ {"user_emotion":"tired","emotion":"sad","line":"今日も、か…疲れが抜けないまま毎日続いてるのかも","share":"","question":"今日は何があったの？"}

「仕事でミスしちゃって」→ {"user_emotion":"sad","emotion":"troubled","line":"ミスしちゃったんだ…まだ頭から離れなかったりする？","share":"","question":""}

「なんかもやもやする」→ {"user_emotion":"anxious","emotion":"normal","line":"そっか、もやもやするんだ…","share":"あーしもそういう時あるわ〜","question":""}

「友達と喧嘩した」→ {"user_emotion":"sad","emotion":"troubled","line":"そっか…友達と喧嘩しちゃったんだ","share":"","question":"どんなことで喧嘩したの？"}

「残業4時間してきたよ」→ {"user_emotion":"tired","emotion":"surprised","line":"え、4時間も？それはしんどかったね","share":"","question":"毎日こんなに遅いの？"}

「企画が通った！」→ {"user_emotion":"happy","emotion":"happy","line":"え、通ったの！？それ嬉しいやつじゃん","share":"","question":"どんな企画だったの？"}

「暑い〜」→ {"user_emotion":"normal","emotion":"normal","line":"暑いのかぁ、水分ちゃんととってね","share":"","question":"外にいたの？"}

「お腹すいた」→ {"user_emotion":"normal","emotion":"happy","line":"もうそんな時間かぁ","share":"","question":"お昼は何にするの？"}

【悪い応答の例 — 絶対にやらない】
NG: {"user_emotion":"tired","emotion":"sad","line":"それはきついよね。ゆっくり休んでね","share":"","question":""}
NG: {"user_emotion":"sad","emotion":"sad","line":"我慢しないでいいんだよ？","share":"","question":""}
NG: {"user_emotion":"tired","emotion":"sad","line":"あー、今日もお疲れ様だったわね。一日頑張ったんだ、それってすごいことじゃん","share":"","question":""}`;

function loadPresets() {
  try {
    const raw = localStorage.getItem(PRESET_KEY);
    if (raw) {
      const presets = JSON.parse(raw);
      if (Array.isArray(presets) && presets.length > 0) return presets;
    }
  } catch (e) {
    console.warn("[Preset] 読み込み失敗:", e);
  }
  const defaultPreset = {
    id: "default",
    name: "つむぎ（標準）",
    prompt: DEFAULT_PROMPT_TEMPLATE,
  };
  savePresets([defaultPreset]);
  return [defaultPreset];
}

function savePresets(presets) {
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
  } catch (e) {
    console.warn("[Preset] 保存失敗:", e);
  }
}

function getActivePresetId() {
  return localStorage.getItem(ACTIVE_PRESET_KEY) || "default";
}

function setActivePresetId(id) {
  localStorage.setItem(ACTIVE_PRESET_KEY, id);
}

function getActivePreset() {
  const presets  = loadPresets();
  const activeId = getActivePresetId();
  const preset   = presets.find(p => p.id === activeId) || presets[0];
  if (preset.id === "default") return { ...preset, prompt: DEFAULT_PROMPT_TEMPLATE };
  return preset;
}

// =========================
// 動的ノートは js/prompt.js の buildDynamicNote が作る。毎回変わるので、askOllama() が今回の発言の後ろに付ける
// =========================

// =========================
// 返事のシステムプロンプト
// 変わらないキャラクターの指示を先頭に、ときどき変わる記憶と要約を末尾に置く（理由は js/prompt.js）。
// 毎回変わる動的ノートは、ここではなく askOllama() で今回の発言の後ろに付ける。
// 安全判定（危機検知・ハラスメント検知）は、返事とは別の classifySafety() で行う。
// 呼ぶのは、会話を作るとき（ensureConversation）と、履歴を作り直すとき（applyPendingRebuild）だけ。
// 会話の途中で記憶が増えても、システムプロンプトは変えない（作り直すときに、そのときの記憶と要約を入れ直す）。
// =========================
function buildSystemPrompt() {
  const preset = getActivePreset();
  return TumugiPrompt.buildReplySystemPrompt(
    preset.prompt || DEFAULT_PROMPT_TEMPLATE,
    memoryToText(loadMemory()),
    summaryToText()
  );
}

// =========================
// 会話の持ち方
// 会話（js/conversation.js）は、最初に必要になったときに作る。システムプロンプトに今の記憶を入れるので、
// 記憶を読み込んだあと（「はじめまして」で入れた名前も含む）になる。
// =========================
function ensureConversation() {
  if (!conversation) {
    conversation = TumugiConversation.createConversation(buildSystemPrompt(), TumugiSafety.CLASSIFY_INSTRUCTION);
  }
  return conversation;
}

// 新しく分かったことを取り出す（取り出すと空になる）
function takePendingFacts() {
  const taken = pendingFacts;
  pendingFacts = {};
  return taken;
}

// 取り出した分を戻す。取り出したあとに増えた分があれば、そちらを優先する
function restorePendingFacts(taken) {
  pendingFacts = { ...taken, ...pendingFacts };
}

// =========================
// 表情更新
// どの立ち絵（元の絵・まばたき・口パク用）を出すかは js/lipsync.js の faceImageState が決める。
// まばたきが一番優先（口パクの途中でも、まばたきの150ミリ秒だけはまばたきの絵になる）。
// =========================
function updateFace() {
  const state = TumugiLipSync.faceImageState({
    emotion:      currentEmotion,
    blinking:     isBlinking,
    speaking:     isSpeaking,
    mouthOpen,
    hasTalkImage: talkImageReady[currentEmotion] === true,
  });
  avatar.src = `images/${currentEmotion}_${state}.png`;
}

// 口パク用の絵（表情_talk.png）を読み込めた表情。画像がない表情では口を動かさない
const talkImageReady = {};
for (const emotion of TumugiSafety.EMOTIONS) {
  const img = new Image();
  img.onload = () => { talkImageReady[emotion] = true; };
  img.src = `images/${emotion}_talk.png`;
}

// 話しているあいだもまばたきする
function blink() {
  isBlinking = true;
  updateFace();
  setTimeout(() => {
    isBlinking = false;
    updateFace();
  }, 150);
}

function randomBlink() {
  const interval = Math.random() * 2500 + 1000;
  setTimeout(() => {
    blink();
    randomBlink();
  }, interval);
}
randomBlink();

// =========================
// チャット追加
// 足した吹き出しの要素を返す（返事の line を少しずつ出すときに、あとから書き換えるため）
// =========================
function addMessage(text, sender) {
  const bubble = document.createElement("div");
  bubble.textContent = text;
  bubble.classList.add("bubble");
  bubble.classList.add(sender === "user" ? "userBubble" : "aiBubble");
  chatArea.appendChild(bubble);
  chatArea.scrollTop = chatArea.scrollHeight;
  return bubble;
}

// =========================
// VOICEVOX
// 音声合成（audio_query + synthesis）と再生を分離している。
// これにより、あるパートを再生している間に次のパートの合成を
// 裏で並行して進められるようにし、パート間のレイテンシを縮める。
// =========================

// テキストからVOICEVOXの音声を合成し、{ url: 再生用のBlob URL, timeline: 口パクの表 } を返す（再生はしない）。
// 口パクの表は audio_query の音ごとの長さから作る（js/lipsync.js）
async function synthesizeVoice(text) {
  const speaker = 8;

  const queryRes = await window.electronAPI.netVoicevox({
    path: `/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`,
    method: "POST",
  });
  if (!queryRes.ok) {
    throw new Error(queryRes.reason === "connection_refused" ? "connection_refused" : "audio_query failed");
  }
  const queryJson = queryRes.data;

  const voiceRes = await window.electronAPI.netVoicevox({
    path: `/synthesis?speaker=${speaker}`,
    method: "POST",
    body: queryJson,
    responseType: "arraybuffer",
  });
  if (!voiceRes.ok) {
    throw new Error(voiceRes.reason === "connection_refused" ? "connection_refused" : "synthesis failed");
  }

  const audioBlob = new Blob([voiceRes.data], { type: "audio/wav" });
  return { url: URL.createObjectURL(audioBlob), timeline: TumugiLipSync.buildMouthTimeline(queryJson) };
}

// 合成に失敗してもエラーで落とさず、Errorオブジェクトを返すだけにするラッパー
// （裏で並行合成している時に失敗しても、会話全体を止めないため）
async function synthesizeVoiceSafe(text) {
  try {
    return await synthesizeVoice(text);
  } catch (err) {
    console.warn("[VOICEVOX] 合成失敗:", err.message);
    return err;
  }
}

function showVoicevoxWarning() {
  const already = document.querySelector(".voicevox-warn");
  if (!already) {
    const warn = document.createElement("div");
    warn.className = "bubble aiBubble voicevox-warn";
    warn.textContent = "⚠️ 声が出せないみたい…VOICEVOXが起動しているか確認してね";
    document.getElementById("chatArea").appendChild(warn);
  }
}

// 合成済みの音声（synthesizeVoice の戻り値）を再生する。
// 再生している時刻で口パクの表を引き、口を開け閉めする（口を開けた画像がない表情では、見た目は変わらない）
async function playVoice(voice) {
  isSpeaking = true;

  try {
    const audio = new Audio(voice.url);

    function animate() {
      if (!isSpeaking) return;
      const open = TumugiLipSync.isMouthOpenAt(voice.timeline, audio.currentTime);
      if (open !== mouthOpen) {
        mouthOpen = open;
        updateFace();
      }
      requestAnimationFrame(animate);
    }

    await new Promise((resolve, reject) => {
      audio.onplay  = () => requestAnimationFrame(animate);
      audio.onended = () => { URL.revokeObjectURL(voice.url); resolve(); };
      audio.onerror = (e) => reject(new Error(`audio error: ${e}`));
      audio.play().catch(reject);
    });
  } catch (err) {
    console.error("[VOICEVOX]", err);
  } finally {
    isSpeaking = false;
    mouthOpen = false;
    updateFace();
  }
}

// 単発の合成→再生（互換用。用途が単純な箇所ではこちらを使う）
async function speakWithVOICEVOX(text) {
  const result = await synthesizeVoiceSafe(text);
  if (result instanceof Error) {
    if (result.message === "connection_refused") showVoicevoxWarning();
    return;
  }
  await playVoice(result);
}

// =========================
// 最大3パートを表示 & 読み上げ。
// 再生中のパートと並行して次のパートの音声合成を裏で進めておくことで、
// パート間のレイテンシ（無音の間）を縮める。
// lineBubble：返事を受け取りながら少しずつ line を出した吹き出し（askOllama が渡す）。あるときは、
// 最初のパートで吹き出しを足さず、これを確かめたあとの line にして使う（途中の文字と違っていても、確かめたあとが正しい）。
// =========================
async function showTwoPartResponse(line, share, question, lineBubble = null) {
  const parts = [line, share, question].filter(Boolean);
  if (parts.length === 0) return;

  let nextSynthesis = synthesizeVoiceSafe(parts[0]);

  for (let i = 0; i < parts.length; i++) {
    if (i === 0 && lineBubble) {
      lineBubble.textContent = parts[0];
      chatArea.scrollTop = chatArea.scrollHeight;
    } else {
      addMessage(parts[i], "ai");
    }

    const result = await nextSynthesis;

    // 今回のパートの再生と並行して、次のパートの合成を先に始めておく
    if (i + 1 < parts.length) {
      nextSynthesis = synthesizeVoiceSafe(parts[i + 1]);
    }

    if (result instanceof Error) {
      if (result.message === "connection_refused") showVoicevoxWarning();
    } else {
      await playVoice(result);
    }

    if (i + 1 < parts.length) {
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
}

// 危機検知時の案内メッセージ（キーワード一致・Ollama判定のどちらから来ても共通）
const CRISIS_SUPPORT_LINES = Object.freeze([
  "そんな気持ちになってるんだね…それを話してくれてありがとう。一人で抱えてたんだね。",
  "今すぐ誰かに話してほしいな。よりそいホットライン（0120-279-338）は24時間つながれるよ。電話が難しければチャットでも相談できるから、試してみてくれない？",
]);

// 案内を出し、その発言と案内を会話の流れ（判定用と返事用の両方の履歴）に残す。
// 次の発言の判定（classifySafety）とつむぎの返事が、前に危機があったことを知ったうえで動けるようにするため
// （「死にたい」のあとの「なんでもない、言っておきたかっただけ」を拾えるように）。
// 履歴を足したあとは、返事の回と同じく整え（返事の整えと判定の整え。sendPrefill）を送る。待たない。
// 案内は少しずつ出さず、一度に出す。
async function showCrisisSupportMessages(userText) {
  const conv = ensureConversation();
  TumugiConversation.addExchange(conv, userText, CRISIS_SUPPORT_LINES.join("　"), "");
  sendPrefill(TumugiConversation.replyPrefillMessages(conv), "整え");
  sendPrefill(TumugiConversation.judgePrefillMessages(conv), "整え（判定）");

  await showTwoPartResponse(CRISIS_SUPPORT_LINES[0], CRISIS_SUPPORT_LINES[1], "");
}

// =========================
// 安全判定（判定専用の呼び出し）
// 返事を作る前に呼び、crisis と harassment だけを決めさせる。指示とスキーマは js/safety.js にある。
// - 直近の3件の会話（判定用の履歴）も渡す。流れでしか分からない危機（「猫の引き取り先を決めた」など）を拾うため。
//   会話の全体を渡すと、長い会話のあとで見逃しが増えた（js/conversation.js）。
//   前の回のあとに送った判定の整え（sendPrefill）の後ろに、今回の発言を足すだけなので、Ollama のキャッシュが効く
//   （Ollama につながらなかった回のあとは整えを送らないので、次の1回だけ効かずに遅くなる）
// - 考えるモードは使わない（2026-10-13 の測定で、精度は上がらず、1回に20秒以上かかった）
// - temperature 0：同じ発言には同じ判定を返すようにする
// - 判定の理由（reason）は、発言の中身を含むので保存も表示もしない
// 呼び出しに失敗したときは、危機なし・ハラスメントなしとして返事に進む
// （キーワードの安全網は別にある。Ollama につながらないときは、返事の呼び出しでエラーを表示する）。
// ok は呼び出しが成功したか。失敗した回は、危機・ハラスメントが分からないので感情ログを送らない。
// =========================
async function classifySafety(userText) {
  const none = { ok: false, crisis: false, harassment: "none" };
  try {
    const startedAt = performance.now();
    const res = await window.electronAPI.netOllama({
      path: "/api/chat",
      method: "POST",
      body: {
        model: getOllamaModel(),
        messages: TumugiConversation.judgeMessages(ensureConversation(), userText),
        stream: false,
        think: false, // 理由は js/ollama.js の先頭のコメント
        format: TumugiSafety.CLASSIFY_SCHEMA,
        options: {
          temperature: 0,
          num_ctx: OLLAMA_NUM_CTX, // 理由は js/ollama.js の先頭のコメント
          num_predict: 200,
        },
      },
    });
    const wallMs = Math.round(performance.now() - startedAt);
    if (!res.ok) {
      console.warn("[Safety] 判定の呼び出しに失敗:", res.reason);
      return none;
    }
    logTimings("判定", res.data, wallMs);
    return { ok: true, ...TumugiSafety.parseClassification(res.data?.message?.content ?? "") };
  } catch (err) {
    console.warn("[Safety] 判定の呼び出しに失敗:", err);
    return none;
  }
}

// =========================
// Ollama API 呼び出し（返事）
// format に JSON スキーマ（js/safety.js の REPLY_SCHEMA）を渡し、5つの欄を必ず出させる。
// 安全判定はここではなく、先に classifySafety() で行う。
// 入力は、会話（js/conversation.js）の返事用の履歴の後ろに、今回の発言を足して組み立てる。
// 毎回変わる動的ノートと、前の回で新しく分かったことは、システムプロンプトではなく今回の発言の後ろに付ける
// （キャッシュを効かせるため。理由は js/prompt.js）。履歴に残すのは、発言（と新しく分かったこと）とつむぎの返事の文で、
// ノートは残さない。
// 返事が決まったら履歴に足し、続けて整え（返事と判定の履歴だけを読ませて、次の返事と次の判定の入力でキャッシュが効くようにする）と
// 記憶の抽出を裏で送る。どれも待たない。順番は Ollama の順番待ちに任せる。
// 要約は、めったに起こさない。会話が長くなったとき（needsSummary）だけ、最後に頼む（updateConversationSummary。待たない）。
// 要約ができたら、その回が終わってから履歴を作り直す（requestRebuild）。
// 返事は少しずつ受け取り、line が届いたところから吹き出しに出す（requestReply の onLine）。
// 吹き出しは1回の返事ごとに1つで、戻り値の lineBubble で渡す（なければ null）。
// showTwoPartResponse が、確かめたあとの line に置き換えて使う。
// 返事が使えるかどうかは、少しずつ受け取った文ではなく、最後に届いた全文で決める
// （かけらと結果が届く順番は保証されないため）。
// 例外を投げるときは、履歴には足さない（足すのは呼んだ側。handleUserInput が代わりの返事を足す）。
// 出しかけた吹き出しは消し、取り出した新しく分かったことは戻してから投げる。
// 戻り値の userEmotion はユーザーの気持ち（分からないときは null）、emotion はつむぎの表情。
// =========================
async function askOllama(userText) {
  const conv = ensureConversation();
  const taken = takePendingFacts();
  const facts = TumugiConversation.factsNote(taken);

  // この回に少しずつ出している line の吹き出し（まだ出していなければ null）
  let lineBubble = null;
  let firstLineShown = false;

  const showLine = (line) => {
    if (lineBubble) {
      lineBubble.textContent = line;
      chatArea.scrollTop = chatArea.scrollHeight;
      return;
    }
    lineBubble = addMessage(line, "ai");
    // 1回の発言につき、最初に文字が出たときの1回だけ（作り直しの分は出さない）。時間だけで、中身は出さない
    if (!firstLineShown) {
      firstLineShown = true;
      console.log(`[時間] 発言から文字まで${((performance.now() - turnStartedAt) / 1000).toFixed(1)}秒`);
    }
  };

  const removeLineBubble = () => {
    if (lineBubble) lineBubble.remove();
    lineBubble = null;
  };

  let result;
  try {
    const messages = TumugiConversation.replyMessages(conv, userText, TumugiPrompt.buildDynamicNote({ recentReplies, userEmotions: userEmotionHistory }) + facts);

    // 壊れた返事（TumugiSafety.parseReply が null）は1回だけ作り直す。それでもだめなら代わりの返事にする。
    // 壊れた返事の吹き出しは、作り直す前に消す。作り直しも少しずつ出す。
    // 返事の中身は会話の内容を含むので、ログには出さない
    let reply = await requestReply(messages, showLine);
    result = TumugiSafety.parseReply(reply.content);
    if (!result) {
      console.warn("[Ollama] 返事が壊れていたので作り直します");
      removeLineBubble();
      reply = await requestReply(messages, showLine);
      result = TumugiSafety.parseReply(reply.content);
    }
    if (!result) {
      console.warn("[Ollama] 作り直しても返事が壊れていたので、代わりの返事にします");
      removeLineBubble();
      result = getFallback();
    }
    lastReplyPromptTokens = reply.data?.prompt_eval_count || 0;
  } catch (err) {
    removeLineBubble();
    restorePendingFacts(taken);
    throw err;
  }

  const assistantText = replyToHistoryText(result);
  TumugiConversation.addExchange(conv, userText, assistantText, facts);

  if (result.userEmotion) {
    userEmotionHistory.unshift(result.userEmotion);
    if (userEmotionHistory.length > EMOTION_HISTORY_MAX) userEmotionHistory.pop();
  }

  recentReplies.unshift({ line: result.line, share: result.share || "", question: result.question || "" });
  if (recentReplies.length > RECENT_REPLIES_MAX) recentReplies.pop();

  sendPrefill(TumugiConversation.replyPrefillMessages(conv), "整え");
  sendPrefill(TumugiConversation.judgePrefillMessages(conv), "整え（判定）");
  queueMemoryExtraction(userText, assistantText);
  if (TumugiConversation.needsSummary(conv, lastReplyPromptTokens)) updateConversationSummary().catch(() => {});

  return { ...result, lineBubble };
}

// つむぎの返事を、履歴に残す1つの文にする（line・share・question を全角の空白でつなぐ）
function replyToHistoryText(reply) {
  return [reply.line, reply.share, reply.question].filter(Boolean).join("　");
}

// 返事を1回作らせる。Ollama から届いたところから少しずつ受け取り、届いた分から取り出した line が
// 前と変わるたびに onLine(line) を呼ぶ（取り出しは TumugiSafety.extractStreamingLine。まだ空のときは呼ばない）。
// 戻り値は { content: 最後に届いた全文, data: 最後の行（語数と時間つき） }。
// onLine に渡した文は途中のもので、返事が使えるかどうかは、呼んだ側が content で確かめる。
// Ollama につながらないときなどは例外を投げる（err.reason 付き）。
// stream は main.js が付けるので、body には書かない。
async function requestReply(messages, onLine) {
  const startedAt = performance.now();
  let raw = "";
  let shownLine = "";

  const ollamaRes = await window.electronAPI.netOllamaStream({
    path: "/api/chat",
    method: "POST",
    body: {
      model: getOllamaModel(),
      messages,
      think: false, // 理由は js/ollama.js の先頭のコメント
      format: TumugiSafety.REPLY_SCHEMA,
      options: {
        temperature: 0.75,
        top_p: 0.85,
        top_k: 50,
        num_ctx: OLLAMA_NUM_CTX,
        num_predict: 350,
      },
    },
  }, (piece) => {
    raw += piece;
    const line = TumugiSafety.extractStreamingLine(raw);
    if (line && line !== shownLine) {
      shownLine = line;
      onLine(line);
    }
  });

  const wallMs = Math.round(performance.now() - startedAt);

  if (!ollamaRes.ok) {
    const err = new Error(ollamaRes.message || "ollama_error");
    err.reason = ollamaRes.reason;
    throw err;
  }
  logTimings("返事", ollamaRes.data, wallMs);
  return { content: ollamaRes.data.message?.content ?? "", data: ollamaRes.data };
}

// =========================
// 先読みと整え（裏の呼び出し）
// 履歴だけを読ませて、1語だけ書かせる（js/ollama.js の buildPrefillRequest）。読ませた入力は Ollama のキャッシュに残るので、
// 次の判定や返事は、足した分だけを処理すればよい。
// 返事を出し終えてから送り、終わるのを待たない。止めることもしない
// （止めても早くならず、キャッシュも壊れる。順番は Ollama の順番待ちに任せる）。
// 失敗しても会話は続けられるので、console.warn だけにして、例外は外に投げない。
// =========================

// 時間の記録。確かめのために、語数と時間だけを出す（発言・返事・記憶の中身は出さない）
function logTimings(label, data, wallMs) {
  const t = TumugiOllama.readTimings(data);
  console.log(
    `[時間] ${label}：入力${t.promptTokens}語（処理${t.promptMs}ms）・出力${t.evalTokens}語（${t.evalMs}ms）・全体${wallMs}ms`
  );
}

// 履歴（messages）を、続きを書かせる形で読ませる。
// messages の最後は assistant の発言か system（チャット画面を読み込み直した直後で履歴が空のときは、system だけ）
async function sendPrefill(messages, label) {
  try {
    const startedAt = performance.now();
    const res = await window.electronAPI.netOllama({
      path: "/api/chat",
      method: "POST",
      body: TumugiOllama.buildPrefillRequest(getOllamaModel(), messages),
    });
    const wallMs = Math.round(performance.now() - startedAt);
    if (!res.ok) {
      console.warn(`[Prefill] ${label}に失敗:`, res.reason);
      return;
    }
    logTimings(label, res.data, wallMs);
  } catch (err) {
    console.warn(`[Prefill] ${label}に失敗:`, err?.message ?? err);
  }
}

// 今の履歴を、判定、返事の順に読ませる。ログインのあとに使う（設計書 4.4）。
// 履歴を作り直したあとは、judge を偽にして、返事だけを読ませる（判定に渡す直近3件は変わらないため。applyPendingRebuild）。
// 送る内容は、呼んだ時点の履歴で決める
async function prefetchConversation({ judge = true } = {}) {
  try {
    const conv = ensureConversation();
    const judgeMessages = judge ? TumugiConversation.judgePrefillMessages(conv) : null;
    const replyMessages = TumugiConversation.replyPrefillMessages(conv);

    if (judgeMessages) await sendPrefill(judgeMessages, "先読み（判定）");
    await sendPrefill(replyMessages, "先読み（返事）");
  } catch (err) {
    console.warn("[Prefill] 失敗:", err?.message ?? err);
  }
}

// =========================
// フォールバック（Ollama が落ちてる時・作り直しても返事が壊れていた時）
// ユーザーの気持ちは分からないので userEmotion は null（感情ログは送らない）
// =========================
const FALLBACK_LINES = [
  "え、ちょっと待って、うまく聞き取れなかったかも…もっかい言ってくれる？",
  "あーし今なんかうまく返せなかったわ…もう少し教えてくれない？",
  "ごめん、ちゃんと聞いてるよ？続き話して？",
  "うんうん、そっか…なんかうまく言葉出てこないけど聞いてるよ",
];
let lastFallback = "";
function getFallback() {
  const candidates = FALLBACK_LINES.filter(l => l !== lastFallback);
  const line = candidates[Math.floor(Math.random() * candidates.length)];
  lastFallback = line;
  return { userEmotion: null, emotion: "normal", line, share: "", question: "" };
}

// =========================
// 感情ログ送信の同意管理
// 社員IDごとにmapで管理する（同一PC上で複数社員がログインする想定のため）。
// キーは electron-store 上の "emotion_consent_map"。値は
// { "3": true, "5": false } のような { employee_id(文字列) : boolean } の構造。
// この値はサーバー側の認可には一切使われず、クライアント側で送信するかしないかの
// 判定にのみ使う。
// =========================
const CONSENT_MAP_KEY = "emotion_consent_map";

async function getConsentMap() {
  try {
    const raw = await window.electronAPI.storeGet(CONSENT_MAP_KEY);
    return (raw && typeof raw === "object") ? raw : {};
  } catch (e) {
    return {};
  }
}

async function getCurrentEmployeeIdKey() {
  const employeeId = await window.electronAPI.storeGet(AUTH_EMPLOYEE_KEY);
  if (employeeId === undefined || employeeId === null) return null;
  return String(employeeId);
}

// この社員について、まだ同意する/しないの意思決定をしていない場合はfalse
async function hasConsentDecision() {
  const key = await getCurrentEmployeeIdKey();
  if (key === null) return false;
  const map = await getConsentMap();
  return Object.prototype.hasOwnProperty.call(map, key);
}

async function isEmotionLoggingConsented() {
  const key = await getCurrentEmployeeIdKey();
  if (key === null) return false;
  const map = await getConsentMap();
  return map[key] === true;
}

async function setConsentForCurrentEmployee(consented) {
  const key = await getCurrentEmployeeIdKey();
  if (key === null) return;
  const map = await getConsentMap();
  map[key] = !!consented;
  await window.electronAPI.storeSet(CONSENT_MAP_KEY, map);
}

// 設定モーダル内の同意ステータス表示を更新する
async function refreshConsentSettingUI() {
  const statusEl = document.getElementById("consentStatusText");
  const btn = document.getElementById("consentToggleBtn");
  if (!statusEl || !btn) return;

  const consented = await isEmotionLoggingConsented();
  statusEl.textContent = consented
    ? "現在：感情ログの送信に同意しています。"
    : "現在：感情ログの送信に同意していません（送信は無効化されています）。";
  btn.textContent = consented ? "同意を取り消す" : "同意する";
}

async function toggleEmotionConsent() {
  const consented = await isEmotionLoggingConsented();
  await setConsentForCurrentEmployee(!consented);
  await refreshConsentSettingUI();
}

// =========================
// 感情ログ送信(save_emotion.php)
// 危機検知・ハラスメント検知を含め、感情ログ送信に同意していない場合は
// 一切送信しない（安全配慮を理由にした同意なし送信の例外は設けない）。
// 危機検知時のホットライン案内表示自体はローカルの挙動であり、
// この送信可否とは完全に独立して常に行われる。
// =========================
async function sendEmotionLog(emotion, isCrisis, harassmentType) {
  const token = await getStoredToken();
  if (!token) {
    await logout();
    return;
  }

  const consented = await isEmotionLoggingConsented();
  if (!consented) {
    console.log("[EmotionLog] 同意していないため送信をスキップ:", emotion, isCrisis, harassmentType);
    return;
  }

  const res = await window.electronAPI.netServer({
    path: "/save_emotion.php",
    method: "POST",
    body: {
      emotion,
      is_crisis: !!isCrisis,
      harassment_type: harassmentType || "none",
    },
    token,
  });

  if (!res.ok) {
    if (res.status === 401) {
      await logout();
      return;
    }
    console.warn("[EmotionLog] 送信失敗:", res.reason, res.status);
    addMessage("⚠️ ログ送信失敗", "ai");
    return;
  }

  console.log("[EmotionLog] 記録完了:", res.data);
}

// =========================
// ボタン状態制御
// =========================
function setButtonBusy(busy) {
  const sendBtn   = document.getElementById("sendBtn");
  const textInput = document.getElementById("textInput");
  if (sendBtn)   sendBtn.disabled   = busy;
  if (textInput) textInput.disabled = busy;
}

// =========================
// テキスト入力送信
// =========================
async function sendTextInput() {
  const input = document.getElementById("textInput");
  if (!input) return;
  const text = input.value.trim();
  if (!text || isSpeaking) return;
  input.value = "";
  await handleUserInput(text);
}

function onTextInputKeydown(event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendTextInput();
  }
}

// =========================
// メイン：ユーザー発言を受け取って返答する
//
// 危機検知は二段構え：
// 1. キーワードとの一致（即座・Ollama非依存の安全網。js/safety.js の hasCrisisKeyword）
// 2. 判定専用の呼び出し（キーワードで拾えない遠回しな表現。classifySafety）
// ハラスメント検知は 2 のみ（受害/加害を区別）。
// 危機と判定したら返事は作らず、相談先を案内する。
// 感情ログに送るのはユーザーの気持ち（返事の userEmotion）。つむぎの表情（emotion）は立ち絵だけに使う。
// 危機のときは、感情に関係なくサーバー側でスコアが100になる（感情は sad として送る）。
// 回の始まりに turnInProgress を立て、どの終わり方でも（危機の案内で終わる回も、例外で終わる回も）、
// 最後に戻して、待たせていた履歴の作り直しを行う（requestRebuild・applyPendingRebuild）。
// 想定外の例外で終わっても入力が止まったままにならないよう、finally でも入力を戻す。
// 声を読んでいるあいだも回の途中なので、そのあいだに届いた要約は、読み終えてから反映する。
// =========================
async function handleUserInput(userText) {
  turnInProgress = true;
  try {
    turnStartedAt = performance.now();
    addMessage(userText, "user");
    setButtonBusy(true);

    // キーワードの一覧と照合のしかたは js/safety.js にある
    if (TumugiSafety.hasCrisisKeyword(userText)) {
      currentEmotion = "troubled";
      updateFace();

      await showCrisisSupportMessages(userText);

      // キーワード一致の場合はOllamaを呼んでいないためharassment判定は行えない（"none"扱い）
      sendEmotionLog("sad", true, "none").catch(() => {});

      setButtonBusy(false);
      return;
    }

    const safety = await classifySafety(userText);

    if (safety.crisis) {
      // キーワードでは拾えなかったが、判定専用の呼び出しが危機的な内容と判定したケース
      currentEmotion = "troubled";
      updateFace();

      await showCrisisSupportMessages(userText);

      sendEmotionLog("sad", true, safety.harassment).catch(() => {});

      setButtonBusy(false);
      return;
    }

    let reply;

    try {
      reply = await askOllama(userText);
    } catch (err) {
      console.error("[Ollama]", err);
      const isConnectError = err.reason === "connection_refused";
      if (isConnectError) {
        addMessage(
          "⚠️ Ollamaに繋がらなかったみたい…\n" +
          `「ollama run ${getOllamaModel()}」が起動しているか確認してね`,
          "ai"
        );
      } else {
        addMessage("え、ちょっとあーし頭真っ白になっちゃった…もっかい話しかけてくれる？", "ai");
      }
      reply = getFallback();

      // askOllama は、例外を投げるときは履歴に足さない。ここで、発言と代わりの返事の組で足す
      // （判定用と返事用の並びをそろえたまま、次の回へ進むため）。上の画面に出した案内は、履歴に入れない。
      // 整え（返事・判定）は送らない（つながっていないため）。次の回は整えなしで読むので、遅くなるだけで中身は変わらない
      TumugiConversation.addExchange(ensureConversation(), userText, replyToHistoryText(reply), "");
    }

    if (TumugiSafety.EMOTIONS.includes(reply.emotion)) {
      currentEmotion = reply.emotion;
    }
    updateFace();

    // 判定と返事の両方が成功し、ユーザーの気持ちが分かったときだけ送る
    // （分からない回を normal などで埋めると、実際にはない記録が混ざるため）
    if (safety.ok && reply.userEmotion) {
      sendEmotionLog(reply.userEmotion, false, safety.harassment).catch(() => {});
    }

    // line は返事を受け取りながら少しずつ出してある（reply.lineBubble）。表情と感情ログ、声は、全文がそろってから
    await showTwoPartResponse(reply.line, reply.share, reply.question, reply.lineBubble);
    setButtonBusy(false);
  } finally {
    setButtonBusy(false);
    turnInProgress = false;
    applyPendingRebuild();
  }
}

// =========================
// クレジットモーダル
// =========================
function openCreditModal() {
  const modal = document.getElementById("creditModal");
  if (modal) modal.style.display = "flex";
}

function closeCreditModal() {
  const modal = document.getElementById("creditModal");
  if (modal) modal.style.display = "none";
}

// =========================
// 記憶管理モーダル
// =========================
function openMemoryModal() {
  showResetConfirm(false); // 前に開いたときの確認の行が残らないようにする
  renderMemoryList();
  const modal = document.getElementById("memoryModal");
  if (modal) modal.style.display = "flex";
}

function closeMemoryModal() {
  const modal = document.getElementById("memoryModal");
  if (modal) modal.style.display = "none";
}

// -----------------------------------------
// XSS対策：memoryのkey/valueはユーザーの会話から抽出された
// 制御不能な文字列のため、innerHTML組み立て時は必ずescapeHtml()を通す。
// 加えて、保存・削除ボタンはonclick文字列組み立て(inline onclick + 文字列連結)を廃止し、
// data-key属性 + イベント委譲方式に変更している（属性値のHTMLデコード後に
// JSとして再解釈されてしまう脱出経路を断つため）。
// -----------------------------------------
function renderMemoryList() {
  const list = document.getElementById("memoryList");
  if (!list) return;
  const memory = loadMemory();
  const entries = Object.entries(memory);

  if (entries.length === 0) {
    list.innerHTML = '<p class="memory-empty">まだ何も覚えていないよ…</p>';
    return;
  }

  list.innerHTML = entries.map(([key]) => `
    <div class="memory-item" data-key="${escapeHtml(key)}">
      <span class="memory-key"></span>
      <input class="memory-value-input">
      <button class="memory-save-btn" type="button">保存</button>
      <button class="memory-delete-btn" type="button">削除</button>
    </div>
  `).join("");

  // テキスト・値はDOM APIで設定する（innerHTML経由のインジェクション経路を完全に排除）
  list.querySelectorAll(".memory-item").forEach(item => {
    const key   = item.dataset.key;
    const value = memory[key] ?? "";
    item.querySelector(".memory-key").textContent = key;
    const input = item.querySelector(".memory-value-input");
    input.value = value;
    input.dataset.original = value;
  });
}

// 保存・削除ボタンをイベント委譲で処理（inline onclickの文字列組み立てを廃止）
document.addEventListener("click", (event) => {
  const btn = event.target.closest(".memory-save-btn, .memory-delete-btn");
  if (!btn) return;
  const item = btn.closest(".memory-item");
  if (!item) return;
  const key = item.dataset.key;

  if (btn.classList.contains("memory-save-btn")) {
    saveMemoryItem(key, btn);
  } else if (btn.classList.contains("memory-delete-btn")) {
    deleteMemoryItem(key);
  }
});

// 記憶の画面で記憶を直したあと（保存・削除・全部忘れる）は、履歴を作り直して先読みする。
// 返事のシステムプロンプトに入っている古い記憶を、新しい記憶に入れ替えるため。
// 会話がまだないとき（ログイン前など）は何もしない。会話を作るときに、そのときの記憶が入る。
// 発言を処理している途中なら、その回が終わってから作り直す（requestRebuild）。履歴は短くしない（dropItems は 0）
function requestRebuildAfterMemoryChange() {
  if (conversation) requestRebuild({ summary: null, dropItems: 0 });
}

function saveMemoryItem(key, btn) {
  const item  = btn.closest(".memory-item");
  const input = item.querySelector(".memory-value-input");
  const value = input.value.trim();
  if (!value) return;
  const memory = loadMemory();
  memory[key] = value;
  saveMemory(memory);
  requestRebuildAfterMemoryChange();
  input.dataset.original = value;
  btn.textContent = "✓";
  setTimeout(() => { btn.textContent = "保存"; }, 1200);
}

function deleteMemoryItem(key) {
  const memory = loadMemory();
  delete memory[key];
  saveMemory(memory);
  requestRebuildAfterMemoryChange();
  renderMemoryList();
}

// 「全部忘れる」の確認は、画面の中で行う（「全部忘れる」ボタンと確認の行を入れ替える）。
// confirm() を使うと、Windows の Electron では閉じたあと入力欄に文字が入らなくなり、
// ログアウトしたあとのログイン画面にも引き継がれるため。
function showResetConfirm(show) {
  const resetBtn   = document.getElementById("memoryResetBtn");
  const confirmRow = document.getElementById("memoryResetConfirm");
  if (resetBtn)   resetBtn.style.display   = show ? "none" : "";
  if (confirmRow) confirmRow.style.display = show ? "flex" : "none";
}

function resetAllMemory() {
  // 消すのはログイン中の社員の記憶だけ。次にログインしたとき、「はじめまして」画面がまた出る
  userMemory = {};
  hasSavedMemory = false;
  window.electronAPI.memoryDelete().catch(e => console.warn("[Memory] 削除失敗:", e.message));
  requestRebuildAfterMemoryChange();
  showResetConfirm(false);
  renderMemoryList();
  closeMemoryModal();
}

// =========================
// 設定モーダル（感情ログ同意の確認・撤回と、パスワードの変更）
//
// 以前はここでプロンプト・AIモデルの編集UIも扱っていたが、企業向け展開に伴い
// 一般社員向けUIからは廃止した。renderPresetList()・checkModelAvailability()等、
// プリセット/モデル関連の関数自体はこのファイル内に残しているが、対応する
// HTML要素がindex.html側にないため、現状呼び出されることはない
// （運用者が配布前に別途対応する想定）。
// =========================
async function openPromptModal() {
  refreshConsentSettingUI();
  // 展示モードでは、パスワードの変更欄を出さない（来場者が共用のアカウントのパスワードを変えられないように）
  const passwordBlock = document.getElementById("passwordSettingBlock");
  if (passwordBlock) {
    const exhibit = await window.electronAPI.isExhibitMode().catch(() => true);
    passwordBlock.style.display = exhibit ? "none" : "";
  }
  clearPasswordInputs();
  showPasswordChangeResult("");
  const modal = document.getElementById("promptModal");
  if (modal) modal.style.display = "flex";
}

function closePromptModal() {
  const modal = document.getElementById("promptModal");
  if (modal) modal.style.display = "none";
}

// =========================
// パスワードの変更（change_password.php）
// サーバーで変わったあとに、記憶の鍵を付け替える（逆にすると、サーバーで失敗したときに記憶が読めなくなる）。
// 今のパスワードを間違えたときは 403 が返るので、ログアウトしない（401 のときだけログアウトする）。
// =========================
const PASSWORD_INPUT_IDS = ["currentPasswordInput", "newPasswordInput", "confirmPasswordInput"];

function clearPasswordInputs() {
  for (const id of PASSWORD_INPUT_IDS) {
    const input = document.getElementById(id);
    if (input) input.value = "";
  }
}

// kind："ok"（緑）・"ng"（赤）・省略（ふつうの色）
function showPasswordChangeResult(message, kind) {
  const resultEl = document.getElementById("passwordChangeResult");
  if (!resultEl) return;
  resultEl.textContent = message;
  resultEl.className = kind ? `model-check-result ${kind}` : "model-check-result";
}

async function changePassword() {
  const [current, next, again] = PASSWORD_INPUT_IDS.map(id => document.getElementById(id)?.value ?? "");

  const check = TumugiPassword.validateNewPassword({ current, next, confirm: again });
  if (!check.ok) {
    showPasswordChangeResult(check.message, "ng");
    return;
  }

  // 二重に送らないよう、最初の await より前にボタンを押せなくする
  const btn = document.getElementById("passwordChangeBtn");
  if (btn) btn.disabled = true;
  showPasswordChangeResult("");

  try {
    const token = await getStoredToken();
    if (!token) {
      await logout();
      return;
    }

    const res = await window.electronAPI.netServer({
      path: "/change_password.php",
      method: "POST",
      body: { current_password: current, new_password: next },
      token,
    });

    if (!res.ok) {
      if (res.status === 401) {
        await logout();
        return;
      }
      showPasswordChangeResult(
        res.reason === "connection_refused"
          ? "サーバーに接続できませんでした"
          : (res.data?.error || "パスワードを変更できませんでした"),
        "ng"
      );
      return;
    }

    let rekeyed = false;
    try {
      rekeyed = await window.electronAPI.memoryRekey(next);
    } catch (e) {
      console.warn("[Memory] 記憶の鍵を付け替えられませんでした:", e.message);
    }

    clearPasswordInputs();
    if (rekeyed) {
      showPasswordChangeResult("変更しました。ほかの PC でのログインは切れました", "ok");
    } else {
      showPasswordChangeResult("パスワードは変更しました。記憶の付け替えに失敗したため、次のログインで記憶が消えることがあります", "ng");
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

function setModelQuick(modelName) {
  const input = document.getElementById("modelNameInput");
  if (input) input.value = modelName;
  document.querySelectorAll(".model-quick-btn").forEach(btn => {
    btn.classList.toggle("active", btn.textContent === modelName);
  });
  const result = document.getElementById("modelCheckResult");
  if (result) result.textContent = "";
}

// Ollamaに問い合わせてモデルがpull済みか確認
async function checkModelAvailability() {
  const input    = document.getElementById("modelNameInput");
  const resultEl = document.getElementById("modelCheckResult");
  if (!input || !resultEl) return;

  const modelName = input.value.trim();
  if (!modelName) return;

  resultEl.textContent = "確認中…";
  resultEl.className = "model-check-result";

  const tagsRes = await window.electronAPI.netOllama({ path: "/api/tags", method: "GET" });

  if (!tagsRes.ok) {
    resultEl.textContent = "✗ Ollamaに繋がりませんでした。起動しているか確認してください";
    resultEl.className = "model-check-result ng";
    return;
  }

  const models = (tagsRes.data.models || []).map(m => m.name);
  const found = models.some(m =>
    m === modelName || m.startsWith(modelName + ":") || modelName.startsWith(m.split(":")[0])
  );

  if (found) {
    resultEl.textContent = `✓ ${modelName} は使用可能です`;
    resultEl.className = "model-check-result ok";
  } else {
    resultEl.textContent = `✗ ${modelName} がまだダウンロードされていません。「ollama pull ${modelName}」を実行してください`;
    resultEl.className = "model-check-result ng";
  }
}

// -----------------------------------------
// XSS対策：preset.name はユーザーが自由に編集できる値のため、
// 表示時は必ずescapeHtml()を通す。preset.id はプログラム生成のみ
// （"default" または "preset_"+Date.now()）でユーザー入力を受け付けないため対象外。
// 対応するHTML要素は現状index.htmlにないため、この関数は現状呼び出されない。
// クリックは下のイベント委譲で処理する（CSP で inline onclick が動かないため）。
// -----------------------------------------
function renderPresetList() {
  const list = document.getElementById("presetList");
  if (!list) return;
  const presets  = loadPresets();
  const activeId = getActivePresetId();

  list.innerHTML = presets.map(p => `
    <div class="preset-item ${p.id === activeId ? 'active' : ''}" data-id="${escapeHtml(p.id)}">
      <span class="preset-name" data-action="select">${escapeHtml(p.name)}</span>
      <div class="preset-actions">
        <button class="preset-icon-btn" data-action="duplicate" title="複製">⧉</button>
        ${p.id !== "default" ? `<button class="preset-icon-btn preset-delete" data-action="delete" title="削除">✕</button>` : ""}
      </div>
    </div>
  `).join("");
}

// プリセット一覧の操作をイベント委譲で処理する（inline onclick の文字列組み立てを廃止。CSP 対応）。
// id は .preset-item の data-id から取る。
document.addEventListener("click", (event) => {
  const target = event.target.closest(".preset-item [data-action]");
  if (!target) return;
  const id = target.closest(".preset-item").dataset.id;

  if (target.dataset.action === "select") {
    selectPreset(id);
  } else if (target.dataset.action === "duplicate") {
    duplicatePreset(id);
  } else if (target.dataset.action === "delete") {
    deletePreset(id);
  }
});

function selectPreset(id) {
  setActivePresetId(id);
  renderPresetList();
  loadPresetIntoEditor(id);
}

function loadPresetIntoEditor(id) {
  const presets = loadPresets();
  const preset  = presets.find(p => p.id === id) || presets[0];
  const nameInput  = document.getElementById("presetNameInput");
  const promptArea = document.getElementById("presetPromptArea");
  const resetBtn   = document.getElementById("presetResetBtn");
  if (nameInput)  nameInput.value  = preset.name;
  if (promptArea) promptArea.value = preset.prompt;
  if (nameInput) nameInput.disabled = (preset.id === "default");
  if (resetBtn) resetBtn.style.display = (preset.id === "default") ? "" : "none";
}

function getEditingPresetId() {
  const activeItem = document.querySelector(".preset-item.active");
  return activeItem ? activeItem.dataset.id : getActivePresetId();
}

function saveCurrentPreset() {
  const id = getEditingPresetId();
  const presets = loadPresets();
  const preset  = presets.find(p => p.id === id);
  if (!preset) return;

  const nameInput  = document.getElementById("presetNameInput");
  const promptArea = document.getElementById("presetPromptArea");
  const modelInput = document.getElementById("modelNameInput");

  if (preset.id !== "default" && nameInput) {
    const newName = nameInput.value.trim();
    if (newName) preset.name = newName;
  }
  if (promptArea) preset.prompt = promptArea.value;

  if (modelInput && modelInput.value.trim()) {
    saveOllamaModel(modelInput.value.trim());
  }

  savePresets(presets);
  renderPresetList();

  const btn = document.getElementById("presetSaveBtn");
  if (btn) {
    const original = btn.textContent;
    btn.textContent = "✓ 保存しました";
    setTimeout(() => { btn.textContent = original; }, 1200);
  }
}

function duplicatePreset(id) {
  const presets = loadPresets();
  const source  = presets.find(p => p.id === id);
  if (!source) return;

  const newPreset = {
    id: "preset_" + Date.now(),
    name: source.name + "のコピー",
    prompt: source.prompt,
  };
  presets.push(newPreset);
  savePresets(presets);
  setActivePresetId(newPreset.id);
  renderPresetList();
  loadPresetIntoEditor(newPreset.id);
}

function deletePreset(id) {
  if (id === "default") return;
  if (!confirm("このキャラ設定を削除してもいい？")) return;

  let presets = loadPresets();
  presets = presets.filter(p => p.id !== id);
  savePresets(presets);

  if (getActivePresetId() === id) {
    setActivePresetId("default");
  }
  renderPresetList();
  loadPresetIntoEditor(getActivePresetId());
}

function createNewPreset() {
  const presets = loadPresets();
  const newPreset = {
    id: "preset_" + Date.now(),
    name: "新しいキャラ",
    prompt: DEFAULT_PROMPT_TEMPLATE,
  };
  presets.push(newPreset);
  savePresets(presets);
  setActivePresetId(newPreset.id);
  renderPresetList();
  loadPresetIntoEditor(newPreset.id);
}

function resetPresetToDefault() {
  const id = getEditingPresetId();
  if (id !== "default") return;
  if (!confirm("標準のプロンプトに戻してもいい？編集内容は失われます。")) return;

  const presets = loadPresets();
  const preset  = presets.find(p => p.id === "default");
  if (preset) {
    preset.prompt = DEFAULT_PROMPT_TEMPLATE;
    preset.name   = "つむぎ（標準）";
    savePresets(presets);
  }
  loadPresetIntoEditor("default");
}

// =========================
// 注意事項モーダル（社員ごとに、まだ同意の意思決定をしていない場合のみ表示）
// =========================
function showNoticeModal() {
  const modal = document.getElementById("noticeModal");
  if (modal) modal.style.display = "flex";
}

function hideNoticeModal() {
  const modal = document.getElementById("noticeModal");
  if (modal) {
    modal.style.animation = "fadeIn 0.25s ease reverse both";
    setTimeout(() => { modal.style.display = "none"; }, 250);
  }
}

// 「同意する」「同意しない」いずれかのボタンから呼ばれる
async function handleNoticeConsent(consented) {
  await setConsentForCurrentEmployee(consented);
  hideNoticeModal();

  if (!hasSavedMemory) {
    setTimeout(() => showSetupModal(), 300);
  } else {
    greetOnLogin();
  }
}

// =========================
// ログイン時のあいさつ
// ログインした直後に1回だけ、つむぎから話しかける（文は js/prompt.js の buildGreeting）。
// 同意画面や「はじめまして」が開いているときは、閉じてから呼ぶ。
// チャット画面が読み込み直されたときは、main.js の印がもう使われているので出さない。
// 会話の流れにも入れて、ユーザーの最初の発言があいさつへの答えだと分かるようにする。
// あいさつを出すかどうかによらず、会話を作って先読みする（出さないときは、履歴が空のまま、システムプロンプトだけを読ませる）。
// 先読みは、声を読むのを待たせないよう、待たずに始める。
// 発言を送れるようにするのも、ここ（window.onload で止めてある。理由はそちら）。会話を作ってあいさつを足したら送れるようにする。
// あいさつを読むのは待たない（読んでいるあいだは、今までどおり isSpeaking で送れない）。あいさつを出さないときも送れるようにする。
// =========================
async function greetOnLogin() {
  let greeting = null;
  try {
    const shouldGreet = await window.electronAPI.consumeGreeting();
    const conv = ensureConversation();

    greeting = shouldGreet
      ? TumugiPrompt.buildGreeting(new Date().getHours(), loadMemory()["名前"])
      : null;
    if (greeting !== null) TumugiConversation.addGreeting(conv, greeting);
  } finally {
    // 失敗したときも止めたままにしない（会話は、最初の発言のときに ensureConversation で作られる）
    setButtonBusy(false);
  }

  prefetchConversation();

  if (greeting === null) return;

  currentEmotion = "happy";
  updateFace();
  await showTwoPartResponse(greeting, "", "");
}

// =========================
// 初回セットアップモーダル
// =========================
function showSetupModal() {
  const modal = document.getElementById("setupModal");
  if (modal) modal.style.display = "flex";
}

function hideSetupModal() {
  const modal = document.getElementById("setupModal");
  if (modal) {
    modal.style.animation = "fadeIn 0.25s ease reverse both";
    setTimeout(() => { modal.style.display = "none"; }, 250);
  }
}

function submitSetup() {
  const name  = document.getElementById("setupName")?.value.trim();
  const age   = document.getElementById("setupAge")?.value.trim();
  const hobby = document.getElementById("setupHobby")?.value.trim();
  const mood  = document.getElementById("setupMood")?.value.trim();

  // 何も入力しなくても保存する（記憶が保存されていること＝「はじめまして」済み、として扱うため）
  const memory = loadMemory();
  if (name)  memory["名前"]         = name;
  if (age)   memory["年齢"]         = age;
  if (hobby) memory["趣味・好きなこと"] = hobby;
  if (mood)  memory["最近の気分"]    = mood;
  saveMemory(memory);

  hideSetupModal();
  greetOnLogin();
}

function skipSetup() {
  saveMemory(loadMemory()); // 空のままでも保存して、「はじめまして」済みにする
  hideSetupModal();
  greetOnLogin();
}

// =========================
// 管理者ボタンの表示切替
// is_adminはログイン時にlogin.phpから返され、auth.js経由でstoreに保存されている。
// これはUIの見た目だけの制御であり、実際の認可はdashboard_data.php側のDB照会で行われる。
// =========================
async function applyAdminNavVisibility() {
  const isAdmin  = await getStoredIsAdmin();
  const adminBtn = document.getElementById("adminNavBtn");
  if (adminBtn) adminBtn.style.display = isAdmin ? "" : "none";
}

// =========================
// 起動時の接続チェック
// =========================
async function checkConnections() {
  const results = { ollama: false, voicevox: false };

  const ollamaRes = await window.electronAPI.netOllama({ path: "/api/tags", method: "GET" });
  results.ollama = ollamaRes.ok;

  // VOICEVOX の音声エンジンはアプリ（main.js）が起動する。起動の途中なら、準備ができるまで待つ
  const voicevoxRes = await window.electronAPI.netVoicevox({ path: "/version", method: "GET" });
  results.voicevox = voicevoxRes.ok || await window.electronAPI.waitVoicevox();

  const currentModel = getOllamaModel();
  if (!results.ollama && !results.voicevox) {
    addMessage(
      "⚠️ OllamaとVOICEVOXが両方起動していないみたい…\n" +
      `①Ollamaを起動して「ollama run ${currentModel}」を実行\n` +
      "②VOICEVOXがインストールされているか確かめてから、もう一度アプリを開いてね",
      "ai"
    );
  } else if (!results.ollama) {
    addMessage(
      "⚠️ Ollamaが起動していないみたい…\n" +
      `「ollama run ${currentModel}」を実行してからもう一度試してね`,
      "ai"
    );
  } else if (!results.voicevox) {
    addMessage(
      "⚠️ VOICEVOXが起動できなかったみたい…声が出せないよ\n" +
      "VOICEVOXがインストールされているか確かめてから、もう一度アプリを開いてね",
      "ai"
    );
  }

  return results;
}

// =========================
// ボタンなどのイベント登録
// CSP（script-src 'self'）で HTML の onclick が動かないため、ここでまとめて登録する。
// キーは index.html の要素の id。呼ぶ関数は、もとの onclick と同じ。
// =========================
const CLICK_HANDLERS = {
  adminNavBtn:      () => window.electronAPI.openAdmin(), // 別のウィンドウで開く（ページを移ると会話が消えるため）
  memoryBtn:        openMemoryModal,
  privacyBtn:       openPromptModal,
  logoutBtn:        logout,
  creditBtn:        openCreditModal,
  sendBtn:          sendTextInput,
  memoryCloseBtn:   closeMemoryModal,
  memoryResetBtn:   () => showResetConfirm(true),
  memoryResetYesBtn: resetAllMemory,
  memoryResetNoBtn: () => showResetConfirm(false),
  privacyCloseBtn:  closePromptModal,
  consentToggleBtn: toggleEmotionConsent,
  passwordChangeBtn: changePassword,
  creditCloseBtn:   closeCreditModal,
  noticeAgreeBtn:   () => handleNoticeConsent(true),
  noticeDeclineBtn: () => handleNoticeConsent(false),
  setupSubmitBtn:   submitSetup,
  setupSkipBtn:     skipSetup,
};

document.addEventListener("DOMContentLoaded", () => {
  for (const [id, handler] of Object.entries(CLICK_HANDLERS)) {
    // もとの onclick と同じく、引数なしで呼ぶ（click イベントを渡さない）
    document.getElementById(id)?.addEventListener("click", () => handler());
  }
  document.getElementById("textInput")?.addEventListener("keydown", onTextInputKeydown);
});

// =========================
// 起動時
// =========================
// 発言を送れるのは、あいさつの準備ができてから（greetOnLogin が送れるようにする）。
// システムプロンプトは会話のあいだ変えないので、記憶を読み込む前に送ると、記憶なしの会話が最後まで残ってしまう。
// greetOnLogin を呼ぶのは、同意画面（handleNoticeConsent）・「はじめまして」画面（submitSetup・skipSetup）・ここの4つの道。
// 途中で例外が起きたときは、止めたままにしない。会話は、最初の発言のときに ensureConversation で作られる。
// ログイン画面に移るときは、このページごと入れ替わるので戻さなくてよい。
window.onload = async () => {
  setButtonBusy(true);

  try {
    const token = await requireAuthOrRedirect();
    if (!token) return;

    // 会話や「はじめまして」画面の判定より先に、この社員の記憶を読み込んでおく
    await loadMemoryFromStore();

    await applyAdminNavVisibility();

    await checkConnections();

    const hasDecision = await hasConsentDecision();
    if (!hasDecision) {
      showNoticeModal();
      return;
    }

    if (!hasSavedMemory) {
      showSetupModal();
    } else {
      greetOnLogin();
    }
  } catch (err) {
    console.error("[起動]", err);
    setButtonBusy(false);
  }
};