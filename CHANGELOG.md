# Changelog

公開日は日本時間です。

## 0.22.0 — 未公開

- managed threadへの低水準`send`は監督IDの有無によらず拒否し、介入は`work tell`に限定します。配送直前に公開イベントの追加・更新と現在の質問・承認状態を再照合します。
- `project sync`は完全な最新観測で消えた待機フラグを解消し、質問と失敗の証拠を別々に保持します。公開イベントは要約前の全文を保存し、コマンド出力も`project event`で取得できます。`work start`の初回観測も次のsyncで提示します。
- `project control stop`は今後の監督による介入を止めます。受付済みの担当の実行・編集・外部操作を終了する操作ではありません。

- `project sync`は直近turnの完了と入力待ちを証明できる担当を検収待ちに分類し、開始前idleと区別します。同じ委任を`work tell --new-turn`で続け、activeになれば動作中へ戻ります。

- `project sync`は途中コマンドの非ゼロ終了を担当の失敗と扱わず、turnやbackendの失敗と区別します。担当への発注では、前提への異論・改善案と根拠を求めます。

- `project control pause|stop|resume`で個別または全担当を制御できます。部分失敗とbusyを明示し、stop済みの担当は再開しません。オーケストレーター本文とhelpを4操作へ整理し、担当範囲を方針と発注から決め、確認済みの道具でDesktop Cloudとlocal Desktopを選びます。

- `project sync`の並行実行によるcursorの巻き戻りを防ぎ、未解決attentionの根拠をページをまたいで保持します。担当内のイベントもcontinuationで分割してbyte予算を守り、不正な観測ページや停止済み担当の自動再登録を拒否します。

- `work tell`を追加しました。最新のcomplete project syncから送信直前までを再照合し、質問・承認待ち、attention不明、history gap、並行sync、membership変更では送信しません。finding・source・kind・監督IDを内部化し、unknownと同一意図を自動再送しません。
- managed threadの外部効果を共通gateへ集約しました。受付確認できないDesktop UI sendとpaired `command/exec`は拒否し、方針ファイルの差し替え、作成照合の不一致、stopped supervisorの自動再登録をfail closedにします。
- `project sync`を追加しました。managed projectの全担当を前回cursorから公平に差分取得し、動作中・対応が必要・検収待ち・未確認へ分類します。未解決attentionを再掲し、history gap・429・不完全取得・出力省略を明示します。長文は`project event`で全文取得できます。
- `work start`を追加しました。repository rootの`CODEXTEER.md`を原文のまま発注書へ入れ、Desktop sharedまたはDesktop Cloudで作成・managed index登録・監督登録・初回観測までを一度に行います。段階を保存して同じ作成を再送せず、作成結果が不明なときは読み取り照合だけを行います。Desktop Cloudはenvironment configurationと明示したローカルcheckoutを使い、調整用projectへ登録します。work startのWeb Cloud経路は提供しません。

## 0.21.0 — 2026-11-03公開

- ローカルの`orchestrate`本文に、ローカル資源を占有せず並行作業を増やせるWeb Cloudを、条件に向く担当で優先する基準と環境照合・作成・監督手順を追加しました。条件を満たさない、環境がない・照合できない場合は作成前にDesktopを選びます。同じCLI・Node・CODEX_HOMEの専用`cloud_command`を返し、pairedリモートではCloud手順を出しません。Cloud接続のorchestrateは従来どおり拒否します。
- ローカル共有資源の待機時は、資源なしで進められるコード変更をWeb Cloudへ分け、ローカルでは統合後の確認を順番に行う分担を案内します。Cloudの基点は取得可能なpush済みブランチとし、必要なpushは委任された作業ブランチだけ、委任がなければ確認を求めます。既定ブランチへの直接pushやユーザーの未コミット差分を巻き込むpushは禁止します。
- Web Cloudの監督本文に照会間隔・429・差分の限界と検収方法を補い、本文を失った場合は`help cloud`も読むようにしました。Cloud監督のChatGPTプロファイル指定を保存方式でも明示します。

## 0.20.0 — 2026-11-02公開

