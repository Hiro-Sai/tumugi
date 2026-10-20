# 共感AI つむぎ

社員がつむぎと話すと、気持ちが匿名で集計され、会社には組織の傾向だけが見えるソフトです。社員向けのデスクトップアプリ（Electron）と、感情ログを集計する管理者向けの API サーバー（PHP）でできています。

**紹介ページ（デモ動画あり）：https://hiro-sai.github.io/**

> 閲覧用に公開しています。無断での利用・改変・再配布はお断りします。（© 2026 Hiro-Sai）

![つむぎと会話している画面](https://hiro-sai.github.io/images/tumugi-chat.jpg)

![管理者のダッシュボード](https://hiro-sai.github.io/images/tumugi-dashboard.jpg)

## 工夫した点

| 工夫 | 内容 | 主なファイル |
|---|---|---|
| 会話がネットに出ない | AI（Ollama と Gemma 4）も声（VOICEVOX）も、その PC の中で動きます。アプリからの通信は、許可した宛先・メソッド・パスの組だけに絞り、画面には CSP をかけています。 | `tumugi_app/net-policy.js`、`tumugi_app/main.js` |
| 個人を特定させない | 直近7日間に記録がある社員が10名未満の部署は、数字を出しません。危機の検知も、人数が少ないときは件数を出さず「あり」とだけ出します。 | `tumugi_server/api/dashboard_data.php` |
| 記憶の暗号化 | つむぎが覚えた内容は、社員のパスワードから scrypt で作った鍵で AES-256-GCM により暗号化し、さらに OS の仕組み（safeStorage）で包んで保存します。鍵はメモリにだけ置きます。パスワードを変えたときは、新しい鍵で暗号化し直します。 | `tumugi_app/memory-crypto.js` |
| 見逃しを減らす | キーワード → 危ない話かの判定（返事とは別の AI の呼び出し）→ 返事、の順で動きます。返事は JSON スキーマで受け取り、壊れていたら1回だけ作り直します。 | `tumugi_app/js/safety.js` |
| 声に合わせて口が動く | VOICEVOX の音ごとの長さ（audio_query）から、口を開け閉めするタイミングを作ります。 | `tumugi_app/js/lipsync.js` |

## テスト

```bash
cd tumugi_app
npm test
```

node:test で88個（外との通信のルール、安全判定、プロンプト、記憶の暗号化、口パク、パスワードの確認）。

## 構成

| フォルダ | 内容 |
|---|---|
| `tumugi_app/` | デスクトップアプリ（Electron）。会話は Ollama、音声は VOICEVOX を、それぞれこの PC の中で使う |
| `tumugi_server/` | API サーバー（PHP 8.4）。ログイン、感情ログの保存、管理者ダッシュボード用の集計 |
| `docker/` | API サーバーのコンテナ設定 |
| `docs/` | 開発ログと設計書（「開発の記録」を参照） |

## 必要なもの

- Docker Desktop
- Node.js
- Ollama（新しい版。モデル：`ollama pull gemma4:e4b`）
- VOICEVOX

最初の1回だけ、Docker イメージ・npm パッケージ・Ollama のモデルのダウンロードにインターネット接続が必要です。

## 起動手順

コマンドはすべて、リポジトリのルートで実行します。

1. `.env` を作り、パスワード類（`DB_PASS`・`DB_ROOT_PASS`・`DEMO_PASSWORD`）を推測されにくい値に書き換えます。記号を使うとコマンドや `.env` の読み込みで問題が起きることがあるため、英数字だけ（長め）にしてください。

   ```powershell
   Copy-Item .env.example .env
   ```

2. Docker Desktop を起動してから、サーバーを起動します。初回はイメージのビルドと、デモデータの投入が自動で行われます。

   ```bash
   docker compose up -d
   ```

3. 状態を確認します。`db` が healthy、`app` が Up、`seed` が `Exited (0)` なら成功です。

   ```bash
   docker compose ps -a
   ```

4. Ollama を起動してから、アプリを起動します。VOICEVOX は、アプリが起動時に音声エンジン（画面なし）を立ち上げ、アプリを閉じると止めます（もともと VOICEVOX が動いていれば、それを使います）。

   ```bash
   cd tumugi_app
   npm install
   npm start
   ```

立ち絵の画像はリポジトリに入っていないので、そのままではつむぎの絵が出ません（「立ち絵について」を参照）。

## デモアカウント

| 社員ID | 内容 |
|---|---|
| E001〜E048 | 一般社員（営業部・開発部・人事部・製造部 各12名、うち新卒は各部署3名の計12名） |
| A001 | 管理者（ダッシュボードを閲覧できる） |

パスワードは全員共通で、`.env` の `DEMO_PASSWORD` です。ログインしたあと、「設定」からパスワードを変えられます（展示モードでは出ません）。

初めてログインすると、感情ログの送信に同意するかを確認する画面が出ます。「同意する」を選ぶと、発言ごとの感情がサーバーに記録されます。

## 展示で使うとき

リポジトリのルートの `start-demo.bat` をダブルクリックします。次の順に立ち上がり、最後にアプリが展示モードで開きます。

1. Docker Desktop（動いていなければ起動して待つ）
2. サーバー（`docker compose up -d`）
3. デモデータの作り直し（`seed --refresh`。それまでの感情ログはすべて消えます）
4. Ollama（動いていなければ起動し、モデルを先に読み込む）
5. アプリ（VOICEVOX の音声エンジンは、アプリが立ち上げます）

ログインすると、つむぎが時間帯に合わせてあいさつします（「はじめまして」で名前を入れていれば、名前も呼びます）。

展示モードでは、来場者どうしで話した内容が見えないように、次のように動きます。

- つむぎの記憶はディスクに保存せず、ログアウトするかアプリを閉じると消えます。
- 感情ログの送信の同意は、ログアウトのたびに消えます（来場者ごとに同意の画面が出ます）。
- モデルを60分読み込んだままにします（来場者の間があいても、最初の返事が遅くなりにくい）。

**来場者が替わるたびに、ログアウトしてください。** ダッシュボードは直近7日間の記録だけを表示するので、展示の日は毎朝 `start-demo.bat` から起動してデモデータを作り直してください。

Ollama・Docker Desktop のインストール先が違う PC で使うときは、`start-demo.bat` の先頭のパスを直します。VOICEVOX は、ユーザーごとのインストール先（`%LOCALAPPDATA%\Programs\VOICEVOX`）と Program Files の両方を探します。

## よく使うコマンド

| やりたいこと | コマンド |
|---|---|
| デモの直前に感情ログを作り直す | `docker compose run --rm seed --refresh` |
| phpMyAdmin を使う | `docker compose --profile tools up -d` のあと http://127.0.0.1:8081 を開く（`.env` の `DB_USER` / `DB_PASS` でログイン） |
| DB を直接操作する（mysql） | `docker compose exec db sh -c 'mysql --default-character-set=utf8mb4 -uroot -p$MYSQL_ROOT_PASSWORD $MYSQL_DATABASE'` |
| サーバーのログを見る | `docker compose logs app` |
| 停止する | `docker compose --profile tools down` |
| DB を含めて完全に初期化する（⚠️ DB の中身がすべて消えます） | `docker compose --profile tools down -v` |

停止と初期化に `--profile tools` を付けるのは、phpMyAdmin も一緒に片付けるためです。

## セキュリティ上の前提

- サーバーには、この PC の中（127.0.0.1）からしか接続できません。同じネットワークのほかの PC からは接続できません。
- URL で公開されているのは `/api` だけです。
- DB は、インターネットに出られない Docker の内部ネットワークに置いています。
- `.env` はリポジトリに含めません。
- 実運用ではデモデータを入れないよう、`.env` の `DEMO_SEED` を `false` にします（手順は「デモから実運用に切り替えるとき」）。`true` のままでも、デモ用ではない社員がいる DB には何もせず、`seed` が `Exited (1)` で止まります。
- 社員の気持ちを扱うため、データを外部のサービスに送らない方針です。Docker Desktop の AI アシスタント（Gordon）など、エラーや設定ファイルを外部に送る機能は使わないでください。
- Ollama にはサインインしないでください。サインインすると、インターネット上のサーバーで動く cloud モデル（名前が `-cloud` や `:cloud` で終わるもの）が使えるようになり、会話が PC の外に出ます。アプリは cloud モデルへの中継を拒否しますが、念のためです。

## デモから実運用に切り替えるとき

実在の社員を登録する前に、次の手順でデモデータを消してください。デモ用の社員や感情ログが残っていると、集計に混ざります。

1. サーバーを止めて、DB を消します（⚠️ DB の中身がすべて消えます）。

   ```bash
   docker compose --profile tools down -v
   ```

2. `.env` の `DEMO_SEED` を `false` にします。`DB_PASS` などのパスワードを変える場合は、DB を作り直すこのタイミングで変えてください。

3. サーバーを起動します。

   ```bash
   docker compose up -d
   ```

4. `seed` のログに「デモデータの投入をスキップしました」と出ていれば完了です。

   ```bash
   docker compose logs seed
   ```

## うまく動かないとき

- **ポート 8080 / 8081 がすでに使われている**：使っているアプリを止めてください。ポートを変える場合は、`compose.yaml` と `tumugi_app/net-policy.js` の `BASE_URLS` の両方を変更する必要があります。
- **テーブル構造（`tumugi_server/sql/schema.sql`）を変えたのに反映されない**：構造は DB を初めて作るときにだけ読み込まれます。`docker compose --profile tools down -v` のあと、もう一度 `docker compose up -d` を実行してください（⚠️ DB の中身がすべて消えます。実運用の DB では実行しないでください）。
- **`docker compose` で「.env がありません」と表示される**：手順1の `.env` を作ってください。
- **`.env` の `DB_PASS` などを変えたら、DB に接続できなくなった**：DB のパスワードは、DB を初めて作るときにだけ設定されます。デモ環境なら `docker compose --profile tools down -v` で DB を作り直してください（DB の中身はすべて消えます）。
- **発言しても感情ログが記録されない**：アプリの「🔒 設定」で「感情ログの送信に同意しています」になっているか確認してください。同意は PC ごと・社員ごとに保存されます。
- **mysql の結果で日本語が `???` になる**：`--default-character-set=utf8mb4` を付けてください（「よく使うコマンド」の書き方）。
- **phpMyAdmin を起動すると「network ... not found」と表示される**：DB を作り直す前の古い phpMyAdmin が残っています。`docker compose --profile tools up -d --force-recreate --no-deps phpmyadmin` で作り直してください。

## 立ち絵について

- 立ち絵の画像は、このリポジトリに入っていません（`tumugi_app/images/*.png` は Git の管理外です）。
- 立ち絵は、坂本アヒルさんの「春日部つむぎ立ち絵素材」です。まばたき・口パク用の絵も含めて、絵はすべて坂本アヒルさんのものです（素材に入っている目や口の差分を、表情ごとに組み合わせて書き出しました）。素材の再配布になるため、画像はこのリポジトリに入れていません。
- アプリは `tumugi_app/images/` の次のファイルを読みます。表情は `normal`・`happy`・`sad`・`angry`・`surprised`・`troubled` の6つです。

| ファイル | 使いどころ |
|---|---|
| `<表情>_open.png` | 元の絵 |
| `<表情>_close.png` | まばたき |
| `<表情>_talk.png` | 口パク（口だけが元の絵と反対の絵）。なければ口パクしません |

## 開発の記録

- `docs/dev_log/`：セッションごとの開発ログ（やったこと・決めたこと・つまずいたこと）
- `docs/superpowers/specs/`：設計書（何を、なぜそう決めたか）

開発には AI（Claude）を使っています。設計の判断は選択肢を比べて自分で決め、その理由を設計書と開発ログに残しています。

## クレジット

- VOICEVOX（音声合成エンジン）© Hiroshiba Kazuyuki
- VOICEVOX:春日部つむぎ
- 立ち絵：坂本アヒル（春日部つむぎ立ち絵素材）
- Gemma 4（E4B）© Google DeepMind — Apache License 2.0
- Ollama © Ollama, Inc. — MIT License
- Electron © OpenJS Foundation — MIT License
- Zen Old Mincho — Copyright 2021 The Zen Old Mincho Project Authors (https://github.com/googlefonts/zen-oldmincho) — SIL Open Font License 1.1
- DM Sans — Copyright 2014 The DM Sans Project Authors (https://github.com/googlefonts/dm-fonts) — SIL Open Font License 1.1
- Noto Sans JP — (c) 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'. — SIL Open Font License 1.1

春日部つむぎ公式とは関係のない、個人の作品です。

## 著作権

© 2026 Hiro-Sai。閲覧用です。無断での利用・改変・再配布はお断りします。
