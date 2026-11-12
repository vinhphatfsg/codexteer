# Desktop Cloud

新規Cloud担当の推奨経路です。高水準の操作は`work start`、`project sync`、`work tell`、`project control`を使います。必要な道具は構成ごとに確認し、実行先名からGUI・実機・Unity・Blender等の可用性を推測しません。未確認なら環境調査タスクかlocal Desktopを選びます。

```sh
codexteer --connection desktop-cloud work start --project sample --environment example-config --root /path/to/checkout --title verify - --json < order.txt
codexteer project sync --project sample --json
codexteer project control stop --project sample --all --json
```

基点ブランチは作成引数で指定できません。委任された作業ブランチをpushし、発注書にfetchするブランチとSHAを書きます。進行しない場合はsyncで確認し、unknownを再送しません。環境再公開が実行中の担当へ影響した運用観測があるため、共有資源として順番を管理します。影響の条件や保証は未確認として区別します。

## 実行中ターンの観測範囲

Desktop Cloudのタスクは、ターンの実行中は開始時の指示だけが読めます。その間の発言・コマンド・質問は、ターンが終わるとまとめて履歴に現れます。承認待ちを示すフラグ（`attention`）は、実行中は空のままです。そのため、実行中ターンの質問・承認待ち・自動レビューの拒否・進捗を、codexteerは観測できません。

この間、`status`・`read`・`watch`（`--stream`を除きます）と`project sync`の担当行は`attention_coverage:"running_turn_unobserved"`を返します。ターンが実行中でないと確認できないときも返します。`attention`が`[]`でも、質問・承認待ちがないことは示しません。Codexの画面で確認してください。`project sync`と`project wait`の結果（timeoutを含みます）は、その担当を`attention_unobserved`に並べます。`doctor`は、次節の設定が無効なら、この接続の制限として`running_turn_attention:"unobserved"`を、対象の状態によらず返します。

ターンが終わると印は付かなくなります。その間に出た質問は`read`で読め、`project wait`が変化として返します。`work tell`は実行中ターンへの送信の可否を変えず、receiptの`attention_coverage`で観測できなかったことを示します。

## 実行中ターンを読む（`CODEXTEER_DESKTOP_CLOUD_LIVE_TURN=on`）

環境変数`CODEXTEER_DESKTOP_CLOUD_LIVE_TURN=on`を設定すると、codexteerは実行中のターンを、別の接続でタスクを`thread/resume`して読みます。そのターンのここまでの発言・コマンド・質問と、届いたサーバー要求が分かります。既定は無効です。承認待ちで止まったターンのresumeと、ターンが終わった直後のresumeを、サービスで確認していないためです。

