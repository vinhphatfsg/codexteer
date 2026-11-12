# Changelog

公開日は日本時間です。

## 0.25.0 — 未公開

Desktop Cloudの担当は、ターンの実行中は開始時の指示しか読めません。その間の発言・コマンド・質問・承認待ちは、ターンが終わった後にまとめて現れます。codexteerはこの間も`attention`を空で返していたため、Codexの画面で質問が待っていても「待っているものはない」と読める結果になっていました。

- Desktop Cloudでターンが実行中の担当は、`project sync`の担当行、`status`、`read`、`watch`（`--stream`を除きます）に`attention_coverage:"running_turn_unobserved"`を持ちます。そのターン中の質問・承認待ち・進捗を観測できていないことを示します。ターンが実行中でないと確認できない担当にも付きます。全てのターンが終わったと確認できた担当には付きません。`attention`・`group`・`complete`など既存の値は変わりません。
- `project sync`の全ページと`project wait`の全ての結果（timeoutを含みます）は、その担当を`attention_unobserved:[{thread_id, attention_coverage}]`に並べます。該当する担当がいなければ付きません。ページ本体の外に付き、`output_bytes`とbyte budgetには含みません。
- ターン中に出た質問は、ターンが終わると従来どおりwaitが返し、担当行は「対応が必要」になります。
- `work tell`は、実行中のDesktop Cloudターンに送るときも送信の可否を変えません。質問・承認待ちを観測できなかったことを、receiptの`attention_coverage`で示します。
- Desktop Cloudの`doctor`は、この接続の制限として`running_turn_attention:"unobserved"`を常に返します。`approval_roundtrip`とは別の項目です。
- オーケストレーター本文は、この印の付いた担当について「待っているものはない」とユーザーへ伝えず、Codexの画面で確認が必要だと伝えるよう指示します。

Desktop Cloudのスレッドは、最後のターンが終わった後も`status`が`active`のまま残ることがあります。codexteerはその担当を「動作中」と表示し、停止済みでも`settled`にせず読み続けていました。

- Desktop Cloudの担当の`execution`は、ターンの状態（最新ターンの状態と実行中ターンの数）で決めます。実行中のターンがあれば`active`、全てのターンが終わっていれば、スレッドの`status`が`active`でも`idle`です。最後のターンが`completed`なら「検収待ち」、`failed`なら「対応が必要」になります。
- スレッドの`status`と食い違うときはターンの状態を採ります。その行の`reason`は、`backend_status`（スレッドの`status`）と`execution_basis:"turn_status"`・`latest_turn_status`・`active_turn_count`を持ちます。ターンの状態が欠けているか矛盾するときは、スレッドの`status`のままです。
- `project control stop`したDesktop Cloudの担当は、スレッドの`status`が`active`のままでも、全てのターンが終わり承認・質問のフラグが空と分かれば`settled`になります。
- idleの担当を`settled`にするのは、全てのターンが終わったと確認できた場合だけになりました。実行中ターンの数が0でも最新ターンが実行中か状態不明の担当は、どの接続でも読み続けます。これまでは`settled`になることがありました。
- shared・Web Cloudの担当の`execution`は変わりません。

サーバーが要求を拒否したエラー（`RPC_REJECTED`）は、JSON-RPCのcodeだけを返し、サーバーのmessageと`data.reason`を捨てていました。過負荷（-32001）やサーバーの停止中（-32600、`serverShuttingDown`）のような一時的な拒否を、結果から見分けられませんでした。

