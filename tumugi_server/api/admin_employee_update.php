<?php
// =========================================
// admin_employee_update.php
// 社員の名前・部署・新卒・管理者を直す（管理者だけ）。
// 受け取る JSON：{ "employee_code", "display_name", "department", "is_new_grad": bool, "is_admin": bool }
// 成功したら 200 で {"status":"ok"} を返す。
//
// - 社員IDは変えない（探すのに使うだけ）。退職中の社員も直せる。
// - 自分自身の名前・部署は直せる。止めるのは、自分を管理者から外すことだけ。
// - 在籍の管理者を管理者から外すとき、在籍の管理者が1人だけなら止める（管理者がいなくなるため）。
// - 今の値と比べて、変わった項目だけを記録する。何も変わっていなければ、書き込まず、記録も残さずに ok を返す。
// - 操作の記録：action は update。detail は、変えた項目の名前をコンマでつないだもの（値は入れない）。
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

$result = validateEmployeeFields($input, false);
if ($result['error'] !== null) {
    respondError(400, $result['error']);
}
$values = $result['values'];

// 新卒・管理者は true か false だけ受ける（送り忘れたまま、管理者や新卒でなくなってしまわないように）
if (!is_bool($input['is_new_grad'] ?? null) || !is_bool($input['is_admin'] ?? null)) {
    respondError(400, '新卒・管理者は、true か false で指定してください');
}

$pdo = getDbConnection();
$pdo->beginTransaction();

$target = findEmployeeForUpdate($pdo, $values['employee_code']);
if ($target === null) {
    rollBackAndRespondError($pdo, 404, 'その社員は見つかりません');
}

// 管理者を外す（true → false）ときの守り
if ($target['is_admin'] === 1 && $values['is_admin'] === 0) {
    if ($target['id'] === $admin['id']) {
        rollBackAndRespondError(
            $pdo, 400,
            '自分自身には、この操作はできません。自分のパスワードは、チャットの「設定」から変えてください'
        );
    }
    // 在籍の管理者が、最後の1人になるとき
    if ($target['is_active'] === 1 && countActiveAdminsForUpdate($pdo) <= 1) {
        rollBackAndRespondError($pdo, 400, '在籍している管理者がいなくなるため、この操作はできません');
    }
}

// 変わった項目の名前
$changed = [];
foreach (['display_name', 'department', 'is_new_grad', 'is_admin'] as $field) {
    if ($target[$field] !== $values[$field]) {
        $changed[] = $field;
    }
}

if ($changed === []) {
    // 何も変わっていない。書き込まず、記録も残さない
    $pdo->rollBack();
    echo json_encode(['status' => 'ok']);
    exit;
}

$update = $pdo->prepare(
    "UPDATE employees
     SET display_name = :name, department = :department, is_new_grad = :new_grad, is_admin = :admin
     WHERE id = :id"
);
$update->execute([
    'name'       => $values['display_name'],
    'department' => $values['department'],
    'new_grad'   => $values['is_new_grad'],
    'admin'      => $values['is_admin'],
    'id'         => $target['id'],
]);

recordAdminAction($pdo, $admin['employee_code'], 'update', $target['employee_code'], implode(',', $changed));

$pdo->commit();

echo json_encode(['status' => 'ok']);
