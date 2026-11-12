# Desktop Cloud

新規Cloud担当の推奨経路です。高水準の操作は`work start`、`project sync`、`work tell`、`project control`を使います。必要な道具は構成ごとに確認し、実行先名からGUI・実機・Unity・Blender等の可用性を推測しません。未確認なら環境調査タスクかlocal Desktopを選びます。

```sh
codexteer --connection desktop-cloud work start --project sample --environment example-config --root /path/to/checkout --title verify - --json < order.txt
codexteer project sync --project sample --json
codexteer project control stop --project sample --all --json
```

基点ブランチは作成引数で指定できません。委任された作業ブランチをpushし、発注書にfetchするブランチとSHAを書きます。進行しない場合はsyncで確認し、unknownを再送しません。環境再公開が実行中の担当へ影響した運用観測があるため、共有資源として順番を管理します。影響の条件や保証は未確認として区別します。

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

A v1 cursor saved by an earlier version (in a project's membership, a wait baseline, a `work start` record or a `--based-on` reference) is read once in full and returns a v3 cursor. That read uses ascending pages of 100 turns, at most 100 pages and 32 MiB, and delivers the same events as before. A `project wait` whose baseline is still a v1 cursor repeats that full read on every poll until the wait returns or a complete `project sync` publishes a new baseline. `--full-history` keeps the full read and v1 cursors. A v3 cursor with `--full-history` is `OPTIONS_INVALID`. Each response is limited to 16 MiB. A task whose newest turn alone exceeds that cannot be read (`PAYLOAD_TOO_LARGE`). Neither can a task whose full read for a saved v1 cursor exceeds the limits above. A send reads the task's metadata and its newest turn without items, and steers that turn. A `--based-on` check from a v3 cursor reads only the turns at and after the cursor's turn. One from a v1 cursor reads the full history. `history check` and creation reconciliation still read the full history.

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
