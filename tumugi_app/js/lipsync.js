// =========================================
// js/lipsync.js
// 口パク。VOICEVOX の audio_query（音ごとの長さ）から「何秒から何秒まで口を開けるか」の表を作り、
// 再生中の時刻とまばたきに合わせて、立ち絵のどれを出すかを決める。
// 画面（index.html から script.js より先に読み込む）と、単体テスト（test/lipsync.test.js）の両方から使う。
//
// 声の大きさで口を開け閉めする方法は、つむぎの声では音と音のあいだで音量があまり下がらず、
// 1秒に1〜3回しか開かなかった（2026-10-16 の試算。「あいうえお」の音は1秒に5〜7個ある）。
// 音の長さで決めると1秒に3〜5回開き、開いている割合も半分くらいになった。
// =========================================

(function () {
  "use strict";

  // 口を開ける母音。声の出ない母音（大文字。「です」の「す」など）・ん（N）・っ（cl）・息つぎ（pau）は閉じる
  const OPEN_VOWELS = Object.freeze(["a", "i", "u", "e", "o"]);

  // 開いているあいだに挟まる、これより短い「閉じ」は開いたままにする（チカチカして見えるため）。
  // 大きくすると口の動きがゆっくりになり、小さくすると細かく動く
  const MIN_CLOSE_SEC = 0.04;

  // 疑問文の句は、VOICEVOX が終わりに語尾上げの音を足す（2026-10-16 に測って、1句あたり約0.15秒）
  const INTERROGATIVE_EXTRA_SEC = 0.15;

  const seconds = (value) => (typeof value === "number" && value > 0 ? value : 0);

  // 戻り値：[{ start, end, open }]（秒。時間の順で、隣どうしは開く・閉じるが交互になる）
  // speedScale（話す速さ）は音の長さにだけ効かせ、前後の無音には効かせない（アプリは 1 のまま使っている）
  function buildMouthTimeline(query) {
    if (!query || !Array.isArray(query.accent_phrases)) return [];
    const speed = typeof query.speedScale === "number" && query.speedScale > 0 ? query.speedScale : 1;

    const pieces = [[seconds(query.prePhonemeLength), false]]; // [長さ, 開くか]
    for (const phrase of query.accent_phrases) {
      for (const mora of phrase?.moras ?? []) {
        pieces.push([seconds(mora.consonant_length) / speed, false]);
        pieces.push([seconds(mora.vowel_length) / speed, OPEN_VOWELS.includes(mora.vowel)]);
      }
      if (phrase?.is_interrogative) pieces.push([INTERROGATIVE_EXTRA_SEC / speed, true]);
      if (phrase?.pause_mora) pieces.push([seconds(phrase.pause_mora.vowel_length) / speed, false]);
    }
    pieces.push([seconds(query.postPhonemeLength), false]);

    // 同じ状態が続く区間をまとめる
    const runs = [];
    for (const [length, open] of pieces) {
      if (length === 0) continue;
      if (runs.length && runs[runs.length - 1].open === open) runs[runs.length - 1].length += length;
      else runs.push({ length, open });
    }

    // 開いているあいだに挟まる短い「閉じ」を開いたままにして、もう一度まとめる
    const smoothed = [];
    runs.forEach((run, i) => {
      const between = i > 0 && i < runs.length - 1 && runs[i - 1].open && runs[i + 1].open;
      const open = run.open || (between && run.length < MIN_CLOSE_SEC);
      if (smoothed.length && smoothed[smoothed.length - 1].open === open) smoothed[smoothed.length - 1].length += run.length;
      else smoothed.push({ length: run.length, open });
    });

    let time = 0;
    return smoothed.map(({ length, open }) => {
      const segment = { start: time, end: time + length, open };
      time += length;
      return segment;
    });
  }

  // 再生中の時刻（秒）で、口を開けるか
  function isMouthOpenAt(timeline, time) {
    if (!Array.isArray(timeline)) return false;
    const segment = timeline.find(s => time >= s.start && time < s.end);
    return segment ? segment.open : false;
  }

  // -----------------------------------------
  // 立ち絵のどれを出すか
  // 立ち絵は表情ごとに3枚：
  //   表情_open.png  … 元の絵（目を開けている）
  //   表情_close.png … まばたき（目を閉じている）
  //   表情_talk.png  … 口だけを元の絵と反対にした絵（口パク用。用意した表情だけ）
  // 元の絵で口が開いているかは表情によって違う（2026-10-16 に画像で確かめた。口が閉じているのは normal だけ）。
  //   元の口が閉じている表情 → 母音のあいだ _talk（口を開けた絵）にする
  //   元の口が開いている表情 → 子音・息つぎのあいだ _talk（口を閉じた絵）にする
  // -----------------------------------------
  const BASE_MOUTH_OPEN = Object.freeze({
    normal: false, happy: true, sad: true, surprised: true, angry: true, troubled: true,
  });

  // 戻り値："open"（元の絵）／"close"（まばたき）／"talk"（口を元と反対にした絵）
  function faceImageState({ emotion, blinking, speaking, mouthOpen, hasTalkImage }) {
    if (blinking) return "close";
    if (!speaking || !hasTalkImage) return "open";
    const baseOpen = BASE_MOUTH_OPEN[emotion] === true;
    return mouthOpen === baseOpen ? "open" : "talk";
  }

  const api = Object.freeze({
    OPEN_VOWELS, MIN_CLOSE_SEC, INTERROGATIVE_EXTRA_SEC, BASE_MOUTH_OPEN,
    buildMouthTimeline, isMouthOpenAt, faceImageState,
  });

  // テスト（Node）では module.exports、画面では window.TumugiLipSync として使う
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    globalThis.TumugiLipSync = api;
  }
})();
