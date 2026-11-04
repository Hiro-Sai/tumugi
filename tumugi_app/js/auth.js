// =========================================
// auth.js
// ログイン処理・トークン管理（electron-store経由、preload.js の window.electronAPI 使用）
// サーバー通信はすべて window.electronAPI.netServer() 経由（main.js側で固定URLに限定）
// =========================================

const AUTH_TOKEN_KEY      = "auth_token";
const AUTH_EMPLOYEE_KEY   = "auth_employee_id";
const AUTH_DEPARTMENT_KEY = "auth_department";
const AUTH_EXPIRES_KEY    = "auth_expires_at";
const AUTH_IS_ADMIN_KEY   = "auth_is_admin";

// =========================
// ログインフォーム送信（login.html専用）
// =========================
async function submitLogin() {
  const codeInput = document.getElementById("loginEmployeeCode");
  const passInput = document.getElementById("loginPassword");
  const errorEl   = document.getElementById("loginError");
  const btn       = document.getElementById("loginSubmitBtn");

  const employeeCode = codeInput?.value.trim();
  const password     = passInput?.value ?? "";

  if (errorEl) errorEl.textContent = "";

  if (!employeeCode || !password) {
    if (errorEl) errorEl.textContent = "社員IDとパスワードを入力してください";
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = "ログイン中…";
  }

  const res = await window.electronAPI.netServer({
    path: "/login.php",
    method: "POST",
    body: { employee_code: employeeCode, password },
  });

  // ログインに失敗したときの後始末（ボタンを元に戻す）
  const restoreButton = () => {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "ログイン";
    }
  };

  if (!res.ok) {
    if (errorEl) {
      errorEl.textContent = res.reason === "connection_refused"
        ? "サーバーに接続できませんでした。サーバーが起動しているか確認してください"
        : (res.data?.error || "ログインに失敗しました");
    }
    restoreButton();
    return;
  }

  const data = res.data;

  // 期限（秒数）が正の数でなければ、ログインを失敗として扱い、何も保存しない
  if (!Number.isFinite(data?.expires_in) || data.expires_in <= 0) {
    if (errorEl) errorEl.textContent = "ログインに失敗しました";
    restoreButton();
    return;
  }

  await window.electronAPI.storeSet(AUTH_TOKEN_KEY, data.token);
  await window.electronAPI.storeSet(AUTH_EMPLOYEE_KEY, data.employee_id);
  await window.electronAPI.storeSet(AUTH_DEPARTMENT_KEY, data.department);
  await window.electronAPI.storeSet(AUTH_IS_ADMIN_KEY, !!data.is_admin);
  // 期限は、サーバーの時刻ではなく、この PC の時計で数える（getStoredToken と同じ時計になる）
  await window.electronAPI.storeSet(
    AUTH_EXPIRES_KEY,
    new Date(Date.now() + data.expires_in * 1000).toISOString()
  );

  // 仮のパスワードでのログインは、ここで新しいパスワードを決めてもらう（2段目）。
  // 仮のパスワードから記憶の鍵は作らない（新しいパスワードが決まってから作る）
  if (data.must_change_password === true) {
    restoreButton();
    showPasswordChangeStep(password, data.employee_id);
    return;
  }

  // つむぎの記憶の鍵を、入力されたパスワードから作る（main.js・memory-crypto.js）。
  // 失敗しても会話はできるので、ログインは続ける（その場合、記憶は読み書きされない）
  try {
    await window.electronAPI.memoryUnlock(data.employee_id, password);
  } catch (e) {
    console.warn("[Memory] 記憶の鍵を作れませんでした:", e.message);
  }

  window.electronAPI.loginSuccess();
}

// =========================
// ログインの2段目：新しいパスワードを決める（login.html専用）
// 仮のパスワードでログインした社員は、サーバーに「パスワードを変えるまで他の操作はできない」状態にされている。
// ここで change_password.php を呼んで新しいパスワードに変えてから、チャットに入る。
// =========================

// 仮のパスワードと社員の id は、この2段目のあいだだけ持つ。終わったら（成功・401・やめる）必ず消す
let pendingTempPassword = null;
let pendingEmployeeId   = null;

// 2段目を終える：持っている値と、入力欄の中身を消す
function endPasswordChangeStep() {
  pendingTempPassword = null;
  pendingEmployeeId   = null;
  for (const id of ["firstNewPassword", "firstConfirmPassword"]) {
    const input = document.getElementById(id);
    if (input) input.value = "";
  }
}