- resumeするのは、同じ読み取りで取得したターンの一覧で、実行中のターンが1つだけで、それが最新のターンのときだけです。idle・終了済み・状態不明の担当、終わったターンの後ろで古いターンが実行中の担当、`settled`の担当はresumeしません。一覧を取得してからresumeするまでの間にターンが終わると、終わった直後のタスクをresumeすることがあります。この間隔はなくせません。
- 読むのは`read`・`status`・`project sync`・`project wait`・`work tell`・`doctor --thread`です。`watch`（`--stream`を含みます）と、`work start`の作成直後の確認は読みません。1回の`project sync`、`project wait`の1回の照会、1回の`work tell`は、実行中の担当ごとに1回だけresumeします。同じコマンドの2回目の読み取りは、実行中のターンが同じなら同じ結果を使います。
- resumeは読み取り・送信とは別の接続で行います。その接続は、届いたサーバー要求に応答せず、通知を無視し、要求のメソッド名だけを記録して閉じます。
- 読めた項目は、履歴が返すものと同じ形のイベントとして返ります。ターン中の質問は、ターンの実行中に`read`で読め、`project wait`が返します。その読み取りの結果は`live_turn_id`（読んだターンのID）を持ち、`attention_coverage`は付きません。読んだ項目は、ターンが終わって履歴に現れても、内容が同じなら再び返しません。内容が変わった項目は`change:"updated"`で返ります。
- resumeした接続に届いたサーバー要求（承認や入力の要求）は、`attention`に`pendingRequest:<メソッド名>`として加わり、結果の`pending_requests`にメソッド名が並びます。担当行は「対応が必要」になり、`work tell`は`WORK_TELL_HUMAN_REQUIRED`で送りません。回答はCodexの画面で行います。次の読み取りでresumeできなくても、最後に見た要求を残します。同じターンを読めて要求がなくなったとき、またはターンが終わったときに外します。
- resumeが失敗するか10秒以内に終わらない場合、その担当は従来どおり履歴だけで読み、`attention_coverage:"running_turn_unobserved"`が付きます。読めない担当にはなりません。
- 実行中のターンを読めずに履歴だけで読んだ結果は、理由を`live_fallback`で返します。`project sync`の担当行（詳細を省いた行を含みます）と、`attention_unobserved`のその担当も同じ値を持ちます。値は次の4つです。
  - `unavailable`：resumeが失敗した、10秒以内に終わらなかった、resumeした時点でターンが終わっていた、resumeの結果に形の崩れた項目か同じIDの項目があった、のいずれかです。次の読み取りでまたresumeします。
  - `ledger_full`：実行中に読んだ項目が1ターンで256を超えました。超えた読み取りからは新しい項目を返さず、そのターンの残りは履歴で読みます。そのターンが終わるまで照会ごとのresumeは続き、ターンが終わると全ての項目が1回ずつ返ります。次のターンはまた読みます。
  - `view_mismatch`：resumeで得たターンに、履歴が並べている項目（実行中は開始時の指示）のIDがありませんでした。その結果は`live_mismatch`（`turn_id`・`absent`）を持ち、resumeで得た項目は返しません。以後そのタスクはresumeせず履歴だけで読みます。
  - `mismatch`：ターンが終わった後の履歴に、実行中に読んだ項目のIDがありませんでした。その結果は`live_mismatch`（`turn_id`・`unlisted`）を持ち、以後そのタスクはresumeせず履歴だけで読みます。
- `view_mismatch`と`mismatch`はcursorに残ります。そのcursorから読む`read`・`project sync`・`project wait`は、ターンが実行中でなくても`live_fallback`を返し続けます。`--since`なしの`read`はcursorを持たないため、またresumeします。`project wait`は、担当がこのどちらかになった照会で1回返り（`reason:"work_changed"`）、以後の照会ではresumeしません。
- 履歴が並べている項目は、IDだけでresumeの結果と照合します。その項目は常に履歴から返し、resumeの結果からは返さないため、内容の違いは結果を変えません。resumeで読んだ項目は、ターンが終わったときに履歴の同じIDの項目と内容を照合します。
- 中断・失敗で終わったターンの履歴は、実行中に読んだ項目（終わらなかったコマンドなど）を並べないことがあります。そのターンは`mismatch`になります。履歴にある項目のうち、実行中に同じ内容で返したものは再び返さず、残りを全て返します。履歴にない項目は、実行中に返した1回だけです。読み飛ばす項目も、同じ内容で2回返る項目もありません。以後そのタスクは履歴だけで読むため、後のターンの質問はターンが終わってから返ります。
- `work tell`は、実行中のターンを読めなかったとき（`live_fallback`のどの値でも）、設定が無効のときと同じく送信の可否を変えず、receiptに`attention_coverage`を付けます。
- `work tell`は、送信前の確認にも同じ読み取りを使います。syncの後に実行中のターンが新しい項目を出していれば、localの担当と同じく`WORK_TELL_STALE_SYNC`で送りません。syncからやり直してください。項目を出し続けるターンには、送れる機会が少なくなります。
- `doctor`は、この設定が有効なら`running_turn_attention:"live"`を返します。
- cursorには、実行中に読んだ項目のIDと内容のhashが入ります。設定を無効に戻しても、そのcursorは続きから読めます。0.24.x以前では読めません（[CHANGELOG](../CHANGELOG.md)の0.25.0を参照）。

