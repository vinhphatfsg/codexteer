# codexteer

普段のCodex Desktopを使いながら、別のAIが進捗を観測し、根拠を伴って実行途中に軌道修正を伝えるためのmacOS用CLIです。ターミナルからの単発送信にも使えます。

## 導入

macOS、Node.js 20以降とnpm、`/Applications/ChatGPT.app`にインストールされたCodex Desktopが必要です。監督役に使うClaude CodeまたはCodex CLIを、PATH上の`claude`または`codex`で起動できる状態にします。

### npxで使う

リポジトリのcloneやグローバルインストールなしで実行できます。npmパッケージ名とCLI名は`codexteer`です。

このブランチはマイナー更新`0.16.0`を準備します。`watch --stream`の通知集約と監督プロンプトの改善に加え、長いタスクへの送信前確認の修正を含みます。公開前に使う場合は「ソースから導入する」の手順で導入してください。変更点は[CHANGELOG](CHANGELOG.md)を参照してください。

```bash
npx -y codexteer --version
```

Codex Desktopでの作業を終えてアプリを終了し、ターミナルから起動します。

```bash
npx -y codexteer desktop start
npx -y codexteer doctor --json
```

`-y`はnpmの取得確認を省略します。通常はバージョン指定なしで使えます。監督開始後は、その時点で保存したCLIを使い続けます。起動側と操作側の製品バージョンは、必要な通信仕様が対応していれば異なっていても使えます。

<details>
<summary>特定のバージョンで実行する場合（任意）</summary>

不具合の切り分けや、同じ版で監督を開始し直したい場合は、パッケージ名に`@バージョン`を付けられます。`0.16.0`の公開後にその版を選ぶ場合は、次のように指定します。

```bash
npx -y codexteer@0.16.0 supervise <thread-id>
```

</details>

### ソースから導入する

こちらの方法ではGitとmakeも必要です。

```bash
git clone https://github.com/vinhphatfsg/codexteer.git
cd codexteer
make install-local
```

`~/.local/bin`をPATHに追加してください。zshの場合は次の行を`~/.zshrc`に追加し、ターミナルを開き直します。

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Codex Desktopでの作業を終えてアプリを終了し、導入したCLIから起動します。

```bash
codexteer desktop start
codexteer doctor --json
```

インストールしたCLIはこのリポジトリへのシンボリックリンクです。リポジトリを移動した場合は`make install-local`を再実行してください。削除する場合は`make uninstall-local`を実行します。

### codex-steerから移行する

旧npmパッケージは`@vinhphatfsg/codex-steer`です。現在は`npx -y codexteer`を使います。ソースから導入している場合は、新しいコードで`make install-local`を実行すると`codexteer`コマンドを導入できます。既存cloneのリモートURLは`https://github.com/vinhphatfsg/codexteer.git`へ更新してください。

保存済みの履歴や起動中Desktopとの接続を引き継ぐため、内部の保存先`CODEX_HOME/codex-steer`と通信・診断用JSONの`codex_steer_*`フィールドは維持しています。保存先を手動で移動する必要はありません。改名前から保存済みコピーを使っている監督も、そのコピーを引き続き使えます。

### Desktopの起動について

どちらの導入方法でも、`desktop start`はDesktopを起動するたびに実行します。すでに起動している場合は、一度終了してから実行してください。通常の起動に戻すには、Desktopを終了し、Dockなどから開き直します。

`desktop start`は実行ファイルと依存を`CODEX_HOME/codex-steer/runtimes/<version>-<sha256>`へ検証して配置し、そのwrapperからDesktopを起動します。元のリポジトリやnpxキャッシュに依存せず、起動後のhelperも同じ保存先を使います。配置済みの版は自動削除・上書きしません。

監督AIが使うCLIの参照先については、次の監督手順を参照してください。MITライセンス、保存先の検証・復旧と公開手順は[配布ドキュメント](docs/distribution.md)にまとめています。

## 使い方

以下の`<thread-id>`は対象のタスクIDに置き換えてください。`codex://threads/...`形式のタスクURLも使えます。
コマンド一覧では`codexteer`と略記します。npxで手動実行する場合は、その部分を`npx -y codexteer`に置き換えてください。

### Claude Code・Codex CLIに監視とステアリングを任せる

上の導入を済ませ、監視したいCodexタスクのIDまたはURLをコピーします。別のターミナルの対象プロジェクトのディレクトリから、導入方法に合う方を実行してください。

```bash
# npxで起動する場合
npx -y codexteer supervise <thread-id>

# ソースから導入した場合
codexteer supervise <thread-id>
```

