const { app, BrowserWindow, Menu, ipcMain, safeStorage, session } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const Store = require("electron-store");
const { buildRelayUrl, isLocalRequestUrl, isAllowedNavigation, isAllowedOllamaModel } = require("./net-policy");
const { newSalt, deriveMemoryKey, encryptMemory, decryptMemory } = require("./memory-crypto");

const store = new Store();

// 中継先の基準 URL と、中継してよいリクエストの一覧は net-policy.js にある。

// =========================================
// 展示モード（リポジトリのルートの start-demo.bat が --exhibit を付けて起動する）
// 来場者が同じデモアカウントを使い回すので、前の人の話や同意が次の人に引き継がれないようにする：
//   - 記憶はディスクに保存せず、ログイン中だけメモリに置く（ログアウト・アプリの終了で消える）
//   - 感情ログ送信の同意は、起動時とログアウトのたびに消す（来場者ごとに同意画面が出る）
//   - Ollama のモデルを長めに読み込んだままにする（来場者の間があいても、最初の返事を遅くしない）
// ふだんの起動（npm start）では、どれも行わない。
// =========================================
const EXHIBIT_MODE = process.argv.includes("--exhibit");
const EXHIBIT_KEEP_ALIVE = "60m";
const CONSENT_MAP_KEY = "emotion_consent_map"; // js/script.js の CONSENT_MAP_KEY と同じ

function clearConsentForExhibit() {
  if (EXHIBIT_MODE) store.delete(CONSENT_MAP_KEY);
}

let mainWindow = null;

// ログには URL 全体ではなく、スキームとホストだけを出す
// （クエリに会話の内容などが含まれることがあるため）
function describeUrl(url) {
  try {
    const u = new URL(url);
    return u.host ? `${u.protocol}//${u.host}` : u.protocol;
  } catch {
    return "（解釈できない URL）";
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 560,
    title: "つむぎ",
    icon: path.join(__dirname, "images", "icon.ico"),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#090704",
    webPreferences: {
      webSecurity: true,
      allowRunningInsecureContent: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 環境によっては辞書をネットから取りに行くため切る
      spellcheck: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow = win;

  Menu.setApplicationMenu(null);
  win.loadFile("login.html");

  // ===== デバッグ用一時変更 =====
  // メニューバーを消しているためCtrl+Shift+Iのショートカットが効かない。
  // 調査が終わったら、このwin.webContents.openDevTools()の行は削除してよい。
  //win.webContents.openDevTools();
  // ===== ここまで =====

  // 外部の URL は開かない（新しいウィンドウも、既定のブラウザも）
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // アプリのフォルダの中の HTML 以外へは、ウィンドウを移動させない
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url, __dirname)) {
      event.preventDefault();
      console.warn(`[net] アプリの外への画面移動を止めました: ${describeUrl(url)}`);
    }
  });

  win.on("closed", () => {
    mainWindow = null;
  });
}

// =========================================
// 画面側（HTML）の通信と権限の制限
// 画面側からの通信は、ローカルファイル（file:・blob:・data:）と開発者ツール（devtools:）以外、
// すべて取り消す（CSP と二重の守り）。
// 中継（下の net:* の IPC）は main プロセスから Node の fetch で送るため、ここの影響を受けない。
// =========================================
function restrictRendererSession() {
  const ses = session.defaultSession;

  ses.webRequest.onBeforeRequest((details, callback) => {
    if (isLocalRequestUrl(details.url)) {
      callback({});
      return;
    }
    console.warn(`[net] 外部への通信を止めました: ${describeUrl(details.url)}`);
    callback({ cancel: true });
  });

  // カメラ・マイク・通知などの権限は使わないので、すべて断る
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);

  // スペルチェックは使わない（有効のままだと、辞書をネットから取りに行くことがあるため）
  ses.setSpellCheckerEnabled(false);
}

// =========================================
// IPC: electron-store 操作（safeStorageによる暗号化つき）
//
// 保存形式：
//   暗号化成功時   → { __enc: true,  data: "<base64 encrypted>" }
//   平文フォールバック時 → { __enc: false, data: <元の値> }
//   旧形式（導入前のデータ）→ ラッパーなしの生の値（後方互換で読み込み可）
// =========================================

function isEncWrapper(value) {
  return value !== null && typeof value === "object" && typeof value.__enc === "boolean" && "data" in value;
}

