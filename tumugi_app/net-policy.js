// =========================================
// net-policy.js
// アプリの外との境界のルール：
//   - 中継してよいリクエスト（buildRelayUrl）
//   - 画面側（HTML）に許す通信（isLocalRequestUrl）
//   - 画面の移動先（isAllowedNavigation）
// Electron に依存しない純粋な関数だけを置き、main.js とテスト（test/net-policy.test.js）から使う。
// =========================================

const path = require("path");
const { fileURLToPath } = require("url");

// -----------------------------------------
// 中継先の基準 URL。中継はこの3つに固定する。
// 画面側から任意の URL を受け取って中継することは絶対にしない
// （XSS 発生時の外部送信路になるのを防ぐため）。
// "localhost" は IPv6（::1）として先に解決されることがあり、127.0.0.1 でしか
// 待ち受けないサーバー（Docker の API サーバーなど）とつながらない可能性があるため、IP アドレスを直接書いている。
// API サーバーは、リポジトリルートの compose.yaml で起動する。
// 将来 https:// にする場合、自己署名証明書だと Node.js の TLS 検証でエラーになるため、
// 信頼された認証局の証明書を使うか、別途対応を検討すること（未決定・保留中）。
// -----------------------------------------
const BASE_URLS = Object.freeze({
  ollama:   "http://127.0.0.1:11434",
  voicevox: "http://127.0.0.1:50021",
  server:   "http://127.0.0.1:8080/api",
});

// -----------------------------------------
// 中継してよいメソッドとパスの組。query: true の組だけ「?」以降を付けてよい。
// Ollama の /api/pull（ネットからモデルを取得）や /api/delete などを通さないため、
// 使うものだけを書く。API を足すときは、ここにも足すこと。
// -----------------------------------------
const ALLOWED_REQUESTS = Object.freeze({
  ollama: [
    { method: "POST", path: "/api/chat" },
    { method: "GET",  path: "/api/tags" },
  ],
  voicevox: [
    { method: "POST", path: "/audio_query", query: true },
    { method: "POST", path: "/synthesis",   query: true },
    { method: "GET",  path: "/version" },
  ],
  server: [
    { method: "POST", path: "/login.php" },
    { method: "POST", path: "/save_emotion.php" },
    { method: "GET",  path: "/dashboard_data.php" },
    { method: "POST", path: "/change_password.php" },
  ],
});

// 表示できる ASCII 文字（! から ~ まで）だけでできているか
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

// 中継してよければ URL の文字列を、だめなら null を返す。
// パスは許可リストと文字列として完全に一致したときだけ通す
// （"/api/../api/chat" や "%2e%2e" のような書き方は、正規化せずに拒否する）。
function buildRelayUrl(service, reqPath, method) {
  if (!Object.prototype.hasOwnProperty.call(BASE_URLS, service)) return null;
  if (typeof reqPath !== "string" || typeof method !== "string") return null;
  if (!PRINTABLE_ASCII.test(reqPath)) return null;
  if (!reqPath.startsWith("/") || reqPath.startsWith("//")) return null;
  if (reqPath.includes("\\") || reqPath.includes("#")) return null;

  const queryIndex = reqPath.indexOf("?");
  const hasQuery   = queryIndex !== -1;
  const pathPart   = hasQuery ? reqPath.slice(0, queryIndex) : reqPath;

  const rule = ALLOWED_REQUESTS[service].find(r => r.method === method && r.path === pathPart);
  if (!rule) return null;
  if (hasQuery && !rule.query) return null;

  // 念のため、組み立てた URL の接続先（スキーム・ホスト・ポート）が変わっていないことも確かめる
  const base = BASE_URLS[service];
  const url  = base + reqPath;
  try {
    if (new URL(url).origin !== new URL(base).origin) return null;
  } catch {
    return null;
  }
  return url;
}

// 画面側からの通信として許可してよいか（ローカルファイルと開発者ツールだけ）
const LOCAL_PROTOCOLS = new Set(["file:", "blob:", "data:", "devtools:"]);

function isLocalRequestUrl(url) {
  if (typeof url !== "string") return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!LOCAL_PROTOCOLS.has(parsed.protocol)) return false;
  if (parsed.protocol === "file:") return isLocalFileUrl(parsed);
  return true;
}

// file: の URL が、この PC の中のファイルを指しているか。
// Windows では file://ホスト名/共有名/... のような URL（UNC、ネットワーク上の共有フォルダ）を
// ネットワーク越しに取りに行くため、許可しない。
// （file://localhost/ は URL の解釈の段階でホスト名が空になる）
function isLocalFileUrl(parsed) {
  if (parsed.hostname !== "") return false;
  let filePath;
  try {
    filePath = fileURLToPath(parsed);
  } catch {
    return false;
  }
  return !filePath.startsWith("\\\\") && !filePath.startsWith("//");
}

// アプリのウィンドウがその URL に移動してよいか（appDir の中にある .html の file: URL だけ）
function isAllowedNavigation(url, appDir) {
  if (typeof url !== "string" || typeof appDir !== "string") return false;

  let filePath;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:") return false;
    filePath = fileURLToPath(parsed);
  } catch {
    return false;
  }

  const relative = path.relative(appDir, filePath);
  if (relative === "" || path.isAbsolute(relative)) return false;
  if (relative.split(path.sep)[0] === "..") return false;
  return relative.toLowerCase().endsWith(".html");
}

// Ollama に渡してよいモデル名か（この PC の中で動くモデルだけ）。
// Ollama の cloud モデル（名前が「-cloud」「:cloud」で終わる。例：gpt-oss:120b-cloud）は、
// Ollama にサインインしていると ollama.com のサーバーで動き、会話が PC の外に出るため拒否する。
const CLOUD_MODEL = /(^|[:-])cloud$/i;

function isAllowedOllamaModel(model) {
  if (typeof model !== "string") return false;
  if (!PRINTABLE_ASCII.test(model)) return false;
  return !CLOUD_MODEL.test(model);
}

module.exports = {
  BASE_URLS,
  ALLOWED_REQUESTS,
  buildRelayUrl,
  isLocalRequestUrl,
  isAllowedNavigation,
  isAllowedOllamaModel,
};
