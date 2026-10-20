<?php
// =========================================
// phpMyAdmin の追加設定
// compose.yaml で /etc/phpmyadmin/config.user.inc.php に読み込ませる
// （公式イメージの config.inc.php がこのファイルを読み込む）。
// つむぎは「使用中はインターネットに出ない」ため、外部への問い合わせを止める。
// =========================================

// 新しい版が出ていないかを phpmyadmin.net に問い合わせない
$cfg['VersionCheck'] = false;

// エラー報告を phpMyAdmin の開発元に送らない（送信の確認も出さない）
$cfg['SendErrorReports'] = 'never';
