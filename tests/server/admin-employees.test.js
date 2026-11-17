"use strict";
// 5.8 登録・5.9 修正・5.10 退職/在籍・5.11 リセット・5.12 削除
// （admin_employee_create / update / status / reset / delete .php）
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

// ---------- 道具 ----------

// 管理者 A001 を入れてログインする → { token }
async function setupAdmin() {
  const admin = seedAdmin("A001");
  const token = await loginAs("A001", admin.pw);
  return { token };
}

// 一般の社員を1人入れる → パスワード
function addEmployee(code, extra = {}) {
  const pw = randomValue();
  fixture([{ op: "add_employee", code, department: "営業部", pw, ...extra }]);
  return pw;
}

function post(path, body, token) {
  return api("POST", path, { body, token });
}

function login(code, pw) {
  return api("POST", "/login.php", { body: { employee_code: code, password: pw } });
}

const readEmployee = (code) => fixture([{ op: "read_employee", code }])[0];
const readAuth = (code) => fixture([{ op: "read_auth", code }])[0];
const readAudit = () => fixture([{ op: "read_audit" }])[0];
const readCounts = () => fixture([{ op: "read_counts" }])[0];

function createBody(over = {}) {
  return {
    employee_code: "E100",
    display_name: "新入 太郎",
    department: "営業部",
    is_new_grad: false,
    is_admin: false,
    ...over,
  };
}

function updateBody(over = {}) {
  return {
    employee_code: "E001",
    display_name: "テストE001",
    department: "営業部",
    is_new_grad: false,
    is_admin: false,
    ...over,
  };
}

const create = (token, over) => post("/admin_employee_create.php", createBody(over), token);
const update = (token, over) => post("/admin_employee_update.php", updateBody(over), token);
const setStatus = (token, code, isActive) =>
  post("/admin_employee_status.php", { employee_code: code, is_active: isActive }, token);
const reset = (token, code) => post("/admin_employee_reset.php", { employee_code: code }, token);
const remove = (token, code, confirmCode) =>
  post("/admin_employee_delete.php", { employee_code: code, confirm_code: confirmCode }, token);

// ---------- 5.8 社員の登録 ----------

test("登録：成功で 12文字の temp_password が返る。仮のパスワードの状態で、ログインできる", async () => {
  const { token } = await setupAdmin();
  const res = await create(token);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ["employee_code", "status", "temp_password"]);
  assert.equal(res.json.status, "ok");
  assert.equal(res.json.employee_code, "E100");
  const temp = res.json.temp_password;
  assert.match(temp, /^[A-Za-z0-9]{12}$/);

  const row = readEmployee("E100");
  assert.equal(row.display_name, "新入 太郎");
  assert.equal(row.department, "営業部");
  assert.equal(row.is_active, 1);
  assert.equal(row.is_new_grad, 0);
  assert.equal(row.is_admin, 0);
  assert.equal(row.must_change_password, 1);

  const loginRes = await login("E100", temp);
  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.json.must_change_password, true);
});

test("登録：新卒・管理者の印が、そのまま入る", async () => {
  const { token } = await setupAdmin();
  const res = await create(token, { is_new_grad: true, is_admin: true });
  assert.equal(res.status, 200);
  const row = readEmployee("E100");
  assert.equal(row.is_new_grad, 1);
  assert.equal(row.is_admin, 1);
});

test("登録：集計に入れ始める時刻は、登録した時刻（今）になる", async () => {
  const { token } = await setupAdmin();
  const res = await create(token);
  assert.equal(res.status, 200);
  const [seconds] = fixture([{ op: "read_counted", code: "E100" }]);
  assert.ok(seconds >= 0 && seconds < 60, `seconds=${seconds}`);
});

test("登録：同じ社員IDは 409。大文字・小文字だけが違う社員IDも 409", async () => {
  const { token } = await setupAdmin();
  const first = await create(token);
  assert.equal(first.status, 200);
  const afterFirst = readCounts();

  const same = await create(token);
  assert.equal(same.status, 409);
  const lower = await create(token, { employee_code: "e100" });
  assert.equal(lower.status, 409);

  // 増えていない（社員も、操作の記録も）
  const after = readCounts();
  assert.equal(after.employees, afterFirst.employees);
  assert.equal(after.admin_audit_logs, afterFirst.admin_audit_logs);
  assert.equal(readEmployee("E100").employee_code, "E100");
});

