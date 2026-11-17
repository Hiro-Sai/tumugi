"use strict";
// 環境と道具そのものの確認
const { test, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  api,
  fixture,
  resetDb,
  randomValue,
  ensureEnvironment,
  loginAs,
  seedAdmin,
  seedEmployees,
} = require("./helpers");

before(ensureEnvironment);
beforeEach(resetDb);

test("環境が立っていて、ログインの API に応答がある", async () => {
  const res = await api("POST", "/login.php");
  assert.equal(res.status, 400);
});

test("resetDb のあと、全部のテーブルの行の数が 0", () => {
  seedAdmin();
  resetDb();
  const [counts] = fixture([{ op: "read_counts" }]);
  assert.deepEqual(counts, {
    employees: 0,
    emotion_logs: 0,
    auth_tokens: 0,
    login_attempts: 0,
    admin_audit_logs: 0,
    employee_notices: 0,
  });
});

test("add_employee のあと loginAs で token が取れる", async () => {
  const pw = randomValue();
  const [added] = fixture([{ op: "add_employee", code: "E001", department: "営業部", pw }]);
  assert.ok(added.id > 0);
  const token = await loginAs("E001", pw);
  assert.equal(typeof token, "string");
  assert.ok(token.length > 0);
  const [row] = fixture([{ op: "read_employee", code: "E001" }]);
  assert.equal(row.department, "営業部");
  assert.equal(row.is_active, 1);
  assert.equal(row.password_hash, undefined);
});

test("違うパスワードでは loginAs が throw する", async () => {
  const pw = randomValue();
  fixture([{ op: "add_employee", code: "E001", department: "営業部", pw }]);
  await assert.rejects(() => loginAs("E001", randomValue()), /status=401/);
});

test("seedAdmin と seedEmployees で入れた人がログインできる", async () => {
  const admin = seedAdmin();
  const [first, second, third] = seedEmployees(3, { prefix: "E" });
  assert.equal(admin.code, "A001");
  assert.deepEqual([first.code, second.code, third.code], ["E001", "E002", "E003"]);
  assert.ok(await loginAs(admin.code, admin.pw));
  assert.ok(await loginAs(third.code, third.pw));
  const [row] = fixture([{ op: "read_employee", code: "A001" }]);
  assert.equal(row.is_admin, 1);
});

test("add_logs で days_ago: 8 の行が、8日前の時刻で入る", () => {
  const pw = randomValue();
  fixture([{ op: "add_employee", code: "E001", department: "営業部", pw }]);
  const [added, logs] = fixture([
    {
      op: "add_logs",
      code: "E001",
      logs: [
        { emotion: "sad", score: 70, is_crisis: true, harassment: "received", days_ago: 8 },
        {},
      ],
    },
    { op: "read_logs", code: "E001" },
  ]);
  assert.equal(added.count, 2);
  assert.equal(logs.length, 2);

  // 古い順。8日前の行が先
  // 経過の秒数は DB の時計で測ったもの（PC の時計とは比べない）
  assert.ok(
    Math.abs(logs[0].age_seconds - 8 * 24 * 60 * 60) < 300,
    `8日前の行の時刻が合いません: ${logs[0].recorded_at}`
  );
  assert.equal(logs[0].emotion, "sad");
  assert.equal(logs[0].negativity_score, 70);
  assert.equal(logs[0].is_crisis, 1);
  assert.equal(logs[0].harassment_type, "received");

  // 省略した行は、normal・10・false・none・今
  assert.equal(logs[1].emotion, "normal");
  assert.equal(logs[1].negativity_score, 10);
  assert.equal(logs[1].is_crisis, 0);
  assert.equal(logs[1].harassment_type, "none");
  assert.ok(Math.abs(logs[1].age_seconds) < 300);
});

test("add_attempts で入れた数が、read_auth の数と合う", () => {
  const pw = randomValue();
  fixture([{ op: "add_employee", code: "E001", department: "営業部", pw }]);
  const [a, b, auth] = fixture([
    { op: "add_attempts", code: "E001", count: 3, succeeded: false, minutes_ago: 16 },
    { op: "add_attempts", code: "E001", count: 2, succeeded: true, minutes_ago: 1 },
    { op: "read_auth", code: "E001" },
  ]);
  assert.equal(a.count, 3);
  assert.equal(b.count, 2);
  assert.deepEqual(auth, { tokens: 0, failed_attempts: 3, succeeded_attempts: 2 });
});

test("expire_tokens のあと、そのトークンで /save_emotion.php が 401", async () => {
  const pw = randomValue();
  fixture([{ op: "add_employee", code: "E001", department: "営業部", pw }]);
  const token = await loginAs("E001", pw);

  // 切る前は使える（このテストが、何もせずに通っていないことの確認）
  const beforeExpire = await api("POST", "/save_emotion.php", { body: { emotion: "normal" }, token });
  assert.equal(beforeExpire.status, 200);

  const [expired, auth] = fixture([
    { op: "expire_tokens", code: "E001" },
    { op: "read_auth", code: "E001" },
  ]);
  assert.equal(expired.count, 1);
  // 期限を切るだけで、行は消さない
  assert.equal(auth.tokens, 1);

  const afterExpire = await api("POST", "/save_emotion.php", { body: { emotion: "normal" }, token });
  assert.equal(afterExpire.status, 401);
});
