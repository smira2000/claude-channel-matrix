#!/usr/bin/env bun
/**
 * Standalone Matrix connection test — runs outside of Claude Code.
 * Tests: credentials, sync, room list, send/receive, access control.
 *
 * Usage: bun test-connection.ts [--send "message" --room "!roomid:server"]
 */
import * as sdk from 'matrix-js-sdk'
import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const STATE_DIR = process.env.MATRIX_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'matrix')
const ENV_FILE = join(STATE_DIR, '.env')
const ACCESS_FILE = join(STATE_DIR, 'access.json')

// ── Load .env ──
const env: Record<string, string> = {}
try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m) env[m[1]] = m[2]
  }
} catch (e) {
  console.error(`❌ Cannot read ${ENV_FILE}:`, e)
  process.exit(1)
}

const HOMESERVER = env.MATRIX_HOMESERVER
const TOKEN = env.MATRIX_ACCESS_TOKEN
const USER_ID = env.MATRIX_USER_ID

// ── Parse args ──
const args = process.argv.slice(2)
const sendMsg = args.includes('--send') ? args[args.indexOf('--send') + 1] : null
const targetRoom = args.includes('--room') ? args[args.indexOf('--room') + 1] : null

let pass = 0, fail = 0, warn = 0
const ok = (m: string) => { console.log(`  ✅ ${m}`); pass++ }
const no = (m: string) => { console.log(`  ❌ ${m}`); fail++ }
const eh = (m: string) => { console.log(`  ⚠️  ${m}`); warn++ }

async function main() {
  console.log('═══ Matrix Channel Debug ═══\n')

  // ── 1. Credentials ──
  console.log('▸ Credentials')
  HOMESERVER ? ok(`MATRIX_HOMESERVER: ${HOMESERVER}`) : no('MATRIX_HOMESERVER missing')
  TOKEN ? ok(`MATRIX_ACCESS_TOKEN: ${TOKEN.slice(0, 10)}...`) : no('MATRIX_ACCESS_TOKEN missing')
  USER_ID ? ok(`MATRIX_USER_ID: ${USER_ID}`) : no('MATRIX_USER_ID missing')
  if (!HOMESERVER || !TOKEN || !USER_ID) process.exit(1)
  console.log()

  // ── 2. Homeserver reachability ──
  console.log('▸ Homeserver')
  try {
    const r = await fetch(`${HOMESERVER}/_matrix/client/versions`)
    const j = await r.json() as any
    ok(`Reachable — ${j.versions?.length} API versions supported`)
  } catch (e: any) {
    no(`Cannot reach ${HOMESERVER}: ${e.message}`)
    process.exit(1)
  }
  console.log()

  // ── 3. Token validation ──
  console.log('▸ Authentication')
  try {
    const r = await fetch(`${HOMESERVER}/_matrix/client/v3/account/whoami`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    const j = await r.json() as any
    if (j.user_id === USER_ID) {
      ok(`Token valid for ${j.user_id} (device: ${j.device_id})`)
    } else if (j.user_id) {
      eh(`Token belongs to ${j.user_id}, expected ${USER_ID}`)
    } else {
      no(`Token rejected: ${JSON.stringify(j)}`)
    }
  } catch (e: any) {
    no(`Auth check failed: ${e.message}`)
  }
  console.log()

  // ── 4. Access config ──
  console.log('▸ Access Control')
  try {
    const access = JSON.parse(readFileSync(ACCESS_FILE, 'utf8'))
    ok(`DM policy: ${access.dmPolicy}`)
    ok(`Allowed users: ${access.allowFrom?.join(', ') || '(none)'}`)
    const roomCount = Object.keys(access.rooms || {}).length
    ok(`Opted-in rooms: ${roomCount}`)
    if (access.pending && Object.keys(access.pending).length > 0) {
      eh(`${Object.keys(access.pending).length} pending pairing(s)`)
    }
  } catch {
    eh('No access.json found — defaults will be used (pairing mode)')
  }
  console.log()

  // ── 5. Client sync ──
  console.log('▸ Matrix Sync')
  const client = sdk.createClient({ baseUrl: HOMESERVER, accessToken: TOKEN, userId: USER_ID })

  try {
    await client.startClient({ initialSyncLimit: 0 })
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('sync timeout (15s)')), 15000)
      client.once(sdk.ClientEvent.Sync as any, (state: string) => {
        clearTimeout(timeout)
        if (state === 'PREPARED') resolve()
        else reject(new Error(`unexpected sync state: ${state}`))
      })
    })
    ok('Initial sync completed')
  } catch (e: any) {
    no(`Sync failed: ${e.message}`)
    process.exit(1)
  }

  // ── 6. Room list ──
  console.log()
  console.log('▸ Joined Rooms')
  const rooms = client.getRooms()
  if (rooms.length === 0) {
    eh('Bot is not in any rooms — invite it to start chatting')
  } else {
    for (const room of rooms) {
      const members = room.getJoinedMembers()
      const memberNames = members.map(m => m.userId).join(', ')
      const isDm = members.length <= 2
      const label = isDm ? '(DM)' : `(${members.length} members)`
      ok(`${room.roomId} ${label} — ${room.name || '(unnamed)'} [${memberNames}]`)
    }
  }
  console.log()

  // ── 7. Send test message ──
  if (sendMsg && targetRoom) {
    console.log('▸ Send Test')
    try {
      const res = await client.sendTextMessage(targetRoom, sendMsg)
      ok(`Sent to ${targetRoom}: event ${res.event_id}`)
    } catch (e: any) {
      no(`Send failed: ${e.message}`)
    }
    console.log()
  }

  // ── 8. Listen test (5 seconds) ──
  console.log('▸ Listener (5s window — send a message to the bot now)')
  let received = 0
  client.on(sdk.RoomEvent.Timeline as any, (event: any, room: any) => {
    if (event.getSender() === USER_ID) return
    if (event.getType() !== 'm.room.message') return
    received++
    const sender = event.getSender()
    const body = event.getContent()?.body || ''
    console.log(`    📨 ${sender} in ${room?.roomId}: "${body}"`)
  })
  await new Promise(r => setTimeout(r, 5000))
  received > 0 ? ok(`Received ${received} message(s)`) : eh('No messages received (expected if nobody sent one)')

  // ── Cleanup ──
  client.stopClient()
  console.log()
  console.log('═══════════════════════════════')
  console.log(`  ✅ ${pass} passed  ❌ ${fail} failed  ⚠️  ${warn} warnings`)
  console.log('═══════════════════════════════')
  process.exit(fail)
}

main()
