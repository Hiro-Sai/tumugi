<?php
// =========================================
// change_password.php
// ログインしている社員が、自分のパスワードを変える。
// 受け取る JSON：{ "current_password": "...", "new_password": "..." }
// 成功したら 200 で {"status":"ok","revoked":<消したほかのトークンの数>} を返す。
//
// - 今のパスワードが違うときは 403 にする。401 にすると、アプリは「ログインが切れた」と見なしてログアウトする。
// - 試せる回数は、ログインと共通（includes/login_guard.php）。
// - 今のパスワードを、新しいパスワードの決まりより先に確かめる。間違えた回数を必ず数えるため。
// - 新しいパスワードの決まりは、アプリ（tumugi_app/js/password.js）と同じにすること。
// =========================================
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/login_guard.php';
setCorsHeaders();

define('MIN_PASSWORD_CHARS', 8);
define('MAX_PASSWORD_BYTES', 72); // bcrypt は72バイトを超えた分を無視するため

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
// verifyToken() が通ったので、トークンは必ずある
$currentToken = getBearerToken();

$pdo = getDbConnection();

$stmt = $pdo->prepare(
    "SELECT employee_code, password_hash FROM employees WHERE id = :id AND is_active = 1"
);
$stmt->execute(['id' => $employeeId]);
$employee = $stmt->fetch();

if (!$employee) {
    http_response_code(403);
    echo json_encode(['error' => 'このアカウントは使えません']);
    exit;
}
$employeeCode = $employee['employee_code'];

if (countRecentFailures($pdo, $employeeCode) >= MAX_FAILED_ATTEMPTS) {
    http_response_code(429);
    echo json_encode([
        'error' => '試行回数が上限を超えました。' . LOCKOUT_WINDOW_MINUTES . '分ほど時間をおいてから再度お試しください',
    ]);
    exit;
}

$input = json_decode(file_get_contents('php://input'), true);
$currentPassword = (string)($input['current_password'] ?? '');
$newPassword     = (string)($input['new_password'] ?? '');

if (!password_verify($currentPassword, $employee['password_hash'])) {
    recordAttempt($pdo, $employeeCode, false);
    http_response_code(403);
    echo json_encode(['error' => '今のパスワードが正しくありません']);
    exit;
}

// 文字数は、全角や絵文字も1文字と数える（strlen はバイト数なので、全角3文字で8になってしまう）
if (mb_strlen($newPassword, 'UTF-8') < MIN_PASSWORD_CHARS) {
    http_response_code(400);
    echo json_encode(['error' => '新しいパスワードは8文字以上にしてください']);
    exit;
}

if (strlen($newPassword) > MAX_PASSWORD_BYTES) {
    http_response_code(400);
    echo json_encode(['error' => '新しいパスワードが長すぎます（72バイトまで。全角なら24文字程度）']);
    exit;
}

if ($newPassword === $currentPassword) {
    http_response_code(400);
    echo json_encode(['error' => '今と同じパスワードにはできません']);
    exit;
}

$newHash = password_hash($newPassword, PASSWORD_BCRYPT);

// パスワードを変えたら、ほかの PC でのログイン（今のトークン以外）を切る。
// 途中で失敗したら（例外で止まると接続が閉じて）、どちらも元に戻る。
$pdo->beginTransaction();

$update = $pdo->prepare("UPDATE employees SET password_hash = :hash WHERE id = :id");
$update->execute(['hash' => $newHash, 'id' => $employeeId]);

$revoke = $pdo->prepare(
    "DELETE FROM auth_tokens WHERE employee_id = :id AND token <> :current"
);
$revoke->execute(['id' => $employeeId, 'current' => $currentToken]);
$revoked = $revoke->rowCount();

$pdo->commit();

echo json_encode(['status' => 'ok', 'revoked' => $revoked]);
