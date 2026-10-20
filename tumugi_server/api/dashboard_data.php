<?php
require_once __DIR__ . '/../includes/db.php';
setCorsHeaders();

$employeeId = verifyToken();
if ($employeeId === null) {
    http_response_code(401);
    echo json_encode(['error' => '認証が必要です']);
    exit;
}

$pdo = getDbConnection();

// -----------------------------------------
// 管理者権限チェック
// is_admin=1 かつ is_active=1 の社員のみダッシュボードを閲覧できる。
// -----------------------------------------
$adminCheckStmt = $pdo->prepare(
    "SELECT is_admin FROM employees WHERE id = :id AND is_active = 1"
);
$adminCheckStmt->execute(['id' => $employeeId]);
$adminRow = $adminCheckStmt->fetch();

if (!$adminRow || (int)$adminRow['is_admin'] !== 1) {
    http_response_code(403);
    echo json_encode(['error' => 'この機能を利用する権限がありません']);
    exit;
}

// -----------------------------------------
// 個人特定の対策：
// 直近7日間に記録がある在籍社員（実際に集計に入る人）が MIN_DEPT_SIZE 名未満の部署・グループは表示しない。
// 在籍人数で判定すると、在籍は多くても記録がある人が少ない部署で、少人数の値がそのまま出てしまうため。
// 10名は、ストレスチェック制度の集団分析の目安（10人を下回る集団の結果は、
// 全員の同意がない限り事業者に渡さない）に合わせている。
// -----------------------------------------
define('MIN_DEPT_SIZE', 10);

// -----------------------------------------
// まれな事象（危機検知・ハラスメント）は、該当したユニーク人数で表示を3段階に分ける。
// 閾値未満だからといって単純に非表示にすると、「1名でもいたら埋もれてしまい
// 会社側が全く気づけない」という別の問題があるため、存在だけは伝える：
//   1. 該当ユニーク人数が0人 → 'none'（何も出さない）
//   2. 該当ユニーク人数が1人以上 MIN_DEPT_SIZE 未満 → 'flag_only'（「あり」とだけ出し、人数・件数は出さない）
//   3. 該当ユニーク人数が MIN_DEPT_SIZE 以上 → 'count'（件数を出す）
// -----------------------------------------
function rareEventDisplay(int $distinctCount, int $logCount): array {
    if ($distinctCount >= MIN_DEPT_SIZE) {
        return ['display' => 'count', 'count' => $logCount];
    }
    if ($distinctCount >= 1) {
        return ['display' => 'flag_only'];
    }
    return ['display' => 'none'];
}

// -----------------------------------------
// 社員ごとの直近7日間の集計（在籍社員のみ）。部署別・新卒の集計はこれをもとにする。
// 平均スコアは「社員ごとの平均」をグループで平均する。ログの件数で重みを付けると、
// よく話す人の気分でグループの値が決まってしまうため。
// -----------------------------------------
const PER_EMPLOYEE_SQL = "
    SELECT e.department,
           e.is_new_grad,
           AVG(l.negativity_score) AS emp_avg,
           COUNT(l.id) AS emp_logs,
           SUM(l.is_crisis) AS emp_crisis_logs,
           MAX(l.is_crisis) AS emp_has_crisis
    FROM emotion_logs l
    JOIN employees e ON e.id = l.employee_id
    WHERE l.recorded_at >= (NOW() - INTERVAL 7 DAY)
      AND e.is_active = 1
    GROUP BY e.id, e.department, e.is_new_grad
";

// -----------------------------------------
// 部署別集計
// -----------------------------------------
$deptStmt = $pdo->prepare(
    "SELECT p.department,
            ROUND(AVG(p.emp_avg), 1) AS avg_score,
            SUM(p.emp_logs) AS log_count,
            SUM(p.emp_crisis_logs) AS crisis_logs,
            SUM(p.emp_has_crisis) AS crisis_people
     FROM (" . PER_EMPLOYEE_SQL . ") p
     GROUP BY p.department
     HAVING COUNT(*) >= :min_size
     ORDER BY p.department"
);
$deptStmt->execute(['min_size' => MIN_DEPT_SIZE]);

