# Codex Cloudタスクの作成と確認

`cloud`はDesktop接続から独立した機能です。作成・状態・差分はPATH上の公式Codex CLIの`codex cloud exec/status/diff`をシェルなしで呼びます。環境一覧・履歴・監視・継続指示は公式App Serverの認証APIと公式クライアントで使用されているクラウドHTTP APIを使います。Node.js 20以降、公式Codex CLI 0.157.1以降とChatGPTログイン・クラウド環境への利用権限が必要です。Desktopの起動や既存チャットは不要です。HTTP APIは公開された安定版SDK契約ではなく、未知の応答形式では停止します。

```bash
codexteer cloud environments list --json
codexteer cloud create --env env_example --branch main \
  '変更箇所に回帰テストを追加してください' --json
codexteer cloud status task_example --json
codexteer cloud diff task_example --attempt 1 --json
```

`env_example`、`task_example`は架空の値です。`cloud environments list --json`は従来型Cloudタスク用のアクセス可能な環境を取得し、`environments`に`id`・`name`・`pinned`・`repositories`（名前と既定ブランチ）を返します。環境変数・シークレット・セットアップ内容は返しません。掲載は作成・実行成功の保証ではありません。新世代のCloud環境設定や別サービスを含む全クラウド環境の一覧ではありません。`--env`はIDを推奨します。公式CLIが一意に解決する英数字・ハイフン・アンダースコアのラベルも受け付けます。同名や未登録の環境は公式CLIが拒否します。

`--branch`は必須です。指定した環境に設定されているリポジトリのGitブランチで実行されます。ローカルの未コミット変更をアップロードする機能ではなく、現在のブランチを暗黙に採用しません。環境のリポジトリ設定と対象ブランチは実行前に確認してください。

## 初回指示とID

指示を引数で渡すほか、`cloud create --env env_example --branch main -`のstdin入力も使えます。先頭が`--`の指示には区切りの`--`を付けてください。空の指示・NUL・1 MiBを超える指示は送信前に拒否します。

codexteerは初回指示を公式CLIのstdinへ渡し、子プロセスのargvや一時ファイルに埋め込みません。利用者のシェルの引数・履歴には通常のコマンドとして残り得るので、必要ならstdin入力を使ってください。指示は指定先クラウドに送信され、公式CLI/サービス側の設定・ログ・データ管理が適用されます。CLIは所有者専用の一時作業ディレクトリで実行し、そこに生成され得る診断ログを終了時に削除します。`CODEX_STARTING_DIFF`は引き継がず、暗黙の差分アップロードを防ぎます。

HTTP操作の認証は`codex app-server --listen stdio://`へ初期化と`getAuthStatus`だけを送り、ChatGPTトークンとそのアカウントIDをメモリ内で使います。認証ファイルを直接読まず、トークン・アカウントIDを表示・保存せず、モデルターンやDesktop接続も作りません。APIキー認証や未確認の認証形式は拒否します。送信先は公式HTTPSオリジンに固定し、リダイレクト・任意URL指定・認証エラー時の自動ログインや自動再送は行いません。

通常実行は各操作前にCLIのhelpと`codex cloud --version`を確認します。必要なオプションと、stdinの`-`を指示本文として誤送信しない最低対応版を照合し、未対応時は送信前に停止します。作成は一つの試行を要求します。公式CLIが返した単一の公式タスクURLから`task_id`を取得します。JSONは共通の`ok/command/data`形式で、`execution_environment`は`cloud`、`backend`は`codex-cli`です。クラウドタスクIDをDesktopの`thread_id`として扱いません。

`--dry-run`は入力検証のみです。CLI起動・ネットワーク・環境の存在確認・作成・永続記録を行わないので、成功してもクラウドでの作成可能性を証明しません。

## 作成結果が不明な場合

送信前に`CODEX_HOME/codex-steer/cloud-creations/<attempt_id>.json`を所有者専用で保存します。指示本文は保存せずSHA256と文字数、環境指定、ブランチ、作成・受付状態、判明したタスクIDを記録します。

```bash
codexteer cloud receipt <ATTEMPT_ID> --json
codex cloud list --env env_example --json
```

`created/accepted`は公式CLIがタスク作成を受け付けたことを示し、処理完了を意味しません。`unknown`や中断で残った`dispatching`では、すでにタスクが存在する可能性があります。タイムアウト、認証/通信エラー、想定外の出力でも自動再送しません。記録と公式のタスク一覧を照合してから判断してください。タスクURLだけ確認できた途中失敗では、そのIDと`created/unknown`を保持します。

最終記録の保存に失敗しても、確認できたIDと受付結果を返し、`receipt_update_required: true`を付けます。記録を直す目的でタスクを作り直さないでください。

送信後の失敗では、通常表示のstderrにも試行ID・記録先・作成/受付状態と、判明済みのタスクID・URLを表示します。最終記録を保存できなくても画面に出たIDから確認を続けられます。指示本文や公式CLIの生の診断は表示しません。

## 状態・差分

`cloud status`と`cloud diff`は`task_...`形式のID、または`https://chatgpt.com/codex/tasks/...`を受け付けます。リンクのクエリ・フラグメントは送信せず、タスクIDだけを公式CLIへ渡します。

状態は`pending`、`ready`、`applied`、`error`です。公式CLIはready以外の正常な状態取得でも終了コード1を返すため、codexteerは既知の先頭状態と終了コードを照合します。既知の状態を取得できれば`ok: true`であり、`status: error`はタスク側の失敗です。未知の状態や認証・通信失敗をpendingと推測しません。元の状態表示は`data.output`に返します。