## スレッドの`status`と`execution`

Desktop Cloudのスレッドは、最後のターンが終わった後も`status`が`active`のまま残ることがあります。そのため`status`・`read`・`watch`は、`status`に加えて`execution`（`active`・`idle`・`terminal`・`unknown`）を返します。`execution`は`project sync`の担当行と同じ規則で決まります。実行中のターンがあれば`active`、全てのターンが終わっていれば`idle`です。ターンの状態が欠けているか矛盾するときは`status`のとおりです。ターンの状態が`status`と食い違ったときは`execution_basis:"turn_status"`も返します。`status`はサービスが返した値のままで、変えません。実行中かどうかは`execution`で判断してください。

`watch --until idle`は`execution`が`idle`になったときに返ります。`send`も同じ規則で判断します。`--new-turn`は、`status`が`idle`のとき、または`status`が`active`のままでも全てのターンが終わっているときに送れます。後者では、全てのターンのIDと状態だけ（項目なし）を読んで確かめます。通常の`send`は最新ターンが実行中のときだけ送れます。`--new-turn`は、実行中のターンがある、`status`が`idle`でも`active`でもない、`status`が`active`でターンが終わったと確認できない、のいずれかなら`STALE_OBSERVATION`で送信しません。

## 既定のモデルとエフォート

```sh
codexteer --connection desktop-cloud models select
codexteer --connection desktop-cloud models list --json
codexteer --connection desktop-cloud models show --json
```

`models select`（`models` だけでも同じ）は、現在の Cloud モデル一覧を取得し、モデル、そのモデルで利用できるエフォートの順に番号で選びます。Enter は表示中の現在値、q・Ctrl-C・EOF は選択を中止します。モデル一覧やエフォートは固定しません。選び終えた時点でもカタログを再取得して利用可否を確かめます。

対話端末以外では、`models list --json` の ID とエフォートを使って次のように保存します。

```sh
codexteer --connection desktop-cloud models set --model MODEL --thinking EFFORT --json
codexteer --connection desktop-cloud models reset --json
```

保存先は `CODEX_HOME/codex-steer/settings/desktop-cloud-model.json`（CODEX_HOME 未指定時は `~/.codex`）です。モデルとエフォートを一組で原子的に保存します。保存が完了した後の新しい `work start`／`thread create` は毎回読み直すため、再起動は不要です。設定は同じ CODEX_HOME の対応版 codexteer で共有します。古い保存済み CLI には新機能が追加されないため、その CLI は新しい設定を参照しません。

作成時は `--model MODEL`／`--thinking EFFORT` で今回だけ上書きできます。モデルは「引数 → 保存値 → Cloud の既定」、エフォートは「引数 → 同じ保存モデルの保存値 → 選択モデルの既定」の順です。モデルだけを別モデルに変えた場合に、以前のモデルのエフォートを流用しません。`reset` は保存値を解除します。未保存時も Cloud カタログの既定エフォートを明示指定し、未指定時の表示補完には依存しません。

```sh
codexteer --connection desktop-cloud thread create --environment CONFIG --model MODEL --thinking EFFORT --dry-run '実行前の設定確認' --json
```

`--dry-run` は環境・現在のモデル一覧と選択を照合して `model_selection` を返し、作成・送信・受付記録の保存をしません。非表示モデル、不明なモデル、未対応エフォート、破損設定では作成前に停止し、別の組合せに自動変更しません。

`model_selection` の `model`／`thinking` は作成要求に指定した値です。モデルは `thread/start.model`、エフォートは `thread/start.config.model_reasoning_effort` に設定し、初回 `turn/start` にも `model`／`effort` を明示します。Cloud の内部で実際に使用されたモデルの独立した実行証明を表すフィールドではありません。

作成開始済みの `work start` は発注ごとに選択を保存します。同じ発注の再実行は、途中で既定値を変更しても元の選択を維持し、明示引数の変更は拒否します。受付不明は読み取り照合のみです。作成 RPC の未送信を保存記録で確認できた場合だけ、同じ attempt の再実行を許可します。既存スレッドや通常の継続送信には新しい既定値を上書きしません。

