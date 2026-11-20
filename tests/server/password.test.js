"use strict";
// 5.5 パスワード変更（change_password.php）
const { test, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  api,
  fixture,
  resetDb,
  randomValue,
  ensureEnvironment,
  loginAs,
} = require("./helpers");

before(ensureEnvironment);
beforeEach(resetDb);

// 社員を1人入れてログインし、{ pw, token } を返す
async function setupEmployee(extra = {}) {
  const pw = randomValue();
  fixture([{ op: "add_employee", code: "E001", department: "営業部", pw, ...extra }]);
  const token = await loginAs("E001", pw);
  return { pw, token };
}

function change(token, currentPw, newPw) {
  return api("POST", "/change_password.php", {
    body: { current_password: currentPw, new_password: newPw },
    token,
  });
}

function login(pw) {
  return api("POST", "/login.php", { body: { employee_code: "E001", password: pw } });
}

function readAuth() {
  return fixture([{ op: "read_auth", code: "E001" }])[0];
}

test("トークンがないと 401", async () => {
  const { pw } = await setupEmployee();
  const res = await change(undefined, pw, randomValue());
  assert.equal(res.status, 401);
});

test("変えたあとは、新しいパスワードでログインでき、古いパスワードではできない", async () => {
  const { pw, token } = await setupEmployee();
  const newPw = randomValue();
  const res = await change(token, pw, newPw);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { status: "ok", revoked: 0 });

  const withNew = await login(newPw);
  assert.equal(withNew.status, 200);
  const withOld = await login(pw);
  assert.equal(withOld.status, 401);
});

test("今のパスワードが違うと 403。失敗が1回数えられ、パスワードは変わらない", async () => {
  const { pw, token } = await setupEmployee();
  const newPw = randomValue();
  const res = await change(token, randomValue(), newPw);
  assert.equal(res.status, 403);
  assert.equal(readAuth().failed_attempts, 1);
  // 古いパスワードのまま。新しいパスワードでは入れない
  assert.equal((await login(newPw)).status, 401);
  assert.equal((await login(pw)).status, 200);
});

test("今のパスワードが合えば、間違えた数が0に戻る（新しいパスワードが短くて 400 のときも）", async () => {
  const { pw, token } = await setupEmployee();
  for (let i = 0; i < 2; i += 1) {
    assert.equal((await change(token, randomValue(), randomValue())).status, 403);
  }
  assert.equal(readAuth().failed_attempts, 2);
  // 今のパスワードは合っている。新しいパスワードが8文字未満なので、パスワードは変わらない
  const res = await change(token, pw, randomValue(7));
  assert.equal(res.status, 400);
  assert.equal(readAuth().failed_attempts, 0);
});

test("新しいパスワードが8文字未満だと 400（今のパスワードは正しく送る）", async () => {
  const { pw, token } = await setupEmployee();
  const short = randomValue(7);
  const res = await change(token, pw, short);
  assert.equal(res.status, 400);
  // 変わっていない
  assert.equal((await login(short)).status, 401);
  assert.equal((await login(pw)).status, 200);
});

test("全角7文字も 400。全角8文字なら通る（全角も1文字と数える）", async () => {
  const { pw, token } = await setupEmployee();
  const sevenWide = "あ".repeat(7);
  const res = await change(token, pw, sevenWide);
  assert.equal(res.status, 400);

  const eightWide = "あ".repeat(8);
  const ok = await change(token, pw, eightWide);
  assert.equal(ok.status, 200);
  assert.equal((await login(eightWide)).status, 200);
});

test("新しいパスワードが72バイトを超えると 400。72バイトちょうどは通る", async () => {
  const { pw, token } = await setupEmployee();
  const tooLong = "a".repeat(73);
  const res = await change(token, pw, tooLong);
  assert.equal(res.status, 400);
  assert.equal((await login(tooLong)).status, 401);
  assert.equal((await login(pw)).status, 200);

  // 全角25文字は75バイトなので、文字数が少なくても 400
  const wideLong = "あ".repeat(25);
  const wide = await change(token, pw, wideLong);
  assert.equal(wide.status, 400);

  const limit = randomValue(72);
  const ok = await change(token, pw, limit);
  assert.equal(ok.status, 200);
  assert.equal((await login(limit)).status, 200);
});

