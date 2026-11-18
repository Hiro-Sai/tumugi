// =========================================
// test/task-queue.test.js
// task-queue.js の単体テスト（実行：npm test）
// =========================================

const test   = require("node:test");
const assert = require("node:assert/strict");

const { createTaskQueue } = require("../task-queue");

// 外から終わらせられる Promise（前の操作が、まだ終わっていない状態を作る）
function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

test("createTaskQueue: 後から入れた操作は、前の操作が終わるまで始まらない", async () => {
  const run = createTaskQueue();
  const order = [];
  const gate = deferred();

  const first = run(async () => {
    order.push("1つ目が始まった");
    await gate.promise;
    order.push("1つ目が終わった");
  });
  const second = run(() => {
    order.push("2つ目が始まった");
  });

  // 1つ目が待っているあいだは、2つ目が始まっていないこと
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ["1つ目が始まった"]);

  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["1つ目が始まった", "1つ目が終わった", "2つ目が始まった"]);
});

test("createTaskQueue: 操作の戻り値を返す（同期の関数でも、非同期の関数でも）", async () => {
  const run = createTaskQueue();
  assert.equal(await run(() => 1), 1);
  assert.equal(await run(async () => 2), 2);
});

test("createTaskQueue: 前の操作が失敗しても次の操作は行い、失敗は呼んだ側に返る", async () => {
  const run = createTaskQueue();
  const failed = run(async () => { throw new Error("書けなかった"); });
  const next   = run(() => "次の操作");

  await assert.rejects(failed, /書けなかった/);
  assert.equal(await next, "次の操作");
});

test("createTaskQueue: 同期の関数が投げた失敗も、呼んだ側に返る", async () => {
  const run = createTaskQueue();
  await assert.rejects(run(() => { throw new Error("同期の失敗"); }), /同期の失敗/);
  assert.equal(await run(() => "続く"), "続く");
});
