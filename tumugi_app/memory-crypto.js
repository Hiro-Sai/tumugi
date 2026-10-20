// =========================================
// memory-crypto.js
// つむぎの記憶を、社員ごとに、その人のパスワードから作った鍵で暗号化する。
//   - newSalt()                        … 社員ごとのソルトを作る
//   - deriveMemoryKey(password, salt)  … パスワードとソルトから鍵（32バイト）を作る（scrypt）
//   - encryptMemory(key, salt, memory) … 記憶（オブジェクト）を暗号化し、保存用のレコードにする（AES-256-GCM）
//   - decryptMemory(key, record)       … レコードを復号して記憶に戻す。鍵が違う・書き換えられていたら例外
// Electron に依存しない純粋な関数だけを置き、main.js とテスト（test/memory-crypto.test.js）から使う。
//
// 鍵はパスワードからしか作れないので、本人のパスワードがなければ、同じ Windows アカウントを使う同僚も、
// 会社の管理者も記憶を読めない。そのかわり、パスワードをリセットすると、それまでの記憶は読めなくなる。
// =========================================

const crypto = require("crypto");
const { promisify } = require("util");

const scrypt = promisify(crypto.scrypt);

// OWASP の Password Storage Cheat Sheet にある scrypt の推奨値の一つ（N=2^15, r=8, p=3）。
// 必要なメモリ（約 128 × N × r = 32MiB）が Node の既定の上限（32MiB）ちょうどで失敗するため、上限を広げている。
const SCRYPT_OPTIONS = Object.freeze({ N: 2 ** 15, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });

const KEY_BYTES      = 32; // AES-256
const SALT_BYTES     = 16;
const IV_BYTES       = 12; // GCM で推奨される長さ
const TAG_BYTES      = 16;
const RECORD_VERSION = 1;

function newSalt() {
  return crypto.randomBytes(SALT_BYTES).toString("base64");
}

async function deriveMemoryKey(password, salt) {
  return scrypt(String(password), Buffer.from(salt, "base64"), KEY_BYTES, SCRYPT_OPTIONS);
}

// 戻り値のレコードは、ソルト以外すべて暗号化されている。ソルトは秘密にする必要がない
function encryptMemory(key, salt, memory) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  const data = Buffer.concat([cipher.update(JSON.stringify(memory), "utf8"), cipher.final()]);
  return {
    v:    RECORD_VERSION,
    salt,
    iv:   iv.toString("base64"),
    tag:  cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

// authTagLength を指定するのは、短く切り詰めた認証タグを受け付けないようにするため
// （指定しないと、短いタグでも通ってしまい、書き換えを見逃しやすくなる）
function decryptMemory(key, record) {
  if (!record || record.v !== RECORD_VERSION) {
    throw new Error("記憶の保存形式が違います");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"), { authTagLength: TAG_BYTES });
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  const json = Buffer.concat([decipher.update(Buffer.from(record.data, "base64")), decipher.final()]).toString("utf8");
  return JSON.parse(json);
}

module.exports = { newSalt, deriveMemoryKey, encryptMemory, decryptMemory };
