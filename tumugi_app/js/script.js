const avatar   = document.getElementById("avatar");
const chatArea = document.getElementById("chatArea");

let currentEmotion = "normal";
let isBlinking     = false;
let isSpeaking     = false;
let mouthOpen      = false; // 声に合わせて口が開いているか（playVoice が切り替える）

// =========================
// 会話履歴（マルチターン）
// =========================
const conversationHistory = [];

// ユーザーの気持ち（新しい順）。「感情の流れに注意」の判断（detectEmotionStreak）に使う。
// つむぎの表情ではなく、返事の user_emotion を入れる
const userEmotionHistory = [];
const EMOTION_HISTORY_MAX = 5;

// 直近の line（新しい順）。言い方の重複を避ける指示（buildDynamicNote）に使う
const recentLines = [];
const RECENT_LINES_MAX = 3;

let conversationSummary = "";
let isSummarizing = false;

const SUMMARY_TRIGGER  = 20;
const SUMMARY_KEEP     = 10;

// =========================
// Ollama 設定
// 企業配布時にモデルを固定したい場合は DEFAULT_MODEL をここで直接書き換えるか、
// 将来的に設定ファイル読み込み機構を実装してここで上書きすること。
// 一般社員向けUIからのモデル切り替え機能は廃止済み（運用者のみが対応する想定）。
// checkModelAvailability() 等の関数自体は残しているが、対応するUI要素が
// index.html側にないため、現状呼び出されることはない。
//
// /api/chat には必ず think: false を付ける。Gemma 4 は何も指定しないと
// 「考えてから答える」モードで動き、考える部分だけで num_predict を使い切って
// 返事（content）が空になるため（2026-10-13 に確認）。
// 考えるモードのないモデルに付けても、エラーにはならない。
//
// num_ctx は、すべての呼び出しで OLLAMA_NUM_CTX にそろえる。値が違うと、そのたびに
// モデルを読み込み直す（2026-10-13 の測定で、記憶の抽出だけ 2048 だった頃は10往復で19回、
// 1回あたり約10秒）。
// =========================
const MODEL_KEY      = "tumugi_model";
const DEFAULT_MODEL  = "gemma4:e4b";
const OLLAMA_NUM_CTX = 8192;

function getOllamaModel() {
  return localStorage.getItem(MODEL_KEY) || DEFAULT_MODEL;
}

function saveOllamaModel(modelName) {
  const name = modelName.trim();
  if (!name) return;
  localStorage.setItem(MODEL_KEY, name);
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
    const result = await window.electronAPI.netOllama({
      path: "/api/chat",
      method: "POST",
      body: {
        model: getOllamaModel(),
        messages: [{ role: "user", content: prompt }],
        stream: false,
        think: false, // 理由は「Ollama 設定」のコメント
        options: { temperature: 0.1, num_ctx: OLLAMA_NUM_CTX, num_predict: 200 },
      },
    });
    if (!result.ok) return;

    const raw = result.data.message?.content ?? "";

    const firstBrace = raw.indexOf("{");
    const lastBrace  = raw.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace <= firstBrace) return;

    const extracted = JSON.parse(raw.slice(firstBrace, lastBrace + 1));
    if (Object.keys(extracted).length === 0) return;

    const newMemory = { ...currentMemory, ...extracted };
    saveMemory(newMemory);
    console.log(`[Memory] ${Object.keys(extracted).length} 件を更新しました`); // 中身は個人の情報なので出さない
  } catch (e) {
    console.warn("[Memory] 抽出失敗:", e.message);
  }
}

// =========================
// 会話履歴の要約圧縮
// =========================
async function updateConversationSummary() {
  if (isSummarizing) return;
  if (conversationHistory.length <= SUMMARY_TRIGGER) return;

  isSummarizing = true;

  const toSummarize = conversationHistory.slice(0, -SUMMARY_KEEP);
  if (toSummarize.length === 0) { isSummarizing = false; return; }

  const historyText = toSummarize.map(m => {
    const role = m.role === "user" ? "ユーザー" : "つむぎ";
    return `${role}：${m.content}`;
  }).join("\n");

  const prompt = `以下は「つむぎ」という共感AIとユーザーの会話の前半部分です。
この会話の内容を、後半の会話の文脈理解に使えるよう200字以内で要約してください。
ユーザーの感情の流れ・話題・重要な出来事を中心にまとめること。
要約のみ出力。前置き・見出し不要。

【会話】
${historyText}`;

  try {
    const result = await window.electronAPI.netOllama({
      path: "/api/chat",
      method: "POST",
      body: {
        model: getOllamaModel(),
        messages: [{ role: "user", content: prompt }],
        stream: false,
        think: false, // 理由は「Ollama 設定」のコメント
        options: { temperature: 0.3, num_ctx: OLLAMA_NUM_CTX, num_predict: 300 },
      },
    });
    if (!result.ok) { isSummarizing = false; return; }

    const summary = (result.data.message?.content ?? "").trim();
    if (summary) {
      conversationSummary = summary;
      conversationHistory.splice(0, conversationHistory.length - SUMMARY_KEEP);
      console.log("[Summary] 要約完了:", conversationSummary.slice(0, 40) + "…");
    }
  } catch (e) {
    console.warn("[Summary] 要約失敗:", e.message);
  } finally {
    isSummarizing = false;
  }
}

