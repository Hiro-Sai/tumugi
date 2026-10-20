# ローカル完結の仕上げ 設計書

- 日付：2026-10-08
- 状態：実装済み（2026-10-09、ユーザー確認済み）。実装中に変えた点は「9. 実装中の変更と追加」

## 1. 背景と目的

### 背景
- つむぎは社員の悩みや感情を扱うため、「すべてローカルで完結する」ことが絶対条件になっている（2026-10-07 にユーザーが決定）。
  - 範囲：**使用中はインターネットに出ない**。PC の中と社内 LAN の通信はよい。導入時に1回だけソフトやモデルをダウンロードするのと、ソースコードを GitHub に保存するのはよい。
- 2026-10-07 の監査で、アプリ（tumugi_app、Electron 29）に次の問題が見つかった。
  1. **Google Fonts を毎回ネットから読み込んでいる**：login.html・index.html・admin-dashboard.html の `<link>` と、css/style.css の `@import`。今も絶対条件に反している。
  2. **中継のパスを検証していない**：main.js は `${OLLAMA_BASE_URL}${reqPath}` のように連結している。画面側から `@evil.com/x` を渡すと `http://localhost:11434@evil.com/x` になり、外部のサーバーに送られる。XSS（不正なスクリプトの埋め込み）が起きたときの送信経路になる。
  3. **外部リンクを何でも開く**：`setWindowOpenHandler` が、どんな URL でも `shell.openExternal` で開く。アプリのウィンドウ自体が外部ページへ移動するのを止める仕組みもない。
  4. **CSP がない**：HTML に直接書いたスクリプト（admin-dashboard.html の約340行、HTML の `onclick`・`onkeydown` 18か所、プリセット一覧が組み立てる3か所）があるため、厳しい CSP をそのままでは入れられない。
  5. **Ollama・VOICEVOX の接続先が `localhost` のまま**：API サーバーは 127.0.0.1 にそろえてある。
- ほかに、main.js で Electron のセキュリティ警告を消している（`ELECTRON_DISABLE_SECURITY_WARNINGS`）。

### 目的
- 上の5つを直し、アプリが使用中に PC の外へ通信する経路をなくす。
- 万一 XSS が起きても、外部へ送れない・ネットから何かを取りに行けない状態にする。

### 成功基準
- Wi-Fi を切った状態でも、見た目（フォント）と動き（ログイン、会話、音声、ダッシュボード）が今と同じ。
- 画面側からの通信は、CSP と Electron の両方で止まる。
- 中継は、許可リストにあるメソッドとパスの組だけを通す。
- アプリはどの外部 URL も開かない。

## 2. 決定事項（ユーザーと合意したもの）

| 項目 | 決定 | 理由 |
|---|---|---|
| フォント | 今の3フォントをアプリに同梱する | 見た目を変えない。日本語フォントは数MB〜十数MBあるが、Electron アプリ全体から見れば小さい |
| 同梱の方法 | npm パッケージ（Fontsource） | Git に大きなバイナリを入れずに済む。ライセンス文がパッケージに入っている。Google と同じく文字の範囲ごとに分割されている |
| 外部リンク | 開かず、URL を文字で表示する | アプリはどの外部 URL も開かない。いちばん単純で、面接でも言い切れる |
| CSP | スクリプトだけ厳しくする（スタイルは許可） | XSS 対策として効果が大きい部分だけをやる。外部につながらない以上、スタイルを禁止しても安全性はほとんど変わらない |
| 中継の制限 | 使うエンドポイントだけ許可する（メソッドも固定） | 接続先の確認だけでは、Ollama の `/api/pull`（ネットからモデルを取得）などが通ってしまう |
| 追加の守り | 入れる | 画面からの通信を Electron でも止める、権限要求を断る、スペルチェックを切る、警告を消す設定を外す |

## 3. 変更するファイル

