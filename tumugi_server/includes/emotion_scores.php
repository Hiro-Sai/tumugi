<?php
// =========================================
// 感情ごとの重み付けスコア表（0-100、高いほどネガティブ）
// save_emotion.php と tools/seed_demo.php が参照する唯一の定義。
// キーはアプリ側のユーザーの気持ちの分類（tumugi_app/js/safety.js の USER_EMOTIONS）と同じにすること
// （tumugi_app/test/safety.test.js で一致を確かめている）。
// 以前の分類（surprised・troubled）のログは DB にそのまま残るが、スコアは記録時に保存済みなので集計には影響しない。
// 落ち込み・自分を責める気持ち（sad）を、いちばん危ないサインとして最も高くしている。
// =========================================

const EMOTION_SCORES = [
    'happy'   => 0,
    'normal'  => 10,
    'tired'   => 50,
    'angry'   => 50,
    'anxious' => 60,
    'sad'     => 70,
];

// 危機検知時は、感情に関係なくこのスコアにする
const CRISIS_SCORE = 100;
