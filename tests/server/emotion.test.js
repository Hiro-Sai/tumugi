"use strict";
// 5.4 感情ログ（save_emotion.php）
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
} = require("./helpers");

before(ensureEnvironment);
beforeEach(resetDb);

// 社員を1人入れてログインし、{ code, pw, token } を返す
async function setupEmployee(extra = {}) {
  const pw = randomValue();
  fixture([{ op: "add_employee", code: "E001", department: "営業部", pw, ...extra }]);
  const token = await loginAs("E001", pw);
  return { code: "E001", pw, token };
}

function save(token, body) {
  return api("POST", "/save_emotion.php", { body, token });
}

function readLogs(code = "E001") {
  return fixture([{ op: "read_logs", code }])[0];
}

test("トークンがないと 401（記録は増えない）", async () => {
  await setupEmployee();
  const res = await save(undefined, { emotion: "normal" });
  assert.equal(res.status, 401);
  assert.equal(readLogs().length, 0);
});

test("期限の切れたトークンも 401（記録は増えない）", async () => {
  const { token } = await setupEmployee();
  fixture([{ op: "expire_tokens", code: "E001" }]);
  const res = await save(token, { emotion: "normal" });
  assert.equal(res.status, 401);
  assert.equal(readLogs().length, 0);
});

test("知らないトークンは 401", async () => {
  await setupEmployee();
  const res = await save(randomValue(64), { emotion: "normal" });
  assert.equal(res.status, 401);
  assert.equal(readLogs().length, 0);
});

test("仮のパスワードのままの社員は 401（記録は増えない）", async () => {
  const { token } = await setupEmployee({ must_change: true });
  const res = await save(token, { emotion: "normal" });
  assert.equal(res.status, 401);
  assert.equal(readLogs().length, 0);
});

test("退職にした社員のトークンは 401（記録は増えない）", async () => {
  const { token } = await setupEmployee();
  // 退職にする前は使える
  const ok = await save(token, { emotion: "normal" });
  assert.equal(ok.status, 200);

  // トークンの行は残したまま、退職にだけする（is_active の条件そのものを確かめる）
  fixture([{ op: "set_active", code: "E001", is_active: false }]);
  const [auth] = fixture([{ op: "read_auth", code: "E001" }]);
  assert.equal(auth.tokens, 1);

  const res = await save(token, { emotion: "normal" });
  assert.equal(res.status, 401);
  // 退職前の1行だけが残っている
  assert.equal(readLogs().length, 1);
});

test("感情ごとのスコア：happy 0・normal 10・tired 50・angry 50・anxious 60・sad 70", async () => {
  const { token } = await setupEmployee();
  const table = [
    ["happy", 0],
    ["normal", 10],
    ["tired", 50],
    ["angry", 50],
    ["anxious", 60],
    ["sad", 70],
  ];
  for (const [emotion, score] of table) {
    const res = await save(token, { emotion });
    assert.equal(res.status, 200, emotion);
    assert.deepEqual(res.json, { status: "ok", recorded_score: score }, emotion);
  }
  // DB に保存された値も、同じ順で同じ
  const logs = readLogs();
  assert.deepEqual(
    logs.map((row) => [row.emotion, row.negativity_score]),
    table
  );
});

test("is_crisis が true なら、感情が何でもスコアは 100", async () => {
  const { token } = await setupEmployee();
  const emotions = ["happy", "normal", "tired", "angry", "anxious", "sad"];
  for (const emotion of emotions) {
    const res = await save(token, { emotion, is_crisis: true });
    assert.equal(res.status, 200, emotion);
    assert.deepEqual(res.json, { status: "ok", recorded_score: 100 }, emotion);
  }
  const logs = readLogs();
  assert.equal(logs.length, emotions.length);
  for (const row of logs) {
    assert.equal(row.negativity_score, 100);
    assert.equal(row.is_crisis, 1);
  }
  // 感情そのものは、そのまま保存される
  assert.deepEqual(
    logs.map((row) => row.emotion),
    emotions
  );
});

test("知らない emotion は 400（記録は増えない）", async () => {
  const { token } = await setupEmployee();
  const res = await save(token, { emotion: "excited" });
  assert.equal(res.status, 400);
  assert.equal(typeof res.json.error, "string");
  assert.equal(readLogs().length, 0);
});

test("前の分類の surprised・troubled も 400（記録は増えない）", async () => {
  const { token } = await setupEmployee();
  for (const emotion of ["surprised", "troubled"]) {
    const res = await save(token, { emotion });
    assert.equal(res.status, 400, emotion);
  }
  assert.equal(readLogs().length, 0);
});

