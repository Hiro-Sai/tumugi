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
