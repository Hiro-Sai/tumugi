<?php
require_once __DIR__ . '/../includes/db.php';
setCorsHeaders();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'POSTメソッドのみ許可されています']);
    exit;
}

$employeeId = verifyToken();
if ($employeeId === null) {
    http_response_code(401);
    echo json_encode(['error' => '認証が必要です']);
    exit;
}

$input = json_decode(file_get_contents('php://input'), true);
$currentPassword = (string)($input['current_password'] ?? '');
$newPassword     = (string)($input['new_password'] ?? '');

if (strlen($newPassword) < 8) {
    http_response_code(400);
    echo json_encode(['error' => '新しいパスワードは8文字以上にしてください']);
    exit;
}

$pdo = getDbConnection();

$stmt = $pdo->prepare("SELECT password_hash FROM employees WHERE id = :id");
$stmt->execute(['id' => $employeeId]);
$row = $stmt->fetch();

if (!$row || !password_verify($currentPassword, $row['password_hash'])) {
    http_response_code(401);
    echo json_encode(['error' => '現在のパスワードが正しくありません']);
    exit;
}

$newHash = password_hash($newPassword, PASSWORD_BCRYPT);
$update = $pdo->prepare("UPDATE employees SET password_hash = :hash WHERE id = :id");
$update->execute(['hash' => $newHash, 'id' => $employeeId]);

echo json_encode(['status' => 'ok']);