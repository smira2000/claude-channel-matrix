---
name: access
description: Manage Matrix channel access control — pair users, set DM policy, add/remove rooms. Use for pairing codes, allowlist management, room opt-in.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
---

# /matrix:access — Matrix Access Control

Manages `~/.claude/channels/matrix/access.json`. Changes take effect on the next inbound message (no restart needed).

Arguments passed: `$ARGUMENTS`

---

## No args — show current state

Read `access.json` and display:
- DM policy (pairing/allowlist/disabled)
- Allowed users (list Matrix IDs)
- Pending pairing codes (code + display name)
- Opted-in rooms (room ID + settings)

## `pair <code>` — approve a pairing code

1. Read `access.json`
2. Find `code` in `pending`
3. Add the pending user's Matrix ID to `allowFrom`
4. Remove from `pending`
5. Save `access.json`
6. Confirm: *"Approved @user:server. Their next DM will reach the assistant."*

## `deny <code>` — reject a pairing code

Remove from `pending` without adding to `allowFrom`.

## `allow <matrix_user_id>` — add user directly

Add `@user:server` to `allowFrom`. No pairing needed.

## `remove <matrix_user_id>` — remove user

Remove from `allowFrom`.

## `policy <pairing|allowlist|disabled>` — set DM policy

Update `dmPolicy` in `access.json`.
- `pairing`: Unknown DMs get a pairing code
- `allowlist`: Unknown DMs dropped silently
- `disabled`: All DMs dropped

## `room add <room_id> [--no-mention] [--allow id1,id2]`

Add a room to the opted-in list:
```json
{
  "requireMention": true,
  "allowFrom": []
}
```
Pass `--no-mention` to respond to all messages. Pass `--allow` to restrict senders.

## `room rm <room_id>` — remove room

Remove room from opted-in list.

## `set <key> <value>` — configure delivery

Keys: `ackReaction`, `replyToMode` (off/first/all), `textChunkLimit`, `chunkMode` (length/newline), `mentionPatterns` (JSON array of regex strings).
