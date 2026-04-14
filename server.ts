#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import * as sdk from 'matrix-js-sdk'
import { join } from 'path'
import { homedir } from 'os'
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
} from 'fs'
import { z } from 'zod'
import { appendFileSync } from 'fs'

// ── Logging (to file since stdout is MCP stdio transport) ────────────────────
const LOG_DIR = process.env.MATRIX_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'matrix')
mkdirSync(LOG_DIR, { recursive: true })
const LOG_FILE = join(LOG_DIR, 'server.log')
function log(level: 'INFO' | 'WARN' | 'ERROR', msg: string) {
  const ts = new Date().toISOString()
  const line = `[${ts}] ${level} ${msg}\n`
  try { appendFileSync(LOG_FILE, line) } catch {}
}

// ── State directory ──────────────────────────────────────────────────────────
const STATE_DIR =
  process.env.MATRIX_STATE_DIR ??
  join(homedir(), '.claude', 'channels', 'matrix')
const ENV_FILE = join(STATE_DIR, '.env')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const INBOX_DIR = join(STATE_DIR, 'inbox')

mkdirSync(STATE_DIR, { recursive: true })
mkdirSync(INBOX_DIR, { recursive: true })

// ── Load .env ────────────────────────────────────────────────────────────────
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const HOMESERVER = process.env.MATRIX_HOMESERVER
const ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN
const USER_ID = process.env.MATRIX_USER_ID

if (!HOMESERVER || !ACCESS_TOKEN || !USER_ID) {
  console.error(
    `Matrix channel: missing credentials.
Set these in ${ENV_FILE}:
  MATRIX_HOMESERVER=https://matrix.org
  MATRIX_ACCESS_TOKEN=syt_...
  MATRIX_USER_ID=@yourbot:matrix.org

Generate an access token:
  1. Log in to Element as your bot account
  2. Settings → Help & About → Access Token (click to reveal)
  Or use: curl -XPOST 'https://matrix.org/_matrix/client/v3/login' \\
    -d '{"type":"m.login.password","user":"botuser","password":"pass"}'`
  )
  process.exit(1)
}

// ── Access control ───────────────────────────────────────────────────────────
type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[] // Matrix user IDs like @user:server
  rooms: Record<string, { requireMention: boolean; allowFrom: string[] }>
  pending: Record<string, { userId: string; roomId: string; displayName: string; ts: number }>
  mentionPatterns: string[]
  ackReaction: string
  replyToMode: 'off' | 'first' | 'all'
  textChunkLimit: number
  chunkMode: 'length' | 'newline'
}

const DEFAULT_ACCESS: Access = {
  dmPolicy: 'pairing',
  allowFrom: [],
  rooms: {},
  pending: {},
  mentionPatterns: [],
  ackReaction: '👀',
  replyToMode: 'first',
  textChunkLimit: 65536, // Matrix has no hard limit like Discord's 2000
  chunkMode: 'newline',
}

function loadAccess(): Access {
  try {
    return { ...DEFAULT_ACCESS, ...JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) }
  } catch {
    return { ...DEFAULT_ACCESS }
  }
}

function saveAccess(a: Access) {
  writeFileSync(ACCESS_FILE, JSON.stringify(a, null, 2))
}

// ── Matrix client ────────────────────────────────────────────────────────────
const client = sdk.createClient({
  baseUrl: HOMESERVER,
  accessToken: ACCESS_TOKEN,
  userId: USER_ID,
})

// Track "working..." messages so the reply tool can edit them
// Each entry: { eventId, ts } — cleared on reply or after TTL
const WORKING_TTL_MS = 5 * 60 * 1000 // 5 minutes
type WorkingEntry = { eventId: string; ts: number }
const pendingWorkingMessages = new Map<string, WorkingEntry>()

function getWorkingId(roomId: string): string | undefined {
  const entry = pendingWorkingMessages.get(roomId)
  if (!entry) return undefined
  if (Date.now() - entry.ts > WORKING_TTL_MS) {
    pendingWorkingMessages.delete(roomId)
    return undefined
  }
  return entry.eventId
}

// Track recent sent event IDs for mention detection
const recentSentIds = new Set<string>()
const SENT_ID_CAP = 200