test("知らない harassment_type は 400（emotion は正しく送る。記録は増えない）", async () => {
  const { token } = await setupEmployee();
  const res = await save(token, { emotion: "normal", harassment_type: "other" });
  assert.equal(res.status, 400);
  assert.equal(typeof res.json.error, "string");
  assert.equal(readLogs().length, 0);
});

test("記録は、その社員の行として1行増える。感情・スコア・危機・ハラスメントが保存される", async () => {
  const { token } = await setupEmployee();
  // 別の社員の行は増えない
  fixture([{ op: "add_employee", code: "E002", department: "営業部", pw: randomValue() }]);

  const res = await save(token, { emotion: "sad", is_crisis: true, harassment_type: "received" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { status: "ok", recorded_score: 100 });

  const logs = readLogs();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].emotion, "sad");
  assert.equal(logs[0].negativity_score, 100);
  assert.equal(logs[0].is_crisis, 1);
  assert.equal(logs[0].harassment_type, "received");
  // 今の時刻で入っている（DB の時計で測った経過秒）
  assert.ok(Math.abs(logs[0].age_seconds) < 300);
  assert.equal(readLogs("E002").length, 0);

  // 危機でない・ハラスメントなしの記録も、続けて1行増える
  const second = await save(token, { emotion: "happy", harassment_type: "said" });
  assert.equal(second.status, 200);
  const after = readLogs();
  assert.equal(after.length, 2);
  assert.equal(after[1].emotion, "happy");
  assert.equal(after[1].negativity_score, 0);
  assert.equal(after[1].is_crisis, 0);
  assert.equal(after[1].harassment_type, "said");
});

test("is_crisis と harassment_type を付けない記録は、危機なし・ハラスメントなしで保存される", async () => {
  const { token } = await setupEmployee();
  const res = await save(token, { emotion: "tired" });
  assert.equal(res.status, 200);
  const logs = readLogs();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].is_crisis, 0);
  assert.equal(logs[0].harassment_type, "none");
});

test("記録に、その時点の部署と新卒の印が入る", async () => {
  const { token } = await setupEmployee({ is_new_grad: true });
  const res = await save(token, { emotion: "normal" });
  assert.equal(res.status, 200);
  const logs = readLogs();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].department, "営業部");
  assert.equal(logs[0].is_new_grad, 1);
  assert.equal(logs[0].is_counted, 1);
});

test("部署を変えたあとの記録には、新しい部署が入る。前の記録は変わらない", async () => {
  const { token } = await setupEmployee();
  const admin = seedAdmin("A001");
  const adminToken = await loginAs("A001", admin.pw);

  assert.equal((await save(token, { emotion: "normal" })).status, 200);

  const update = await api("POST", "/admin_employee_update.php", {
    body: {
      employee_code: "E001",
      display_name: "テストE001",
      department: "開発部",
      is_new_grad: false,
      is_admin: false,
    },
    token: adminToken,
  });
  assert.equal(update.status, 200);

  assert.equal((await save(token, { emotion: "normal" })).status, 200);

  const logs = readLogs();
  assert.equal(logs.length, 2);
  assert.equal(logs[0].department, "営業部");
  assert.equal(logs[1].department, "開発部");
});

test("集計に入れ始める時刻から6日の社員の記録は is_counted が 0、8日なら 1", async () => {
  const six = await setupEmployee({ counted_days_ago: 6 });
  const resSix = await save(six.token, { emotion: "normal" });
  assert.equal(resSix.status, 200);
  const logsSix = readLogs("E001");
  assert.equal(logsSix.length, 1);
  assert.equal(logsSix[0].is_counted, 0);

  const pwEight = randomValue();
  fixture([
    { op: "add_employee", code: "E002", department: "営業部", pw: pwEight, counted_days_ago: 8 },
  ]);
  const tokenEight = await loginAs("E002", pwEight);
  const resEight = await save(tokenEight, { emotion: "normal" });
  assert.equal(resEight.status, 200);
  const logsEight = readLogs("E002");
  assert.equal(logsEight.length, 1);
  assert.equal(logsEight[0].is_counted, 1);
});

test("管理者の記録は、is_counted が 0", async () => {
  const admin = seedAdmin("A001");
  const token = await loginAs("A001", admin.pw);
  const res = await save(token, { emotion: "normal" });
  assert.equal(res.status, 200);
  const logs = readLogs("A001");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].is_counted, 0);
});
