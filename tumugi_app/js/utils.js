// =========================================
// utils.js
// 共通ユーティリティ（HTMLエスケープ等）
// script.js / admin-dashboard.js の両方から使う
// =========================================

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}