function trackSent(eventId: string) {
  recentSentIds.add(eventId)
  if (recentSentIds.size > SENT_ID_CAP) {
    const first = recentSentIds.values().next().value
    if (first) recentSentIds.delete(first)
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function isDm(room: sdk.Room): boolean {
  const members = room.getJoinedMembers()
  return members.length <= 2
}

function randomCode(): string {
  const chars = 'abcdefghijkmnopqrstuvwxyz' // no 'l'
  let code = ''
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)]
  return code
}

function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining)
      break
    }
    let cut = limit
    if (mode === 'newline') {
      const paraBr = remaining.lastIndexOf('\n\n', limit)
      if (paraBr > limit * 0.3) cut = paraBr + 2
      else {
        const lineBr = remaining.lastIndexOf('\n', limit)
        if (lineBr > limit * 0.3) cut = lineBr + 1
        else {
          const spaceBr = remaining.lastIndexOf(' ', limit)
          if (spaceBr > limit * 0.3) cut = spaceBr + 1
        }
      }
    }
    chunks.push(remaining.slice(0, cut))
    remaining = remaining.slice(cut)
  }
  return chunks
}

// ── Permission relay ─────────────────────────────────────────────────────────
const PERMISSION_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

// ── MCP server ───────────────────────────────────────────────────────────────
const mcp = new Server(
  { name: 'matrix', version: '0.1.0' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
    },
    instructions: `Messages from the Matrix channel arrive as <channel source="matrix" room_id="..." sender="..." ...>.
Reply using the reply tool with the room_id from the inbound message.
Use react to acknowledge messages with emoji.
Use fetch_messages to read recent history from a room.
Keep replies concise — Matrix supports long messages but brevity is better for chat.`,
  }
)

