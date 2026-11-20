// =========================================
// js/memory-rules.js
// つむぎの記憶の決まり（項目の数・値の長さ・値の形）。画面には触らない（値を返すだけ）。
// 画面（index.html から script.js より先に読み込む）と、単体テスト（test/memory-rules.test.js）の両方から使う。
//
// 記憶は、返事のシステムプロンプトと、記憶の抽出の指示に入る。上限がないと、増えるほど CPU だけの PC で遅くなり、
// 極端なときは、Ollama がつむぎへの指示まで削ってしまう（レビューの A12。入力の上限 A2 と同じ理由）。
// 30項目 × 100文字で、いちばん多いときでも約1700語（日本語1文字 ≈ 0.53語）。
// 本人が入れる欄（「はじめに」の4つの欄、記憶の画面の編集欄）は、maxlength で MAX_VALUE_CHARS までにしている。
// =========================================

(function () {
  "use strict";

  const MAX_ITEMS       = 30;  // 記憶の項目の数
  const MAX_VALUE_CHARS = 100; // 1項目の値の文字数
  const MAX_KEY_CHARS   = 20;  // 項目の名前の文字数

  const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

  // 文字（コードポイント）で数えて、max 文字までにする
  function cutChars(text, max) {
    const chars = [...text];
    return chars.length > max ? chars.slice(0, max).join("") : text;
  }

  // 値の形をそろえる。文字は前後の空白を除き、数字は文字に、配列は「、」でつなぐ（配列の中の使えない値と空は除く）。
  // それ以外（オブジェクト・true/false・null）と、空になった値は null（捨てる）。
  // AI が返した記憶が、配列やオブジェクトのこともあるため（表示が「a,b」や [object Object] になっていた）
  function normalizeValue(value) {
    let text;
    if (typeof value === "string") {
      text = value;
    } else if (isFiniteNumber(value)) {
      text = String(value);
    } else if (Array.isArray(value)) {
      text = value
        .filter((v) => typeof v === "string" || isFiniteNumber(v))
        .map((v) => String(v).trim())
        .filter(Boolean)
        .join("、");
    } else {
      return null;
    }
    text = text.trim();
    return text === "" ? null : text;
  }

  // 項目の名前として使えるか（前後の空白を除いたもの。空でなく、MAX_KEY_CHARS 文字まで）
  function isValidKey(key) {
    return key !== "" && key !== "__proto__" && [...key].length <= MAX_KEY_CHARS;
  }

  // 会話から抽出した項目（extracted）を、今の記憶（current）に足す。current は書き換えない。
  // - 値は normalizeValue でそろえ、MAX_VALUE_CHARS 文字で切る（AI がまとめた文なので、切ってよい）。
  // - 名前が使えない項目と、値が使えない項目は捨てる。
  // - 今ある項目は上書きする。新しい項目は、MAX_ITEMS に達するまでだけ足す
  //   （いっぱいのときは足さない。名前など大事な項目が、本人の知らないうちに消えないように。ユーザーが選んだ）。
  // 戻り値：{ memory: 足したあとの記憶, applied: 実際に入れた（変わった）項目, skipped: 捨てた・足さなかった数 }。
  // applied は、次の返事の発言に添える「新しく分かったこと」に使う
  function mergeExtracted(current, extracted) {
    const memory = { ...(current || {}) };
    const applied = {};
    let skipped = 0;
    if (!extracted || typeof extracted !== "object" || Array.isArray(extracted)) {
      return { memory, applied, skipped };
    }
    for (const [rawKey, rawValue] of Object.entries(extracted)) {
      const key = rawKey.trim();
      const normalized = normalizeValue(rawValue);
      if (!isValidKey(key) || normalized === null) {
        skipped += 1;
        continue;
      }
      const value = cutChars(normalized, MAX_VALUE_CHARS);
      const exists = Object.prototype.hasOwnProperty.call(memory, key);
      if (exists && memory[key] === value) continue; // 変わらない
      if (!exists && Object.keys(memory).length >= MAX_ITEMS) {
        skipped += 1;
        continue;
      }
      memory[key] = value;
      applied[key] = value;
    }
    return { memory, applied, skipped };
  }

  // 保存してあった記憶の形をそろえる（読み込んだとき）。値は normalizeValue でそろえ、使えない値の項目は捨てる。
  // 数と長さは切らない（本人の記憶を、黙って消さないため。上限を超えているあいだは、新しい項目を足さないだけ）
  function cleanLoaded(memory) {
    const out = {};
    if (!memory || typeof memory !== "object" || Array.isArray(memory)) return out;
    for (const [key, value] of Object.entries(memory)) {
      const normalized = normalizeValue(value);
      if (key.trim() !== "" && key !== "__proto__" && normalized !== null) out[key] = normalized;
    }
    return out;
  }

  // 記憶がいっぱいか（記憶の画面で、新しいことを覚えないと知らせるため）
  function isFull(memory) {
    return Object.keys(memory || {}).length >= MAX_ITEMS;
  }

  const api = Object.freeze({
    MAX_ITEMS, MAX_VALUE_CHARS, MAX_KEY_CHARS,
    normalizeValue, mergeExtracted, cleanLoaded, isFull,
  });

  // テスト（Node）では module.exports、画面では window.TumugiMemoryRules として使う
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    globalThis.TumugiMemoryRules = api;
  }
})();
