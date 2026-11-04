<?php
// =========================================
// admin_employee_delete.php
// 退職にした社員を消す（管理者だけ）。元に戻せない。
// 受け取る JSON：{ "employee_code", "confirm_code" }
// 成功したら 200 で {"status":"ok"} を返す。
//
// - 消せるのは、退職にした社員だけ。在籍中は 400。自分自身は在籍中なので消せない。
// - confirm_code は、消す社員の社員IDと同じ文字でなければならない（大文字・小文字も区別する）。
//   画面で打ち込んでもらった社員IDを、サーバーでも確かめる。
// - login_attempts のその社員IDの行を消してから、employees を消す。
//   感情ログとトークンは、外部キーの ON DELETE CASCADE で一緒に消える。
// - 操作の記録（admin_audit_logs）は、社員IDを文字で持つので、社員を消しても残る。action は delete。
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
$confirmCode = normalizeText($input['confirm_code'] ?? '');

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

if ($target['is_active'] === 1) {
    rollBackAndRespondError($pdo, 400, '在籍中の社員は消せません。先に退職にしてください');
}

// 大文字・小文字も区別して、DB に入っている社員IDと照らす
if ($confirmCode !== $target['employee_code']) {
    rollBackAndRespondError($pdo, 400, '確かめの社員IDが一致しません');
}

$clearAttempts = $pdo->prepare("DELETE FROM login_attempts WHERE employee_code = :code");
$clearAttempts->execute(['code' => $target['employee_code']]);

$delete = $pdo->prepare("DELETE FROM employees WHERE id = :id");
$delete->execute(['id' => $target['id']]);

recordAdminAction($pdo, $admin['employee_code'], 'delete', $target['employee_code']);

$pdo->commit();

echo json_encode(['status' => 'ok']);