test("登録：社員IDの形が違うと 400（21文字、記号、空）", async () => {
  const { token } = await setupAdmin();
  const before = readCounts();
  const badCodes = ["E".repeat(21), "E@01", "E 01", "", "社員01"];
  for (const code of badCodes) {
    const res = await create(token, { employee_code: code });
    assert.equal(res.status, 400, `社員ID「${code}」`);
  }
  // 20文字ちょうどは通る（ほかの項目は正しいので、400 の理由が社員IDの形だと分かる）
  const ok = await create(token, { employee_code: "E".repeat(20) });
  assert.equal(ok.status, 200);

  const after = readCounts();
  assert.equal(after.employees, before.employees + 1);
  assert.equal(after.admin_audit_logs, before.admin_audit_logs + 1);
});

test("登録：社員ID「CLI」は、大文字でも小文字でも 400", async () => {
  const { token } = await setupAdmin();
  const before = readCounts();
  for (const code of ["CLI", "cli", "Cli"]) {
    const res = await create(token, { employee_code: code });
    assert.equal(res.status, 400, `社員ID「${code}」`);
  }
  assert.equal(readEmployee("CLI"), null);
  assert.deepEqual(readCounts(), before);

  // 形が同じでも、CLI でなければ通る（400 の理由が予約の社員IDだと分かる）
  const ok = await create(token, { employee_code: "CLIX" });
  assert.equal(ok.status, 200);
});

test("登録：名前・部署が空、または51文字だと 400。50文字は通る", async () => {
  const { token } = await setupAdmin();
  const before = readCounts();
  const long = "あ".repeat(51);
  const cases = [
    { display_name: "" },
    { display_name: "　 " }, // 空白（全角を含む）だけ
    { display_name: long },
    { department: "" },
    { department: "　 " },
    { department: long },
  ];
  for (const over of cases) {
    const res = await create(token, over);
    assert.equal(res.status, 400, JSON.stringify(over).slice(0, 40));
  }
  assert.deepEqual(readCounts(), before);

  const fifty = "あ".repeat(50);
  const ok = await create(token, { display_name: fifty, department: fifty });
  assert.equal(ok.status, 200);
  const row = readEmployee("E100");
  assert.equal(row.display_name, fifty);
  assert.equal(row.department, fifty);
});

test("登録：is_new_grad・is_admin が true/false でないと 400", async () => {
  const { token } = await setupAdmin();
  const before = readCounts();
  const cases = [
    { is_new_grad: "true" },
    { is_new_grad: 1 },
    { is_new_grad: null },
    { is_admin: "false" },
    { is_admin: 0 },
    { is_admin: null },
  ];
  for (const over of cases) {
    const res = await create(token, over);
    assert.equal(res.status, 400, JSON.stringify(over));
  }
  // 送り忘れ（キーがない）も 400
  const noGrad = createBody();
  delete noGrad.is_new_grad;
  assert.equal((await post("/admin_employee_create.php", noGrad, token)).status, 400);
  const noAdmin = createBody();
  delete noAdmin.is_admin;
  assert.equal((await post("/admin_employee_create.php", noAdmin, token)).status, 400);

  assert.deepEqual(readCounts(), before);
});

test("登録：操作の記録に create が1行増える", async () => {
  const { token } = await setupAdmin();
  assert.equal(readAudit().length, 0);
  const res = await create(token);
  assert.equal(res.status, 200);
  const audit = readAudit();
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0], {
    admin_code: "A001",
    action: "create",
    target_code: "E100",
    detail: null,
  });
  // 仮のパスワードは、記録に入らない
  assert.ok(!JSON.stringify(audit).includes(res.json.temp_password));
});

// ---------- 5.9 社員の修正 ----------

test("修正：部署と新卒の印を変えられる。操作の記録の detail は変えた項目の名前", async () => {
  const { token } = await setupAdmin();
  addEmployee("E001");
  const res = await update(token, { department: "開発部", is_new_grad: true });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { status: "ok" });

  const row = readEmployee("E001");
  assert.equal(row.department, "開発部");
  assert.equal(row.is_new_grad, 1);
  assert.equal(row.display_name, "テストE001");
  assert.equal(row.is_admin, 0);

  const audit = readAudit();
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0], {
    admin_code: "A001",
    action: "update",
    target_code: "E001",
    detail: "department,is_new_grad",
  });
});