- 介入も報告も不要な通知に「変化なし」とだけ応答する指示を、標準方針から共通手順へ移しました。`supervise prompt`のMESSAGEやオーケストレーションの担当方針で方針を置き換えても、方針に別の指定がなければ維持されます。
- 監督役が自分の判断・指示を`--kind decision`（ユーザー決定の伝達）で送っていたため、decisionはユーザー本人の決定を発言日時とともに引用する場合に限り、監督の指示は`review`で送るよう生成プロンプトで指示します。`supervise status`・`help send`・`help findings`の確認は最初の介入の前に一度にしました。
- 生成プロンプトは、タスクが待機中でも監督停止まで監視を続け、会話の要約・再起動の後は実行コマンド・読了cursorを確認し、手順を読み直してから再開するよう指示します。実行コマンドをシェル変数や関数に入れないこと（zshでは終了コード127になります）、調べれば分かる事実や決まっていることをユーザーに聞き直さないこと、別の論点には別のkeyを使うことも加えました。
- `orchestrate prompt`の本文は、本文と各担当のdata.promptをファイルに保存して要約・再起動の後に読み直すよう指示します。全体の完了時とユーザーの停止指示時には、各担当の監督を`supervise stop`で終了します。既存の成果物や以前のAIが選んだ仕組みを確定要件として扱わないことも明記しました。
- 子の監督本文だけで継続と監視の終了が決まるようにしました。共通手順は、監督方針で明示的に許可された`--new-turn`の再開と、方針の終了条件を認めます。オーケストレーションの担当方針は、idleの未完了作業の再開（paused/stopped・承認・質問待ちは迂回しない）と、ユーザーの停止指示か全体の完了を終了条件とすることを定めます。`orchestrate prompt`の本文から、子の規則を読み替える文を削除しました。標準方針は再開も終了条件も定めないため、単一スレッド監督の挙動は変わりません。
- 保存済みCLI方式の`supervise`・`supervise prompt`・`orchestrate`・`orchestrate prompt`は、300〜500文字の実行コマンド（`CODEX_HOME`指定・Node・保存したCLIのパス・`--require-node-version`・`--supervisor`・`--connection`・リモートの経路）を本文に20回ほど繰り返す代わりに、これらを固定した起動ファイル`CODEX_HOME/codex-steer/bin/codexteer-s-<hash>`（プロジェクト用は`codexteer-p-<hash>`）を生成し、そのパスを1語の実行コマンドとして示します。子の監督本文は約4割短くなります。起動ファイルは本人専用で内容のハッシュを名前にし、同じ名前で内容が違えば上書きせず`LAUNCHER_MODIFIED`、生成時に実行できなければ本文を出力せず`LAUNCHER_UNUSABLE`で止まります。`--json`は`data.command`も返します。
- `--supervisor`・`--connection`・`--require-node-version`・`--host`・`--remote-transport`・`--context-thread`を`--`より前に重ねて指定すると、全経路で`OPTIONS_INVALID`になります。生成した実行コマンドに付け直しても束縛は変わりません。以前の版が生成した長い実行コマンドはそのまま使えます。`--use-path-cli`の実行コマンドと動作は変わりません。
- `read`・`watch`・`status`が返すcursorを、タスクのターン数で長くならない`c1`で始まる形式にしました。全ターンの一覧の代わりにターン列のSHA-256を持ち、`--since`・`--based-on`では従来どおり現在のターン列・項目と照合するため、`STALE_CURSOR`・`STALE_OBSERVATION`の判定は変わりません。200ターンのタスクでは約18,600文字から約190文字になります。以前の版が出力したcursor（`eyJ`で始まる）も引き続き使え、続きは新しい形式で返します。保存済みの指摘・送信履歴の記録は変わりません。保存済みCLIなど以前の版に新しいcursorを渡すと`STALE_CURSOR`になるため、`--since`なしで読み直してください。
- 失敗した呼び出しは`error.help`に該当トピック、`error.action`にそのトピックに記載した対処を返し、引数エラー（`OPTIONS_INVALID`・`CLOUD_OPTIONS_INVALID`・`DESKTOP_CLOUD_OPTIONS_INVALID`）は`error.usage`に失敗したサブコマンドの使い方も返します。テキスト出力では標準エラーに`使い方:`・`対処:`の行を足します。代わりに`help <topic>`はテキストでも`--json`でもエラー一覧を載せず、`help <topic> --errors`を示す1行だけにしました（`--json`の`errors`配列は`errors_command`に置き換わります）。一覧は`help <topic> --errors`で取得できます。`help send`は約4,300から約2,300 o200kに減ります。エラーコード・メッセージ・終了コードは変わりません。
- `findings`の`create`・`reopen`・`show`・`list`・`resolve`・`dismiss`・`evaluate`（`revisions`を含む）と`history list`・`show`・`check`・`mark`、`instructions list`は、`based_on`のcursorをそのまま返す代わりに、cursorのSHA-256（16進64桁）を`based_on_sha256`として返します。保存済みの記録は全文のcursorを保持し、以前の記録もそのまま読めます。
- 生成プロンプトは、会話の要約・再起動の後に保存した本文を読み直し、保存していない場合だけ`help monitor`を読むよう指示します。単発の`watch --until change`の行の後に、完了まで待つ`--until idle`と本文を短くする`--max-chars N`（既定2000）も示します。
- `send`・`thread create`（ローカル・Cloud・Desktop Cloud）・`orchestrate`で`--`より前の未知のオプションを拒否するとき、エラー文と`error.unknown_options`がその語を示します（例: `Unknown send option: --kidn. Put instruction text that starts with -- after --.`）。示すのは`--`で始まる語を先頭から3件までで、本文を含まないよう各語を最初の空白の手前・40文字までに切り詰めます。拒否する入力・エラーコード・終了コードは変わりません。
- 生成済みの本文は変わりません。更新後のCLIで生成し直してください。

