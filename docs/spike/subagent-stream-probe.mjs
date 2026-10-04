// Per-subagent stable id, status, timing, and live-stream RPC probe (spec 004 T003, extends
// FINDINGS C6 and spec 001 task T071(d)'s probe -- docs/spike/chat-lines-probe.mjs scenario (e)
// -- rather than repeating either).
//
// Question: does `tool_call_update` progress (or a `set_subagent_subscription` frame, named in
// FINDINGS C6) carry a per-subagent text/tool-call stream, or only a status/timing summary (in
// which case per-subagent text must come from somewhere else, such as nested
// message_start/message_end frames scoped to the subagent)? Also: is there a stable id per
// subagent usable as a React key and as the argument to chat.setVisibleSubagent?
//
// This uses Stuart's REAL default OMP profile (no --profile flag): the scenario needs a real
// model to drive the task tool's subagents, but:
//   - `--session-dir` points at a scratch temp directory, never his real session history.
//   - cwd is a brand-new scratch git repo, never his real working trees.
//   - `--approval-mode=always-ask`, approving ONLY the task tool's own "Allow tool: task" gate
//     (orchestration, not an executor), exactly as chat-lines-probe.mjs's approveTaskOnly does.
//   - SAFETY: once "task" is approved, a subagent's own tool calls are NOT gated at all (same
//     caveat as chat-lines-probe.mjs). The scenario prompt below only asks subagents to read a
//     fixed scratch file already present in the scratch repo and report its contents -- no
//     writes, no network, no shell commands outside the scratch cwd.
//
// Run:  node docs/spike/subagent-stream-probe.mjs
// Env:  PINION_OMP          omp executable (default "omp" from PATH)
//       PINION_PROBE_MODEL  model id (default github-copilot/gpt-5.6-luna)

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OMP = process.env.PINION_OMP || 'omp';
const MODEL = process.env.PINION_PROBE_MODEL || 'github-copilot/gpt-5.6-luna';
const READY_MS = 120_000;
const REQUEST_MS = 60_000;
const PROMPT_MS = 180_000;
const EXIT_MS = 30_000;

const T0 = Date.now();
const ROOT = path.join(os.tmpdir(), 'pinion-subagent-stream-probe', new Date().toISOString().replace(/[:.]/g, '-'));
const dir = (name) => path.join(ROOT, name);
for (const d of ['repo', 'session-dir', 'frames']) {
  fs.mkdirSync(dir(d), { recursive: true });
}

try {
  execFileSync('git', ['init', '-q', '-b', 'main', dir('repo')]);
  fs.writeFileSync(path.join(dir('repo'), 'NOTES.md'), 'Alpha fact: the sky is teal today.\nBeta fact: the river is silver today.\n');
  execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'add', '-A'], { cwd: dir('repo') });
  execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'commit', '-m', 'init'], { cwd: dir('repo') });
} catch (e) {
  console.error(`scratch repo init failed: ${e.message}`);
  process.exit(2);
}

// ---- OmpProc: identical pattern to docs/spike/chat-lines-probe.mjs.
class OmpProc {
  constructor(label, { sessionDir, cwd, onDialog } = {}) {
    this.label = label;
    this.frames = [];
    this.waiters = [];
    this.warnings = [];
    this.chunks = new Map();
    this.buf = Buffer.alloc(0);
    this.readyMs = null;
    this.exitCode = null;
    this.onDialog = onDialog || (() => false);
    this.log = fs.createWriteStream(path.join(dir('frames'), `${label}.jsonl`));
    this.errLog = fs.createWriteStream(path.join(dir('frames'), `${label}.stderr.log`));
    const args = ['--mode', 'rpc-ui', '--approval-mode=always-ask'];
    if (sessionDir) args.push('--session-dir', sessionDir);
    if (MODEL !== 'none') args.push('--model', MODEL);
    this.startedAt = Date.now();
    this.child = spawn(OMP, args, { cwd, env: process.env, stdio: 'pipe', windowsHide: true });
    this.exitPromise = new Promise((resolve) => {
      this.child.on('exit', (code) => {
        this.exitCode = code;
        resolve();
      });
    });
    this.child.on('error', (e) => console.error(`${label}: omp not found: ${e.message}`));
    this.child.stdout.on('data', (d) => this.#onData(d));
    this.child.stderr.on('data', (d) => this.errLog.write(d));
  }

  #record(dir_, frame, extra = {}) {
    this.log.write(JSON.stringify({ t: Date.now() - T0, dir: dir_, frame, ...extra }) + '\n');
  }

