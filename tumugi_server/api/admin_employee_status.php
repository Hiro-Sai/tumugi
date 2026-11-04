<?php
// =========================================
// admin_employee_status.php
// 社員を退職にする・在籍に戻す（管理者だけ）。
// 受け取る JSON：{ "employee_code", "is_active": bool }（false：退職にする、true：在籍に戻す）
// 成功したら 200 で {"status":"ok"} を返す。
//
// - 退職にする：自分自身と、最後の在籍の管理者は止める。その社員のトークンをすべて消す（すぐ使えなくなる）。
//   操作の記録：action は deactivate。
// - 在籍に戻す：パスワードは変えない。操作の記録：action は reactivate。
// - 今と同じ状態なら、何も書き込まず、記録も残さずに ok を返す。
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

// true か false だけ受ける（送り忘れで、退職にしてしまわないように）
if (!is_bool($input['is_active'] ?? null)) {
    respondError(400, '在籍に戻すか退職にするかを、true か false で指定してください');
}
$makeActive = $input['is_active'];

$pdo = getDbConnection();
$pdo->beginTransaction();

$target = findEmployeeForUpdate($pdo, $code);
if ($target === null) {
    rollBackAndRespondError($pdo, 404, 'その社員は見つかりません');
}

if ($makeActive) {
    // 在籍に戻す
    if ($target['is_active'] === 1) {
        // すでに在籍。何もしない
        $pdo->rollBack();
        echo json_encode(['status' => 'ok']);
        exit;
    }

    $update = $pdo->prepare("UPDATE employees SET is_active = 1 WHERE id = :id");
    $update->execute(['id' => $target['id']]);

    recordAdminAction($pdo, $admin['employee_code'], 'reactivate', $target['employee_code']);
} else {
    // 退職にする
    if ($target['id'] === $admin['id']) {
        rollBackAndRespondError(
            $pdo, 400,
            '自分自身には、この操作はできません。自分のパスワードは、チャットの「設定」から変えてください'
        );
    }

    if ($target['is_active'] === 0) {
        // すでに退職。何もしない
        $pdo->rollBack();
        echo json_encode(['status' => 'ok']);
        exit;
    }

    // 在籍の管理者が、最後の1人になるとき（ここに来たとき、対象は在籍中）
    if ($target['is_admin'] === 1 && countActiveAdminsForUpdate($pdo) <= 1) {
        rollBackAndRespondError($pdo, 400, '在籍している管理者がいなくなるため、この操作はできません');
    }

    $update = $pdo->prepare("UPDATE employees SET is_active = 0 WHERE id = :id");
    $update->execute(['id' => $target['id']]);

    // 退職にした社員のログインを、すべて切る
    $revoke = $pdo->prepare("DELETE FROM auth_tokens WHERE employee_id = :id");
    $revoke->execute(['id' => $target['id']]);

    recordAdminAction($pdo, $admin['employee_code'], 'deactivate', $target['employee_code']);
}

$pdo->commit();

echo json_encode(['status' => 'ok']);
