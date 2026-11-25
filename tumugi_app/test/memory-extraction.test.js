// =========================================
// test/memory-extraction.test.js
// 記憶の抽出のあいだに記憶が変わったら、その回の結果を入れないことのテスト（レビューの E5。実行：npm test）
// 抽出（js/script.js の extractAndSaveMemory）は、始める前の記憶の写しに足して保存する。Ollama を待つあいだに、
// 本人が記憶の画面で直した・削除した・全部忘れた分を元に戻さないよう、記憶が変わった回数（memoryRevision）を比べる。
// script.js は画面の中でしか動かないので、ソースの並びで確かめる。
// =========================================

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("fs");
const path   = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "js", "script.js"), "utf8");

// トップレベルの関数を1つ、宣言の行から行頭の「}」までで返す
function topLevelFunction(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, `${name} が見つからない`);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}

// pos を中に含むトップレベルの関数を返す
function enclosingFunction(pos) {
  const start = Math.max(source.lastIndexOf("\nfunction ", pos), source.lastIndexOf("\nasync function ", pos)) + 1;
  return source.slice(start, source.indexOf("\n}", pos) + 2);
}

test("記憶の抽出は、Ollama を待つ前に回数を覚え、待ったあと・保存の前に比べる", () => {
  const body = topLevelFunction("extractAndSaveMemory");
  const remember = body.indexOf("const startRevision = memoryRevision;");
  const wait     = body.indexOf("await window.electronAPI.netOllama(");
  const compare  = body.indexOf("if (memoryRevision !== startRevision)");
  const save     = body.indexOf("saveMemory(newMemory);");
  assert.ok(remember >= 0, "始めるときに回数を覚えていない");
  assert.ok(wait > remember, "回数を覚える前に、Ollama を待っている");
  assert.ok(compare > wait, "Ollama を待ったあとに、回数を比べていない");
  assert.ok(save > compare, "回数を比べる前に、保存している");
  assert.ok(!body.slice(compare, save).includes("await"), "比べてから保存するまでのあいだに、待っている");
  assert.equal(body.split("saveMemory(").length - 1, 1, "保存は1か所だけ");
});

test("記憶（userMemory）を変える関数は、どれも回数（memoryRevision）を1つ増やす", () => {
  // userMemory は置きかえる（userMemory = …）だけで、中を直接書きかえない
  assert.doesNotMatch(source, /userMemory\s*(?:\[|\.[^\s(]+\s*=(?!=))|delete\s+userMemory|Object\.assign\(\s*userMemory/);

  const assigns = [...source.matchAll(/^[ \t]+userMemory\s*=(?!=)/gm)];
  // 読み込み（loadMemoryFromStore）・保存（saveMemory）・全部忘れる（resetAllMemory）の3か所。
  // 読み方が変わって、1つも拾えないまま通るのを防ぐ
  assert.ok(assigns.length >= 3, `userMemory を置きかえる所が ${assigns.length} か所しか見つからない`);
  for (const m of assigns) {
    const body = enclosingFunction(m.index);
    const name = body.match(/function (\w+)\(/)?.[1] ?? "（名前が分からない関数）";
    assert.ok(body.includes("memoryRevision += 1;"), `${name} が、記憶を置きかえるのに回数を増やしていない`);
  }
});
