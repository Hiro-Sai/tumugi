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
// CORS設定（Electronアプリからのfetchを許可）
// 本番運用時は許可オリジンを絞ること
// -----------------------------------------
function setCorsHeaders(): void {
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization');
    header('Content-Type: application/json; charset=utf-8');

    if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
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
// トークン検証（Authorization: Bearer <token> を想定）
// 成功時は employee_id を返す。失敗時は null
// -----------------------------------------
function verifyToken(): ?int {
    $token = getBearerToken();
    if ($token === null) {
        return null;
    }

    $pdo = getDbConnection();
    $stmt = $pdo->prepare(
        "SELECT employee_id FROM auth_tokens WHERE token = :token AND expires_at > NOW()"
    );
    $stmt->execute(['token' => $token]);
    $row = $stmt->fetch();

    return $row ? (int)$row['employee_id'] : null;
}
