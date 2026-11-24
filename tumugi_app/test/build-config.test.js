// =========================================
// test/build-config.test.js
// 配る形（electron-builder）のビルドの対象（package.json の build.files）のテスト（実行：npm test）
// レビューの A9・E1：ないファイルを指していないか、自作のモジュールなどが読むファイルの付け忘れがないか、
// node_modules（electron-store とフォント）を除いていないかを見る。
// 付け忘れると、開発（npm start）では動くのに、配る形だけが動かなくなるため。
// =========================================

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("fs");
const path   = require("path");
const { builtinModules } = require("module");

const appDir = path.join(__dirname, "..");
const pkg    = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8"));
const files  = pkg.build.files;

// パターン（! で始まる除外や、* などを含むもの）でない、ファイルそのものの名前
const plainFiles = files.filter((entry) => !entry.startsWith("!") && !/[*?{}[\]]/.test(entry));
// 自作のモジュール（アプリのフォルダの直下の .js。今は、1つずつ名前で書いている）
const ownModules = plainFiles.filter((entry) => entry.endsWith(".js"));
const readSource = (name) => fs.readFileSync(path.join(appDir, name), "utf8");

// require("…") で読む名前を、すべて取り出す
function requiredNames(source) {
  return [...source.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
}

test("build.files: 書いたファイルと、Windows のアイコンが、すべてある", () => {
  assert.ok(plainFiles.length > 0);
  for (const entry of [...plainFiles, pkg.build.win.icon]) {
    assert.ok(fs.existsSync(path.join(appDir, entry)), `${entry} がない`);
  }
});

test("build.files: 自作のモジュールが読むファイル・preload・開く HTML が、すべて入っている", () => {
  // モジュールどうしの読み込み（ipc-guard.js → net-policy.js など）も含める
  const local = ownModules.flatMap((name) =>
    requiredNames(readSource(name))
      .filter((req) => req.startsWith("./"))
      .map((req) => path.posix.normalize(req).replace(/(\.js)?$/, ".js"))
  );
  const mainSource = readSource("main.js");
  const preloads = [...mainSource.matchAll(/preload: path\.join\(__dirname, "([^"]+)"\)/g)].map((m) => m[1]);
  const pages    = [...mainSource.matchAll(/loadFile\("([^"]+)"\)/g)].map((m) => m[1]);

  // main.js の書き方が変わって、1つも拾えないまま通るのを防ぐ
  assert.ok(local.length >= 5, `自作のモジュールの読み込みが ${local.length} 個しか見つからない`);
  assert.ok(preloads.includes("preload.js"), "main.js の preload が見つからない");
  assert.ok(pages.length >= 3, `開く HTML が ${pages.length} 個しか見つからない`);

  for (const name of new Set([...local, ...preloads, ...pages])) {
    assert.ok(files.includes(name), `${name} が build.files にない`);
  }
});

test("build.files: node_modules を除かず、動いているときに読むパッケージは dependencies にある", () => {
  for (const entry of files) {
    assert.ok(!(entry.startsWith("!") && entry.includes("node_modules")), `${entry} で node_modules を除いている`);
  }

  // electron-builder が配る形に入れるのは dependencies だけ（devDependencies は入らない）
  const fromModules = ownModules.flatMap((name) =>
    requiredNames(readSource(name)).filter((req) =>
      !req.startsWith(".") && req !== "electron" && !builtinModules.includes(req.replace(/^node:/, "")))
  );
  const cssDir  = path.join(appDir, "css");
  const fromCss = fs.readdirSync(cssDir)
    .filter((name) => name.endsWith(".css"))
    .flatMap((name) => [...fs.readFileSync(path.join(cssDir, name), "utf8")
      .matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)].map((m) => m[1]));

  // 今は electron-store とフォントのはず（拾えていることも確かめる）
  assert.ok(fromModules.includes("electron-store"), "main.js の electron-store が見つからない");
  assert.ok(fromCss.includes("@fontsource/biz-udpgothic"), "css のフォントが見つからない");
  for (const name of new Set([...fromModules, ...fromCss])) {
    assert.ok(pkg.dependencies?.[name], `${name} が dependencies にない`);
  }
});
