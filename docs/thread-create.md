# Desktopプロジェクトにチャットを直接作成する

`projects list`でローカルプロジェクトを確認し、`thread create`で初回指示付きのチャットを作成します。Desktopのnative RPCを使い、中継AIは実装から削除しました。「競馬」のような複数フォルダ・共有フォルダを持つプロジェクトにも対応します。

```bash
codexteer projects list --json
codexteer thread create --project '競馬' \
  --title '関連リポジトリの調査' '関連リポジトリを読み、結果を報告してください' --json
codexteer thread create --project '競馬' \
  --dry-run '調査してください' --json
```

**プロジェクト名と初回指示だけで作成できます。`--context-thread`も`CODEX_THREAD_ID`も不要です。** 既存チャットがないプロジェクトでも使えます。既存チャットを探したり、別のAIを起動したりせず、作成したチャット自身の実在thread/turn IDでnative所属登録を呼びます。

`--context-thread`を明示した場合だけ、その既存チャットの保存済みターンを関連付けてnative `create_thread`を呼びます。idleでも使用できます。呼出し元への送信や追加のAIターンはありません。省略時は環境変数`CODEX_THREAD_ID`も参照せず、独立した作成になります。

プロジェクト名は完全一致で選び、同名なら`projects list`のIDを指定します。App Serverのcanonical IDとDesktop IDは読取り専用の対応表・native一覧で照合します。同名のChatGPTプロジェクトは選択しません。cwdだけで所属を推測しません。

## 作成と所属登録

標準経路は次のとおりです。

```text
terminal CLI → App Server thread/start（選択プロジェクトの全フォルダ）
  → Desktopの長期接続で購読 → turn/start（初回指示を1回だけ送信）
  → 共有App Serverのcommand/exec（追加のthread/turnを作らないAPI）
  → 固定の署名付きNode helper（read-only sandbox）
  → native tools/call move_thread_to_project（新規チャット自身）
  → Desktopの所属サービスで登録・表示更新
```

App Serverはnative操作用にcodexteer同梱の固定helperだけを起動します。native引数は所有者専用の一時JSONファイルで渡し、shellやargvへ埋め込みません。helperの許可操作はcatalog、list_projects、固定上限のlist_threads、ローカルcreate_thread、新規チャット自身のmove_thread_to_projectだけです。新規チャットの初回処理以外のモデル推論は発生しません。

作成前に、実行中サーバーと同じ同梱CLIからcommand/execとread-only sandboxのschemaを確認します。helperはDesktopのpeer認証を通過する署名付きApp Serverの正規の子として実行されます。Unix socketへ接続するためsandboxのnetworkAccessはtrueですが、helperにHTTP/DNSや外部サービスへの接続処理はありません。認証チェックや署名は変更しません。

codexteerは選択プロジェクトからプライマリcwdと全workspace rootsを解決します。名前とcanonical所属をAPIで保存し、Desktopの購読を確立します。初回指示の前に範囲と空の履歴を確認します。初回受付後、Desktopのnative所属サービスを呼び、スケジュールと同じ所属ストアと表示へ反映します。作成応答だけを成功の証拠にせず、Desktop native一覧のthread ID・local host・Desktop project ID、canonical projectId、全フォルダ、userMessageとして保存された初回指示の完全一致とタイトルを照合します。旧global stateファイルの`thread-project-assignments`だけを現在の所属とはみなしません。関連付けを明示したnative作成の場合は、`codex_delegation`の呼出し元IDと本文を含むliteral全文を比較します。XMLとして解釈しません。

受付が履歴の永続化より早い場合は、最大5秒間、読取りだけで反映を待ちます。作成や初回ターンを再実行しません。standaloneではcanonical所属をthread/startで指定し、購読前にmetadata APIでも保存します。関連付けを明示したnative作成では必要に応じてmetadata APIでcanonical所属を登録します。Desktopの状態ファイル・DBを直接書き換えません。

CLI終了後の承認はDesktopが担当します。codexteerは承認を自動回答しません。

## 設定と接続の制約

- `--title`、`--model`、`--thinking`を明示指定できます。standaloneで指定しないモデル・権限・承認はプロジェクトのApp Server設定に従います。他チャットの設定を継承しません。関連付けを明示した場合はDesktopのnative作成規則に従います。
- standaloneで`--title`を省略すると、初回指示の空白をまとめた先頭80文字を名前にします。タイトル生成用のAIは起動しません。対象サーバーでは未使用の空チャットをDesktopが購読するために、先に名前を保存して履歴を永続化する必要があります。
- cwd・permissions・sandbox・approval policy・approvals reviewerの上書きはnative schemaにないため、指定すると作成前に拒否します。
- `--via-thread`のAI中継経路は削除しました。自動fallbackもありません。
- 対応先は登録済みローカルプロジェクトです。worktree、remote、ChatGPT cloudは未対応です。
- `--timeout-ms`は各RPCの待機期限で、既定120000、1000〜600000です。
- `--dry-run`は接続・プロジェクト・native schemaを読み、チャット・指示・receiptを作りません。