- `RPC_REJECTED`のエラーは、`--json`の`error`に`rpc_code`に加えて`rpc_reason`と`rpc_message`を返します。`rpc_reason`は`data.reason`が短い識別子のときだけ、`rpc_message`は読み取り（`thread/read`・`thread/turns/list`など）の拒否のときだけ返します。`--json`なしでは`rpc: CODE REASON: MESSAGE`の行を出します。
- `rpc_message`は1行・300バイトまでに切り詰め、認証情報に見える長い文字列を伏せます。指示文や題名を含む要求（送信・作成）の拒否では、サーバーが要求を引用しうるため`rpc_message`を返しません。エラー本文（`message`）は変わりません。
- `project sync`と`project wait`の担当行は、サーバーが読み取りを拒否した場合に`error_detail`（`rpc_code`・`rpc_reason`・`rpc_message`）を持ちます。byte budgetに収まらず詳細を省いた行では`rpc_code`と`rpc_reason`だけです。
- `doctor`の`failure`も`rpc_reason`と`rpc_message`を返します。
- どのエラーを再試行するかは変わりません。

`project wait`が、1回だけ読み取りに失敗した担当を`observation_failed`で返していました。担当が多く長く続くprojectでは、すぐ後に読める担当の失敗のたびにオーケストレーターが起こされていました。

- `project wait`は、同じ担当が2回以上の照会で続けて読めず、最初の失敗から60秒以上経ったときにだけ、その担当を`observation_failed`で返します。1回の読み取り失敗は担当の状態を示さず、次に読めたときにcursor以後の出来事を受け取れるため、返しません。同じ照会が他の理由で返る場合は、その結果の`unreadable`で`reported:true`にし、`observation_failed`では返しません。この経過はtimeoutや他の理由で返った後に再開したwaitにも引き継ぎ、途中でwaitの照会が完全に読めれば数え直します。通常のsyncが読めただけでは数え直しません。
- 報告した担当は、エラーcodeが変わっても、waitの照会が途中で読めた後に再び失敗しても、再び返しません。waitの結果か通常の`project sync`がその担当を完全に読めた状態で示した後に、読めない状態がまた続いた場合に、新しい失敗としてもう一度報告します。
- 全ての結果の`unreadable`は`[{thread_id, error, reported}]`になりました。`reported:true`の担当は、次に読めるまで監視されていません。`reported:false`の担当は直近の照会で失敗しただけで、waitは読み続け、読めない状態が続けば報告します。他の理由で返る結果が続いても、最初の失敗から数え続けます。公開競合で返った結果の`reported`は、先に公開されたheadの記録を示します。
- 読めた担当の変化は、他の担当が読めない間も従来どおり返します。全ての結果の`unreadable`は、従来どおり直近の照会で読めなかった担当を並べます。`initial_sync`・`membership_changed`・`work_changed`・公開競合・`owner_exited`・timeoutと終了値は変わりません。

最後のターンが未回答の質問や失敗で終わった停止済みの担当を、syncとwaitが毎回読み続けていました。停止済みの担当には誰も回答しないため、この状態は終わらず、projectが長く続くほど読む担当が増えていました。

- `project control stop`した担当は、停止後の完全な観測で終了済みか実行中ターンのないidleで、承認・質問のフラグが空と分かれば、未解決attentionが残っていても`settled`になり、次のsyncから読みません。`settled`にする回の担当行がその質問・失敗を`attention`と`events`で示し、以後の行も同じ未解決attentionと根拠のイベントを再掲します。未解決attentionは消えません。承認・質問のフラグが立っている担当、ターン実行中の担当、フラグが不明な担当は、従来どおり読み続けます。
- waitの基準があるprojectの`complete:false`のsyncは、未解決attentionが残る担当を従来どおり`settled`にしません。その担当は、次にwaitが返した回か完全なsyncの回に、質問・失敗を示した行で`settled`になります。waitに返すべき質問を、読めない担当が残るsyncが先に消費することはありません。
- `settled`の担当の行は、「対応が必要」でも、今回読んだ全ての担当の行の後に並びます。読まなくなった担当の行が結果の最初のページを占めることはなくなりました。