// 1段目に戻す。message があれば、ログインの下にエラーとして出す
function returnToLoginStep(message) {
  endPasswordChangeStep();

  const loginStep  = document.getElementById("loginStep");
  const changeStep = document.getElementById("passwordChangeStep");
  const errorEl    = document.getElementById("loginError");
  const loginBtn   = document.getElementById("loginSubmitBtn");
  const passInput  = document.getElementById("loginPassword");

  const firstError = document.getElementById("firstPasswordError");
  if (firstError) firstError.textContent = "";
  if (changeStep) changeStep.hidden = true;
  if (loginStep) loginStep.hidden = false;
  if (errorEl) errorEl.textContent = message || "";
  if (loginBtn) {
    loginBtn.disabled = false;
    loginBtn.textContent = "ログイン";
  }
  if (passInput) {
    passInput.value = "";
    passInput.focus();
  }
}

// 2段目を出す
function showPasswordChangeStep(tempPassword, employeeId) {
  pendingTempPassword = tempPassword;
  pendingEmployeeId   = employeeId;

  const loginStep  = document.getElementById("loginStep");
  const changeStep = document.getElementById("passwordChangeStep");
  const passInput  = document.getElementById("loginPassword");
  const errorEl    = document.getElementById("firstPasswordError");
  const btn        = document.getElementById("firstPasswordSubmitBtn");
  const newInput   = document.getElementById("firstNewPassword");
  const confirmEl  = document.getElementById("firstConfirmPassword");

  // 1段目に打ったパスワードは、画面に残さない
  if (passInput) passInput.value = "";
  if (newInput) newInput.value = "";
  if (confirmEl) confirmEl.value = "";
  if (errorEl) errorEl.textContent = "";
  if (btn) {
    btn.disabled = false;
    btn.textContent = "変えてはじめる";
  }

  if (loginStep) loginStep.hidden = true;
  if (changeStep) changeStep.hidden = false;
  if (newInput) newInput.focus();
}

async function submitPasswordChangeStep() {
  const tempPassword = pendingTempPassword;
  const employeeId   = pendingEmployeeId;
  if (tempPassword === null) return; // 2段目が出ていない

  const newInput  = document.getElementById("firstNewPassword");
  const confirmEl = document.getElementById("firstConfirmPassword");
  const errorEl   = document.getElementById("firstPasswordError");
  const btn       = document.getElementById("firstPasswordSubmitBtn");

  // 送っているあいだは、Enter キーでも二重に送らない
  if (btn?.disabled) return;

  const next  = newInput?.value ?? "";
  const again = confirmEl?.value ?? "";

  if (errorEl) errorEl.textContent = "";

  const check = TumugiPassword.validateNewPassword({ current: tempPassword, next, confirm: again });
  if (!check.ok) {
    if (errorEl) errorEl.textContent = check.message;
    return;
  }

  // 二重に送らないよう、最初の await より前にボタンを押せなくする
  if (btn) {
    btn.disabled = true;
    btn.textContent = "変更中…";
  }

  try {
    const token = await getStoredToken();
    if (!token) {
      // トークンが期限切れ（または消えている）
      await clearAuth();
      returnToLoginStep("もう一度ログインしてください");
      return;
    }

    const res = await window.electronAPI.netServer({
      path: "/change_password.php",
      method: "POST",
      body: { current_password: tempPassword, new_password: next },
      token,
    });

    // 返事を待っているあいだに「やめる」が押されていたら、何もしない
    if (pendingTempPassword === null) return;

    if (!res.ok) {
      if (res.status === 401) {
        // サーバー側でトークンが無効になっている。保存したものも消して、1段目からやり直す
        await clearAuth();
        returnToLoginStep("もう一度ログインしてください");
        return;
      }
      if (errorEl) {
        errorEl.textContent = res.reason === "connection_refused"
          ? "サーバーに接続できませんでした。サーバーが起動しているか確認してください"
          : (res.data?.error || "パスワードを変えられませんでした");
      }
      return;
    }

    // 変えられた。仮のパスワードは使い終わったので消し、新しいパスワードから記憶の鍵を作ってチャットへ
    endPasswordChangeStep();
    try {
      await window.electronAPI.memoryUnlock(employeeId, next);
    } catch (e) {
      console.warn("[Memory] 記憶の鍵を作れませんでした:", e.message);
    }
    window.electronAPI.loginSuccess();
  } finally {
    // 2段目がまだ続いているとき（失敗したとき）だけ、ボタンを元に戻す。
    // 成功・401 のときは 2段目を終えているので、ボタンはそのまま（画面が切り替わる）
    if (pendingTempPassword !== null && btn) {
      btn.disabled = false;
      btn.textContent = "変えてはじめる";
    }
  }
}

// 「やめる」：サーバーのトークンを消してログイン画面に戻る（logout() が画面を読み直す）
function cancelPasswordChangeStep() {
  endPasswordChangeStep();
  return logout();
}