// ── Tools ────────────────────────────────────────────────────────────────────
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'Send a message to a Matrix room. Auto-chunks if needed. Returns sent event ID(s).',
      inputSchema: {
        type: 'object',
        properties: {
          room_id: {
            type: 'string',
            description: 'Matrix room ID (e.g. !abc123:matrix.org)',
          },
          text: { type: 'string', description: 'Message text (markdown supported)' },
          reply_to: {
            type: 'string',
            description: 'Event ID to reply to (creates threaded reply)',
          },
        },
        required: ['room_id', 'text'],
      },
    },
    {
      name: 'react',
      description: 'React to a message with an emoji.',
      inputSchema: {
        type: 'object',
        properties: {
          room_id: { type: 'string', description: 'Matrix room ID' },
          event_id: { type: 'string', description: 'Event ID to react to' },
          emoji: { type: 'string', description: 'Emoji to react with (e.g. 👍)' },
        },
        required: ['room_id', 'event_id', 'emoji'],
      },
    },
    {
      name: 'edit_message',
      description: "Edit a message the bot previously sent. Only works on the bot's own messages.",
      inputSchema: {
        type: 'object',
        properties: {
          room_id: { type: 'string', description: 'Matrix room ID' },
          event_id: { type: 'string', description: 'Event ID of message to edit' },
          text: { type: 'string', description: 'New message text' },
        },
        required: ['room_id', 'event_id', 'text'],
      },
    },
    {
      name: 'fetch_messages',
      description:
        'Fetch recent messages from a Matrix room. Returns oldest-first with event IDs. Messages with attachments are marked +Natt.',
      inputSchema: {
        type: 'object',
        properties: {
          room_id: { type: 'string', description: 'Matrix room ID' },
          limit: {
            type: 'number',
            description: 'Number of messages to fetch (default 20, max 100)',
          },
        },
        required: ['room_id'],
      },
    },
    {
      name: 'download_attachment',
      description:
        'Download attachments from a specific Matrix message. Returns file paths and metadata. Files are saved to ~/.claude/channels/matrix/inbox/.',
      inputSchema: {
        type: 'object',
        properties: {
          room_id: { type: 'string', description: 'Matrix room ID' },
          event_id: { type: 'string', description: 'Event ID of the message with attachments' },
        },
        required: ['room_id', 'event_id'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments as Record<string, unknown>
  log('INFO', `tool: ${req.params.name} called with ${JSON.stringify(args).slice(0, 200)}`)

  switch (req.params.name) {
    case 'reply': {
      const roomId = args.room_id as string
      const text = args.text as string
      const replyTo = args.reply_to as string | undefined
      const access = loadAccess()
      const chunks = chunk(text, access.textChunkLimit, access.chunkMode)
      const sentIds: string[] = []
      const workingId = getWorkingId(roomId)

      for (let i = 0; i < chunks.length; i++) {
        // Edit the "working..." message with the first chunk
        if (i === 0 && workingId) {
          await client.sendEvent(roomId, 'm.room.message', {
            msgtype: 'm.text',
            body: `* ${chunks[i]}`,
            'm.new_content': {
              msgtype: 'm.text',
              body: chunks[i],
            },
            'm.relates_to': {
              rel_type: 'm.replace',
              event_id: workingId,
            },
          })
          sentIds.push(workingId)
          pendingWorkingMessages.delete(roomId)
          continue
        }

        const content: Record<string, unknown> = {
          msgtype: 'm.text',
          body: chunks[i],
          format: 'org.matrix.custom.html',
          formatted_body: chunks[i],
        }

        // Thread subsequent chunks under the replied-to message
        if (replyTo && (access.replyToMode === 'all' || (access.replyToMode === 'first' && i === 0))) {
          content['m.relates_to'] = {
            'm.in_reply_to': { event_id: replyTo },
          }
        }

        const res = await client.sendEvent(roomId, 'm.room.message', content)
        sentIds.push(res.event_id)
        trackSent(res.event_id)
      }
      return { content: [{ type: 'text', text: `sent: ${sentIds.join(', ')}` }] }
    }

    case 'react': {
      const roomId = args.room_id as string
      const eventId = args.event_id as string
      const emoji = args.emoji as string
      await client.sendEvent(roomId, 'm.reaction', {
        'm.relates_to': {
          rel_type: 'm.annotation',
          event_id: eventId,
          key: emoji,
        },
      })
      return { content: [{ type: 'text', text: 'reacted' }] }
    }

    case 'edit_message': {
      const roomId = args.room_id as string
      const eventId = args.event_id as string
      const text = args.text as string
      await client.sendEvent(roomId, 'm.room.message', {
        msgtype: 'm.text',
        body: `* ${text}`,
        'm.new_content': {
          msgtype: 'm.text',
          body: text,
        },
        'm.relates_to': {
          rel_type: 'm.replace',
          event_id: eventId,
        },
      })
      return { content: [{ type: 'text', text: 'edited' }] }
    }

    case 'fetch_messages': {
      const roomId = args.room_id as string
      const limit = Math.min((args.limit as number) || 20, 100)
      const res = await client.createMessagesRequest(roomId, undefined, limit, 'b')
      const messages = (res.chunk || []).reverse()
      const lines = messages
        .filter((e: any) => e.type === 'm.room.message')
        .map((e: any) => {
          const sender = e.sender || '?'
          const body = e.content?.body || ''
          const ts = new Date(e.origin_server_ts).toISOString()
          const msgtype = e.content?.msgtype || ''
          const attTag = ['m.image', 'm.file', 'm.audio', 'm.video'].includes(msgtype) ? ' +1att' : ''
          return `[${ts}] ${sender} (${e.event_id}): ${body}${attTag}`
        })
      return {
        content: [{ type: 'text', text: lines.join('\n') || '(no messages)' }],
      }
    }

    case 'download_attachment': {
      const roomId = args.room_id as string
      const eventId = args.event_id as string

      // Fetch the specific event
      const event = await client.fetchRoomEvent(roomId, eventId)
      const content = event.content || {}
      const msgtype = content.msgtype

      if (!['m.image', 'm.file', 'm.audio', 'm.video'].includes(msgtype)) {
        return { content: [{ type: 'text', text: 'no attachment on this message' }] }
      }

      const filename = content.body || 'attachment'
      const mxcUrl = content.url || content.file?.url
      if (!mxcUrl) {
        return { content: [{ type: 'text', text: 'no downloadable URL found' }] }
      }

      // Convert mxc:// URL to HTTP download URL
      const httpUrl = client.mxcUrlToHttp(mxcUrl, undefined, undefined, undefined, false, true)
      if (!httpUrl) {
        return { content: [{ type: 'text', text: 'failed to resolve mxc URL' }] }
      }

      // Download the file
      const response = await fetch(httpUrl)
      if (!response.ok) {
        return { content: [{ type: 'text', text: `download failed: ${response.status}` }] }
      }

      const buffer = Buffer.from(await response.arrayBuffer())
      const ts = Date.now()
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_')
      const outPath = join(INBOX_DIR, `${ts}_${safeName}`)
      const { writeFileSync: wfs } = await import('fs')
      wfs(outPath, buffer)

      const info = content.info || {}
      return {
        content: [{
          type: 'text',
          text: `downloaded: ${outPath}\nfilename: ${filename}\ntype: ${info.mimetype || 'unknown'}\nsize: ${info.size || buffer.length} bytes`,
        }],
      }
    }

    default:
      throw new Error(`unknown tool: ${req.params.name}`)
  }
})

// ── Permission relay handler ─────────────────────────────────────────────────
mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  const access = loadAccess()
  const msg =
    `🔐 **Permission request** (\`${params.request_id}\`)\n` +
    `Tool: \`${params.tool_name}\`\n` +
    `${params.description}\n\n` +
    `\`\`\`\n${params.input_preview}\n\`\`\`\n\n` +
    `Reply \`yes ${params.request_id}\` or \`no ${params.request_id}\``

  // Send to all allowed users via DM — find existing DM first, create only if needed
  for (const userId of access.allowFrom) {
    try {
      const rooms = client.getRooms()
      const existing = rooms.find(
        (r) => isDm(r) && r.getJoinedMembers().some((m) => m.userId === userId)
      )
      if (existing) {
        await client.sendTextMessage(existing.roomId, msg)
      } else {
        const created = await client.createRoom({
          is_direct: true,
          invite: [userId],
          preset: sdk.Preset.TrustedPrivateChat as any,
        })
        await client.sendTextMessage(created.room_id, msg)
      }
    } catch (e) {
      log('WARN', `permission relay: failed to notify ${userId}: ${e}`)
    }
  }
})

