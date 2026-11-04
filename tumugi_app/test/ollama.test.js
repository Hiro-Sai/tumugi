// =========================================
// test/ollama.test.js
// js/ollama.js の単体テスト（実行：npm test）
// =========================================

const test   = require("node:test");
const assert = require("node:assert/strict");

const {
  NUM_CTX, getOllamaModel, buildPrefillRequest, readTimings,
} = require("../js/ollama");

// -----------------------------------------
// getOllamaModel
// -----------------------------------------
test("getOllamaModel: 保存したモデル名を使う", () => {
  assert.equal(getOllamaModel({ getItem: () => "gemma4:e2b" }), "gemma4:e2b");
});

test("getOllamaModel: 保存がない・空・storage がない・読めないときは gemma4:e4b", () => {
  assert.equal(getOllamaModel({ getItem: () => null }), "gemma4:e4b");
  assert.equal(getOllamaModel({ getItem: () => "" }), "gemma4:e4b");
  assert.equal(getOllamaModel(undefined), "gemma4:e4b");
  assert.equal(getOllamaModel({ getItem: () => { throw new Error("読めない"); } }), "gemma4:e4b");
});

// -----------------------------------------
// buildPrefillRequest
// -----------------------------------------
test("buildPrefillRequest: 1語だけ書かせ、num_ctx は 8192", () => {
  const messages = [
    { role: "system", content: "指示" },
    { role: "user", content: "今日も疲れた" },
    { role: "assistant", content: "{\"emotion\":\"normal\",\"line\":\"" },
  ];
  const body = buildPrefillRequest("gemma4:e4b", messages);

  assert.equal(NUM_CTX, 8192);
  assert.equal(body.model, "gemma4:e4b");
  assert.equal(body.options.num_ctx, 8192);
  assert.equal(body.options.num_predict, 1);
  assert.equal(body.think, false);
  assert.equal(body.stream, false);
  assert.deepEqual(body.messages, messages);
});

// -----------------------------------------
// readTimings
// -----------------------------------------
test("readTimings: ナノ秒をミリ秒に直す", () => {
  const data = {
    prompt_eval_count: 1206, prompt_eval_duration: 16_479_000_000,
    eval_count: 30,          eval_duration: 2_100_400_000,
  };
  assert.deepEqual(readTimings(data), { promptTokens: 1206, promptMs: 16479, evalTokens: 30, evalMs: 2100 });
});

test("readTimings: 欄がなければ0", () => {
  const zero = { promptTokens: 0, promptMs: 0, evalTokens: 0, evalMs: 0 };
  assert.deepEqual(readTimings({}), zero);
  assert.deepEqual(readTimings(undefined), zero);
});
