<?php
// =========================================
// my_notices_seen.php
// 自分あての知らせを「見た」ことにする。
// 受け取る JSON：{ "up_to_id": 1以上の整数 }
// 成功したら 200 で {"status":"ok","updated":数} を返す。
//
// - 自分の、id が up_to_id 以下で、まだ見ていない知らせに seen_at = NOW() を入れる。
// - updated は、実際に seen_at を入れた行の数（もう見た行・ほかの社員の行は数えない）。
// - up_to_id は JSON の整数だけ（文字列・小数・0・負・ないときは 400）。
// - employee_id はトークンから決める（リクエストの値は使わない）。
// =========================================
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/employee_admin.php';
startApi();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respondError(405, 'POSTメソッドのみ許可されています');
}

$employeeId = verifyToken();
if ($employeeId === null) {
    respondError(401, '認証が必要です。再度ログインしてください');
}

$input = readJsonInput();
$upToId = $input['up_to_id'] ?? null;
if (!is_int($upToId) || $upToId < 1) {
    respondError(400, 'up_to_id は、1以上の整数で指定してください');
}

$pdo = getDbConnection();
$stmt = $pdo->prepare(
    "UPDATE employee_notices
     SET seen_at = NOW()
     WHERE employee_id = :eid AND id <= :upto AND seen_at IS NULL"
);
$stmt->execute(['eid' => $employeeId, 'upto' => $upToId]);

echo json_encode(['status' => 'ok', 'updated' => $stmt->rowCount()]);
