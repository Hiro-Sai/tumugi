// =========================================
// js/ollama.js
// Ollama の呼び出しの設定（モデル名・num_ctx・先読み用の body・時間の読み取り）を1か所にまとめる。
// 画面（index.html から script.js より先に読み込む）と、単体テスト（test/ollama.test.js）の両方から使う。
//
// 企業配布時にモデルを固定したい場合は DEFAULT_MODEL をここで直接書き換えるか、
// 将来的に設定ファイル読み込み機構を実装してここで上書きすること。
//
// /api/chat には必ず think: false を付ける。Gemma 4 は何も指定しないと
// 「考えてから答える」モードで動き、考える部分だけで num_predict を使い切って
// 返事（content）が空になるため（2026-10-13 に確認）。
// 考えるモードのないモデルに付けても、エラーにはならない。
//
// num_ctx は、すべての呼び出しで NUM_CTX にそろえる。値が違うと、そのたびに
// モデルを読み込み直す（2026-10-13 の測定で、記憶の抽出だけ 2048 だった頃は10往復で19回、
// 1回あたり約10秒）。モデルと num_ctx がずれると、先読みで作ったキャッシュも効かなくなる。
// =========================================

(function () {
  "use strict";

  const MODEL_KEY     = "tumugi_model";
  const DEFAULT_MODEL = "gemma4:e4b";
  const NUM_CTX       = 8192;

  // storage：localStorage など。保存がない・空・storage がない・読めないときは、DEFAULT_MODEL
  function getOllamaModel(storage) {
    try {
      return (storage && storage.getItem(MODEL_KEY)) || DEFAULT_MODEL;
    } catch (e) {
      return DEFAULT_MODEL;
    }
  }

  // 先読みと整え用の body。messages の最後が assistant だと、Ollama はその続きを書く形で読む。
  // 書かせるのは1語だけ（num_predict: 1）で、読ませた入力をキャッシュに残すのが目的
  function buildPrefillRequest(model, messages) {
    return {
      model,
      messages,
      stream: false,
      think: false,
      options: { temperature: 0, num_ctx: NUM_CTX, num_predict: 1 },
    };
  }

  // Ollama の応答から、読み込んだ語数と時間を取り出す。時間はナノ秒で届くので、ミリ秒の整数に直す
  function readTimings(data) {
    const d = data || {};
    return {
      promptTokens: d.prompt_eval_count || 0,
      promptMs:     Math.round((d.prompt_eval_duration || 0) / 1e6),
      evalTokens:   d.eval_count || 0,
      evalMs:       Math.round((d.eval_duration || 0) / 1e6),
    };
  }

  const api = Object.freeze({
    MODEL_KEY, DEFAULT_MODEL, NUM_CTX,
    getOllamaModel, buildPrefillRequest, readTimings,
  });

  // テスト（Node）では module.exports、画面では window.TumugiOllama として使う
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    globalThis.TumugiOllama = api;
  }
})();
