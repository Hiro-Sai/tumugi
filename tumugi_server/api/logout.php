<?php
// =========================================
// logout.php
// ログアウトする。送られてきたトークンを、サーバーの DB から消す。
// 受け取るもの：Authorization: Bearer <token>（JSON の本文はなし）
// 成功したら 200 で {"status":"ok"} を返す。
//
// - verifyToken() は使わない。トークンを持っている人が自分のトークンを無効にするだけで、
//   消せなくて困ることはないため。期限切れや、すでに消えているトークンでも、ログアウトできるようにする。
// - 消す行がなくても（期限切れ・すでに消えている・退職者）200 を返す。
// =========================================
require_once __DIR__ . '/../includes/db.php';
setCorsHeaders();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'POSTメソッドのみ許可されています']);
    exit;
}

$token = getBearerToken();
if ($token === null) {
    http_response_code(400);
    echo json_encode(['error' => 'トークンがありません']);
    exit;
}

$pdo = getDbConnection();
$stmt = $pdo->prepare("DELETE FROM auth_tokens WHERE token = :token");
$stmt->execute(['token' => hashToken($token)]);

echo json_encode(['status' => 'ok']);