native RPCはDesktop内部のversion依存APIです。この実装の実測はDesktop `26.1007.30912`と`26.1007.71326` / 同梱CLI `0.162.0-alpha.17.2`です。未対応schema、unsafe socket、変更されたendpoint、認証拒否では止めます。

wrapperはnative endpointを所有者専用runtimeに公開します。公開されていない旧wrapperでは、選択済み・所有者検証済みPIDと同梱Node実行ファイルを確認し、継承環境のnative endpointだけを取得します。環境全体を出力・保存しません。

作成処理は既存の共有App Serverのcommand/execを使うため、専用control serviceの追加・native_tools_rpcフラグ・追加のDesktop再起動を必要としません。wrapper自身からnative接続する旧経路と、外部Nodeがnative workerを直接起動する経路は削除しました。通常の`codexteer`コマンドがそのまま使えます。

`--dry-run`でもschemaと要求JSONの一時ファイルを作成・削除します。チャット、追加AIターン、永続receiptは作りません。

## 配送不明と部分成功

作成前に`CODEX_HOME/codex-steer/creations/<attempt_id>.json`を所有者専用で保存します。standaloneのschemaは3、`creation_mode`は`standalone`、外部`context_thread_id`と`context_turn_id`はnullです。`native_context_*`は新規チャット自身の実在IDです。`native_call_id`は所属登録のcall IDでattempt IDと一致します。初回指示のSHA-256、所属ID、rootと名前を記録します。standaloneでは省略時の名前が初回指示の先頭80文字になるため、JSON出力・receiptの`title`にもこの文字列が含まれます。指示全文の専用フィールドやAI中継用のmessages journalは作りません。

- `creation_status: created`は既に子チャットが存在することを示します。照合失敗でも同じIDを調べ、作成を再実行しません。
- `sent: true` / `delivery_status: accepted`は初回ターンの受付です。後続の所属登録・照合やreceipt保存が失敗しても、この受付を取り消しません。standaloneでは所属登録前に指示が開始するため、所属登録失敗もcreated/acceptedとして保持します。
- `creation_status: unknown` / `dispatching`は未作成の証拠ではありません。接続断・時間切れ・不明応答で自動再送しません。
- `verification_status: verified`と所属・初回指示の個別verifiedが、照合完了の証拠です。
- 最終receipt保存だけ失敗した場合は`receipt_update_required`を返します。受付済み操作を再送可能な失敗に変換しません。

## 作成済みreceiptの再照合

```bash
codexteer thread verify <ATTEMPT-ID> --json
```

`creation_status: created`、`sent: true`、`delivery_status: accepted`を持つschema 2/3のreceiptを、同じCODEX_HOMEで再照合します。作成・購読・移動・metadata更新・指示送信は行いません。新しいthread/turnやAI処理も発生しません。更新するのはcodexteer自身のreceiptだけで、以前の照合状態・エラーと今回の全チェックを`verification_history`へ残します。unknown/dispatching/未受付をこのコマンドで成功扱いにはしません。

Desktop native所属、現在のプロジェクトID対応と全フォルダ、threadのcanonical所属・cwd・全フォルダ・指定タイトルに加え、保存された初回本文のSHA-256とUnicode文字数をreceiptと比較します。standaloneでは初回turn IDも一致が必要です。初回本文を再度渡す必要はありません。関連付けを明示した場合は既知の呼出し元を含むliteral envelopeから本文を取り出し、XMLとして解釈しません。

native一覧はDesktopの実schemaに従い最新50件と全pinnedです。対象が見つからない、別host/projectに所属する、重複して見える、schemaやruntimeが変わる場合は成功と推測しません。失敗の`verification_checks`を確認してください。`--timeout-ms`は各RPCの期限です。`--supervisor`と観測専用の`--connection desktop`からは実行できません。保存済みCLIは変更しないため、この機能には修正版CLIが必要です。

## 所属照合の修正と実Desktop再検証 (2026-10-17 JST)

