<?php
// =========================================
// my_notices.php
// 自分あての知らせ（管理者が所属などを変えた記録）を返す。
// 成功したら 200 で
//   { "notices": [ { "id", "kind", "old_value", "new_value", "created_at", "seen" } ], "unseen_count": 数 }
// を返す。
//
// - 自分の分だけ。employee_id はトークンから決める（リクエストの値は使わない）。
// - 直近 NOTICE_HISTORY_DAYS 日の分を、新しい順（created_at、同じ時刻は id の大きい順）。
// - まだ見ていない知らせは、それより古くても返す。長くログインしなかった人が、
//   その間の変更を知らないままにならないように。
// - unseen_count は、返す範囲の中の、まだ見ていない数。
// - seen は真偽値（見ていれば true）。
// =========================================
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/aggregate_rules.php';
startApi();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    http_response_code(405);
    echo json_encode(['error' => 'GETメソッドのみ許可されています']);
    exit;
}

$employeeId = verifyToken();
if ($employeeId === null) {
    http_response_code(401);
    echo json_encode(['error' => '認証が必要です。再度ログインしてください']);
    exit;
}

$pdo = getDbConnection();
$days = (int)NOTICE_HISTORY_DAYS;
$stmt = $pdo->prepare(
    "SELECT id, kind, old_value, new_value, created_at, (seen_at IS NOT NULL) AS seen
     FROM employee_notices
     WHERE employee_id = :eid
       AND (created_at >= NOW() - INTERVAL {$days} DAY OR seen_at IS NULL)
     ORDER BY created_at DESC, id DESC"
);
$stmt->execute(['eid' => $employeeId]);

$notices = [];
$unseen = 0;
foreach ($stmt->fetchAll() as $row) {
    $seen = (int)$row['seen'] === 1;
    if (!$seen) {
        $unseen++;
    }
    $notices[] = [
        'id'         => (int)$row['id'],
        'kind'       => $row['kind'],
        'old_value'  => $row['old_value'],
        'new_value'  => $row['new_value'],
        'created_at' => $row['created_at'],
        'seen'       => $seen,
    ];
}

echo json_encode(['notices' => $notices, 'unseen_count' => $unseen]);