Desktop Cloud environment configurations use a different service from Web Cloud tasks. Use the same observation, sending, supervision, findings and instruction commands with a `durable_` task identifier or a `codex://threads/<UUID>?hostId=durable` link. A bare UUID continues to mean a local Desktop task; it never silently selects Cloud.

```sh
codexteer --connection desktop-cloud environments list --json
codexteer --connection desktop-cloud thread create --environment example-config 'Verify the connection without changing files' --json
codexteer read 'codex://threads/aaaaaaaa-aaaa-4aaa-8aaa-000000000001?hostId=durable' --include-output --json
codexteer send durable_aaaaaaaa-aaaa-4aaa-8aaa-000000000001 'Continue the verification' --new-turn --json
```

Authentication comes from the official CLI getAuthStatus API into memory. No credential files are read, no token is printed or persisted, no Desktop UI bridge is used, and no alternate endpoint is selected after failure. WebSocket authentication uses the service's bearer subprotocol; transport exceptions must not expose that subprotocol. Reads and writes are bounded. No approval requests are answered automatically.

Creation selects exactly one accessible configuration by ID or exact name. Model and effort follow explicit creation options, saved codexteer defaults, then the Cloud model catalog, as described above. The first turn and later continuations carry the thread's selected environment and its deferred allocation flag. Omitting that flag can produce a server internal error despite successful thread creation. Internal errors, timeouts and disconnections after mutation dispatch remain unknown; they are never automatically retried. Creation receipts survive partial success. JSON and human-readable errors expose the created thread ID, attempt ID, receipt path and creation/delivery status even if setting a title or delivering the initial instruction fails. Inspect these identifiers rather than creating a replacement.

A configuration is not a Desktop project. The tested remote Cloud thread/start rejects project assignment, while the general Desktop move tool cannot safely establish the source project of a directly created Cloud task. The separate signed assignment endpoint described below is restricted to Desktop execution. The low-level `thread create --project` therefore fails before creation. The high-level `work start --project` is a separate codexteer coordination namespace and does not request Desktop DB assignment. Environment-only creation explicitly returns `project_membership: not_requested`. This implementation does not claim that such a task appears inside a local Desktop project. It does not edit Desktop's membership database or forge a caller context to work around the rejection.

Read/watch/Monitor use the shared event model, cursor validation, reconnect reporting and supervisor controls. A Desktop Cloud read does not fetch the whole history. It lists turns newest first, one turn per request (`thread/turns/list` with `itemsView: full`), and stops at the turn its cursor names. A read therefore costs the turns at and after the cursor. Its cursor is a v3 cursor: the shared v1 cursor over that turn and every newer turn, so the events, `has_more` and `changed` are the same as a full read would give. Each read moves the cursor's turn forward to the turn that holds the last delivered event. It stops earlier at a change not yet delivered or at a turn that is still running. Suppose that turn is final, delivered in full and still the newest, and the task's state is unchanged. Then a read lists only that turn's id and status (`itemsView: notLoaded`). A read without `--since` stops once it has `--limit` events. Its `omitted_older_events` is `null` unless it reached the oldest turn, so `work start` and `project sync` still refuse an unproven first boundary. History is read `history_scope: tail-turns`.

The reader relies on the service appending turns and never changing a turn once it is completed, failed, interrupted or cancelled. It checks the cursor's turn and every newer turn against the cursor on every read that lists them. A cursor whose turn is gone is `STALE_CURSOR`, a history gap. The reader finds this from the turns' start times without reading older turns. A listing that is not newest first, repeats a turn or a position, or stalls is `DESKTOP_CLOUD_PROTOCOL_ERROR`. A walk is limited to 1000 requests and 32 MiB. Two cases are not detected: a turn inserted before the cursor's turn, and a change to an older final turn. While the newest final turn keeps its id and status, items the service adds to it later are not read either, and neither is a change to its items. They are delivered, or detected, at the next read that lists that turn in full: when a newer turn starts or the task's state changes. A turn that is not final pins the cursor's turn. If such a turn stays behind newer turns, every read lists one request per turn from the newest down to it, and a read fails once that exceeds the walk limit.

