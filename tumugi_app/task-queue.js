// =========================================
// task-queue.js
// 順番待ち：入れた操作を、入れた順に1つずつ行う（前の操作が終わるまで、次の操作を始めない）。
// main.js が、ストアの読み書き（OS の暗号化・復号を含む）を途中で入りまじらせないために使う。
// Electron に依存しない関数だけを置き、main.js とテスト（test/task-queue.test.js）から使う。
// =========================================

// 戻り値は run(task)。task は同期の関数でも、非同期の関数でもよい。
// run は task の結果を返す（失敗したときは、その失敗を返す）。1つが失敗しても、次の操作は行う。
function createTaskQueue() {
  let last = Promise.resolve();
  return function run(task) {
    const result = last.then(() => task());
    last = result.catch(() => {});
    return result;
  };
}

module.exports = { createTaskQueue };