test("今と同じパスワードは 400", async () => {
  const { pw, token } = await setupEmployee();
  const res = await change(token, pw, pw);
  assert.equal(res.status, 400);
  assert.equal((await login(pw)).status, 200);
});

test("仮のパスワードの社員が変えると、save_emotion.php が通るようになる", async () => {
  const { pw, token } = await setupEmployee({ must_change: true });
  const beforeChange = await api("POST", "/save_emotion.php", { body: { emotion: "normal" }, token });
  assert.equal(beforeChange.status, 401);

  const res = await change(token, pw, randomValue());
  assert.equal(res.status, 200);

  // 同じトークンで通る
  const after = await api("POST", "/save_emotion.php", { body: { emotion: "normal" }, token });
  assert.equal(after.status, 200);
  const [row] = fixture([{ op: "read_employee", code: "E001" }]);
  assert.equal(row.must_change_password, 0);
});

test("仮のパスワードを自分のパスワードに変えると、集計に入れ始める時刻が今になる（そのあとの記録は集計に入らない）", async () => {
  const { pw, token } = await setupEmployee({ must_change: true, counted_days_ago: 30 });
  const [beforeSeconds] = fixture([{ op: "read_counted", code: "E001" }]);
  assert.ok(beforeSeconds > 29 * 24 * 60 * 60);

  const res = await change(token, pw, randomValue());
  assert.equal(res.status, 200);

  // 変えた時刻（DB の時計）から数秒以内
  const [afterSeconds] = fixture([{ op: "read_counted", code: "E001" }]);
  assert.ok(afterSeconds >= 0 && afterSeconds < 60, `afterSeconds=${afterSeconds}`);

  // そのあとの記録は、集計に入れない記録（is_counted が 0）になる
  const save = await api("POST", "/save_emotion.php", { body: { emotion: "normal" }, token });
  assert.equal(save.status, 200);
  const [log] = fixture([{ op: "read_logs", code: "E001" }])[0];
  assert.equal(log.is_counted, 0);
});

test("ふつうのパスワード変更（仮でない）では、集計に入れ始める時刻は動かない", async () => {
  const { pw, token } = await setupEmployee({ counted_days_ago: 30 });
  const res = await change(token, pw, randomValue());
  assert.equal(res.status, 200);

  const [seconds] = fixture([{ op: "read_counted", code: "E001" }]);
  assert.ok(seconds > 29 * 24 * 60 * 60, `seconds=${seconds}`);
});

test("ほかのトークンは消え、今のトークンは残る（revoked の数）", async () => {
  const { pw, token: tokenA } = await setupEmployee();
  const tokenB = await loginAs("E001", pw);
  assert.equal(readAuth().tokens, 2);

  const res = await change(tokenA, pw, randomValue());
  assert.equal(res.status, 200);
  assert.equal(res.json.revoked, 1);

  assert.equal(readAuth().tokens, 1);
  const other = await api("POST", "/save_emotion.php", { body: { emotion: "normal" }, token: tokenB });
  assert.equal(other.status, 401);
  const current = await api("POST", "/save_emotion.php", { body: { emotion: "normal" }, token: tokenA });
  assert.equal(current.status, 200);
});

test("失敗が5回あると、パスワード変更は 429（今のパスワードは正しく送る）", async () => {
  const { pw, token } = await setupEmployee();
  fixture([{ op: "add_attempts", code: "E001", count: 5, succeeded: false, minutes_ago: 1 }]);
  const res = await change(token, pw, randomValue());
  assert.equal(res.status, 429);
  // 記録は増えない
  assert.equal(readAuth().failed_attempts, 5);
});

test("今のパスワードを5回間違えると、6回目は正しいパスワードでも 429", async () => {
  const { pw, token } = await setupEmployee();
  const newPw = randomValue();
  for (let i = 0; i < 5; i += 1) {
    const res = await change(token, randomValue(), newPw);
    assert.equal(res.status, 403);
  }
  assert.equal(readAuth().failed_attempts, 5);

  const locked = await change(token, pw, newPw);
  assert.equal(locked.status, 429);
  // ログインもロックされている（ログインと回数を共有）
  const loginRes = await login(pw);
  assert.equal(loginRes.status, 429);
});
