<?php
// =========================================
// login_guard.php
// ブルートフォース対策。login.php と change_password.php で共有する。
// 直近 LOCKOUT_WINDOW_MINUTES 分以内の失敗回数が MAX_FAILED_ATTEMPTS 以上なら止める。
// 回数は社員ID（employee_code）ごとに login_attempts で数えるので、
// ログインの失敗と、パスワード変更での「今のパスワード」の間違いは、合わせて数える。
// =========================================

define('MAX_FAILED_ATTEMPTS', 5);
define('LOCKOUT_WINDOW_MINUTES', 15);

function countRecentFailures(PDO $pdo, string $employeeCode): int {
    // LOCKOUT_WINDOW_MINUTESは定数（ユーザー入力ではない）のためSQLに直接埋め込んでも安全
    $window = (int) LOCKOUT_WINDOW_MINUTES;
    $stmt = $pdo->prepare(
        "SELECT COUNT(*) AS cnt FROM login_attempts
         WHERE employee_code = :code AND succeeded = 0
           AND attempted_at > (NOW() - INTERVAL {$window} MINUTE)"
    );
    $stmt->execute(['code' => $employeeCode]);
    $row = $stmt->fetch();
    return (int)($row['cnt'] ?? 0);
}

function recordAttempt(PDO $pdo, string $employeeCode, bool $succeeded): void {
    $stmt = $pdo->prepare(
        "INSERT INTO login_attempts (employee_code, succeeded) VALUES (:code, :succeeded)"
    );
    $stmt->execute(['code' => $employeeCode, 'succeeded' => $succeeded ? 1 : 0]);
}