履歴の上限（256 MiB）の確認が、観測したデータの8倍と1 MiBの空きを求めていました。実際に書く量の数倍にあたり、使用量が上限よりずっと少なくてもsyncとwaitが`PROJECT_HISTORY_LIMIT`で拒否されました。拒否されるとcursorが進まないため、次の実行は同じ履歴を読み直していました。上限に達した後は、人が`project prune`を実行するまで保存できませんでした。

- 上限の確認は、今回書くrecord（イベント・sync結果・担当詳細）の保存後のサイズを使います。recordが空きに収まるpublicationは保存されます。sync結果と担当詳細はcursorの更新後に確定するため、完全に読めた担当の行はcursorを進めた場合と更新が拒否された場合の大きい方で数え、確認を通ったpublicationが途中で容量不足になることはありません。
- recordが収まらない場合、sync・wait・`work start`はそのprojectの古い履歴を`project prune`と同じ基準で自動的に削除し、もう一度確認します。最新sync、最新のwait結果、未提示の初回結果、未解決attentionの根拠とそれらの参照先は、`project prune`と同じく保持します。他projectの履歴は削除しません。
- 自動削除をした結果は`history_pruned`を持ちます。`deleted`（`events`・`results`・`initial_payloads`の件数）と`reclaimed_bytes`で、syncとwaitではページ本体の外に付き、`output_bytes`とbyte予算には含まれません。自動削除の後、その時点の最新syncと最新のwait結果より古い結果のcontinuation tokenとevent tokenは使えません。
- `PROJECT_HISTORY_LIMIT`は、自動削除の後も収まらない場合に返ります。1回のpublicationが残りの空きより大きい場合と、保護対象がそのprojectの上限を占めている場合です。エラーの`storage_bytes`は自動削除後の使用量で、行った自動削除を`history_pruned`で返します。従来どおり何も保存せず、cursorも進めません。

同じ`CODEX_HOME`の全projectが、履歴の上限（256 MiB）、保存と整理の排他、整理の読み取りを共有していました。あるprojectの履歴が上限を占めると他projectのsync・wait・`work start`が`PROJECT_HISTORY_LIMIT`で拒否され、あるprojectの保存中は他projectの保存と整理が`RECORD_BUSY`で失敗し、あるprojectの壊れたrecordが他projectの整理と`work tell`を失敗させていました。

- 履歴（イベント・sync結果・担当詳細・work startの記録）は、projectごとに別の場所へ保存します。256 MiBの上限はprojectごとで、そのprojectが保存した量だけを数えます。保存と整理の排他もprojectごとで、別のprojectの保存・整理は互いを待たせません。
- `project prune`と自動削除が削除するのは、そのprojectの履歴だけです。他projectの保存場所は読まず、他projectの壊れたrecordで失敗することもありません。結果の形は変わらず、`storage_bytes`は整理後の、そのprojectの使用量です。`PROJECT_HISTORY_LIMIT`の`storage_bytes`も同じです。
- 0.24.x以前が保存した履歴は、新しい場所へ移さず元の場所のまま使います。tokenはどちらの場所のrecordでも使え、`project event`・`project sync --continue`・`work tell`・waitの結果の復元は従来どおりです。古い履歴はどのprojectの上限にも数えず、新しく書き足すこともないため、その総量は減る一方です。そのprojectの`project prune`と自動削除が、従来と同じ基準で古い履歴のうち自分のprojectのものも削除し、`deleted`と`reclaimed_bytes`に含めます。提示済み初回結果の重複全文は、従来どおり元の場所のrecordから削除します。古い履歴が残る間は、各projectの整理がその全体を読みます。読めない古いrecordは飛ばします。古い履歴の削除と書き換えは、0.24.x以前が保存に使う共通の排他を待たずに取れたときだけ行い、取れなければ今回は見送って次の整理で行います。0.24.x以前の保存中のrecordを消すことはなく、他projectを待たせることもありません。
- `project prune`と自動削除は、そのprojectのsync・waitが公開している途中（0.24.x以前の公開も含みます）は何も削除しません。公開途中のheadは未解決の質問を一時的に示さないため、その根拠を消すおそれがありました。`project prune`は`deleted`がすべて0の結果に`publication_in_progress: true`を付けて返し、上限に達した`work start`の保存と公開競合で返るsync・waitの保存は、`PROJECT_HISTORY_LIMIT`に`publication_in_progress: true`を付けて拒否します。公開が終わってから再実行してください。公開中のsync・wait自身の自動削除は従来どおりです。
- アップグレードの後、実行中の`project wait`を再起動してください。アップグレード前に始めたwaitは古いコードのまま動き続けます。
- 0.24.x以前に戻すと、このversionが保存した履歴は見えません。そのversionでは、このversionが返したtokenは見つからず、`work tell`は次の`project sync`まで`WORK_TELL_SYNC_INCOMPLETE`になります。このversionで始めた`work start`の記録も見えないため、同じ引数で再実行すると別の担当を作ります。戻した後は、`work start`を再実行する前に`project sync`でその担当がすでにprojectにいるかを確認してください。戻したversionが保存した履歴は、再びこのversionにしたときに古い履歴として使えます。

