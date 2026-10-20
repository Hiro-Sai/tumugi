<?php
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/login_guard.php';
setCorsHeaders();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'POSTメソッドのみ許可されています']);
    exit;
}

$input = json_decode(file_get_contents('php://input'), true);
$employeeCode = trim($input['employee_code'] ?? '');
$password     = (string)($input['password'] ?? '');

if ($employeeCode === '' || $password === '') {
    http_response_code(400);
    echo json_encode(['error' => '社員IDとパスワードを入力してください']);
    exit;
}

// =========================================
// ブルートフォース対策（includes/login_guard.php）
// 直近LOCKOUT_WINDOW_MINUTES分以内の失敗回数がMAX_FAILED_ATTEMPTS以上ならロック
// =========================================
$pdo = getDbConnection();

if (countRecentFailures($pdo, $employeeCode) >= MAX_FAILED_ATTEMPTS) {
    http_response_code(429);
    echo json_encode([
        'error' => 'ログイン試行回数が上限を超えました。' . LOCKOUT_WINDOW_MINUTES . '分ほど時間をおいてから再度お試しください',
    ]);
    exit;
}

$stmt = $pdo->prepare(
    "SELECT id, password_hash, display_name, department, is_admin
     FROM employees
     WHERE employee_code = :code AND is_active = 1"
);
$stmt->execute(['code' => $employeeCode]);
$employee = $stmt->fetch();

// 社員IDの存在有無に関わらず同じエラーメッセージにする（IDの存在を推測されないため）
if (!$employee || !password_verify($password, $employee['password_hash'])) {
    recordAttempt($pdo, $employeeCode, false);
    http_response_code(401);
    echo json_encode(['error' => '社員IDまたはパスワードが正しくありません']);
    exit;
}

recordAttempt($pdo, $employeeCode, true);

// トークン発行（24時間有効）
$token     = bin2hex(random_bytes(32));
$expiresAt = date('Y-m-d H:i:s', strtotime('+24 hours'));

$insertToken = $pdo->prepare(
    "INSERT INTO auth_tokens (employee_id, token, expires_at) VALUES (:eid, :token, :expires)"
);
$insertToken->execute([
    'eid'     => $employee['id'],
    'token'   => $token,
    'expires' => $expiresAt,
]);

// is_admin はUIの表示切替（管理者ボタンの表示/非表示）にのみ使用するクライアント向けヒント。
// 実際の認可はdashboard_data.php側のDB照会で行うため、ここが偽装されても実害はない。
echo json_encode([
    'token'         => $token,
    'employee_id'   => $employee['id'],
    'department'    => $employee['department'],
    'is_admin'      => (bool)$employee['is_admin'],
    'expires_at'    => $expiresAt,
]);