  #onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    let i;
    while ((i = this.buf.indexOf(0x0a)) >= 0) {
      const line = this.buf.subarray(0, i).toString('utf8').trim();
      this.buf = this.buf.subarray(i + 1);
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch (e) {
        this.#record('out', line, { parseError: true });
        continue;
      }
      this.#handle(frame);
    }
  }

  #handle(frame) {
    if (frame.type === 'rpc_chunk') {
      let c = this.chunks.get(frame.chunkId);
      if (!c) {
        c = { parts: new Array(frame.count), got: 0, byteLength: frame.byteLength };
        this.chunks.set(frame.chunkId, c);
      }
      c.parts[frame.index] = c.parts[frame.index] ?? Buffer.from(frame.data, 'base64');
      c.got++;
      if (c.got !== frame.count) return;
      const whole = Buffer.concat(c.parts);
      this.chunks.delete(frame.chunkId);
      if (whole.length !== c.byteLength) {
        this.#record('out', { type: '__probe_protocol_error', error: `chunk ${frame.chunkId}: got ${whole.length} bytes, expected ${c.byteLength}` });
        return;
      }
      try {
        frame = JSON.parse(whole.toString('utf8'));
      } catch (e) {
        this.#record('out', { type: '__probe_protocol_error', error: `chunk ${frame.chunkId}: ${e.message}` });
        return;
      }
    }
    this.#dispatch(frame);
  }

  #dispatch(frame) {
    const idx = this.frames.length;
    this.frames.push({ type: frame.type, frame, t: Date.now() - T0 });
    this.#record('in', frame);
    if (frame.type === 'extension_ui_request') {
      if (this.onDialog(frame, this)) return;
      this.#answerDialog(frame);
    }
    for (const w of [...this.waiters]) {
      if (idx >= w.from && w.pred(frame)) this.waiters.splice(this.waiters.indexOf(w), 1), w.resolve(frame);
    }
  }

  #answerDialog(frame) {
    const title = frame.data?.title ?? '(omitted)';
    if (frame.method === 'select' && title.startsWith('Allow tool:')) {
      this.warnings.push(`approval denied: ${title.split('\n')[0]}`);
      this.write({ type: 'extension_ui_response', id: frame.id, value: 'Deny' });
    } else if (frame.method === 'select' || frame.method === 'input' || frame.method === 'editor') {
      this.warnings.push(`dialog cancelled: ${title.split('\n')[0]}`);
      this.write({ type: 'extension_ui_response', id: frame.id, cancelled: true });
    } else {
      this.write({ type: 'extension_ui_response', id: frame.id, cancelled: true });
    }
  }

  write(obj) {
    this.#record('out', obj);
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  async waitFor(pred, { timeout = REQUEST_MS, what } = {}) {
    const from = this.frames.length;
    for (let i = from; i < this.frames.length; i++) if (pred(this.frames[i].frame)) return this.frames[i].frame;
    return new Promise((resolve, reject) => {
      const w = { pred, from, resolve };
      const t = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`${this.label}: timeout waiting for ${what ?? '<frame>'}`));
      }, timeout);
      w.resolve = (f) => {
        clearTimeout(t);
        resolve(f);
      };
      this.waiters.push(w);
    });
  }

  async ready() {
    const r = await Promise.race([
      this.waitFor((f) => f.type === 'ready', { timeout: READY_MS, what: 'ready frame' }).then((f) => ({ ok: true, frame: f })),
      this.exitPromise.then(() => ({ ok: false })),
    ]);
    if (!r.ok) throw new Error(`process exited before ready frame (code ${this.exitCode}); see frames/${this.label}.stderr.log`);
    const readyFrame = r.frame;
    this.readyMs = Date.now() - this.startedAt;
    if (readyFrame.supportedProtocolVersions?.includes(2)) {
      const neg = await this.request({ type: 'negotiate_protocol', protocolVersion: 2 });
      if (!neg.success) throw new Error(`negotiate_protocol failed: ${neg.error}`);
    }
  }

  n = 0;

  async request(cmd, { timeout = REQUEST_MS } = {}) {
    const id = `${this.label}-${this.n++}`;
    this.write({ ...cmd, id });
    return this.waitFor((f) => f.type === 'response' && f.id === id, { timeout, what: `response to ${cmd.type}` });
  }

  async getState() {
    return (await this.request({ type: 'get_state' })).data;
  }

  async getMessages() {
    return (await this.request({ type: 'get_messages' })).data;
  }

  async promptOnce(message) {
    const id = `${this.label}-${this.n++}`;
    this.write({ id, type: 'prompt', message });
    const ack = await this.waitFor((f) => f.type === 'response' && f.id === id, { timeout: REQUEST_MS, what: 'prompt ack' });
    if (!ack.success) return { stage: 'response', success: false, error: ack.error, code: ack.code };
    if (ack.agentInvoked === false) return { stage: 'response', success: true, agentInvoked: false, data: ack.data };
    const frame = await this.waitFor((f) => f.type === 'prompt_result' && f.id === id, { timeout: PROMPT_MS, what: 'prompt_result' });
    return { stage: 'prompt_result', frame };
  }

  async closeGracefully() {
    this.child.stdin.end();
    const done = await Promise.race([this.exitPromise.then(() => true), new Promise((r) => setTimeout(() => r(false), EXIT_MS))]);
    if (!done) this.hardKill();
    return this.exitCode;
  }

  hardKill() {
    try {
      if (this.child.exitCode === null) execFileSync('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (e) {
      /* already gone */
    }
  }

  summary() {
    return { label: this.label, readyMs: this.readyMs, exitCode: this.exitCode, warnings: this.warnings };
  }
}