## 0.19.0 — 2026-11-01公開

- タスクIDと接続指定の不一致エラーに、修正用の`--connection`とJSONの`expected_connection`・`connection`を追加しました。Desktop Cloudには`desktop-cloud`、Web Cloudには`cloud`、ローカルには既定の`shared`を示します。拒否・終了コード・既存エラーコードを維持し、自動切り替えは行いません。
- `help`の全30トピックを同じ構成に揃えました。各トピックは使い所・使い方・オプション（既定値）・確認できること・エラーと対処・手順・例・補足・関連を持ち、`--json`でも同じ項目名で取得できます。記述は実装と照合し、実装と食い違っていた説明（接続ソケットのリンク、Cloudの版確認の範囲、`status`の`unregistered`など）を直しました。`help desktop-cloud`と`help environments`の「使い所: undefined」表示と、`checkpoint run`・`resource run`の`--json`を`--`の後ろに示していた使い方表示も直しました。トピック名は変わりません。
- Desktop Cloudで受付不明の送信・プロジェクト割り当てが残ると、以後の送信・`thread assign`が永久に拒否される問題を修正しました。Desktopのプロフィール状態で割り当てを確認できた記録は自動で確定します。確認できない記録は、ユーザーが`history mark <TASK> <MESSAGE-ID> --resolve-unknown --note TEXT`または`thread receipt <ATTEMPT> --resolve-unknown --note TEXT`で理由を残して解除できます（`--supervisor`付きは`SUPERVISOR_CONTROL_FORBIDDEN`）。記録がないことを未配送の証拠にはしません。解除した送信は、結び付いた指摘でも受付不明として扱いません。拒否エラーには解除対象の`existing_message_id`・`existing_attempt_id`を含めます。
- ローカルの`send`が、`--`より前の未知のオプション（`--kidn`などの打ち間違い）を本文として送っていた問題を修正し、`OPTIONS_INVALID`で拒否するようにしました。`--`より後ろは従来どおり本文です。
- ローカルの`resource`で、`--supervisor`付きの`acquire`・`renew`・`release`・`status`・`list`が監督状態を確認していなかった問題を修正しました。`--supervisor`付きは`--thread`が必須になり、停止済み・別セッションは拒否、一時停止中は`acquire`・`renew`・`run`を`SUPERVISOR_PAUSED`で拒否します。
- ローカルタスクへの`diff`が送信の省略形として解釈されていた問題を修正し、接続前に`OPTIONS_INVALID`で拒否します。
- コードを持たなかった利用者向けの失敗に、エラーコードを付けました（`OPTIONS_INVALID`、`MESSAGE_NOT_FOUND`、`CHECKPOINT_NOT_FOUND`、`INSTRUCTION_NOT_REPLACEABLE`、`RESOURCE_NOT_OWNED`、`TASK_IDLE`、`TASK_BUSY`、`DESKTOP_START_UNSUPPORTED`、`DESKTOP_ALREADY_RUNNING`、`DESKTOP_START_FAILED`、`DESKTOP_UI_NOT_READY`、`DESKTOP_UI_FAILED`、`CURSOR_TOO_LARGE`、`STORE_UNSAFE`など）。実行中のターンがない送信と、idleでないタスクへの`--new-turn`は、`NOT_SENT`ではなく`TASK_IDLE`・`TASK_BUSY`になります。中断したローカルの`checkpoint run`・`resource run`は`error_code: CANCELLED`を返します。