test("修正：4つとも変えると、detail は display_name,department,is_new_grad,is_admin の順", async () => {
  const { token } = await setupAdmin();
  addEmployee("E001");
  const res = await update(token, {
    display_name: "新しい名前",
    department: "開発部",
    is_new_grad: true,
    is_admin: true,
  });
  assert.equal(res.status, 200);
  const row = readEmployee("E001");
  assert.equal(row.display_name, "新しい名前");
  assert.equal(row.is_admin, 1);
  const audit = readAudit();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].detail, "display_name,department,is_new_grad,is_admin");
});

test("修正：何も変わらないときは 200 で、操作の記録は増えない", async () => {
  const { token } = await setupAdmin();
  addEmployee("E001");
  const beforeCounts = readCounts();
  const beforeRow = readEmployee("E001");

  const res = await update(token);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { status: "ok" });
  assert.deepEqual(readEmployee("E001"), beforeRow);
  assert.deepEqual(readCounts(), beforeCounts);
  assert.equal(readAudit().length, 0);
});

test("修正：いない社員は 404（名前・部署・新卒・管理者も付けて送る）", async () => {
  const { token } = await setupAdmin();
  const before = readCounts();
  const res = await update(token, { employee_code: "E999" });
  assert.equal(res.status, 404);
  assert.deepEqual(readCounts(), before);
});

test("修正：自分を管理者から外すのは 400。管理者のまま変わらない", async () => {
  const { token } = await setupAdmin();
  // 管理者が2人いても、自分を外すのは止める（人数の守りではなく、自分への守り）
  const other = randomValue();
  fixture([{ op: "add_employee", code: "A002", department: "管理部", pw: other, is_admin: true }]);
  const res = await update(token, {
    employee_code: "A001",
    display_name: "テストA001",
    department: "管理部",
    is_admin: false,
  });
  assert.equal(res.status, 400);
  assert.equal(readEmployee("A001").is_admin, 1);
  assert.equal(readAudit().length, 0);

  // 自分の名前・部署は直せる（400 の理由が「管理者を外す」だと分かる）
  const ok = await update(token, {
    employee_code: "A001",
    display_name: "テストA001",
    department: "経営部",
    is_admin: true,
  });
  assert.equal(ok.status, 200);
  assert.equal(readEmployee("A001").department, "経営部");
});

test("修正：管理者の印を外すと、集計に入れ始める時刻が今になる。付けたとき・部署だけを変えたときは動かない", async () => {
  const { token } = await setupAdmin();
  const other = randomValue();
  fixture([{ op: "add_employee", code: "A002", department: "管理部", pw: other, is_admin: true, counted_days_ago: 30 }]);
  addEmployee("E001", { counted_days_ago: 30 });
  addEmployee("E002", { counted_days_ago: 30 });
  const MONTH_AGO = 29 * 24 * 60 * 60;
  const seconds = (code) => fixture([{ op: "read_counted", code }])[0];

  // 付けたとき：動かない
  assert.equal((await update(token, { is_admin: true })).status, 200);
  assert.equal(readEmployee("E001").is_admin, 1);
  assert.ok(seconds("E001") > MONTH_AGO);

  // 部署だけを変えたとき：動かない
  assert.equal((await update(token, { employee_code: "E002", department: "開発部" })).status, 200);
  assert.ok(seconds("E002") > MONTH_AGO);

  // 外したとき：今になる
  const res = await update(token, {
    employee_code: "A002",
    display_name: "テストA002",
    department: "管理部",
    is_admin: false,
  });
  assert.equal(res.status, 200);
  assert.equal(readEmployee("A002").is_admin, 0);
  const afterRevoke = seconds("A002");
  assert.ok(afterRevoke >= 0 && afterRevoke < 60, `afterRevoke=${afterRevoke}`);
});

test("修正：ほかの管理者を、管理者から外せる（管理者が2人いるとき）", async () => {
  const { token } = await setupAdmin();
  const other = randomValue();
  fixture([{ op: "add_employee", code: "A002", department: "管理部", pw: other, is_admin: true }]);
  const res = await update(token, {
    employee_code: "A002",
    display_name: "テストA002",
    department: "管理部",
    is_admin: false,
  });
  assert.equal(res.status, 200);
  assert.equal(readEmployee("A002").is_admin, 0);
  const audit = readAudit();
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0], {
    admin_code: "A001",
    action: "update",
    target_code: "A002",
    detail: "is_admin",
  });
});

