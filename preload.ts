// Redirect all console output to stderr before any module loads.
// matrix-js-sdk uses loglevel which writes debug to stdout via console.log,
// corrupting the MCP JSON-RPC transport on stdin/stdout.
const stderrWrite = (msg: string) => process.stderr.write(msg + '\n')
console.log = stderrWrite as any
console.debug = stderrWrite as any
console.info = stderrWrite as any
