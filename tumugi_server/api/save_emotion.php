<?php
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/emotion_scores.php';
require_once __DIR__ . '/../includes/aggregate_rules.php';
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
// 部署・新卒の印・集計に入れるかの印は、アプリから受け取らず、employees から写す
// （記録した時点の所属を残すため）。
// 集計に入れない記録（is_counted = 0）：管理者の記録と、集計に入れ始める時刻（counted_from）から
// NEW_EMPLOYEE_WAIT_DAYS 日たつまでの記録。入れるかは、記録した時点で決める。
// 集計のときに時刻で見ると、待ちが明けた瞬間にそれまでの記録がいっぺんに入り、前後の差でその人の値が分かるため。
// 日数は整数の定数だけを SQL に入れる（利用者の入力は入らない）。
$waitDays = (int)NEW_EMPLOYEE_WAIT_DAYS;
$stmt = $pdo->prepare(
    "INSERT INTO emotion_logs
       (employee_id, emotion, negativity_score, is_crisis, harassment_type,
        department, is_new_grad, is_counted)
     SELECT id, :emotion, :score, :crisis, :harassment,
            department, is_new_grad,
            IF(is_admin = 1 OR counted_from > NOW() - INTERVAL {$waitDays} DAY, 0, 1)
     FROM employees WHERE id = :eid"
);
$stmt->execute([
    'eid'        => $employeeId,
    'emotion'    => $emotion,
    'score'      => $score,
    'crisis'     => $isCrisis,
    'harassment' => $harassmentType,
]);

echo json_encode(['status' => 'ok', 'recorded_score' => $score]);