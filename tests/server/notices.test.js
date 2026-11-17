"use strict";
// 本人あての知らせ：管理者の変更が残ること（admin_employee_update / status / reset .php）と、
// 本人が読む・見たことにする API（my_notices.php / my_notices_seen.php）
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

const update = (token, over) => post("/admin_employee_update.php", updateBody(over), token);
const setStatus = (token, code, isActive) =>
  post("/admin_employee_status.php", { employee_code: code, is_active: isActive }, token);
const reset = (token, code) => post("/admin_employee_reset.php", { employee_code: code }, token);

const readNotices = (code) => fixture([{ op: "read_notices", code }])[0];
const addNotice = (code, extra = {}) =>
  fixture([{ op: "add_notice", code, kind: "department", old: "営業部", new: "開発部", ...extra }])[0];
const getNotices = (token) => api("GET", "/my_notices.php", { token });
const markSeen = (token, body) => post("/my_notices_seen.php", body, token);

// ---------- 管理者の変更が、知らせとして残る ----------

test("知らせ：部署を変えると、本人に department の知らせが1行（old・new は部署名）", async () => {
  const { token } = await setupAdmin();
  addEmployee("E001");

  const res = await update(token, { department: "開発部" });
  assert.equal(res.status, 200);

  const notices = readNotices("E001");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, "department");
  assert.equal(notices[0].old_value, "営業部");
  assert.equal(notices[0].new_value, "開発部");
  assert.equal(notices[0].seen, false);
  // 管理者の側には、知らせは増えない
  assert.deepEqual(readNotices("A001"), []);
});

test("知らせ：新卒の印を変えると、new_grad の知らせが1行（old \"0\"、new \"1\"）", async () => {
  const { token } = await setupAdmin();
  addEmployee("E001");

  const res = await update(token, { is_new_grad: true });
  assert.equal(res.status, 200);

  const notices = readNotices("E001");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, "new_grad");
  assert.equal(notices[0].old_value, "0");
  assert.equal(notices[0].new_value, "1");
});

test("知らせ：部署と新卒の印を一緒に変えると、2行", async () => {
  const { token } = await setupAdmin();
  addEmployee("E001", { is_new_grad: true });

  const res = await update(token, { department: "開発部", is_new_grad: false });
  assert.equal(res.status, 200);

  const notices = readNotices("E001");
  assert.deepEqual(
    notices.map((n) => [n.kind, n.old_value, n.new_value]),
    [
      ["department", "営業部", "開発部"],
      ["new_grad", "1", "0"],
    ]
  );
});

test("知らせ：氏名だけを変えても、知らせは増えない", async () => {
  const { token } = await setupAdmin();
  addEmployee("E001");

  const res = await update(token, { display_name: "新しい名前" });
  assert.equal(res.status, 200);
  assert.deepEqual(readNotices("E001"), []);
});

test("知らせ：管理者の印を付けると admin が1行（old \"0\"、new \"1\"）、外すと1行増える（old \"1\"、new \"0\"）", async () => {
  const { token } = await setupAdmin();
  addEmployee("E001");

  // 付ける
  assert.equal((await update(token, { is_admin: true })).status, 200);
  const afterGrant = readNotices("E001");
  assert.equal(afterGrant.length, 1);
  assert.equal(afterGrant[0].kind, "admin");
  assert.equal(afterGrant[0].old_value, "0");
  assert.equal(afterGrant[0].new_value, "1");
  assert.equal(afterGrant[0].seen, false);

  // 外す
  assert.equal((await update(token, { is_admin: false })).status, 200);
  const afterRevoke = readNotices("E001");
  assert.equal(afterRevoke.length, 2);
  assert.equal(afterRevoke[1].kind, "admin");
  assert.equal(afterRevoke[1].old_value, "1");
  assert.equal(afterRevoke[1].new_value, "0");
});

test("知らせ：何も変わらない修正では、知らせは増えない", async () => {
  const { token } = await setupAdmin();
  addEmployee("E001");

  const res = await update(token);
  assert.equal(res.status, 200);
  assert.deepEqual(readNotices("E001"), []);
  assert.deepEqual(fixture([{ op: "read_counts" }])[0].employee_notices, 0);
});

test("知らせ：在籍に戻すと reactivated が1行。退職にしても増えない。すでに在籍の社員を戻しても増えない", async () => {
  const { token } = await setupAdmin();
  addEmployee("E001", { is_active: false });
  addEmployee("E002");

  // すでに在籍の社員を在籍に戻す
  assert.equal((await setStatus(token, "E002", true)).status, 200);
  assert.deepEqual(readNotices("E002"), []);

  // 退職中の社員を在籍に戻す
  assert.equal((await setStatus(token, "E001", true)).status, 200);
  const afterReactivate = readNotices("E001");
  assert.equal(afterReactivate.length, 1);
  assert.equal(afterReactivate[0].kind, "reactivated");
  assert.equal(afterReactivate[0].old_value, null);
  assert.equal(afterReactivate[0].new_value, null);

  // 退職にしても、増えない
  assert.equal((await setStatus(token, "E001", false)).status, 200);
  assert.equal(readNotices("E001").length, 1);
});

test("知らせ：仮のパスワードを発行すると password_reset が1行。自分への発行（400）では増えない", async () => {
  const { token } = await setupAdmin();
  addEmployee("E001");

  const ok = await reset(token, "E001");
  assert.equal(ok.status, 200);
  const notices = readNotices("E001");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, "password_reset");
  assert.equal(notices[0].old_value, null);
  assert.equal(notices[0].new_value, null);

  const self = await reset(token, "A001");
  assert.equal(self.status, 400);
  assert.deepEqual(readNotices("A001"), []);
  assert.equal(readNotices("E001").length, 1);
});