function shapeOf(v, depth = 0) {
  if (depth > 4) return typeof v;
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth + 1)] : [];
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = shapeOf(val, depth + 1);
    return out;
  }
  return typeof v;
}

function frameShape(f) {
  return { type: f.type, keys: Object.keys(f), shape: shapeOf(f) };
}

// Approves ONLY the task tool's own "Allow tool: task" gate (chat-lines-probe.mjs's
// approveTaskOnly, reused verbatim); every other "Allow tool:" dialog still falls through to the
// default deny-everything logic.
function approveTaskOnly(frame, proc) {
  const title = frame.data?.title ?? frame.title ?? '';
  if (frame.method === 'select' && /^Allow tool: task\b/.test(title)) {
    proc.write({ type: 'extension_ui_response', id: frame.id, value: 'Approve' });
    return true;
  }
  return false;
}

// ---- main ----
let ompVersion = 'unknown';
try {
  ompVersion = execFileSync(OMP, ['--version'], { encoding: 'utf8' }).trim();
} catch (e) {
  console.error(`omp not found; set PINION_OMP (${e.message})`);
  process.exit(2);
}
console.log(`omp ${ompVersion} | model ${MODEL}\nscratch ${ROOT}\n`);

const results = {
  ompVersion,
  model: MODEL,
  scratch: ROOT,
  subscriptionRpc: null,
  outcome: null,
  taskCallFrames: [],
  toolCallUpdateFrames: [],
  nestedMessageFramesDuringTask: [],
  liveFrameTypes: [],
  error: null,
};
let scriptFailed = false;

