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
// - 部署・新卒・管理者の印が変わったときは、本人あての知らせ（employee_notices）に、前の値と後の値を残す
//   （自分自身を変えたときも残す）。
// - 管理者の印を外したときは、集計に入れ始める時刻（counted_from）を今にする。
// =========================================
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/admin_guard.php';
require_once __DIR__ . '/../includes/employee_admin.php';
require_once __DIR__ . '/../includes/notices.php';
startApi();

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

// 管理者の印を外したときは、そこから7日は集計に入れない（集計に入れ始める時刻 counted_from を今にする）。
// 管理者の記録は集計に入れていないので、外した直後からすぐ入れると、人数の水増しに使えてしまうため。
$resetCountedFrom = in_array('is_admin', $changed, true) && $values['is_admin'] === 0
    ? ', counted_from = NOW()'
    : '';
$update = $pdo->prepare(
    "UPDATE employees
     SET display_name = :name, department = :department, is_new_grad = :new_grad, is_admin = :admin{$resetCountedFrom}
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

// 部署・新卒の印・管理者の印が変わったときだけ、本人あての知らせを残す（氏名だけでは残さない）
if (in_array('department', $changed, true)) {
    recordEmployeeNotice($pdo, $target['id'], 'department', $target['department'], $values['department']);
}
if (in_array('is_new_grad', $changed, true)) {
    recordEmployeeNotice($pdo, $target['id'], 'new_grad', (string)$target['is_new_grad'], (string)$values['is_new_grad']);
}
if (in_array('is_admin', $changed, true)) {
    recordEmployeeNotice($pdo, $target['id'], 'admin', (string)$target['is_admin'], (string)$values['is_admin']);
}

$pdo->commit();

echo json_encode(['status' => 'ok']);
