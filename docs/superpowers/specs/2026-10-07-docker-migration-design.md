# XAMPP から Docker Compose への移行 設計書

- 日付：2026-10-07
- 状態：承認済み（実装計画の作成待ち）

## 1. 背景と目的

### 背景
- 本番として予定していた学校サーバーは、先生により使用を却下された。理由は「ネットワークへの公開が危険」と「学校の運用ルール上の問題」。
- 現在のサーバーは XAMPP（Windows、PHP 8.2.12、MariaDB 10.4.32）で動いている。
- XAMPP の php.ini は `date.timezone=Europe/Berlin` になっており、PHP の `date()` と MySQL の `NOW()` がずれて、ログインのトークンが約7〜8時間早く切れる。
- 今の DB は、リポジトリのファイルだけでは再現できない。
  - `employees.is_admin`、`employees.is_new_grad`、`emotion_logs.harassment_type` の列は、手作業の ALTER で追加されている（schema.sql には `is_new_grad` しかない）。
  - 管理者フラグ（is_admin=1）の設定も手作業で、どのスクリプトにも書かれていない。
- `tumugi_server/README.md` は古い可能性がある。そのため、この設計では README ではなく、実際のコードと今動いている DB を事実の根拠にする。

### 目的（ユーザーと合意したもの）
1. **本番と同じ構成で開発する**：本番環境は決まっていないので、この Docker 構成そのものを本番の構成と定義する。実運用では、導入先の会社が自社のサーバーで `docker compose up` する想定。
2. **他の人が簡単に起動できる**：1コマンドで、空の状態からデモできる状態まで自動で到達する。
3. **XAMPP の不便さから離れる**。

### 成功基準
- まっさらな環境で「`.env` を作る」「`docker compose up -d` を実行する」の2手順だけで、デモ用アカウントでのログインとダッシュボード表示までできる。
- サーバーには、同じPCの中からしか接続できない。
- URL でアクセスできるのは `/api` 配下だけ。

## 2. 決定事項

| 項目 | 決定 | 理由 |
|---|---|---|
| 方式 | Docker Compose | 3つの目的をすべて満たす。Docker Desktop は導入済み |
| PHP | 8.4 | XAMPP の PHP 8.2 は 2026年12月末でセキュリティサポートが終わる。8.4 は 2028年末までサポートされる |
| DB | MySQL 8.4 LTS | schema.sql の「MySQL 8.0 想定」と一致し、企業で広く使われている |
| データ | デモデータを自動で作り直す（今のデータは移さない） | 今のデータはダミーと手作業の設定だけで、再現性のほうが重要 |
| DB ツール | phpMyAdmin を必要なときだけ起動 | 使い慣れたツールのまま、普段は起動しない |
| 管理者 | 専用アカウント A001 | 一般社員と管理者のデモを切り分けやすい |
| 公開ポート | `127.0.0.1:8080`（API）、`127.0.0.1:8081`（phpMyAdmin） | 却下理由（ネットワーク公開）への対策。XAMPP の 80 番とも衝突しない |

## 3. 構成

### 3.1 ファイル配置

```
つむぎプロジェクト/
├─ compose.yaml                     ← 新規
├─ .env.example                     ← 新規（.env 本体は既存の .gitignore の対象）
├─ README.md                        ← 新規：起動手順
├─ docker/app/
│   ├─ Dockerfile                   ← 新規
│   └─ apache.conf                  ← 新規
├─ tumugi_app/
│   ├─ main.js                      ← SERVER_BASE_URL を変更
│   └─ js/config.js                 ← 削除
└─ tumugi_server/
    ├─ api/                         ← save_emotion.php のスコア表だけ共通化
    ├─ includes/
    │   ├─ db.php                   ← .env の読み込みをやめる
    │   ├─ env.php                  ← requireEnv() だけを残す
    │   └─ emotion_scores.php       ← 新規：スコア表の共通定義
    ├─ sql/schema.sql               ← 今の DB から作り直す
    └─ tools/seed_demo.php          ← 新規：シード5本を統合
```

