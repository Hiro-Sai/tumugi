<?php
// =========================================
// tools/seed_demo.php
// デモ用データ（社員48名と管理者1名・感情ログ）を投入する。
// XAMPP 時代のデモデータ投入スクリプト5本（シード4本と作り直し用1本）を1本に統合したもの。統合前のファイルは Git の履歴にある。
//
// 実行方法（リポジトリのルートで）：
//   docker compose up -d
//     … seed サービスとして、起動時に自動で1回実行される
//   docker compose run --rm seed --refresh
//     … 感情ログだけを作り直す（デモの直前用）
//
// 動作：
//   - 環境変数 DEMO_SEED が "true" 以外なら何もしない（--refresh も無視する）。
//     実運用（DEMO_SEED=false）の DB で誤って実行しても、本物のログを消さないため。
//   - デモ用ではない社員が1人でもいる DB では、何もせずにエラーで終了する（終了コード1）。
//     DEMO_SEED を true にしたまま実運用の DB で起動してしまったときの安全装置。
//   - まだ登録されていないデモ用アカウントだけを登録する（デモ社員を足したあとの既存の DB でも、足りない分だけ増える）。
//   - emotion_logs が空のとき（または --refresh 指定時）だけ感情ログを作る。
//   → 何度実行しても二重に登録されない（ロックファイルは不要）。
// =========================================

if (php_sapi_name() !== 'cli') {
    http_response_code(403);
    exit(1);
}

if (getenv('DEMO_SEED') !== 'true') {
    echo "DEMO_SEED が true ではないため、デモデータの投入をスキップしました。\n";
    exit(0);
}

$demoPassword = getenv('DEMO_PASSWORD');
if ($demoPassword === false || $demoPassword === '') {
    fwrite(STDERR, "DEMO_PASSWORD が設定されていません。リポジトリルートの .env を確認してください。\n");
    exit(1);
}

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/emotion_scores.php';

// -----------------------------------------
// デモ用のアカウント [社員コード, 部署, 新卒か, 管理者か]
// この順番で登録するので、id は E001=1 … E020=20、A001=21、E021=22 … E048=49 になる。
// E001〜E020 と A001 は XAMPP 時代と同じ id（アプリ側に残っている社員IDごとの同意設定と食い違わない）。
// E021〜E048 は、ダッシュボードの最低人数を10名にしたときに足した社員。既存の id をずらさないよう後ろに置く。
// 各部署12名（うち新卒3名）・新卒は全社で12名。10名ちょうどにしないのは、日がたって記録が
// 7日より古くなった人が1人出ただけで、その部署がダッシュボードから消えないようにするため。
// 管理者1名だけの「管理部」は、最低人数に満たないので集計に入らない。
// -----------------------------------------
const DEMO_ACCOUNTS = [
    ['E001', '営業部', false, false],
    ['E002', '営業部', false, false],
    ['E003', '開発部', false, false],
    ['E004', '人事部', false, false],
    ['E005', '製造部', false, false],
    ['E006', '営業部', true,  false],
    ['E007', '営業部', false, false],
    ['E008', '営業部', false, false],
    ['E009', '開発部', true,  false],
    ['E010', '開発部', true,  false],
    ['E011', '開発部', false, false],
    ['E012', '開発部', false, false],
    ['E013', '人事部', true,  false],
    ['E014', '人事部', true,  false],
    ['E015', '人事部', false, false],
    ['E016', '人事部', false, false],
    ['E017', '製造部', true,  false],
    ['E018', '製造部', false, false],
    ['E019', '製造部', false, false],
    ['E020', '製造部', false, false],
    ['A001', '管理部', false, true],
    ['E021', '営業部', true,  false],
    ['E022', '営業部', true,  false],
    ['E023', '営業部', false, false],
    ['E024', '営業部', false, false],
    ['E025', '営業部', false, false],
    ['E026', '営業部', false, false],
    ['E027', '営業部', false, false],
    ['E028', '開発部', true,  false],
    ['E029', '開発部', false, false],
    ['E030', '開発部', false, false],
    ['E031', '開発部', false, false],
    ['E032', '開発部', false, false],
    ['E033', '開発部', false, false],
    ['E034', '開発部', false, false],
    ['E035', '人事部', true,  false],
    ['E036', '人事部', false, false],
    ['E037', '人事部', false, false],
    ['E038', '人事部', false, false],
    ['E039', '人事部', false, false],
    ['E040', '人事部', false, false],
    ['E041', '人事部', false, false],
    ['E042', '製造部', true,  false],
    ['E043', '製造部', true,  false],
    ['E044', '製造部', false, false],
    ['E045', '製造部', false, false],
    ['E046', '製造部', false, false],
    ['E047', '製造部', false, false],
    ['E048', '製造部', false, false],
];

// ハラスメント申告のデモ（社員コード => 種別）
const DEMO_HARASSMENT = [
    'E003' => 'received',
    'E007' => 'received',
    'E011' => 'received',
    'E015' => 'said',
    'E019' => 'said',
    'E005' => 'said',
];

