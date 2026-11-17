// =========================================
// js/notice-view.js
// 本人あての知らせ（登録内容の変更）に出す、日付と文。画面には触らない（文字を返すだけ）。
// 画面（index.html から script.js より先に読み込む）と、単体テスト（test/notice-view.test.js）の両方から使う。
// 文字は、HTML として組み立てない。画面に出すときは、必ず textContent で入れること
// （部署名は管理者が自由に入れられるため）。
// =========================================

(function () {
  "use strict";

  const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[ T]/;

  // "2026-11-13 09:05:00" → "11月13日"。文字列から月と日を取り出すだけ（時差の計算はしない）。
  // 形が違えば ""
  function noticeDateLabel(createdAt) {
    if (typeof createdAt !== "string") return "";
    const m = DATE_PATTERN.exec(createdAt);
    if (!m) return "";
    const month = Number(m[2]);
    const day   = Number(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return "";
    return `${month}月${day}日`;
  }

  // 新卒の区分の値（"1"・"0"）を、画面に出す言葉にする
  function newGradLabel(value) {
    return String(value) === "1" ? "対象" : "対象外";
  }

  // 知らせ1件の文。知らない kind は、変更があったことだけを伝える
  function noticeText(notice) {
    const n = notice || {};
    const date = noticeDateLabel(n.created_at);
    switch (n.kind) {
      case "department":
        return `${date}に、部署が「${n.old_value ?? ""}」から「${n.new_value ?? ""}」に変更されました。`;
      case "new_grad":
        return `${date}に、新卒の区分が「${newGradLabel(n.old_value)}」から「${newGradLabel(n.new_value)}」に変更されました。`;
      case "admin":
        // new が "1" なら付与、それ以外は外された
        return String(n.new_value) === "1"
          ? `${date}に、管理者の権限が付与されました。`
          : `${date}に、管理者の権限が外されました。`;
      case "reactivated":
        return `${date}に、在籍の状態に戻されました。`;
      case "password_reset":
        return `${date}に、管理者が仮のパスワードを発行しました。`;
      default:
        return `${date}に、登録内容が変更されました。`;
    }
  }

  const api = Object.freeze({ noticeText, noticeDateLabel });

  // テスト（Node）では module.exports、画面では window.NoticeView として使う
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    globalThis.NoticeView = api;
  }
})();
