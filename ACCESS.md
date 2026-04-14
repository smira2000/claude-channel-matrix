# Matrix — Access & Delivery

Matrix is a federated protocol — anyone with your bot's Matrix ID can send a DM if they're on the same homeserver or a federated one. The bot will auto-join rooms it's invited to.

The default DM policy is **pairing**. An unknown sender gets a 6-character code in reply and their message is dropped. You run `/matrix:access pair <code>` from your Claude Code session to approve them. Once approved, their messages pass through.

All state lives in `~/.claude/channels/matrix/access.json`. The `/matrix:access` skill commands edit this file; the server re-reads it on every inbound message, so changes take effect without a restart.

## At a glance

| | |
| --- | --- |
| Default policy | `pairing` |
| Sender ID | Matrix user ID (e.g. `@alice:matrix.org`) |
| Room key | Room ID (e.g. `!abc123:matrix.org`) |
| Config file | `~/.claude/channels/matrix/access.json` |

## DM policies

| Policy | Behavior |
| --- | --- |
| `pairing` (default) | Reply with a pairing code, drop the message. Approve with `/matrix:access pair <code>`. |
| `allowlist` | Drop silently. No reply. |
| `disabled` | Drop everything, including allowlisted users. |

## User IDs

Matrix identifies users by permanent IDs like `@username:matrix.org`. These don't change.

```
/matrix:access allow @alice:matrix.org
/matrix:access remove @alice:matrix.org
```

## Rooms

Rooms are off by default. Opt each one in individually by room ID. Find room IDs in Element: Room Settings → Advanced → Internal Room ID.

```
/matrix:access room add !abc123:matrix.org
/matrix:access room add !abc123:matrix.org --no-mention
/matrix:access room add !abc123:matrix.org --allow @alice:matrix.org,@friend:matrix.org
/matrix:access room rm !abc123:matrix.org
```

With `requireMention: true` (default), the bot responds only when mentioned or replied to.

## Delivery

Configure outbound behavior:

```
/matrix:access set ackReaction 👀
/matrix:access set replyToMode first
/matrix:access set mentionPatterns '["^hey claude\\b", "\\bmate\\b"]'
```

## Config file

`~/.claude/channels/matrix/access.json`:

```json
{
  "dmPolicy": "pairing",
  "allowFrom": ["@alice:matrix.org"],
  "rooms": {
    "!abc123:matrix.org": {
      "requireMention": true,
      "allowFrom": []
    }
  },
  "mentionPatterns": ["\\bmate\\b"],
  "ackReaction": "👀",
  "replyToMode": "first",
  "textChunkLimit": 65536,
  "chunkMode": "newline"
}
```
