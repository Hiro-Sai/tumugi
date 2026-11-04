// =========================================
// test/employee-rules.test.js
// js/employee-rules.js の単体テスト（実行：npm test）
// 社員の管理画面の、入力の確かめ・一覧の並べ方と検索・操作できるかの判定
// =========================================

const test   = require("node:test");
const assert = require("node:assert/strict");

const {
  validateEmployeeForm,
  sortEmployees,
  filterEmployees,
  countActiveAdmins,
  allowedActions,
  canConfirmDelete,
} = require("../js/employee-rules");

const MSG_CODE       = "社員IDは英数字・-・_ の1〜20文字にしてください";
const MSG_RESERVED_CODE = "社員ID「CLI」は、管理者を作る道具の記録に使うため、登録できません";
const MSG_NAME_EMPTY = "名前を入れてください";
const MSG_NAME_LONG  = "名前は50文字までにしてください";
const MSG_DEPT_EMPTY = "部署を入れてください";
const MSG_DEPT_LONG  = "部署は50文字までにしてください";

// 登録フォームの入力。指定しなかった項目は、正しい値にする
function form(overrides = {}) {
  return validateEmployeeForm({ code: "E049", name: "山田", department: "営業", isNew: true, ...overrides });
}

// サーバーの一覧 API と同じ形の社員。指定しなかった項目は「在籍の一般社員」にする
function emp(code, overrides = {}) {
  return {
    employee_code: code,
    display_name: "山田太郎",
    department: "営業",
    is_new_grad: false,
    is_admin: false,
    is_active: true,
    must_change_password: false,
    ...overrides,
  };
}

const codesOf = (list) => list.map((e) => e.employee_code);

test("社員IDは英数字・-・_ の1〜20文字（新しく登録するときだけ確かめる）", () => {
  assert.equal(form({ code: "E049" }).ok, true);
  assert.equal(form({ code: "a_b-1" }).ok, true);
  assert.equal(form({ code: "A".repeat(20) }).ok, true);

  assert.deepEqual(form({ code: "" }), { ok: false, message: MSG_CODE });
  assert.deepEqual(form({ code: "E 049" }), { ok: false, message: MSG_CODE });
  assert.deepEqual(form({ code: "あ" }), { ok: false, message: MSG_CODE });
  assert.deepEqual(form({ code: "A".repeat(21) }), { ok: false, message: MSG_CODE });

  // 「CLI」は登録できない（大文字・小文字を問わない。形の確かめが先）
  assert.deepEqual(form({ code: "CLI" }), { ok: false, message: MSG_RESERVED_CODE });
  assert.deepEqual(form({ code: "cli" }), { ok: false, message: MSG_RESERVED_CODE });
  assert.deepEqual(form({ code: "Cli" }), { ok: false, message: MSG_RESERVED_CODE });
  assert.equal(form({ code: "CLI2" }).ok, true);

  // 編集のとき（isNew が false）は、社員IDを確かめない
  assert.equal(form({ code: "あ", isNew: false }).ok, true);
  assert.equal(form({ code: "CLI", isNew: false }).ok, true);
});

test("名前と部署は、前後の空白を除いて1〜50文字（全角スペースだけは空）", () => {
  // 前後の空白（全角スペースを含む）を除いた値を返す
  assert.deepEqual(
    form({ code: " E049 ", name: " 山田 ", department: "　営業　" }),
    { ok: true, values: { code: "E049", name: "山田", department: "営業" } }
  );

  // 名前
  assert.deepEqual(form({ name: "　" }), { ok: false, message: MSG_NAME_EMPTY });
  assert.equal(form({ name: "あ".repeat(50) }).ok, true);
  assert.deepEqual(form({ name: "あ".repeat(51) }), { ok: false, message: MSG_NAME_LONG });
  // 空白を除いてから数える（前後に空白があっても、中身が50文字なら通る）
  assert.equal(form({ name: " " + "あ".repeat(50) + "　" }).ok, true);

  // 部署
  assert.deepEqual(form({ department: "　" }), { ok: false, message: MSG_DEPT_EMPTY });
  assert.equal(form({ department: "あ".repeat(50) }).ok, true);
  assert.deepEqual(form({ department: "あ".repeat(51) }), { ok: false, message: MSG_DEPT_LONG });

  // 絵文字は1つを1文字と数える（JavaScript の length では2になる）
  assert.equal(form({ name: "😀".repeat(50) }).ok, true);
  assert.deepEqual(form({ name: "😀".repeat(51) }), { ok: false, message: MSG_NAME_LONG });
  assert.equal(form({ department: "😀".repeat(50) }).ok, true);
  assert.deepEqual(form({ department: "😀".repeat(51) }), { ok: false, message: MSG_DEPT_LONG });
});

