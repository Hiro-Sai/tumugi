"use strict";
// 5.2 ログイン（login.php）と 5.3 ログアウト（logout.php）
const { test, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  api,
  fixture,
  resetDb,
  randomValue,
  ensureEnvironment,
  loginAs,
  seedEmployees,
} = require("./helpers");

before(ensureEnvironment);
beforeEach(resetDb);

// 社員を1人入れて、パスワードを返す
function addEmployee(code, extra = {}) {
  const pw = randomValue();
  fixture([{ op: "add_employee", code, department: "営業部", pw, ...extra }]);
  return pw;
}

function login(code, pw) {
  return api("POST", "/login.php", { body: { employee_code: code, password: pw } });
}

function readAuth(code) {
  return fixture([{ op: "read_auth", code }])[0];
}

// ---------- 5.2 ログイン ----------

test("正しい社員IDとパスワードで 200。必要な項目が返る", async () => {
  const pw = addEmployee("E001");
  const [row] = fixture([{ op: "read_employee", code: "E001" }]);
  const res = await login("E001", pw);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), [
    "department",
    "employee_id",
    "expires_in",
    "is_admin",
    "must_change_password",
    "token",
  ]);
  assert.match(res.json.token, /^[0-9a-f]{64}$/);
  assert.equal(res.json.employee_id, row.id);
  assert.equal(res.json.department, "営業部");
  assert.equal(res.json.is_admin, false);
  assert.equal(res.json.must_change_password, false);
  assert.equal(res.json.expires_in, 86400);
  // トークンの行が1つ、成功の記録が1つ
  assert.deepEqual(readAuth("E001"), { tokens: 1, failed_attempts: 0, succeeded_attempts: 1 });
});

test("管理者は is_admin が true で返る", async () => {
  const pw = addEmployee("A001", { is_admin: true });
  const res = await login("A001", pw);
  assert.equal(res.status, 200);
  assert.equal(res.json.is_admin, true);
});

test("パスワードが違うと 401。トークンは作られず、失敗が1回数えられる", async () => {
  addEmployee("E001");
  const res = await login("E001", randomValue());
  assert.equal(res.status, 401);
  assert.equal(res.json.token, undefined);
  assert.deepEqual(readAuth("E001"), { tokens: 0, failed_attempts: 1, succeeded_attempts: 0 });
});

test("いない社員IDでも 401。エラーの文は、パスワードが違うときと同じ", async () => {
  const pw = addEmployee("E001");
  const wrongPw = await login("E001", randomValue());
  const unknown = await login("E999", pw);
  assert.equal(unknown.status, 401);
  assert.equal(typeof unknown.json.error, "string");
  assert.equal(unknown.json.error, wrongPw.json.error);
});

test("社員IDが空だと 400（パスワードは正しく送る）", async () => {
  const pw = addEmployee("E001");
  const res = await login("", pw);
  assert.equal(res.status, 400);
  // 空白だけの社員IDも、空として扱う
  const blank = await login("   ", pw);
  assert.equal(blank.status, 400);
  assert.deepEqual(readAuth("E001"), { tokens: 0, failed_attempts: 0, succeeded_attempts: 0 });
});

test("パスワードが空だと 400（社員IDは正しく送る）", async () => {
  addEmployee("E001");
  const res = await login("E001", "");
  assert.equal(res.status, 400);
  assert.deepEqual(readAuth("E001"), { tokens: 0, failed_attempts: 0, succeeded_attempts: 0 });
});

test("退職にした社員は 401", async () => {
  const pw = addEmployee("E001", { is_active: false });
  const res = await login("E001", pw);
  assert.equal(res.status, 401);
  assert.equal(res.json.token, undefined);
  assert.equal(readAuth("E001").tokens, 0);
});

test("仮のパスワードの社員は、ログインでき、must_change_password が true", async () => {
  const pw = addEmployee("E001", { must_change: true });
  const res = await login("E001", pw);
  assert.equal(res.status, 200);
  assert.equal(res.json.must_change_password, true);
  assert.equal(typeof res.json.token, "string");
});

test("失敗が5回あると、6回目は正しいパスワードでも 429", async () => {
  const pw = addEmployee("E001");
  fixture([{ op: "add_attempts", code: "E001", count: 5, succeeded: false, minutes_ago: 1 }]);
  const res = await login("E001", pw);
  assert.equal(res.status, 429);
  assert.equal(res.json.token, undefined);
  // トークンは作られず、記録も増えない
  assert.deepEqual(readAuth("E001"), { tokens: 0, failed_attempts: 5, succeeded_attempts: 0 });
});