function wrapValue(value) {
  if (safeStorage.isEncryptionAvailable()) {
    try {
      const json = JSON.stringify(value);
      const encryptedBuf = safeStorage.encryptString(json);
      return { __enc: true, data: encryptedBuf.toString("base64") };
    } catch (err) {
      console.warn("[Store] 暗号化に失敗したため平文で保存します:", err.message);
      return { __enc: false, data: value };
    }
  }
  console.warn(
    "[Store] この環境ではOSレベルの暗号化(safeStorage)が利用できないため、平文で保存します。" +
    "（safeStorage.isEncryptionAvailable() === false）"
  );
  return { __enc: false, data: value };
}

function unwrapValue(stored) {
  if (stored === undefined) return undefined;

  if (!isEncWrapper(stored)) {
    // 暗号化導入前に保存された旧形式データ。そのまま返す（後方互換）
    return stored;
  }

  if (!stored.__enc) {
    return stored.data;
  }

  try {
    const buf  = Buffer.from(stored.data, "base64");
    const json = safeStorage.decryptString(buf);
    return JSON.parse(json);
  } catch (err) {
    console.warn("[Store] 復号に失敗しました:", err.message);
    return undefined;
  }
}

ipcMain.handle("store:get", (event, key) => {
  const stored = store.get(key);
  return unwrapValue(stored);
});

ipcMain.handle("store:set", (event, key, value) => {
  store.set(key, wrapValue(value));
  return true;
});

ipcMain.handle("store:delete", (event, key) => {
  store.delete(key);
  return true;
});

// =========================================
// IPC: つむぎの記憶（社員ごとに、その人のパスワードから作った鍵で暗号化する。memory-crypto.js）
//
// 鍵はログインのとき（memory:unlock）に作り、このプロセスのメモリにだけ置く。ディスクには書かない。
// ログアウト・アプリの終了で消える。画面側には鍵を渡さず、読む・書く・消すだけを受け付ける。
// 保存するレコードは、さらに wrapValue（OS の暗号化）で包んで electron-store に入れる。
// =========================================

// ふだん：{ storeKey, key, salt }。展示モード：{ exhibitMemory }（記憶はここにだけ置く。まだないときは null）
let memorySession = null;

ipcMain.handle("memory:unlock", async (event, employeeId, password) => {
  memorySession = null;
  // electron-store はキーの "." を入れ子として扱うため、社員IDは数字だけに限る
  if (!/^\d+$/.test(String(employeeId)) || typeof password !== "string" || password === "") return false;

  if (EXHIBIT_MODE) {
    // 展示モードでは鍵を作らず、ディスクにある記憶も読まない
    memorySession = { exhibitMemory: null };
    return true;
  }

  const storeKey = `memory_${employeeId}`;
  const record = unwrapValue(store.get(storeKey));
  // 鍵はレコードと同じソルトから作る（ソルトを変えると、保存済みの記憶を読めなくなる）
  const salt = record?.salt ?? newSalt();
  memorySession = { storeKey, key: await deriveMemoryKey(password, salt), salt };
  return true;
});

// 戻り値：{ exists: この社員の記憶が保存されているか, memory: 記憶 }
ipcMain.handle("memory:get", () => {
  if (!memorySession) return { exists: false, memory: {} };
  if (EXHIBIT_MODE) {
    const memory = memorySession.exhibitMemory;
    return memory ? { exists: true, memory } : { exists: false, memory: {} };
  }
  const record = unwrapValue(store.get(memorySession.storeKey));
  if (record === undefined) return { exists: false, memory: {} };

  try {
    return { exists: true, memory: decryptMemory(memorySession.key, record) };
  } catch (err) {
    // パスワードがリセットされた・ファイルが壊れたなどで読めない記憶は、消して新しく始める
    console.warn("[Memory] 記憶を読めなかったため、消して新しく始めます:", err.message);
    store.delete(memorySession.storeKey);
    return { exists: false, memory: {} };
  }
});

ipcMain.handle("memory:set", (event, memory) => {
  if (!memorySession) return false;
  if (memory === null || typeof memory !== "object" || Array.isArray(memory)) return false;
  if (EXHIBIT_MODE) {
    memorySession.exhibitMemory = { ...memory };
    return true;
  }
  store.set(memorySession.storeKey, wrapValue(encryptMemory(memorySession.key, memorySession.salt, memory)));
  return true;
});

