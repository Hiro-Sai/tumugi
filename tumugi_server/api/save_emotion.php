<?php
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/emotion_scores.php';
setCorsHeaders();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'POSTメソッドのみ許可されています']);
    exit;
}

$employeeId = verifyToken();
if ($employeeId === null) {
    http_response_code(401);
    echo json_encode(['error' => '認証が必要です。再度ログインしてください']);
    exit;
}

$input          = json_decode(file_get_contents('php://input'), true);
$emotion        = $input['emotion'] ?? 'normal';
$isCrisis       = !empty($input['is_crisis']) ? 1 : 0;
$harassmentType = $input['harassment_type'] ?? 'none';

// 感情ごとのスコア表は includes/emotion_scores.php に一元化している
if (!array_key_exists($emotion, EMOTION_SCORES)) {
    http_response_code(400);
    echo json_encode(['error' => '不正な emotion 値です']);
    exit;
}

// -----------------------------------------
// ハラスメント分類（受害/加害を区別）。
// none: 該当なし / received: 受けた / said: 言ってしまった
// -----------------------------------------
$allowedHarassmentTypes = ['none', 'received', 'said'];
if (!in_array($harassmentType, $allowedHarassmentTypes, true)) {
    http_response_code(400);
    echo json_encode(['error' => '不正な harassment_type 値です']);
    exit;
}

$score = $isCrisis ? CRISIS_SCORE : EMOTION_SCORES[$emotion];

$pdo = getDbConnection();
$stmt = $pdo->prepare(
    "INSERT INTO emotion_logs (employee_id, emotion, negativity_score, is_crisis, harassment_type)
     VALUES (:eid, :emotion, :score, :crisis, :harassment)"
);
$stmt->execute([
    'eid'        => $employeeId,
    'emotion'    => $emotion,
    'score'      => $score,
    'crisis'     => $isCrisis,
    'harassment' => $harassmentType,
]);

echo json_encode(['status' => 'ok', 'recorded_score' => $score]);