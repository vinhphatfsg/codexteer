# Codex Cloudを既存の操作体系で使う

CloudのタスクIDまたは公式リンクを指定すると、通常の`read`・`watch`・`send`・`supervise`・`history`・`instructions`・`findings`を使えます。Desktopには接続・フォールバックしません。タスクをまだ選んでいない環境一覧・タスク一覧・新規作成では`--connection cloud`で接続先を指定します。

```bash
codexteer --connection cloud projects list --json
codexteer --connection cloud threads list --limit 20 --json
codexteer --connection cloud thread create --project env_example --branch main \
  'テストを追加してください' --json
codexteer read task_example --include-output --json
codexteer watch task_example --stream --notify digest --since <CURSOR> --json
codexteer supervise task_example --agent claude
codexteer supervise task_example --agent codex -- exec
codexteer supervise prompt task_example --use-path-cli --json
```

IDはすべて架空の例です。`--project`は環境IDまたは一意の正確な名前です。`--branch`を省略したときは、一つのリポジトリの既定ブランチを環境が明示している場合だけ使い、`branch_source: environment-default`を返します。不明・複数リポジトリの場合は明示指定が必要です。ローカルの現在ブランチや未コミット差分を暗黙に送信しません。

Node.js 20以降、PATH上の公式Codex CLI 0.157.1以降、ChatGPTログインとCloud利用権限が必要です。Desktopの起動は不要です。対象は従来型Cloudタスク用環境であり、新世代Cloud環境設定や別サービスを含む一覧ではありません。環境一覧にはID・名前・リポジトリ名・既定ブランチだけを返し、環境変数・secrets・セットアップ内容は出しません。掲載は実行成功の保証ではありません。タスク一覧は最大500件を公式CLIのページに分けて取得し、続きのcursorを返します。

## 共通の監督と介入

```bash
codexteer --supervisor <SESSION_ID> --connection cloud supervise register task_example
codexteer --supervisor <SESSION_ID> --connection cloud read task_example --include-output --json
codexteer --supervisor <SESSION_ID> --connection cloud findings create task_example \
  --key timeout-contract --title '期限処理' --condition '期限の検証が通る' --based-on <CURSOR> --json
codexteer --supervisor <SESSION_ID> --connection cloud send task_example \
  '期限処理を確認してください' --finding <FINDING_ID> --based-on <CURSOR> --json
codexteer --supervisor <SESSION_ID> --connection cloud history check task_example <MESSAGE_ID> --json
```

監督プロンプトが返した実際のSESSION_ID・保存済みCLI・Node・CODEX_HOMEをそのまま使います。PATHモードも共通です。監督エージェントの起動前に登録し、終了時にその登録を停止します。自分の状態を解除したり、IDを外して介入したりしないでください。

ユーザーは通常の制御を使えます。

```bash
codexteer supervise status task_example --json
codexteer supervise pause task_example --json
codexteer supervise resume task_example --json
codexteer supervise stop task_example --json
```

pauseはその監督の送信・撤回を拒否し、観測は許可します。stopはその監督の観測・送信を拒否し、watchも終了します。Cloud作業自体を取り消す操作ではありません。送信とpause/stopは同じローカル排他を使い、送信中の競合は`RECORD_BUSY`です。監督IDのない明示的な手動送信や旧CLIは、この制御の対象外です。

Cloud監督レコードは所有者専用の`CODEX_HOME/codex-steer/cloud-supervisors`へ保存します。旧Desktop CLIが新しいレコードを誤読しないようDesktopの登録と分け、新CLIの`supervise list`では両方を扱います。CLIと保存済みランタイムを更新しても、使用中の旧ランタイムは変更しません。

`findings`の安定したkey・revision、対応待ちの重複介入拒否、`history mark`、指示の置換・撤回・有効期限、明示的な根拠、checkpointによる解決・再検証も共通です。登録は継続監視やモデルの読了の証明ではなく、最後の観測時刻と接続状態を区別します。

## 実行中と停止中のsend

- 通常の`send`は、実行中の現在のターンを再確認し、その親IDを指定してCloudのfollow-upを一度送ります。実機では元ターンがキャンセルされ、**同じタスク内の後続ターン**が開始する方式を確認しました。結果は`delivery_action: interrupt-and-follow-up`です。同じターンIDを保持するローカルのsteerとは内部動作が異なります。
- 停止中の継続は`send --new-turn`です。ユーザーが再開を委任している場合だけ使います。対象が実行中なら拒否します。
- タスク・親ターン・ユーザー入力の鮮度を確認しますが、Cloud APIには読取りと送信を原子的に固定することを確認した契約がなく、`freshness_atomic: false`を返します。別の最新ターンを推測して宛先を変更しません。
- `accepted`は受付です。新しいターンIDは即時に推測せず、`read`と`history check`で親ターン・本文SHA256を照合します。`stored`も要求の達成の証明ではありません。
- 結果不明時は`unknown`を維持し、自動再送しません。未解決の配送予約は次のCloud送信も止めます。`not_observed`は未配送の証明ではなく、再送を許可しません。
- POST前の保存失敗では未送信を記録して予約を戻します。予約の復元も失敗した場合は`reservation_cleanup_required: true`で止め、`cloud reconcile <ATTEMPT_ID>`は保存済みの明示的な未送信証拠がある場合だけ予約を修復できます。履歴に見えないだけの送信を安全と推測せず、自動再送もしません。