Desktop Cloudの`work start`と`thread create`は、常にCloudの既定モデルで担当を作り、初回ターンのエフォートを指定していませんでした。担当に使うモデルとエフォートを選べませんでした。

- `codexteer --connection desktop-cloud models select`（`models`だけでも同じ）は、現在のCloudのモデル一覧を読み、モデルと、そのモデルで使えるエフォートを端末で番号から選んで保存します。Enterは表示中の現在値を選びます。`models list`は一覧と保存値、`models show`は保存値を返します。`models set --model MODEL --thinking EFFORT`は対話なしで保存し、`models reset`は保存値を解除します。`select`は対話端末専用で、`--json`を付けられません。
- 保存先は`CODEX_HOME/codex-steer/settings/desktop-cloud-model.json`です。モデルとエフォートを一組で保存し、保存後の新しい`work start`と`thread create`が毎回読みます。再起動は要りません。既存の担当への送信と継続は、その担当自身の設定のままです。
- 作成時のモデルは、`--model`、保存値、Cloudの既定の順に決まります。エフォートは、`--thinking`、同じモデルの保存値、選んだモデルの既定の順です。`--model`／`--thinking`は今回の作成だけに効きます。決めた組は`thread/start`と初回の`turn/start`の両方に明示し、結果の`model_selection`（`model`・`thinking`・`model_source`・`thinking_source`）で返します。`thread create --dry-run`も現在の一覧と照合した`model_selection`を返し、作成・送信・receiptの保存はしません。
- `work start`は、発注を最初に保存するときの組をその発注の記録に残します。保存値を変えた後に同じ発注を再実行しても、最初の組で作成・照合します。同じ発注を別の`--model`／`--thinking`で再実行すると`WORK_START_CONFLICT`で拒否します。
- Desktop Cloudの`work start`が作成の要求を送る前に失敗した場合（接続の失敗、使えないモデルなど）、同じ発注の再実行は同じattemptで作成をやり直します。これまでは送信済みかどうかを区別できず、再実行が`WORK_CREATE_UNKNOWN`で止まり続けていました。要求を送った後の失敗は、従来どおり読み取りの照合だけで、作成を繰り返しません。
- 一覧にないモデル、そのモデルが対応しないエフォート、非表示のモデルは、保存も作成もせず`DESKTOP_CLOUD_MODEL_INVALID`で拒否します。別の組に自動で変えることはありません。一覧が不完全・矛盾している場合は`DESKTOP_CLOUD_MODELS_UNVERIFIED`、保存値が壊れている場合は`DESKTOP_CLOUD_MODEL_SETTINGS_INVALID`を返します。
- `select`をq・Ctrl-C・EOFで中止すると、保存値を変えず、「選択を中止しました。設定は変更していません。」と表示して終了値0で終わります。対話端末以外から実行すると`DESKTOP_CLOUD_MODEL_TTY_REQUIRED`を返します。
- 監督に紐づく実行（`--supervisor`）は`models`を使えません。詳しくは`help models`と`docs/desktop-cloud.md`を参照してください。

