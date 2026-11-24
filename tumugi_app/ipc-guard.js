// =========================================
// IPC の入口の守り（レビューの B3）
//   - 送り主の確かめ（isTrustedSender）
//   - 保存の IPC（store:get・set・delete）で通すキー（STORE_KEYS・isAllowedStoreKey）
// Electron に依存しない純粋な関数だけを置き、main.js とテスト（test/ipc-guard.test.js）から使う。
// =========================================

const { isAllowedNavigation } = require("./net-policy");

// 保存の IPC で、画面側が読み書きしてよいキー。js/auth.js の AUTH_*_KEY と、js/script.js の CONSENT_MAP_KEY。
// キーを足すときは、ここにも足すこと（足し忘れると、test/ipc-guard.test.js が落ちる）。
// 社員ごとの記憶（memory_<社員ID>）は入れない。記憶は memory:* の IPC だけが、ログインした社員の分を扱う。
const STORE_KEYS = Object.freeze([
  "auth_token",
  "auth_employee_id",
  "auth_department",
  "auth_expires_at",
  "auth_is_admin",
  "emotion_consent_map",
]);

function isAllowedStoreKey(key) {
  return typeof key === "string" && STORE_KEYS.includes(key);
}

// IPC の送り主が、アプリの中の画面（アプリのフォルダの HTML を開いた、いちばん外の枠）か。
// 送り主の枠（event.senderFrame）は、もうないときは null になり、消えたあとに url などを読むと
// 例外になることもあるので、そのときも断る。HTML の中の枠（iframe）や、アプリの外の画面からの IPC も断る。
function isTrustedSender(event, appDir) {
  try {
    const frame = event?.senderFrame;
    return !!frame && frame.parent === null && isAllowedNavigation(frame.url, appDir);
  } catch {
    return false;
  }
}

module.exports = { STORE_KEYS, isAllowedStoreKey, isTrustedSender };
