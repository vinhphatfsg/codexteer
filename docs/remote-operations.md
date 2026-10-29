# リモートのCLI操作

`--host <HOST-ID> --remote-transport paired`で、接続先のタスクをcodexteer CLIから操作できます。接続先にはCodex Desktopと公式ペアリングが必要で、codexteerやCodex CLIの追加インストールは不要です。ローカルのshared wrapperと専用鍵は従来どおり使用します。既定のnative経路は観測専用、既存Desktop鍵のcontrol経路は別機能のままです。失敗時に別ホスト・別資格情報・別backendへ自動切替しません。

## 対応範囲

| ローカルの操作 | pairedでの動作 |
| --- | --- |
| `projects list` | 接続先の`project/list`で正式ID・全rootsを取得。Desktop登録IDも別フィールドで対応付ける |
| `threads list` | 接続先のタスクID・タイトル・所属・作業場所・hostId付きリンクを取得。ページ・検索・project指定・Desktop絞込みに対応 |
| `thread create` | Desktopの公式createで対象ホストへ作成し、pairedでcanonical所属・初期指示・全rootsを照合 |
| `thread verify` | 保存済みremote receiptを読み直して照合。作成・初期送信・所属変更は繰り返さない |
| `thread resolve` | hostIdを保持してIDを解決 |
| `read/status/watch/doctor` | 選択先の履歴・稼働状態・差分・接続を読む |
| `send` | 実行中の同じターンへ`expectedTurnId`付きで一度だけ送る |
| `send --new-turn` | idleだけを対象とし、制御側Desktopで対象チャットを開いてから同じ接続先へ`turn/start`する |
| `supervise`・findings・history・instructions | 従来のpause/stop・freshness・重複防止・受信照合を維持。記録・ロックはホストごとに分離 |
| `orchestrate` / `orchestrate prompt` | 接続先host・paired・callerを子作成/監督コマンドへ保持。エージェント自体は制御側で動く |
| `checkpoint capture/verify/attach`・ファイル根拠 | 接続先の公式`fs/*`で読む。相対入力パスは対象チャットのcwdで解決。ファイル根拠・artifactはリモート絶対パス |
| `checkpoint run`・`resource run` | defaultは接続先の`command/exec`。明示的な`thread-shell`にも対応（下記）。Macでは実行しない |
| resourceの取得・更新・解放・一覧 | ホスト別の協調記録。OSの排他制御を作るものではない |
| `open` | 制御側Desktopで指定したリモートチャットを表示 |
| `desktop start`・`debug-ui` | Macの起動/Accessibility用で接続先へは未対応。ローカルで誤実行せず`REMOTE_HOST_OPERATION_UNSUPPORTED`。この版に`desktop update/update-status`はない |
| `thread repair` | この版にはローカル修復機能もない。リモート指定は`REMOTE_REPAIR_UNSUPPORTED`で明示拒否し、保存履歴やDBを変更しない |
| `--backend ui` | 接続先のUI送信は未対応。明示的に拒否する |

Macの起動・AccessibilityはWindowsの接続先へ提供していません。オフライン履歴修復はこの版のCLI機能に含まれません。上表は実装範囲であり、接続先APIが全操作を許可する保証でもありません。

## 一覧と作成

```sh
codexteer --host remote-control:env_example --remote-transport paired projects list --json
codexteer --host remote-control:env_example --remote-transport paired threads list --limit 20 --json
codexteer --host remote-control:env_example --remote-transport paired threads list --project CANONICAL-ID --search 検証 --json
codexteer --host remote-control:env_example --remote-transport paired threads list --cursor CURSOR --json
codexteer --host remote-control:env_example --remote-transport paired --context-thread LOCAL-CALLER-ID thread create --project PROJECT-ID --title 検証専用 '初回の指示' --json
codexteer --host remote-control:env_example --remote-transport paired thread verify ATTEMPT-ID --json
```

`project_id`は接続先App Serverの正式ID、`desktop_project_ids`は制御側Desktopの登録IDです。両者を同じIDとは扱いません。登録ID・正式ID・一意の正確な名前で作成対象を選べます。Desktopの登録とlive projectの全rootsが一意に一致しなければ作成しません。Windows/UNCをMacのパスへ変換したり、Macのrealpath/statで検査したりしません。

paired一覧の`availability: verified`は`availability_scope: project-catalog`です。ホストへ接続して正式一覧を読めた意味で、各rootの現在の存在・読み書き可否は`roots_availability: unverified`です。

作成はDesktopの公式native APIを使うため、**実在するローカルcallerと保存済みturnが必要**です。Codex内では`CODEX_THREAD_ID`を使用し、通常の端末からは`--context-thread LOCAL-CALLER-ID`を明示します。callerの追加ターンやAIによる中継は作りません。pairedの一覧・read・通常sendにはcallerは不要です。ローカルstandalone作成は従来どおりcaller不要で、環境変数も継承しません。

`--dry-run`はnative schema・live project・登録の対応を検査するだけで、作成・送信・receipt保存をしません。作成後は実ホスト、Desktop所属とcanonical所属、タイトル、初回本文、project rootsを照合します。Desktopが付与するそのタスク固有のvisualizations rootだけは、同じprofile・履歴日・thread IDから照合して許容し、それ以外の追加rootは拒否します。

POSIXパスの大文字小文字は区別します。Windowsのドライブ付きパスとバックスラッシュのUNCパスだけは、Windowsの表記を正規化して照合します。再照合が失敗した場合はreceiptのverificationをfailedへ更新して古い認定フラグを除去し、created/acceptedは保持します。

