// =========================================
// ollama-relay.js
// Ollama への中継の部品：
//   - 送る body に足すもの（withRelayOptions）：展示モードの keep_alive、CPU だけの確かめ用の options
//   - 少しずつ届く返事を1行ごとに分ける（createLineSplitter）
// Electron に依存しない関数だけを置き、main.js とテスト（test/ollama-relay.test.js）から使う。
// preload.js は sandbox で動くため、この部品を require できない。
// かけらを画面に渡すチャンネル名は、preload.js にも同じ文字で書いてある。変えるときは両方を直すこと。
// =========================================

// CPU だけの PC（GPU のない事務用 PC）をまねるときに、Ollama に渡す設定。
// num_gpu: 0 は GPU を使わない、num_thread: 4 は事務用 PC のコア数に近づけるためのもの。
const CPU_ONLY_OPTIONS = Object.freeze({ num_gpu: 0, num_thread: 4 });

// main.js が、少しずつ届く返事のかけらを、頼んだ画面に送るときのチャンネル名
const STREAM_PIECE_CHANNEL = "net:ollamaStreamPiece";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// 画面から受け取った body に、main.js 側で決める設定を足した、新しい body を返す。
// 渡された body は変えない。
//   keepAlive：文字列なら keep_alive として足す（展示モード）
//   cpuOnly：真なら options に CPU_ONLY_OPTIONS を足す（ほかの options は残す）
function withRelayOptions(body, { keepAlive, cpuOnly } = {}) {
  if (!isPlainObject(body)) return body;

  const result = { ...body };
  if (typeof keepAlive === "string") result.keep_alive = keepAlive;
  if (cpuOnly) {
    result.options = { ...(isPlainObject(body.options) ? body.options : {}), ...CPU_ONLY_OPTIONS };
  }
  return result;
}

// 少しずつ届く文字を、改行で区切り終わった行にして返す。
// 前後の空白（\r を含む）は除き、空の行は返さない。
// 区切り終わっていない残りは次の push() につなぎ、最後に flush() で取り出す。
function createLineSplitter() {
  let buffer = "";

  const toLines = (parts) => parts.map((part) => part.trim()).filter((part) => part !== "");

  return {
    push(text) {
      buffer += typeof text === "string" ? text : "";
      const parts = buffer.split("\n");
      buffer = parts.pop();
      return toLines(parts);
    },
    flush() {
      const rest = buffer;
      buffer = "";
      return toLines([rest]);
    },
  };
}

module.exports = {
  CPU_ONLY_OPTIONS,
  STREAM_PIECE_CHANNEL,
  withRelayOptions,
  createLineSplitter,
};