対象IDを埋め込んだ監督プロンプトでClaudeを[対話起動](https://code.claude.com/docs/en/cli-reference#cli-commands)します。端末の標準入出力をそのまま使い、起動後もClaudeへ追加の指示を入力できます。

Codex CLIを監督役にする場合は、`--agent codex`を指定します。省略時はClaudeです。モデルなどのエージェント側の引数は`--`の後ろへ渡します。

```bash
codexteer supervise <thread-id> --agent codex
npx -y codexteer supervise <thread-id> "テストと差分を確認してください。" --agent codex
codexteer supervise <thread-id> --agent codex -- --model <model>
codexteer supervise prompt <thread-id> --agent codex
```

監督方針を変える場合は、対象IDの後ろにメッセージを一つの引数として渡します。npx経由でも同じ書式です。

```bash
codexteer supervise <thread-id> "セキュリティの問題だけを私へ報告し、Codexへは送信しないでください。"
```

本文は、必須の共通テンプレートと監督方針を組み合わせて生成します。メッセージを省略すると、ユーザーの目的・制約の範囲で必要最小限の介入と結果確認を行い、簡潔に報告する標準方針を使います。指定すると、その標準方針全体を指定文に置き換えます。対象ID、CLIの実行コマンド、`help`・`read`・`watch`の操作、送信時の確認、停止手順はどちらにも含まれます。監視だけを指定した場合は、送信例を介入の許可として扱わないよう指示します。

上書きは今回の生成・起動だけに適用し、次回の既定設定や保存したCLIには書き込みません。改行・空白・プレースホルダーに見える文字も指定文のまま本文に含めます。空文字・空白だけのメッセージはエラーです。呼び出し元のシェルで一つの引数として引用してください。`$`やバッククォートを文字として含めるときは、シェルが展開しない引用方法を使ってください。

両方とも、起動したCLI本体と依存を`CODEX_HOME/codex-steer/runtimes/<version>-<sha256>`へ検証して保存し、そのコピーへの実行コマンドを監督プロンプトに埋め込みます。監督役に渡す切り替えオプションは不要です。npxのキャッシュが新版に更新された場合や、ソース導入先を`git pull`・削除した場合も、開始済みの監督は保存した内容を使い続けます。

実行コマンドには、生成時に検証した`CODEX_HOME`の実体パス、監督ごとの`--supervisor` ID、選択した`--connection`も埋め込みます。先頭の指定とオプションを全て保持してください。貼り付け先の環境変数が未設定・別設定でも、生成元の接続先と履歴を使います。同じPCで使い、監督中は保存したコピーを保持してください。新しいCLIや別のプロファイルに切り替えるときは、その環境から監督を起動し直すか、プロンプトを生成し直します。同じ版・同じ内容のコピーは検証して再利用し、内容が変われば別の保存先を作ります。既存のコピーは自動削除・上書きしません。

Node本体はコピーせず、開始時の実体への絶対パスとNodeバージョンの検査を各コマンドに含めます。元のNodeは保持してください。バージョンが変われば`NODE_VERSION_MISMATCH`で操作を止めます。同じバージョンのNodeの改変や共有ライブラリまで固定するものではありません。保存先やNodeが使えなくなった場合は介入を止め、理由を報告するよう指示します。

起動時にバージョンを指定するかどうかに関係なく、監督用CLIの保存処理は同じです。キャッシュの動作と保存処理の詳細は[配布ドキュメント](docs/distribution.md#監督役が使うcli)を参照してください。

モデルなどClaude側の起動引数は、`--`の後ろへ渡します。

```bash
codexteer supervise <thread-id> -- --model <model> --effort <level>
codexteer supervise <thread-id> "テスト失敗を優先して監督してください。" -- --model <model>
```

同じPCで既にClaudeを起動している場合は、監督役（オーケストレーター）向けのプロンプトを出力し、そのセッションに貼り付けても使えます。

```bash
# npxで本文を生成する場合
npx -y codexteer supervise prompt <thread-id>

# ソースから導入した場合
codexteer supervise prompt <thread-id>

# 同じ監督方針で本文だけを生成する場合
codexteer supervise prompt <thread-id> "セキュリティの問題だけを私へ報告し、Codexへは送信しないでください。"
```

直接起動と本文だけの出力は、同じ保存・検証・生成処理を使います。生成するたびに監督IDは変わります。`--json`は`data.supervisor`に`session_id`・`owner`・`connection`も返します。`supervise prompt`もCLI一式を保存してから本文を出力します。共通テンプレートの操作手順は`codexteer help monitor`と同じで、ヘルプを読んでも上書き前の標準方針は追加されません。生成プロンプト中の`doctor`・`read`・`watch`・`send`等の例には同じ実行コマンドを使います。監督役には、ヘルプ中の`codexteer`表記も指定された実行コマンドに置き換えるよう指示します。

1. 接続を診断し、対象タスクの最新の依頼・制約・進捗、有効な指示と対応待ちの履歴を確認する。
2. 差分を読み切ったcursorから観測を続ける。[Monitorツール](https://code.claude.com/docs/en/tools-reference#monitor-tool)が使えれば`watch --stream`、使えなければ短い`watch`を繰り返す。接続状態の通知を読み、復帰待ちの間は介入を控える。
3. 選択した監督方針に従って観測する。方針で送信が許され、介入する場合は`help send`を確認し、最新の差分を読み切り、安定したkeyで`findings create`を行ってから`send --finding <id> --based-on <cursor>`を使う。同じ指摘が対応中なら結果を待つ。
4. 送信したmessage_idを保持し、受付・対応報告・検証結果を区別して追う。`unknown`は`history check`で照合し、自動再送しない。
5. 選択した監督方針に従って報告する。停止指示を受けたら、自分のMonitor/watchと追加送信を止める。

標準方針は、ユーザーの最新の目的・制約の範囲内で監督と介入を委任します。その範囲の介入に毎回の確認は不要です。上書き時の観測の観点・介入の判断基準・報告方法は指定文に従います。どちらの場合も、目的・制約が不明な場合や要件自体を変える必要がある場合は確認します。監督の委任だけで停止中タスクを再開したり、承認・質問へ代理回答したりはしません。単発送信では、ユーザーが指定した宛先・内容を使います。

停止するときは、次の`supervise stop`を実行できます。監督エージェントのプロセス自体も終了する場合は、そのセッションへ「監視とステアリングを停止して」と伝えてください。Codexの作業自体は継続します。監督はCLIとOSの既存の権限設定に従います。

IDのコピーを省く場合は、Claudeに`codexteer threads list --desktop-only --json`で候補を表示してもらい、対象を選ぶこともできます。同じプロジェクトに複数のタスクがある場合、Claudeの起動場所だけでは監視対象を特定できません。

### 監督状態の確認・一時停止・停止

ユーザーの端末から、生成元と同じ`CODEX_HOME`で実行します。

```bash
codexteer supervise status <thread-id> --json
codexteer supervise list --json
codexteer supervise pause <thread-id>
codexteer supervise resume <thread-id>
codexteer supervise stop <thread-id>
```

| 操作・状態 | 動作 |
|---|---|
| `active` | 登録済み。CLIで観測した時刻・接続状態を別に確認する |
| `pause` / `paused` | 監督ID付きの送信を止め、観測は続ける |
| `resume` | 同じ監督の介入を再開する |
| `stop` / `stopped` | その監督の以後の観測・送信を拒否する。Codexタスクは止めない |

`status`は所有者、最後のCLI観測と経過時間、接続状態、最後の配送、未解決の指摘を返します。`active`や観測時刻だけでAIの読了・継続監視を証明するものではありません。直接起動ではlauncherの生存確認も表示し、コピーした本文では`launcher_alive: null`です。

直接起動はエージェントを起動する前に登録し、終了時に停止を記録します。本文だけの生成では未登録で、貼り付け先が本文中の`supervise register`を実行して開始します。一つのタスクに一つの監督を登録でき、競合は`SUPERVISOR_CONFLICT`になります。異常終了などで残った登録は、`status`で確認して明示的に`stop`してから開始し直してください。停止済みIDや古い本文で再開はできません。同じ本文の再登録で一時停止が解除されることもありません。

送信中の`pause`/`stop`は`RECORD_BUSY`で失敗します。配送結果を確認して制御を再実行し、成功するまでは停止したと扱わないでください。監督役が自分で`resume`したり、生成コマンドから`--supervisor`を外して回避したりしないよう、必須テンプレートにも指示します。

この制御は新しい監督ID付きコマンドに適用します。以前の版で開始した監督、IDなしの手動送信、同じOSユーザーが実行する任意のコードを隔離する機能ではありません。監督IDは秘密情報ではなく、古いセッションや操作の競合を検出する識別子です。

### 指摘・解決条件・介入の評価を追う

```bash
codexteer findings create <thread-id> --key timeout --title "待機の終了条件" --condition "指定時間で終了する回帰テストが通る" --evidence src/monitor.mjs --based-on <cursor> --json
codexteer findings list <thread-id> --json
codexteer findings show <thread-id> <finding-id> --json
codexteer send <thread-id> "終了条件を確認してください" --finding <finding-id> --based-on <cursor> --json
codexteer findings resolve <thread-id> <finding-id> --checkpoint <checkpoint-id> --note "指定時間で終了することをテストで確認" --json
codexteer findings evaluate <thread-id> <finding-id> --rating useful --reason "対象の不具合を再現して修正できた" --json
codexteer findings stats <thread-id> --json
```

監督役は各行の`codexteer`を生成された実行コマンドへ置き換えます。監督ID付きの送信では`--finding`と`--based-on`が必須です（`instructions retract`はfinding不要）。通常の手動送信には追加オプションを要求しません。

同じタスクの同じ`key`は既存IDを再利用します。そのrevisionに受付済み・受付不明の送信があれば、本文が違っていても`DUPLICATE_INTERVENTION`で拒否します。明確な`not_sent`だけは再試行でき、プレビューは予約しません。意味の似た別keyを自動検出する機能ではないため、同じ指摘に新しいkeyを作らないでください。

新しい根拠や要件があれば`findings reopen`を使います。根拠または解決条件の変更と理由が必要で、cursorが進んだだけでは再介入できません。ユーザーの新たな要件は解決条件へ反映します。受付不明の送信は先に`history check`で確認し、`not_observed`だけで未配送と決めつけません。

```bash
codexteer findings reopen <thread-id> <finding-id> --condition "時間切れとキャンセルの両方で終了する" --reason "ユーザーがキャンセル対応を追加した" --based-on <cursor> --json
codexteer findings dismiss <thread-id> <finding-id> --reason "既存の実装が条件を満たしていた" --json
```

配送、対応申告、解決判断は別に記録します。`history mark --status applied`の後も指摘は`awaiting_verification`です。解決には現在有効なcheckpointと、条件を満たしたと判断した根拠が必要です。解決時のrun IDと入力ハッシュを記録し、入力・最新run・成果物が変わると`needs_review`として未解決一覧に戻します。テストの成功だけで指摘の妥当性や設計の正しさを自動認定しません。

評価は`useful`（有益）・`unnecessary`（不要）・`incorrect`（誤り）、未評価は`unrated`です。`stats`は現在のrevisionを1件として未送信候補も含め、評価済み件数と未評価件数を分けます。`useful_fraction`の母数は評価済み件数で、0件なら`null`です。介入の因果効果を証明する数値ではありません。詳細は`help findings`を参照してください。

### 通常起動したDesktopを再起動せずに観測する

Desktopが共有ローカルdaemonを使っていて、`CODEX_HOME/app-server-control/app-server-control.sock`が存在する環境では、観測専用の直接接続を選べます。

```bash
codexteer --connection desktop doctor --thread <thread-id> --json
codexteer --connection desktop read <thread-id> --include-output --json
codexteer --connection desktop watch <thread-id> --stream --json
codexteer supervise <thread-id> --agent codex --connection desktop
```

既定の`--connection shared`は従来の`desktop start`で用意するwrapperです。`desktop`を選ぶと、既存ソケットの所有者・権限・同一性と、対象がロード済みであることを確認します。ソケットがなければ`DESKTOP_CONNECTION_UNAVAILABLE`、対象が未ロードなら`DESKTOP_THREAD_NOT_LOADED`で止まります。通常起動なら必ず使えるわけではありません。daemonの起動・再起動、設定変更、暗黙のタスク再開、別runtimeへの自動切り替えは行いません。

直接接続で使えるのは観測です。送信・新規ターン・撤回送信・UI送信は`DESKTOP_READ_ONLY`で拒否します。送信は既存のshared方式を明示して使ってください。生成する監督プロンプトも接続方式を保持し、desktopでは観測専用の手順を使います。`doctor`は読み取り成功から送信・画面表示・承認継続の対応を推測しません。

詳細は`help connection`を参照してください。今回の開発環境にはこのソケットがなく、実Desktopへの直接接続は未検証です。読み取り・エンドポイント検査・送信拒否は隔離したUnixソケットの模擬サーバーで検証しています。同梱Codex CLI 0.153.4を一時プロファイルとローカルの偽モデルで動かし、実際のUnix接続から合成履歴を読む検証も通過しました（`npm run test:connection`）。実Desktopの画面表示・承認継続の確認とは区別しています。

### タスクを探して送信する

```bash
# 最近のタスクを表示
codexteer threads list --desktop-only --limit 20 --json

# 実行中のタスクに追加入力（受付成功時に「プルッ」の通知音）
codexteer send <thread-id> "失敗したテストの原因を先に確認してください"

# 今回だけ通知音を鳴らさずに送信
codexteer send <thread-id> "失敗したテストの原因を先に確認してください" --no-sound

# 停止中のタスクを再開
codexteer send <thread-id> "続きをお願いします" --new-turn

# 送信内容をプレビュー
codexteer send <thread-id> "メッセージ" --dry-run --json

# 複数行を標準入力から送信
printf '%s\n' '1. 原因を調査' '2. 結果を説明' | codexteer send <thread-id> -
```

標準の送信方式は`app-server`です。`--json`を付けると結果をJSONで返します。`delivery_status: unknown`の場合は、`codexteer history check <thread-id> --json`で受付状況を確認してから再送を判断してください。

### 状態と進捗を読む

```bash
codexteer status <thread-id> --json
codexteer read <thread-id> --json
codexteer read <thread-id> --since <cursor> --include-output --json
codexteer watch <thread-id> --until idle --timeout-ms 60000 --json
```

`read`は直近50件を返します。返された`data.cursor`を次回の`--since`に渡すと、新規・更新項目を取得できます。`data.has_more: true`の場合は、返されたcursorで続きを読んでください。

変化するたびに1行のJSONを受け取るには、次のコマンドを使います。Ctrl-Cで停止します。

```bash
codexteer watch <thread-id> --stream --json
```

### 詳細な使い方

以下は用途別のコマンド一覧です。`<...>`は実際の値に置き換えてください。`<cursor>`は`read`・`status`・`watch`の結果、`<message-id>`は`send`・`history list`、`<checkpoint-id>`は`checkpoint capture`・`checkpoint list`、`<token>`は`resource acquire`の結果から取得します。

対話起動の`supervise <thread-id> [MESSAGE]`を除き、各コマンドに`--json`を付けるとJSONで結果を返します。`supervise prompt`もJSONに対応します。別コマンドを実行する`run`や監督役の起動では、codexteer側のオプションを区切りの`--`より前に置いてください。

#### ヘルプ・バージョン

```bash
# 全体の使い方
codexteer help

# コマンド別の使い方（sendをread、watch、historyなどに置き換え）
codexteer help send
codexteer send --help
codexteer help send --json

# Claude CodeのMonitorとの連携
codexteer help monitor

# バージョン
codexteer --version
```

引数なしの`codexteer`と`codexteer --help`でも全体のヘルプを表示します。

#### 監督役の起動

```bash
codexteer supervise <thread-id>
codexteer supervise <thread-id> "監督方針を指定するメッセージ"
codexteer supervise <thread-id> "監督方針を指定するメッセージ" --agent claude -- --model <model> --effort <level>
codexteer supervise <thread-id> "監督方針を指定するメッセージ" --agent codex -- --model <model>
codexteer help supervise
```

`--agent`の対応値は`claude`と`codex`です。省略すると`claude`を使います。選択したエージェントのPATH上の実行ファイルを、現在の作業ディレクトリ・環境変数・標準入力・標準出力・標準エラーを引き継いで起動します。シェルのaliasやfunctionは使いません。

最初の`--`以降は対象エージェントの引数です。上書きメッセージはその前に置きます。順序・空文字・空白・改行を保ち、codexteer側では解釈もシェルでの再展開もしません。例えば区切り後の`--help`・`--version`・`--json`も選択したエージェントへ渡します。呼び出し元のシェルで必要な引用は付けてください。

追加引数の後ろには、エージェント側の区切り`--`と、`supervise prompt`と同じ生成処理による監督プロンプトを一つの引数として付加します。追加引数の意味や組み合わせの妥当性は選択したエージェントが判断します。

不正なID形式、空のメッセージ、`--agent`の値不足・未対応値、区切り前の未知・過剰な引数では起動しません。選択したエージェントが未導入・実行不可などの起動失敗は標準エラーに理由を表示し、終了コード1です。Desktopの接続と対象タスクの存在は、起動した監督役が最初に確認します。

通常終了では選択したエージェントの終了コードを返します。`SIGINT`・`SIGTERM`・`SIGHUP`は起動したエージェントへ転送し、シグナル終了時は`128 + シグナル番号`を返します。対話出力を引き継ぐため、この起動形式では`--json`は非対応です。ヘルプは`help supervise --json`、本文だけの取得は`supervise prompt <thread-id> --json`を使ってください。

#### 監督役（オーケストレーター）向けのプロンプトを取得

```bash
# 監督役へ渡す、対象タスク入りの本文を標準出力へ出力
codexteer supervise prompt <thread-id>

# タスクURLからも生成可能
codexteer supervise prompt codex://threads/<thread-id>

# 標準の監督方針を置き換えて本文を生成
codexteer supervise prompt <thread-id> "監督方針を指定するメッセージ"

# JSONで対象IDと本文を取得
codexteer supervise prompt <thread-id> --json

# このコマンドのヘルプ
codexteer help supervise prompt
```

`supervise prompt`は、ClaudeやCodexなどの監督役（オーケストレーター）へ渡す初期プロンプトを生成します。対象IDと引数を検証し、CLI一式を内容ハッシュ別の保存先へ配置・検証してから、正規化したIDと保存先を本文へ埋め込みます。保存・検証に失敗した場合は本文を出力せず、直接起動の場合も監督エージェントを起動しません。Desktopの起動・接続、履歴取得、送信、監督エージェントの起動は行いません。タスクの存在と接続は監督開始時に確認します。本文には観測・根拠付き介入・結果確認・停止までの手順を含みます。

各コマンドは開始時のNodeと保存したCLIの絶対パスを使うため、本文を貼り付ける先のPATHに`codexteer`がなくても実行できます。先頭の`CODEX_HOME='…'`で生成元のプロファイルを指定します。相対パスやシンボリックリンクで指定していたホームも、検証した実体への絶対パスを使います。空白や引用符を含むパスはシェル引数として引用します。本文に埋め込むパスに改行等の制御文字があれば、本文を出力する前に`SUPERVISION_PATH_UNSAFE`で拒否します。`CODEX_HOME`指定・引用・`--require-node-version`を含め、実行コマンドをそのまま使ってください。別のPCや別のプロファイルを監督する場合は、そこで本文を生成し直してください。

通常出力は末尾改行付きの本文のみです。`--json`では既存CLIと同じ形式で返します。

```json
{
  "ok": true,
  "command": "supervise.prompt",
  "data": {
    "thread_id": "01a04373-3770-71e0-a2e3-a3c196f5f5b1",
    "prompt": "対象IDと保存したCLIの実行コマンドを含む監督プロンプト本文…",
    "deployment": {
      "codex_home": "/Users/me/.codex",
      "directory": "/Users/me/.codex/codex-steer/runtimes/0.16.0-<sha256>",
      "wrapper_path": "/Users/me/.codex/codex-steer/runtimes/0.16.0-<sha256>/bin/codexteer-wrapper.mjs",
      "version": "0.16.0",
      "sha256": "<sha256>",
      "reused": false
    },
    "node": { "path": "/absolute/path/to/node", "version": "v25.1.0" }
  }
}
```

IDが不正な場合、引数が不足・過剰な場合、メッセージが空文字・空白だけの場合は終了コード1です。通常は標準エラーへ理由を出し、本文は出力しません。`--json`では標準出力に`{"ok":false,"error":{"message":"理由"}}`を返します。空のメッセージでは`error.code`に`INVALID_SUPERVISION_POLICY`も返します。起動に使う本文の生成には`--json`を付けないでください。

Codex CLIでも、`steer_prompt=$(codexteer supervise prompt <thread-id>) && codex "$steer_prompt"`のように初期プロンプトを渡せます。生成プロンプトには、Monitorが使えない場合の短い`watch`による手順と、監督AI自身の送信元名を使う案内を含みます。

#### Desktopの起動・診断・タスク選択

```bash
# 共有接続を有効にしてDesktopを起動（--dry-runで起動せずプレビュー）
codexteer desktop start
codexteer desktop start --dry-run --json

# 接続と起動条件を診断
codexteer doctor --json

# 指定タスクの観測APIも検証
codexteer doctor --thread <thread-id> --json

# 最近のタスクを一覧表示
codexteer threads list --desktop-only --limit 20 --json

# タスクURLをIDに変換
codexteer thread resolve codex://threads/<thread-id> --json

# 対象タスクをDesktopの画面で開く
codexteer open <thread-id>
```

`doctor`はDesktop・同梱CLI・実行中のwrapper Node・手元のCLIを動かすNodeのバージョンと、`connection.status`、`compatibility.api_checks`、`failure`を返します。対象未指定では接続だけを診断するため、観測の互換性は`unverified`です。

`codex_steer_compatibility`は操作側と実行中wrapperの製品名・バージョンの比較で、診断情報です。版の不明・不一致だけではコマンドを止めません。`runtime_compatibility`で通信仕様と操作ごとの対応状況を返し、必要な仕様が合う組み合わせはそのまま使えます。インストール済み同梱CLIと実行中CLIの版の差も`cli_version_status`に分けて表示します。

例えば新規ターンの仕様だけが非互換なら、`send --new-turn`だけが`CAPABILITY_UNSUPPORTED`で止まり、`read`・`watch`・通常の`send`は使えます。新規ターン用のソケットがない場合も同様です。共通の通信仕様が非互換なら、接続を必要とする操作は`RUNTIME_PROTOCOL_UNSUPPORTED`で止まります。`help`・`supervise prompt`・ローカル履歴一覧・`--dry-run`は接続不要です。

旧wrapperにも対応します。既知のv1仕様は対応表で判断し、仕様不明の環境でも読み取りだけで観測を検証できます。送信仕様が確認できない環境の送信は`CAPABILITY_UNVERIFIED`または`RUNTIME_PROTOCOL_UNVERIFIED`で止め、互換性の確認目的では送信・タスク再開をしません。対応表、各機能の仕様とエラーは[配布ドキュメント](docs/distribution.md#互換性契約)を参照してください。

`doctor --thread`は指定タスクの読み取り経路を検証し、成功すれば`compatibility.status: verified`を返します。呼び出していないAPIは`unverified`、メソッド未対応は`unsupported`、応答異常等は`failed`です。通信が途切れて検証を完了できなければ`unverified`のまま理由を返します。本文は診断出力に含めず、タスクの再開・送信・承認回答は行いません。`--thread`は`app-server`専用です。

`ready`は接続条件と今回指定した検証の結果です。新規ターンだけが使えなくても、観測に成功すれば`ready: true`になります。操作別の仕様対応は`runtime_compatibility.operations`、新規ターン用ソケットの状態は`desktop_subscription`を確認してください。`supported`は仕様上の対応、`verified`は実際に行った観測の検証で、履歴全体、送信、画面表示、承認往復は保証しません。未検証の機能は`unverified_features`に明示します。例えば、従来の履歴形式を読み取った場合の結果は次の形です（主要項目のみ）。

```json
{"ready":true,"connection":{"status":"connected"},"compatibility":{"status":"verified","scope":"target-observation","thread_id":"01a04373-3770-71e0-a2e3-a3c196f5f5b1","api_checks":{"initialize":"verified","thread/loaded/list":"verified","thread/read":"verified","thread/turns/list":"unverified","thread/items/list":"unverified"},"unverified_features":["steering","desktop_ui","approval_roundtrip"]},"failure":null}
```

`threads list`は`--desktop-only`を外すとDesktop以外のローカルタスクも含みます。`--limit`は1〜500件、既定は20件です。タスクや各種記録の保存先は`CODEX_HOME`に従い、未指定時は`~/.codex`を使います。

#### メッセージ送信・ステアリング

```bash
# 実行中タスクへ追加入力
codexteer send <thread-id> "今の要件に必要な変更へ絞ってください" --json

# sendを省略した短縮形
codexteer <thread-id> "今の要件に必要な変更へ絞ってください"

# 停止中・未ロードのタスクを再開
codexteer send <thread-id> "続きをお願いします" --new-turn --json

# 送信せずプレビュー
codexteer send <thread-id> "メッセージ" --dry-run --json

# 観測した内容と根拠を付けて送信
codexteer send <thread-id> "追加の抽象化を見直してください" --source claude-code --kind suggestion --evidence <file-or-url> --based-on <cursor> --json

# 標準入力から送信
printf '%s\n' '問題点' '具体的な修正方針' | codexteer send <thread-id> -

# 本文にオプション名を含める場合
codexteer send <thread-id> -- '--new-turn の処理を確認してください'
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

ページ履歴対応のタスクでは、送信前の状態確認も本文を含まない分割取得を使います。受信上限の64 MiBを超えた場合は`PAYLOAD_TOO_LARGE`で停止します。旧形式の履歴やv1の`--based-on`確認では全履歴の取得が必要です。修正前の保存済みCLIを使う監督には更新が自動適用されないため、更新したCLIで監督を起動し直すか、プロンプトを生成し直してください。

送信音は既定でオンです。同梱の短い3音「プルッ」（約0.30秒、`assets/send-pururu.wav`）を、今回の入力が受け付けられた直後に鳴らします。`--no-sound`・`--dry-run`・受付失敗・受付未確認（UI方式を含む）では鳴りません。CodexやmacOSの通知設定は変更せず、音量・ミュートはMacの出力設定に従います。再生に失敗しても送信成功は維持され、`--json`では`data.sound.played`と鳴らなかった`reason`、通常出力では再生失敗の警告で確認できます。

#### 状態・発言・変更の読み取りと監視

```bash
# 状態・実行中ターン・承認待ちを確認
codexteer status <thread-id> --json

# 直近の発言・コマンド・ファイル変更を読む
codexteer read <thread-id> --limit 50 --max-chars 2000 --json

# 前回からの新規・更新項目を、コマンド出力や差分本文も含めて読む
codexteer read <thread-id> --since <cursor> --include-output --json

# 過去全文の整合性も照合して読む
codexteer read <thread-id> --full-history --json

# 次の変化まで待つ
codexteer watch <thread-id> --since <cursor> --until change --timeout-ms 30000 --poll-ms 1000 --json

# タスクの停止、またはユーザー対応待ちまで待つ
codexteer watch <thread-id> --until idle --timeout-ms 60000 --json
codexteer watch <thread-id> --until attention --json

# 変化するたびにJSONを1行ずつ出力し続ける
codexteer watch <thread-id> --stream --since <cursor> --include-output --json
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
| `--notify digest\|all` | `watch --stream`の通知方法。既定は`digest`。`all`は変化ごとに即時出力。 |
| `--settle-ms <n>` | digestで最後の通常イベントから待つ時間。1000〜120000ms、既定20000ms。 |
| `--max-hold-ms <n>` | digestの最も古い保留イベントの待ち時間。10000〜1800000ms、既定600000ms。 |

`has_more: true`なら`changed: false`でも返されたcursorで続きを読み、読み終えてから判断・送信してください。`--stream`は初回に現在を基準とし、監視開始を1回通知します。その後は作業差分と接続状態の変化を出力します。開始時の状況も読む場合は先に`read`し、そのcursorを渡します。停止はCtrl-C、Monitorで起動した場合はClaudeに停止を依頼します。

0.16.0の`watch --stream`は、通常の進捗を最後の通常イベントから20秒後、読み取り専用コマンドなどを最長10分まで保留してまとめます。ユーザー入力、ターン、質問、注意状態、読み取り専用以外の失敗は即時通知します。連続した通常イベントもmax-holdで排出し、実行中コマンドの出力だけの更新ではsettleを延長しません。ポーリングと読み取り処理による遅れはあり得ます。従来の即時出力には`--notify all`を指定してください。単発watchと保存済みCLIの動作は変わりません。

`digest`には出力理由、保留時間、分類別件数、保留開始前の`from_cursor`が入ります。`compacted: true`のイベントは詳細出力を省略しています。必要なら`read --since <from_cursor> --include-output`で読み直してください。通常は全ページを読み切ってから通知し、ページ途中の切断・終了時だけ`has_more: true`を保持して取得済み分を出力します。200件／64KBはページ読了後の排出目安です。接続行のcursorは読了の証明にはなりません。

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
{"ok":true,"command":"watch","data":{"type":"connection","thread_id":"01a04373-3770-71e0-a2e3-a3c196f5f5b1","state":"reconnecting","resume_cursor":"<cursor>","last_observed_at":"2026-09-12T10:00:00.000Z","observed_at":"2026-09-12T10:00:08.000Z","reconnect_attempts":0,"cause_code":"CONNECTION_FAILED","retry_timeout_ms":60000}}
```

監視の接続・読み取りで停止を伴うエラーは`ok:false`、`data.type:connection`、`data.state:needs_review|failed`、`error.code`と理由を返し、終了コード1です。復帰待ちの上限は`WATCH_RECONNECT_TIMEOUT`、無効cursorは`STALE_CURSOR`です。Ctrl-Cは接続・初期化・復帰待ちの途中でも監視だけを停止します。

#### 指示の一覧・訂正・撤回

```bash
# 現在有効な指示を表示（--allで置換済み・撤回済み・期限切れも表示）
codexteer instructions list <thread-id> --json
codexteer instructions list <thread-id> --all --json

# 以前の指示を訂正
codexteer send <thread-id> "先ほどの指示を訂正します。既存の仕組みを使ってください" --supersedes <message-id> --json

# 有効期限を付けて送信
codexteer send <thread-id> "この方針で進めてください" --expires-at <timestamp> --json

# 理由を添えて撤回
codexteer instructions retract <thread-id> <message-id> --reason "前提が変わったため" --json
```

`retract`には`--source`・`--based-on`・`--new-turn`・`--dry-run`も使えます。訂正・撤回は対象タスクへメッセージとして送られ、元の履歴は残ります。有効期限は指示一覧に適用され、進行中の作業を自動停止するものではありません。

#### 配送・対応履歴

```bash
# 送信履歴を表示（--pendingで反映済み・不採用以外に絞る）
codexteer history list <thread-id> --pending --json

# 特定の送信の詳細と本文を表示
codexteer history show <thread-id> <message-id> --include-text --json

# 対象タスクの受信履歴と照合（message-idを省略するとまとめて照合）
codexteer history check <thread-id> <message-id> --json

# 対応状況と根拠を記録
codexteer history mark <thread-id> <message-id> --status applied --note "指示どおりの変更を確認" --evidence <file-or-url> --by claude-code --json
```

`list`・`show`・`check`は`--include-text`で本文も表示します。`mark --status`は`acknowledged`（確認済み）、`applied`（反映済み）、`dismissed`（不採用）から選び、`--note`を必ず付けます。`applied`には`--evidence`も必要で、複数指定できます。`check`の`stored`は保存の確認、`mark`は記録者による対応状況の申告です。

#### 入力・実行結果・成果物のチェックポイント

```bash
# 入力ファイルを記録し、checkpoint-idを取得
codexteer checkpoint capture <thread-id> tests --path src --path test --path package.json --path package-lock.json --json

# 記録した入力でコマンドを実行
codexteer checkpoint run <thread-id> <checkpoint-id> --timeout-ms 60000 --include-output --json -- npm test

# 成功した実行に成果物ファイルを関連付け
codexteer checkpoint attach <thread-id> <checkpoint-id> --artifact <artifact-file> --json

# 入力・実行結果・成果物の一致を確認
codexteer checkpoint verify <thread-id> <checkpoint-id> --json

# チェックポイントを一覧表示
codexteer checkpoint list <thread-id> --json

# 特定のチェックポイントを出力ログも含めて表示
codexteer checkpoint show <thread-id> <checkpoint-id> --include-output --json
```

`capture --path`はファイル・ディレクトリを複数指定できます。除外するパスは`--exclude`で指定し、コマンドの出力先やキャッシュを入力に含めないでください。`attach --artifact`も複数指定可能です。`run --timeout-ms`は0〜86400000msで、既定の0は無制限です。入力や成果物が変わると`valid: false`になり、`run`・`verify`は終了コード1を返します。

#### 共有リソースの利用調整

```bash
# 利用を予約し、tokenを取得
codexteer resource acquire screen --owner claude-code --ttl-ms 120000 --thread <thread-id> --reason "画面を確認" --condition "ユーザーが今回の画面利用を許可済み" --json

# 特定リソースの状態を確認
codexteer resource status screen --json

# リソースを一覧表示
codexteer resource list --json

# 予約期限を延長
codexteer resource renew screen --token <token> --ttl-ms 120000 --json

# 予約を解放
codexteer resource release screen --token <token> --json

# コマンド実行中だけ予約し、終了時に解放
codexteer resource run project-build --owner claude-code --ttl-ms 600000 --timeout-ms 60000 --include-output --json -- npm test
```

`screen`や`project-build`は利用者が決めるリソース名です。同じ`CODEX_HOME`・同じ名前を使う参加者間で予約を共有します。`acquire`・`run`の`--owner`は必須で、`--thread`・`--reason`・`--condition`で対象タスク・用途・利用条件を記録できます。

`--ttl-ms`は1000〜86400000ms、既定600000msです。`run`は実行中に自動更新し、`--timeout-ms`で実行時間も制限できます（0〜86400000ms、既定0＝無制限）。この予約は参加者間の調整用で、OSの排他ロックや画面利用の許可を与えるものではありません。

#### 画面操作による送信・診断

実行元ターミナルにmacOSのAccessibility許可を与え、`--backend ui`を指定してください。

```bash
# UI方式の利用条件を診断
codexteer doctor --backend ui --json

# UI方式で送信
codexteer send <thread-id> "メッセージ" --backend ui

# 画面の待機時間を指定し、送信後もDesktopを前面に維持
codexteer send <thread-id> "メッセージ" --backend ui --keep-focus --wait-ms 3000

# 対象タスクを開いてAccessibilityの画面構造を診断
codexteer debug-ui <thread-id> --wait-ms 1500
```

UI方式は画面フォーカスに依存し、サイドチャットが開いている場合の宛先保証はありません。結果の`submitted_unverified`はキー入力の実行を表し、対象タスクへの配送確認ではありません。
