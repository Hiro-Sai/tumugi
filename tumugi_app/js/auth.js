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

  if (!res.ok) {
    if (errorEl) {
      errorEl.textContent = res.reason === "connection_refused"
        ? "サーバーに接続できませんでした。サーバーが起動しているか確認してください"
        : (res.data?.error || "ログインに失敗しました");
    }
    if (btn) {
      btn.disabled = false;
      btn.textContent = "ログイン";
    }
    return;
  }

  const data = res.data;

  await window.electronAPI.storeSet(AUTH_TOKEN_KEY, data.token);
  await window.electronAPI.storeSet(AUTH_EMPLOYEE_KEY, data.employee_id);
  await window.electronAPI.storeSet(AUTH_DEPARTMENT_KEY, data.department);
  await window.electronAPI.storeSet(AUTH_IS_ADMIN_KEY, !!data.is_admin);
  await window.electronAPI.storeSet(AUTH_EXPIRES_KEY, data.expires_at);

  // つむぎの記憶の鍵を、入力されたパスワードから作る（main.js・memory-crypto.js）。
  // 失敗しても会話はできるので、ログインは続ける（その場合、記憶は読み書きされない）
  try {
    await window.electronAPI.memoryUnlock(data.employee_id, password);
  } catch (e) {
    console.warn("[Memory] 記憶の鍵を作れませんでした:", e.message);
  }

  window.electronAPI.loginSuccess();
}

document.addEventListener("DOMContentLoaded", () => {
  // ログインボタン（CSP で HTML の onclick が動かないため、ここで登録する）
  const loginBtn = document.getElementById("loginSubmitBtn");
  if (loginBtn) {
    loginBtn.addEventListener("click", () => submitLogin());
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
// 実際の認可はサーバー側（dashboard_data.php）のDB照会で行われるため、
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
  await clearAuth();
  window.electronAPI.logout();
}