```
tumugi_app/
├─ net-policy.js               ← 新規：中継の許可リストと、通信・画面移動の判定（純粋な関数だけ）
├─ test/net-policy.test.js     ← 新規：net-policy.js の単体テスト（node:test）
├─ main.js                     ← 中継・外部リンク・画面移動・通信遮断・権限・webPreferences
├─ package.json                ← Fontsource の3パッケージ、test スクリプト、build.files に net-policy.js
├─ package-lock.json           ← npm install で更新
├─ css/style.css               ← Google Fonts の @import を Fontsource に置き換え、クレジットの URL 表示用のスタイル
├─ login.html                  ← Google Fonts の行を削除、CSP、onclick を削除
├─ index.html                  ← Google Fonts の行を削除、CSP、onclick／onkeydown を削除して id を付ける、クレジット画面
├─ admin-dashboard.html        ← Google Fonts の行を削除、CSP、<script> の中身を外に出す、onclick を削除
└─ js/
    ├─ admin-dashboard.js      ← 新規：admin-dashboard.html の <script> の中身
    ├─ auth.js                 ← ログインボタンのクリックを登録
    └─ script.js               ← index.html のボタンをまとめて登録、プリセット一覧をイベント委譲に
```

## 4. 詳細

### 4.1 net-policy.js（新規）

Electron に依存しない CommonJS のモジュール。main.js とテストの両方から `require` する。

**公開するもの**
- `BASE_URLS`：中継先の基準 URL。
  - `ollama`：`http://127.0.0.1:11434`
  - `voicevox`：`http://127.0.0.1:50021`
  - `server`：`http://127.0.0.1:8080/api`
- `ALLOWED_REQUESTS`：中継先ごとの、許可するメソッドとパスの組。`query: true` の組だけ、`?` 以降を付けてよい。

  | 中継先 | メソッド | パス | クエリ |
  |---|---|---|---|
  | ollama | POST | `/api/chat` | なし |
  | ollama | GET | `/api/tags` | なし |
  | voicevox | POST | `/audio_query` | あり |
  | voicevox | POST | `/synthesis` | あり |
  | voicevox | GET | `/version` | なし |
  | server | POST | `/login.php` | なし |
  | server | POST | `/save_emotion.php` | なし |
  | server | GET | `/dashboard_data.php` | なし |

- `buildRelayUrl(service, reqPath, method)`：中継してよければ URL の文字列を、だめなら `null` を返す。
- `isLocalRequestUrl(url)`：画面側からの通信を許可してよいか（`file:`・`blob:`・`data:`・`devtools:` なら true、それ以外は false）。
  - `file:` は、この PC の中のファイルだけを許可する。`file://ホスト名/共有名/...` のような URL（UNC、ネットワーク上の共有フォルダ）は false。Windows ではネットワーク越しに取りに行くため（Task 1 のレビューで追加）。
- `isAllowedNavigation(url, appDir)`：アプリのウィンドウがその URL に移動してよいか。`appDir` の中にある `.html` の `file:` URL なら true、それ以外は false。`appDir/../x.html` のような外側への移動は false。

**buildRelayUrl の判定（どれか1つでも当てはまれば null）**
1. `service` が `BASE_URLS` にない。`reqPath` か `method` が文字列でない。
2. `reqPath` が空文字、または表示できる ASCII 文字（`!`〜`~`）以外を含む（空白・日本語・制御文字など）。
3. `reqPath` が `/` で始まらない、または `//` で始まる。
4. `reqPath` に `\` か `#` が含まれる。
5. 最初の `?` より前の部分が、その中継先の許可リストのパスと**文字列として完全に一致**し、かつメソッドも完全に一致する組がない（大文字小文字も区別する。`/api/../api/chat` や `%2e` のような書き方は一致しないので拒否される）。
6. `?` があるのに、その組が `query: true` ではない。
7. `BASE_URLS[service] + reqPath` を `new URL()` で解釈したときの origin（スキーム・ホスト・ポート）が、`BASE_URLS[service]` の origin と一致しない。

すべて通れば `BASE_URLS[service] + reqPath` を返す。

### 4.2 main.js

1. **中継**：3つの中継とも `buildRelayUrl(service, reqPath, method || "GET")` で URL を作る。
   - `null` なら fetch せずに `{ ok: false, reason: "forbidden" }` を返し、`console.warn` で中継先・メソッド・パスを出す。
   - 共通 fetch ラッパーのコメントにある `reason` の一覧に `"forbidden"` を足す。
   - VOICEVOX の `responseType` は `"arraybuffer"` のときだけそのまま使い、それ以外は `"json"` にする。
   - 基準 URL の定数は main.js から消し、net-policy.js の `BASE_URLS` を使う。今の SERVER_BASE_URL の説明コメント（127.0.0.1 にしている理由、https の保留事項）は net-policy.js に移す。