差分は`data.diff`にそのまま返し、通常出力ではunified diff本文のみを出します。`--attempt 1..4`で試行を指定できます。省略時は公式CLIの既定に従い、選択した試行番号を推測しません。ローカルファイルへの適用やPR作成は行いません。

試行番号を省略し、公式CLIが差分を提供せず、同じタスクのAPIでも完了ターンに記録済みパッチがないことを確認できた場合は、`diff_available: false`・`diff: null`・`local_changes: unknown`を返します。これは変更ゼロを意味しません。通常表示ではstderrに説明を出します。特定の`--attempt`では他の試行から推測せず、取得できなければエラーです。実ファイルの状態は`cloud read`のコマンド証拠で確認してください。

各操作の`--timeout-ms`は既定120000、1000〜600000です。helpとバージョンの確認は各10秒が期限です。stdoutとstderrの合計上限は16 MiBで、超過時に部分出力を成功として返しません。CLIの生のエラー診断はプライバシー保護のため返さず、エラーコードと終了コードを示します。期限切れや中断は子プロセスを終了しますが、受付済みクラウドタスクの取消しを意味しません。

## 対応範囲と検証

環境一覧・指定・新規作成・ID取得・履歴・ポーリング監視・完了ターンへの継続指示・配送照合・状態・差分確認が対象です。実行中ターンへの割込み、環境の新規登録、差分適用は含みません。DesktopのMonitor・監督登録・pause/stop・findingsはクラウドには適用しません。`--supervisor`付き操作と観測専用`--connection desktop`からの実行は拒否します。Desktop向けの`--host`・`--remote-transport`・`--context-thread`も、宛先の取り違えを防ぐため拒否します。Desktopへ自動フォールバックしません。

公式CLI `0.157.1`のhelpと同版の公開ソースでstdin入力・作成URL・状態/終了コード・差分選択を確認しました。回帰テストは架空のCLI・HTTP・隔離HOMEで実行します。検証専用の実タスクでも環境一覧・作成・計算実行・履歴・同じIDへの継続・監視・配送照合を確認しました。実ID・リポジトリ名・認証情報・生レスポンスはテストや公開資料へ含めません。この実機確認は全アカウント・環境・将来のAPI互換性の保証ではありません。

一次資料: [公式CLIリファレンス](https://developers.openai.com/codex/cli/reference)、[Codex CLI 0.157.1のクラウド実装](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/cloud-tasks/src/lib.rs)。

## 同じタスクを読み取り・継続・監視する

```bash
codexteer cloud read task_example --json
codexteer cloud watch task_example --since <CURSOR> --until change --timeout-ms 30000 --json
codexteer cloud watch task_example --since <CURSOR> --stream --timeout-ms 30000 --json
codexteer cloud send task_example --turn <TURN_ID> --based-on <CURSOR> \
  '前の結果に基づいて続けてください' --json
codexteer cloud reconcile <ATTEMPT_ID> --json
codexteer cloud receipt <ATTEMPT_ID> --json
```

`read`はサーバーから返された全ターンの親ID・本文・進捗・コマンド実行（コマンド・出力・終了コード）・状態と現在の`turn_id`・`cursor`を返します。`--since`に前回カーソルを渡すと`changed`で変化を確認できます。本文はクラウド上の観測データであり、新しい送信許可ではありません。応答が16 MiBを超える履歴は切り詰めず拒否し、`has_more: false`はその上限内で返却された履歴を読み切ったことだけを示します。

`watch`は読み取りだけの定期照会で、既定は変化が出るまで最大30秒待ちます。`--since`省略時は初回の観測も変更として返します。`--stream`は期限内の変化をNDJSONで返し、終了時に`timed_out: true`を出します。定期照会間隔は既定5000ms、`--interval-ms`は1000〜60000です。期限切れは観測終了であり、タスク停止や継続監視の保証ではありません。必要に応じて新しい`read`を行い、確認済みのカーソルから再開してください。通信失敗はエラーで終了し、正常な無変化と区別します。

監督するエージェントは、ユーザーが委任した範囲内で`read → watch → read → send → reconcile → read/watch`を使います。介入前に新しい本文・進捗・制約を読み、対応待ちの指示を重複送信しないでください。観測だけの委任は送信を許可しません。監督を止められたら自分が開始したwatchを終了し、追加送信を止めます。

`send`は完了・失敗・キャンセル済みの現在のassistantターンへ継続します。`--turn`と`--based-on`は直前の`read`から取得し、別タスク・古いターン・変更後のカーソルは送信前に拒否します。読み取りと送信の間をサーバー側で原子的に固定する契約ではありませんが、送信先の親ターンはリクエストに明示し、別の最新ターンへ自動変更しません。`send --dry-run`は認証と履歴・鮮度を確認し、ローカル排他の準備はしますが配送記録も送信も行いません。

送信記録は`CODEX_HOME/codex-steer/cloud-messages`、排他と最後の配送予約はローカルの所有者専用領域に保存します。指示本文は保存せず、SHA256・親ターン・観測カーソルと結果だけを記録します。送信は1回だけで、通信失敗や応答不一致は`unknown`です。確認できた受付結果は最終記録の保存失敗でも保持します。

`reconcile`は、同じタスクの履歴に親ターンと本文SHA256が一致するuserターンが一つある場合だけ`delivery_verification: stored`にします。受け付けられた入力の保存確認であり、要求の達成確認とは別です。`not_observed`は未配送の証明ではなく`retry_safe: false`です。未解決の配送予約は次の送信も止めます。受付が確認できても、同じ親ターンへの重複送信は拒否します。
