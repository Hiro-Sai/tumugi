<?php
// =========================================
// fixture.php
// サーバーのテスト用の道具。データを入れる・空に戻す・中身を読む。
// コンテナの中で、コマンド（CLI）として動かす：
//   docker compose -f compose.test.yaml exec -T app php /var/www/tumugi-test-tools/fixture.php
// 標準入力に命令の配列（JSON）を渡すと、標準出力に結果の配列（JSON。命令と同じ順）を返す。
// 失敗したら、標準エラーに理由を出して、終了コード 1 で終わる。
// =========================================

// ウェブから呼ばれても、何もしない
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit(1);
}

// デモの DB を壊さないための確認。db.php を読み込む前に確かめる。
// DB の名前が tumugi_test でなければ、何もせずに終わる。
if (getenv('DB_NAME') !== 'tumugi_test') {
    fwrite(STDERR, "DB_NAME が tumugi_test ではないので、何もせずに止めました\n");
    exit(1);
}

require_once '/var/www/tumugi/includes/db.php';
require_once '/var/www/tumugi/includes/aggregate_rules.php';

// 失敗は、理由を標準エラーに出して終わる
function fail(string $message): never {
    fwrite(STDERR, $message . "\n");
    exit(1);
}

// 命令の引数を取り出す。なければ既定の値
function arg(array $cmd, string $key, mixed $default = null): mixed {
    return array_key_exists($key, $cmd) ? $cmd[$key] : $default;
}

// 必須の引数（文字列）
function requireString(array $cmd, string $key): string {
    $value = $cmd[$key] ?? null;
    if (!is_string($value) || $value === '') {
        fail("op={$cmd['op']} に {$key}（文字列）がありません");
    }
    return $value;
}

// 社員IDから employees.id を探す。いなければ失敗
function employeeIdByCode(PDO $pdo, string $code): int {
    $stmt = $pdo->prepare("SELECT id FROM employees WHERE employee_code = :code");
    $stmt->execute(['code' => $code]);
    $row = $stmt->fetch();
    if (!$row) {
        fail("社員 {$code} がいません");
    }
    return (int)$row['id'];
}

$raw = stream_get_contents(STDIN);
$commands = json_decode($raw === false ? '' : $raw, true);
if (!is_array($commands) || !array_is_list($commands)) {
    fail('標準入力は、命令の配列（JSON）にしてください');
}

