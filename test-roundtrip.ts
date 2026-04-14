#!/usr/bin/env bun
/**
 * End-to-end roundtrip test — sends a message as the test user, verifies the bot
 * receives it and replies.
 *
 * Usage: bun test-roundtrip.ts
 *
 * Requires MATRIX_TEST_USER and MATRIX_TEST_PASSWORD in ~/.claude/channels/matrix/.env
 */
import * as sdk from 'matrix-js-sdk'
import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const STATE_DIR = join(homedir(), '.claude', 'channels', 'matrix')
const env: Record<string, string> = {}
try {
  for (const line of readFileSync(join(STATE_DIR, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m) env[m[1]] = m[2]
  }
} catch {}

const HOMESERVER = env.MATRIX_HOMESERVER || 'http://localhost:8448'
const BOT_USER = env.MATRIX_USER_ID || (() => { throw new Error('MATRIX_USER_ID is required') })()

const TEST_USER = env.MATRIX_TEST_USER || (() => { throw new Error('MATRIX_TEST_USER is required') })()
const TEST_PASS = env.MATRIX_TEST_PASSWORD || (() => { throw new Error('MATRIX_TEST_PASSWORD is required') })()
const TEST_USER_LOCAL = TEST_USER.replace(/^@/, '').split(':')[0]

async function main() {
  console.log('═══ Matrix Roundtrip Test ═══\n')

  // ── Login as test user ──
  console.log(`▸ Logging in as ${TEST_USER}...`)
  let testToken: string
  let testUserId: string
  try {
    const r = await fetch(`${HOMESERVER}/_matrix/client/v3/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'm.login.password', user: TEST_USER_LOCAL, password: TEST_PASS }),
    })
    const j = await r.json() as any
    if (!j.access_token) throw new Error(JSON.stringify(j))
    testToken = j.access_token
    testUserId = j.user_id
    console.log(`  ✅ Logged in as ${testUserId}\n`)
  } catch (e: any) {
    console.log(`  ❌ Login failed: ${e.message}\n`)
    process.exit(1)
  }

  const testClient = sdk.createClient({ baseUrl: HOMESERVER, accessToken: testToken!, userId: testUserId! })

  // ── Find or create DM with bot ──
  console.log('▸ Finding DM room with bot...')
  await testClient.startClient({ initialSyncLimit: 1 })
  await new Promise<void>(resolve => {
    testClient.once(sdk.ClientEvent.Sync as any, (state: string) => {
      if (state === 'PREPARED') resolve()
    })
  })

  let dmRoom: string | null = null
  for (const room of testClient.getRooms()) {
    const members = room.getJoinedMembers()
    if (members.length <= 2 && members.some(m => m.userId === BOT_USER)) {
      dmRoom = room.roomId
      break
    }
  }

  if (!dmRoom) {
    console.log('  No DM found, creating one...')
    try {
      const res = await testClient.createRoom({
        is_direct: true,
        invite: [BOT_USER],
        preset: sdk.Preset.TrustedPrivateChat as any,
      })
      dmRoom = res.room_id
      console.log(`  ✅ Created DM: ${dmRoom}`)
      // Wait for bot to join
      await new Promise(r => setTimeout(r, 3000))
    } catch (e: any) {
      console.log(`  ❌ Failed to create DM: ${e.message}`)
      process.exit(1)
    }
  } else {
    console.log(`  ✅ Found DM: ${dmRoom}`)
  }
  console.log()

  // ── Send test message ──
  const testId = Math.random().toString(36).slice(2, 8)
  const testMsg = `[roundtrip-test-${testId}] ping`
  console.log(`▸ Sending: "${testMsg}"`)
  try {
    const res = await testClient.sendTextMessage(dmRoom!, testMsg)
    console.log(`  ✅ Sent: ${res.event_id}\n`)
  } catch (e: any) {
    console.log(`  ❌ Send failed: ${e.message}\n`)
    process.exit(1)
  }

  // ── Wait for bot reply ──
  console.log('▸ Waiting for bot reply (60s timeout)...')
  let replied = false
  const replyPromise = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('no reply within 60s')), 60000)
    testClient.on(sdk.RoomEvent.Timeline as any, (event: any, room: any) => {
      if (room?.roomId !== dmRoom) return
      if (event.getSender() !== BOT_USER) return
      if (event.getType() !== 'm.room.message') return
      const body = event.getContent()?.body || ''
      // Skip the "working..." message
      if (body === '⏳ Working on it...') {
        console.log('  📨 Got "Working on it..." indicator')
        return
      }
      clearTimeout(timeout)
      resolve(body)
    })
  })

  try {
    const reply = await replyPromise
    replied = true
    console.log(`  ✅ Bot replied: "${reply.slice(0, 100)}${reply.length > 100 ? '...' : ''}"`)
  } catch (e: any) {
    console.log(`  ❌ ${e.message}`)
  }

  // ── Cleanup ──
  testClient.stopClient()
  console.log()
  console.log('═══════════════════════════════')
  console.log(replied ? '  ✅ ROUNDTRIP PASSED' : '  ❌ ROUNDTRIP FAILED')
  console.log('═══════════════════════════════')
  process.exit(replied ? 0 : 1)
}

main()