### 3.2 サービス

| サービス | イメージ | 公開ポート | 起動するタイミング |
|---|---|---|---|
| db | `mysql:8.4` | なし | 常時 |
| app | `docker/app/Dockerfile`（`php:8.4-apache` ベース） | `127.0.0.1:8080:80` | 常時 |
| seed | app と同じイメージ | なし | `up` のたびに1回実行して終了 |
| phpmyadmin | `phpmyadmin:5.2` | `127.0.0.1:8081:80` | `--profile tools` を付けたときだけ |

### 3.3 compose.yaml の要点
- **db**
  - 環境変数：`MYSQL_DATABASE`、`MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_ROOT_PASSWORD`、`TZ=Asia/Tokyo`
  - 起動オプション：`--default-time-zone=+09:00`
  - ボリューム：名前付きボリューム `db-data` を `/var/lib/mysql` に、`tumugi_server/sql/schema.sql` を初期化用フォルダ `/docker-entrypoint-initdb.d/` に読み取り専用でマウント
  - ヘルスチェック：`mysqladmin ping`
  - `ports` は書かない（外部に公開しない）
- **app**
  - `tumugi_server/` を `/var/www/tumugi` に読み取り専用でマウントする（編集がすぐ反映され、再ビルドは不要）。
  - 環境変数：`DB_HOST=db`、`DB_NAME`、`DB_USER`、`DB_PASS`、`TZ=Asia/Tokyo`
  - db のヘルスチェックが通ってから起動する（`depends_on: condition: service_healthy`）。
- **seed**
  - app と同じイメージで `php /var/www/tumugi/tools/seed_demo.php` を実行する。
  - app の環境変数に加えて `DEMO_SEED` と `DEMO_PASSWORD` を受け取る。
  - db のヘルスチェックが通ってから実行する。`restart: "no"`。
- **phpmyadmin**
  - `profiles: [tools]` を指定する。`PMA_HOST=db`。
  - ログインには `.env` の DB ユーザーとパスワードを使う。

### 3.4 Dockerfile（docker/app）
- ベースは `php:8.4-apache`。
- `docker-php-ext-install pdo_mysql` を実行する。
- `php.ini-production` を `php.ini` として使う（`display_errors=Off`）。公式イメージは何も指定しないとエラーを画面に表示するため、本番用の設定を明示する。
- `conf.d` に `date.timezone=Asia/Tokyo` を追加する。
- `apache.conf` を Apache のデフォルトサイト設定として配置する。

### 3.5 apache.conf
- `DocumentRoot` は空のディレクトリにする。
- `Alias /api /var/www/tumugi/api` で、`/api` だけを公開する。
- `/var/www/tumugi/api` は `Require all granted`、`AllowOverride None`、`Options -Indexes` にする。
- `includes/`、`sql/`、`tools/` は URL では届かない。そのため .htaccess による保護は不要になり、`AllowOverride None` で .htaccess 自体を読まない設定にする。

### 3.6 環境変数（.env / .env.example）

| 変数 | 用途 | .env.example の値 |
|---|---|---|
| `DB_NAME` | DB 名 | `tumugi_demo` |
| `DB_USER` | アプリ用 DB ユーザー | `tumugi_app` |
| `DB_PASS` | アプリ用 DB パスワード | `change_me` |
| `DB_ROOT_PASS` | MySQL の root パスワード | `change_me_root` |
| `DEMO_SEED` | デモデータを投入するか | `true` |
| `DEMO_PASSWORD` | デモアカウント共通のパスワード | `change_me_demo` |

- ルートの `.env` は、compose が変数の置き換えに使い、各サービスに渡す。
- 移行作業では、Claude がランダムな値で `.env` を作る。値はチャットには表示しない。

## 4. データ

### 4.1 schema.sql
- **作り方**
  1. XAMPP の MySQL を一度だけ起動し、`mysqldump --no-data` で構造だけを書き出す。
     - 接続情報は今の `includes/.env` から読み、画面には表示しない。
     - 書き出したファイルはスクラッチ領域に置き、リポジトリには入れない。
  2. それをもとに、MySQL 8.4 用の schema.sql を書き直す。
  3. XAMPP を起動できない場合は、コードで使われている列から組み立て直す。
