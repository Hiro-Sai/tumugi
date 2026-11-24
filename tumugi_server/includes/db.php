<?php
// =========================================
// DB接続設定
// 接続情報は環境変数から読み込む（compose.yaml がリポジトリルートの .env から渡す）。
// ハードコード禁止。
// =========================================

require_once __DIR__ . '/env.php';

define('DB_HOST', requireEnv('DB_HOST'));
define('DB_NAME', requireEnv('DB_NAME'));
define('DB_USER', requireEnv('DB_USER'));
define('DB_PASS', requireEnv('DB_PASS'));

function getDbConnection(): PDO {
    static $pdo = null;
    if ($pdo === null) {
        $dsn = "mysql:host=" . DB_HOST . ";dbname=" . DB_NAME . ";charset=utf8mb4";
        $options = [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false, // 常にプリペアドステートメントを使う
        ];
        try {
            $pdo = new PDO($dsn, DB_USER, DB_PASS, $options);
        } catch (PDOException $e) {
            // 原因（認証失敗・接続拒否など）は利用者には見せず、サーバーのログにだけ残す。
            // PDOException のメッセージにパスワードは含まれない。
            error_log('DB接続に失敗しました: ' . $e->getMessage());
            http_response_code(500);
            header('Content-Type: application/json; charset=utf-8');
            echo json_encode(['error' => 'データベース接続に失敗しました']);
            // CLI（seed など）から呼ばれた場合に失敗を終了コードで伝えるため 1 で終了する
            exit(1);
        }
    }
    return $pdo;
}

// -----------------------------------------
// API の入り口。すべての API が、最初に呼ぶ。
// - 応答は JSON で返す。
// - CORS の許し（Access-Control-Allow-*）は返さない。OPTIONS（ブラウザの事前の確かめ）にも答えない。
//   アプリは main プロセスから送るので、CORS は要らない（画面は CSP の connect-src 'none' で、直接は送らない）。
//   許すと、同じ PC のブラウザで開いたほかのウェブページが、API を呼んで結果まで読めてしまう。
// - POST は、Content-Type が application/json のものだけを受け付け、ほかは DB に触れる前に 415 で断る。
//   ブラウザは、text/plain・フォームの形・Content-Type なしなら、サーバーの許しがなくても、ほかのページから送れる。
//   断らないと、ほかのページからログインを試して、他人の社員IDをロックさせられる。
//   アプリは、いつも application/json を付けて送る（main.js の net:serverRequest）。
// （レビューの B2。2026-11-20 に、CORS の設定を消して、この形にした）
// - 捕まえていない例外は、JSON の 500 で返す（respondUncaughtException。レビューの A5）。
// -----------------------------------------
function startApi(): void {
    header('Content-Type: application/json; charset=utf-8');
    set_exception_handler('respondUncaughtException');

    if ($_SERVER['REQUEST_METHOD'] === 'POST' && !isJsonContentType($_SERVER['CONTENT_TYPE'] ?? '')) {
        http_response_code(415);
        echo json_encode(['error' => 'Content-Type は application/json にしてください']);
        exit;
    }
}

// Content-Type が application/json か。「;」から先（charset など）と、大文字・小文字の違いは見ない
function isJsonContentType(string $contentType): bool {
    $mediaType = strtolower(trim(explode(';', $contentType, 2)[0]));
    return $mediaType === 'application/json';
}

// -----------------------------------------
// 捕まえていない例外（DB のエラー・型のエラーなど）を、JSON の 500 で返す（startApi() が登録する）。
// これがないと、本文のない 500 になり、アプリは「ログインに失敗しました」のような、原因の分からない文を出す。
// 例外の中身（種類・文・ファイルと行）は、サーバーのログにだけ残し、応答には出さない
// （ファイルの場所や SQL の一部が入ることがあるため）。
// 応答を返し始めたあと（ヘッダーを送ったあと）なら、ログに残すだけにする（応答の JSON を壊さないため）。
// -----------------------------------------
function respondUncaughtException(Throwable $e): void {
    error_log(sprintf(
        '想定外のエラー: %s: %s（%s:%d）',
        get_class($e),
        $e->getMessage(),
        $e->getFile(),
        $e->getLine()
    ));
    if (headers_sent()) {
        return;
    }
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'サーバーで予期しないエラーが起きました。時間をおいて、もう一度お試しください']);
}

// -----------------------------------------
// Authorization: Bearer <token> のトークン文字列を返す。なければ null
// （change_password.php が「今のトークン以外」を消すときにも使う）
// -----------------------------------------
function getBearerToken(): ?string {
    $headers = getallheaders();
    $authHeader = $headers['Authorization'] ?? $headers['authorization'] ?? '';

    if (!preg_match('/Bearer\s+(.+)/', $authHeader, $matches)) {
        return null;
    }
    return $matches[1];
}

// -----------------------------------------
// トークンを DB に保存する形（SHA-256 の16進64文字）にする。
// DB には元のトークンを置かない（DB が漏れても、そのまま使われないようにするため）。
// トークンは32バイトのランダムな値なので、ソルトは要らない。
// -----------------------------------------
function hashToken(string $token): string {
    return hash('sha256', $token);
}

// -----------------------------------------
// トークン検証（Authorization: Bearer <token> を想定）
// 成功時は employee_id を返す。失敗時は null
// 退職者（is_active = 0）のトークンは、期限内でも通さない
// 仮のパスワードのまま（must_change_password = 1）の社員のトークンも通さない。
// 管理者が決めた仮のパスワードで、チャットやダッシュボードを使わせないため。
// 仮のパスワードの社員にもできるのは、パスワードの変更とログアウトだけ。
// パスワードの変更（change_password.php）だけが、引数を true にして呼ぶ。
// -----------------------------------------
function verifyToken(bool $allowPendingPasswordChange = false): ?int {
    $token = getBearerToken();
    if ($token === null) {
        return null;
    }

    $pdo = getDbConnection();
    $sql = "SELECT t.employee_id FROM auth_tokens t
            JOIN employees e ON e.id = t.employee_id
            WHERE t.token = :token AND t.expires_at > NOW() AND e.is_active = 1";
    if (!$allowPendingPasswordChange) {
        $sql .= " AND e.must_change_password = 0";
    }
    $stmt = $pdo->prepare($sql);
    $stmt->execute(['token' => hashToken($token)]);
    $row = $stmt->fetch();

    return $row ? (int)$row['employee_id'] : null;
}
