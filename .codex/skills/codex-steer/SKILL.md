---
name: codex-steer
description: Send a user-authorized steering message from the terminal to an existing local Codex Desktop thread.
---

# Codex Steer

Use the installed `codex-steer` command only when the user asks to send or queue a message to another local Codex task.

Start with:

```bash
command -v codex-steer
codex-steer --json doctor
```

Find recent desktop thread IDs:

```bash
codex-steer --json threads list --desktop-only --limit 20
```

Preview before sending when the message or destination is uncertain:

```bash
codex-steer --json send <thread-id> "message" --dry-run
```

Send only after the user has identified the destination and message:

```bash
codex-steer send <thread-id> "Focus on the failing tests first."
printf '%s\n' 'Multiline message' | codex-steer send <thread-id> -
codex-steer codex://threads/<thread-id> "Continue with the new constraint."
```

Rules:

- `send` submits a user message. The `app-server` backend uses the exact task and active turn IDs without navigating the UI. Each send includes `clientUserMessageId` for Desktop's user-bubble rendering; JSON receipts expose it as `client_message_id`. An accepted receipt alone does not certify that the UI rendered it. Do not resend an older message to repair its display.
- The default backend is `app-server`; `--backend app-server` is optional. Use `--backend ui` only for an explicitly requested UI send. Never fall back to UI automatically.
- Background delivery requires Desktop to have been launched with `codex-steer desktop start`. If it is already running normally, finish current work and arrange a restart; do not kill it.
- The Desktop wrapper must run directly with its bundled signed Node runtime. If `doctor` reports `bundled_wrapper_node:false`, finish current work and restart Desktop; do not invoke the wrapper through PATH's `node`. A ready connection alone does not certify Desktop MCP integration.
- Use `--new-turn` only for an idle task. The wrapper establishes Desktop's subscription so approvals and questions survive the sender exiting.
- Prefer `--json` when another agent will parse the result.
- Do not send to a guessed thread ID.
- Do not use UI scripting to bypass macOS permission prompts.
- `delivery_status: accepted` means App Server accepted input, not that the model finished. For `unknown`, check the target task before retrying; never retry automatically.
- Legacy UI delivery requires explicit `--backend ui`, briefly activates Desktop, and requires Accessibility permission for the calling terminal app. Side-chat routing is not guaranteed; `submitted_unverified` is not a delivery confirmation.
- `--keep-focus` and `--wait-ms` are UI-only. Background delivery does not require Accessibility.
