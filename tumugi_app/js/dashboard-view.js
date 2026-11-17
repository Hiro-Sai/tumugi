// =========================================
// js/dashboard-view.js
// 管理者画面（集計）に出す、棒の幅・点数の文・まれな事象の文。画面には触らない（値を返すだけ）。
// 画面（admin-dashboard.html から admin-dashboard.js より先に読み込む）と、
// 単体テスト（test/dashboard-view.test.js）の両方から使う。
// =========================================

(function () {
  "use strict";

  // 数または数の文字列だけを数として読む。それ以外（null・空文字・真偽値など）は NaN
  function toNumber(value) {
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "") return Number(value);
    return NaN;
  }

  // 棒の幅（%）。0〜100 に収める。数でなければ 0
  function barPercent(avgScore) {
    const n = toNumber(avgScore);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
  }

  // 平均スコアの文。小数1桁。数でなければ "—"
  function scoreText(avgScore) {
    const n = toNumber(avgScore);
    if (!Number.isFinite(n)) return "—";
    return n.toFixed(1);
  }

  // まれな事象（危機的な発言・ハラスメントに関する発言）の文。
  // サーバーが該当人数で3段階に分けて返す（dashboard_data.php の rareEventDisplay）
  //   none → 「なし」、flag_only → 件数も人数も出さない、count → 件数
  // 知らない値を「なし」にすると、あるものを無いと見せてしまうので "—" にする
  function rareEventText(display, count) {
    if (display === "none") return "なし";
    if (display === "flag_only") return "あり（人数は非表示）";
    if (display === "count") return `${count ?? 0}件`;
    return "—";
  }

  const api = Object.freeze({ barPercent, scoreText, rareEventText });

  // テスト（Node）では module.exports、画面では window.TumugiDashboardView として使う
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    globalThis.TumugiDashboardView = api;
  }
})();