## 0.24.2 — 2026-11-11公開

読めない担当が残るprojectで、停止済みの担当のターン終了を`project wait`が返さないことがありました。

- ターン実行中に`project control stop`した担当のターンが終わり、次のwaitより先に通常の`project sync`がその担当を読むと、`complete:false`のsyncでもその担当を`settled`にしていました。waitは`settled`の担当を読まないため、そのターン終了は返りませんでした。`complete:false`のsyncでは、waitの基準以後に新しいターン終了・質問・失敗がない担当だけを`settled`にします。それ以外の担当と基準に載っていない担当は、次のwaitが変化として返した回に`settled`になります。waitの回、完全なsyncの回、基準のないprojectでは従来どおりです。

## 0.24.1 — 2026-11-11公開

0.24.0のnpmパッケージに同梱するはずの`ws`が入っておらず、起動時に`ERR_MODULE_NOT_FOUND`で止まっていました。0.24.1は0.24.0と同じコードに`ws`を同梱し直したものです。0.24.0は使わず0.24.1を入れてください。

## 0.24.0 — 2026-11-11公開

担当が多く長く続くprojectでも、読めない担当が1件あるだけで指示と監視が全体で止まらないようにしました。停止済みの担当は静かなことを確かめた後は読まず、tellは対象の担当だけで判定し、waitは読めない担当を一覧で返しながら他の担当の変化を通知します。異常終了したセッションのwaitは自分で終わり、`orchestrate resume`でStop hookを保ったままオーケストレーターを再開できます。

- `project control stop`した担当は、停止後の完全な観測で終了済みか実行中ターンのないidleで、フラグが空と分かり未解決attentionなしを確かめた後、syncで読まなくなります。行は`observation:"settled"`で末尾に残り、未解決attentionは保持します。その後にDesktopから直接再開した作業は検知しません。
- 停止した担当は、新しい監督IDでも`supervise THREAD`・`supervise register`で再び監督できなくなりました（`MANAGED_SUPERVISOR_STOPPED`）。syncとwaitが読まなくなった担当が気付かれずに動き続けないためです。続きは新しい`work start`で別の担当として始めます。managed projectに属さない単独タスクは、従来どおり新しいIDで監督を開始し直せます。
- `project sync --project ID --exclude-unreadable THREAD --reason TEXT`を追加しました。停止済みで読み取りが失敗し続ける担当を理由付きで除外し、結果を`exclude_unreadable.outcome`で返します。停止していない担当は`PROJECT_SYNC_EXCLUDE_NOT_STOPPED`で拒否します。
- `work tell`は、最新のsyncで対象の担当が完全に読めていれば、他の担当が未読でも送れます。receiptの`other_work`は未読・質問待ちの担当とsync後のmembership変更を返します。`WORK_TELL_MEMBERSHIP_CHANGED`は返さなくなりました。`--sync-token`の以前のsyncは、その後に対象が再読されていない間だけ使えます。
- `project wait`は読めない担当があっても、読めた担当の変化を`work_changed`で返します。読めない担当は全ての結果の`unreadable`に載り、`observation_failed`は新しい失敗かエラーcodeの変化ごとに1回だけ返します。waitかsyncが一度完全に読めた後の再発も、同じcodeで1回返します。同じ失敗の間は、間に通常のsyncを実行しても、何も保存せずに待ち続けます。別のsyncとの公開競合に負けたwaitは、従来どおり`observation_failed`・`changed:false`で返ります。公開されなかった結果は`publication_conflict`にエラーcodeを持ちます。
- `project wait`は、開始したClaude/Codex CLIセッションが異常終了すると、次の照会の前に`reason:"owner_exited"`・終了値1で終わり、wait記録とlockを解放します。再開したセッションのwaitが`RECORD_BUSY`になり続け、Stop hookが停止を拒否し続けることはなくなりました。セッションを特定できないwaitは従来どおり待ち続けます。実行中のwaitの内部で別の記録が使用中だった`RECORD_BUSY`は、他セッションのwaitが使用中だという案内に置き換えなくなりました。
- オーケストレーター用の指示に、再起動・要約の後で前のwaitの結果を読んだ記録がなければ、syncが返す`wait_sync_token`を`--continue`で読み切る手順を加えました。waitが公開した変化は以後のsyncに出ないため、セッションが落ちる直前のwait結果を読み落とさないようにします。
- `project sync`と`project wait`のJSONに`stop_hook`（`configured`|`unverified`）を追加しました。Desktop Cloud接続でも返します。
- `orchestrate resume SESSION_ID --project ID`を追加しました。`orchestrate`で起動したClaude Codeセッションを、同じStop hookと設定印を付けて`claude --resume`で再開し、新しい本文は送りません。素の`claude --resume`や`claude --continue`ではhookが付かず、未完了の担当があってもwaitなしで停止できました。Claude向けの本文は、`stop_hook`が`unverified`なら最初の報告でも途中でも、この再開コマンドを案内します。
- 履歴容量のエラーは`storage_bytes`・`required_bytes`・`limit_bytes`をJSONとtextの両方で返します。受信上限を超えた応答のメッセージは、失敗した接続の上限（Desktop Cloudは16 MiB、共有App Serverは64 MiB）を示します。

