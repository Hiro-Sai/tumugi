<?php
// =========================================
// admin_guard.php
// 管理者だけが使える API の入口で呼ぶ確かめ。
// dashboard_data.php と、社員の管理の API（admin_employee*.php）で共有する。
// 確かめ方を1か所にして、API ごとに食い違わないようにする。
// =========================================

require_once __DIR__ . '/db.php';

// -----------------------------------------
// 在籍している管理者（is_admin = 1 かつ is_active = 1）だけを通す。
//   - トークンが通らない（なし・期限切れ・退職者・仮のパスワードのまま）→ 401「認証が必要です」
//   - 在籍の管理者ではない → 403「この機能を利用する権限がありません」
// 通ったら、操作している管理者の id と社員ID（employee_code）を返す。
// 権限はサーバーが毎回 DB で確かめる。画面（アプリ）の出し分けは見た目だけ。
// -----------------------------------------
function requireAdmin(): array {
    $employeeId = verifyToken();
    if ($employeeId === null) {
        http_response_code(401);
        echo json_encode(['error' => '認証が必要です']);
        exit;
    }

    $pdo = getDbConnection();
    $stmt = $pdo->prepare(
        "SELECT employee_code, is_admin FROM employees WHERE id = :id AND is_active = 1"
    );
    $stmt->execute(['id' => $employeeId]);
    $row = $stmt->fetch();

    if (!$row || (int)$row['is_admin'] !== 1) {
        http_response_code(403);
        echo json_encode(['error' => 'この機能を利用する権限がありません']);
        exit;
    }

    return ['id' => $employeeId, 'employee_code' => $row['employee_code']];
}