test("失敗が4回なら、まだログインできる", async () => {
  const pw = addEmployee("E001");
  fixture([{ op: "add_attempts", code: "E001", count: 4, succeeded: false, minutes_ago: 1 }]);
  const res = await login("E001", pw);
  assert.equal(res.status, 200);
});

test("実際に5回間違えると、6回目は正しいパスワードでも 429", async () => {
  const pw = addEmployee("E001");
  for (let i = 0; i < 5; i += 1) {
    const res = await login("E001", randomValue());
    assert.equal(res.status, 401);
  }
  const locked = await login("E001", pw);
  assert.equal(locked.status, 429);
  assert.equal(readAuth("E001").failed_attempts, 5);
});

test("16分前の失敗は数えない（5回あってもログインできる）", async () => {
  const pw = addEmployee("E001");
  fixture([{ op: "add_attempts", code: "E001", count: 5, succeeded: false, minutes_ago: 16 }]);
  const res = await login("E001", pw);
  assert.equal(res.status, 200);
});

test("成功した回は、失敗の数に入らない", async () => {
  const pw = addEmployee("E001");
  // 失敗4回＋成功2回。成功が数えられていたら、合計6回でロックされる
  fixture([
    { op: "add_attempts", code: "E001", count: 4, succeeded: false, minutes_ago: 1 },
    { op: "add_attempts", code: "E001", count: 2, succeeded: true, minutes_ago: 1 },
  ]);
  const res = await login("E001", pw);
  assert.equal(res.status, 200);
});

test("社員IDは、大文字・小文字が違っても、前後に空白があってもログインできる", async () => {
  const pw = addEmployee("E001");
  const [row] = fixture([{ op: "read_employee", code: "E001" }]);
  const lower = await login("e001", pw);
  assert.equal(lower.status, 200);
  assert.equal(lower.json.employee_id, row.id);
  const spaced = await login("  E001  ", pw);
  assert.equal(spaced.status, 200);
  assert.equal(spaced.json.employee_id, row.id);
});

test("ログインすると、期限の切れたトークンが（ほかの社員の分も）消える", async () => {
  const [first, second, third] = seedEmployees(3);
  await loginAs(first.code, first.pw);
  await loginAs(third.code, third.pw);
  fixture([{ op: "expire_tokens", code: first.code }]);
  // 期限を切っただけでは、行は残っている
  assert.equal(readAuth(first.code).tokens, 1);

  await loginAs(second.code, second.pw);

  // 期限の切れた E001 の行は消え、期限内の E003 の行は残る
  assert.equal(readAuth(first.code).tokens, 0);
  assert.equal(readAuth(third.code).tokens, 1);
  assert.equal(readAuth(second.code).tokens, 1);
});

// ---------- 5.3 ログアウト ----------

test("ログアウトでトークンがないと 400", async () => {
  const res = await api("POST", "/logout.php");
  assert.equal(res.status, 400);
});

test("ログアウトしたトークンは、もう使えない（save_emotion.php が 401）", async () => {
  const pw = addEmployee("E001");
  const token = await loginAs("E001", pw);
  // ログアウト前は使える
  const beforeLogout = await api("POST", "/save_emotion.php", { body: { emotion: "normal" }, token });
  assert.equal(beforeLogout.status, 200);

  const out = await api("POST", "/logout.php", { token });
  assert.equal(out.status, 200);
  assert.deepEqual(out.json, { status: "ok" });
  assert.equal(readAuth("E001").tokens, 0);

  const after = await api("POST", "/save_emotion.php", { body: { emotion: "normal" }, token });
  assert.equal(after.status, 401);
});

test("知らないトークンでもログアウトは 200（何も消えない）", async () => {
  const pw = addEmployee("E001");
  const token = await loginAs("E001", pw);
  const out = await api("POST", "/logout.php", { token: randomValue(64) });
  assert.equal(out.status, 200);
  assert.deepEqual(out.json, { status: "ok" });
  // 本物のトークンの行は残り、まだ使える
  assert.equal(readAuth("E001").tokens, 1);
  const res = await api("POST", "/save_emotion.php", { body: { emotion: "normal" }, token });
  assert.equal(res.status, 200);
});