2. **外部リンク**：`setWindowOpenHandler` は常に `{ action: "deny" }` を返す。`shell` は使わなくなるので `require` から消す。
3. **画面移動**：`webContents.on("will-navigate")` で、`isAllowedNavigation(url, __dirname)` が false なら `event.preventDefault()` する。
4. **通信の遮断**：`session.defaultSession.webRequest.onBeforeRequest` で、`isLocalRequestUrl(details.url)` が false の通信を取り消す（`cancel: true`）。取り消したときは `console.warn` に「外部への通信を止めました」とスキームとホストを出す（動作確認でターミナルを見て確かめるため）。
   - 中継は main.js から Node の fetch で送るので、この遮断の影響を受けない。
5. **権限**：`session.defaultSession.setPermissionRequestHandler` は常に拒否、`setPermissionCheckHandler` は常に false を返す。
6. **webPreferences**：`spellcheck: false` と `sandbox: true` を足す（preload.js は `contextBridge` と `ipcRenderer` しか使っていないので、sandbox でも動く）。
7. `process.env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = "true";` の行を消す。
8. 中継のコメント「学校PHPサーバーへの中継」を「API サーバーへの中継」に直す。
9. **Ollama のモデル名**（最終レビューで追加）：会話（POST `/api/chat`）は、本文の `model` が `isAllowedOllamaModel(model)` を通るときだけ中継する。通らなければ `{ ok: false, reason: "forbidden" }` を返し、`console.warn` にモデル名を出す。
   - `isAllowedOllamaModel`（net-policy.js）は、表示できる ASCII 文字だけの文字列で、`/(^|[:-])cloud$/i` に一致しないときだけ true。
   - 理由：Ollama の cloud モデル（例：`gpt-oss:120b-cloud`）は、Ollama にサインインしていると ollama.com のサーバーで動き、会話が PC の外に出る。モデル名は画面側（localStorage）で変えられる。
   - 限界：担当者が Ollama 側で cloud モデルに別名を付けると通ってしまう。そのため README に「Ollama にサインインしない」と書く（本当の守りはこちら）。
10. **スペルチェック**（最終レビューで追加）：`webPreferences` の `spellcheck: false` に加えて、`session.defaultSession.setSpellCheckerEnabled(false)` を呼ぶ。セッションのスペルチェックが有効のままだと、辞書をネットから取りに行くことがあるため。

`app.whenReady()` のあと、`createWindow()` の前に 4・5・10 を設定する。

### 4.3 フォント

- `dependencies` に `@fontsource/zen-old-mincho`、`@fontsource/dm-sans`、`@fontsource/noto-sans-jp` を足す（`npm install` で入れる）。
- css/style.css の5行目（Google Fonts の `@import`）を、次の7行に置き換える。今と同じ太さだけを読み込む。
  ```css
  @import url("../node_modules/@fontsource/zen-old-mincho/400.css");
  @import url("../node_modules/@fontsource/zen-old-mincho/700.css");
  @import url("../node_modules/@fontsource/dm-sans/300.css");
  @import url("../node_modules/@fontsource/dm-sans/400.css");
  @import url("../node_modules/@fontsource/dm-sans/500.css");
  @import url("../node_modules/@fontsource/noto-sans-jp/300.css");
  @import url("../node_modules/@fontsource/noto-sans-jp/400.css");
  ```
- 3つの HTML の Google Fonts の3行（`preconnect` 2行と `<link href="https://fonts.googleapis.com/...">`）を消す。
- Fontsource の `font-family` 名は Google と同じ（'Zen Old Mincho'、'DM Sans'、'Noto Sans JP'）なので、CSS 変数は変えない。実装時に、インストールした各パッケージの CSS で名前が同じことを確かめる。

### 4.4 CSP