## 0.18.2 — 2026-11-01公開

- 停止済みの監督IDが、別の監督への交代後に古い本文から再登録できる問題を修正しました。停止履歴を監督記録に保持し、登録前のdoctor・再登録・観測・送信で`SUPERVISOR_STOPPED`を返します。旧形式の停止済み記録も、交代時に履歴へ引き継ぎます。保存済み旧CLIを使う監督には、更新後のCLIでプロンプトを生成し直してください。
- 同じ監督IDの別タスクへの登録を拒否します。既存データでIDが重複している場合も`supervise list --json`は全件を返し、`session_conflict.thread_ids`と、他タスクの観測記録を除外した項目の`observation_error`で衝突を示します。各タスクの`supervise stop`で停止できます。

## 0.18.1 — 2026-10-31

- ローカルロックの保持者と回収者が続けてクラッシュした後、`RECORD_BUSY`から自動回復できなくなる問題を修正しました。回収処理にもPIDと世代トークンを持つロックを使い、生きた保持者・回収者の排他を維持します。
- 更新前に、同じ`CODEX_HOME`を使う旧版CLIの操作と、保存済み旧CLIで動く監督を終了してください。旧版と修正版の回収方式を混在させることはできません。残った旧`.recover`ディレクトリは修正版の動作を妨げません。更新後に監督を起動し直すか、プロンプトを生成し直してください。

## 0.18.0 — 2026-10-29公開

- `thread repair <THREAD>`で古いターンの終了記録欠落を検出します。明示的な`--apply`はCodexの完全終了・検証済みバージョンを必須とし、バックアップ後に対象IDの中断記録だけを追記・照合します。既存の会話やDBは書き換えず、最新の未完了ターンは修復しません。
- macOS向けに`desktop update`と`desktop update-status`を追加しました。独立したworkerが公式更新UI（英語・日本語）を操作し、新ビルドと再起動を確認してから共有wrapperを再適用・検証します。外部NodeとターミナルのAccessibility・Automation権限が必要です。

- native/control/pairedのリモート経路、専用端末鍵の登録・ペアリング、ホストを保持する観測・監督に対応しました。
- リモートのプロジェクト・タスク一覧、指定ターンへの送信、Desktopによる作成・new-turn、checkpoint/resource実行とorchestrationを追加しました。
- 配送・実行結果が不明な場合は自動再送せず、pause/stopと指摘の重複防止を維持します。full-accessのthread-shellは明示選択が必要です。
- 準備後の監督付きシェル送信をpause/stopと排他し、RPC応答後に制御ロックを解放します。help・文書も実装に揃えました。
- リモート操作の手順と検証の集計を追加しました。リモートのUI送信・ホストのプロセス管理・履歴修復は未対応です。
- POSIXパスの大文字小文字を保持し、CLIの宛先はオプション値ではなく位置引数から選択します。監督の制御は登録時のtransportと一致する場合だけ受け付けます。
- リモート作成の再照合失敗時は古い認定フラグを除去してreceiptへ記録します。実行RPCの内部エラーでは実行済みの可能性を保持し、resource leaseを解放しません。

- Cloud監督の登録前診断と、初回配送の受付不明を共通履歴から照合・回復できるよう修正しました。本文・client IDが一致する保存証拠だけを採用し、自動再送は行いません。

