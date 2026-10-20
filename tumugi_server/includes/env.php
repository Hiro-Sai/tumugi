<?php
// =========================================
// env.php
// 必須の環境変数を読み出すヘルパー。
// 値は compose.yaml がリポジトリルートの .env から環境変数として渡す
// （このファイル自体は .env を読まない）。
// =========================================

function requireEnv(string $key): string {
    $value = getenv($key);
    if ($value === false || $value === '') {
        throw new RuntimeException("必須の環境変数 {$key} が設定されていません（リポジトリルートの .env を確認してください）");
    }
    return $value;
}
