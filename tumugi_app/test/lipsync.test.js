// =========================================
// test/lipsync.test.js
// js/lipsync.js の単体テスト（実行：npm test）
// =========================================

const test   = require("node:test");
const assert = require("node:assert/strict");

const { BASE_MOUTH_OPEN, buildMouthTimeline, isMouthOpenAt, faceImageState } = require("../js/lipsync");
const { EMOTIONS } = require("../js/safety");

// 小数の足し算の誤差をならして比べる
const round = (timeline) => timeline.map(({ start, end, open }) => ({
  start: Math.round(start * 1000) / 1000,
  end:   Math.round(end * 1000) / 1000,
  open,
}));

const mora = (consonant, vowel, length) => ({ consonant_length: consonant, vowel, vowel_length: length });

test("buildMouthTimeline: 母音の間は開き、前後の無音・子音・ん・っ・息つぎの間は閉じる", () => {
  const query = {
    speedScale: 1, prePhonemeLength: 0.1, postPhonemeLength: 0.1,
    accent_phrases: [{
      moras: [mora(0.05, "a", 0.1), mora(null, "N", 0.08), mora(null, "cl", 0.07), mora(0.06, "o", 0.12)],
      pause_mora: mora(null, "pau", 0.2),
      is_interrogative: false,
    }],
  };
  assert.deepEqual(round(buildMouthTimeline(query)), [
    { start: 0,    end: 0.15, open: false }, // 前の無音＋子音
    { start: 0.15, end: 0.25, open: true  }, // a
    { start: 0.25, end: 0.46, open: false }, // ん・っ・子音
    { start: 0.46, end: 0.58, open: true  }, // o
    { start: 0.58, end: 0.88, open: false }, // 息つぎ＋後ろの無音
  ]);
});

test("buildMouthTimeline: 疑問文は、句の終わりに語尾上げの分（0.15秒）を開いたまま足す", () => {
  const query = {
    speedScale: 1, prePhonemeLength: 0.1, postPhonemeLength: 0.1,
    accent_phrases: [
      { moras: [mora(0.05, "a", 0.1)], pause_mora: mora(null, "pau", 0.2), is_interrogative: true },
      { moras: [mora(0.05, "e", 0.1)], pause_mora: null, is_interrogative: false },
    ],
  };
  assert.deepEqual(round(buildMouthTimeline(query)), [
    { start: 0,    end: 0.15, open: false },
    { start: 0.15, end: 0.4,  open: true  }, // a ＋ 語尾上げ
    { start: 0.4,  end: 0.65, open: false }, // 息つぎ＋子音
    { start: 0.65, end: 0.75, open: true  },
    { start: 0.75, end: 0.85, open: false },
  ]);
});

test("buildMouthTimeline: 開いているあいだの短い「閉じ」（40ミリ秒未満）は開いたままにする", () => {
  const query = {
    speedScale: 1, prePhonemeLength: 0.02, postPhonemeLength: 0.1,
    accent_phrases: [{ moras: [mora(null, "a", 0.1), mora(0.03, "i", 0.1)], pause_mora: null, is_interrogative: false }],
  };
  assert.deepEqual(round(buildMouthTimeline(query)), [
    { start: 0,    end: 0.02, open: false }, // 最初の無音は短くても閉じたまま
    { start: 0.02, end: 0.25, open: true  }, // a・子音（0.03秒）・i
    { start: 0.25, end: 0.35, open: false },
  ]);
});

test("buildMouthTimeline: 声の出ない母音（大文字。「です」の「す」など）は閉じる", () => {
  const query = {
    speedScale: 1, prePhonemeLength: 0.1, postPhonemeLength: 0.1,
    accent_phrases: [{ moras: [mora(0.05, "e", 0.1), mora(0.06, "U", 0.08)], pause_mora: null, is_interrogative: false }],
  };
  assert.deepEqual(round(buildMouthTimeline(query)), [
    { start: 0,    end: 0.15, open: false },
    { start: 0.15, end: 0.25, open: true  },
    { start: 0.25, end: 0.49, open: false },
  ]);
});

test("buildMouthTimeline: 話す速さ（speedScale）が2なら、音の長さは半分になる（前後の無音は変えない）", () => {
  const query = {
    speedScale: 2, prePhonemeLength: 0.1, postPhonemeLength: 0.1,
    accent_phrases: [{ moras: [mora(0.1, "a", 0.2)], pause_mora: null, is_interrogative: false }],
  };
  assert.deepEqual(round(buildMouthTimeline(query)), [
    { start: 0,    end: 0.15, open: false },
    { start: 0.15, end: 0.25, open: true  },
    { start: 0.25, end: 0.35, open: false },
  ]);
});

test("buildMouthTimeline: 形が違うものは、空の表にする", () => {
  for (const value of [undefined, null, {}, { accent_phrases: "x" }]) {
    assert.deepEqual(buildMouthTimeline(value), [], String(value));
  }
});

test("isMouthOpenAt: 再生中の時刻が、開く区間に入っているときだけ true", () => {
  const timeline = [
    { start: 0,    end: 0.15, open: false },
    { start: 0.15, end: 0.25, open: true  },
    { start: 0.25, end: 0.35, open: false },
  ];
  assert.equal(isMouthOpenAt(timeline, 0.1),  false);
  assert.equal(isMouthOpenAt(timeline, 0.15), true);
  assert.equal(isMouthOpenAt(timeline, 0.2),  true);
  assert.equal(isMouthOpenAt(timeline, 0.25), false);
  assert.equal(isMouthOpenAt(timeline, 1),    false); // 終わったあと
  assert.equal(isMouthOpenAt([], 0.2),        false);
  assert.equal(isMouthOpenAt(undefined, 0.2), false);
});

// -----------------------------------------
// faceImageState（立ち絵のどれを出すか）
// -----------------------------------------
const face = (overrides) => faceImageState({
  emotion: "normal", blinking: false, speaking: true, mouthOpen: false, hasTalkImage: true, ...overrides,
});

test("faceImageState: まばたき中は目を閉じた絵、話していない・口の画像がないときは元の絵", () => {
  assert.equal(face({ blinking: true, mouthOpen: true }), "close");
  assert.equal(face({ speaking: false, mouthOpen: true }), "open");
  assert.equal(face({ hasTalkImage: false, mouthOpen: true }), "open");
  assert.equal(face({ emotion: "happy", speaking: false }), "open"); // 話し終わったら、口が開いた元の絵に戻る
});

test("faceImageState: 元の口が閉じている表情（normal）は、母音で口を開けた絵（talk）にする", () => {
  assert.equal(face({ emotion: "normal", mouthOpen: true }),  "talk");
  assert.equal(face({ emotion: "normal", mouthOpen: false }), "open");
});

test("faceImageState: 元の口が開いている表情は、子音・息つぎで口を閉じた絵（talk）にする", () => {
  for (const emotion of ["happy", "sad", "surprised", "angry", "troubled"]) {
    assert.equal(face({ emotion, mouthOpen: true }),  "open", emotion);
    assert.equal(face({ emotion, mouthOpen: false }), "talk", emotion);
  }
});

test("BASE_MOUTH_OPEN: つむぎの表情（safety.js の EMOTIONS）が全部そろっている", () => {
  assert.deepEqual(Object.keys(BASE_MOUTH_OPEN).sort(), [...EMOTIONS].sort());
});
