// =========================================
// test/server-rules.test.js
// サーバー（PHP）とアプリ（JS・画面の文）の2か所にある決まりが、同じかを確かめる（実行：npm test。レビューの C6）。
//   - 社員の決まり：tumugi_server/includes/employee_admin.php と js/employee-rules.js
//   - パスワードの決まり：tumugi_server/api/change_password.php と js/password.js
//   - 同意画面の数：tumugi_server/includes/aggregate_rules.php と index.html
// PHP は動かさず、ファイルを文字として読んで、define('名前', 値) から値を取り出す。
// 値だけでなく、エラーの文も確かめる（値を変えて、文の中の数を直し忘れたときに落ちるように）。
// 感情の分類は、test/safety.test.js で確かめている。
// =========================================

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("fs");
const path   = require("path");

const { CODE_PATTERN, TEXT_MAX_CHARS, validateEmployeeForm } = require("../js/employee-rules");
const { MIN_CHARS, MAX_BYTES, validateNewPassword } = require("../js/password");

const APP_DIR    = path.join(__dirname, "..");
const SERVER_DIR = path.join(APP_DIR, "..", "tumugi_server");

function readServerFile(...parts) {
  return fs.readFileSync(path.join(SERVER_DIR, ...parts), "utf8");
}

// PHP の define('名前', 値) から値を取り出す。値は、整数か '…' の文字列だけを読む
function phpConstant(php, name) {
  const pattern = new RegExp(
    String.raw`define\('` + name + String.raw`',\s*(?:'((?:[^'\\]|\\.)*)'|(-?\d+))\s*\)`
  );
  const match = php.match(pattern);
  assert.ok(match, `${name} が見つからない`);
  if (match[2] !== undefined) return Number(match[2]);
  // シングルクォートの文字列で意味を持つのは、\\ と \' だけ
  return match[1].replace(/\\([\\'])/g, "$1");
}

// PHP の正規表現の文字列（'/中身/印'）を、中身と印に分ける
function splitPhpPattern(pattern) {
  const match = pattern.match(/^\/(.*)\/([a-zA-Z]*)$/s);
  assert.ok(match, `区切りが / の正規表現ではない: ${pattern}`);
  return { body: match[1], modifiers: match[2] };
}

// 社員IDの長さ（正規表現の {最小,最大}）
function codeLengthRange(source) {
  const match = source.match(/\{(\d+),(\d+)\}/);
  assert.ok(match, `社員IDの長さ（{最小,最大}）が見つからない: ${source}`);
  return { min: Number(match[1]), max: Number(match[2]) };
}

// PHP のファイルに、その文が '…' の文字列として、そのままあるか
function assertPhpHasMessage(php, message, file) {
  assert.ok(php.includes(`'${message}'`), `${file} に「${message}」がない`);
}

// その文が、今の値を含むか（含むはずの部分がないケースは null）
function assertMessageHas(message, part) {
  if (part === null) return;
  assert.ok(message.includes(part), `「${message}」に「${part}」がない`);
}

// ---------- 社員の決まり ----------

// 登録フォームの入力。指定しなかった項目は、正しい値にする
function employeeForm(overrides = {}) {
  return validateEmployeeForm({ code: "E049", name: "山田", department: "営業", isNew: true, ...overrides });
}

test("社員の決まり：社員IDの形・名前と部署の最大文字数・使えない社員IDが、サーバー（employee_admin.php）と同じ", () => {
  const php = readServerFile("includes", "employee_admin.php");

  // 社員IDの形。中身が同じで、PHP は D（最後の改行を許さない）、JS は印なし（JS の $ は、もともと最後の改行の手前に当たらない）
  const { body, modifiers } = splitPhpPattern(phpConstant(php, "EMPLOYEE_CODE_PATTERN"));
  assert.equal(CODE_PATTERN.source, body);
  assert.equal(modifiers, "D");
  assert.equal(CODE_PATTERN.flags, "");

  assert.equal(TEXT_MAX_CHARS, phpConstant(php, "EMPLOYEE_TEXT_MAX_CHARS"));

  // 使えない社員ID。サーバーの値を（大文字にしても）JS の確かめに通すと、使えない社員IDとして断られる
  const reserved = phpConstant(php, "EMPLOYEE_RESERVED_CODE");
  for (const code of [reserved, reserved.toUpperCase()]) {
    const result = employeeForm({ code });
    assert.equal(result.ok, false, code);
    assertMessageHas(result.message, `「${reserved.toUpperCase()}」`);
  }
});

test("社員の決まり：エラーの文が、サーバーと同じで、今の値を含む", () => {
  const php = readServerFile("includes", "employee_admin.php");
  const reserved = phpConstant(php, "EMPLOYEE_RESERVED_CODE").toUpperCase();
  const { min, max } = codeLengthRange(CODE_PATTERN.source);
  const tooLong = "あ".repeat(TEXT_MAX_CHARS + 1);

  // [入力, 文が含むはずの今の値]（〜 は「〜」）
  const cases = [
    [{ code: "E 001" }, `${min}〜${max}文字`],
    [{ code: reserved }, `「${reserved}」`],
    [{ name: "" }, null],
    [{ name: tooLong }, `${TEXT_MAX_CHARS}文字まで`],
    [{ department: "" }, null],
    [{ department: tooLong }, `${TEXT_MAX_CHARS}文字まで`],
  ];
  const messages = [];
  for (const [overrides, part] of cases) {
    const result = employeeForm(overrides);
    assert.equal(result.ok, false, JSON.stringify(overrides));
    assertPhpHasMessage(php, result.message, "employee_admin.php");
    assertMessageHas(result.message, part);
    messages.push(result.message);
  }
  // 6つとも別の文（どのケースも、ねらった確かめで断られている）
  assert.equal(new Set(messages).size, cases.length);

  // ログインで形が違うときの知らせ（サーバーだけにある。レビューの A5）も、今の最大の文字数を含む
  const loginMessage = readServerFile("api", "login.php").match(/'(社員IDは、[^']*)'/);
  assert.ok(loginMessage, "login.php に、社員IDの形の知らせがない");
  assertMessageHas(loginMessage[1], `${max}文字`);
});

// ---------- パスワードの決まり ----------

test("パスワードの決まり：最小の文字数・最大のバイト数が、サーバー（change_password.php）と同じ", () => {
  const php = readServerFile("api", "change_password.php");
  assert.equal(MIN_CHARS, phpConstant(php, "MIN_PASSWORD_CHARS"));
  assert.equal(MAX_BYTES, phpConstant(php, "MAX_PASSWORD_BYTES"));
});

test("パスワードの決まり：サーバーにもある3つの文が、サーバーと同じで、今の値を含む", () => {
  // 「現在のパスワードを入力してください」と「確認が一致しません」は、アプリだけの確かめなので比べない
  const php = readServerFile("api", "change_password.php");
  const current = "current-pass-1";

  // [新しいパスワード, 文が含むはずの今の値]
  const cases = [
    ["a".repeat(MIN_CHARS - 1), `${MIN_CHARS}文字以上`],
    ["a".repeat(MAX_BYTES + 1), `${MAX_BYTES}バイトまで`],
    [current, null], // 今と同じ
  ];
  const messages = [];
  for (const [next, part] of cases) {
    const result = validateNewPassword({ current, next, confirm: next });
    assert.equal(result.ok, false, next);
    assertPhpHasMessage(php, result.message, "change_password.php");
    assertMessageHas(result.message, part);
    messages.push(result.message);
  }
  assert.equal(new Set(messages).size, cases.length);
});

// ---------- 同意画面 ----------

test("同意画面の文：記録を消す日数と最低人数が、サーバー（aggregate_rules.php）の値と同じ", () => {
  // 同意画面の文は社員への約束なので、サーバーの値だけを変えると、約束が崩れる
  const php = readServerFile("includes", "aggregate_rules.php");
  const html = fs.readFileSync(path.join(APP_DIR, "index.html"), "utf8");
  const days = phpConstant(php, "EMOTION_LOG_RETENTION_DAYS");
  const minSize = phpConstant(php, "MIN_DEPT_SIZE");
  assert.ok(html.includes(`${days}日を過ぎると消えます`), `同意画面に「${days}日を過ぎると消えます」がない`);
  assert.ok(html.includes(`${minSize}名以上のグループ単位`), `同意画面に「${minSize}名以上のグループ単位」がない`);
});
