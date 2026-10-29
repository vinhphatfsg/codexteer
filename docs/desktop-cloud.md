# Desktop Cloud

Desktop Cloud environment configurations use a different service from Web Cloud tasks. Use the same observation, sending, supervision, findings and instruction commands with a `durable_` task identifier or a `codex://threads/<UUID>?hostId=durable` link. A bare UUID continues to mean a local Desktop task; it never silently selects Cloud.

```sh
codexteer --connection desktop-cloud environments list --json
codexteer --connection desktop-cloud thread create --environment example-config 'Verify the connection without changing files' --json
codexteer read 'codex://threads/00000000-0000-4000-8000-000000000001?hostId=durable' --include-output --json
codexteer send durable_00000000-0000-4000-8000-000000000001 'Continue the verification' --new-turn --json
```

Authentication comes from the official CLI getAuthStatus API into memory. No credential files are read, no token is printed or persisted, no Desktop UI bridge is used, and no alternate endpoint is selected after failure. WebSocket authentication uses the service's bearer subprotocol; transport exceptions must not expose that subprotocol. Reads and writes are bounded. No approval requests are answered automatically.

Creation selects exactly one accessible configuration by ID or exact name and uses the server's default model. The first turn and later continuations carry the thread's selected environment and its deferred allocation flag. Omitting that flag can produce a server internal error despite successful thread creation. Internal errors, timeouts and disconnections after mutation dispatch remain unknown; they are never automatically retried. Creation receipts survive partial success and expose the created target even if initial delivery fails.

A configuration is not a Desktop project. The current official Cloud thread/start rejects project assignment, while the Desktop move tool cannot safely establish the source project of a directly created Cloud task. `--project` therefore fails before creation. Environment-only creation explicitly returns `project_membership: not_requested`. This implementation does not claim that such a task appears inside a local Desktop project. It does not edit Desktop's membership database or forge a caller context to work around the rejection.

Read/watch/Monitor use the shared event model, cursor validation, reconnect reporting and supervisor controls. The service can return null backwards cursors for nonempty histories, so the adapter fetches complete turn pages and uses the shared aggregate cursor rather than synthesizing server bookmarks. The adapter permits at most 100 pages and a bounded receive size per response. This costs more than Desktop's fast paged path on long histories.

The journal stores private message text as it does locally. A known accepted turn can be checked using its exact turn ID and message digest. A missing server clientId prevents positive reconciliation of an unknown turn; absence is not non-delivery. Unknown deliveries reserve the target against further sends. Pause and stop control the supervisor, not the Cloud worker. Generated commands retain `--connection desktop-cloud`; no local connection fallback is allowed. Dedicated diff retrieval and approval roundtrips are unverified. Inspect file-change/command events rather than claiming a missing patch means a clean working copy.