## 0.23.0 — 2026-11-05公開

オーケストレーターの変化待ちとStop hookによる監視確認を追加し、自分のセッションのwaitとhook設定を確認できるようにしました。新規ローカルタスクへのDesktop権限選択の反映と、作成RPC送信前に止まった`work start`の再試行にも対応しました。

- 新規ローカルの`work start`と単独の`thread create`は、Desktopに保存された権限選択を反映します。選択を確認できない場合は作成前に止まり、既存タスクへの`send --new-turn`はそのタスク自身の設定を引き継ぎます。
- `work start`は、作成RPCの送信前に停止したことを確認できる場合、原因を直して同じ発注を再実行すると同じattempt_idで作成をやり直せます。送信済みの可能性がある場合は引き続き作成を繰り返しません。
- `project guard`が自分のオーケストレーターを特定できない場合は、監視未確認の警告を返して停止を許します。Claude native installerの版番号付き実行パスを識別し、macOSのwait・所有者の起動識別はcommand全文の代わりにSHA-256を保存します。
- オーケストレーターは受信セッションで`project guard --project ID --status --json`を使い、直接Claude起動のStop hook設定印を照合できます。本文だけの生成や手動起動など有効性が未確認の経路では、最初の報告で監視漏れとhookの設定方法を案内します。単一タスクの監督本文にも、質問・承認・URLの伝達後にwatchを再開する案内を追加しました。
- `project guard`は自分のClaude/Codex CLIセッションに属する生存waitだけを認めます。同じCODEX_HOME・host・projectは1オーケストレーターで扱い、別セッションのwaitでは停止を許可せず、重複waitの`RECORD_BUSY`は所有セッションとの引継ぎを案内します。
- `project wait --project ID [--timeout-ms N] [--json]`を追加しました。最後の完全なproject syncを基準に、新しいターン終了・質問・承認待ち・失敗、またはmembership変更を待ち、syncと同じsnapshotを返します。idleだけでは通知せず、timeoutと観測失敗を区別します。最新のwait結果はsyncの`wait_sync_token`で復元できます。
- `project guard --project ID`を追加しました。未停止の担当（pausedを含む）がいて生存するwaitがなければ、Stop hookの停止拒否JSONを返します。プロセスの起動識別を確認し、異常終了したwaitを監視中と扱いません。Claude向け`orchestrate`はhookを起動設定へ追加し、生成本文は質問・承認・URLの伝達後もバックグラウンドwaitを続けるよう案内します。手動のClaude・Codex hook設定例と制約をオーケストレーション文書へ追加しました。