test("修正：is_new_grad・is_admin が true/false でないと 400", async () => {
  const { token } = await setupAdmin();
  addEmployee("E001");
  const before = readEmployee("E001");
  // 部署も変えて送る。守りが効かなければ、部署が変わって分かる
  const cases = [
    { is_new_grad: "true" },
    { is_new_grad: 1 },
    { is_new_grad: null },
    { is_admin: "true" },
    { is_admin: 1 },
    { is_admin: null },
  ];
  for (const over of cases) {
    const res = await update(token, { department: "開発部", ...over });
    assert.equal(res.status, 400, JSON.stringify(over));
  }
  // 送り忘れ（キーがない）も 400
  const noGrad = updateBody({ department: "開発部" });
  delete noGrad.is_new_grad;
  assert.equal((await post("/admin_employee_update.php", noGrad, token)).status, 400);
  const noAdmin = updateBody({ department: "開発部" });
  delete noAdmin.is_admin;
  assert.equal((await post("/admin_employee_update.php", noAdmin, token)).status, 400);

  assert.deepEqual(readEmployee("E001"), before);
  assert.equal(readAudit().length, 0);
});

// ---------- 5.10 退職・在籍 ----------

test("退職：トークンは使えなくなり、ログインもできない。トークンの行が消える。記録は deactivate", async () => {
  const { token } = await setupAdmin();
  const pw = addEmployee("E001");
  const empToken = await loginAs("E001", pw);
  assert.equal(readAuth("E001").tokens, 1);

  const res = await setStatus(token, "E001", false);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { status: "ok" });

  assert.equal(readEmployee("E001").is_active, 0);
  assert.equal(readAuth("E001").tokens, 0);
  const used = await api("POST", "/save_emotion.php", { body: { emotion: "normal" }, token: empToken });
  assert.equal(used.status, 401);
  assert.equal((await login("E001", pw)).status, 401);

  const audit = readAudit();
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0], {
    admin_code: "A001",
    action: "deactivate",
    target_code: "E001",
    detail: null,
  });
});

test("在籍に戻すと、集計に入れ始める時刻が今になる。退職にしただけ・すでに在籍の社員を戻したときは動かない", async () => {
  const { token } = await setupAdmin();
  addEmployee("E001", { is_active: false, counted_days_ago: 30 });
  addEmployee("E002", { counted_days_ago: 30 });
  addEmployee("E003", { counted_days_ago: 30 });
  const MONTH_AGO = 29 * 24 * 60 * 60;
  const seconds = (code) => fixture([{ op: "read_counted", code }])[0];

  // 退職にしただけ：動かない
  assert.equal((await setStatus(token, "E002", false)).status, 200);
  assert.ok(seconds("E002") > MONTH_AGO);

  // すでに在籍の社員を在籍に戻す：動かない
  assert.equal((await setStatus(token, "E003", true)).status, 200);
  assert.ok(seconds("E003") > MONTH_AGO);

  // 退職から在籍に戻す：今になる
  assert.ok(seconds("E001") > MONTH_AGO);
  assert.equal((await setStatus(token, "E001", true)).status, 200);
  const afterReactivate = seconds("E001");
  assert.ok(afterReactivate >= 0 && afterReactivate < 60, `afterReactivate=${afterReactivate}`);
});

test("在籍に戻す：ログインできる（パスワードは変わらない）。記録は reactivate", async () => {
  const { token } = await setupAdmin();
  const pw = addEmployee("E001", { is_active: false });
  assert.equal((await login("E001", pw)).status, 401);

  const res = await setStatus(token, "E001", true);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { status: "ok" });
  assert.equal(readEmployee("E001").is_active, 1);
  assert.equal((await login("E001", pw)).status, 200);

  const audit = readAudit();
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0], {
    admin_code: "A001",
    action: "reactivate",
    target_code: "E001",
    detail: null,
  });
});

