# claude-channel-matrix

Matrix channel plugin for Claude Code. Bridges Matrix messages into a running Claude Code session via the MCP channel plugin interface.

## Architecture

- **`server.ts`** — single-file MCP server. Connects to Matrix via `matrix-js-sdk`, long-polls `/sync`, delivers inbound messages as `notifications/claude/channel` to Claude Code, and exposes tools (`reply`, `react`, `edit_message`, `fetch_messages`, `download_attachment`).
- **`start.ts`** — entry point wrapper. Overrides `console.log/debug/info` → stderr before any imports, preventing `matrix-js-sdk`'s loglevel from writing to stdout and corrupting the MCP JSON-RPC stdio transport.
- **`preload.ts`** — same redirect logic for environments that load it as a preload module.
- **`skills/configure/`** and **`skills/access/`** — Claude Code skill definitions for `/matrix:configure` and `/matrix:access` slash commands.

## State

All runtime state lives in `~/.claude/channels/matrix/`:
- `.env` — credentials (`MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN`, `MATRIX_USER_ID`)
- `access.json` — DM policy, allowlist, per-room config, pending pairings
- `inbox/` — downloaded attachments
- `server.log` — server-side log (stdout is reserved for MCP transport)

## Key design decisions

**Why `start.ts` instead of running `server.ts` directly:** `matrix-js-sdk` uses `loglevel` which writes to `console.log` → stdout. The MCP stdio transport uses stdout for JSON-RPC. These collide. The wrapper overrides console before any SDK import.

**Why access.json is read on every message:** Allows the `/matrix:access` skill to edit the file and have changes take effect immediately without restarting the server.

**Working indicator pattern:** On inbound message, the server sends "⏳ Working on it..." and stores the event ID. The `reply` tool edits that message with the first chunk of the response (via `m.replace`). This gives visual feedback without extra messages. Stale entries expire after 5 minutes or are cleared on the next inbound message.

## Testing

```bash
# Add test credentials to ~/.claude/channels/matrix/.env:
# MATRIX_TEST_USER=@testuser:your.homeserver
# MATRIX_TEST_PASSWORD=testpass

bun test-workflows.ts --list       # list tests
bun test-workflows.ts              # run all
bun test-workflows.ts --test reply # run one
```

Requires a running Claude Code session with the plugin loaded and a pre-existing DM between the test user and the bot.

## Development

```bash
bun install
bun start.ts   # run locally
```

To load as a development channel in Claude Code:
```bash
claude --dangerously-load-development-channels plugin:matrix@/path/to/this/repo
```
