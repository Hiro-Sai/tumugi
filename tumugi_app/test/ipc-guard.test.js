// =========================================
// test/ipc-guard.test.js
// ipc-guard.js（IPC の入口の守り。レビューの B3・B9）の単体テスト（実行：npm test）
// =========================================

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("fs");
const path   = require("path");
const { pathToFileURL } = require("url");

const { STORE_KEYS, SESSION_KEYS, isAllowedStoreKey, isSessionKey, isTrustedSender } = require("../ipc-guard");

// main.js と同じく、アプリのフォルダ（このテストの1つ上）を使う。
// このフォルダの名前に日本語が入っていても、正しく確かめられることも見る
const appDir    = path.join(__dirname, "..");
const toUrl     = (...parts) => pathToFileURL(path.join(...parts)).href;
const topFrame  = (url) => ({ url, parent: null });
const eventFrom = (frame) => ({ senderFrame: frame });

// -----------------------------------------
// isTrustedSender（IPC の送り主の確かめ）
// -----------------------------------------
test("isTrustedSender: アプリのフォルダの HTML を開いた、いちばん外の枠からなら受け付ける", () => {
  for (const name of ["login.html", "index.html", "admin-dashboard.html"]) {
    assert.equal(isTrustedSender(eventFrom(topFrame(toUrl(appDir, name))), appDir), true, name);
  }
});

test("isTrustedSender: HTML の中の枠（iframe）からは断る", () => {
  const parent = topFrame(toUrl(appDir, "index.html"));
  const child  = { url: toUrl(appDir, "index.html"), parent };
  assert.equal(isTrustedSender(eventFrom(child), appDir), false);
});

test("isTrustedSender: アプリの外の画面や、HTML でないものからは断る", () => {
  for (const url of [
    "https://example.com/",
    "about:blank",
    "data:text/html,<p>x</p>",
    "devtools://devtools/bundled/inspector.html",
    toUrl(appDir, "js", "auth.js"),
    toUrl(appDir, "..", "outside.html"),
    pathToFileURL(appDir).href,
    "",
    undefined,
  ]) {
    assert.equal(isTrustedSender(eventFrom(topFrame(url)), appDir), false, String(url));
  }
});

test("isTrustedSender: 送り主の枠がない・読めないときは断る", () => {
  assert.equal(isTrustedSender(eventFrom(null), appDir), false);
  assert.equal(isTrustedSender({}, appDir), false);
  assert.equal(isTrustedSender(undefined, appDir), false);

  // 枠が先に消えていると、読むときに例外になることがある
  const disposed = () => { throw new Error("Render frame was disposed"); };
  assert.equal(isTrustedSender({ get senderFrame() { return disposed(); } }, appDir), false);
  assert.equal(isTrustedSender(eventFrom({ parent: null, get url() { return disposed(); } }), appDir), false);
});

// -----------------------------------------
// isAllowedStoreKey（保存の IPC で通すキー）
// -----------------------------------------
test("isAllowedStoreKey: 決めた6つのキーだけ通す", () => {
  assert.deepEqual([...STORE_KEYS].sort(), [
    "auth_department",
    "auth_employee_id",
    "auth_expires_at",
    "auth_is_admin",
    "auth_token",
    "emotion_consent_map",
  ]);
  for (const key of STORE_KEYS) assert.equal(isAllowedStoreKey(key), true, key);
});

test("isAllowedStoreKey: ほかのキーや、文字でないものは通さない", () => {
  for (const key of [
    "memory_1",
    "auth_",
    "auth_token2",
    "AUTH_TOKEN",
    " auth_token",
    "auth_token ",
    "",
    undefined,
    null,
    1,
    ["auth_token"],
    { toString: () => "auth_token" },
  ]) {
    assert.equal(isAllowedStoreKey(key), false, `${typeof key}: ${String(key)}`);
  }
});