- **内容**
  - `employees`：`is_admin` と `is_new_grad` を含める
  - `emotion_logs`：`harassment_type` を含める
  - `auth_tokens`、`login_attempts`
  - 手作業の ALTER で追加された列は、すべて CREATE TABLE に最初から含める。
  - `CREATE DATABASE` と `USE` は書かない（DB は compose が作る）。文字コードは utf8mb4 にする。
- **実行タイミング**
  - db のボリュームが空のとき（初回）だけ実行される。
  - 構造を変えたときは `docker compose down -v` で作り直す。デモデータは自動で再生成されるので失うものはない。

### 4.2 tools/seed_demo.php
- CLI からの実行だけを受け付ける（Web からは届かない場所に置くが、念のため残す）。
- `DEMO_SEED` が `true` 以外の場合は、`--refresh` の有無に関係なく何もせず、メッセージを出して正常終了する（exit 0）。実運用ではここを false にする。これにより、実運用の DB で誤って `--refresh` を実行しても本物のログは消えない。
- `DEMO_PASSWORD` が未設定の場合は、理由を出して失敗する（exit 1）。
- **社員**：`employees` が空のときだけ、下表の21人を登録する。パスワードは `password_hash(DEMO_PASSWORD)` で作る。

| 部署 | 社員（★は新卒） |
|---|---|
| 営業部 | E001, E002, E006★, E007, E008 |
| 開発部 | E003, E009★, E010★, E011, E012 |
| 人事部 | E004, E013★, E014★, E015, E016 |
| 製造部 | E005, E017★, E018, E019, E020 |
| 管理部 | A001（表示名「管理者」、`is_admin=1`） |

  - 表示名は既存のシードと同じく「ダミー社員N」にする。
  - 管理部は1人なので、5人未満の部署を除外するルールによって集計に入らない。
- **感情ログ**：`emotion_logs` が空のときだけ、今の `refresh_demo_data.php` と同じ規則で作る。
  - 在籍中の一般社員（`is_admin=0`）1人あたり3〜8件、直近6日間のランダムな時刻。管理者 A001 のログは作らない
  - 危機検知は5%（スコア100）
  - ハラスメント申告：received は E003・E007・E011、said は E015・E019・E005（各1件、emotion=troubled）
- **`--refresh` オプション**：`emotion_logs` を TRUNCATE してから作り直す。デモの直前に使う。
  - 実行方法：`docker compose run --rm seed php /var/www/tumugi/tools/seed_demo.php --refresh`
- 「テーブルが空かどうか」で判定するので、何回実行しても二重に登録されない。ロックファイルの仕組みは廃止する。

### 4.3 includes/emotion_scores.php
- 感情ごとのスコア表（happy=0、normal=10、surprised=20、angry=50、sad=60、troubled=70、危機検知時は100）を1か所で定義する。
- `api/save_emotion.php` と `tools/seed_demo.php` はここを参照する。今は同じ表が4か所に重複している。

## 5. アプリ側・サーバー側の変更

### アプリ（tumugi_app）
- `main.js` の `SERVER_BASE_URL` を `http://127.0.0.1:8080/api` に変える。
  - `localhost` は IPv6（::1）として先に解決されることがあり、127.0.0.1 でしか待ち受けない Docker とつながらない可能性があるため、IP を直接書く。
  - 学校サーバー前提のコメントは更新する。
- 使われていない `js/config.js` を削除する（URL の二重定義を解消する）。

### サーバー（tumugi_server）
- `includes/db.php`：`loadEnv()` の呼び出しをやめ、`requireEnv()` で環境変数だけを読む。
- `includes/env.php`：`requireEnv()` だけを残す。
- `api/save_emotion.php`：スコア表を `emotion_scores.php` から読む。