共通`send --dry-run`はローカルと同様に入力・指摘・根拠・監督状態を確認するだけで、ネットワーク・配送記録・送信を行いません。鮮度は未確認です。初回指示と送信にはstdinの`-`も使えます。空本文・NUL・1 MiB超の指示は拒否します。先頭が`--`の本文には区切りの`--`を使います。

共通の`history`と`instructions`を使うため、通常の`send`本文・送信時の本文・根拠・結果はローカルと同じ所有者専用ジャーナルに保存します。認証情報は記録しません。これと、本文を保存しない作成/Cloud配送の試行記録は別です。ファイルは公開資料や配布物へ含めないでください。

## read/watchとMonitor

観測はCloud履歴を共通のturn・userMessage・agentMessage・commandExecutionへ変換し、既存の読取りカーソル・ページ分割・Monitor・通知バッファを使います。コマンドの出力・終了コードも確認できます。reasoning、生の内部イベント、環境設定は表示しません。返却された本文は観測データであり、新しい委任ではありません。

`watch --stream`は明示的に終了するまで動き、既定の`digest`、`--notify all`、`--settle-ms`、`--max-hold-ms`、接続通知、最大60秒の復帰待ちを共通のMonitor処理で使います。送信前には自分が実際に読んだcursorから`has_more`を読み切ります。`--stream`と`--until`・`--timeout-ms`は併用できません。単発watchは既定30秒、`--until change|idle|attention`に対応します。Cloudの既定照会間隔は5000msで、`--poll-ms`を明示できます。

通信失敗の復帰待ち中は介入しません。初期接続失敗、認証エラー、未確認のプロトコル、履歴変更によるcursor不整合は成功扱いせず停止します。watchが終了したら継続監視中と報告せず、確認済みcursorで明示的に再開します。

サーバー履歴は集約応答で、受信上限16 MiBを超えた場合は切り詰めず拒否します。共通CLIの`has_more`は取得済みの履歴内のページ分割であり、Cloud API自体の分割取得を保証しません。

## 状態・差分・ローカル検証

共通`status`はローカルと同じ`active/idle`等の観測状態を返します。詳細な元のCloud状態は旧`cloud status`でも確認できます。

```bash
codexteer diff task_example --json
codexteer cloud diff task_example --attempt 1 --json
```

公式CLIが返す差分をそのまま返し、ローカルへ適用しません。既定試行で公式CLIが差分を提供せず、APIでも完了ターンに記録済みパッチがないことを確認できたときは、`diff_available: false`・`diff: null`・`local_changes: unknown`です。実機ではファイルの実差分があっても記録済みパッチが提供されない場合がありました。変更ゼロと解釈せず、`read --include-output`のコマンド証拠と区別します。特定の`--attempt 1..4`では他の試行から推測しません。

checkpoint・resourceは同じローカル記録/コマンド機能で、Cloudタスクにも関連付けられます。明示したローカル入力・成果物・コマンドが対象であり、Cloud作業コピーがローカルにあるとは仮定しません。出力に`execution_environment: local`を示します。ローカルのテスト成功をCloud側の検証と取り違えないでください。

Cloud作成時のタイトル・モデル/推論設定・ローカルの権限上書きは、現在の作成経路で適用を確認できていないため、無視せず送信前に拒否します。監督エージェント自身のモデルなどは、従来どおり`supervise --agent ... -- <AGENT_ARGS>`でそのエージェントへ渡します。承認/質問の代理回答、環境登録、Desktop UI操作はこのCloud接続の対象外です。

## 認証と失敗時の保護

一覧・観測・配送照合・継続指示は、公式`codex app-server --listen stdio://`へ初期化と`getAuthStatus`を送り、既存のChatGPT認証とそのアカウントをメモリ内で使います。認証ファイルを直接読まず、トークン・アカウントIDは表示/保存せず、認証取得のためのモデルターンやDesktop接続も作りません。APIキーや未確認の認証形式は拒否します。

HTTP APIは安定した公開SDK契約ではありません。送信先は公式HTTPSオリジンに固定し、リダイレクト・任意URL・自動ログイン・自動再送を使いません。作成・タスク一覧・元の状態・差分は公式Cloud CLIを使い、必要なhelpと版を確認します。公式CLIは私有の一時作業ディレクトリで動かして診断ログを終了時に削除し、`CODEX_STARTING_DIFF`を引き継ぎません。未確認の入力や認証/通信エラーを、空の正常結果に置き換えません。

## 旧cloudサブコマンド

`cloud environments list/create/read/watch/send/reconcile/status/diff/receipt`は互換用に残します。新しい監督では共通コマンドを使います。旧`cloud read`の`cloud_v1:...`カーソルと共通`read`のカーソルは別形式なので混ぜません。旧`cloud watch --stream`は期限付きで、共通`watch --stream`とは終了条件が異なります。旧`cloud send`は明示した完了ターンへの継続用で、監督ID付きの旧cloud操作は拒否します。

作成・配送の試行記録は`cloud receipt <ATTEMPT_ID>`で確認できます。初回指示は保存せずダイジェストを持ち、作成結果不明時も再作成しません。受付後に記録更新だけ失敗した場合は、確認できた実IDと`receipt_update_required: true`を保持します。

一次資料: [公式CLIリファレンス](https://developers.openai.com/codex/cli/reference)、[公式Cloud CLI実装](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/cloud-tasks/src/lib.rs)。実機検証は専用タスクに限定し、実ID・環境名・認証情報・生ログを公開資料に含めません。
