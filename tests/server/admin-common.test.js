"use strict";
// 5.1 共通（管理者用の API の入口の確かめ）と 5.7 社員の一覧（admin_employees.php）
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

// 管理者用の API（7本）。body は、入口を通ってしまったら何かが変わる形にしておく
const ADMIN_APIS = [
  { path: "/admin_employees.php", method: "GET", wrongMethod: "POST" },
  {
    path: "/admin_employee_create.php",
    method: "POST",
    wrongMethod: "GET",
    body: {
      employee_code: "Z900",
      display_name: "確認用",
      department: "営業部",
      is_new_grad: false,
      is_admin: false,
    },
  },
  {
    path: "/admin_employee_update.php",
    method: "POST",
    wrongMethod: "GET",
    body: {
      employee_code: "E002",
      display_name: "テストE002",
      department: "開発部",
      is_new_grad: false,
      is_admin: false,
    },
  },
  {
    path: "/admin_employee_status.php",
    method: "POST",
    wrongMethod: "GET",
    body: { employee_code: "E002", is_active: false },
  },
  {
    path: "/admin_employee_reset.php",
    method: "POST",
    wrongMethod: "GET",
    body: { employee_code: "E002" },
  },
  {
    path: "/admin_employee_delete.php",
    method: "POST",
    wrongMethod: "GET",
    body: { employee_code: "E002", confirm_code: "E002" },
  },
  // ダッシュボードはメソッドを見ない。401・403 の対象だけ
  { path: "/dashboard_data.php", method: "GET", wrongMethod: null },
];

function call(spec, token) {
  return api(spec.method, spec.path, { body: spec.body, token });
}

function readCounts() {
  return fixture([{ op: "read_counts" }])[0];
}

// 管理者 A001 と、対象になる社員 E002 を入れる。{ adminPw, pw }
function seedBase() {
  const admin = seedAdmin("A001");
  const pw = randomValue();
  fixture([{ op: "add_employee", code: "E002", department: "営業部", pw }]);
  return { adminPw: admin.pw, pw };
}

// 入口で止められて、何も変わっていないこと（社員の行・操作の記録）
function assertNothingChanged(beforeCounts, beforeRow) {
  assert.deepEqual(readCounts(), beforeCounts);
  assert.deepEqual(fixture([{ op: "read_employee", code: "E002" }])[0], beforeRow);
  assert.equal(fixture([{ op: "read_employee", code: "Z900" }])[0], null);
}

// ---------- 5.1 共通 ----------

test("管理者用の API（7本）は、トークンがないと 401。知らない・期限切れのトークンも 401", async () => {
  const { adminPw } = seedBase();
  const beforeCounts = readCounts();
  const beforeRow = fixture([{ op: "read_employee", code: "E002" }])[0];

  for (const spec of ADMIN_APIS) {
    const res = await call(spec, undefined);
    assert.equal(res.status, 401, `${spec.path} トークンなし`);
  }
  for (const spec of ADMIN_APIS) {
    const res = await call(spec, randomValue(64));
    assert.equal(res.status, 401, `${spec.path} 知らないトークン`);
  }

  // 期限の切れたトークン（管理者本人のもの）
  const token = await loginAs("A001", adminPw);
  fixture([{ op: "expire_tokens", code: "A001" }]);
  for (const spec of ADMIN_APIS) {
    const res = await call(spec, token);
    assert.equal(res.status, 401, `${spec.path} 期限切れ`);
  }

  // ログインは成功の記録を1つ足すだけ。ほかは何も変わらない
  const afterCounts = readCounts();
  assert.equal(afterCounts.admin_audit_logs, 0);
  assert.equal(afterCounts.employees, beforeCounts.employees);
  assert.deepEqual(fixture([{ op: "read_employee", code: "E002" }])[0], beforeRow);
  assert.equal(fixture([{ op: "read_employee", code: "Z900" }])[0], null);
});

test("管理者用の API（7本）は、管理者でない社員だと 403", async () => {
  const { pw } = seedBase();
  const beforeCounts = readCounts();
  const beforeRow = fixture([{ op: "read_employee", code: "E002" }])[0];
  // E002 自身が一般の社員としてログインする（対象も E002 だが、入口で止まる）
  const token = await loginAs("E002", pw);

  for (const spec of ADMIN_APIS) {
    const res = await call(spec, token);
    assert.equal(res.status, 403, spec.path);
  }

  const afterCounts = readCounts();
  assert.equal(afterCounts.admin_audit_logs, 0);
  assert.equal(afterCounts.employees, beforeCounts.employees);
  assert.deepEqual(fixture([{ op: "read_employee", code: "E002" }])[0], beforeRow);
  assert.equal(fixture([{ op: "read_employee", code: "Z900" }])[0], null);
});

test("POST の API に GET で来ると 405。一覧の API は POST で来ると 405", async () => {
  const { adminPw } = seedBase();
  const token = await loginAs("A001", adminPw);
  const beforeCounts = readCounts();
  const beforeRow = fixture([{ op: "read_employee", code: "E002" }])[0];

  for (const spec of ADMIN_APIS) {
    if (spec.wrongMethod === null) {
      continue; // ダッシュボードはメソッドを見ない
    }
    const res = await api(spec.wrongMethod, spec.path, { token });
    assert.equal(res.status, 405, `${spec.path} を ${spec.wrongMethod} で`);
  }
  assertNothingChanged(beforeCounts, beforeRow);
});

