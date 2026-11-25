// =========================================
// test/console-log.test.js
// アプリの JS の console に、社員の気持ち・発言・記憶・パスワード・トークンを渡していないかのテスト
// （レビューの E6。実行：npm test）
// console の呼び出しの引数から、文字列の中身を除いた名前（変数・プロパティ）を拾い、下の一覧と照らす。
// 名前で見るので、一覧にない名前の変数で渡すのは防げない（付け忘れ・戻し忘れの見張り）。
// =========================================

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("fs");
const path   = require("path");

const appDir = path.join(__dirname, "..");

// console に渡さない名前
const SENSITIVE_NAMES = [
  // 気持ちと安全の判定（感情ログに送る値と、サーバーの返事のスコア）
  "emotion", "userEmotion", "currentEmotion", "isCrisis", "crisis", "harassment", "harassmentType",
  "safety", "record", "score",
  // 発言・返事・会話の履歴
  "userText", "text", "reply", "content", "line", "share", "question", "messages", "history",
  // つむぎの記憶
  "memory", "userMemory", "facts",
  // サーバーの返事（中身をまるごと出さない）
  "data",
  // パスワードとトークン
  "password", "newPassword", "currentPassword", "token",
];

// 引用符の文字列（'…' か "…"）を飛ばし、閉じた引用符の次の位置を返す
function skipQuoted(source, i) {
  const quote = source[i];
  for (i++; i < source.length && source[i] !== quote; i++) {
    if (source[i] === "\\") i++;
  }
  return i + 1;
}

// pos から、対応する閉じ括弧（close）の手前までを読み、文字列の中身を除いたコードと、閉じ括弧の次の位置を返す。
// テンプレート（`…`）は、${…} の中だけをコードとして読む
function readUntilClose(source, pos, close) {
  const opens = { "(": ")", "[": "]", "{": "}" };
  const stack = [close];
  let code = "";
  let i = pos;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      i = skipQuoted(source, i);
      code += " ";
    } else if (ch === "`") {
      for (i++; i < source.length && source[i] !== "`"; ) {
        if (source[i] === "\\") {
          i += 2;
        } else if (source[i] === "$" && source[i + 1] === "{") {
          const inner = readUntilClose(source, i + 2, "}");
          code += ` ${inner.code} `;
          i = inner.end;
        } else {
          i++;
        }
      }
      i++; // 閉じの `
      code += " ";
    } else {
      if (opens[ch]) {
        stack.push(opens[ch]);
      } else if (ch === stack[stack.length - 1]) {
        stack.pop();
        if (stack.length === 0) return { code, end: i + 1 };
      }
      code += ch;
      i++;
    }
  }
  throw new Error(`閉じ括弧（${close}）が見つからない`);
}

// console の呼び出しごとに、引数で使っている名前の一覧を返す
function consoleArgNames(source) {
  const calls = [];
  for (const m of source.matchAll(/\bconsole\.(?:log|info|warn|error|debug|trace|table|dir)\s*\(/g)) {
    const { code } = readUntilClose(source, m.index + m[0].length, ")");
    calls.push(code.match(/[A-Za-z_$][\w$]*/g) ?? []);
  }
  return calls;
}

test("console の引数の読み方：文字列の中は見ず、テンプレートの ${…} の中と、何行かにまたがる呼び出しは見る", () => {
  const sample = [
    'console.log("[a] emotion（やあ）(x)", first);',
    "console.warn(`[b] ${second.score} (y)`, 'token', \"it's\");",
    "console.error(",
    '  "[c] " +',
    "  third(fourth)",
    ");",
    "myconsole.log(fifth);",
    "console.info(`[d] ${`${sixth}`}`);",
  ].join("\n");
  assert.deepEqual(consoleArgNames(sample), [
    ["first"],
    ["second", "score"],
    ["third", "fourth"],
    ["sixth"],
  ]);
});

test("アプリの JS の console に、気持ち・発言・記憶・パスワード・トークンを入れる名前を渡さない", () => {
  const files = [
    ...fs.readdirSync(appDir).filter(name => name.endsWith(".js")),
    ...fs.readdirSync(path.join(appDir, "js")).filter(name => name.endsWith(".js")).map(name => `js/${name}`),
  ];

  let count = 0;
  for (const file of files) {
    const source = fs.readFileSync(path.join(appDir, file), "utf8");
    for (const names of consoleArgNames(source)) {
      count++;
      const found = names.filter(name => SENSITIVE_NAMES.includes(name));
      assert.deepEqual(found, [], `${file} の console に渡している: ${found.join("・")}`);
    }
  }
  // 読み方が変わって、1つも拾えないまま通るのを防ぐ（2026-11-25 の時点で55個ほど）
  assert.ok(count >= 40, `console の呼び出しが ${count} 個しか見つからない`);
});