ipcMain.handle("memory:delete", () => {
  if (!memorySession) return false;
  if (EXHIBIT_MODE) {
    memorySession.exhibitMemory = null;
    return true;
  }
  store.delete(memorySession.storeKey);
  return true;
});

// ログインしたばかりか。チャット画面がログイン時のあいさつを出すときに1回だけ使う
// （管理者画面から戻ってチャット画面を開き直したときに、あいさつを繰り返さないため）
let greetingPending = false;

ipcMain.on("auth:login-success", () => {
  greetingPending = true;
  if (mainWindow) mainWindow.loadFile("index.html");
});
ipcMain.on("auth:logout", () => {
  memorySession = null; // 次にログインする社員が、前の社員の鍵（展示モードでは記憶）を使えないようにする
  greetingPending = false;
  clearConsentForExhibit();
  if (mainWindow) mainWindow.loadFile("login.html");
});

ipcMain.handle("greeting:consume", () => {
  const pending = greetingPending;
  greetingPending = false;
  return pending;
});

// =========================================
// VOICEVOX の音声エンジンを、アプリの起動時に立ち上げる
// - すでに動いていれば、そのまま使う（アプリを閉じても止めない）
// - 動いていなければ、画面のない音声エンジン（vv-engine/run.exe）を見えない形で起動し、
//   アプリを閉じるときに止める。待ち受けは 127.0.0.1 に限る
// - 見つからないときは何もしない（チャット画面に「VOICEVOX が起動していない」の案内が出る）
// Ollama は、インストールするとログイン時に自動で起動するので、ここでは扱わない。
// =========================================
const VOICEVOX_ENGINE_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA || "", "Programs", "VOICEVOX", "vv-engine", "run.exe"), // ユーザーごとのインストール
  path.join(process.env.ProgramFiles || "", "VOICEVOX", "vv-engine", "run.exe"),             // すべてのユーザーへのインストール
];
const VOICEVOX_START_TIMEOUT_MS = 30000; // 起動にはふつう10〜20秒かかる

let voicevoxProcess = null;  // アプリが起動したエンジン（もともと動いていたときは null）
let voicevoxStarting = null; // アプリが起動したエンジンの準備ができるまでの Promise（true＝応答した）

async function isVoicevoxResponding() {
  try {
    const res = await fetch(buildRelayUrl("voicevox", "/version", "GET"), { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForVoicevox(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isVoicevoxResponding()) return true;
    if (!voicevoxProcess) return false; // 起動に失敗して、エンジンが終わってしまった
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return false;
}

async function startVoicevoxIfNeeded() {
  if (process.platform !== "win32" || await isVoicevoxResponding()) return;

  const engine = VOICEVOX_ENGINE_CANDIDATES.find(p => p && fs.existsSync(p));
  if (!engine) {
    console.warn("[VOICEVOX] 音声エンジンが見つからないため、起動しませんでした");
    return;
  }

  voicevoxProcess = spawn(engine, ["--host", "127.0.0.1"], { windowsHide: true, stdio: "ignore" });
  voicevoxProcess.on("error", (err) => {
    console.warn("[VOICEVOX] 音声エンジンを起動できませんでした:", err.message);
    voicevoxProcess = null;
  });
  voicevoxProcess.on("exit", () => { voicevoxProcess = null; });
  voicevoxStarting = waitForVoicevox(VOICEVOX_START_TIMEOUT_MS);
}

// チャット画面が「VOICEVOX が起動していない」と案内する前に呼ぶ。
// アプリがエンジンを起動している途中なら、準備ができるまで待つ
ipcMain.handle("voicevox:wait", async () => (voicevoxStarting ? voicevoxStarting : false));

app.on("will-quit", () => {
  if (voicevoxProcess) voicevoxProcess.kill();
});

// =========================================
// 共通fetchラッパー
// 戻り値は必ずこの2形式のどちらか：
//   成功: { ok: true, status, data }
//   失敗: { ok: false, reason: "connection_refused"|"http_error"|"invalid_json"|"unknown"|"forbidden", status?, message?, data? }
// responseType: "json"（デフォルト） | "arraybuffer" | "none"
// "forbidden" だけは safeFetch ではなく、呼ぶ前に返す
// （許可リストにない中継は下の rejectRelay、PC の外で動くモデルは rejectModel）。
// =========================================
async function safeFetch(url, { method = "GET", headers = {}, body, responseType = "json" } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body !== undefined
        ? (typeof body === "string" ? body : JSON.stringify(body))
        : undefined,
    });
  } catch (err) {
    return { ok: false, reason: "connection_refused", message: err.message };
  }

  if (!response.ok) {
    let errBody = null;
    try { errBody = await response.json(); } catch { /* JSONでなければ無視 */ }
    return { ok: false, reason: "http_error", status: response.status, data: errBody };
  }

  if (responseType === "none") {
    return { ok: true, status: response.status, data: null };
  }

  if (responseType === "arraybuffer") {
    try {
      const buf = await response.arrayBuffer();
      return { ok: true, status: response.status, data: buf };
    } catch (err) {
      return { ok: false, reason: "unknown", message: err.message };
    }
  }

  try {
    const data = await response.json();
    return { ok: true, status: response.status, data };
  } catch (err) {
    return { ok: false, reason: "invalid_json", message: err.message };
  }
}

