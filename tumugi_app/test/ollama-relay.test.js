// =========================================
// test/ollama-relay.test.js
// ollama-relay.js の単体テスト（実行：npm test）
// =========================================

const test   = require("node:test");
const assert = require("node:assert/strict");

const { CPU_ONLY_OPTIONS, withRelayOptions, createLineSplitter } = require("../ollama-relay");

// -----------------------------------------
// withRelayOptions
// -----------------------------------------
test("withRelayOptions: 何も付けないときは、中身の同じ別のオブジェクトを返す", () => {
  const body = { model: "gemma4:e4b", stream: false, options: { num_ctx: 8192 } };
  for (const settings of [undefined, {}, { keepAlive: null, cpuOnly: false }]) {
    const result = withRelayOptions(body, settings);
    assert.deepEqual(result, body);
    assert.notEqual(result, body);
  }
});

test("withRelayOptions: 展示モードでは keep_alive を付ける", () => {
  const result = withRelayOptions({ model: "gemma4:e4b" }, { keepAlive: "60m", cpuOnly: false });
  assert.equal(result.keep_alive, "60m");
});

test("withRelayOptions: CPU だけのときは num_gpu 0・num_thread 4 を足し、ほかの options は残す", () => {
  const result = withRelayOptions(
    { model: "gemma4:e4b", options: { num_ctx: 8192, temperature: 0.75 } },
    { keepAlive: null, cpuOnly: true }
  );
  assert.deepEqual(result.options, { num_ctx: 8192, temperature: 0.75, num_gpu: 0, num_thread: 4 });
  assert.deepEqual(CPU_ONLY_OPTIONS, { num_gpu: 0, num_thread: 4 });
});

test("withRelayOptions: 両方を一緒に付けられ、渡した body は変えない", () => {
  const body = { model: "gemma4:e4b", options: { num_ctx: 8192 } };
  const before = JSON.stringify(body);
  const result = withRelayOptions(body, { keepAlive: "60m", cpuOnly: true });
  assert.equal(JSON.stringify(body), before);
  assert.equal(result.keep_alive, "60m");
  assert.deepEqual(result.options, { num_ctx: 8192, num_gpu: 0, num_thread: 4 });
});

test("withRelayOptions: オブジェクトでない body は、そのまま返す", () => {
  const settings = { keepAlive: "60m", cpuOnly: true };
  assert.equal(withRelayOptions(undefined, settings), undefined);
  assert.equal(withRelayOptions("x", settings), "x");
});

// -----------------------------------------
// createLineSplitter
// -----------------------------------------
test("createLineSplitter: かけらの境目で切れた行は、次のかけらとつなぐ", () => {
  const splitter = createLineSplitter();
  assert.deepEqual(splitter.push('{"a":1}\n{"b"'), ['{"a":1}']);
  assert.deepEqual(splitter.push(":2}\n"), ['{"b":2}']);
  assert.deepEqual(splitter.push("\r\n\n"), []);
  assert.deepEqual(splitter.push('{"c":3}'), []);
  assert.deepEqual(splitter.flush(), ['{"c":3}']);
});
