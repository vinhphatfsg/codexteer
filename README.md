# codex-steer

普段のCodex Desktopを使いながら、別のAIが進捗を観測し、根拠を伴って実行途中に軌道修正を伝えるためのmacOS用CLIです。ターミナルからの単発送信にも使えます。

## 導入

macOS、Node.js 20以降、Git、makeと、`/Applications/ChatGPT.app`にインストールされたCodex Desktopが必要です。

```bash
git clone https://github.com/vinhphatfsg/codex-steer.git
cd codex-steer
make install-local
```

`~/.local/bin`をPATHに追加してください。zshの場合は次の行を`~/.zshrc`に追加し、ターミナルを開き直します。

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Codex Desktopでの作業を終えてアプリを終了し、ターミナルから起動します。

```bash
codex-steer desktop start
codex-steer doctor --json
```

`desktop start`はDesktopを起動するたびに実行します。すでに起動している場合は、一度終了してから実行してください。通常の起動に戻すには、Desktopを終了し、Dockなどから開き直します。

インストールしたCLIはこのリポジトリへのシンボリックリンクです。リポジトリを移動した場合は`make install-local`を再実行してください。削除する場合は`make uninstall-local`を実行します。

`desktop start`は実行ファイルと依存を`CODEX_HOME/codex-steer/runtimes/<version>-<sha256>`へ検証して配置し、そのwrapperからDesktopを起動します。元のリポジトリやnpxキャッシュに依存せず、起動後のhelperも同じ保存先を使います。配置済みの版は自動削除・上書きしません。

npm配布用の名前は`@vinhphatfsg/codex-steer`です。無指定の`codex-steer`は別パッケージが登録済みです。現在は公開前のため`private: true`を維持しています。MITライセンス、固定版での実行例、保存先の検証・復旧と公開前テストは[配布ドキュメント](docs/distribution.md)を参照してください。

## 使い方

以下の`<thread-id>`は対象のタスクIDに置き換えてください。`codex://threads/...`形式のタスクURLも使えます。

### Claude CodeにCodexの監視とステアリングを任せる

上の導入を済ませ、PATH上の`claude`でClaude Codeを起動できる状態にします。監視したいCodexタスクのIDまたはURLをコピーし、別のターミナルの対象プロジェクトのディレクトリから次を実行してください。

```bash
codex-steer supervise <thread-id> --agent claude
```

