# Desktop Cloud

Desktop Cloud environment configurations use a different service from Web Cloud tasks. Use the same observation, sending, supervision, findings and instruction commands with a `durable_` task identifier or a `codex://threads/<UUID>?hostId=durable` link. A bare UUID continues to mean a local Desktop task; it never silently selects Cloud.

```sh
codexteer --connection desktop-cloud environments list --json
codexteer --connection desktop-cloud thread create --environment example-config 'Verify the connection without changing files' --json
codexteer read 'codex://threads/aaaaaaaa-aaaa-4aaa-8aaa-000000000001?hostId=durable' --include-output --json
codexteer send durable_aaaaaaaa-aaaa-4aaa-8aaa-000000000001 'Continue the verification' --new-turn --json
```

Authentication comes from the official CLI getAuthStatus API into memory. No credential files are read, no token is printed or persisted, no Desktop UI bridge is used, and no alternate endpoint is selected after failure. WebSocket authentication uses the service's bearer subprotocol; transport exceptions must not expose that subprotocol. Reads and writes are bounded. No approval requests are answered automatically.

Creation selects exactly one accessible configuration by ID or exact name and uses the server's default model. The first turn and later continuations carry the thread's selected environment and its deferred allocation flag. Omitting that flag can produce a server internal error despite successful thread creation. Internal errors, timeouts and disconnections after mutation dispatch remain unknown; they are never automatically retried. Creation receipts survive partial success and expose the created target even if initial delivery fails.

A configuration is not a Desktop project. The tested remote Cloud thread/start rejects project assignment, while the general Desktop move tool cannot safely establish the source project of a directly created Cloud task. The separate signed assignment endpoint described below is restricted to Desktop execution. `--project` therefore fails before creation. Environment-only creation explicitly returns `project_membership: not_requested`. This implementation does not claim that such a task appears inside a local Desktop project. It does not edit Desktop's membership database or forge a caller context to work around the rejection.

Read/watch/Monitor use the shared event model, cursor validation, reconnect reporting and supervisor controls. The service can return null backwards cursors for nonempty histories, so the adapter fetches complete turn pages and uses the shared aggregate cursor rather than synthesizing server bookmarks. The adapter permits at most 100 pages and a bounded receive size per response. This costs more than Desktop's fast paged path on long histories.

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
