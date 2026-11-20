"use strict";
// API の入り口（includes/db.php の startApi）：ほかのウェブページから呼べないこと（レビューの B2）
// - CORS の許し（Access-Control-Allow-*）を返さない。OPTIONS（ブラウザの事前の確かめ）にも 204 を返さない
// - Content-Type が application/json でない POST は、DB に触れる前に 415 で断る。
//   ブラウザは、text/plain・フォームの形・Content-Type なしなら、サーバーの許しがなくても、ほかのページから POST を送れるため
const { test, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { BASE_URL, api, fixture, resetDb, randomValue, ensureEnvironment } = require("./helpers");

before(ensureEnvironment);
beforeEach(resetDb);

// helpers の api と違い、Content-Type などのヘッダーを、指定したとおりに送る
async function raw(method, apiPath, { headers = {}, body } = {}) {
  const res = await fetch(BASE_URL + apiPath, { method, headers, body });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

// 社員を1人入れて、パスワードを返す
function addEmployee(code) {
  const pw = randomValue();
  fixture([{ op: "add_employee", code, department: "営業部", pw }]);
  return pw;
}

function assertNoCors(res, label) {
  assert.equal(res.headers.get("access-control-allow-origin"), null, label);
  assert.equal(res.headers.get("access-control-allow-methods"), null, label);
  assert.equal(res.headers.get("access-control-allow-headers"), null, label);
}

test("応答に CORS の許し（Access-Control-Allow-Origin など）が付かない", async () => {
  const pw = addEmployee("E001");
  const get = await raw("GET", "/dashboard_data.php");
  const post = await raw("POST", "/login.php", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ employee_code: "E001", password: pw }),
  });

  assert.equal(get.status, 401);
  assert.equal(post.status, 200);
  assertNoCors(get, "GET");
  assertNoCors(post, "POST");
});

test("OPTIONS（ブラウザの事前の確かめ）に、204 も CORS の許しも返さない", async () => {
  for (const apiPath of ["/login.php", "/save_emotion.php", "/dashboard_data.php"]) {
    const res = await raw("OPTIONS", apiPath, {
      headers: {
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type",
      },
    });
    assert.notEqual(res.status, 204, apiPath);
    assertNoCors(res, apiPath);
  }
});

test("JSON でない POST は 415 で断り、ログインの失敗にも数えない（ほかのページから他人をロックさせない）", async () => {
  const pw = addEmployee("E001");
  // 本文はバイト列で送る（文字列だと、fetch が text/plain を付けてしまい、Content-Type なしを試せないため）
  const wrong = new TextEncoder().encode(
    JSON.stringify({ employee_code: "E001", password: `wrong-${randomValue()}` })
  );
  // ブラウザが、サーバーの許しなしに、ほかのページから送れる形
  const headerSets = [
    { "Content-Type": "text/plain" },
    { "Content-Type": "application/x-www-form-urlencoded" },
    { "Content-Type": "multipart/form-data; boundary=x" },
    {}, // Content-Type なし
  ];
  // 形ごとに2回、合わせて8回（ロックがかかる5回を超える）
  for (const headers of headerSets) {
    for (let i = 0; i < 2; i += 1) {
      const res = await raw("POST", "/login.php", { headers, body: wrong });
      assert.equal(res.status, 415, JSON.stringify(headers));
    }
  }

  assert.deepEqual(fixture([{ op: "read_auth", code: "E001" }])[0], {
    tokens: 0,
    failed_attempts: 0,
    succeeded_attempts: 0,
  });
  // ロックされていないので、正しいパスワードでログインできる
  const ok = await api("POST", "/login.php", { body: { employee_code: "E001", password: pw } });
  assert.equal(ok.status, 200);
});

test("Content-Type は、charset が付いていても、大文字でも、JSON として受け付ける", async () => {
  const pw = addEmployee("E001");
  for (const type of ["application/json; charset=utf-8", "Application/JSON"]) {
    const res = await raw("POST", "/login.php", {
      headers: { "Content-Type": type },
      body: JSON.stringify({ employee_code: "E001", password: pw }),
    });
    assert.equal(res.status, 200, type);
  }
});
