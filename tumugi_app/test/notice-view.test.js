// =========================================
// test/notice-view.test.js
// js/notice-view.js の単体テスト（実行：npm test）
// =========================================

const test   = require("node:test");
const assert = require("node:assert/strict");

const { noticeText, noticeDateLabel } = require("../js/notice-view");

test("noticeDateLabel: 月と日を取り出す（ゼロは付けない）", () => {
  assert.equal(noticeDateLabel("2026-11-13 09:05:00"), "11月13日");
  assert.equal(noticeDateLabel("2026-01-05 00:00:00"), "1月5日");
});

test("noticeDateLabel: 形が違えば空の文字列", () => {
  assert.equal(noticeDateLabel(""), "");
  assert.equal(noticeDateLabel(null), "");
  assert.equal(noticeDateLabel(undefined), "");
  assert.equal(noticeDateLabel("abc"), "");
  assert.equal(noticeDateLabel("2026-13-40 00:00:00"), "");
});

test("noticeText: 部署の変更", () => {
  assert.equal(
    noticeText({ kind: "department", old_value: "営業部", new_value: "開発部", created_at: "2026-11-13 09:05:00" }),
    "11月13日に、部署が「営業部」から「開発部」に変更されました。"
  );
});

test("noticeText: 新卒の区分の変更（1 が対象、0 が対象外）", () => {
  assert.equal(
    noticeText({ kind: "new_grad", old_value: "1", new_value: "0", created_at: "2026-11-13 09:05:00" }),
    "11月13日に、新卒の区分が「対象」から「対象外」に変更されました。"
  );
  assert.equal(
    noticeText({ kind: "new_grad", old_value: "0", new_value: "1", created_at: "2026-11-13 09:05:00" }),
    "11月13日に、新卒の区分が「対象外」から「対象」に変更されました。"
  );
});

test("noticeText: 管理者の権限の付与・取り消し（new が 1 なら付与、0 なら外された）", () => {
  assert.equal(
    noticeText({ kind: "admin", old_value: "0", new_value: "1", created_at: "2026-11-13 09:05:00" }),
    "11月13日に、管理者の権限が付与されました。"
  );
  assert.equal(
    noticeText({ kind: "admin", old_value: "1", new_value: "0", created_at: "2026-11-13 09:05:00" }),
    "11月13日に、管理者の権限が外されました。"
  );
});

test("noticeText: 在籍に戻された・仮のパスワードの発行", () => {
  assert.equal(
    noticeText({ kind: "reactivated", old_value: null, new_value: null, created_at: "2026-11-13 09:05:00" }),
    "11月13日に、在籍の状態に戻されました。"
  );
  assert.equal(
    noticeText({ kind: "password_reset", old_value: null, new_value: null, created_at: "2026-11-13 09:05:00" }),
    "11月13日に、管理者が仮のパスワードを発行しました。"
  );
});

test("noticeText: 知らない kind は、登録内容の変更として返す", () => {
  assert.equal(
    noticeText({ kind: "unknown_kind", created_at: "2026-11-13 09:05:00" }),
    "11月13日に、登録内容が変更されました。"
  );
});

test("noticeText: 部署名に HTML が入っていても、そのままの文字で返す", () => {
  const text = noticeText({ kind: "department", old_value: "<b>営業</b>", new_value: "<img src=x onerror=1>", created_at: "2026-11-13 09:05:00" });
  assert.equal(text, "11月13日に、部署が「<b>営業</b>」から「<img src=x onerror=1>」に変更されました。");
});
