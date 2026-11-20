<?php
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/admin_guard.php';
require_once __DIR__ . '/../includes/aggregate_rules.php';
startApi();

// -----------------------------------------
// 管理者権限チェック（includes/admin_guard.php）
// is_admin=1 かつ is_active=1 の社員のみダッシュボードを閲覧できる。
// 通らなければ、401（認証が必要です）か 403（この機能を利用する権限がありません）でここで終わる。
// -----------------------------------------
requireAdmin();

$pdo = getDbConnection();

// 集計の決まりの定数（MIN_DEPT_SIZE など）は includes/aggregate_rules.php にある

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
// 集計は、記録した時点の所属（emotion_logs.department / is_new_grad）で作る。
// 社員の「今の」所属（employees.department など）で数えると、管理者が部署を付け替えるだけで、
// 集計が変わってしまう。例えば11名の部署から1人を移して10名の部署を作ると、
// 差から移した人の値が分かるし、最低人数（MIN_DEPT_SIZE）の守りもすり抜けられる。
// 記録の側に所属を持たせておけば、付け替えても、すでにある記録の行き先は動かない。
//
// 集計に入る記録の条件（部署・新卒・ハラスメントの3つとも同じ）：
//   - 直近 AGGREGATE_WINDOW_DAYS 日の記録（l.recorded_at）
//   - l.is_counted = 1。記録した時点で、管理者の記録と、集計に入れ始める時刻（employees.counted_from）から
//     NEW_EMPLOYEE_WAIT_DAYS 日以内の記録を 0 にしてある（api/save_emotion.php）。
//     あとから管理者の印を付けても、待ちが明けても、すでにある記録の印は動かない。
//     集計のときに時刻で見ると、待ちが明けた瞬間にそれまでの記録がいっぺんに入り、差でその人の値が分かるため。
// 在籍か退職か（employees.is_active）は見ない。退職にした途端に人数が減ると、これも差から分かるため。
// 時刻の比較は、すべて MySQL の NOW() で行う（PHP の時計とは混ぜない）。
// 日数は整数の定数だけを SQL に入れる（利用者の入力は入らない）。
// -----------------------------------------
const COUNTED_LOGS_WHERE = "
    l.recorded_at >= (NOW() - INTERVAL " . AGGREGATE_WINDOW_DAYS . " DAY)
      AND l.is_counted = 1
";

// -----------------------------------------
// 社員ごとの集計。部署別・新卒の集計はこれをもとにする。
// 平均スコアは「社員ごとの平均」をグループで平均する。ログの件数で重みを付けると、
// よく話す人の気分でグループの値が決まってしまうため。
// -----------------------------------------

// 部署別用：記録の所属ごとに、社員1人を1行にする。
// 直近7日のうちに部署を移った人は、前の部署と新しい部署の両方で1人と数える
const PER_EMPLOYEE_DEPT_SQL = "
    SELECT l.department,
           l.employee_id,
           AVG(l.negativity_score) AS emp_avg,
           COUNT(l.id) AS emp_logs,
           SUM(l.is_crisis) AS emp_crisis_logs,
           MAX(l.is_crisis) AS emp_has_crisis
    FROM emotion_logs l
    WHERE " . COUNTED_LOGS_WHERE . "
    GROUP BY l.employee_id, l.department
";

// 新卒用：記録の時点で新卒だった行だけを、社員ごとに1行にする（部署はまたぐので見ない）
const PER_EMPLOYEE_NEW_GRAD_SQL = "
    SELECT l.employee_id,
           AVG(l.negativity_score) AS emp_avg,
           COUNT(l.id) AS emp_logs,
           SUM(l.is_crisis) AS emp_crisis_logs,
           MAX(l.is_crisis) AS emp_has_crisis
    FROM emotion_logs l
    WHERE " . COUNTED_LOGS_WHERE . "
      AND l.is_new_grad = 1
    GROUP BY l.employee_id
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
     FROM (" . PER_EMPLOYEE_DEPT_SQL . ") p
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
     FROM (" . PER_EMPLOYEE_NEW_GRAD_SQL . ") p"
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
         WHERE " . COUNTED_LOGS_WHERE . "
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