Desktop `26.1007.71326`で、作成済みthread `01a1452d-ea18-78c0-9fca-b0af4e15d759`のnative一覧は`codex-steer`のDesktop ID `8b8c19b2-5a36-4683-8b2f-28a489e03724`を返す一方、ディスクの旧所属mapにはエントリがありませんでした。canonical ID、全フォルダ、初回指示、名前は全て一致し、旧mapだけに依存する`desktopMembership`がfalseを返して`CREATION_VERIFICATION_FAILED`になっていました。native現在値へ照合先を変更し、canonical所属の独立したチェックを維持しています。

同じattempt `5004b3ed-5776-4e49-ac4f-51a5d022ab3d`へ通常の`codexteer thread verify`を実行し、exit 0、全10チェックtrue、保存receiptのverifiedを確認しました。thread ID・初回turn ID・初回client ID・本文SHA256は保持され、初回指示は1件、既存2ターンは両方completed、threadはidleのままです。重複作成・初回再送・所属移動は行っていません。以前の作成コマンドの失敗記録も保持しています。

## 実機検証 (2026-10-14 JST)

- 直接作成と承認: `01a135f5-85aa-7410-a0cf-1a0eed53037f`、attempt `b7479787-a995-4566-a1d0-5f05a8bc6035`。native CLIは終了済みでもDesktopで`waitingOnApproval`が継続。Desktop一覧のprojectIdは「競馬」の`ad16728e-81d9-499f-81c8-fdf13f0f9d89`。初回commentaryに`CODEXTEER_NATIVE_INITIAL_INSTRUCTION_OK`。
- ユーザーの「今回だけ承認」後、`printf CODEXTEER_NATIVE_APPROVAL_OK`がexit 0、最終応答`CODEXTEER_NATIVE_APPROVAL_ROUNDTRIP_OK`を確認。
- この最初の試行は受付直後の履歴照合が早すぎ、CLIがcreated/acceptedの部分成功を返した。反映待ちを修正し、同じ子ID・同じattemptを読み取り照合してreceiptを確定。再作成・再送していない。
- 修正後CLI全体: `01a135f9-3974-7983-a756-5d6b31968fd0`、attempt `daf87c13-7df3-45b0-acb6-4e7ea56f32ef`。Desktop所属・canonical所属・7フォルダ・初回指示・タイトルの照合を完了しexit 0。最終応答`CODEXTEER_NATIVE_CREATE_VERIFIED`。
- contextは`01a135b4-b84b-7530-9c25-5bde83077c9e`の既存completedターン。終了後もidle、turn数1、latest turnは`01a135b4-bac5-7f62-9014-d109c5a37b92`。中継AIターンは発生していない。
- 稼働中wrapperを中断しないため、実Desktopの作成試験は同梱NodeでCLIを直接実行した。当時のcontrol経路はローカルsocket試験までで、その後の実機確認で修正しました。現行経路と結果は次節を参照。

これらは特定Desktop/CLIの実測で、将来のリリースや全承認種別の認定ではありません。[調査時の経路とコード根拠](thread-create-native-investigation.md)も参照してください。

## 再起動後の通常CLI検証 (2026-10-15 JST)

Desktop `26.1007.71326` / 同梱CLI `0.162.0-alpha.17.2`で実測しました。

- 最初の再起動後、旧native_tools_rpc:1のwrapper自身の接続は`missing-code-signing-identity`で拒否され、dry-runで停止。チャットは作成していません。
- 接続元の起動経路を修正し、既存App Serverのcommand/execから固定の署名付きhelperをread-only sandboxで起動する方式に切り替えました。追加の再起動なしで通常CLIのdry-runが成功しました。
- 通常の`codexteer thread create --project 競馬 --context-thread ...`がexit 0。作成IDは`01a13e01-2d5a-7bc2-a752-dbdddda9d1ea`、attemptは`68b4064b-eabc-444b-8607-935e66ebbb62`です。Desktop一覧の「競馬」所属、canonical所属、7フォルダ、タイトル、初回指示を全てverifiedで返しました。
- 初回commentaryに`CODEXTEER_STANDARD_CLI_INITIAL_OK`、printfがexit 0、最終応答`CODEXTEER_STANDARD_CLI_ROUNDTRIP_OK`。この時のDesktop設定はauto_reviewでした。
- 手動承認は同じ検証チャットだけをapprovalsReviewer:user / on-request / read-onlyへ変更した後続ターン`01a13e03-559a-7f12-9d9f-2d7650c52ae8`で確認しました。他チャットやプロジェクト設定は変更していません。
- このターンの短命senderは`2026-10-15T05:22:48.359Z`に終了し、その後もDesktopのwaitingOnApprovalが継続。ユーザーの「今回だけ承認」後、`printf CODEXTEER_STANDARD_CLI_HUMAN_APPROVAL_OK`がexit 0、最終応答`CODEXTEER_STANDARD_CLI_HUMAN_ROUNDTRIP_OK`を確認しました。
- 呼出し元`01a135b4-b84b-7530-9c25-5bde83077c9e`は元のcompletedターン1件のままです。中継AIや追加ターンは発生していません。