test("確かめる順番は 社員ID → 名前 → 部署", () => {
  // 3つとも不正なら、社員IDのことを言う
  assert.deepEqual(form({ code: "", name: "", department: "" }), { ok: false, message: MSG_CODE });
  // 社員IDだけ正しければ、名前のことを言う
  assert.deepEqual(form({ code: "E049", name: "", department: "" }), { ok: false, message: MSG_NAME_EMPTY });
  // 社員IDと名前が正しければ、部署のことを言う
  assert.deepEqual(form({ code: "E049", name: "山田", department: "" }), { ok: false, message: MSG_DEPT_EMPTY });
});

test("一覧は在籍が先、退職があと。それぞれ社員IDの順", () => {
  const list = [
    emp("E013", { is_active: false }),
    emp("E002"),
    emp("A001"),
    emp("E001", { is_active: false }),
  ];
  const before = codesOf(list);

  const sorted = sortEmployees(list);

  assert.deepEqual(codesOf(sorted), ["A001", "E002", "E001", "E013"]);
  // 元の配列は変えない
  assert.notEqual(sorted, list);
  assert.deepEqual(codesOf(list), before);
});

test("検索は社員ID・名前の一部で、大文字と小文字を区別しない。空なら全員", () => {
  const list = [
    emp("E001", { display_name: "山田太郎" }),
    emp("E002", { display_name: "佐藤花子" }),
    emp("E013", { display_name: "鈴木一郎" }),
  ];

  // 社員IDの一部（小文字でも当たる）
  assert.deepEqual(codesOf(filterEmployees(list, "e00")), ["E001", "E002"]);
  // 名前の一部
  assert.deepEqual(codesOf(filterEmployees(list, "山田")), ["E001"]);
  // 前後の空白は無視する
  assert.deepEqual(codesOf(filterEmployees(list, " e00 ")), ["E001", "E002"]);
  // 空（空白だけを含む）なら全員
  assert.deepEqual(codesOf(filterEmployees(list, "")), ["E001", "E002", "E013"]);
  assert.deepEqual(codesOf(filterEmployees(list, "  ")), ["E001", "E002", "E013"]);
  // 当たらなければ空
  assert.deepEqual(filterEmployees(list, "zzz"), []);
});

test("在籍の管理者の数は、退職の管理者を数えない", () => {
  const list = [
    emp("A001", { is_admin: true }),
    emp("A002", { is_admin: true }),
    emp("A003", { is_admin: true, is_active: false }),
    emp("E001"),
    emp("E002", { is_active: false }),
  ];
  assert.equal(countActiveAdmins(list), 2);
  assert.equal(countActiveAdmins([]), 0);
});

test("自分自身には、リセット・退職・管理者を外す操作ができない", () => {
  const me = emp("A001", { is_admin: true });
  const actions = allowedActions(me, "A001", 2);

  assert.equal(actions.isSelf, true);
  assert.equal(actions.reset, false);
  assert.equal(actions.deactivate, false);
  assert.equal(actions.unsetAdmin, false);

  // 自分ではない人は isSelf が偽
  assert.equal(allowedActions(emp("E001"), "A001", 2).isSelf, false);
});

test("在籍の管理者が1人だけのとき、その人を退職にしたり管理者から外したりできない", () => {
  // 自分ではない、在籍の管理者（2人の管理者が同時に相手を外す場合への守り）
  const other = emp("A002", { is_admin: true });

  const onlyOne = allowedActions(other, "A001", 1);
  assert.equal(onlyOne.deactivate, false);
  assert.equal(onlyOne.unsetAdmin, false);
  // パスワードのリセットは、管理者の数に関わらずできる
  assert.equal(onlyOne.reset, true);

  const two = allowedActions(other, "A001", 2);
  assert.equal(two.deactivate, true);
  assert.equal(two.unsetAdmin, true);

  // 管理者ではない人は、管理者が1人でも退職にできる
  assert.equal(allowedActions(emp("E001"), "A001", 1).deactivate, true);
});

test("退職の社員だけ、在籍に戻す・消すができる", () => {
  const retired = allowedActions(emp("E013", { is_active: false }), "A001", 2);
  assert.equal(retired.reactivate, true);
  assert.equal(retired.remove, true);
  assert.equal(retired.reset, false);
  assert.equal(retired.deactivate, false);

  const active = allowedActions(emp("E001"), "A001", 2);
  assert.equal(active.reactivate, false);
  assert.equal(active.remove, false);
  assert.equal(active.reset, true);
  assert.equal(active.deactivate, true);
});

test("消すのは、社員IDを正しく打ち込んだときだけ", () => {
  const target = emp("E013", { is_active: false });

  assert.equal(canConfirmDelete(target, "E013"), true);
  assert.equal(canConfirmDelete(target, " E013 "), true);

  assert.equal(canConfirmDelete(target, "e013"), false);
  assert.equal(canConfirmDelete(target, ""), false);
  assert.equal(canConfirmDelete(target, undefined), false);
  assert.equal(canConfirmDelete(target, null), false);
});
