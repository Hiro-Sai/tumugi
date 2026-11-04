<?php
// =========================================
// admin_employee_create.php
// 社員を登録する（管理者だけ）。
// 受け取る JSON：{ "employee_code", "display_name", "department", "is_new_grad": bool, "is_admin": bool }
// 成功したら 200 で {"status":"ok","employee_code":"…","temp_password":"…"} を返す。
//
// - 仮のパスワードはサーバーが作る。DB にはハッシュだけを入れ、must_change_password = 1 にする。
//   仮のパスワードが出るのは、この応答だけ（ログにも操作の記録にも残さない）。
// - 社員IDの重複は、事前の SELECT ではなく INSERT の UNIQUE 違反（SQLSTATE 23000）で見つけて 409 にする。
//   同時に2回届いても、1人だけ登録されるようにするため。
//   大文字・小文字は区別されない（e001 と E001 は同じ）。
// - 操作の記録：action は create。
// =========================================
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/admin_guard.php';
require_once __DIR__ . '/../includes/employee_admin.php';
setCorsHeaders();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respondError(405, 'POSTメソッドのみ許可されています');
}

$admin = requireAdmin();

$input = readJsonInput();

$result = validateEmployeeFields($input, true);
if ($result['error'] !== null) {
    respondError(400, $result['error']);
}
$values = $result['values'];

// 新卒・管理者は true か false だけ受ける（送り忘れたまま、管理者や新卒でなくなってしまわないように）
if (!is_bool($input['is_new_grad'] ?? null) || !is_bool($input['is_admin'] ?? null)) {
    respondError(400, '新卒・管理者は、true か false で指定してください');
}

$tempPassword = generateTempPassword();
$hash = password_hash($tempPassword, PASSWORD_BCRYPT);

$pdo = getDbConnection();
$pdo->beginTransaction();

try {
    $insert = $pdo->prepare(
        "INSERT INTO employees
            (employee_code, password_hash, display_name, department,
             is_active, is_new_grad, is_admin, must_change_password)
         VALUES (:code, :hash, :name, :department, 1, :new_grad, :admin, 1)"
    );
    $insert->execute([
        'code'       => $values['employee_code'],
        'hash'       => $hash,
        'name'       => $values['display_name'],
        'department' => $values['department'],
        'new_grad'   => $values['is_new_grad'],
        'admin'      => $values['is_admin'],
    ]);
} catch (PDOException $e) {
    // SQLSTATE 23000：UNIQUE 違反（同じ社員IDがすでにある）
    if ($e->getCode() === '23000') {
        rollBackAndRespondError($pdo, 409, 'その社員IDはすでに使われています');
    }
    throw $e;
}

recordAdminAction($pdo, $admin['employee_code'], 'create', $values['employee_code']);

$pdo->commit();

echo json_encode([
    'status'        => 'ok',
    'employee_code' => $values['employee_code'],
    'temp_password' => $tempPassword,
]);