test("管理者でも、退職にした・仮のパスワードのままなら、管理者用の API は 401", async () => {
  const { adminPw } = seedBase();
  const mustChangePw = randomValue();
  const healthyPw = randomValue();
  fixture([
    { op: "add_employee", code: "A002", department: "管理部", pw: mustChangePw, is_admin: true, must_change: true },
    { op: "add_employee", code: "A003", department: "管理部", pw: healthyPw, is_admin: true },
  ]);
  // 仮のパスワードの管理者も、ログイン自体はできる（トークンは使えない）
  const mustChangeToken = await loginAs("A002", mustChangePw);
  const retiredToken = await loginAs("A001", adminPw);
  const healthyToken = await loginAs("A003", healthyPw);
  // 退職にする（トークンの行は残したまま）
  fixture([{ op: "set_active", code: "A001", is_active: false }]);
  const beforeCounts = readCounts();
  const beforeRow = fixture([{ op: "read_employee", code: "E002" }])[0];

  // 比べる相手：ふつうの管理者は通る
  const ok = await api("GET", "/admin_employees.php", { token: healthyToken });
  assert.equal(ok.status, 200);

  for (const spec of ADMIN_APIS) {
    const retired = await call(spec, retiredToken);
    assert.equal(retired.status, 401, `${spec.path} 退職にした管理者`);
    const pending = await call(spec, mustChangeToken);
    assert.equal(pending.status, 401, `${spec.path} 仮のパスワードの管理者`);
  }
  assertNothingChanged(beforeCounts, beforeRow);
});

test("管理者用の API の応答に、パスワードのハッシュは入らない（一覧・登録・リセット）", async () => {
  const { adminPw } = seedBase();
  const token = await loginAs("A001", adminPw);

  const list = await api("GET", "/admin_employees.php", { token });
  assert.equal(list.status, 200);
  assert.ok(list.json.employees.length >= 2, "ハッシュを持つ社員が一覧に出ている");

  const create = await api("POST", "/admin_employee_create.php", {
    body: {
      employee_code: "E100",
      display_name: "新入 太郎",
      department: "営業部",
      is_new_grad: true,
      is_admin: false,
    },
    token,
  });
  assert.equal(create.status, 200);

  const reset = await api("POST", "/admin_employee_reset.php", {
    body: { employee_code: "E002" },
    token,
  });
  assert.equal(reset.status, 200);

  for (const res of [list, create, reset]) {
    assert.ok(!res.text.includes("password_hash"));
    assert.ok(!/\$2[aby]\$/.test(res.text));
  }
});

// ---------- 5.7 社員の一覧 ----------

test("一覧：全員が社員IDの順に返る（退職者も、仮のパスワードの印も）。self_code は呼んだ管理者", async () => {
  const admin = seedAdmin("A001");
  const pw = randomValue();
  fixture([
    { op: "add_employee", code: "E002", department: "営業部", pw, name: "二番", is_new_grad: true },
    { op: "add_employee", code: "E001", department: "営業部", pw, name: "一番" },
    { op: "add_employee", code: "E004", department: "総務部", pw, name: "四番", must_change: true },
    { op: "add_employee", code: "E003", department: "開発部", pw, name: "三番", is_active: false },
  ]);
  const token = await loginAs("A001", admin.pw);

  const res = await api("GET", "/admin_employees.php", { token });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.employees, [
    {
      employee_code: "A001",
      display_name: "テストA001",
      department: "管理部",
      is_new_grad: false,
      is_admin: true,
      is_active: true,
      must_change_password: false,
    },
    {
      employee_code: "E001",
      display_name: "一番",
      department: "営業部",
      is_new_grad: false,
      is_admin: false,
      is_active: true,
      must_change_password: false,
    },
    {
      employee_code: "E002",
      display_name: "二番",
      department: "営業部",
      is_new_grad: true,
      is_admin: false,
      is_active: true,
      must_change_password: false,
    },
    {
      employee_code: "E003",
      display_name: "三番",
      department: "開発部",
      is_new_grad: false,
      is_admin: false,
      is_active: false,
      must_change_password: false,
    },
    {
      employee_code: "E004",
      display_name: "四番",
      department: "総務部",
      is_new_grad: false,
      is_admin: false,
      is_active: true,
      must_change_password: true,
    },
  ]);
  assert.equal(res.json.self_code, "A001");

  // 別の管理者で呼ぶと、self_code もその管理者になる
  const second = seedAdmin("A002");
  const secondToken = await loginAs("A002", second.pw);
  const res2 = await api("GET", "/admin_employees.php", { token: secondToken });
  assert.equal(res2.status, 200);
  assert.equal(res2.json.self_code, "A002");
});

test("一覧：departments は、在籍している社員の部署だけ（重複なし）", async () => {
  const admin = seedAdmin("A001"); // 管理部
  const pw = randomValue();
  fixture([
    { op: "add_employee", code: "E001", department: "営業部", pw },
    { op: "add_employee", code: "E002", department: "営業部", pw },
    { op: "add_employee", code: "E003", department: "開発部", pw, is_active: false },
    { op: "add_employee", code: "E004", department: "総務部", pw, must_change: true },
  ]);
  const token = await loginAs("A001", admin.pw);

  const res = await api("GET", "/admin_employees.php", { token });
  assert.equal(res.status, 200);
  // 退職者だけの部署（開発部）は入らない。並び順は見ない
  assert.deepEqual([...res.json.departments].sort(), ["営業部", "管理部", "総務部"].sort());
  assert.equal(res.json.departments.length, 3);
});