// ── Inbound message handler ──────────────────────────────────────────────────
async function handleInbound(event: any, room: sdk.Room) {
  // Ignore own messages
  if (event.getSender() === USER_ID) return

  // Only handle room messages
  if (event.getType() !== 'm.room.message') return
  const content = event.getContent()
  const msgtype = content.msgtype
  if (!['m.text', 'm.image', 'm.file', 'm.audio', 'm.video'].includes(msgtype)) return

  const senderId = event.getSender()
  const body = content.body || ''
  log('INFO', `inbound: ${senderId} in ${room.roomId} [${msgtype}]: ${body.slice(0, 100)}`)
  const roomId = room.roomId
  const eventId = event.getId()

  // Check for permission reply
  const permMatch = PERMISSION_RE.exec(body)
  if (permMatch) {
    const access = loadAccess()
    if (access.allowFrom.includes(senderId)) {
      await mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: {
          request_id: permMatch[2].toLowerCase(),
          behavior: permMatch[1].toLowerCase().startsWith('y') ? 'allow' : 'deny',
        },
      })
      // Ack the permission response
      try {
        await client.sendEvent(roomId, 'm.reaction', {
          'm.relates_to': {
            rel_type: 'm.annotation',
            event_id: eventId,
            key: '✅',
          },
        })
      } catch {}
      return
    }
  }

  const access = loadAccess()

  // ── Access gate ──
  if (isDm(room)) {
    // DM access control
    if (access.allowFrom.includes(senderId)) {
      log('INFO', `access: DM allowed for ${senderId}`)
    } else if (access.dmPolicy === 'pairing') {
      log('INFO', `access: DM pairing triggered for ${senderId}`)
      const code = randomCode()
      access.pending[code] = {
        userId: senderId,
        roomId,
        displayName: event.sender?.name || senderId,
        ts: Date.now(),
      }
      saveAccess(access)
      await client.sendTextMessage(
        roomId,
        `Pairing code: \`${code}\`\nAsk the Claude Code operator to run: /matrix:access pair ${code}`
      )
      return
    } else {
      log('INFO', `access: DM dropped for ${senderId} (policy: ${access.dmPolicy})`)
      return
    }
  } else {
    // Room access control
    const roomConfig = access.rooms[roomId]
    if (!roomConfig) { log('INFO', `access: room ${roomId} not opted in — dropped`); return }

    // Check sender allowlist for this room
    if (roomConfig.allowFrom.length > 0 && !roomConfig.allowFrom.includes(senderId)) return

    // Check mention requirement
    if (roomConfig.requireMention) {
      const mentioned =
        // Direct mention in formatted body
        content.formatted_body?.includes(USER_ID) ||
        // Reply to bot's message
        (content['m.relates_to']?.['m.in_reply_to']?.event_id &&
          recentSentIds.has(content['m.relates_to']['m.in_reply_to'].event_id)) ||
        // Regex mention patterns
        access.mentionPatterns.some((p) => new RegExp(p, 'i').test(body))

      if (!mentioned) return
    }
  }

  // Clear any stale working message from a previous unanswered message
  pendingWorkingMessages.delete(roomId)

  // ── Ack reaction ──
  if (access.ackReaction) {
    try {
      await client.sendEvent(roomId, 'm.reaction', {
        'm.relates_to': {
          rel_type: 'm.annotation',
          event_id: eventId,
          key: access.ackReaction,
        },
      })
    } catch {}
  }

  // ── "Working..." indicator ──
  let workingEventId: string | undefined
  try {
    const res = await client.sendEvent(roomId, 'm.room.message', {
      msgtype: 'm.text',
      body: '⏳ Working on it...',
    })
    workingEventId = res.event_id
    trackSent(res.event_id)
  } catch {}

  // Store the working message ID so the reply tool can edit it instead of sending a new message
  if (workingEventId) {
    pendingWorkingMessages.set(roomId, { eventId: workingEventId, ts: Date.now() })
  }

  // ── Deliver to Claude ──
  const meta: Record<string, string> = {
    room_id: roomId,
    event_id: eventId,
    sender: senderId,
    display_name: event.sender?.name || senderId,
    ts: new Date(event.getTs()).toISOString(),
  }

  // Attachment metadata (not auto-downloaded)
  if (['m.image', 'm.file', 'm.audio', 'm.video'].includes(msgtype)) {
    const info = content.info || {}
    meta.attachment_count = '1'
    meta.attachment_name = content.body || 'attachment'
    meta.attachment_type = info.mimetype || 'unknown'
    meta.attachment_size = String(info.size || 0)
  }

  log('INFO', `deliver: pushing to Claude — ${senderId}: "${body.slice(0, 80)}"`)
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: msgtype === 'm.text' ? body : `[${msgtype.replace('m.', '')} attachment: ${body}]`,
      meta,
    },
  })
  log('INFO', 'deliver: notification sent to Claude')
}