// まだ登録されていないデモ用アカウントだけを、DEMO_ACCOUNTS の順番で登録する。登録した人数を返す
function insertMissingDemoAccounts(PDO $pdo, string $password): int {
    $existingCodes = $pdo->query("SELECT employee_code FROM employees")->fetchAll(PDO::FETCH_COLUMN);

    $stmt = $pdo->prepare(
        "INSERT INTO employees (employee_code, password_hash, display_name, department, is_new_grad, is_admin)
         VALUES (:code, :hash, :name, :dept, :new_grad, :admin)"
    );

    $added = 0;
    $pdo->beginTransaction();
    foreach (DEMO_ACCOUNTS as [$code, $dept, $isNewGrad, $isAdmin]) {
        if (in_array($code, $existingCodes, true)) {
            continue;
        }
        $stmt->execute([
            'code'     => $code,
            'hash'     => password_hash($password, PASSWORD_BCRYPT),
            'name'     => $isAdmin ? '管理者' : 'ダミー社員' . (int)substr($code, 1),
            'dept'     => $dept,
            'new_grad' => $isNewGrad ? 1 : 0,
            'admin'    => $isAdmin ? 1 : 0,
        ]);
        $added++;
    }
    $pdo->commit();

    return $added;
}

// 直近6日間のランダムな時刻（ダッシュボードの「直近7日間」に必ず入るようにする）
function randomRecentTimestamp(): string {
    return date('Y-m-d H:i:s', time() - random_int(0, 6 * 24 * 60 * 60));
}

function insertDemoEmotionLogs(PDO $pdo): int {
    // 管理者（is_admin=1）のログは作らない
    $employees = $pdo->query(
        "SELECT id, employee_code FROM employees WHERE is_active = 1 AND is_admin = 0 ORDER BY id"
    )->fetchAll();

    $stmt = $pdo->prepare(
        "INSERT INTO emotion_logs (employee_id, emotion, negativity_score, is_crisis, harassment_type, recorded_at)
         VALUES (:eid, :emotion, :score, :crisis, :harassment, :recorded_at)"
    );
    $emotions = array_keys(EMOTION_SCORES);
    $total = 0;

    $pdo->beginTransaction();
    foreach ($employees as $emp) {
        // 通常のログ：1人あたり3〜8件、危機検知は5%
        $count = random_int(3, 8);
        for ($i = 0; $i < $count; $i++) {
            $emotion  = $emotions[array_rand($emotions)];
            $isCrisis = random_int(1, 100) <= 5;
            $stmt->execute([
                'eid'         => $emp['id'],
                'emotion'     => $emotion,
                'score'       => $isCrisis ? CRISIS_SCORE : EMOTION_SCORES[$emotion],
                'crisis'      => $isCrisis ? 1 : 0,
                'harassment'  => 'none',
                'recorded_at' => randomRecentTimestamp(),
            ]);
            $total++;
        }

        // ハラスメント申告：該当する社員に1件ずつ
        $harassment = DEMO_HARASSMENT[$emp['employee_code']] ?? null;
        if ($harassment !== null) {
            $stmt->execute([
                'eid'         => $emp['id'],
                'emotion'     => 'sad',
                'score'       => EMOTION_SCORES['sad'],
                'crisis'      => 0,
                'harassment'  => $harassment,
                'recorded_at' => randomRecentTimestamp(),
            ]);
            $total++;
        }
    }
    $pdo->commit();

    return $total;
}

// -----------------------------------------
// 実行
// -----------------------------------------
$refresh = in_array('--refresh', $argv, true);
$pdo = getDbConnection();

// デモ用ではない社員（実在の社員）が1人でもいる DB では、何もしない。
// DEMO_SEED を true にしたまま実運用の DB で起動しても、
// 偽のログを混ぜたり、--refresh で本物のログを消したりしないため。
$demoCodes = array_column(DEMO_ACCOUNTS, 0);
$placeholders = implode(',', array_fill(0, count($demoCodes), '?'));
$stmt = $pdo->prepare("SELECT COUNT(*) FROM employees WHERE employee_code NOT IN ($placeholders)");
$stmt->execute($demoCodes);
$otherCount = (int)$stmt->fetchColumn();
if ($otherCount > 0) {
    fwrite(STDERR, "デモ用ではない社員が {$otherCount} 名登録されているため、デモデータの投入を中止しました（.env の DEMO_SEED を確認してください）。\n");
    exit(1);
}

$addedCount = insertMissingDemoAccounts($pdo, $demoPassword);
if ($addedCount > 0) {
    echo "デモ用のアカウントを {$addedCount} 名登録しました。\n";
} else {
    echo "デモ用のアカウントは登録済みのためスキップしました。\n";
}

if ($refresh) {
    $pdo->exec("TRUNCATE TABLE emotion_logs");
    echo "--refresh が指定されたため、感情ログを全削除しました。\n";
}

$logCount = (int)$pdo->query("SELECT COUNT(*) FROM emotion_logs")->fetchColumn();
if ($logCount === 0) {
    echo "感情ログを " . insertDemoEmotionLogs($pdo) . " 件作成しました。\n";
} else {
    echo "感情ログは登録済みのためスキップしました（{$logCount} 件）。\n";
    if ($addedCount > 0) {
        echo "足した社員にはまだ感情ログがありません。docker compose run --rm seed --refresh で作り直してください。\n";
    }
}
