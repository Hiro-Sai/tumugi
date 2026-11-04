<?php
// =========================================
// admin_employees.php
// 社員の一覧（管理者だけ）。
// 受け取るもの：なし（GET）
// 返すもの：
//   {
//     "employees":   [{ employee_code, display_name, department, is_new_grad, is_admin, is_active, must_change_password }],
//     "departments": [在籍の社員の部署（重複なし・昇順）],
//     "self_code":   操作している管理者の社員ID（画面が自分自身の行を見分けるため）
//   }
//   真偽値は bool で返す。
//
// - 退職者だけの古い部署は、departments に入れない（部署を選ぶ候補に出さないため）。
// - 感情に関わる情報（感情ログ、危機、ハラスメント、ログの件数など）と、
//   パスワードのハッシュは、一切選ばない。
// =========================================
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/admin_guard.php';
require_once __DIR__ . '/../includes/employee_admin.php';
setCorsHeaders();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    respondError(405, 'GETメソッドのみ許可されています');
}

$admin = requireAdmin();

$pdo = getDbConnection();

$rows = $pdo->query(
    "SELECT employee_code, display_name, department,
            is_new_grad, is_admin, is_active, must_change_password
     FROM employees
     ORDER BY employee_code"
)->fetchAll();

$employees = array_map(fn($row) => [
    'employee_code'        => $row['employee_code'],
    'display_name'         => $row['display_name'],
    'department'           => $row['department'],
    'is_new_grad'          => (bool)$row['is_new_grad'],
    'is_admin'             => (bool)$row['is_admin'],
    'is_active'            => (bool)$row['is_active'],
    'must_change_password' => (bool)$row['must_change_password'],
], $rows);

$departments = $pdo->query(
    "SELECT DISTINCT department FROM employees WHERE is_active = 1 ORDER BY department"
)->fetchAll(PDO::FETCH_COLUMN);

echo json_encode([
    'employees'   => $employees,
    'departments' => $departments,
    'self_code'   => $admin['employee_code'],
]);