// ── Start ────────────────────────────────────────────────────────────────────
async function main() {
  // Start MCP transport
  const transport = new StdioServerTransport()
  await mcp.connect(transport)

  // Start Matrix client
  log('INFO', `starting: connecting to ${HOMESERVER} as ${USER_ID}`)
  await client.startClient({ initialSyncLimit: 0 })

  // Wait for first sync
  await new Promise<void>((resolve) => {
    client.once(sdk.ClientEvent.Sync as any, (state: string) => {
      if (state === 'PREPARED') resolve()
    })
  })
  const rooms = client.getRooms()
  log('INFO', `synced: ${rooms.length} rooms joined`)

  // Auto-join invited rooms
  client.on(sdk.RoomMemberEvent.Membership as any, (event: any, member: any) => {
    if (member.membership === 'invite' && member.userId === USER_ID) {
      client.joinRoom(member.roomId).catch(() => {})
    }
  })

  // Listen for messages
  client.on(sdk.RoomEvent.Timeline as any, (event: any, room: sdk.Room | undefined) => {
    if (!room) return
    // Skip events from initial sync
    if ((event as any).isOldEvent?.() ?? false) return
    handleInbound(event, room).catch((e) => {
      log('ERROR', `inbound handler: ${e.message || e}`)
    })
  })
}

main().catch((e) => {
  console.error('matrix channel fatal:', e)
  process.exit(1)
})
