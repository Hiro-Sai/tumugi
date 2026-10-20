const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  storeGet: (key) => ipcRenderer.invoke("store:get", key),
  storeSet: (key, value) => ipcRenderer.invoke("store:set", key, value),
  storeDelete: (key) => ipcRenderer.invoke("store:delete", key),

  // つむぎの記憶（main.js側で、社員ごとにパスワードから作った鍵で暗号化する。鍵は画面側に来ない）
  memoryUnlock: (employeeId, password) => ipcRenderer.invoke("memory:unlock", employeeId, password),
  memoryGet:    () => ipcRenderer.invoke("memory:get"),
  memorySet:    (memory) => ipcRenderer.invoke("memory:set", memory),
  memoryDelete: () => ipcRenderer.invoke("memory:delete"),

  loginSuccess: () => ipcRenderer.send("auth:login-success"),
  logout: () => ipcRenderer.send("auth:logout"),
  // ログインしたばかりなら true（1回だけ）。ログイン時のあいさつに使う
  consumeGreeting: () => ipcRenderer.invoke("greeting:consume"),
  // アプリが VOICEVOX の音声エンジンを起動している途中なら、準備ができるまで待つ（true＝応答した）
  waitVoicevox: () => ipcRenderer.invoke("voicevox:wait"),

  // ネットワーク中継（main.js側で固定ベースURLに限定済み）
  netOllama:   (opts) => ipcRenderer.invoke("net:ollamaRequest", opts),
  netVoicevox: (opts) => ipcRenderer.invoke("net:voicevoxRequest", opts),
  netServer:   (opts) => ipcRenderer.invoke("net:serverRequest", opts),
});