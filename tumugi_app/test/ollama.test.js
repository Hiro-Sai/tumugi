// =========================================
// test/ollama.test.js
// js/ollama.js の単体テスト（実行：npm test）
// =========================================

const test   = require("node:test");
const assert = require("node:assert/strict");

const {
  NUM_CTX, getOllamaModel, buildPrefillRequest, readTimings, hasModel, isModelMissing,
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

// -----------------------------------------
// hasModel（起動時に、使うモデルが Ollama に入っているかを確かめる）
// 渡すのは /api/tags の答え（{ models: [{ name, model, ... }] }）
// -----------------------------------------
test("hasModel: 使うモデルと同じ名前があれば true（name がなければ model で比べる）", () => {
  assert.equal(hasModel({ models: [{ name: "qwen3.5:4b" }, { name: "gemma4:e4b" }] }, "gemma4:e4b"), true);
  assert.equal(hasModel({ models: [{ model: "gemma4:e4b" }] }, "gemma4:e4b"), true);
});

test("hasModel: 名前の前のほうが同じだけのモデルしかなければ false", () => {
  const tags = {
    models: [{ name: "gemma4:e2b" }, { name: "gemma:2b" }, { name: "gemma4:e4b-it-qat" }, { name: "gemma4:latest" }],
  };
  assert.equal(hasModel(tags, "gemma4:e4b"), false);
});

test("hasModel: 大文字と小文字は区別しない（Ollama と同じ）", () => {
  assert.equal(hasModel({ models: [{ name: "gemma4:e4b" }] }, "GEMMA4:E4B"), true);
  assert.equal(hasModel({ models: [{ name: "hf.co/Org/Model-GGUF:Q4_K_M" }] }, "hf.co/org/model-gguf:q4_k_m"), true);
});

test("hasModel: タグのない名前は latest として比べる（ホスト名の「:」はタグにしない）", () => {
  const tags = { models: [{ name: "someone/model-x:latest" }, { name: "localhost:5000/model-y:latest" }] };
  assert.equal(hasModel(tags, "someone/model-x"), true);
  assert.equal(hasModel(tags, "localhost:5000/model-y"), true);
  assert.equal(hasModel(tags, "model-x"), false); // 名前空間が違う
  assert.equal(hasModel({ models: [{ name: "gemma4:e4b" }] }, "gemma4"), false); // gemma4 は gemma4:latest のこと
});

test("hasModel: 一覧やモデル名が読めないときは false", () => {
  const tags = { models: [{ name: "gemma4:e4b" }] };
  assert.equal(hasModel({ models: [] }, "gemma4:e4b"), false);
  assert.equal(hasModel({}, "gemma4:e4b"), false);
  assert.equal(hasModel(null, "gemma4:e4b"), false);
  assert.equal(hasModel({ models: "gemma4:e4b" }, "gemma4:e4b"), false);
  assert.equal(hasModel({ models: [null, {}, { name: 1 }] }, "gemma4:e4b"), false);
  assert.equal(hasModel(tags, ""), false);
  assert.equal(hasModel(tags, undefined), false);
});

// -----------------------------------------
// isModelMissing（話しかけたときの失敗が、モデルが入っていないためかを見分ける）
// -----------------------------------------
test("isModelMissing: Ollama が 404 を返したときだけ true", () => {
  assert.equal(isModelMissing({ ok: false, reason: "http_error", status: 404 }), true);
  // 返事の呼び出しが投げる例外（Ollama の答えの reason と status を写したもの）
  const err = Object.assign(new Error("ollama_error"), { reason: "http_error", status: 404 });
  assert.equal(isModelMissing(err), true);

  assert.equal(isModelMissing({ ok: false, reason: "http_error", status: 500 }), false);
  assert.equal(isModelMissing({ ok: false, reason: "connection_refused" }), false);
  assert.equal(isModelMissing({ ok: false, reason: "forbidden" }), false);
  assert.equal(isModelMissing(null), false);
  assert.equal(isModelMissing(undefined), false);
});
