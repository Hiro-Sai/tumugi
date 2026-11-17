// =========================================
// js/chat-view.js
// チャットの画面に出す、時刻・日付・状態の文・話題の例。画面には触らない（文字や値を返すだけ）。
// 画面（index.html から script.js より先に読み込む）と、単体テスト（test/chat-view.test.js）の両方から使う。
// 日付と時刻は、その PC の時刻（ローカル）で扱う。
// =========================================

(function () {
  "use strict";

  const WEEKDAYS = Object.freeze(["日", "月", "火", "水", "木", "金", "土"]);

  const pad2 = (n) => String(n).padStart(2, "0");

  // "18:42"（24時間、ゼロ埋め）
  function formatTime(date) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }

  // "11月11日（水）"
  function formatHeaderDate(date) {
    return `${date.getMonth() + 1}月${date.getDate()}日（${WEEKDAYS[date.getDay()]}）`;
  }

  // "2026-11-11"（日が同じかどうかを比べるための印）
  function dayKey(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  // 日の区切りに出す文。同じ日は「今日」、前の日は「昨日」、それ以外は日付
  function dayLabel(date, now) {
    const key = dayKey(date);
    if (key === dayKey(now)) return "今日";
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (key === dayKey(yesterday)) return "昨日";
    return formatHeaderDate(date);
  }

  // 日の区切りを入れるか。まだ何も出していない（prevKey が null）か、日が変わったとき
  function needsDaySeparator(prevKey, date) {
    return prevKey === null || prevKey === undefined || prevKey !== dayKey(date);
  }

  // 左の欄の状態の文。話している間は、考えている状態より優先する
  function statusText({ busy, speaking }) {
    if (speaking) return "話しています";
    if (busy) return "考えています";
    return "話を聞いています";
  }

  // 話題の例。押すと入力欄に text が入る（送信はしない）
  const STARTERS = Object.freeze([
    Object.freeze({ label: "今日の出来事", text: "今日あったことを聞いてほしい。" }),
    Object.freeze({ label: "仕事の悩み", text: "仕事のことで悩んでいて、話を聞いてほしい。" }),
    Object.freeze({ label: "人間関係",   text: "職場の人間関係のことで、聞いてほしいことがある。" }),
    Object.freeze({ label: "雑談したい", text: "少し雑談に付き合ってほしいな。" }),
  ]);

  const api = Object.freeze({
    formatTime, formatHeaderDate, dayKey, dayLabel, needsDaySeparator, statusText, STARTERS,
  });

  // テスト（Node）では module.exports、画面では window.TumugiChatView として使う
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    globalThis.TumugiChatView = api;
  }
})();