// ---------- 本人が読む・見たことにする ----------

test("my_notices：自分の分だけが、新しい順に返る（ほかの社員の分は返らない）。unseen_count が合う", async () => {
  const pw = addEmployee("E001");
  addEmployee("E002");
  addNotice("E001", { old: "一", new: "二", days_ago: 3 });
  addNotice("E001", { old: "二", new: "三", days_ago: 2, seen: true });
  addNotice("E001", { old: "三", new: "四", days_ago: 1 });
  addNotice("E002", { old: "他", new: "人" });
  const token = await loginAs("E001", pw);

  const res = await getNotices(token);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ["notices", "unseen_count"]);
  assert.deepEqual(
    res.json.notices.map((n) => n.new_value),
    ["四", "三", "二"]
  );
  assert.deepEqual(
    res.json.notices.map((n) => n.seen),
    [false, true, false]
  );
  assert.equal(res.json.unseen_count, 2);

  const first = res.json.notices[0];
  assert.deepEqual(Object.keys(first).sort(), [
    "created_at",
    "id",
    "kind",
    "new_value",
    "old_value",
    "seen",
  ]);
  assert.equal(typeof first.id, "number");
  assert.equal(first.kind, "department");
  assert.match(first.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test("my_notices：見た知らせは、89日前は返り、91日前は返らない", async () => {
  const pw = addEmployee("E001");
  addNotice("E001", { old: "あ", new: "い", days_ago: 89, seen: true });
  addNotice("E001", { old: "う", new: "え", days_ago: 91, seen: true });
  const token = await loginAs("E001", pw);

  const res = await getNotices(token);
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.json.notices.map((n) => n.old_value),
    ["あ"]
  );
  assert.equal(res.json.unseen_count, 0);
});

test("my_notices：まだ見ていない知らせは、91日より前でも返る（長くログインしなかった人のため）", async () => {
  const pw = addEmployee("E001");
  addNotice("E001", { old: "あ", new: "い", days_ago: 100 });
  addNotice("E001", { old: "う", new: "え", days_ago: 100, seen: true });
  const token = await loginAs("E001", pw);

  const res = await getNotices(token);
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.json.notices.map((n) => [n.old_value, n.seen]),
    [["あ", false]]
  );
  assert.equal(res.json.unseen_count, 1);
});

test("my_notices_seen：up_to_id までが seen になり、それより新しい知らせは残る。ほかの社員の知らせは変わらない。updated の数が合う", async () => {
  const pw = addEmployee("E001");
  addEmployee("E002");
  addNotice("E001", { old: "一", new: "二", seen: true });
  addNotice("E002", { old: "他", new: "人" });
  addNotice("E001", { old: "二", new: "三" });
  const upTo = addNotice("E001", { old: "三", new: "四" });
  addNotice("E001", { old: "四", new: "五" });
  const token = await loginAs("E001", pw);

  const res = await markSeen(token, { up_to_id: upTo.id });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { status: "ok", updated: 2 });

  assert.deepEqual(
    readNotices("E001").map((n) => n.seen),
    [true, true, true, false]
  );
  assert.deepEqual(
    readNotices("E002").map((n) => n.seen),
    [false]
  );

  // 同じ範囲をもう一度送っても、数えない
  const again = await markSeen(token, { up_to_id: upTo.id });
  assert.deepEqual(again.json, { status: "ok", updated: 0 });

  // 存在しない大きな id でも 200。自分の未読すべてが対象（ほかの社員の分は含めない）
  const rest = await markSeen(token, { up_to_id: 2147483647 });
  assert.equal(rest.status, 200);
  assert.deepEqual(rest.json, { status: "ok", updated: 1 });
  assert.deepEqual(
    readNotices("E002").map((n) => n.seen),
    [false]
  );
});

test("my_notices_seen：確認したあとも、my_notices には seen: true で返る", async () => {
  const pw = addEmployee("E001");
  const added = addNotice("E001");
  const token = await loginAs("E001", pw);

  const before = await getNotices(token);
  assert.equal(before.json.notices[0].seen, false);
  assert.equal(before.json.unseen_count, 1);

  assert.equal((await markSeen(token, { up_to_id: added.id })).status, 200);

  const after = await getNotices(token);
  assert.equal(after.json.notices.length, 1);
  assert.equal(after.json.notices[0].seen, true);
  assert.equal(after.json.unseen_count, 0);
});

test("知らせの API：トークンなしは 401。仮のパスワードのままは 401。メソッドが違うと 405。up_to_id が数でない・0・ないと 400", async () => {
  const pw = addEmployee("E001");
  const pendingPw = addEmployee("E002", { must_change: true });
  const token = await loginAs("E001", pw);
  const pendingToken = await loginAs("E002", pendingPw);

  // トークンなし
  assert.equal((await api("GET", "/my_notices.php")).status, 401);
  assert.equal((await markSeen(undefined, { up_to_id: 1 })).status, 401);

  // 仮のパスワードのまま
  assert.equal((await getNotices(pendingToken)).status, 401);
  assert.equal((await markSeen(pendingToken, { up_to_id: 1 })).status, 401);

  // メソッドが違う
  assert.equal((await post("/my_notices.php", {}, token)).status, 405);
  assert.equal((await api("GET", "/my_notices_seen.php", { token })).status, 405);

  // up_to_id が、1以上の整数ではない
  for (const body of [
    { up_to_id: "3" },
    { up_to_id: 1.5 },
    { up_to_id: 0 },
    { up_to_id: -1 },
    { up_to_id: null },
    {},
  ]) {
    const res = await markSeen(token, body);
    assert.equal(res.status, 400, `up_to_id=${JSON.stringify(body)}`);
    assert.equal(typeof res.json.error, "string");
  }
});