test("退職：自分を退職にするのは 400。在籍のまま変わらない", async () => {
  const { token } = await setupAdmin();
  // 管理者が2人いても、自分を退職にするのは止める（人数の守りではなく、自分への守り）
  const other = randomValue();
  fixture([{ op: "add_employee", code: "A002", department: "管理部", pw: other, is_admin: true }]);
  const before = readCounts();
  const res = await setStatus(token, "A001", false);
  assert.equal(res.status, 400);
  assert.equal(readEmployee("A001").is_active, 1);
  assert.equal(readAuth("A001").tokens, 1);
  assert.equal(readCounts().admin_audit_logs, before.admin_audit_logs);
  assert.equal(readAudit().length, 0);
});

test("退職：すでに退職の社員を退職にしても 200 で、記録は増えない（何も書き込まない）", async () => {
  const { token } = await setupAdmin();
  const pw = addEmployee("E001");
  await loginAs("E001", pw);
  // トークンの行は残したまま、退職にする
  fixture([{ op: "set_active", code: "E001", is_active: false }]);
  const beforeCounts = readCounts();
  assert.equal(readAuth("E001").tokens, 1);

  const res = await setStatus(token, "E001", false);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { status: "ok" });
  assert.deepEqual(readCounts(), beforeCounts);
  assert.equal(readAudit().length, 0);
  // トークンの行を消す処理も走っていない
  assert.equal(readAuth("E001").tokens, 1);
});

test("在籍：すでに在籍の社員を在籍に戻しても 200 で、記録は増えない", async () => {
  const { token } = await setupAdmin();
  addEmployee("E001");
  const beforeCounts = readCounts();

  const res = await setStatus(token, "E001", true);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { status: "ok" });
  assert.deepEqual(readCounts(), beforeCounts);
  assert.equal(readAudit().length, 0);
  assert.equal(readEmployee("E001").is_active, 1);
});

test("退職・在籍：is_active が true/false でないと 400。何も変わらない", async () => {
  const { token } = await setupAdmin();
  addEmployee("E001"); // 在籍中。守りが効かず false と読まれれば、退職になって分かる
  const beforeCounts = readCounts();
  const cases = [{ is_active: "false" }, { is_active: 0 }, { is_active: null }, {}];
  for (const extra of cases) {
    const res = await post("/admin_employee_status.php", { employee_code: "E001", ...extra }, token);
    assert.equal(res.status, 400, JSON.stringify(extra));
  }
  assert.equal(readEmployee("E001").is_active, 1);
  assert.deepEqual(readCounts(), beforeCounts);
});

test("退職・在籍：いない社員は 404（is_active も付けて送る）", async () => {
  const { token } = await setupAdmin();
  const before = readCounts();
  assert.equal((await setStatus(token, "E999", false)).status, 404);
  assert.equal((await setStatus(token, "E999", true)).status, 404);
  assert.deepEqual(readCounts(), before);
});

// ---------- 5.11 リセット ----------

test("リセット：temp_password が返る。古いパスワードではログインできず、仮のパスワードでできる", async () => {
  const { token } = await setupAdmin();
  const pw = addEmployee("E001");
  assert.equal(readEmployee("E001").must_change_password, 0);

  const res = await reset(token, "E001");
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ["status", "temp_password"]);
  assert.equal(res.json.status, "ok");
  const temp = res.json.temp_password;
  assert.match(temp, /^[A-Za-z0-9]{12}$/);
  assert.equal(readEmployee("E001").must_change_password, 1);

  const withTemp = await login("E001", temp);
  assert.equal(withTemp.status, 200);
  assert.equal(withTemp.json.must_change_password, true);
  assert.equal((await login("E001", pw)).status, 401);
});