対象IDを埋め込んだ監督プロンプトでClaudeを[対話起動](https://code.claude.com/docs/en/cli-reference#cli-commands)します。端末の標準入出力をそのまま使い、起動後もClaudeへ追加の指示を入力できます。

モデルなどClaude側の起動引数は、`--`の後ろへ渡します。

```bash
codex-steer supervise <thread-id> --agent claude -- --model <model> --effort <level>
```

既にClaudeを起動している場合は、監督役（オーケストレーター）向けのプロンプトを出力し、そのセッションに貼り付けても使えます。

```bash
codex-steer supervise prompt <thread-id>
```

監督手順は`codex-steer help monitor`と生成プロンプトで共通です。

1. 接続を診断し、対象タスクの最新の依頼・制約・進捗、有効な指示と対応待ちの履歴を確認する。
2. 差分を読み切ったcursorから観測を続ける。[Monitorツール](https://code.claude.com/docs/en/tools-reference#monitor-tool)が使えれば`watch --stream`、使えなければ短い`watch`を繰り返す。接続状態の通知を読み、復帰待ちの間は介入を控える。
3. 過剰設計・スコープ逸脱・より小さな修正の余地を判断し、必要なら最新の差分を読み切ってから`send --based-on`で介入する。同じ指摘が対応中なら結果を待つ。
4. 送信したmessage_idを保持し、受付・対応報告・検証結果を区別して追う。`unknown`は`history check`で照合し、自動再送しない。
5. 介入内容・確認結果・未確認事項を短く報告する。停止指示を受けたら、自分のMonitor/watchと追加送信を止める。

このプロンプトは、ユーザーの最新の目的・制約の範囲内で監督と介入を委任します。その範囲の介入に毎回の確認は不要です。目的・制約が不明な場合や要件自体を変える必要がある場合は確認します。監督の委任だけで停止中タスクを再開したり、承認・質問へ代理回答したりはしません。単発送信では、ユーザーが指定した宛先・内容を使います。

停止するときは、同じClaudeセッションで「監視とステアリングを停止して」と伝えてください。Codexの作業自体は継続します。監督はCLIとOSの既存の権限設定に従います。

IDのコピーを省く場合は、Claudeに`codex-steer threads list --desktop-only --json`で候補を表示してもらい、対象を選ぶこともできます。同じプロジェクトに複数のタスクがある場合、Claudeの起動場所だけでは監視対象を特定できません。

### タスクを探して送信する

```bash
# 最近のタスクを表示
codex-steer threads list --desktop-only --limit 20 --json

# 実行中のタスクに追加入力（受付成功時に「プルッ」の通知音）
codex-steer send <thread-id> "失敗したテストの原因を先に確認してください"

# 今回だけ通知音を鳴らさずに送信
codex-steer send <thread-id> "失敗したテストの原因を先に確認してください" --no-sound

# 停止中のタスクを再開
codex-steer send <thread-id> "続きをお願いします" --new-turn

# 送信内容をプレビュー
codex-steer send <thread-id> "メッセージ" --dry-run --json

# 複数行を標準入力から送信
printf '%s\n' '1. 原因を調査' '2. 結果を説明' | codex-steer send <thread-id> -
```

標準の送信方式は`app-server`です。`--json`を付けると結果をJSONで返します。`delivery_status: unknown`の場合は、`codex-steer history check <thread-id> --json`で受付状況を確認してから再送を判断してください。

### 状態と進捗を読む

```bash
codex-steer status <thread-id> --json
codex-steer read <thread-id> --json
codex-steer read <thread-id> --since <cursor> --include-output --json
codex-steer watch <thread-id> --until idle --timeout-ms 60000 --json
```

`read`は直近50件を返します。返された`data.cursor`を次回の`--since`に渡すと、新規・更新項目を取得できます。`data.has_more: true`の場合は、返されたcursorで続きを読んでください。

変化するたびに1行のJSONを受け取るには、次のコマンドを使います。Ctrl-Cで停止します。

```bash
codex-steer watch <thread-id> --stream --json
```

### 詳細な使い方

以下は用途別のコマンド一覧です。`<...>`は実際の値に置き換えてください。`<cursor>`は`read`・`status`・`watch`の結果、`<message-id>`は`send`・`history list`、`<checkpoint-id>`は`checkpoint capture`・`checkpoint list`、`<token>`は`resource acquire`の結果から取得します。

対話起動の`supervise <thread-id> --agent claude`を除き、各コマンドに`--json`を付けるとJSONで結果を返します。`supervise prompt`もJSONに対応します。別コマンドを実行する`run`や監督役の起動では、codex-steer側のオプションを区切りの`--`より前に置いてください。

#### ヘルプ・バージョン

```bash
# 全体の使い方
codex-steer help

# コマンド別の使い方（sendをread、watch、historyなどに置き換え）
codex-steer help send
codex-steer send --help
codex-steer help send --json

# Claude CodeのMonitorとの連携
codex-steer help monitor

# バージョン
codex-steer --version
```

引数なしの`codex-steer`と`codex-steer --help`でも全体のヘルプを表示します。

#### 監督役の起動

```bash
codex-steer supervise <thread-id> --agent claude
codex-steer supervise <thread-id> --agent claude -- --model <model> --effort <level>
codex-steer help supervise
```

`--agent`は必須で、現在の対応値は`claude`です。PATH上の実行ファイルを、現在の作業ディレクトリ・環境変数・標準入力・標準出力・標準エラーを引き継いで起動します。シェルのaliasやfunctionは使いません。

最初の`--`以降は対象エージェントの引数です。順序・空文字・空白・改行を保ち、codex-steer側では解釈もシェルでの再展開もしません。例えば区切り後の`--help`・`--version`・`--json`もClaudeへ渡します。呼び出し元のシェルで必要な引用は付けてください。

追加引数の後ろには、Claude側の区切り`--`と、`supervise prompt`と同じ生成処理による監督プロンプトを一つの引数として付加します。追加引数の意味や組み合わせの妥当性はClaudeが判断します。

不正なID形式、`--agent`の不足・未対応値、区切り前の未知の引数では起動しません。Claudeが未導入・実行不可などの起動失敗は標準エラーに理由を表示し、終了コード1です。Desktopの接続と対象タスクの存在は、起動した監督役が最初に確認します。

通常終了ではClaudeの終了コードを返します。`SIGINT`・`SIGTERM`・`SIGHUP`は起動したClaudeへ転送し、シグナル終了時は`128 + シグナル番号`を返します。対話出力を引き継ぐため、この起動形式では`--json`は非対応です。ヘルプは`help supervise --json`、本文だけの取得は`supervise prompt <thread-id> --json`を使ってください。

#### 監督役（オーケストレーター）向けのプロンプトを取得

```bash
# 監督役へ渡す、対象タスク入りの本文を標準出力へ出力
codex-steer supervise prompt <thread-id>

# タスクURLからも生成可能
codex-steer supervise prompt codex://threads/<thread-id>

# JSONで対象IDと本文を取得
codex-steer supervise prompt <thread-id> --json

# このコマンドのヘルプ
codex-steer help supervise prompt
```

`supervise prompt`は、Claudeなどの監督役（オーケストレーター）へ渡す初期プロンプトを生成します。対象IDの書式を確認して正規化し、本文へ埋め込みます。Desktopの起動・接続、履歴取得、送信、ファイル保存、Claudeの起動は行いません。タスクの存在と接続は監督開始時に確認します。本文には観測・根拠付き介入・結果確認・停止までの手順を含みます。

通常出力は末尾改行付きの本文のみです。`--json`では既存CLIと同じ形式で返します。

```json
{"ok":true,"command":"supervise.prompt","data":{"thread_id":"aaaaaaaa-aaaa-4aaa-8aaa-000000000001","prompt":"対象IDを含む監督プロンプト本文…"}}
```

IDが不正な場合や引数が不足・過剰な場合は終了コード1です。通常は標準エラーへ理由を出し、本文は出力しません。`--json`では標準出力に`{"ok":false,"error":{"message":"理由"}}`を返します。起動に使う本文の生成には`--json`を付けないでください。

Codex CLIでも、`steer_prompt=$(codex-steer supervise prompt <thread-id>) && codex "$steer_prompt"`のように初期プロンプトを渡せます。生成プロンプトには、Monitorが使えない場合の短い`watch`による手順と、監督AI自身の送信元名を使う案内を含みます。

#### Desktopの起動・診断・タスク選択

```bash
# 共有接続を有効にしてDesktopを起動（--dry-runで起動せずプレビュー）
codex-steer desktop start
codex-steer desktop start --dry-run --json

# 接続と起動条件を診断
codex-steer doctor --json

# 指定タスクの観測APIも検証
codex-steer doctor --thread <thread-id> --json

# 最近のタスクを一覧表示
codex-steer threads list --desktop-only --limit 20 --json

# タスクURLをIDに変換
codex-steer thread resolve codex://threads/<thread-id> --json

# 対象タスクをDesktopの画面で開く
codex-steer open <thread-id>
```

`doctor`はDesktop・同梱CLI・実行中のwrapper Node・手元のCLIを動かすNodeのバージョンと、`connection.status`、`compatibility.api_checks`、`failure`を返します。対象未指定では接続だけを診断するため、観測の互換性は`unverified`です。

さらに`codex_steer_compatibility`で、操作側と実行中wrapperのパッケージ名・バージョン・runtime protocolを照合します。不明・不一致なら`ready: false`です。`read`・`watch`・`send`は`STEER_VERSION_UNVERIFIED`または`STEER_VERSION_MISMATCH`で止まります。旧wrapperの利用後は作業を終えてDesktopを終了し、同じ版のCLIで`desktop start`してください。

`doctor --thread`は指定タスクの読み取り経路を検証し、成功すれば`compatibility.status: verified`を返します。呼び出していないAPIは`unverified`、メソッド未対応は`unsupported`、応答異常等は`failed`です。通信が途切れて検証を完了できなければ`unverified`のまま理由を返します。本文は診断出力に含めず、タスクの再開・送信・承認回答は行いません。`--thread`は`app-server`専用です。

`ready`は接続条件と今回指定した検証の結果です。`verified`の範囲は対象タスクの初回観測で、履歴全体、送信、画面表示、承認往復は保証しません。未検証の機能は`unverified_features`に明示します。例えば、従来の履歴形式を読み取った場合の結果は次の形です（主要項目のみ）。

```json
{"ready":true,"connection":{"status":"connected"},"compatibility":{"status":"verified","scope":"target-observation","thread_id":"aaaaaaaa-aaaa-4aaa-8aaa-000000000001","api_checks":{"initialize":"verified","thread/loaded/list":"verified","thread/read":"verified","thread/turns/list":"unverified","thread/items/list":"unverified"},"unverified_features":["steering","desktop_ui","approval_roundtrip"]},"failure":null}
```

`threads list`は`--desktop-only`を外すとDesktop以外のローカルタスクも含みます。`--limit`は1〜500件、既定は20件です。タスクや各種記録の保存先は`CODEX_HOME`に従い、未指定時は`~/.codex`を使います。

#### メッセージ送信・ステアリング

```bash
# 実行中タスクへ追加入力
codex-steer send <thread-id> "今の要件に必要な変更へ絞ってください" --json

# sendを省略した短縮形
codex-steer <thread-id> "今の要件に必要な変更へ絞ってください"

# 停止中・未ロードのタスクを再開
codex-steer send <thread-id> "続きをお願いします" --new-turn --json

# 送信せずプレビュー
codex-steer send <thread-id> "メッセージ" --dry-run --json

# 観測した内容と根拠を付けて送信
codex-steer send <thread-id> "追加の抽象化を見直してください" --source claude-code --kind suggestion --evidence <file-or-url> --based-on <cursor> --json

# 標準入力から送信
printf '%s\n' '問題点' '具体的な修正方針' | codex-steer send <thread-id> -

# 本文にオプション名を含める場合
codex-steer send <thread-id> -- '--new-turn の処理を確認してください'
```

| オプション | 用途 |
| --- | --- |
| `--new-turn` | 停止中のタスクを再開。実行中は拒否します。 |
| `--dry-run` | 接続・送信せず、送信内容をプレビュー。 |
| `--no-sound` | 今回の送信を消音。既定は受付成功時に「プルッ」の通知音。 |
| `--sound` | 音ありを明示する互換オプション。`app-server`方式専用。`--no-sound`と併用不可。 |
| `--backend app-server\|ui` | 送信方式。既定は`app-server`。 |
| `--source <name>` | 送信者名。例: `claude-code`。 |
| `--kind <kind>` | `decision`（ユーザー決定の伝達）、`review`、`hypothesis`、`suggestion`。 |
| `--evidence <file-or-url>` | 根拠となるファイルやURL。複数指定可能。 |
| `--based-on <cursor>` | 観測後に新しいユーザー入力やターン変更があれば送信を停止。読み残しのないcursorを使います。 |
| `--supersedes <message-id>` | 以前の指示を新しい内容に置き換え。 |
| `--expires-at <timestamp>` | 指示の有効期限。時差付きの未来のISO日時を指定。 |
| `--checkpoint <checkpoint-id>` | 指定したチェックポイントを送信直前に照合。無効なら送信を停止。 |
| `--keep-focus` | UI方式で、送信後もDesktopを前面に維持。 |
| `--wait-ms <milliseconds>` | UI方式の画面待機時間。既定は1500ms。 |

`--source`から`--checkpoint`までの指示メタデータは`app-server`方式で使います。`accepted`は入力の受付を表します。`unknown`の場合は`history check`で確認してから再送を判断してください。

送信音は既定でオンです。同梱の短い3音「プルッ」（約0.30秒、`assets/send-pururu.wav`）を、今回の入力が受け付けられた直後に鳴らします。`--no-sound`・`--dry-run`・受付失敗・受付未確認（UI方式を含む）では鳴りません。CodexやmacOSの通知設定は変更せず、音量・ミュートはMacの出力設定に従います。再生に失敗しても送信成功は維持され、`--json`では`data.sound.played`と鳴らなかった`reason`、通常出力では再生失敗の警告で確認できます。

#### 状態・発言・変更の読み取りと監視

```bash
# 状態・実行中ターン・承認待ちを確認
codex-steer status <thread-id> --json

# 直近の発言・コマンド・ファイル変更を読む
codex-steer read <thread-id> --limit 50 --max-chars 2000 --json

# 前回からの新規・更新項目を、コマンド出力や差分本文も含めて読む
codex-steer read <thread-id> --since <cursor> --include-output --json

# 過去全文の整合性も照合して読む
codex-steer read <thread-id> --full-history --json

# 次の変化まで待つ
codex-steer watch <thread-id> --since <cursor> --until change --timeout-ms 30000 --poll-ms 1000 --json

# タスクの停止、またはユーザー対応待ちまで待つ
codex-steer watch <thread-id> --until idle --timeout-ms 60000 --json
codex-steer watch <thread-id> --until attention --json

# 変化するたびにJSONを1行ずつ出力し続ける
codex-steer watch <thread-id> --stream --since <cursor> --include-output --json
```

| オプション | 対象・用途 |
| --- | --- |
| `--since <cursor>` | `read`・`watch`で前回の続きから取得。 |
| `--limit <n>` | `read`・`watch`で1回に返す項目数。1〜1000、既定50。 |
| `--max-chars <n>` | `read`・`watch`で各テキストの文字数。100〜20000、既定2000。 |
| `--include-output` | `read`・`watch`でコマンド出力・差分本文を表示。 |
| `--full-history` | `status`・`read`・`watch`で過去全文も照合。旧v1 cursorの継続にも使用。 |
| `--until change\|idle\|attention` | `watch`の待機条件。既定は`change`。 |
| `--timeout-ms <n>` | 通常の`watch`の待機上限。0〜60000ms、既定30000ms。 |
| `--poll-ms <n>` | `watch`の確認間隔。250〜10000ms、既定1000ms。 |
| `--stream` | `watch`で停止まで監視を継続。`--until`・`--timeout-ms`とは併用不可。 |

`has_more: true`なら`changed: false`でも返されたcursorで続きを読み、読み終えてから判断・送信してください。`--stream`は初回に現在を基準とし、監視開始を1回通知します。その後は作業差分と接続状態の変化を出力します。開始時の状況も読む場合は先に`read`し、そのcursorを渡します。停止はCtrl-C、Monitorで起動した場合はClaudeに停止を依頼します。

`--stream`のJSONは、`data.type`で次の2種類を区別します。

| `data.type` | 内容 |
|---|---|
| `observation` | 作業差分。従来の`events`・`attention`・`cursor`・`has_more`等を含みます。 |
| `connection` | 接続状態。`state`、`resume_cursor`、`last_observed_at`、`reconnect_attempts`等を含みます。作業差分は含みません。 |

接続状態は`watching`（監視開始）、`reconnecting`（観測不能・復帰待ち）、`recovered`（読み取り復帰）、`needs_review`（履歴の再確認が必要）、`failed`（監視終了）です。平常時の定期通知はありません。

観測に一度成功した後の通信切断・読み取りタイムアウト・一時的なruntime不在は、接続先を再確認し、同じタスクとcursorで再接続します。待機間隔は1→2→4→8→最大10秒、接続・初期化・読み取りを含む復帰待ちは合計60秒までです。復帰後も`has_more`があれば続きを読みます。初回の接続失敗、権限異常、不正な応答、未対応API、無効cursorでは停止します。通常の`watch`には再接続処理はありません。

接続行の`resume_cursor`はCLIの出力完了位置、または初回の基準です。監督AIが内容を読んだ証明にはなりません。watchプロセス自体が終了した場合は、監督側が読了済みcursorを指定して明示的に再開してください。無効cursorを自動で捨てたり、配送が`unknown`の指示を再送したりはしません。

接続状態の通知例です。`<cursor>`は実際の値に置き換わります。

```json
{"ok":true,"command":"watch","data":{"type":"connection","thread_id":"aaaaaaaa-aaaa-4aaa-8aaa-000000000001","state":"reconnecting","resume_cursor":"<cursor>","last_observed_at":"2026-09-12T10:00:00.000Z","observed_at":"2026-09-12T10:00:08.000Z","reconnect_attempts":0,"cause_code":"CONNECTION_FAILED","retry_timeout_ms":60000}}
```

監視の接続・読み取りで停止を伴うエラーは`ok:false`、`data.type:connection`、`data.state:needs_review|failed`、`error.code`と理由を返し、終了コード1です。復帰待ちの上限は`WATCH_RECONNECT_TIMEOUT`、無効cursorは`STALE_CURSOR`です。Ctrl-Cは接続・初期化・復帰待ちの途中でも監視だけを停止します。

#### 指示の一覧・訂正・撤回

```bash
# 現在有効な指示を表示（--allで置換済み・撤回済み・期限切れも表示）
codex-steer instructions list <thread-id> --json
codex-steer instructions list <thread-id> --all --json

# 以前の指示を訂正
codex-steer send <thread-id> "先ほどの指示を訂正します。既存の仕組みを使ってください" --supersedes <message-id> --json

# 有効期限を付けて送信
codex-steer send <thread-id> "この方針で進めてください" --expires-at <timestamp> --json

# 理由を添えて撤回
codex-steer instructions retract <thread-id> <message-id> --reason "前提が変わったため" --json
```

`retract`には`--source`・`--based-on`・`--new-turn`・`--dry-run`も使えます。訂正・撤回は対象タスクへメッセージとして送られ、元の履歴は残ります。有効期限は指示一覧に適用され、進行中の作業を自動停止するものではありません。

#### 配送・対応履歴

```bash
# 送信履歴を表示（--pendingで反映済み・不採用以外に絞る）
codex-steer history list <thread-id> --pending --json

# 特定の送信の詳細と本文を表示
codex-steer history show <thread-id> <message-id> --include-text --json

# 対象タスクの受信履歴と照合（message-idを省略するとまとめて照合）
codex-steer history check <thread-id> <message-id> --json

# 対応状況と根拠を記録
codex-steer history mark <thread-id> <message-id> --status applied --note "指示どおりの変更を確認" --evidence <file-or-url> --by claude-code --json
```

`list`・`show`・`check`は`--include-text`で本文も表示します。`mark --status`は`acknowledged`（確認済み）、`applied`（反映済み）、`dismissed`（不採用）から選び、`--note`を必ず付けます。`applied`には`--evidence`も必要で、複数指定できます。`check`の`stored`は保存の確認、`mark`は記録者による対応状況の申告です。

#### 入力・実行結果・成果物のチェックポイント

```bash
# 入力ファイルを記録し、checkpoint-idを取得
codex-steer checkpoint capture <thread-id> tests --path src --path test --path package.json --path package-lock.json --json

# 記録した入力でコマンドを実行
codex-steer checkpoint run <thread-id> <checkpoint-id> --timeout-ms 60000 --include-output --json -- npm test

# 成功した実行に成果物ファイルを関連付け
codex-steer checkpoint attach <thread-id> <checkpoint-id> --artifact <artifact-file> --json

# 入力・実行結果・成果物の一致を確認
codex-steer checkpoint verify <thread-id> <checkpoint-id> --json

# チェックポイントを一覧表示
codex-steer checkpoint list <thread-id> --json

# 特定のチェックポイントを出力ログも含めて表示
codex-steer checkpoint show <thread-id> <checkpoint-id> --include-output --json
```

`capture --path`はファイル・ディレクトリを複数指定できます。除外するパスは`--exclude`で指定し、コマンドの出力先やキャッシュを入力に含めないでください。`attach --artifact`も複数指定可能です。`run --timeout-ms`は0〜86400000msで、既定の0は無制限です。入力や成果物が変わると`valid: false`になり、`run`・`verify`は終了コード1を返します。

#### 共有リソースの利用調整

```bash
# 利用を予約し、tokenを取得
codex-steer resource acquire screen --owner claude-code --ttl-ms 120000 --thread <thread-id> --reason "画面を確認" --condition "ユーザーが今回の画面利用を許可済み" --json

# 特定リソースの状態を確認
codex-steer resource status screen --json

# リソースを一覧表示
codex-steer resource list --json

# 予約期限を延長
codex-steer resource renew screen --token <token> --ttl-ms 120000 --json

# 予約を解放
codex-steer resource release screen --token <token> --json

# コマンド実行中だけ予約し、終了時に解放
codex-steer resource run project-build --owner claude-code --ttl-ms 600000 --timeout-ms 60000 --include-output --json -- npm test
```

`screen`や`project-build`は利用者が決めるリソース名です。同じ`CODEX_HOME`・同じ名前を使う参加者間で予約を共有します。`acquire`・`run`の`--owner`は必須で、`--thread`・`--reason`・`--condition`で対象タスク・用途・利用条件を記録できます。

`--ttl-ms`は1000〜86400000ms、既定600000msです。`run`は実行中に自動更新し、`--timeout-ms`で実行時間も制限できます（0〜86400000ms、既定0＝無制限）。この予約は参加者間の調整用で、OSの排他ロックや画面利用の許可を与えるものではありません。

#### 画面操作による送信・診断

実行元ターミナルにmacOSのAccessibility許可を与え、`--backend ui`を指定してください。

```bash
# UI方式の利用条件を診断
codex-steer doctor --backend ui --json

# UI方式で送信
codex-steer send <thread-id> "メッセージ" --backend ui

# 画面の待機時間を指定し、送信後もDesktopを前面に維持
codex-steer send <thread-id> "メッセージ" --backend ui --keep-focus --wait-ms 3000

# 対象タスクを開いてAccessibilityの画面構造を診断
codex-steer debug-ui <thread-id> --wait-ms 1500
```

UI方式は画面フォーカスに依存し、サイドチャットが開いている場合の宛先保証はありません。結果の`submitted_unverified`はキー入力の実行を表し、対象タスクへの配送確認ではありません。