// 画面側（js/*.js）が保存の IPC に渡すキーと、STORE_KEYS がちょうど同じか。
// キーを足して STORE_KEYS を直し忘れる（画面が動かなくなる）のと、使わなくなったキーを残すのを防ぐ
test("STORE_KEYS: 画面側が保存の IPC に渡すキーと、ちょうど同じ", () => {
  const jsDir = path.join(appDir, "js");
  const source = fs.readdirSync(jsDir)
    .filter(name => name.endsWith(".js"))
    .map(name => fs.readFileSync(path.join(jsDir, name), "utf8"))
    .join("\n");

  // 保存の IPC の呼び出しは、どれも1つ目にキーの定数（〜_KEY）を渡している
  const names = new Set();
  for (const m of source.matchAll(/electronAPI\.store(?:Get|Set|Delete)\(\s*([^\s,)]+)/g)) {
    assert.match(m[1], /^[A-Z][A-Z0-9_]*_KEY$/, `キーは定数で渡す: ${m[1]}`);
    names.add(m[1]);
  }
  assert.ok(names.size > 0, "保存の IPC の呼び出しが見つからない");

  const values = new Set();
  for (const name of names) {
    const def = source.match(new RegExp(`const\\s+${name}\\s*=\\s*"([^"]+)"`));
    assert.ok(def, `定数の定義が見つからない: ${name}`);
    values.add(def[1]);
  }
  assert.deepEqual([...values].sort(), [...STORE_KEYS].sort());
});

// -----------------------------------------
// isSessionKey（ディスクに保存せず、メモリにだけ置くキー。レビューの B9）
// -----------------------------------------
test("isSessionKey: ログインの情報の5つだけで、どれも保存の IPC で通すキー（同意などは入れない）", () => {
  assert.deepEqual([...SESSION_KEYS].sort(), [
    "auth_department",
    "auth_employee_id",
    "auth_expires_at",
    "auth_is_admin",
    "auth_token",
  ]);
  for (const key of SESSION_KEYS) {
    assert.equal(isAllowedStoreKey(key), true, key);
    assert.equal(isSessionKey(key), true, key);
  }
  for (const key of [
    "emotion_consent_map",
    "memory_1",
    "auth_",
    "AUTH_TOKEN",
    " auth_token",
    "",
    undefined,
    null,
    1,
    ["auth_token"],
    { toString: () => "auth_token" },
  ]) {
    assert.equal(isSessionKey(key), false, `${typeof key}: ${String(key)}`);
  }
});

// 画面側（js/*.js）のログインの情報のキー（AUTH_*_KEY）と、SESSION_KEYS がちょうど同じか。
// ログインの情報を足して SESSION_KEYS を直し忘れる（その値だけディスクに書いてしまう）のを防ぐ
test("SESSION_KEYS: 画面側のログインの情報のキー（AUTH_*_KEY）と、ちょうど同じ", () => {
  const jsDir = path.join(appDir, "js");
  const source = fs.readdirSync(jsDir)
    .filter(name => name.endsWith(".js"))
    .map(name => fs.readFileSync(path.join(jsDir, name), "utf8"))
    .join("\n");

  const values = [...source.matchAll(/const\s+AUTH_[A-Z0-9_]*_KEY\s*=\s*"([^"]+)"/g)].map(m => m[1]);
  assert.ok(values.length > 0, "AUTH_*_KEY の定義が見つからない");
  assert.deepEqual(values.sort(), [...SESSION_KEYS].sort());
});

// -----------------------------------------
// main.js（IPC の登録のしかた）
// -----------------------------------------
test("main.js: IPC は handleIpc・onIpc でだけ登録する（送り主の確かめを付け忘れないように）", () => {
  const source = fs.readFileSync(path.join(appDir, "main.js"), "utf8");
  const count = (re) => (source.match(re) || []).length;
  // ipcMain を直接呼ぶのは、handleIpc・onIpc の中の1回ずつだけ
  assert.equal(count(/ipcMain\.handle\(/g), 1);
  assert.equal(count(/ipcMain\.on\(/g), 1);
  assert.equal(count(/ipcMain\.(?:once|handleOnce|addListener|prependListener|prependOnceListener)\(/g), 0);
});

test("main.js: 保存の IPC の3つの入口は、どれもストアより先に isSessionKey を見る（ログインの情報をディスクに書かないように）", () => {
  const source = fs.readFileSync(path.join(appDir, "main.js"), "utf8");
  for (const channel of ["store:get", "store:set", "store:delete"]) {
    const start = source.indexOf(`handleIpc("${channel}"`);
    assert.ok(start >= 0, `${channel} の登録が見つからない`);
    // 登録の終わり（行の頭の「});」）までを見る
    const end = source.indexOf("\n});", start);
    assert.ok(end > start, `${channel} の登録の終わりが見つからない`);
    const handler = source.slice(start, end);
    const routed = handler.indexOf("isSessionKey(key)");
    const toStore = handler.indexOf("storeTask(");
    assert.ok(routed >= 0, `${channel} が isSessionKey を見ていない`);
    assert.ok(toStore >= 0, `${channel} の、ストアの読み書きが見つからない`);
    assert.ok(routed < toStore, `${channel} は、ストアより先に isSessionKey を見る`);
  }
});