3つの HTML の `<head>` の、`<meta charset>` の直後に入れる。内容は3つとも同じ。

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
```

| 指定 | 理由 |
|---|---|
| `script-src 'self'` | アプリのフォルダの JS ファイルだけ実行する。HTML に直接書いたスクリプトと `onclick` は動かなくなる |
| `style-src 'self' 'unsafe-inline'` | `style="..."` と admin-dashboard.html の `<style>` を残すため |
| `img-src 'self' data:` | 背景のノイズ模様（style.css の data: の SVG）のため |
| `media-src 'self' blob:` | VOICEVOX の音声を Blob URL で再生するため |
| `connect-src 'none'` | 画面側からの通信をすべて止める。画面側の通信は中継（IPC）経由だけ |

### 4.5 HTML に直接書いたスクリプトをなくす

- **admin-dashboard.html**
  - `<script>` の中身を、そのまま新しいファイル js/admin-dashboard.js に移す。HTML では `<script src="js/admin-dashboard.js"></script>` で読み込む（utils.js・auth.js のあと）。
  - 戻るボタンの `onclick="location.href='index.html'"` を消し、id `adminBackBtn` を付けて、admin-dashboard.js で click を登録する。
- **index.html**
  - `onclick`／`onkeydown` の16か所を消す。id がない要素には id を付ける。
  - script.js に `DOMContentLoaded` の処理を1つ足し、そこでまとめて `addEventListener` で登録する。呼ぶ関数は今の `onclick` と同じにする。
  - `handleNoticeConsent(true)`／`(false)` のような引数付きのものは、無名関数で包む。`onTextInputKeydown(event)` は keydown で登録する。
- **login.html**
  - ログインボタンの `onclick="submitLogin()"` を消し、auth.js の既存の `DOMContentLoaded` の中で、`loginSubmitBtn` の click を登録する。
- **script.js のプリセット一覧**
  - `onclick="selectPreset('${p.id}')"`・`duplicatePreset`・`deletePreset` の3か所をやめる。
  - 代わりに、`data-action="select|duplicate|delete"` と `data-id`（`escapeHtml` を通す）を付け、一覧の要素でイベント委譲する（記憶一覧と同じ形）。
  - 今は id をエスケープせずに JS の文字列へ埋め込んでいるが、この書き換えでその経路もなくなる。
- `style="..."` と admin-dashboard.html の `<style>` はそのまま残す。

### 4.6 クレジット画面（index.html）

- 6つの `<a class="credit-link" href="..." target="_blank">` をなくす。フォントの項目（`https://fonts.google.com`）は下のフォント3項目に置き換えて URL を出さず、残りの5つを `<span class="credit-url">` に変え、URL を省略せずに文字で表示する（例：「利用規約 — voicevox.hiroshiba.jp/term」は `https://voicevox.hiroshiba.jp/term` にする）。
- css/style.css の `.credit-link` と `.credit-link:hover` を `.credit-url` に置き換える。色と大きさは今のままにし、ホバーの下線は付けない。文字は選択してコピーできるようにする（`user-select: text`、`cursor: text`）。
- フォントの項目を、Zen Old Mincho・DM Sans・Noto Sans JP の3つにする。著作権表示は、同梱したフォントファイル（woff）に埋め込まれた著作権表示（name テーブルの nameID 0）を一字一句写し、「SIL Open Font License 1.1」と書く（パッケージの LICENSE は、複数ファイル分の表記が連結されていたり、「Google Inc.」だけだったりして使えなかったため）。今の「© Google Fonts」は正確ではないのでやめる。
- 春日部つむぎの「© AquesTalk春日部つむぎ」を「VOICEVOX:春日部つむぎ」に直す（公開前に直す予定だった項目。同じ箇所なので一緒に直す）。

## 5. エラーのときの動き

- 中継で拒否したとき（許可リストにない中継、PC の外で動くモデルへの会話）：`{ ok: false, reason: "forbidden" }` を返す。画面側は、今の接続エラーの表示に任せる（新しい表示は作らない）。正しく使っている限り、拒否は起きない。
- 画面側の外部への通信：Electron が取り消し、ターミナルに警告を出す。CSP にも違反するので、開発者ツールを開いていればコンソールにも出る。
- 外部への画面移動・新しいウィンドウ：何も起きない。

## 6. テストと確認

### 6.1 単体テスト（test/net-policy.test.js、node:test）

- package.json に `"test": "node --test"` を足す。新しいパッケージは使わない。
- **buildRelayUrl が通すもの**（返る URL まで確かめる）：4.1 の表の8つの組。
  - 例：`("ollama", "/api/chat", "POST")` → `http://127.0.0.1:11434/api/chat`
  - 例：`("voicevox", "/audio_query?text=%E3%81%82&speaker=8", "POST")` → `http://127.0.0.1:50021/audio_query?text=%E3%81%82&speaker=8`
  - 例：`("server", "/login.php", "POST")` → `http://127.0.0.1:8080/api/login.php`
