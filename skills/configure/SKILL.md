---
name: configure
description: Set up the Matrix channel — save credentials and review access policy. Use when the user provides Matrix credentials, asks to configure Matrix, or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
---

# /matrix:configure — Matrix Channel Setup

Writes Matrix credentials to `~/.claude/channels/matrix/.env` and orients the user on access policy.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

Read both state files and give the user a complete picture:

1. **Credentials** — check `~/.claude/channels/matrix/.env` for `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN`, `MATRIX_USER_ID`. Show set/not-set.

2. **Access** — read `~/.claude/channels/matrix/access.json` (missing file = defaults: `dmPolicy: "pairing"`, empty allowlist). Show:
   - DM policy and what it means
   - Allowed senders: count and list
   - Pending pairings: count and codes
   - Opted-in rooms: count

3. **What next** — concrete next step based on state:
   - No credentials → explain how to get an access token
   - Credentials set, nobody allowed → *"DM your bot on Matrix. It replies with a code; approve with `/matrix:access pair <code>`."*
   - Credentials set, someone allowed → *"Ready. DM your bot to reach the assistant."*

### `<homeserver> <user_id> <access_token>` — save credentials

1. `mkdir -p ~/.claude/channels/matrix`
2. Write `.env` with:
   ```
   MATRIX_HOMESERVER=<homeserver>
   MATRIX_USER_ID=<user_id>
   MATRIX_ACCESS_TOKEN=<access_token>
   ```
3. `chmod 600 ~/.claude/channels/matrix/.env`
4. Confirm saved, show status.

### `clear` — remove credentials

Delete the `.env` file.