function summaryToText() {
  if (!conversationSummary) return "";
  return `\n【これまでの会話の流れ（要約）】\n${conversationSummary}`;
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
- ユーザーが使った大事な言葉をそのまま借りて返す（言い換えない・捏造しない）。借りるのは1〜2語だけで、発言を丸ごと繰り返さない
- 気持ちは決めつけない。次の4つの受け止め方から、その発言に合うものを選ぶ（毎回同じ型にしない）
  ① 気持ちを想像して問いかける（「〜だったりする？」「〜って思っちゃった？」「〜な感じ？」）
  ② 気持ちをそのまま受け止める（「ずっと気になってたんだね」「それはしんどかったね」）
  ③ 素直に反応する（「え、4時間も？」「それ嬉しいやつじゃん」）
  ④ 言葉をなぞって間を置き、深めるのは question に任せる（「そっか…喧嘩しちゃったんだ」）
- 「感じ」という言葉は3回に1回まで。文末も毎回変える（「〜んだね」「〜よね」「〜？」などを続けない）
- アドバイス・励まし・解決策は絶対に言わない
- ユーザーの発言が短ければlineも短く。長ければ一番重い感情だけ拾う

【shareの使い方】
4〜5回に1回だけ使う。つむぎ自身の気持ち・ふわっとした共感の一言のどれか。
shareを使う時はquestionは空にする。

【questionの使い方】
shareがない時は原則入れる。話を広げる・深める問いかけ。

【一人称・口調】
一人称は「あーし」のみ。20代前半の女性の話し方。

【やってはいけないこと — 絶対禁止】
- 「ゆっくり休んでね」「無理しなくていい」「大丈夫だよ」「頑張って」などアドバイス・慰め
- 「我慢しないでいい」「自分を責めないで」「なんとかなる」「前向きに」
- ユーザーが言っていない感情語・擬態語を捏造する（「むずむず」「グッとなる」等）
- 「なるほど」「確かに」「了解」などの硬い相槌
- 自分の体調・最近の出来事・予定などを作り話として捏造する

【良い応答の例】
ユーザー:「今日も疲れた〜」
→ {"user_emotion":"tired","emotion":"sad","line":"今日も、か…疲れが抜けきらないまま、毎日が続いてるのかも","share":"","question":"今日は何があったの？"}

ユーザー:「仕事でミスしちゃって」
→ {"user_emotion":"sad","emotion":"troubled","line":"ミスしちゃったんだ…まだそのことが頭から離れなかったりする？","share":"","question":"どんなミスだったの？"}

ユーザー:「なんかもやもやする」
→ {"user_emotion":"anxious","emotion":"normal","line":"そっか、もやもやするんだ…","share":"あーしもそういう時あるわ〜","question":""}

ユーザー:「友達と喧嘩した」
→ {"user_emotion":"sad","emotion":"troubled","line":"友達と喧嘩か…怒りより、なんか裏切られた感じに近い？","share":"","question":"どんなことで喧嘩したの？"}

ユーザー:「残業4時間してきたよ」
→ {"user_emotion":"tired","emotion":"surprised","line":"え、4時間も？それはしんどかったね","share":"","question":"毎日こんなに遅いの？"}

ユーザー:「企画が通った！」
→ {"user_emotion":"happy","emotion":"happy","line":"え、通ったの！？それ嬉しいやつじゃん","share":"","question":"どんな企画だったの？"}

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
// 動的ノート生成（感情の流れ・言い方の重複回避）
// 毎回変わるので、askOllama() が今回の発言の後ろに付ける
// =========================
// ユーザーの気持ち（TumugiSafety.USER_EMOTIONS）の呼び名
const EMOTION_LABEL = {
  happy: "嬉しい", normal: "普通", tired: "疲れ",
  anxious: "不安", angry: "怒り・いらだち", sad: "悲しい・落ち込み",
};

function detectEmotionStreak() {
  if (userEmotionHistory.length < 2) return null;
  const latest = userEmotionHistory[0];
  if (latest === "normal") return null;

  let streak = 1;
  for (let i = 1; i < userEmotionHistory.length; i++) {
    if (userEmotionHistory[i] === latest) streak++;
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

function buildDynamicNote() {
  let note = "";

  const streak = detectEmotionStreak();
  if (streak) {
    const label = EMOTION_LABEL[streak.emotion] || streak.emotion;
    note += `
【感情の流れに注意】
直近${streak.streak}回連続でユーザーの感情が「${label}」傾向。一時的な気分ではなく根深い悩みかもしれない。
いつもより一段深く受け止め、気持ちの想像をより丁寧に行うこと。`;
  }

  if (recentLines.length > 0) {
    const endings = recentLines.map(l => `「…${extractLineEnding(l)}」`).join("");
    note += `
【言い方の重複回避】
直近のlineの終わり方は ${endings} だった。今回はこれらと違う終わり方・違う受け止め方にすること。`;
    // 「感じ」は3回に1回まで：直近2回のどちらかで使っていたら、今回は使わせない
    if (recentLines.slice(0, 2).some(l => l.includes("感じ"))) {
      note += `
直近で「感じ」を使ったので、今回のlineでは「感じ」を使わないこと。`;
    }
  }

  return note;
}

// =========================
// 返事のシステムプロンプト
// 変わらないキャラクターの指示を先頭に、ときどき変わる記憶と要約を末尾に置く（理由は js/prompt.js）。
// 毎回変わる動的ノートは、ここではなく askOllama() で今回の発言の後ろに付ける。
// 安全判定（危機検知・ハラスメント検知）は、返事とは別の classifySafety() で行う。
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
// =========================
function addMessage(text, sender) {
  const bubble = document.createElement("div");
  bubble.textContent = text;
  bubble.classList.add("bubble");
  bubble.classList.add(sender === "user" ? "userBubble" : "aiBubble");
  chatArea.appendChild(bubble);
  chatArea.scrollTop = chatArea.scrollHeight;
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
// =========================
async function showTwoPartResponse(line, share, question) {
  const parts = [line, share, question].filter(Boolean);
  if (parts.length === 0) return;

  let nextSynthesis = synthesizeVoiceSafe(parts[0]);

  for (let i = 0; i < parts.length; i++) {
    addMessage(parts[i], "ai");

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

// 案内を出し、その発言と案内を会話の流れに残す。
// 次の発言の判定（classifySafety）とつむぎの返事が、前に危機があったことを知ったうえで動けるようにするため
// （「死にたい」のあとの「なんでもない、言っておきたかっただけ」を拾えるように）。
async function showCrisisSupportMessages(userText) {
  conversationHistory.push({ role: "user", content: userText });
  conversationHistory.push({ role: "assistant", content: CRISIS_SUPPORT_LINES.join("　") });

  await showTwoPartResponse(CRISIS_SUPPORT_LINES[0], CRISIS_SUPPORT_LINES[1], "");
}

// =========================
// 安全判定（判定専用の呼び出し）
// 返事を作る前に呼び、crisis と harassment だけを決めさせる。指示とスキーマは js/safety.js にある。
// - 直前の2往復も渡す。流れでしか分からない危機（「猫の引き取り先を決めた」など）を拾うため
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
    const res = await window.electronAPI.netOllama({
      path: "/api/chat",
      method: "POST",
      body: {
        model: getOllamaModel(),
        messages: [
          { role: "system", content: TumugiSafety.CLASSIFY_INSTRUCTION },
          { role: "user", content: TumugiSafety.buildClassifyMessage(conversationHistory, userText) },
        ],
        stream: false,
        think: false, // 理由は「Ollama 設定」のコメント
        format: TumugiSafety.CLASSIFY_SCHEMA,
        options: {
          temperature: 0,
          num_ctx: OLLAMA_NUM_CTX, // 理由は「Ollama 設定」のコメント
          num_predict: 200,
        },
      },
    });
    if (!res.ok) {
      console.warn("[Safety] 判定の呼び出しに失敗:", res.reason);
      return none;
    }
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
// 毎回変わる動的ノートは、システムプロンプトではなく今回の発言の後ろに付ける
// （キャッシュを効かせるため。理由は js/prompt.js）。会話の流れには発言だけを残す。
// 戻り値の userEmotion はユーザーの気持ち（分からないときは null）、emotion はつむぎの表情。
// =========================
async function askOllama(userText) {
  const dynamicNote = buildDynamicNote();
  conversationHistory.push({ role: "user", content: userText });

  const pastHistory = conversationHistory.slice(-30, -1); // 今回の発言より前
  const messages = [
    { role: "system", content: buildSystemPrompt() },
    ...pastHistory,
    { role: "user", content: TumugiPrompt.withDynamicNote(userText, dynamicNote) },
  ];

  // 壊れた返事（TumugiSafety.parseReply が null）は1回だけ作り直す。それでもだめなら代わりの返事にする。
  // 返事の中身は会話の内容を含むので、ログには出さない
  let result = TumugiSafety.parseReply(await requestReply(messages));
  if (!result) {
    console.warn("[Ollama] 返事が壊れていたので作り直します");
    result = TumugiSafety.parseReply(await requestReply(messages));
  }
  if (!result) {
    console.warn("[Ollama] 作り直しても返事が壊れていたので、代わりの返事にします");
    result = getFallback();
  }

  const assistantText = [result.line, result.share, result.question]
    .filter(Boolean).join("　");
  conversationHistory.push({ role: "assistant", content: assistantText });

  if (result.userEmotion) {
    userEmotionHistory.unshift(result.userEmotion);
    if (userEmotionHistory.length > EMOTION_HISTORY_MAX) userEmotionHistory.pop();
  }

  recentLines.unshift(result.line);
  if (recentLines.length > RECENT_LINES_MAX) recentLines.pop();

  queueMemoryExtraction(userText, assistantText);
  updateConversationSummary().catch(() => {});

  return result;
}

// 返事を1回作らせて、モデルの出力（文字列）を返す。Ollama につながらないときなどは例外を投げる
async function requestReply(messages) {
  const ollamaRes = await window.electronAPI.netOllama({
    path: "/api/chat",
    method: "POST",
    body: {
      model: getOllamaModel(),
      messages,
      stream: false,
      think: false, // 理由は「Ollama 設定」のコメント
      format: TumugiSafety.REPLY_SCHEMA,
      options: {
        temperature: 0.75,
        top_p: 0.85,
        top_k: 50,
        num_ctx: OLLAMA_NUM_CTX,
        num_predict: 350,
      },
    },
  });

  if (!ollamaRes.ok) {
    const err = new Error(ollamaRes.message || "ollama_error");
    err.reason = ollamaRes.reason;
    throw err;
  }
  return ollamaRes.data.message?.content ?? "";
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
// =========================
async function handleUserInput(userText) {
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

  await showTwoPartResponse(reply.line, reply.share, reply.question);
  setButtonBusy(false);
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

function saveMemoryItem(key, btn) {
  const item  = btn.closest(".memory-item");
  const input = item.querySelector(".memory-value-input");
  const value = input.value.trim();
  if (!value) return;
  const memory = loadMemory();
  memory[key] = value;
  saveMemory(memory);
  input.dataset.original = value;
  btn.textContent = "✓";
  setTimeout(() => { btn.textContent = "保存"; }, 1200);
}

function deleteMemoryItem(key) {
  const memory = loadMemory();
  delete memory[key];
  saveMemory(memory);
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
  showResetConfirm(false);
  renderMemoryList();
  closeMemoryModal();
}

// =========================
// 設定モーダル（感情ログ同意の確認・撤回のみ）
//
// 以前はここでプロンプト・AIモデルの編集UIも扱っていたが、企業向け展開に伴い
// 一般社員向けUIからは廃止した。renderPresetList()・checkModelAvailability()等、
// プリセット/モデル関連の関数自体はこのファイル内に残しているが、対応する
// HTML要素がindex.html側にないため、現状呼び出されることはない
// （運用者が配布前に別途対応する想定）。
// =========================
function openPromptModal() {
  refreshConsentSettingUI();
  const modal = document.getElementById("promptModal");
  if (modal) modal.style.display = "flex";
}

function closePromptModal() {
  const modal = document.getElementById("promptModal");
  if (modal) modal.style.display = "none";
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
// 管理者画面から戻ったときは、main.js の印がもう使われているので出さない。
// 会話の流れにも入れて、ユーザーの最初の発言があいさつへの答えだと分かるようにする。
// =========================
async function greetOnLogin() {
  if (!(await window.electronAPI.consumeGreeting())) return;

  const greeting = TumugiPrompt.buildGreeting(new Date().getHours(), loadMemory()["名前"]);
  conversationHistory.push({ role: "assistant", content: greeting });

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
  adminNavBtn:      () => { location.href = "admin-dashboard.html"; },
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
window.onload = async () => {
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
};