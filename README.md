# Matrix Channel for Claude Code

Chat with Claude Code from any Matrix client — Element, FluffyChat, Cinny, Nheko, or any other.

This is a [Claude Code channel plugin](https://code.claude.com/docs/en/channels) that bridges Matrix messages into your local Claude Code session. Claude receives your messages, runs tools on your machine, and replies back in the same Matrix room.

## Features

- **DM and room support** — DM the bot directly or invite it to rooms
- **Access control** — Pairing flow for new users, allowlist for lockdown
- **Reply threading** — Replies thread under the original message
- **Reactions** — Ack reactions on receipt, emoji reactions via tool
- **Message editing** — Edit previously sent messages
- **Permission relay** — Approve/deny tool calls from Matrix
- **Mention detection** — In rooms, respond only when @mentioned (configurable)

## Prerequisites

- [Bun](https://bun.sh) runtime
- A Matrix account for the bot (any homeserver)
- Claude Code v2.1.80+

## Quick Setup

### 1. Create a Matrix bot account

Register a new account on your homeserver for the bot. You can use any Matrix client or the CLI:

```bash
curl -XPOST 'https://matrix.org/_matrix/client/v3/register' \
  -d '{"auth":{"type":"m.login.dummy"},"username":"mybot","password":"botpass"}'
```

### 2. Get an access token

Log in to get an access token:

```bash
curl -XPOST 'https://matrix.org/_matrix/client/v3/login' \
  -d '{"type":"m.login.password","user":"mybot","password":"botpass"}'
```

Or in Element: Settings → Help & About → Access Token.

### 3. Install the plugin

```
/plugin install matrix@<your-marketplace>
/reload-plugins
```

Or load from a local directory:

```bash
claude --plugin-dir /path/to/claude-channel-matrix
```

### 4. Configure credentials

```
/matrix:configure https://matrix.org @mybot:matrix.org syt_your_access_token
```

### 5. Launch with the channel

```bash
claude --channels plugin:matrix@<your-marketplace>
```

Or for local development:

```bash
claude --dangerously-load-development-channels plugin:matrix@<your-marketplace>
```

### 6. Pair your account

DM your bot on Matrix. It replies with a pairing code. In Claude Code:

```
/matrix:access pair <code>
```

### 7. Lock it down

```
/matrix:access policy allowlist
```

## Access Control

See [ACCESS.md](./ACCESS.md) for full documentation on DM policies, room opt-in, mention detection, and delivery configuration.

## Tools

| Tool | Purpose |
| --- | --- |
| `reply` | Send a message to a room. Supports threading via `reply_to`. |
| `react` | React to a message with an emoji. |
| `edit_message` | Edit a previously sent message. |
| `fetch_messages` | Pull recent messages from a room (oldest-first, max 100). |

## Environment Variables

| Variable | Description |
| --- | --- |
| `MATRIX_HOMESERVER` | Homeserver URL (e.g. `https://matrix.org`) |
| `MATRIX_USER_ID` | Bot's Matrix user ID (e.g. `@mybot:matrix.org`) |
| `MATRIX_ACCESS_TOKEN` | Bot's access token |
| `MATRIX_STATE_DIR` | Override state directory (default: `~/.claude/channels/matrix/`) |

Set in `~/.claude/channels/matrix/.env` or as shell environment variables (shell takes precedence).

## License

MIT