## 0.22.0 — 2026-11-04公開

オーケストレーターがmanaged projectの担当を立ち上げ（`work start`）、まとめて把握し（`project sync`）、指示し（`work tell`）、止める（`project control`）4操作を追加しました。役割の指定は設けず、担当範囲はrepository rootの`CODEXTEER.md`と発注で決めます。

- `work start`を追加しました。`CODEXTEER.md`を原文のまま発注書へ入れ、Desktop sharedまたはDesktop Cloudで作成・managed index登録・監督登録・初回観測までを一度に行います。段階を保存して同じ作成を再送せず、作成結果が不明なときは読み取り照合だけを行います。Desktop Cloudはenvironment configurationと明示したローカルcheckoutを使い、調整用projectへ登録します。Web Cloud（`--connection cloud`）の経路は提供しません。
- `project sync`を追加しました。managed projectの全担当を前回cursorから差分取得し、動作中・対応が必要・検収待ち・未確認へ分類します。直近turnの完了を証明できるidleの担当は検収待ちとし、開始前idleと区別します。途中コマンドの非ゼロ終了は担当の失敗と扱いません。未解決の質問・承認・失敗は完全な観測で解消を確認するまで再掲し、history gap・429・不完全取得・出力省略を明示します。byte予算を超える結果はcontinuationで分割します。
- `project event TOKEN`で、syncが要約した公開イベントとコマンド出力の全文を取得できます。`work start`の初回観測も次のsyncで提示します。
- `work tell`を追加しました。最新のcomplete project syncを基点に送信直前まで再照合し、新しいイベント、質問・承認待ち、attention不明、history gap、並行sync、membership変更では送信しません。finding・source・kind・監督IDは内部で扱い、unknownと同一意図を自動再送しません。
- `project control pause|stop|resume`で個別（`--work`）または全担当（`--all`）を制御できます。部分失敗とbusyを明示し、stop済みの担当は再開しません。stopは今後の監督による介入を止める操作で、受付済みの担当の実行・編集・外部操作は終了しません。停止済みの担当へのwork tell・work startは、ユーザーの明示的な指示を受けてから新しい担当として`work start`するよう案内します。
- `project prune --project ID`で過去のsync履歴と提示済み初回全文の重複を整理できます。最新sync・未提示初回結果・参照中の根拠は保持します。保存対象の総量はhost namespaceごとに256 MiB、1担当の全文観測は1回16 MiBまでで、不足時は全文を省略せず拒否します。保持期限は設けず、整理で削除した古いtokenは取得できなくなります。
- 初回観測で履歴の先頭を証明できない場合、`work start`と`project sync`はhistory gapとして止まり、cursorを確定しません。

互換性の変更:

- managed threadへの低水準`send`は監督IDの有無によらず`MANAGED_INTERVENTION_REQUIRED`で拒否し、介入は`work tell`に限定します。受付確認できない`--backend ui`の送信（`MANAGED_UI_UNSUPPORTED`）とpaired `command/exec`も拒否します。managed threadでない担当の`send`は従来どおりです。
- `orchestrate prompt`の本文を4操作へ整理し、固定の役割分担を削除しました。担当範囲は方針と発注から決め、Cloudの担当はDesktop Cloudで立ち上げます。0.21.0で追加したWeb Cloud優先の案内は削除しました。`help`の入口も4操作から選べる構成にし、`help thread`と同梱skillの新規Cloud担当の案内をDesktop Cloudへ統一しました。低水準のWeb Cloudコマンドは引き続き利用できます。

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