### 削除するもの
- `tumugi_server/includes/.env`（Git 管理外のローカルファイル。統合前のものは `tumugi_server_bak_20261007` に残っている）
- `tumugi_server/includes/.env.example`
- `tumugi_server/.htaccess`、`tumugi_server/includes/.htaccess`
- `seed_dummy_data.php`、`seed_additional_employees.php`、`seed_dummy_emotion_logs.php`、`seed_dummy_harassment_logs.php`、`refresh_demo_data.php`
- `.seed_lock`、`.seed_additional_lock`、`.seed_emotion_lock`、`.seed_harassment_lock`
- `tumugi_server/README.md`（古い内容）
- `.gitignore` の `.seed_*lock` の行（対象のファイルがなくなるため）

### 追加するもの
- ルートの `README.md`：起動手順だけを書く。
  - 前提：Docker Desktop、Node.js、Ollama、VOICEVOX
  - `.env` の作り方、`docker compose up -d`、`npm install` と `npm start`
  - デモアカウント、デモデータの作り直し、phpMyAdmin、完全な初期化（`docker compose down -v`）
  - ポートフォリオ向けの説明は、公開前の別テーマで書く。

## 6. エラー処理
- PHP は `display_errors=Off`。DB 接続に失敗した場合は、今と同じく汎用の JSON エラー（500）を返す。
- 必須の環境変数が足りない場合、`requireEnv()` が例外を投げる。画面にはエラーの詳細を出さず、Apache のエラーログ（`docker compose logs app`）で確認する。
- seed は理由を表示して終了コードで成否を返す。`docker compose ps` で exit code を確認できる。
- app と seed は db のヘルスチェックを待つので、DB の起動が遅れても接続エラーにならない。

## 7. 移行手順
1. ユーザーが XAMPP の MySQL だけを起動し、Claude が構造だけを書き出す（4.1）。
2. Claude が 3〜5 章の変更を実装し、`.env` をランダムな値で作る。
3. ユーザーが `docker compose up -d` を実行する（初回はイメージのビルドがある）。
4. ユーザーが 8 章のチェックリストで動作を確認する。
5. 確認がすべて通ったら、ジャンクション `C:\xampp\htdocs\tumugi_server` を削除する。`C:\xampp\htdocs\tumugi_server_bak_20261007` を削除するタイミングはユーザーが決める。XAMPP 本体はそのまま残る（使わなくなる）。
6. コミットは意味のまとまりごとに分ける（例：Docker 構成とデータ／アプリの接続先変更／古いファイルの削除と README）。

## 8. 確認チェックリスト（ユーザーが実施）
1. `docker compose ps` で db と app が healthy / running、seed が exit 0 になっている
2. ブラウザで `http://127.0.0.1:8080/api/login.php` を開くと、405（POST のみ）の JSON が返る
3. `http://127.0.0.1:8080/includes/db.php` は 404 になる
4. アプリで E001 としてログインし、1回発言できる
5. A001 でログインすると、ダッシュボードに4部署・新卒・ハラスメントの項目が表示される
6. `--refresh` 付きでシードを実行すると、ダッシュボードの値が変わる
7. `docker compose --profile tools up -d` のあと、`http://127.0.0.1:8081` で phpMyAdmin が開く

## 9. 範囲外
- レビューで見つかった改善項目（集計の閾値、記憶の社員別化、emotion の分離など）はこの移行では扱わない。
  - ただし、タイムゾーンの統一でトークン期限のずれは解消される。期限を SQL 側で計算する根本対策は、別テーマで行う。
- HTTPS 化（127.0.0.1 からしか接続できないため、今回は不要）
- 導入先での本番運用の手順（バックアップ、実際の管理者アカウントの作り方など）
- CORS 設定の見直し
- 自動テスト
- LLM をどこで動かすか（実運用の条件「事務用PCでも動く」を満たすため）。この移行のあと、モデルを測定して決める（別テーマ）。社内LLMサーバー方式になった場合は、compose に Ollama のサービスを追加する。
- Electron 29 からの更新（サポート終了済み。別テーマ）