// =========================
// ログイン画面を開いているあいだの先読み
// Ollama にモデルを読み込ませ、安全判定の指示を読ませておく（js/ollama.js・js/safety.js）。
// 読ませた入力は Ollama のキャッシュに残るので、ログインのあとの1回目の判定は、足した分だけを処理すればよい。
// 呼ぶ側は待たない（ログインの操作を遅らせない）。止めることもしない。
// 失敗してもログインも会話もできるので、console.warn だけにして、例外は外に投げない。
// 会話の中身はない呼び出しだが、script.js の logTimings と同じく、console には語数と時間だけを出す
// =========================
async function prefetchOnLoginScreen() {
  try {
    const startedAt = performance.now();
    const res = await window.electronAPI.netOllama({
      path: "/api/chat",
      method: "POST",
      body: TumugiOllama.buildPrefillRequest(
        TumugiOllama.getOllamaModel(localStorage),
        [{ role: "system", content: TumugiSafety.CLASSIFY_INSTRUCTION }]
      ),
    });
    const wallMs = Math.round(performance.now() - startedAt);
    if (!res.ok) {
      console.warn("[Prefill] 先読み（ログイン画面）に失敗:", res.reason);
      return;
    }
    const t = TumugiOllama.readTimings(res.data);
    console.log(
      `[時間] 先読み（ログイン画面）：入力${t.promptTokens}語（処理${t.promptMs}ms）・出力${t.evalTokens}語（${t.evalMs}ms）・全体${wallMs}ms`
    );
  } catch (err) {
    console.warn("[Prefill] 先読み（ログイン画面）に失敗:", err?.message ?? err);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  // ログインボタン（CSP で HTML の onclick が動かないため、ここで登録する）
  const loginBtn = document.getElementById("loginSubmitBtn");
  if (loginBtn) {
    loginBtn.addEventListener("click", () => submitLogin());
    // auth.js はチャット画面でも読み込まれるので、ログインボタンがあるとき（ログイン画面）だけ先読みする。待たない
    prefetchOnLoginScreen();
  }

  const passInput = document.getElementById("loginPassword");
  if (passInput) {
    passInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitLogin();
      }
    });
  }

  // 2段目（新しいパスワードを決める）。ログイン画面以外にはこの要素がないので、あるときだけ登録する
  const firstSubmitBtn = document.getElementById("firstPasswordSubmitBtn");
  if (firstSubmitBtn) {
    firstSubmitBtn.addEventListener("click", () => submitPasswordChangeStep());
  }

  const firstCancelBtn = document.getElementById("firstPasswordCancelBtn");
  if (firstCancelBtn) {
    firstCancelBtn.addEventListener("click", () => cancelPasswordChangeStep());
  }

  const firstConfirmInput = document.getElementById("firstConfirmPassword");
  if (firstConfirmInput) {
    firstConfirmInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitPasswordChangeStep();
      }
    });
  }
});

// =========================
// 共通ヘルパー（index.html / admin-dashboard.html から利用）
// =========================

async function getStoredToken() {
  const token     = await window.electronAPI.storeGet(AUTH_TOKEN_KEY);
  const expiresAt = await window.electronAPI.storeGet(AUTH_EXPIRES_KEY);

  if (!token || !expiresAt) return null;

  const expiresDate = new Date(expiresAt.replace(" ", "T"));
  if (Number.isNaN(expiresDate.getTime()) || expiresDate.getTime() <= Date.now()) {
    return null;
  }
  return token;
}

// UI表示切替（管理者ボタンの表示/非表示）専用のヒント値。
// 実際の認可はサーバー側（requireAdmin()。includes/admin_guard.php）のDB照会で行われるため、
// この値はセキュリティ境界ではない。
async function getStoredIsAdmin() {
  const isAdmin = await window.electronAPI.storeGet(AUTH_IS_ADMIN_KEY);
  return !!isAdmin;
}

async function clearAuth() {
  await window.electronAPI.storeDelete(AUTH_TOKEN_KEY);
  await window.electronAPI.storeDelete(AUTH_EMPLOYEE_KEY);
  await window.electronAPI.storeDelete(AUTH_DEPARTMENT_KEY);
  await window.electronAPI.storeDelete(AUTH_IS_ADMIN_KEY);
  await window.electronAPI.storeDelete(AUTH_EXPIRES_KEY);
}

async function requireAuthOrRedirect() {
  const token = await getStoredToken();
  if (!token) {
    await clearAuth();
    window.electronAPI.logout();
    return null;
  }
  return token;
}

async function logout() {
  // 期限切れのトークンでも送るので、getStoredToken ではなく保存値を直接読む
  const token = await window.electronAPI.storeGet(AUTH_TOKEN_KEY);
  if (token) {
    // 返事は待たない（await しない）。中継は main.js で動くので、画面がログイン画面に
    // 切り替わっても送信は最後まで続く。サーバーが落ちていても、ログアウトはすぐ終わる
    // （その場合、サーバーのトークンは期限まで残る）
    window.electronAPI.netServer({ path: "/logout.php", method: "POST", token }).catch(() => {});
  }
  await clearAuth();
  window.electronAPI.logout();
}