- Desktop Cloudの所属確認をdoctorへ追加し、プロジェクト一覧と環境一覧を分離しました。署名付きのthread assignは実環境・nonce・署名・保存結果を照合します。そのDesktop実行環境への結合が必要で、通常のCloud環境の拒否を成功扱いしたり別環境へ置き換えたりしません。作成後のタイトル設定・初回配送失敗時にも通常表示へ作成済みIDと復旧情報を残します。

- Desktop Cloudの環境構成一覧・新規作成・継続送信・共通監視を追加しました。初回送信にも選択済み環境と遅延起動指定を保持します。環境選択とDesktopプロジェクト所属を区別し、所属登録が確認できない`--project`作成は事前拒否します。受付不明の自動再送は行いません。

- Cloudの重複拒否で前回の試行IDを今回の配送履歴へ結び付けないよう修正しました。回復用IDを分離し、history checkは今回の本文・親ターンも照合して、拒否した指示の誤有効化を防ぎます。作成用--env別名を削除し、環境指定は--projectに統一しました。新規作成の本文がCloud ID/URLで始まっても、それを宛先と誤判定しません。

- 共通Cloud観測で公開commentaryの途中経過を保持し、途中経過だけの更新でもMonitorへ通知します。reasoning等の非公開内容は除外し、`--backend app-server`を宛先より前に置く場合のCloud振り分けも修正しました。

- Cloudタスクも共通の`supervise`・`read/watch`・`send`・`history/instructions/findings`で扱えます。監督の登録・pause/resume/stop・保存済みCLI・Monitorのdigestと復帰待ちを既存基盤へ接続し、実行中の指定ターンの中断と同一タスク内での継続、配送照合を追加しました。旧Desktop CLIとの記録互換性を保つCloud専用監督名前空間を使います。

- Cloud環境・タスクの一覧と新規作成は`--connection cloud projects list`・`threads list`・`thread create`で扱います。作成試行は`thread receipt`、配送照合・予約回復は`history show/check --attempt`、試行を選ぶ差分取得は`diff --attempt`に統一しました。重複サブコマンドと専用のカーソル・watch処理を削除し、結果不明時の自動再送は行いません。公式CLIの診断は私有一時領域で処理し、ローカル差分を暗黙に送信・適用しません。

## 0.17.0 — 2026-10-15公開

- `projects list`と`thread create --project`を追加しました。プロジェクト名と初回指示だけで作成でき、既存チャット・`CODEX_THREAD_ID`・中継AIは不要です。App Serverで作成・Desktop購読・初回配送を行い、新規チャット自身の実在IDからnative RPCで所属登録し、全フォルダと初回指示を照合します。明示的な`--context-thread`は任意で、従来のnative直接作成を使います。配送不明・部分成功を保持し、自動再作成・再送を行いません。

- 内部RPCエラー（`-32603`など）では作成・配送が実行済みの可能性を保持し、`unknown`として記録します。メソッド・引数エラー（`-32601`/`-32602`）だけを実行前の拒否として区別し、自動再作成・再送は行いません。

## 0.16.0 — 2026-09-21公開

