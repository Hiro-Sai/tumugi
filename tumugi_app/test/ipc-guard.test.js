// =========================================
// test/ipc-guard.test.js
// ipc-guard.js（IPC の入口の守り。レビューの B3）の単体テスト（実行：npm test）
// =========================================

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("fs");
const path   = require("path");
const { pathToFileURL } = require("url");

const { STORE_KEYS, isAllowedStoreKey, isTrustedSender } = require("../ipc-guard");

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
