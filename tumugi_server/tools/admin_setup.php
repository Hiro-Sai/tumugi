<?php
// =========================================
// tools/admin_setup.php
// 管理者を作る道具。次の2つのときに使う。
//   - 実運用の最初の管理者を作る（まだ管理者が1人もいない）
//   - 管理者がパスワードを忘れて、ほかに管理者がいないときに戻す
//
// 実行方法（リポジトリのルートで）：
//   docker compose exec app php /var/www/tumugi/tools/admin_setup.php <社員ID> [名前] [部署]
//     … いつも動いている app のコンテナで動かす
//
// 動作：
//   - その社員IDの社員がいないとき：名前と部署が必要。管理者・在籍・仮のパスワードで作る。
//   - その社員IDの社員がいるとき：社員IDだけを指定する。管理者・在籍にして、仮のパスワードに替える。
//     その社員のトークン（ログインしていた PC）とログインの失敗は消す。
//     名前や部署を付けたときは、何も変えず、仮のパスワードも出さずに止まる
//     （新しい社員を作るつもりで、いる社員をリセットしてしまわないため）。
//   - 仮のパスワードは、成功したときに画面（標準出力）へ1回だけ出す。
//     DB にはハッシュだけを入れ、操作の記録（admin_audit_logs）・ログ・標準エラーには出さない。
//     最初のログインで、新しいパスワードに変えてもらう（must_change_password = 1）。
//   - 操作の記録は、admin_code を CLI にして残す（action は create か reset_password）。
//   - 書き込みと記録は1つのトランザクションで行う。途中で失敗したら、すべて元に戻す。
//
// コマンドから動かしたときだけ動く。tools/ は URL で公開されていない（公開は /api だけ）。
// 終了コード：成功は 0、使い方の表示・入力の誤り・失敗は 1。
// =========================================

if (PHP_SAPI !== 'cli') {
    exit;
}

require_once __DIR__ . '/../includes/employee_admin.php';

const ADMIN_SETUP_USAGE = '使い方：php admin_setup.php <社員ID> [名前] [部署]（新しい社員IDのときは、名前と部署が必要です。すでにいる社員IDのときは、社員IDだけを指定します）';
const ADMIN_SETUP_EXISTS = 'その社員IDの社員はすでにいます。リセットするときは、社員IDだけを指定してください';

// -----------------------------------------
// 標準エラーにメッセージを出して、終了コード1で終わる。
// トランザクションの途中なら、先に元に戻す。
// -----------------------------------------
function abortSetup(?PDO $pdo, string $message): never {
    if ($pdo !== null) {
        try {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
        } catch (PDOException $e) {
            // 接続が切れているときは、サーバー側で取り消される
        }
    }
    fwrite(STDERR, $message . "\n");
    exit(1);
}

// -----------------------------------------
// 引数の確かめ（DB に触る前）
// 引数は <社員ID> [名前] [部署] の3つまで。
// 名前に空白があるのに引用符で囲まないと、部署がずれて登録されてしまうので、4つ以上は受けない。
// -----------------------------------------
if (count($argv) < 2 || count($argv) > 4) {
    abortSetup(null, ADMIN_SETUP_USAGE);
}
$code = normalizeText($argv[1]);
if ($code === '') {
    abortSetup(null, ADMIN_SETUP_USAGE);
}
$hasNameAndDepartment = count($argv) === 4;
$hasExtraArgs = count($argv) > 2;   // 名前か部署が付いている

require_once __DIR__ . '/../includes/db.php';

// -----------------------------------------
// 実行
// -----------------------------------------
$pdo = getDbConnection();
$tempPassword = '';
$storedCode = '';
$action = '';

try {
    $pdo->beginTransaction();

    // 大文字・小文字は区別されない。以降は DB に入っている社員IDを使う
    $employee = findEmployeeForUpdate($pdo, $code);

    if ($employee === null) {
        // 社員がいない：名前と部署が必要
        if (!$hasNameAndDepartment) {
            abortSetup($pdo, ADMIN_SETUP_USAGE);
        }
        $result = validateEmployeeFields([
            'employee_code' => $code,
            'display_name'  => $argv[2],
            'department'    => $argv[3],
        ], true);
        if ($result['error'] !== null) {
            abortSetup($pdo, $result['error']);
        }
        $values = $result['values'];

        $tempPassword = generateTempPassword();
        $insert = $pdo->prepare(
            "INSERT INTO employees
                (employee_code, password_hash, display_name, department,
                 is_active, is_new_grad, is_admin, must_change_password)
             VALUES (:code, :hash, :name, :department, 1, 0, 1, 1)"
        );
        $insert->execute([
            'code'       => $values['employee_code'],
            'hash'       => password_hash($tempPassword, PASSWORD_BCRYPT),
            'name'       => $values['display_name'],
            'department' => $values['department'],
        ]);

        $storedCode = $values['employee_code'];
        $action = 'create';
    } else {
        // 社員がいる：社員IDだけを受ける。名前や部署が付いているときは、新しい社員を作るつもりの
        // 入力なので、何も変えずに止める（いる社員を、間違ってリセットしないため）
        if ($hasExtraArgs) {
            abortSetup($pdo, ADMIN_SETUP_EXISTS);
        }

        // 管理者・在籍にして、仮のパスワードに替える
        $update = $pdo->prepare("UPDATE employees SET is_admin = 1, is_active = 1 WHERE id = :id");
        $update->execute(['id' => $employee['id']]);

        $tempPassword = setTempPassword($pdo, $employee['id'], $employee['employee_code']);

        $storedCode = $employee['employee_code'];
        $action = 'reset_password';
    }

    recordAdminAction($pdo, 'CLI', $action, $storedCode);

    $pdo->commit();
} catch (Throwable $e) {
    // SQLSTATE 23000：UNIQUE 違反（調べたあとに、同じ社員IDが作られた）
    if ($e instanceof PDOException && $e->getCode() === '23000') {
        abortSetup($pdo, '同じ社員IDの社員が、同時に作られました。もう一度実行してください。');
    }
    abortSetup($pdo, '管理者の作成に失敗しました（変更は取り消しました）：' . $e->getMessage());
}

// -----------------------------------------
// 結果の表示（コミットのあとに、1回だけ）
// -----------------------------------------
if ($action === 'create') {
    echo "管理者を作りました：{$storedCode}\n";
} else {
    echo "管理者にして、パスワードをリセットしました：{$storedCode}\n";
}
echo "仮のパスワード：{$tempPassword}\n";
echo "最初のログインで、新しいパスワードに変えてもらいます。この表示は二度と出ません。\n";