## 回帰・配布検証

native直接作成の時点では`npm run check`成功、`node --test --test-concurrency=1`は320件中318成功・2skip・失敗0。配布テストもPASSで、76ファイルのpack、publish dry-run、offline install、npm/npx起動を確認しました。公開は行っていません。

並列実行では既存checkpointのファイル監視テストが一度失敗しました。同テストの単独実行と全体の逐次実行は成功しています。今回のnative helper関連テストは全て成功しています。

## 呼出し元なし・最小引数での検証 (2026-10-15 JST)

`env -u CODEX_THREAD_ID codexteer thread create --project 競馬 '初回指示' --json`で実測しました。`--context-thread`、`--title`、モデル・権限上書きは指定していません。

- 最終CLIはexit 0。threadは`01a13e22-e9db-71a3-b0d2-703586bf84d5`、attemptは`ed2dc9ec-ac30-445c-9586-dbfcd336179e`。Desktopの「競馬」所属、canonical所属、全7フォルダ、初回指示と名前がverifiedです。
- `context_thread_id` / `context_turn_id`はnull。native所属登録のcontextは新規thread自身と、その実際の初回ターン`01a13e22-ebfa-7541-b7a1-789676672435`です。既存チャットの読取りやAIターンは不要です。
- 初回ターンはcompleted、最終応答`CODEXTEER_PROJECT_PROMPT_ONLY_FINAL_OK`。初回指示は通常のuserMessageとして完全一致し、作成時に開始したターンはこの1件だけです。
- タイトル未指定の試験で、初回ターン前の未保存チャットはDesktop購読やmetadata保存を拒否される条件が見つかりました。名前を先にAPIで保存し、canonical所属を保存してから購読するよう修正しました。途中の2試行はcreated/not_sentのreceiptを保持しています。`95bdf33c-7580-40da-90e2-a2882f4b83af`は履歴0件を確認してアーカイブしました。`cf88c307-7e8d-4140-a074-ed25fa551916`は作成後の読取りをAPIが拒否したため状態を断定せず、receiptを保持しています。いずれも初回指示の送信前で停止し、再送していません。
- 承認試験は同じ最終チャットの後続ターン`01a13e23-e670-7e60-8107-5317fbbca458`のみをuser/on-request/read-onlyにして実施。作成時のDesktop購読を再利用し、新たな購読は行っていません。短命senderは`2026-10-15T05:58:22.584Z`に終了し、その後もDesktopでwaitingOnApprovalが継続しました。ユーザーの「今回だけ承認」後、`printf CODEXTEER_STANDALONE_HUMAN_APPROVAL_OK`がexit 0、最終応答`CODEXTEER_STANDALONE_HUMAN_ROUNDTRIP_OK`、ターンcompletedを確認しました。所属・7フォルダ・初回指示も再照合し、同じattemptのreceiptをhuman_approval_roundtrip:verifiedへ更新しました。
- 全体の逐次テストは327件中325成功・2skip・失敗0、`npm run check`と`git diff --check`も成功しました。sandbox内のNode 25によるUnix socket試験は実行環境のassertで終了したため、ローカルsocketを許可した環境で実行・確認しました。
- 更新後の配布テストもPASS。77ファイルのpack、publish dry-run、offline install、npm exec/npx、保存CLIと混在バージョンの回帰を確認しました。公開は行っていません。

## PRレビューでの修正 (0.17.0公開候補)

内部RPCエラーを実際の`RpcFailure`型で模擬すると、処理が実行された可能性があっても`not_created` / `not_sent`になる問題が再現しました。内部エラー（`-32603`など）は`unknown`を保持し、メソッド・引数エラー（`-32601` / `-32602`）だけを実行前の拒否として扱うよう修正しています。standaloneの作成・初回配送、native helperと明示的context作成の回帰テストを追加しました。未確認の操作を自動再実行する処理は追加していません。

公開前の全回帰で、既存のcheckpoint試験がmacOSの監視通知の到着順に依存して失敗することを変更前のmainでも確認しました。edit-and-restore試験は監視イベントまたはスナップショットのメタデータ差分で対象ファイルの変更が検出されたことを確認し、無効化されるという契約を維持しています。checkpointの実装は変更していません。
