<?php
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/login_guard.php';
require_once __DIR__ . '/../includes/aggregate_rules.php';
// 社員IDの形の決まり（EMPLOYEE_CODE_PATTERN）と入力の受け方（readJsonInput・normalizeText）を、社員の管理とそろえるため
require_once __DIR__ . '/../includes/employee_admin.php';
startApi();

define('TOKEN_TTL_HOURS', 24); // ログインのトークンが有効な時間

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'POSTメソッドのみ許可されています']);
    exit;
}

// 入力の受け方は、社員の管理の API と同じにする（レビューの A5。前は、配列などが来ると 500 になっていた）。
// - 本文が JSON のオブジェクトでないときは、空として扱う（readJsonInput）。
// - 社員IDは、文字か数のときだけ使い、前後の空白を（全角も）除く（normalizeText）。
// - パスワードは、文字のときだけ使う。打ったとおりに使い、空白も除かない。
// 使えない値は空として扱い、すぐ下の 400 で断る。
$input        = readJsonInput();
$employeeCode = normalizeText($input['employee_code'] ?? '');
$password     = is_string($input['password'] ?? null) ? $input['password'] : '';

if ($employeeCode === '' || $password === '') {
    http_response_code(400);
    echo json_encode(['error' => '社員IDとパスワードを入力してください']);
    exit;
}

// 社員IDの形（英数字・-・_ の1〜20文字。登録できる社員IDと同じ決まり）に合わなければ、DB に触れずに断る（レビューの A5）。
// - 失敗の記録には入れない。この形の社員はいないので、ロックの数に入れる意味がない
//   （前は、51文字以上だと記録の欄（50文字）に入らず、500 になっていた）。
// - 形が違うことは知らせる（全角で打ったときなどに、直し方が分かるように）。
//   形の決まりが分かっても、社員IDがあるかどうかは、今までどおり分からない。
if (!preg_match(EMPLOYEE_CODE_PATTERN, $employeeCode)) {
    http_response_code(400);
    echo json_encode(['error' => '社員IDは、半角の英数字・-・_ の20文字までで入力してください']);
    exit;
}

// =========================================
// ブルートフォース対策（includes/login_guard.php）
// 直近LOCKOUT_WINDOW_MINUTES分以内の失敗回数がMAX_FAILED_ATTEMPTS以上ならロック
// =========================================
$pdo = getDbConnection();

// 1日より前のログインの記録を、全員分消す（ログインのたびに掃除する。ロック中で 429 を返すときも）
deleteOldAttempts($pdo);

if (countRecentFailures($pdo, $employeeCode) >= MAX_FAILED_ATTEMPTS) {
    http_response_code(429);
    echo json_encode([
        'error' => 'ログイン試行回数が上限を超えました。' . LOCKOUT_WINDOW_MINUTES . '分ほど時間をおいてから再度お試しください',
    ]);
    exit;
}

$stmt = $pdo->prepare(
    "SELECT id, password_hash, display_name, department, is_admin, must_change_password
     FROM employees
     WHERE employee_code = :code AND is_active = 1"
);
$stmt->execute(['code' => $employeeCode]);
$employee = $stmt->fetch();

// 社員IDがないとき（退職も含む）も、パスワードを確かめるのと同じ重さの計算をしてから断り（checkPassword）、
// エラーの文も同じにする。どちらも、社員IDがあるかどうかを推測されないため
if (!checkPassword($password, $employee ? $employee['password_hash'] : null)) {
    recordAttempt($pdo, $employeeCode, false);
    http_response_code(401);
    echo json_encode(['error' => '社員IDまたはパスワードが正しくありません']);
    exit;
}

recordAttempt($pdo, $employeeCode, true);
// 正しいパスワードで入れたので、この社員IDの失敗の数を0に戻す
clearFailures($pdo, $employeeCode);

// 期限の切れたトークンを、全員分消す（ログインのたびに掃除する）
$pdo->exec("DELETE FROM auth_tokens WHERE expires_at <= NOW()");

// EMOTION_LOG_RETENTION_DAYS 日より前の感情ログを、全員分消す（ログインに成功するたびに掃除する）。
// 失敗や 429 のときは消さない。ログインできない人の要求のたびに、感情ログの表を全部読ませないため。
// EMOTION_LOG_RETENTION_DAYSは定数（ユーザー入力ではない）のためSQLに直接埋め込んでも安全
$retentionDays = (int) EMOTION_LOG_RETENTION_DAYS;
$pdo->exec("DELETE FROM emotion_logs WHERE recorded_at < (NOW() - INTERVAL {$retentionDays} DAY)");

// トークン発行（TOKEN_TTL_HOURS 時間有効）。DB にはトークンそのものではなく、そのハッシュを入れる。
// 期限は MySQL の時計で計算する。
// TOKEN_TTL_HOURSは定数（ユーザー入力ではない）のためSQLに直接埋め込んでも安全
$token = bin2hex(random_bytes(32));
$ttl   = (int) TOKEN_TTL_HOURS;

$insertToken = $pdo->prepare(
    "INSERT INTO auth_tokens (employee_id, token, expires_at)
     VALUES (:eid, :token, NOW() + INTERVAL {$ttl} HOUR)"
);
$insertToken->execute([
    'eid'   => $employee['id'],
    'token' => hashToken($token),
]);

// is_admin はUIの表示切替（管理者ボタンの表示/非表示）にのみ使用するクライアント向けヒント。
// 実際の認可は、管理者用の各APIが呼ぶrequireAdmin()（includes/admin_guard.php）のDB照会で行うため、ここが偽装されても実害はない。
echo json_encode([
    'token'         => $token,
    'employee_id'   => $employee['id'],
    'department'    => $employee['department'],
    'is_admin'      => (bool)$employee['is_admin'],
    'must_change_password' => (bool)$employee['must_change_password'], // true なら、アプリはパスワードの変更だけをさせる
    'expires_in'    => TOKEN_TTL_HOURS * 3600, // トークンが有効な秒数（アプリは、受け取った時刻にこれを足して期限を知る）
]);