- **buildRelayUrl が拒否するもの**（すべて null）：
  - 接続先のすり替え：`@evil.com/x`、`//evil.com/api/chat`
  - 許可していないエンドポイント：`/api/pull`、`/api/delete`
  - メソッド違い：`/api/chat` を GET、`/api/tags` を POST、`/api/chat` を `post`（小文字）
  - 書き方の違い：`/api/../api/chat`、`/api/%2e%2e/api/chat`、`/api\chat`、`/api/chat#x`
  - 許可していないクエリ：`/api/chat?x=1`、`/version?x=1`
  - 文字：空文字、空白を含むもの、日本語を含むもの
  - 型：`reqPath` が `undefined`・`null`・数値
  - 中継先違い：`("ollama", "/login.php", "POST")`、存在しない中継先 `("evil", "/api/chat", "POST")`
- **isLocalRequestUrl**
  - true：`file:///C:/app/index.html`、`file://localhost/C:/app/index.html`、日本語（%エンコード）を含むパス、`blob:file:///...`、`data:image/svg+xml,...`、`devtools://devtools/...`
  - false：`http://127.0.0.1:11434/api/tags`（画面側からはローカルのサーバーにも直接つながせない）、`https://fonts.googleapis.com/...`、`ws://127.0.0.1:1234`、UNC の `file://evil.com/share/x.png`・`file:////evil.com/share/x.png`・`file:///%2F%2Fevil.com/x.png`
- **isAllowedNavigation**（`appDir` はテスト内で作ったパスを `pathToFileURL` で URL にする）
  - true：`appDir/index.html`、`appDir/admin-dashboard.html`
  - false：`appDir` の外の HTML、`appDir/../x.html`、`https://example.com`、`appDir/js/script.js`（HTML 以外）
  - Windows のときだけ（最終レビューで追加）：大文字小文字の違いは true。名前の前半が同じ別フォルダ（`C:/tumugi-app2`）、別ドライブ、UNC、`%2F`・`%5C` を使ったすり替えは false。
- **最終レビューで追加したもの**
  - buildRelayUrl：`%2f`・`%5c`・`%2e%2e`・`%3f` を使ったすり替えは null。許可したクエリに `@evil.com` があっても接続先は変わらない。
  - isAllowedOllamaModel：`gemma3:12b` などは true。`gpt-oss:120b-cloud`・`glm-4.6:cloud`・大文字の `-CLOUD`・`cloud`・前後に空白・空文字・文字列でない値は false。

### 6.2 ユーザーの確認

作業の前に、ログイン画面・チャット画面・ダッシュボードのスクリーンショットを撮っておく（フォントを見比べるため）。

実装のあと：
1. `npm test` がすべて成功する。
2. Docker・Ollama・VOICEVOX を起動し、**Wi-Fi を切ってから** `npm start` する。
3. ログイン画面：フォントがスクリーンショットと同じ。間違ったパスワードでエラーが出る。ボタンと Enter キーのどちらでもログインできる。
4. 同意の確認画面：まだ同意を決めていない社員（例：E002）でログインし、「同意する」「同意しない」が動く。
5. 初回設定の画面：「記憶」の「全部忘れる」のあとにログインし直すと出る。「話しかける」「後で」が動く。
6. チャット画面：ボタンと Enter キーで送信でき、返事と音声が出る。フォントがスクリーンショットと同じ。
7. 左側のボタンがすべて動く：記憶（開く・閉じる・保存・削除・全部忘れる）、プライバシー設定（開く・閉じる・切り替え）、クレジット（開く・閉じる）、ログアウト。
   - プリセット一覧（4.5）は、今の index.html に表示する場所がなく呼ばれていないため、画面では確認できない。書き換えはコードのレビューで確かめる。
8. 管理者（A001）：ダッシュボードへのボタン、グラフの表示、「チャットに戻る」。
9. クレジット画面：URL が文字で表示され、クリックしても何も開かない。選択してコピーできる。春日部つむぎの表記が「VOICEVOX:春日部つむぎ」になっている。
10. `npm start` のターミナルに「外部への通信を止めました」が1行も出ていない。

