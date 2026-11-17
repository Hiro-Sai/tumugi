"use strict";
// =========================================
// サーバーのテストで共通に使う関数。
// 向き先は、テスト用の環境（compose.test.yaml）の 127.0.0.1:8082 だけ。
// =========================================
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

// デモ（8080）の DB を壊さないため、向き先はここに固定する。環境変数では変えられない
const BASE_URL = "http://127.0.0.1:8082/api";
const ALLOWED_BASE_URL = "http://127.0.0.1:8082/api";
if (BASE_URL !== ALLOWED_BASE_URL) {
  throw new Error(`向き先が ${ALLOWED_BASE_URL} ではないので、テストを始めません: ${BASE_URL}`);
}

// リポジトリの直下（docker compose を動かす場所）
const REPO_ROOT = path.resolve(__dirname, "../..");

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// API を呼ぶ。→ { status, json }（JSON でない本文は json: null）
// body はオブジェクトなら JSON にして送る。文字列ならそのまま送る
async function api(method, apiPath, { body, token } = {}) {
  const headers = {};
  if (token !== undefined && token !== null) {
    headers.Authorization = `Bearer ${token}`;
  }
  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await fetch(BASE_URL + apiPath, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

// fixture.php に命令（の配列）を渡して、結果の配列を受け取る
function fixture(commands) {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "-f",
      "compose.test.yaml",
      "exec",
      "-T",
      "app",
      "php",
      "/var/www/tumugi-test-tools/fixture.php",
    ],
    { cwd: REPO_ROOT, input: JSON.stringify(commands), encoding: "utf8", timeout: 60000 }
  );
  if (result.error) {
    throw new Error(`fixture を呼べませんでした: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`fixture が失敗しました（終了コード ${result.status}）: ${result.stderr}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`fixture の結果が JSON ではありません: ${result.stdout}`);
  }
}

// 5つのテーブルを空にする
function resetDb() {
  return fixture([{ op: "reset" }]);
}

// 英数字の乱数（パスワード・違うパスワード・知らないトークン用）
function randomValue(length = 16) {
  let value = "";
  for (let i = 0; i < length; i += 1) {
    value += ALPHANUMERIC[crypto.randomInt(ALPHANUMERIC.length)];
  }
  return value;
}

// テスト用の環境が立っているか確かめる（応答があればよい。中身は見ない）
async function ensureEnvironment() {
  try {
    await fetch(`${BASE_URL}/login.php`, { method: "POST" });
  } catch {
    throw new Error(
      "テスト用の環境が立っていません。docker compose -f compose.test.yaml up -d --build --wait"
    );
  }
}

// ログインして token を返す。200 でなければ throw
async function loginAs(code, pw) {
  const res = await api("POST", "/login.php", {
    body: { employee_code: code, password: pw },
  });
  if (res.status !== 200 || !res.json || !res.json.token) {
    throw new Error(`ログインできませんでした（${code}）: status=${res.status}`);
  }
  return res.json.token;
}

// 管理者を1人入れる → { code, pw }
function seedAdmin(code = "A001") {
  const pw = randomValue();
  fixture([{ op: "add_employee", code, department: "管理部", pw, is_admin: true }]);
  return { code, pw };
}

// 社員をまとめて入れる（fixture を1回だけ呼ぶ）→ [{ code, pw }]
// 番号は prefix + 3桁の連番（E001, E002, …）。logs は、全員に同じログを入れる配列（省略できる）。
// 速さのため、パスワードは全員同じ値（1回の呼び出しの中で）
function seedEmployees(
  count,
  { prefix = "E", department = "営業部", isNewGrad = false, logs = [] } = {}
) {
  const pw = randomValue();
  const employees = [];
  const commands = [];
  for (let i = 1; i <= count; i += 1) {
    const code = `${prefix}${String(i).padStart(3, "0")}`;
    employees.push({ code, pw });
    commands.push({ op: "add_employee", code, department, pw, is_new_grad: isNewGrad });
    if (logs.length > 0) {
      commands.push({ op: "add_logs", code, logs });
    }
  }
  if (commands.length > 0) {
    fixture(commands);
  }
  return employees;
}

module.exports = {
  BASE_URL,
  api,
  fixture,
  resetDb,
  randomValue,
  ensureEnvironment,
  loginAs,
  seedAdmin,
  seedEmployees,
};
