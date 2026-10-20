// =========================================
// test/memory-crypto.test.js
// memory-crypto.js の単体テスト（実行：npm test）
// =========================================

const test   = require("node:test");
const assert = require("node:assert/strict");

const { newSalt, deriveMemoryKey, encryptMemory, decryptMemory, reencryptMemory } = require("../memory-crypto");

const MEMORY = { "名前": "たろう", "最近の気分": "上司との関係で少し疲れている" };

test("暗号化して復号すると元に戻り、レコードに記憶の中身は残らない", async () => {
  const salt   = newSalt();
  const key    = await deriveMemoryKey("pass-1234", salt);
  const record = encryptMemory(key, salt, MEMORY);

  assert.deepEqual(decryptMemory(key, record), MEMORY);
  assert.ok(!JSON.stringify(record).includes("たろう"));
});

test("別のパスワードで作った鍵では読めない（パスワードをリセットした場合）", async () => {
  const salt   = newSalt();
  const record = encryptMemory(await deriveMemoryKey("pass-1234", salt), salt, MEMORY);
  const otherKey = await deriveMemoryKey("pass-9999", salt);

  assert.throws(() => decryptMemory(otherKey, record));
});

test("書き換えられたレコードは読めない", async () => {
  const salt   = newSalt();
  const key    = await deriveMemoryKey("pass-1234", salt);
  const record = encryptMemory(key, salt, MEMORY);
  const data   = Buffer.from(record.data, "base64");
  data[0] ^= 0x01;

  assert.throws(() => decryptMemory(key, { ...record, data: data.toString("base64") }));
});

test("認証タグを短く切り詰めたレコードは読めない", async () => {
  const salt   = newSalt();
  const key    = await deriveMemoryKey("pass-1234", salt);
  const record = encryptMemory(key, salt, MEMORY);
  const shortTag = Buffer.from(record.tag, "base64").subarray(0, 4).toString("base64");

  assert.throws(() => decryptMemory(key, { ...record, tag: shortTag }));
});

test("同じ記憶でも、暗号化するたびに違う暗号文になる", async () => {
  const salt = newSalt();
  const key  = await deriveMemoryKey("pass-1234", salt);
  const a = encryptMemory(key, salt, MEMORY);
  const b = encryptMemory(key, salt, MEMORY);

  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.data, b.data);
});

test("同じパスワードでも、ソルトが違えば鍵も違う", async () => {
  const a = await deriveMemoryKey("pass-1234", newSalt());
  const b = await deriveMemoryKey("pass-1234", newSalt());

  assert.equal(a.length, 32);
  assert.ok(!a.equals(b));
});

// -----------------------------------------
// パスワードを変えたときの、記憶の鍵の付け替え
// -----------------------------------------
async function oldAndNew() {
  const oldSalt = newSalt();
  const oldKey  = await deriveMemoryKey("old-pass-1", oldSalt);
  const newSaltValue = newSalt();
  const newKey  = await deriveMemoryKey("new-pass-2", newSaltValue);
  return { oldSalt, oldKey, newSaltValue, newKey, record: encryptMemory(oldKey, oldSalt, MEMORY) };
}

test("付け替えたレコードは、新しい鍵で読めて、中身は同じ", async () => {
  const { oldKey, newSaltValue, newKey, record } = await oldAndNew();
  const moved = reencryptMemory(oldKey, record, newKey, newSaltValue);

  assert.equal(moved.salt, newSaltValue);
  assert.deepEqual(decryptMemory(newKey, moved), MEMORY);
});

test("付け替えたレコードは、古い鍵では読めない", async () => {
  const { oldKey, newSaltValue, newKey, record } = await oldAndNew();
  const moved = reencryptMemory(oldKey, record, newKey, newSaltValue);

  assert.throws(() => decryptMemory(oldKey, moved));
});

test("違う鍵を古い鍵として渡すと、例外になる", async () => {
  const { oldSalt, newSaltValue, newKey, record } = await oldAndNew();
  const wrongKey = await deriveMemoryKey("wrong-pass", oldSalt);

  assert.throws(() => reencryptMemory(wrongKey, record, newKey, newSaltValue));
});