`creation_status: created`は既存タスクがある状態です。後段の照合失敗でもそのIDとacceptedを保持します。応答不明はunknownとしてreceiptを残し、自動再作成・再送しません。異なるホストが返った場合も判明したIDを保持して停止し、そのタスクへ追加操作しません。

## 新しいターンと監督

```sh
codexteer --remote-transport paired --context-thread LOCAL-CALLER-ID send 'codex://threads/UUID?hostId=remote-control%3Aenv_example' '続きの指示' --new-turn --json
codexteer --remote-transport paired --context-thread LOCAL-CALLER-ID supervise prompt 'codex://threads/UUID?hostId=remote-control%3Aenv_example' --use-path-cli --json
```

new-turnは、実在callerによるDesktop native readでthread/hostを照合し、公式navigation APIで制御側Desktopに対象チャットを表示します。通常sendと異なり画面遷移があり、そのDesktopの持続する接続で対象を開いた後、pairedでidle・freshnessを再確認して一度だけ`turn/start`します。短命なsenderだけでresumeする経路は使いません。ユーザーからの再開委任がないidleタスクを監督目的だけで再開しません。

生成する監督・オーケストレーションコマンドはhost・transport・指定callerを保持します。停止済みの監督を別ID・unbound送信で迂回しません。承認・質問を自動回答するAPIは追加していません。画面への吹き出し表示や承認UI往復は、受付・保存・明示応答とは別の検証項目です。

## リモートの検証コマンド

既定の`command/exec`は接続先の設定された権限を使い、sandbox/permissionの上書きを送りません。接続先によってはこのAPIが`RPC_REJECTED`（-32600）になる場合があります。この拒否から自動で別経路を試しません。

公式`thread/shellCommand`は**ホストのfull accessでシェルを実行**するAPIです。その意味を選べるよう、次の明示指定に限定します。

```sh
codexteer --host remote-control:env_example --remote-transport paired resource run test-resource --owner codex --thread TEST-THREAD-ID --exec-backend thread-shell --shell powershell --cwd 'C:\Windows' --timeout-ms 10000 --include-output -- cmd.exe /d /c 'echo test'
codexteer --host remote-control:env_example --remote-transport paired checkpoint capture TEST-THREAD-ID tests --path 'C:\test\input.txt' --json
codexteer --host remote-control:env_example --remote-transport paired checkpoint run TEST-THREAD-ID CHECKPOINT-ID --exec-backend thread-shell --shell powershell --timeout-ms 10000 --include-output -- cmd.exe /d /c 'echo test'
```

`--shell powershell|posix`が必須で、相手のshellを推測しません。resourceでは対象`--thread`も必須、checkpointは自身のthreadを使います。idle以外では実行しません。argvは選んだshellの規則で引用し、任意のshell式として連結しません。`cmd.exe /c`などに式を渡す場合は、その式自体が明示したユーザーのコマンドです。

受け付けたという空応答だけでは成功としません。ランダムIDを含む実行項目、集約出力中の独立した1行に一度だけ現れる完了marker（stdoutのmarker後にstderrが続く場合も許容）、同じ項目のexitCodeを接続先の保存履歴で照合します。人間/モデルの「成功した」という発言では判定しません。full access・backend・実行先・終了コードを結果に表示します。制御側Macのプロセスを起動しません。

リモートのtimeout 0はthread-shellで公式APIの既定に合わせ1時間、汎用command/execで24時間として送ります（ローカルの無制限とは異なります）。明示timeoutは最大24時間です。thread-shellには対応する限定的な取消操作がないため、観測中断時に別のCodex作業を止める操作は行いません。完了を照合できない場合はunknown・再送禁止とし、resourceは期限までleaseを保持、checkpointは無効にします。承認/質問への代理回答やpermission overrideは行いません。

checkpointは接続先の`fs/watch`で途中変更を観測し、入力hashも前後照合します。symlinkのcanonical targetが分からない場合、巨大な入力、読取/監視失敗は有効な検証にしません。全体の厳密固定が必要なら隔離した入力を使います。監督ID付きthread-shellは、準備後の送信直前に同じsession・connection・transportとactive状態を再確認し、受付応答までpause/stopと同じロックを保持します。先にpause/stopが完了すれば送信しません。送信中のpause/stopは`RECORD_BUSY`で失敗し、停止済みという誤った応答を返しません。受付応答後はロックを解放するためpause/stopできますが、すでに受け付けたコマンドの取消・終了は保証しません。応答不明でも自動再送せず、観測とleaseの扱いは上記に従います。

## 公開検証情報

回帰テストは架空の識別子・ホスト・一時プロファイルを使います。実アカウントの登録情報、接続先一覧、チャットやプロジェクトの実ID、業務タイトル、実行ログは公開しません。テスト件数、pause競合のローカル再現、依存DB照合の要約は`remote-cli-validation.json`を参照してください。

`native`は観測専用、`control`は既存のactiveターンへの送信、`paired`は明示した管理操作を扱います。正式project IDとDesktop登録IDは別の識別子です。Desktopの承認・質問UIや表示は、RPC受付とは別に利用環境で確認してください。

監督のpause/resume/stopでも、生成された`--host`と`--remote-transport`を保持してください。登録と異なるtransportの制御は`SUPERVISOR_MISMATCH`で拒否し、保存状態を変更しません。
