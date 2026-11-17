<?php
// =========================================
// notices.php
// 本人あての知らせ（employee_notices）を書く関数。
// 管理者が、社員の所属などを変えたときに、本人に見える形で残す
// （管理者が、気づかれずに所属を動かせないようにするため）。
//
// kind と、old_value・new_value の中身：
//   department      所属の部署（部署名）
//   new_grad        新卒の印（"1" か "0"）
//   admin           管理者の印（"1" か "0"）
//   reactivated     在籍に戻した（NULL）
//   password_reset  仮のパスワードを発行した（NULL）
// 読むのは my_notices.php、見た印を付けるのは my_notices_seen.php。
// =========================================

// -----------------------------------------
// 知らせを1行足す。社員の変更と同じトランザクションの中で、書き込みのあとに呼ぶ。
// 変更が失敗して元に戻れば、知らせも残らない。
// -----------------------------------------
function recordEmployeeNotice(PDO $pdo, int $employeeId, string $kind, ?string $oldValue = null, ?string $newValue = null): void {
    $stmt = $pdo->prepare(
        "INSERT INTO employee_notices (employee_id, kind, old_value, new_value)
         VALUES (:eid, :kind, :old, :new)"
    );
    $stmt->execute([
        'eid'  => $employeeId,
        'kind' => $kind,
        'old'  => $oldValue,
        'new'  => $newValue,
    ]);
}