- `supervise`と`supervise prompt`に`--use-path-cli`を追加しました。指定時はPATH上の`codexteer`を使うコマンドを本文に出し、CLIのコピー・NodeとCODEX_HOMEの固定を行いません。監督ID・接続方式と既存の監督制御は維持します。既定は従来どおり保存済みCLIを使います。
- Codex同梱CLI 0.155系列が作る保護ソケットへの公式シンボリックリンクに対応し、`desktop start`・共有接続・観測専用接続が`RUNTIME_UNSAFE`等で拒否される問題を修正しました。固定ディレクトリ、パスのハッシュ、所有者、権限、実ソケットを検証し、任意のリンクは引き続き拒否します。起動済みwrapperも更新後のCLIから利用でき、保存済み監督CLIにはプロンプトの再生成・監督の再起動で反映します。
- `watch --stream`の既定を`digest`へ変更します。通常の進捗は20秒のsettle、読み取り専用コマンドなどは最長10分の保留でまとめ、ユーザー入力・注意状態・ターン・質問・読み取り専用以外の失敗は即時通知します。`--notify all`を明示すると従来の即時出力に戻せます。単発の`watch`と保存済みCLIの動作は変わりません。
- `--settle-ms`と`--max-hold-ms`で待ち時間を調整できます。初回の読み取りは基準として扱い、実行中コマンドの出力だけの更新ではsettleを延長しません。保留分は接続断・終了時にも排出し、ページ途中の場合だけ`has_more:true`を保持します。200件／64KBはページ読了後の排出目安です。
- 監督プロンプトを方針先頭の8節へ整理し、既定方針に設計上の責務と作業の焦点を追加します。設計上の責務では、事実・計算・判定を設計がどの層やシステムの担当と定めているかを先に確認し、別の層での検算や再計算など、同じ事実の持ち主が二つになる実装を観測します。基準は複数のリポジトリにまたがる設計の全体とし、分担が示されていない場合は推測せずユーザーに確認します。開始時の`help monitor`の重複読み取りをなくし、通知の読み方・無操作時の応答・Monitor期限切れ・議論の送信を明示します。生成する監視コマンドは`--notify digest`を明示します。

## 0.15.1 — 2026-09-13公開

- ページ履歴に対応するタスクへの`send`・`send --new-turn`は、本文を含まないターン状態を分割取得して送信前に確認します。長いタスクの全履歴が64 MiBを超え、観測はできても送信準備だけ失敗する問題を修正しました。`--based-on`等の安全確認は維持します。
- 64 MiBの受信上限を超えた場合は`PAYLOAD_TOO_LARGE`を返します。上限は維持し、送信前の`not_sent`と受付未確認の`unknown`を区別します。
- runtime protocolとcapability契約はv1を維持します。0.15.0で起動済みのDesktopを再起動せずに操作できます。起動済みの監督は保存した旧CLIを使うため、修正版を使うには監督を起動し直すか、プロンプトを生成し直してください。

## 0.15.0 — 2026-09-12公開

監督の一時停止、指摘の重複抑制と検証結果の追跡を追加する機能リリースです。

- `supervise <THREAD> [MESSAGE]`と`supervise prompt <THREAD> [MESSAGE]`で、必須の操作テンプレートを保ったまま監督方針を置き換えられます。
- `supervise status / list / pause / resume / stop`で監督の登録・観測・配送状態を確認し、Codexタスクを止めずに介入を制御できます。
- `findings`で指摘・解決条件・根拠・メッセージ・checkpointを関連付け、対応申告と検証を区別します。入力や検証結果が変われば再確認を求めます。
- 同じ指摘の同じrevisionへの重複送信を拒否し、有益・不要・誤り・未評価を集計します。受付不明の送信は自動再送しません。
- `--agent codex`でCodex CLIを監督役として起動できます。既定はClaudeです。
- `--connection desktop`で、既存の共有制御ソケットを使った観測専用接続を選べます。送信は既存の`shared`方式を使います。
- 保存済みCLI・canonical `CODEX_HOME`・監督ID・接続方式を同じ実行コマンドに固定し、古い監督や意図しない接続変更を拒否します。

### 互換性・確認範囲

- 製品バージョンを`0.14.1`から`0.15.0`へ更新します。runtime protocolと既存のcapability契約はv1を維持します。版の不一致だけを理由に接続を拒否しません。
- 新しい監督制御は0.15.0で生成する監督ID付きコマンドが対象です。以前に保存したCLIとIDなしの手動送信は既存の挙動を維持します。
- 直接接続はソケットが存在し、対象がロード済みの環境に限ります。Desktop・daemonの再起動や別接続への自動切り替えは行いません。
- 直接接続のUnixプロトコルは同梱CLI 0.153.4と隔離した合成履歴で検証しています。実Desktopでの直接接続・画面表示・承認継続は未検証です。

## 0.14.1 — 公開済み

`codexteer`名で公開した版です。監督CLIの永続配置と`CODEX_HOME`固定、操作ごとの互換性判定、観測APIの診断を含みます。監督制御・指摘管理・方針上書き・Codex CLI起動・観測専用の直接接続は0.15.0で追加しました。