test("リセット：トークンと失敗の行が消え、成功の行は残る。ロック中でもログインできる。記録は reset_password", async () => {
  const { token } = await setupAdmin();
  const pw = addEmployee("E001");
  const empToken = await loginAs("E001", pw); // トークン1つ、成功1回
  fixture([{ op: "add_attempts", code: "E001", count: 5, succeeded: false, minutes_ago: 1 }]);
  assert.deepEqual(readAuth("E001"), { tokens: 1, failed_attempts: 5, succeeded_attempts: 1 });
  // リセット前は、正しいパスワードでもロックされている
  assert.equal((await login("E001", pw)).status, 429);

  const res = await reset(token, "E001");
  assert.equal(res.status, 200);
  const temp = res.json.temp_password;

  assert.deepEqual(readAuth("E001"), { tokens: 0, failed_attempts: 0, succeeded_attempts: 1 });
  const used = await api("POST", "/save_emotion.php", { body: { emotion: "normal" }, token: empToken });
  assert.equal(used.status, 401);
  // ロックが解けて、仮のパスワードですぐログインできる
  assert.equal((await login("E001", temp)).status, 200);

  const audit = readAudit();
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0], {
    admin_code: "A001",
    action: "reset_password",
    target_code: "E001",
    detail: null,
  });
  // 仮のパスワードは、記録に入らない
  assert.ok(!JSON.stringify(audit).includes(temp));
});

test("リセット：自分は 400。パスワードも記録も変わらない", async () => {
  const admin = seedAdmin("A001");
  const token = await loginAs("A001", admin.pw);
  const res = await reset(token, "A001");
  assert.equal(res.status, 400);
  assert.equal(readEmployee("A001").must_change_password, 0);
  assert.equal(readAuth("A001").tokens, 1);
  assert.equal(readAudit().length, 0);
  // 古いパスワードのまま
  assert.equal((await login("A001", admin.pw)).status, 200);
});

test("リセット：いない社員は 404", async () => {
  const { token } = await setupAdmin();
  const before = readCounts();
  const res = await reset(token, "E999");
  assert.equal(res.status, 404);
  assert.deepEqual(readCounts(), before);
});

// ---------- 5.12 削除 ----------

test("削除：在籍中の社員は 400。退職にすれば同じ呼び方で消せる", async () => {
  const { token } = await setupAdmin();
  addEmployee("E001");
  // 確かめの社員IDは正しく送る
  const res = await remove(token, "E001", "E001");
  assert.equal(res.status, 400);
  assert.notEqual(readEmployee("E001"), null);
  assert.equal(readAudit().length, 0);

  // 退職にすると、同じ呼び方が通る（400 の理由が「在籍中」だと分かる）
  fixture([{ op: "set_active", code: "E001", is_active: false }]);
  const ok = await remove(token, "E001", "E001");
  assert.equal(ok.status, 200);
  assert.equal(readEmployee("E001"), null);
});

test("削除：確かめの社員IDが違うと 400（大文字・小文字も区別する）", async () => {
  const { token } = await setupAdmin();
  addEmployee("E001", { is_active: false });
  addEmployee("E002", { is_active: false });
  const before = readCounts();

  for (const confirm of ["e001", "E002", "E00", "E0011", ""]) {
    const res = await remove(token, "E001", confirm);
    assert.equal(res.status, 400, `確かめ「${confirm}」`);
  }
  // 確かめの社員IDなし（キーがない）も 400
  const noConfirm = await post("/admin_employee_delete.php", { employee_code: "E001" }, token);
  assert.equal(noConfirm.status, 400);

  assert.notEqual(readEmployee("E001"), null);
  assert.deepEqual(readCounts(), before);

  // 正しい確かめなら通る（400 の理由が確かめの不一致だと分かる）
  const ok = await remove(token, "E001", "E001");
  assert.equal(ok.status, 200);
  assert.equal(readEmployee("E001"), null);
});

