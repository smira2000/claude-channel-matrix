#!/usr/bin/env bun
// Wrapper that silences matrix-js-sdk stdout pollution before loading server.ts.
// matrix-js-sdk uses loglevel which writes debug logs via console.log to stdout,
// corrupting the MCP JSON-RPC stdio transport. Override BEFORE any import.

const _origLog = console.log
const _origDebug = console.debug
const _origInfo = console.info
const toStderr = (...args: unknown[]) => process.stderr.write(args.map(String).join(' ') + '\n')
console.log = toStderr as any
console.debug = toStderr as any
console.info = toStderr as any

// Now dynamically import the real server — loglevel will capture our overridden console
await import('./server.ts')
