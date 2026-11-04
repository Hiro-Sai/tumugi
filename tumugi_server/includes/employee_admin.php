<?php
// =========================================
// employee_admin.php
// 社員の管理で使う共通の関数。
//   - 社員の管理の API（api/admin_employee*.php）
//   - 最初の管理者を作る道具（tools/admin_setup.php）
// の両方から読み込む。
//
// コマンド（CLI）からも読み込まれるので、読み込んだだけでは何も出力せず、
// setCorsHeaders() も exit も呼ばない。応答を返して終わるのは respondError() と
// rollBackAndRespondError() だけ（API から呼ぶ）。
// 入力の確かめ（validateEmployeeFields）は、終わらずにエラーの文を返す。
//
// 仮のパスワードは、作った API の応答で1回だけ返す。DB にはハッシュだけを入れる。
// error_log・操作の記録（recordAdminAction）には、仮のパスワードも、変えた値も入れない。
// =========================================

define('TEMP_PASSWORD_LENGTH', 12);
// 見間違えやすい 0 O o 1 l I を除いた英大文字・英小文字・数字
define('TEMP_PASSWORD_ALPHABET', 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789');

// 社員IDに使える文字と長さ。名前・部署の最大文字数
// （アプリの tumugi_app/js/employee-rules.js と同じにすること）
// D は、末尾の改行を許さないため（$ は、ふつう最後の改行の手前にも当たる）
define('EMPLOYEE_CODE_PATTERN', '/^[A-Za-z0-9_-]{1,20}$/D');
define('EMPLOYEE_TEXT_MAX_CHARS', 50);
// 登録できない社員ID（大文字・小文字を問わない）。
// 操作の記録（admin_audit_logs）では、管理者を作る道具の操作を admin_code = 'CLI' で残す。
// 同じ社員IDの社員がいると、記録の上で道具の操作と見分けがつかなくなるため。
define('EMPLOYEE_RESERVED_CODE', 'cli');

// -----------------------------------------
// 仮のパスワードを作る（random_int で1文字ずつ選ぶ）
// -----------------------------------------
function generateTempPassword(): string {
    $alphabet = TEMP_PASSWORD_ALPHABET;
    $last = strlen($alphabet) - 1;
    $password = '';
    for ($i = 0; $i < TEMP_PASSWORD_LENGTH; $i++) {
        $password .= $alphabet[random_int(0, $last)];
    }
    return $password;
}

// -----------------------------------------
// 文字列にして、前後の空白を除く。全角スペース（U+3000）なども空白として除く。
// 文字列・数値以外（null・配列・真偽値）は空の文字列にする。
// （アプリの employee-rules.js は JavaScript の trim() を使うので、同じ範囲にそろえている）
// -----------------------------------------
function normalizeText(mixed $value): string {
    if (is_int($value) || is_float($value)) {
        $value = (string)$value;
    }
    if (!is_string($value)) {
        return '';
    }
    // 不正な UTF-8 だと preg_replace は null を返す。そのときも空の文字列にする
    $trimmed = preg_replace('/^[\s\p{Z}\x{FEFF}]+|[\s\p{Z}\x{FEFF}]+$/u', '', $value);
    return $trimmed ?? '';
}

// -----------------------------------------
// 社員の入力（登録・直す）の形を確かめる。
// 確かめる順は 社員ID（形 → 使えない社員ID）→ 名前 → 部署。最初に当てはまったものだけを error に入れる（なければ null）。
// 決まりとメッセージは、アプリの employee-rules.js の validateEmployeeForm() と同じ。
// $isNew が false のときは、社員IDは確かめない（社員IDは変えられず、探すのに使うだけ）。
// 新卒・管理者は、真偽値として読み、0 か 1 にする（ない・読めないときは 0）。
// 終わらずに結果を返す（CLI からも使うため）：
//   ['error' => ?string, 'values' => [employee_code, display_name, department, is_new_grad, is_admin]]
// -----------------------------------------
function validateEmployeeFields(array $input, bool $isNew): array {
    $values = [
        'employee_code' => normalizeText($input['employee_code'] ?? ''),
        'display_name'  => normalizeText($input['display_name'] ?? ''),
        'department'    => normalizeText($input['department'] ?? ''),
        'is_new_grad'   => filter_var($input['is_new_grad'] ?? false, FILTER_VALIDATE_BOOLEAN) ? 1 : 0,
        'is_admin'      => filter_var($input['is_admin'] ?? false, FILTER_VALIDATE_BOOLEAN) ? 1 : 0,
    ];

    $error = null;
    $nameLength = mb_strlen($values['display_name'], 'UTF-8');
    $departmentLength = mb_strlen($values['department'], 'UTF-8');

    if ($isNew && !preg_match(EMPLOYEE_CODE_PATTERN, $values['employee_code'])) {
        $error = '社員IDは英数字・-・_ の1〜20文字にしてください';
    } elseif ($isNew && strtolower($values['employee_code']) === EMPLOYEE_RESERVED_CODE) {
        $error = '社員ID「CLI」は、管理者を作る道具の記録に使うため、登録できません';
    } elseif ($nameLength === 0) {
        $error = '名前を入れてください';
    } elseif ($nameLength > EMPLOYEE_TEXT_MAX_CHARS) {
        $error = '名前は50文字までにしてください';
    } elseif ($departmentLength === 0) {
        $error = '部署を入れてください';
    } elseif ($departmentLength > EMPLOYEE_TEXT_MAX_CHARS) {
        $error = '部署は50文字までにしてください';
    }

    return ['error' => $error, 'values' => $values];
}

// -----------------------------------------
// リクエストの本文（JSON）を配列にして返す。JSON でない・配列でないときは空の配列
// -----------------------------------------
function readJsonInput(): array {
    $input = json_decode(file_get_contents('php://input'), true);
    return is_array($input) ? $input : [];
}

// -----------------------------------------
// {"error": "…"} を返して終わる（API 用）
// -----------------------------------------
function respondError(int $status, string $message): never {
    http_response_code($status);
    echo json_encode(['error' => $message]);
    exit;
}

// -----------------------------------------
// トランザクションの途中でエラーを返すとき。先に元に戻してから返す
// -----------------------------------------
function rollBackAndRespondError(PDO $pdo, int $status, string $message): never {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    respondError($status, $message);
}

// -----------------------------------------
// 社員IDで社員を探し、その行をロックして返す。いなければ null。
// トランザクションの中で使う（ロックはコミットまで続く）。
// 社員IDの大文字・小文字は区別されない（照合順序が utf8mb4_general_ci のため）。
// 返す employee_code は、DB に入っている形。
// -----------------------------------------
function findEmployeeForUpdate(PDO $pdo, string $code): ?array {
    $stmt = $pdo->prepare(
        "SELECT id, employee_code, display_name, department, is_active, is_new_grad, is_admin
         FROM employees
         WHERE employee_code = :code
         FOR UPDATE"
    );
    $stmt->execute(['code' => $code]);
    $row = $stmt->fetch();
    if (!$row) {
        return null;
    }
    return [
        'id'            => (int)$row['id'],
        'employee_code' => $row['employee_code'],
        'display_name'  => $row['display_name'],
        'department'    => $row['department'],
        'is_active'     => (int)$row['is_active'],
        'is_new_grad'   => (int)$row['is_new_grad'],
        'is_admin'      => (int)$row['is_admin'],
    ];
}

// -----------------------------------------
// 在籍の管理者（is_admin = 1 かつ is_active = 1）の行をロックして、人数を返す。
// ほかの管理者が同時に管理者を外しても、「最後の管理者」の判定が崩れないようにするため。
// トランザクションの中で使う。
// -----------------------------------------
function countActiveAdminsForUpdate(PDO $pdo): int {
    $stmt = $pdo->query(
        "SELECT id FROM employees WHERE is_admin = 1 AND is_active = 1 FOR UPDATE"
    );
    return count($stmt->fetchAll());
}

// -----------------------------------------
// 仮のパスワードに替える（リセット・管理者を作る道具で使う）。
//   - パスワードのハッシュを替え、must_change_password = 1 にする
//   - その社員のトークンをすべて消す（ログインしていた PC が、すべて切れる）
//   - その社員のログインの失敗を消す（仮のパスワードで、すぐログインできるように）
// 仮のパスワードを返す（呼んだ側が、応答や画面に1回だけ出す）。
// トランザクションの中で使う。
// -----------------------------------------
function setTempPassword(PDO $pdo, int $employeeId, string $employeeCode): string {
    $tempPassword = generateTempPassword();
    $hash = password_hash($tempPassword, PASSWORD_BCRYPT);

    $update = $pdo->prepare(
        "UPDATE employees SET password_hash = :hash, must_change_password = 1 WHERE id = :id"
    );
    $update->execute(['hash' => $hash, 'id' => $employeeId]);

    $revoke = $pdo->prepare("DELETE FROM auth_tokens WHERE employee_id = :id");
    $revoke->execute(['id' => $employeeId]);

    $clear = $pdo->prepare(
        "DELETE FROM login_attempts WHERE employee_code = :code AND succeeded = 0"
    );
    $clear->execute(['code' => $employeeCode]);

    return $tempPassword;
}

// -----------------------------------------
// 管理者の操作を admin_audit_logs に残す。トランザクションの中で、書き込みのあとに呼ぶ。
// $action は create / update / reset_password / deactivate / reactivate / delete。
// $detail は update のときの、変えた項目の名前だけ（値は入れない）。
// 仮のパスワードも、変えた値も、ここには渡さない。
// -----------------------------------------
function recordAdminAction(PDO $pdo, string $adminCode, string $action, string $targetCode, ?string $detail = null): void {
    $stmt = $pdo->prepare(
        "INSERT INTO admin_audit_logs (admin_code, action, target_code, detail)
         VALUES (:admin, :action, :target, :detail)"
    );
    $stmt->execute([
        'admin'  => $adminCode,
        'action' => $action,
        'target' => $targetCode,
        'detail' => $detail,
    ]);
}
