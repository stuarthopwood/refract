// Issue #700/#701 pinned-panel slice (a) probe: the exact live shape of the `todo` tool's own
// `tool_execution_end` `result.details.phases`, specifically whether a `blocker` string
// accompanies a blocked task and what literal `status` values OMP sends (`completed`,
// `abandoned`, `blocked`, `in_progress`/`in-progress`, `pending`). FINDINGS item 35(d) already
// established `{name, tasks:[{content, status}]}` on omp 18.5.1 but never exercised a blocked or
// abandoned task, and the decision record for #700/#701 requires the panel to retain `blocker`
// and distinguish `abandoned` from `completed` -- this probe must observe both before the Rust
// side (`readout_todo.rs`) is written to rely on either.
//
// Scratch isolation (same convention as docs/spike/todo-progress-probe.mjs): `--session-dir`
// under the OS temp dir, cwd a brand-new scratch git repo, `--approval-mode=always-ask` with a
// deny-everything dialog handler (the `todo` tool needs no approval, matches the existing probe's
// own observation).
//
// Run:  node docs/spike/todo-tree-pin-probe-700.mjs
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
const PROMPT_MS = 240_000;
const EXIT_MS = 30_000;

const T0 = Date.now();
const ROOT = path.join(os.tmpdir(), 'pinion-todo-tree-pin-probe-700', new Date().toISOString().replace(/[:.]/g, '-'));
const dir = (name) => path.join(ROOT, name);
for (const d of ['repo', 'session-dir', 'frames']) {
  fs.mkdirSync(dir(d), { recursive: true });
}

try {
  execFileSync('git', ['init', '-q', '-b', 'main', dir('repo')]);
  execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'commit', '--allow-empty', '-m', 'init'], {
    cwd: dir('repo'),
  });
} catch (e) {
  console.error(`scratch repo init failed: ${e.message}`);
  process.exit(2);
}

// ---- OmpProc: identical pattern to docs/spike/todo-progress-probe.mjs.
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

// ---- main ----
let ompVersion = 'unknown';
try {
  ompVersion = execFileSync(OMP, ['--version'], { encoding: 'utf8' }).trim();
} catch (e) {
  console.error(`omp not found; set PINION_OMP (${e.message})`);
  process.exit(2);
}
console.log(`omp ${ompVersion} | model ${MODEL}\nscratch ${ROOT}\n`);

const results = { ompVersion, model: MODEL, scratch: ROOT, todoToolCallsRaw: [], getStateAfter: null, error: null };
let scriptFailed = false;

try {
  const p = new OmpProc('probe', { sessionDir: dir('session-dir'), cwd: dir('repo') });
  await p.ready();

  // One turn, five tasks in one phase, every status slice (a) cares about: completed, abandoned,
  // blocked-with-a-blocker-string, in-progress, and left pending. Asked to use the todo tool's
  // own blocked-marking mechanism (not just prose) so any `blocker` field OMP itself writes shows
  // up, never guessed from the prompt text.
  const outcome = await p.promptOnce(
    'Use the todo tool to create exactly five tasks in one phase: "Write tests", "Implement feature", ' +
    '"Update docs", "Deploy", "Clean up". Then, using the todo tool\'s own status-changing actions: ' +
    'mark "Write tests" done (completed); mark "Implement feature" in progress (the current task); ' +
    'mark "Update docs" blocked, with the blocker reason "waiting on API docs"; ' +
    'mark "Deploy" abandoned; leave "Clean up" pending (make no further change to it). ' +
    'Do this all via the todo tool itself, one call per state change, then reply with only the word done.'
  );
  if (outcome.stage !== 'prompt_result') {
    results.error = `turn did not complete via prompt_result: ${JSON.stringify(outcome)}`;
    scriptFailed = true;
  }

  results.todoToolCallsRaw = p.frames
    .filter((f) => f.frame.type === 'tool_execution_end' && f.frame.toolName === 'todo')
    .map((f) => ({ t: f.t, frame: f.frame }));

  const after = await p.getState();
  results.getStateAfter = { todoPhases: after?.todoPhases ?? null };

  await p.closeGracefully();
  results.summary = p.summary();
} catch (e) {
  results.error = (results.error ? results.error + '; ' : '') + e.message;
  scriptFailed = true;
  console.error('probe FAILED', e.message);
}

fs.writeFileSync(path.join(ROOT, 'result.json'), JSON.stringify(results, null, 2));
console.log('\n--- last todo tool_execution_end result.details ---');
const last = results.todoToolCallsRaw[results.todoToolCallsRaw.length - 1];
console.log(JSON.stringify(last?.frame?.result?.details ?? null, null, 2));
console.log('\n--- every todo tool_execution_end result.details.phases (chronological) ---');
for (const call of results.todoToolCallsRaw) {
  console.log(JSON.stringify(call.frame?.result?.details?.phases ?? null));
}
console.log('\n--- get_state().todoPhases after settle ---');
console.log(JSON.stringify(results.getStateAfter?.todoPhases, null, 2));
console.log(`\nscratch dir (raw frames, unredacted): ${ROOT}`);
process.exit(scriptFailed ? 1 : 0);
