// =========================================
// js/password.js
// 「設定」でパスワードを変えるときの、入力の確かめ。
// 画面（index.html から script.js より先に読み込む）と、単体テスト（test/password.test.js）の両方から使う。
//
// サーバー（tumugi_server/api/change_password.php）も同じ決まりで確かめる。ここで先に確かめるのは、
// 送る前に理由を出すため（サーバーの確かめを省くためではない）。
//   - 文字数は、絵文字なども1文字と数える（サーバーは mb_strlen）
//   - 72バイトまで：bcrypt は72バイトを超えた分を無視するため（サーバーは strlen）
// =========================================

(function () {
  "use strict";

  const MIN_CHARS = 8;
  const MAX_BYTES = 72;

  // 決まりは上から順に確かめ、最初に当てはまったものだけを返す
  function validateNewPassword({ current, next, confirm } = {}) {
    const cur = String(current ?? "");
    const nxt = String(next ?? "");
    const again = String(confirm ?? "");

    if (cur === "") return { ok: false, message: "今のパスワードを入れてください" };
    if (Array.from(nxt).length < MIN_CHARS) return { ok: false, message: "新しいパスワードは8文字以上にしてください" };
    if (new TextEncoder().encode(nxt).length > MAX_BYTES) {
      return { ok: false, message: "新しいパスワードが長すぎます（72バイトまで。全角なら24文字程度）" };
    }
    if (nxt === cur) return { ok: false, message: "今と同じパスワードにはできません" };
    if (nxt !== again) return { ok: false, message: "新しいパスワード（もう一度）が一致しません" };
    return { ok: true };
  }

  const api = Object.freeze({ MIN_CHARS, MAX_BYTES, validateNewPassword });

  // テスト（Node）では module.exports、画面では window.TumugiPassword として使う
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    globalThis.TumugiPassword = api;
  }
})();