A v1 cursor saved by an earlier version (in a project's membership, a wait baseline, a `work start` record or a `--based-on` reference) is read once in full and returns a v3 cursor. That read uses ascending pages of 100 turns, at most 100 pages and 32 MiB, and delivers the same events as before. A `project wait` whose baseline is still a v1 cursor repeats that full read on every poll until the wait returns or a complete `project sync` publishes a new baseline. `--full-history` keeps the full read and v1 cursors. A v3 cursor with `--full-history` is `OPTIONS_INVALID`. Each response is limited to 16 MiB. A task whose newest turn alone exceeds that cannot be read (`PAYLOAD_TOO_LARGE`). Neither can a task whose full read for a saved v1 cursor exceeds the limits above. A send reads the task's metadata and its newest turn without items. It steers that turn when the turn runs, and starts a new turn when the turn has ended and the thread status is `idle`. When the thread status is still `active`, a new turn also lists every turn's id and status without items (`itemsView: notLoaded`, 100 turns per request) and is sent only if none runs. A service that rejects that listing leaves the send refused. A `--based-on` check from a v3 cursor reads only the turns at and after the cursor's turn. One from a v1 cursor reads the full history. `history check` and creation reconciliation still read the full history.

The journal stores private message text as it does locally. A known accepted turn can be checked using its exact turn ID and message digest. A missing server clientId prevents positive reconciliation of an unknown turn; absence is not non-delivery. Unknown deliveries reserve the target against further sends. Pause and stop control the supervisor, not the Cloud worker. Generated commands retain `--connection desktop-cloud`; no local connection fallback is allowed. Dedicated diff retrieval and approval roundtrips are unverified. Inspect file-change/command events rather than claiming a missing patch means a clean working copy.

## Project membership diagnostics and assignment

```sh
codexteer --connection desktop-cloud projects list --json
codexteer --connection desktop-cloud doctor --thread durable_aaaaaaaa-aaaa-4aaa-8aaa-000000000001 --project example-project --json
codexteer --connection desktop-cloud thread assign durable_aaaaaaaa-aaaa-4aaa-8aaa-000000000001 --project example-project --json
```

Use `doctor --thread` to inspect a target. The project catalog comes from the existing Desktop App Server, uses its actual Desktop project IDs and does not list Cloud environment configurations. Desktop must be running with its existing codexteer connection for this project catalog. Cloud observation and delivery remain independent of that Desktop connection.

Doctor distinguishes membership already recorded in the current Desktop profile from permission to register it. A missing assignment is `source_unknown`, not proof that the task is projectless. A recorded assignment without a durable host binding is `recorded_host_unverified`. This inspection reads the owner-validated profile state; it never edits that state and is not represented as a remote Cloud API result.

The official signed project API requires the task to use that Desktop's own ready executor. `thread assign` calls its read-only catalog with the **actual** environment from the Cloud task, validates the signed domain, nonce and request, resolves exactly one project, and rechecks both endpoints before mutation. The assignment acknowledgement must match the same environment, thread and project. Desktop flushes its own state; codexteer reads it back to verify membership. No caller thread/turn identity is fabricated. Public verification keys remain in memory. Unknown mutations reserve the target and are not automatically retried; inspect `thread receipt ATTEMPT_ID` and `doctor --thread TARGET --project PROJECT`.

This endpoint does not authorize arbitrary remote Cloud environments. The remote Cloud configuration used in validation was rejected by its read-only catalog; no assignment was attempted on that path. A local executor ID must never be substituted, and a local executor must never be attached just to satisfy this check. Remote `thread/start`/`thread/metadata/update` reject project assignment and remote `project/list` is unavailable in the tested service. Therefore new remote Cloud creation with `--project` still fails before creation. This is a service boundary, not a successful project registration.
