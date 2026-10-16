// #570 decision 7 probe: capture one real failing `bash` `tool_execution_end` frame to confirm
// the shape of `result.content`/`details` a failed bash call's error line must derive from.
// Scratch session-dir + scratch cwd (never Stuart's real Sessions), real default OMP profile
// (no --profile override), --approval-mode=yolo so the single bash call runs with no approval
// dialog gate in the way. Pattern copied from docs/spike/chat-lines-probe.mjs's OmpProc.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const OMP = process.env.PINION_OMP || 'omp'
const T0 = Date.now()
const ROOT = path.join(os.tmpdir(), 'pinion-570-bash-fail-probe', new Date().toISOString().replace(/[:.]/g, '-'))
for (const d of ['repo', 'session-dir-stderr-failure', 'session-dir-silent-failure-no-output']) fs.mkdirSync(path.join(ROOT, d), { recursive: true })
try {
  execFileSync('git', ['init', '-q'], { cwd: path.join(ROOT, 'repo') })
} catch (e) {
  console.error('git init failed', e.message)
}

class OmpProc {
  constructor({ sessionDir, cwd }) {
    this.frames = []
    this.waiters = []
    this.buf = Buffer.alloc(0)
    this.chunks = new Map()
    this.n = 0
    const args = ['--mode', 'rpc-ui', '--approval-mode=yolo', '--session-dir', sessionDir]
    this.child = spawn(OMP, args, { cwd, env: process.env, stdio: 'pipe', windowsHide: true })
    this.exitPromise = new Promise((resolve) => this.child.on('exit', (code) => resolve(code)))
    this.child.on('error', (e) => console.error('omp not found:', e.message))
    this.child.stdout.on('data', (d) => this.#onData(d))
    this.child.stderr.on('data', (d) => process.stderr.write(d))
  }
  #onData(d) {
    this.buf = Buffer.concat([this.buf, d])
    let i
    while ((i = this.buf.indexOf(0x0a)) >= 0) {
      const line = this.buf.subarray(0, i).toString('utf8').trim()
      this.buf = this.buf.subarray(i + 1)
      if (!line) continue
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        continue
      }
      this.#handle(frame)
    }
  }
  #handle(frame) {
    if (frame.type === 'rpc_chunk') {
      let c = this.chunks.get(frame.chunkId)
      if (!c) {
        c = { parts: new Array(frame.count), got: 0 }
        this.chunks.set(frame.chunkId, c)
      }
      c.parts[frame.index] = c.parts[frame.index] ?? Buffer.from(frame.data, 'base64')
      c.got++
      if (c.got !== frame.count) return
      frame = JSON.parse(Buffer.concat(c.parts).toString('utf8'))
      this.chunks.delete(frame.chunkId)
    }
    this.#dispatch(frame)
  }
  #dispatch(frame) {
    const idx = this.frames.length
    this.frames.push(frame)
    if (frame.type === 'extension_ui_request') {
      // Deny everything except the implicit yolo auto-approve path (no dialog expected in yolo).
      this.write({ type: 'extension_ui_response', id: frame.id, cancelled: true })
    }
    for (const w of [...this.waiters]) {
      if (idx >= w.from && w.pred(frame)) {
        this.waiters.splice(this.waiters.indexOf(w), 1)
        w.resolve(frame)
      }
    }
  }
  write(obj) {
    this.child.stdin.write(JSON.stringify(obj) + '\n')
  }
  async waitFor(pred, { timeout = 60000, what } = {}) {
    const from = this.frames.length
    for (let i = from; i < this.frames.length; i++) if (pred(this.frames[i])) return this.frames[i]
    return new Promise((resolve, reject) => {
      const w = { pred, from, resolve }
      const t = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1)
        reject(new Error(`timeout waiting for ${what ?? '<frame>'}`))
      }, timeout)
      w.resolve = (f) => {
        clearTimeout(t)
        resolve(f)
      }
      this.waiters.push(w)
    })
  }
  async ready() {
    const r = await Promise.race([
      this.waitFor((f) => f.type === 'ready', { timeout: 120000, what: 'ready' }),
      this.exitPromise.then(() => null)
    ])
    if (!r) throw new Error('process exited before ready frame')
    const neg = await this.request({ type: 'negotiate_protocol', protocolVersion: 2 })
    if (!neg.success) throw new Error('negotiate_protocol failed')
  }
  async request(cmd, { timeout = 60000 } = {}) {
    const id = `p-${this.n++}`
    this.write({ ...cmd, id })
    return this.waitFor((f) => f.type === 'response' && f.id === id, { timeout, what: cmd.type })
  }
  async promptOnce(message, { timeout = 120000 } = {}) {
    const id = `p-${this.n++}`
    this.write({ id, type: 'prompt', message })
    const ack = await this.waitFor((f) => f.type === 'response' && f.id === id, { timeout: 60000, what: 'prompt ack' })
    if (!ack.success) return { stage: 'response', ack }
    const result = await this.waitFor((f) => f.type === 'prompt_result' && f.id === id, { timeout, what: 'prompt_result' })
    return { stage: 'prompt_result', result }
  }
}

// Two scenarios, each its own fresh OmpProc/scratch session-dir (never reused across scenarios,
// so one scenario's turn can never bleed into another's): (a) a real stderr failure, (b) a
// SILENT failure with no stdout or stderr at all -- the exact shape gate round 1 (G909Code High)
// found `errorLine()`'s first cut got wrong (it kept OMP's own `(no output)` placeholder and
// dropped the exit code).
const SCENARIOS = [
  {
    name: 'stderr-failure',
    prompt:
      "Run exactly ONE bash tool call: `ls /definitely-not-a-real-path-570`. It will fail. Wait for it to finish, then reply with exactly the single word 'probe570done' and nothing else."
  },
  {
    name: 'silent-failure-no-output',
    prompt:
      "Run exactly ONE bash tool call: `exit 9`. It will fail with no stdout or stderr output at all, only a non-zero exit code. Wait for it to finish, then reply with exactly the single word 'probe570doneb' and nothing else."
  }
]

;(async () => {
  for (const scenario of SCENARIOS) {
    console.log(`\n--- scenario: ${scenario.name} ---`)
    const proc = new OmpProc({ sessionDir: path.join(ROOT, `session-dir-${scenario.name}`), cwd: path.join(ROOT, 'repo') })
    await proc.ready()
    const r = await proc.promptOnce(scenario.prompt)
    const endFrames = proc.frames.filter((f) => f.type === 'tool_execution_end')
    console.log('tool_execution_end frames:', endFrames.length)
    for (const f of endFrames) {
      console.log(JSON.stringify({ toolName: f.toolName, isError: f.isError, content: f.result?.content, details: f.result?.details }, null, 2))
    }
    if (endFrames.length === 0) console.log('stage:', r.stage, JSON.stringify(r).slice(0, 2000))
    proc.child.stdin.end()
    await Promise.race([proc.exitPromise, new Promise((res) => setTimeout(res, 10000))])
    try {
      proc.child.kill()
    } catch {}
  }
  console.log('\nscratch root (scratch, safe to delete):', ROOT)
})().catch((e) => {
  console.error('PROBE ERROR', e)
  process.exitCode = 1
})
