<?php
// =========================================
// admin_employee_reset.php
// 社員のパスワードを、仮のパスワードにリセットする（管理者だけ）。
// 受け取る JSON：{ "employee_code" }
// 成功したら 200 で {"status":"ok","temp_password":"…"} を返す。
//
// - 仮のパスワードに替え、must_change_password = 1 にする。その社員のトークンをすべて消し（ログインが切れる）、
//   ログインの失敗も消す（includes/employee_admin.php の setTempPassword）。
//   仮のパスワードが出るのは、この応答だけ（ログにも操作の記録にも残さない）。
// - 自分自身はリセットできない（自分のパスワードは、チャットの「設定」から変える）。
// - 操作の記録：action は reset_password。
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
$code = normalizeText($input['employee_code'] ?? '');

$pdo = getDbConnection();
$pdo->beginTransaction();

$target = findEmployeeForUpdate($pdo, $code);
if ($target === null) {
    rollBackAndRespondError($pdo, 404, 'その社員は見つかりません');
}

if ($target['id'] === $admin['id']) {
    rollBackAndRespondError(
        $pdo, 400,
        '自分自身には、この操作はできません。自分のパスワードは、チャットの「設定」から変えてください'
    );
}

$tempPassword = setTempPassword($pdo, $target['id'], $target['employee_code']);

recordAdminAction($pdo, $admin['employee_code'], 'reset_password', $target['employee_code']);

$pdo->commit();

echo json_encode(['status' => 'ok', 'temp_password' => $tempPassword]);
