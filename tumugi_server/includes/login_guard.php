<?php
// =========================================
// login_guard.php
// ブルートフォース対策。login.php と change_password.php で共有する。
// 直近 LOCKOUT_WINDOW_MINUTES 分以内の失敗回数が MAX_FAILED_ATTEMPTS 以上なら止める。
// 回数は社員ID（employee_code）ごとに login_attempts で数えるので、
// ログインの失敗と、パスワード変更での「今のパスワード」の間違いは、合わせて数える。
// 正しいパスワードを確かめられたら（ログインの成功、パスワード変更で今のパスワードが合ったとき）、失敗の数を0に戻す。
// =========================================

define('MAX_FAILED_ATTEMPTS', 5);
define('LOCKOUT_WINDOW_MINUTES', 15);
// ログインの記録（社員ID・時刻・成功したか）を残す時間。ロックに使うのは直近15分だけ。
// 1日あれば、その日に「ロックされた」と相談されたときに確かめられる。
// 成功の記録は「いつログインしたか」になるので、それより長くは残さない。
define('ATTEMPT_RETENTION_HOURS', 24);

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

// 残す時間（ATTEMPT_RETENTION_HOURS）より前の記録を、成功も失敗も、全員分消す。login.php が、ログインのたびに呼ぶ。
function deleteOldAttempts(PDO $pdo): void {
    // ATTEMPT_RETENTION_HOURSは定数（ユーザー入力ではない）のためSQLに直接埋め込んでも安全
    $hours = (int) ATTEMPT_RETENTION_HOURS;
    $pdo->exec("DELETE FROM login_attempts WHERE attempted_at < (NOW() - INTERVAL {$hours} HOUR)");
}

// その社員IDの失敗の記録を消す（失敗の数が0に戻る）。成功の記録は残す。
// 4回間違えてから入れた人が、そのあと1回打ち間違えただけでロックされないように。
function clearFailures(PDO $pdo, string $employeeCode): void {
    $stmt = $pdo->prepare(
        "DELETE FROM login_attempts WHERE employee_code = :code AND succeeded = 0"
    );
    $stmt->execute(['code' => $employeeCode]);
}

// パスワードを確かめる。$hash が null（社員がいない・退職している）なら false を返す。
// そのときも、確かめるのと同じ重さの計算（bcrypt。今の設定で0.2秒ほど）を1回してから返す。
// 計算を飛ばすと、応答の速さで、その社員IDがあるかどうかが分かってしまう。
// ハッシュをその場で1つ作るので、重さ（コスト）は、社員のパスワードのハッシュを作るときと同じ PHP の既定になる。
function checkPassword(string $password, ?string $hash): bool {
    if ($hash === null) {
        password_hash($password, PASSWORD_BCRYPT);
        return false;
    }
    return password_verify($password, $hash);
}