test("削除：成功で一覧から消え、感情ログとログインの試行も消える。記録は delete", async () => {
  const { token } = await setupAdmin();
  const pw = addEmployee("E001");
  addEmployee("E002");
  await loginAs("E001", pw); // トークン1つ、成功1回
  fixture([
    { op: "add_logs", code: "E001", logs: [{ emotion: "tired", score: 50, days_ago: 8 }, { emotion: "sad", score: 70, days_ago: 9 }] },
    { op: "add_attempts", code: "E001", count: 2, succeeded: false, minutes_ago: 1 },
    { op: "set_active", code: "E001", is_active: false },
    // 消えてはいけない、ほかの社員の分
    { op: "add_logs", code: "E002", logs: [{ emotion: "normal", score: 10 }] },
    { op: "add_attempts", code: "E002", count: 1, succeeded: false, minutes_ago: 1 },
  ]);
  const [logsBefore, authBefore] = fixture([
    { op: "read_logs", code: "E001" },
    { op: "read_auth", code: "E001" },
  ]);
  assert.equal(logsBefore.length, 2);
  assert.deepEqual(authBefore, { tokens: 1, failed_attempts: 2, succeeded_attempts: 1 });

  const res = await remove(token, "E001", "E001");
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { status: "ok" });

  assert.equal(readEmployee("E001"), null);
  // 下の read_logs・read_auth は社員の行を通して数えるので、社員が消えると、行が残っていても 0 になる。
  // 行そのものが消えたことは、テーブルの行の数で確かめる（残るのは、E002 のログ1行と、管理者のトークン1つ）
  const counts = readCounts();
  assert.equal(counts.emotion_logs, 1);
  assert.equal(counts.auth_tokens, 1);
  const [logsAfter, authAfter, otherLogs, otherAuth] = fixture([
    { op: "read_logs", code: "E001" },
    { op: "read_auth", code: "E001" },
    { op: "read_logs", code: "E002" },
    { op: "read_auth", code: "E002" },
  ]);
  assert.deepEqual(logsAfter, []);
  assert.deepEqual(authAfter, { tokens: 0, failed_attempts: 0, succeeded_attempts: 0 });
  // ほかの社員の分は残る
  assert.equal(otherLogs.length, 1);
  assert.equal(otherAuth.failed_attempts, 1);

  // 一覧から消えている
  const list = await api("GET", "/admin_employees.php", { token });
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.json.employees.map((e) => e.employee_code),
    ["A001", "E002"]
  );

  // 社員を消しても、操作の記録は残る
  const audit = readAudit();
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0], {
    admin_code: "A001",
    action: "delete",
    target_code: "E001",
    detail: null,
  });
});

test("削除：直近7日に記録がある退職者は 400。社員も記録も残り、操作の記録は増えない", async () => {
  const { token } = await setupAdmin();
  addEmployee("E001");
  fixture([
    { op: "add_logs", code: "E001", logs: [{ emotion: "tired", score: 50, days_ago: 6 }] },
    { op: "set_active", code: "E001", is_active: false },
  ]);
  const before = readCounts();

  const res = await remove(token, "E001", "E001");
  assert.equal(res.status, 400);
  assert.ok(res.json.error.includes("直近7日間に感情記録がある"));
  assert.notEqual(readEmployee("E001"), null);
  const [logs] = fixture([{ op: "read_logs", code: "E001" }]);
  assert.equal(logs.length, 1);
  assert.deepEqual(readCounts(), before);
  assert.equal(readAudit().length, 0);
});

test("削除：記録が8日前だけなら消せる", async () => {
  const { token } = await setupAdmin();
  addEmployee("E001");
  fixture([
    { op: "add_logs", code: "E001", logs: [{ emotion: "tired", score: 50, days_ago: 8 }] },
    { op: "set_active", code: "E001", is_active: false },
  ]);

  const res = await remove(token, "E001", "E001");
  assert.equal(res.status, 200);
  assert.equal(readEmployee("E001"), null);
  assert.equal(readCounts().emotion_logs, 0);
});

test("削除：管理者だった社員の記録（is_counted が 0）でも、直近7日にあれば 400", async () => {
  const { token } = await setupAdmin();
  addEmployee("E001");
  fixture([
    { op: "add_logs", code: "E001", logs: [{ emotion: "tired", score: 50, days_ago: 3, is_counted: false }] },
    { op: "set_active", code: "E001", is_active: false },
  ]);

  const res = await remove(token, "E001", "E001");
  assert.equal(res.status, 400);
  assert.ok(res.json.error.includes("直近7日間に感情記録がある"));
  assert.notEqual(readEmployee("E001"), null);
  assert.equal(readAudit().length, 0);
});

test("削除：自分は 400。消えない", async () => {
  const { token } = await setupAdmin();
  const res = await remove(token, "A001", "A001");
  assert.equal(res.status, 400);
  // 在籍中の 400 と区別するため、自分への操作の文であることも見る
  assert.ok(res.json.error.includes("自分自身"));
  assert.notEqual(readEmployee("A001"), null);
  assert.equal(readAudit().length, 0);
});

test("削除：いない社員は 404", async () => {
  const { token } = await setupAdmin();
  const before = readCounts();
  const res = await remove(token, "E999", "E999");
  assert.equal(res.status, 404);
  assert.deepEqual(readCounts(), before);
});
