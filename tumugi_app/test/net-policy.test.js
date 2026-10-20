// =========================================
// test/net-policy.test.js
// net-policy.js の単体テスト（実行：npm test）
// =========================================

const test   = require("node:test");
const assert = require("node:assert/strict");
const os     = require("os");
const path   = require("path");
const { pathToFileURL } = require("url");

const { buildRelayUrl, isLocalRequestUrl, isAllowedNavigation, isAllowedOllamaModel } = require("../net-policy");

// どれも null（拒否）になることを確かめる
function assertRejected(cases) {
  for (const [service, reqPath, method] of cases) {
    assert.equal(
      buildRelayUrl(service, reqPath, method),
      null,
      `拒否されるべき：${String(service)} ${String(method)} ${String(reqPath)}`
    );
  }
}

// -----------------------------------------
// buildRelayUrl
// -----------------------------------------
test("buildRelayUrl: 許可した9つの組は URL を返す", () => {
  const cases = [
    ["ollama",   "/api/chat",                             "POST", "http://127.0.0.1:11434/api/chat"],
    ["ollama",   "/api/tags",                             "GET",  "http://127.0.0.1:11434/api/tags"],
    ["voicevox", "/audio_query?text=%E3%81%82&speaker=8", "POST", "http://127.0.0.1:50021/audio_query?text=%E3%81%82&speaker=8"],
    ["voicevox", "/synthesis?speaker=8",                  "POST", "http://127.0.0.1:50021/synthesis?speaker=8"],
    ["voicevox", "/version",                              "GET",  "http://127.0.0.1:50021/version"],
    ["server",   "/login.php",                            "POST", "http://127.0.0.1:8080/api/login.php"],
    ["server",   "/save_emotion.php",                     "POST", "http://127.0.0.1:8080/api/save_emotion.php"],
    ["server",   "/dashboard_data.php",                   "GET",  "http://127.0.0.1:8080/api/dashboard_data.php"],
    ["server",   "/change_password.php",                  "POST", "http://127.0.0.1:8080/api/change_password.php"],
  ];
  for (const [service, reqPath, method, expected] of cases) {
    assert.equal(buildRelayUrl(service, reqPath, method), expected, `${service} ${method} ${reqPath}`);
  }
});

test("buildRelayUrl: 接続先のすり替えを拒否する", () => {
  assertRejected([
    ["ollama",   "@evil.com/x",                 "POST"],
    ["ollama",   "//evil.com/api/chat",         "POST"],
    ["voicevox", "@evil.com/audio_query?text=a", "POST"],
    ["server",   "//evil.com/login.php",        "POST"],
  ]);
});

test("buildRelayUrl: 許可していないエンドポイントを拒否する", () => {
  assertRejected([
    ["ollama", "/api/pull",     "POST"],
    ["ollama", "/api/delete",   "DELETE"],
    ["ollama", "/api/delete",   "POST"],
    ["ollama", "/api/generate", "POST"],
    ["server", "/logout.php",   "POST"],
  ]);
});

test("buildRelayUrl: メソッドが違えば拒否する", () => {
  assertRejected([
    ["ollama", "/api/chat",          "GET"],
    ["ollama", "/api/tags",          "POST"],
    ["ollama", "/api/chat",          "post"],
    ["server", "/dashboard_data.php", "POST"],
    ["server", "/change_password.php", "GET"],
  ]);
});

test("buildRelayUrl: パスの書き方が違えば拒否する", () => {
  assertRejected([
    ["ollama", "/api/../api/chat",      "POST"],
    ["ollama", "/api/%2e%2e/api/chat",  "POST"],
    ["ollama", "/api\\chat",            "POST"],
    ["ollama", "/api/chat#x",           "POST"],
    ["ollama", "/api/chat/",            "POST"],
    ["ollama", "/API/CHAT",             "POST"],
  ]);
});

test("buildRelayUrl: 許可していないクエリを拒否する", () => {
  assertRejected([
    ["ollama",   "/api/chat?x=1",  "POST"],
    ["ollama",   "/api/chat?",     "POST"],
    ["voicevox", "/version?x=1",   "GET"],
    ["server",   "/login.php?x=1", "POST"],
  ]);
});

test("buildRelayUrl: 表示できる ASCII 文字以外を含むパスを拒否する", () => {
  assertRejected([
    ["ollama",   "",                          "POST"],
    ["voicevox", "/audio_query?text=あ",      "POST"],
    ["voicevox", "/audio_query?text=a b",     "POST"],
    ["ollama",   "/api/chat\n",               "POST"],
  ]);
});

test("buildRelayUrl: 文字列でない引数を拒否する", () => {
  assertRejected([
    ["ollama", undefined,   "POST"],
    ["ollama", null,        "POST"],
    ["ollama", 123,         "POST"],
    ["ollama", "/api/chat", undefined],
    ["ollama", "/api/chat", null],
  ]);
});

test("buildRelayUrl: 中継先が違えば拒否する", () => {
  assertRejected([
    ["ollama",      "/login.php", "POST"],
    ["server",      "/api/chat",  "POST"],
    ["evil",        "/api/chat",  "POST"],
    ["constructor", "/api/chat",  "POST"],
    ["__proto__",   "/api/chat",  "POST"],
    [undefined,     "/api/chat",  "POST"],
  ]);
});

