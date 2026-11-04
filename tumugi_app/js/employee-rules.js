// =========================================
// js/employee-rules.js
// 管理者ダッシュボードの「社員の管理」で使う、画面に依存しない判定。
//   - 登録・編集フォームの入力の確かめ
//   - 一覧の並べ方と検索
//   - 在籍の管理者の数と、その社員に対して今できる操作
//
// 画面（admin-dashboard.html から読み込む）と、単体テスト（test/employee-rules.test.js）の両方から使う。
//
// ここは「送る前に理由を出す」「押せない操作を最初から押せなくする」ための確かめ。
// 最終的に確かめるのはサーバー（tumugi_server/api/admin_employee_*.php）で、ここを省くためのものではない。
//   - 文字数は、絵文字なども1文字と数える（サーバーは mb_strlen）
// =========================================

(function () {
  "use strict";

  // 社員IDに使える文字と長さ。名前・部署の最大文字数
  const CODE_PATTERN   = /^[A-Za-z0-9_-]{1,20}$/;
  const TEXT_MAX_CHARS = 50;

  // 登録できない社員ID（大文字・小文字を問わない）。
  // 操作の記録（admin_audit_logs）では、管理者を作る道具の操作を admin_code = "CLI" で残す。
  // 同じ社員IDの社員がいると、記録の上で道具の操作と見分けがつかなくなるため。
  const RESERVED_CODE = "cli";
  const MSG_RESERVED_CODE = "社員ID「CLI」は、管理者を作る道具の記録に使うため、登録できません";

  // 前後の空白（全角スペースを含む）を除いた文字列にする
  function clean(value) {
    return String(value ?? "").trim();
  }

  // 絵文字なども1文字と数える（JavaScript の length では2になる）
  function charLength(text) {
    return Array.from(text).length;
  }

  // 確かめる順は 社員ID（形 → 使えない社員ID）→ 名前 → 部署。最初に当てはまったものだけを返す。
  // 編集のとき（isNew が false）は、社員IDを変えられないので確かめない。
  function validateEmployeeForm({ code, name, department, isNew } = {}) {
    const values = { code: clean(code), name: clean(name), department: clean(department) };

    if (isNew !== false) {
      if (!CODE_PATTERN.test(values.code)) {
        return { ok: false, message: "社員IDは英数字・-・_ の1〜20文字にしてください" };
      }
      if (values.code.toLowerCase() === RESERVED_CODE) {
        return { ok: false, message: MSG_RESERVED_CODE };
      }
    }

    const nameLength = charLength(values.name);
    if (nameLength === 0) return { ok: false, message: "名前を入れてください" };
    if (nameLength > TEXT_MAX_CHARS) return { ok: false, message: "名前は50文字までにしてください" };

    const departmentLength = charLength(values.department);
    if (departmentLength === 0) return { ok: false, message: "部署を入れてください" };
    if (departmentLength > TEXT_MAX_CHARS) return { ok: false, message: "部署は50文字までにしてください" };

    return { ok: true, values };
  }

  // 在籍が先、そのあと退職。それぞれ社員IDの昇順（文字コード順）。元の配列は変えない
  function sortEmployees(list) {
    const rank = (e) => (e.is_active ? 0 : 1);
    return [...list].sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      if (a.employee_code < b.employee_code) return -1;
      if (a.employee_code > b.employee_code) return 1;
      return 0;
    });
  }

  // 社員IDか名前の一部が当たる社員だけにする（大文字と小文字は区別しない）。空なら全員
  function filterEmployees(list, query) {
    const q = clean(query).toLowerCase();
    if (q === "") return [...list];
    return list.filter((e) =>
      String(e.employee_code ?? "").toLowerCase().includes(q) ||
      String(e.display_name ?? "").toLowerCase().includes(q)
    );
  }

  // 在籍の管理者の人数（退職の管理者は数えない）
  function countActiveAdmins(list) {
    return list.filter((e) => e.is_active && e.is_admin).length;
  }

  // その社員に対して、今できる操作。すべて真偽値で返す。
  // 「最後の在籍の管理者」を退職にしたり管理者から外したりできないのは、管理者がいなくなるのを防ぐため。
  // （サーバーも同じ守りを持つ。2人の管理者が同時に相手を外すような操作は、サーバーが止める）
  function allowedActions(target, selfCode, activeAdminCount) {
    const isSelf = target.employee_code === selfCode;
    const active = Boolean(target.is_active);
    const isLastActiveAdmin = active && Boolean(target.is_admin) && activeAdminCount <= 1;

    return {
      isSelf,
      reset:      active && !isSelf,
      deactivate: active && !isSelf && !isLastActiveAdmin,
      reactivate: !active,
      remove:     !active,
      unsetAdmin: !isSelf && !isLastActiveAdmin,
    };
  }

  // 消すのは、削除の確認欄に社員IDを正しく打ち込んだときだけ（前後の空白は無視する）
  function canConfirmDelete(target, typed) {
    return String(typed ?? "").trim() === target.employee_code;
  }

  const api = Object.freeze({
    CODE_PATTERN,
    TEXT_MAX_CHARS,
    validateEmployeeForm,
    sortEmployees,
    filterEmployees,
    countActiveAdmins,
    allowedActions,
    canConfirmDelete,
  });

  // テスト（Node）では module.exports、画面では globalThis.TumugiEmployeeRules として使う
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    globalThis.TumugiEmployeeRules = api;
  }
})();