try {
    $pdo = getDbConnection();
    // 念のため、つながった先の DB の名前も確かめる
    $dbName = $pdo->query('SELECT DATABASE()')->fetchColumn();
    if ($dbName !== 'tumugi_test') {
        fail('つながった DB が tumugi_test ではないので、止めました');
    }

    // 同じパスワードのハッシュは使い回す（bcrypt は遅いので）
    $hashCache = [];
    $results = [];

    foreach ($commands as $cmd) {
        if (!is_array($cmd) || !isset($cmd['op']) || !is_string($cmd['op'])) {
            fail('命令には op（文字列）が要ります');
        }

        switch ($cmd['op']) {
            case 'reset':
                $pdo->exec('SET FOREIGN_KEY_CHECKS = 0');
                foreach (['emotion_logs', 'auth_tokens', 'login_attempts', 'admin_audit_logs', 'employee_notices', 'employees'] as $table) {
                    $pdo->exec("TRUNCATE TABLE {$table}");
                }
                $pdo->exec('SET FOREIGN_KEY_CHECKS = 1');
                $results[] = ['ok' => true];
                break;

            case 'add_employee':
                $code = requireString($cmd, 'code');
                $department = requireString($cmd, 'department');
                $pw = requireString($cmd, 'pw');
                if (!isset($hashCache[$pw])) {
                    $hashCache[$pw] = password_hash($pw, PASSWORD_BCRYPT);
                }
                // 登録してからの日数（省略すると 30）と、集計に入れ始める時刻（counted_from）からの日数（省略すると 30）。
                // (int) にした数だけを SQL に入れる
                $createdDaysAgo = (int)arg($cmd, 'created_days_ago', 30);
                $countedDaysAgo = (int)arg($cmd, 'counted_days_ago', 30);
                $stmt = $pdo->prepare(
                    "INSERT INTO employees
                       (employee_code, password_hash, display_name, department,
                        is_active, is_new_grad, is_admin, must_change_password, created_at, counted_from)
                     VALUES (:code, :hash, :name, :dept, :active, :grad, :admin, :must,
                             NOW() - INTERVAL {$createdDaysAgo} DAY, NOW() - INTERVAL {$countedDaysAgo} DAY)"
                );
                $stmt->execute([
                    'code'   => $code,
                    'hash'   => $hashCache[$pw],
                    'name'   => (string)arg($cmd, 'name', 'テスト' . $code),
                    'dept'   => $department,
                    'active' => arg($cmd, 'is_active', true) ? 1 : 0,
                    'grad'   => arg($cmd, 'is_new_grad', false) ? 1 : 0,
                    'admin'  => arg($cmd, 'is_admin', false) ? 1 : 0,
                    'must'   => arg($cmd, 'must_change', false) ? 1 : 0,
                ]);
                $results[] = ['id' => (int)$pdo->lastInsertId()];
                break;

            case 'add_logs':
                $employeeId = employeeIdByCode($pdo, requireString($cmd, 'code'));
                $logs = arg($cmd, 'logs', []);
                if (!is_array($logs)) {
                    fail('logs は配列にしてください');
                }
                // 時刻は PHP の時計ではなく、MySQL の NOW() から引く（サーバーが比べるのも MySQL の時計のため）
                // 日数は (int) にした数だけを SQL に入れる（文字列は入らない）
                // department・is_new_grad・is_counted は、1行ごとに指定できる。省略すると、その社員の今の値
                // （is_counted は、本番の save_emotion.php と同じ決め方：管理者か、counted_from から
                // NEW_EMPLOYEE_WAIT_DAYS 日以内なら 0、そうでなければ 1。
                // 本番は記録した時点の NOW() で決めるので、ここでは、その記録の時刻（NOW() - days_ago）で同じ式を使う。
                // counted_from は今の値を使う。記録のあとに動かしたときは、行ごとに is_counted を指定すること）
                $waitDays = (int)NEW_EMPLOYEE_WAIT_DAYS;
                $empStmt = $pdo->prepare(
                    "SELECT department, is_new_grad, is_admin FROM employees WHERE id = :eid"
                );
                $empStmt->execute(['eid' => $employeeId]);
                $emp = $empStmt->fetch();
                foreach ($logs as $log) {
                    $days = (int)($log['days_ago'] ?? 0);
                    $waitStmt = $pdo->prepare(
                        "SELECT (counted_from > (NOW() - INTERVAL {$days} DAY) - INTERVAL {$waitDays} DAY) AS in_wait
                         FROM employees WHERE id = :eid"
                    );
                    $waitStmt->execute(['eid' => $employeeId]);
                    $inWait = (int)$waitStmt->fetchColumn() === 1;
                    $stmt = $pdo->prepare(
                        "INSERT INTO emotion_logs
                           (employee_id, emotion, negativity_score, is_crisis, harassment_type,
                            department, is_new_grad, is_counted, recorded_at)
                         VALUES (:eid, :emotion, :score, :crisis, :harassment,
                                 :dept, :grad, :counted, NOW() - INTERVAL {$days} DAY)"
                    );
                    $stmt->execute([
                        'eid'        => $employeeId,
                        'emotion'    => (string)($log['emotion'] ?? 'normal'),
                        'score'      => (int)($log['score'] ?? 10),
                        'crisis'     => !empty($log['is_crisis']) ? 1 : 0,
                        'harassment' => (string)($log['harassment'] ?? 'none'),
                        'dept'       => (string)($log['department'] ?? $emp['department']),
                        'grad'       => array_key_exists('is_new_grad', $log)
                            ? (!empty($log['is_new_grad']) ? 1 : 0)
                            : (int)$emp['is_new_grad'],
                        'counted'    => array_key_exists('is_counted', $log)
                            ? (!empty($log['is_counted']) ? 1 : 0)
                            : (((int)$emp['is_admin'] === 1 || $inWait) ? 0 : 1),
                    ]);
                }
                $results[] = ['count' => count($logs)];
                break;

            case 'add_attempts':
                $code = requireString($cmd, 'code');
                $count = (int)arg($cmd, 'count', 0);
                // 分は (int) にした数だけを SQL に入れる
                $minutes = (int)arg($cmd, 'minutes_ago', 0);
                $stmt = $pdo->prepare(
                    "INSERT INTO login_attempts (employee_code, succeeded, attempted_at)
                     VALUES (:code, :ok, NOW() - INTERVAL {$minutes} MINUTE)"
                );
                for ($i = 0; $i < $count; $i++) {
                    $stmt->execute([
                        'code' => $code,
                        'ok'   => arg($cmd, 'succeeded', false) ? 1 : 0,
                    ]);
                }
                $results[] = ['count' => $count];
                break;

            case 'expire_tokens':
                $employeeId = employeeIdByCode($pdo, requireString($cmd, 'code'));
                $stmt = $pdo->prepare(
                    "UPDATE auth_tokens SET expires_at = NOW() - INTERVAL 1 DAY WHERE employee_id = :eid"
                );
                $stmt->execute(['eid' => $employeeId]);
                $results[] = ['count' => $stmt->rowCount()];
                break;

            case 'set_active':
                // 在籍・退職だけを切り替える（トークンの行は消さない。API の退職とは違う）
                $employeeId = employeeIdByCode($pdo, requireString($cmd, 'code'));
                $stmt = $pdo->prepare("UPDATE employees SET is_active = :active WHERE id = :eid");
                // 省くと、気づかないまま退職になってしまうので、必ず書かせる
                if (!is_bool($cmd['is_active'] ?? null)) {
                    fail("op=set_active に is_active（true か false）がありません");
                }
                $stmt->execute(['active' => $cmd['is_active'] ? 1 : 0, 'eid' => $employeeId]);
                $results[] = ['count' => $stmt->rowCount()];
                break;

            case 'read_employee':
                // password_hash は返さない。counted_from は返さない（時間がたつと値が変わり、
                // 「変わっていないこと」を deepEqual で確かめるテストが崩れるため。read_counted を使う）
                $stmt = $pdo->prepare(
                    "SELECT id, employee_code, display_name, department,
                            is_active, is_new_grad, is_admin, must_change_password
                     FROM employees WHERE employee_code = :code"
                );
                $stmt->execute(['code' => requireString($cmd, 'code')]);
                $row = $stmt->fetch();
                if (!$row) {
                    $results[] = null;
                    break;
                }
                foreach (['id', 'is_active', 'is_new_grad', 'is_admin', 'must_change_password'] as $key) {
                    $row[$key] = (int)$row[$key];
                }
                $results[] = $row;
                break;

            case 'read_counted':
                // 集計に入れ始める時刻（counted_from）から何秒たったか。社員がいなければ null
                // （DB の時計だけで測る。PC の時計とずれていても合う）
                $stmt = $pdo->prepare(
                    "SELECT UNIX_TIMESTAMP() - UNIX_TIMESTAMP(counted_from) AS counted_seconds_ago
                     FROM employees WHERE employee_code = :code"
                );
                $stmt->execute(['code' => requireString($cmd, 'code')]);
                $row = $stmt->fetch();
                $results[] = $row ? (int)$row['counted_seconds_ago'] : null;
                break;

            case 'read_logs':
                // 社員がいなくても（削除のあと）、空の配列を返す
                $stmt = $pdo->prepare(
                    "SELECT l.emotion, l.negativity_score, l.is_crisis, l.harassment_type,
                            l.department, l.is_new_grad, l.is_counted,
                            l.recorded_at, UNIX_TIMESTAMP(l.recorded_at) AS recorded_unix,
                            UNIX_TIMESTAMP() - UNIX_TIMESTAMP(l.recorded_at) AS age_seconds
                     FROM emotion_logs l
                     JOIN employees e ON e.id = l.employee_id
                     WHERE e.employee_code = :code
                     ORDER BY l.recorded_at, l.id"
                );
                $stmt->execute(['code' => requireString($cmd, 'code')]);
                $rows = $stmt->fetchAll();
                foreach ($rows as &$row) {
                    $row['negativity_score'] = (int)$row['negativity_score'];
                    $row['is_crisis'] = (int)$row['is_crisis'];
                    $row['is_new_grad'] = (int)$row['is_new_grad'];
                    $row['is_counted'] = (int)$row['is_counted'];
                    $row['recorded_unix'] = (int)$row['recorded_unix'];
                    // 記録してからの秒数（DB の時計だけで測る。PC の時計とずれていても合う）
                    $row['age_seconds'] = (int)$row['age_seconds'];
                }
                unset($row);
                $results[] = $rows;
                break;

            case 'read_auth':
                // 行の数。社員の行がなくても数える（削除のあとの確かめ用）
                $code = requireString($cmd, 'code');
                $stmt = $pdo->prepare(
                    "SELECT COUNT(*) FROM auth_tokens t
                     JOIN employees e ON e.id = t.employee_id
                     WHERE e.employee_code = :code"
                );
                $stmt->execute(['code' => $code]);
                $tokens = (int)$stmt->fetchColumn();

                $stmt = $pdo->prepare(
                    "SELECT succeeded, COUNT(*) AS cnt FROM login_attempts
                     WHERE employee_code = :code GROUP BY succeeded"
                );
                $stmt->execute(['code' => $code]);
                $failed = 0;
                $succeeded = 0;
                foreach ($stmt->fetchAll() as $row) {
                    if ((int)$row['succeeded'] === 1) {
                        $succeeded = (int)$row['cnt'];
                    } else {
                        $failed = (int)$row['cnt'];
                    }
                }
                $results[] = [
                    'tokens'             => $tokens,
                    'failed_attempts'    => $failed,
                    'succeeded_attempts' => $succeeded,
                ];
                break;

            case 'read_audit':
                $rows = $pdo->query(
                    "SELECT admin_code, action, target_code, detail
                     FROM admin_audit_logs ORDER BY id"
                )->fetchAll();
                $results[] = $rows;
                break;

            case 'read_counts':
                $counts = [];
                foreach (['employees', 'emotion_logs', 'auth_tokens', 'login_attempts', 'admin_audit_logs', 'employee_notices'] as $table) {
                    $counts[$table] = (int)$pdo->query("SELECT COUNT(*) FROM {$table}")->fetchColumn();
                }
                $results[] = $counts;
                break;

            case 'read_notices':
                // 社員の知らせの行を、id の小さい順に。seen_at が入っているかを seen（真偽）で返す
                $stmt = $pdo->prepare(
                    "SELECT n.id, n.kind, n.old_value, n.new_value, (n.seen_at IS NOT NULL) AS seen
                     FROM employee_notices n
                     JOIN employees e ON e.id = n.employee_id
                     WHERE e.employee_code = :code
                     ORDER BY n.id"
                );
                $stmt->execute(['code' => requireString($cmd, 'code')]);
                $rows = $stmt->fetchAll();
                foreach ($rows as &$row) {
                    $row['id'] = (int)$row['id'];
                    $row['seen'] = (int)$row['seen'] === 1;
                }
                unset($row);
                $results[] = $rows;
                break;

            case 'add_notice':
                // kind は、文字列をそのまま入れる（確かめない）
                $employeeId = employeeIdByCode($pdo, requireString($cmd, 'code'));
                // 日数は (int) にした数だけを SQL に入れる
                $days = (int)arg($cmd, 'days_ago', 0);
                $stmt = $pdo->prepare(
                    "INSERT INTO employee_notices (employee_id, kind, old_value, new_value, created_at, seen_at)
                     VALUES (:eid, :kind, :old, :new, NOW() - INTERVAL {$days} DAY,
                             IF(:seen = 1, NOW(), NULL))"
                );
                $oldValue = arg($cmd, 'old');
                $newValue = arg($cmd, 'new');
                $stmt->execute([
                    'eid'  => $employeeId,
                    'kind' => (string)arg($cmd, 'kind', ''),
                    'old'  => $oldValue === null ? null : (string)$oldValue,
                    'new'  => $newValue === null ? null : (string)$newValue,
                    'seen' => arg($cmd, 'seen', false) ? 1 : 0,
                ]);
                $results[] = ['id' => (int)$pdo->lastInsertId()];
                break;

            case 'set_admin':
                // 管理者の印だけを切り替える（API は通さない）
                $employeeId = employeeIdByCode($pdo, requireString($cmd, 'code'));
                if (!is_bool($cmd['is_admin'] ?? null)) {
                    fail("op=set_admin に is_admin（true か false）がありません");
                }
                $stmt = $pdo->prepare("UPDATE employees SET is_admin = :admin WHERE id = :eid");
                $stmt->execute(['admin' => $cmd['is_admin'] ? 1 : 0, 'eid' => $employeeId]);
                $results[] = ['count' => $stmt->rowCount()];
                break;

            default:
                fail('知らない op です: ' . $cmd['op']);
        }
    }

    echo json_encode($results, JSON_UNESCAPED_UNICODE);
} catch (Throwable $e) {
    fail('fixture の実行に失敗しました: ' . $e->getMessage());
}