test("buildRelayUrl: パーセントエンコードによるすり替えを拒否する", () => {
  assertRejected([
    ["ollama",   "/api%2fchat",         "POST"],
    ["ollama",   "/api%2Fchat",         "POST"],
    ["ollama",   "/api%5cchat",         "POST"],
    ["ollama",   "/api/chat%5c",        "POST"],
    ["ollama",   "/%2e%2e/api/chat",    "POST"],
    ["server",   "/%2e%2e/login.php",   "POST"],
    ["voicevox", "/audio_query%3fx=1",  "POST"],
  ]);
});

test("buildRelayUrl: 許可したクエリに @ があっても接続先は変わらない", () => {
  const url = buildRelayUrl("voicevox", "/audio_query?text=@evil.com&speaker=8", "POST");
  assert.equal(url, "http://127.0.0.1:50021/audio_query?text=@evil.com&speaker=8");
  assert.equal(new URL(url).host, "127.0.0.1:50021");
});

// -----------------------------------------
// isLocalRequestUrl
// -----------------------------------------
test("isLocalRequestUrl: ローカルのスキームは許可する", () => {
  for (const url of [
    "file:///C:/app/index.html",
    "file://localhost/C:/app/index.html",
    "file:///C:/senko_program/%E8%87%AA%E4%BD%9C/index.html",
    "blob:file:///0b6c3d5e-1111-2222-3333-444455556666",
    "data:image/svg+xml,%3Csvg%3E%3C/svg%3E",
    "devtools://devtools/bundled/devtools_app.html",
  ]) {
    assert.equal(isLocalRequestUrl(url), true, url);
  }
});

test("isLocalRequestUrl: それ以外は許可しない", () => {
  for (const url of [
    "http://127.0.0.1:11434/api/tags",
    "https://fonts.googleapis.com/css2?family=Noto+Sans+JP",
    "https://fonts.gstatic.com/s/x.woff2",
    "ws://127.0.0.1:1234",
    "ftp://example.com/x",
    "file://evil.com/share/x.png",
    "file:////evil.com/share/x.png",
    "file:///%2F%2Fevil.com/x.png",
    "not a url",
    "",
    undefined,
  ]) {
    assert.equal(isLocalRequestUrl(url), false, String(url));
  }
});

// -----------------------------------------
// isAllowedNavigation
// -----------------------------------------
const appDir = path.join(os.tmpdir(), "tumugi-app-test");
const toUrl  = (...parts) => pathToFileURL(path.join(...parts)).href;

test("isAllowedNavigation: アプリのフォルダの中の HTML は許可する", () => {
  for (const url of [
    toUrl(appDir, "index.html"),
    toUrl(appDir, "admin-dashboard.html"),
    toUrl(appDir, "login.html"),
    toUrl(appDir, "sub", "page.html"),
  ]) {
    assert.equal(isAllowedNavigation(url, appDir), true, url);
  }
});

test("isAllowedNavigation: それ以外は許可しない", () => {
  for (const url of [
    toUrl(os.tmpdir(), "other.html"),
    pathToFileURL(appDir).href + "/../x.html",
    pathToFileURL(appDir).href,
    toUrl(appDir, "js", "script.js"),
    "https://example.com/",
    "javascript:alert(1)",
    "not a url",
    undefined,
  ]) {
    assert.equal(isAllowedNavigation(url, appDir), false, String(url));
  }
});

// Windows 固有の罠（ドライブ・UNC・大文字小文字・名前の前半が同じ別フォルダ）。
// パスの扱いが OS で違うため、Windows のときだけ実行する。ファイルの存在は見ないので、架空のパスでよい。
const winAppDir = "C:\\tumugi-app";

test("isAllowedNavigation: Windows でも、アプリのフォルダの中の HTML は許可する", { skip: process.platform !== "win32" }, () => {
  for (const url of [
    "file:///C:/tumugi-app/index.html",
    "file:///c:/Tumugi-App/index.html",
    "file:///C:/tumugi-app/LOGIN.HTML",
  ]) {
    assert.equal(isAllowedNavigation(url, winAppDir), true, url);
  }
});

test("isAllowedNavigation: Windows のドライブ・UNC・別フォルダは許可しない", { skip: process.platform !== "win32" }, () => {
  for (const url of [
    "file:///C:/tumugi-app2/index.html",
    "file:///C:/tumugi-app.bak/index.html",
    "file:///D:/tumugi-app/index.html",
    "file://server/share/tumugi-app/index.html",
    "file:////server/share/tumugi-app/index.html",
    "file:///C:/tumugi-app/..%2Fx.html",
    "file:///C:/tumugi-app%5C..%5Cx.html",
    "file:///C:/tumugi-app/../x.html",
  ]) {
    assert.equal(isAllowedNavigation(url, winAppDir), false, url);
  }
});

// -----------------------------------------
// isAllowedOllamaModel
// -----------------------------------------
test("isAllowedOllamaModel: この PC の中で動くモデルは許可する", () => {
  for (const model of [
    "gemma3:12b",
    "gemma3:4b",
    "llama3.1:8b",
    "qwen2.5:7b-instruct",
    "mistral",
    "cloudy:7b",
    "my-cloud-model:7b",
  ]) {
    assert.equal(isAllowedOllamaModel(model), true, model);
  }
});

test("isAllowedOllamaModel: cloud モデルと、文字列でない・おかしな名前は許可しない", () => {
  for (const model of [
    "gpt-oss:120b-cloud",
    "deepseek-v3.1:671b-cloud",
    "glm-4.6:cloud",
    "GPT-OSS:120B-CLOUD",
    "cloud",
    "gemma3:12b ",
    " gemma3:12b",
    "",
    undefined,
    null,
    123,
    {},
    ["gemma3:12b"],
  ]) {
    assert.equal(isAllowedOllamaModel(model), false, String(model));
  }
});