$departments = array_map(fn($row) => [
    'department' => $row['department'],
    'avg_score'  => $row['avg_score'],
    'log_count'  => (int)$row['log_count'],
    'crisis'     => rareEventDisplay((int)$row['crisis_people'], (int)$row['crisis_logs']),
], $deptStmt->fetchAll());

$departmentsNote = empty($departments)
    ? '直近7日間に記録がある社員が' . MIN_DEPT_SIZE . '名以上の部署がないため、現在表示できる部署がありません。'
    : null;

// -----------------------------------------
// 新卒集計（全社ひとまとまり、部署をまたいで集計）
// 個人特定リスク対策として、部署別集計と同じ最低人数ルールを適用する
// -----------------------------------------
$newGradRow = $pdo->query(
    "SELECT COUNT(*) AS member_count,
            ROUND(AVG(p.emp_avg), 1) AS avg_score,
            COALESCE(SUM(p.emp_logs), 0) AS log_count,
            COALESCE(SUM(p.emp_crisis_logs), 0) AS crisis_logs,
            COALESCE(SUM(p.emp_has_crisis), 0) AS crisis_people
     FROM (" . PER_EMPLOYEE_SQL . ") p
     WHERE p.is_new_grad = 1"
)->fetch();

$newGrad = null;
$newGradNote = null;

if ((int)$newGradRow['member_count'] >= MIN_DEPT_SIZE) {
    $newGrad = [
        'avg_score' => $newGradRow['avg_score'],
        'log_count' => (int)$newGradRow['log_count'],
        'crisis'    => rareEventDisplay((int)$newGradRow['crisis_people'], (int)$newGradRow['crisis_logs']),
    ];
} else {
    $newGradNote = '直近7日間に記録がある新卒社員が' . MIN_DEPT_SIZE . '名に満たないため、現在表示できません。';
}

// -----------------------------------------
// ハラスメント集計（全社ひとまとまり、部署別バーは作らない）
//
// 「受けた」「言ってしまった」を合算した人数だけで閾値判定すると、
// 例えば「受けた9人＋言ってしまった1人＝合計10人」で閾値を通過してしまい、
// 内訳の「言ってしまった：1件」がそのまま加害者個人の特定につながる。
// これを防ぐため、カテゴリ（受けた/言ってしまった）ごとに個別に
// ユニーク人数で3段階の表示を決める（rareEventDisplay）。
// 画面側では、'count' は棒グラフ、'flag_only' は人数非公開のバッジで表示する。
// -----------------------------------------
function getHarassmentCategoryStats(PDO $pdo, string $type): array {
    $stmt = $pdo->prepare(
        "SELECT COUNT(DISTINCT l.employee_id) AS distinct_count, COUNT(l.id) AS log_count
         FROM emotion_logs l
         JOIN employees e ON e.id = l.employee_id
         WHERE l.recorded_at >= (NOW() - INTERVAL 7 DAY)
           AND e.is_active = 1
           AND l.harassment_type = :type"
    );
    $stmt->execute(['type' => $type]);
    $row = $stmt->fetch();

    return rareEventDisplay((int)($row['distinct_count'] ?? 0), (int)($row['log_count'] ?? 0));
}

$harassment = [
    'received' => getHarassmentCategoryStats($pdo, 'received'),
    'said'     => getHarassmentCategoryStats($pdo, 'said'),
];

echo json_encode([
    'departments'   => $departments,
    'note'          => $departmentsNote,
    'new_grad'      => $newGrad,
    'new_grad_note' => $newGradNote,
    'harassment'    => $harassment,
    'min_dept_size' => MIN_DEPT_SIZE,
]);