// 許可リストにない中継を拒否する。
// ログには「?」より前だけを出す（VOICEVOX のクエリには会話の文章が入るため）。
function rejectRelay(service, method, reqPath) {
  const methodText = String(method).slice(0, 16);
  const pathOnly   = String(reqPath).split("?")[0].slice(0, 100);
  console.warn(`[net] 許可されていない中継を拒否しました: ${service} ${methodText} ${pathOnly}`);
  return { ok: false, reason: "forbidden" };
}

// PC の外で動くモデル（Ollama の cloud モデルなど）への会話の中継を拒否する
function rejectModel(model) {
  console.warn(`[net] この PC の中で動かないモデルへの中継を拒否しました: ${String(model).slice(0, 60)}`);
  return { ok: false, reason: "forbidden" };
}

// =========================================
// IPC: Ollama への中継
// =========================================
ipcMain.handle("net:ollamaRequest", async (event, { path: reqPath, method, body } = {}) => {
  const httpMethod = method || "GET";
  const url = buildRelayUrl("ollama", reqPath, httpMethod);
  if (!url) return rejectRelay("ollama", httpMethod, reqPath);
  // 会話（POST /api/chat）は、この PC の中で動くモデルにだけ送る
  if (httpMethod === "POST" && !isAllowedOllamaModel(body?.model)) return rejectModel(body?.model);
  // 展示モードでは、モデルを長めに読み込んだままにする（Ollama の既定は5分）
  const sendBody = EXHIBIT_MODE && httpMethod === "POST" && body && typeof body === "object"
    ? { ...body, keep_alive: EXHIBIT_KEEP_ALIVE }
    : body;
  return safeFetch(url, {
    method: httpMethod,
    headers: sendBody !== undefined ? { "Content-Type": "application/json" } : {},
    body: sendBody,
    responseType: "json",
  });
});

// =========================================
// IPC: VOICEVOX への中継
// =========================================
ipcMain.handle("net:voicevoxRequest", async (event, { path: reqPath, method, body, responseType } = {}) => {
  const httpMethod = method || "GET";
  const url = buildRelayUrl("voicevox", reqPath, httpMethod);
  if (!url) return rejectRelay("voicevox", httpMethod, reqPath);
  return safeFetch(url, {
    method: httpMethod,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body,
    responseType: responseType === "arraybuffer" ? "arraybuffer" : "json",
  });
});

// =========================================
// IPC: API サーバーへの中継
// =========================================
ipcMain.handle("net:serverRequest", async (event, { path: reqPath, method, body, token } = {}) => {
  const httpMethod = method || "GET";
  const url = buildRelayUrl("server", reqPath, httpMethod);
  if (!url) return rejectRelay("server", httpMethod, reqPath);
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return safeFetch(url, {
    method: httpMethod,
    headers,
    body,
    responseType: "json",
  });
});

app.whenReady().then(() => {
  restrictRendererSession();
  clearConsentForExhibit(); // 前回の展示で最後の来場者がログアウトせずに閉じた場合に備える
  // 待たない（ログインしているあいだに起動する）
  startVoicevoxIfNeeded().catch(err => console.warn("[VOICEVOX] 起動の確認に失敗しました:", err.message));
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
