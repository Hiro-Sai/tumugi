const { contextBridge, ipcRenderer } = require("electron");

// main.js が返事のかけらを送ってくるチャンネル名。ollama-relay.js の STREAM_PIECE_CHANNEL と同じ文字にすること
// （preload は sandbox で動くので、ollama-relay.js を require できない）
const STREAM_PIECE_CHANNEL = "net:ollamaStreamPiece";

// Ollama の返事を少しずつ受け取る。
// 呼び出しごとに requestId を作り、同じ requestId のかけらだけを onPiece に渡す（ほかの呼び出しのかけらは無視）。
// 終わったら（失敗したときも）、かけらを待つのをやめる。
function netOllamaStream(opts, onPiece) {
  const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const onPieceMessage = (event, id, piece) => {
    if (id === requestId && typeof onPiece === "function") onPiece(piece);
  };
  ipcRenderer.on(STREAM_PIECE_CHANNEL, onPieceMessage);
  return ipcRenderer.invoke("net:ollamaStream", requestId, opts).finally(() => {
    ipcRenderer.removeListener(STREAM_PIECE_CHANNEL, onPieceMessage);
  });
}

contextBridge.exposeInMainWorld("electronAPI", {
  storeGet: (key) => ipcRenderer.invoke("store:get", key),
  storeSet: (key, value) => ipcRenderer.invoke("store:set", key, value),
  storeDelete: (key) => ipcRenderer.invoke("store:delete", key),

  // つむぎの記憶（main.js側で、社員ごとにパスワードから作った鍵で暗号化する。鍵は画面側に来ない）
  memoryUnlock: (employeeId, password) => ipcRenderer.invoke("memory:unlock", employeeId, password),
  memoryGet:    () => ipcRenderer.invoke("memory:get"),
  memorySet:    (memory) => ipcRenderer.invoke("memory:set", memory),
  memoryDelete: () => ipcRenderer.invoke("memory:delete"),
  // パスワードを変えたあとに、記憶の鍵を新しいパスワードのものに付け替える（true＝付け替えた）
  memoryRekey:  (newPassword) => ipcRenderer.invoke("memory:rekey", newPassword),
  // 展示モードなら true
  isExhibitMode: () => ipcRenderer.invoke("app:isExhibit"),

  loginSuccess: () => ipcRenderer.send("auth:login-success"),
  logout: () => ipcRenderer.send("auth:logout"),
  // 管理者ダッシュボードを、チャットとは別のウィンドウで開く
  openAdmin: () => ipcRenderer.send("admin:open"),
  // ログインしたばかりなら true（1回だけ）。ログイン時のあいさつに使う
  consumeGreeting: () => ipcRenderer.invoke("greeting:consume"),
  // アプリが VOICEVOX の音声エンジンを起動している途中なら、準備ができるまで待つ（true＝応答した）
  waitVoicevox: () => ipcRenderer.invoke("voicevox:wait"),

  // ネットワーク中継（main.js側で固定ベースURLに限定済み）
  netOllama:   (opts) => ipcRenderer.invoke("net:ollamaRequest", opts),
  // 少しずつ受け取る版。返事のかけらが届くたびに onPiece(かけら) を呼び、全部届いたら netOllama と同じ形の結果を返す
  netOllamaStream: (opts, onPiece) => netOllamaStream(opts, onPiece),
  netVoicevox: (opts) => ipcRenderer.invoke("net:voicevoxRequest", opts),
  netServer:   (opts) => ipcRenderer.invoke("net:serverRequest", opts),
});