try {
  const p = new OmpProc('probe', { sessionDir: dir('session-dir'), cwd: dir('repo'), onDialog: approveTaskOnly });
  await p.ready();

  // Does set_subagent_subscription exist as a real request at all? (FINDINGS C6 named it as a
  // hypothesis, never confirmed as an implemented RPC command.)
  const subResp = await p.request({ type: 'set_subagent_subscription', subscribe: true });
  results.subscriptionRpc = { success: subResp.success, error: subResp.error ?? null, data: subResp.success ? subResp.data : null };

  const taskPrompt =
    'Use the task tool to start two subagents in one call (pass a tasks array with two entries, ' +
    'named Alpha and Beta). Alpha must read NOTES.md in the current directory and reply with only ' +
    'the "Alpha fact" line it finds. Beta must read NOTES.md in the current directory and reply ' +
    'with only the "Beta fact" line it finds. Then summarize both replies.';

  const outcome = await p.promptOnce(taskPrompt);
  results.outcome = outcome.stage === 'prompt_result' ? { stage: 'prompt_result', frame: frameShape(outcome.frame) } : outcome;
  if (outcome.stage !== 'prompt_result') scriptFailed = true;

  results.liveFrameTypes = [...new Set(p.frames.map((f) => f.frame.type))].sort();

  // Every frame touching the task tool's own toolCallId: tool_execution_start/end plus anything
  // named tool_call_update (unconfirmed/new frame type -- not in src/shared/frames.ts yet).
  const taskStart = p.frames.find((f) => f.frame.type === 'tool_execution_start' && f.frame.toolName === 'task');
  const taskCallId = taskStart?.frame.toolCallId;
  results.taskCallFrames = p.frames
    .filter((f) => f.frame.toolCallId === taskCallId || (f.frame.type === 'tool_execution_start' && f.frame.toolName === 'task') || (f.frame.type === 'tool_execution_end' && f.frame.toolName === 'task'))
    .map((f) => ({ t: f.t, shape: frameShape(f.frame) }));

  results.toolCallUpdateFrames = p.frames.filter((f) => f.frame.type === 'tool_call_update').map((f) => ({ t: f.t, shape: frameShape(f.frame) }));

  // Every message_start/message_update/message_end frame seen while the task call was in
  // flight (between its start and end timestamps), looking for subagent-scoped nested messages
  // -- the research.md item 3 fallback hypothesis if tool_call_update turns out status-only.
  const taskEnd = p.frames.find((f) => f.frame.type === 'tool_execution_end' && f.frame.toolName === 'task');
  const startT = taskStart?.t ?? 0;
  const endT = taskEnd?.t ?? Infinity;
  results.nestedMessageFramesDuringTask = p.frames
    .filter((f) => f.t >= startT && f.t <= endT && /^message_/.test(f.frame.type))
    .map((f) => ({ t: f.t, shape: frameShape(f.frame) }));

  const messages = await p.getMessages();
  results.subagentHistoryShape = (messages?.messages ?? [])
    .filter((m) => JSON.stringify(m).toLowerCase().includes('alpha') || JSON.stringify(m).toLowerCase().includes('beta'))
    .map((m) => shapeOf(m));

  await p.closeGracefully();
  results.summary = p.summary();
} catch (e) {
  results.error = (results.error ? results.error + '; ' : '') + e.message;
  scriptFailed = true;
  console.error('probe FAILED', e.message);
}

fs.writeFileSync(path.join(ROOT, 'result.json'), JSON.stringify(results, null, 2));
console.log('\n--- subscriptionRpc ---');
console.log(JSON.stringify(results.subscriptionRpc, null, 2));
console.log('\n--- liveFrameTypes ---');
console.log(JSON.stringify(results.liveFrameTypes, null, 2));
console.log('\n--- taskCallFrames (shapes) ---');
console.log(JSON.stringify(results.taskCallFrames, null, 2));
console.log('\n--- toolCallUpdateFrames (shapes) ---');
console.log(JSON.stringify(results.toolCallUpdateFrames, null, 2));
console.log(`\nscratch dir (raw frames, unredacted): ${ROOT}`);
process.exit(scriptFailed ? 1 : 0);
