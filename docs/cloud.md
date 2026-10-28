# Codex Cloudタスクの作成と確認

`cloud`はDesktop接続から独立した機能です。PATH上の公式Codex CLIの`codex cloud exec/status/diff`をシェルなしで呼びます。Node.js 20以降、公式Codex CLI 0.157.1以降とクラウド環境への利用権限・ログインが必要です。Desktopの起動や既存チャットは不要です。

```bash
codexteer cloud create --env env_example --branch main \
  '変更箇所に回帰テストを追加してください' --json
codexteer cloud status task_example --json
codexteer cloud diff task_example --attempt 1 --json
```

`env_example`、`task_example`は架空の値です。公式CLIの`codex cloud`で実際の環境を確認してください。`--env`はIDを推奨します。公式CLIが一意に解決する英数字・ハイフン・アンダースコアのラベルも受け付けます。同名や未登録の環境は公式CLIが拒否します。

`--branch`は必須です。指定した環境に設定されているリポジトリのGitブランチで実行されます。ローカルの未コミット変更をアップロードする機能ではなく、現在のブランチを暗黙に採用しません。環境のリポジトリ設定と対象ブランチは実行前に確認してください。

## 初回指示とID

指示を引数で渡すほか、`cloud create --env env_example --branch main -`のstdin入力も使えます。先頭が`--`の指示には区切りの`--`を付けてください。空の指示・NUL・1 MiBを超える指示は送信前に拒否します。

codexteerは指示を公式CLIのstdinへ渡し、子プロセスのargvや一時ファイルに埋め込みません。利用者のシェルの引数・履歴には通常のコマンドとして残り得るので、必要ならstdin入力を使ってください。指示は指定先クラウドに送信され、公式CLI/サービス側の設定・ログ・データ管理が適用されます。codexteerは認証トークンを解析・複製せず、公式CLIに既存の環境と認証を引き継ぎます。

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

各操作の`--timeout-ms`は既定120000、1000〜600000です。helpとバージョンの確認は各10秒が期限です。stdoutとstderrの合計上限は16 MiBで、超過時に部分出力を成功として返しません。CLIの生のエラー診断はプライバシー保護のため返さず、エラーコードと終了コードを示します。期限切れや中断は子プロセスを終了しますが、受付済みクラウドタスクの取消しを意味しません。

## 対応範囲と検証

環境指定・新規作成・ID取得・状態・差分確認が対象です。環境の新規登録や一覧、継続指示、監督、差分適用は含みません。`--supervisor`付き操作と観測専用`--connection desktop`からの実行は拒否します。Desktop向けの`--host`・`--remote-transport`・`--context-thread`も、宛先の取り違えを防ぐため拒否します。Desktopのローカル/リモート作成とは別のコマンドで、Desktopへ自動フォールバックしません。

公式CLI `0.157.1`のhelpと同版の公開ソースでstdin入力・作成URL・状態/終了コード・差分選択を確認しました。回帰テストは架空のCLIと隔離HOMEで実行し、実アカウントでの作成・認証・クラウド実行の成功は未検証です。

一次資料: [公式CLIリファレンス](https://developers.openai.com/codex/cli/reference)、[Codex CLI 0.157.1のクラウド実装](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/cloud-tasks/src/lib.rs)。
