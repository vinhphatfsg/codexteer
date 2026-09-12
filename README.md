# codex-steer

ローカルのCodex Desktopタスクへ、ターミナルからメッセージを送信し、進捗を読み取るmacOS用CLIです。

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

インストール先はこのリポジトリへのシンボリックリンクです。リポジトリを移動した場合は`make install-local`を再実行してください。削除する場合は`make uninstall-local`を実行します。

## 使い方

以下の`<thread-id>`は対象のタスクIDに置き換えてください。`codex://threads/...`形式のタスクURLも使えます。

### Claude CodeにCodexの監視とステアリングを任せる

上の導入を済ませ、[Monitorツール](https://code.claude.com/docs/en/tools-reference#monitor-tool)が使えるClaude Codeを用意してください。

1. Codexで監視したいタスクのIDまたはURLをコピーします。
2. 別のターミナルで`claude`を起動します。
3. 次のプロンプトの`<thread-id>`を置き換えて入力します。

```text
codex-steerで次のCodexタスクを監視し、作業中のCodexへ軌道修正を直接伝えるオーケストレーター役をしてください。
対象: <thread-id>

まず codex-steer help monitor と codex-steer help send を読み、readでユーザーの依頼・制約と現在の進捗を確認してください。
読み終えたcursorを引き継いで watch --stream --since をMonitorツールで実行してください。

次の観点で監視してください。
- 今の要件に不要な抽象化・汎用化・仕組みを増やし、過剰設計になっていないか。
- 本来解くべき問題から外れて、周辺機能や無関係な改善に作業を広げていないか。
- 要件を満たす、より小さく単純な変更で目的を達成できないか。

軌道修正が必要なら、作業の完了を待たずに最新の差分をreadで読み切り、
そのcursorを使って次の形式でステアリングメッセージを送ってください。
codex-steer send <thread-id> "<根拠と具体的な軌道修正指示>" --source claude-code --based-on <cursor> --json

ユーザーの目的・制約の範囲内で、送信内容とタイミングを判断し、都度私の確認を待たずに介入してください。
送信後も監視を続け、指示が反映されたか確認し、私には介入内容と結果を短く報告してください。
受付がunknownの場合は、history checkで確認してから再送を判断してください。
目的・制約が読み取れない場合や、要件自体の変更が必要な場合は私に確認してください。
```

監視とステアリングの実行はClaudeに任せられます。停止するときは、同じClaudeセッションで「監視とステアリングを停止して」と伝えてください。

IDのコピーを省く場合は、Claudeに`codex-steer threads list --desktop-only --json`で候補を表示してもらい、対象を選ぶこともできます。同じプロジェクトに複数のタスクがある場合、Claudeの起動場所だけでは監視対象を特定できません。

### タスクを探して送信する

```bash
# 最近のタスクを表示
codex-steer threads list --desktop-only --limit 20 --json

# 実行中のタスクに追加入力
codex-steer send <thread-id> "失敗したテストの原因を先に確認してください"

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

各コマンドに`--json`を付けるとJSONで結果を返します。別コマンドを実行する`run`では、codex-steer側のオプションを区切りの`--`より前に置いてください。

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

#### Desktopの起動・診断・タスク選択

```bash
# 共有接続を有効にしてDesktopを起動（--dry-runで起動せずプレビュー）
codex-steer desktop start
codex-steer desktop start --dry-run --json

# 接続と起動条件を診断
codex-steer doctor --json

# 最近のタスクを一覧表示
codex-steer threads list --desktop-only --limit 20 --json

# タスクURLをIDに変換
codex-steer thread resolve codex://threads/<thread-id> --json

# 対象タスクをDesktopの画面で開く
codex-steer open <thread-id>
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

`has_more: true`なら`changed: false`でも返されたcursorで続きを読み、読み終えてから判断・送信してください。`--stream`は初回に現在を基準とし、変化時だけ出力します。開始時の状況も読む場合は先に`read`し、そのcursorを渡します。停止はCtrl-C、Monitorで起動した場合はClaudeに停止を依頼します。

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