（任意）main.js の `//win.webContents.openDevTools();` の行のコメントを一時的に外し、コンソールに CSP 違反が出ていないことを確かめる。確認後は元に戻す。

## 7. 進め方

- 実装は前回と同じく、タスクごとに別のエージェントが実装し、レビューする。
- `npm install @fontsource/...` は実装者が実行してよい（パッケージを1回ダウンロードして package.json と package-lock.json を更新するだけで、使用中の通信ではない）。
- 単体テスト（`npm test`）は外部に通信せず数秒で終わるので、実装者が書きながら実行してよい。最後にユーザーも実行する。
- アプリの起動（`npm start`）と動作確認はユーザーが行う。コミットはユーザーの確認のあと。

## 8. 範囲外（バックログに残す）

- スタイルも厳しくする CSP（`style="..."` をクラスにし、admin-dashboard.html の `<style>` を CSS ファイルに移す）。
- Electron の更新（29.4.6 はサポート終了済み）。
- インストーラーの作成。package.json の build 設定に `!**/node_modules/**` があるため、今のままでは同梱フォントも electron-store もインストーラーに入らない。また、存在しない `admin-demo.html` が書かれている。Electron の更新と一緒に見直す。
- 社内 LAN 用の接続先の設定（基準 URL を設定で変えられるようにする）。社内 LLM サーバーにするかは LLM の測定のあとで決める。
- （最終レビューから）インストーラーを作るときは、同梱フォントの OFL の本文（各パッケージの LICENSE）も一緒に入れる。
- （最終レビューから）画面の移動先を、アプリのフォルダの中の任意の `.html` から、3つの画面（index.html・login.html・admin-dashboard.html）だけに絞る。今は node_modules の中の HTML にも移動できてしまう（preload が読み込まれ、CSP はない）。画面からの攻撃が成功したときだけ問題になるので、優先度は低い。
- （最終レビューから）CSP と webRequest では見えない経路の守り：`<link rel="dns-prefetch">` と WebRTC（STUN）。WebRTC の IP 処理ポリシーを `disable_non_proxied_udp` にする、`host-resolver-rules` で名前解決を止める（LAN のホスト名を使うときに見直す）、インストーラーで Windows ファイアウォールの送信の規則を入れる（最後の守り）。
- （最終レビューから）cloud モデルで会話を拒否したとき、画面にはふつうの接続エラーしか出ない。理由がわかる表示にするか検討する。
- （最終レビューから）グラフの文字が、同梱フォントの読み込みより先に描かれることがある。`document.fonts.ready` のあとにも描き直すと確実になる。
- （最終レビューから）仕上げの細かい点：`buildRelayUrl` で `service` が文字列か確かめる。`will-navigate` の非推奨の第2引数 `url` を `details.url` にする（Electron の更新と一緒に）。style.css の `font-weight: 600`（日本語の本文用フォント）に対応する字形を読み込むか、500 以下にする。`npm audit` の19件（Electron の更新と一緒に）。

## 9. 実装中の変更と追加

- **UNC の拒否（4.1）**：Task 1 のレビューで、`file://ホスト名/...`（ネットワーク上の共有）を許可してしまう問題が見つかり、`isLocalRequestUrl` で拒否するようにした。最終確認で、Electron の中でこの読み込みは CSP（`'self'`）でも止まることを確かめた（開発者ツールで `file://example.invalid/...` の画像を読み込むと CSP の違反になる）。webRequest 側の判定は二重の守りとして残す。
- **管理者画面のグラフの描き直し（計画外）**：ウィンドウの大きさや画面の拡大率が変わるとグラフが引き伸ばされてぼやける、もとからの不具合を、ユーザーの依頼で直した。`ResizeObserver`（`device-pixel-content-box`）で実際の画素数の変化を見て描き直す。このコードは 4.5 のとおり js/admin-dashboard.js に移した。
- **クレジットの著作権表示（4.6）**：LICENSE ではなく、フォントファイルに埋め込まれた表記を使った。URL は5つ（フォントの項目の URL はなくした）。
- **最終レビューの修正（4.2 の 9・10、6.1）**：Ollama の cloud モデルへの会話の中継を拒否、セッションのスペルチェックを停止、テストを13個から19個に追加、README に「Ollama にサインインしない」を追加。
