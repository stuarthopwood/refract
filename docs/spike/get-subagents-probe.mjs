// `get_subagents` payload shape probe (issue #489, PLAN.md row A2c): confirms the response field
// names and, crucially, whether a *second, freshly-spawned* `omp` process that `switch_session`s
// onto the same Conversation file sees the first process's own in-flight subagent as
// `status: "running"` in its own `get_subagents` snapshot. Gate fixes 2 finding 10 (2026-10-07):
// this header used to claim this was "the exact crash and resume shape #489's fix seeds from" --
// stale the moment `SessionAgent.reconcileSubagentsOnAttach` stopped calling `get_subagents` at
// all (gate finding 5): the live contract this probe confirms is now the REASON that RPC is never
// sent there (a fresh process's own registry is unconditionally empty, so asking could never
// discriminate "genuinely still running" from "gone"), not something the fix "seeds from".
//
// The omp version actually run is printed at runtime (`omp --version`) and recorded in
// `result.json`'s own `ompVersion` field -- never hardcode a version number in this comment, it
// goes stale the moment a newer `omp` is installed (gate finding 10 (round 1), 2026-10-07: this
// header used to claim "18.6.1" long after 18.8.0 was the version actually in use elsewhere in
// this repo's own docs). `get_subagents`'s response/command shapes are documented in
// `specs/004-session-readout/contracts/omp-usage.md` section (d) -- gate fixes 2 finding 9
// removed the corresponding `GetSubagentsResponseData`/`GetSubagentsCommand` declarations from
// `src/shared/frames.ts` as unused (YAGNI); this probe's own job is re-confirming that live
// contract from scratch against the raw wire frames, not type-checking against them.
//
// This uses Stuart's REAL default OMP profile (no --profile flag), same safety posture as
// docs/spike/subagent-stream-probe.mjs: `--session-dir`/cwd are scratch-only, and
// `--approval-mode=always-ask` approves ONLY the task tool's own "Allow tool: task" gate. The
// scenario prompt only asks the subagent to read a fixed scratch file -- no writes, no network,
// no shell commands outside the scratch cwd. The run still makes one real model call against the
// real signed-in account, and leaves this run's own raw, UNREDACTED frame logs under
// `%TEMP%/pinion-get-subagents-probe/<timestamp>/` (gate finding 10) -- never attach that
// directory verbatim to anything leaving this machine. Gate fixes 2 finding 10: unlike the
// isolated-profile probes (`slash-commands-probe.mjs`, `omp-signin-probe.mjs`,
// `predict-word-probe.mjs`), this one forwards the full `process.env` to the child, including
// every credential-shaped var, rather than `sanitizedEnv()` under a brand-new `--profile`; this
// is a deliberate, disclosed trade-off, not an oversight -- a `task()` subagent needs a REAL,
// signed-in model to actually run, which an isolated profile's unreachable fake model cannot
// provide (same trade-off `chat-lines-probe.mjs`/`subagent-stream-probe.mjs`/
// `todo-progress-probe.mjs`/`context-usage-probe.mjs` already accept for the same reason).
//
// Asserts every response it depends on and exits non-zero on the first failure (gate finding 10:
// an earlier draft silently ignored `switch_session`'s own `success` field, skipped the whole
// reattach half of the probe without error if `sessionFile` ever came back `null`, declared the
// subagent "probably" still running at kill time from timing alone rather than confirming it via
// `get_subagents` itself, and always exited 0 regardless of any of that).
//
// Run:  node docs/spike/get-subagents-probe.mjs
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
const EXIT_MS = 15_000;

const T0 = Date.now();
const ROOT = path.join(os.tmpdir(), 'pinion-get-subagents-probe', new Date().toISOString().replace(/[:.]/g, '-'));
const dir = (name) => path.join(ROOT, name);
for (const d of ['repo', 'session-dir', 'frames']) {
  fs.mkdirSync(dir(d), { recursive: true });
}

try {
  execFileSync('git', ['init', '-q', '-b', 'main', dir('repo')]);
  fs.writeFileSync(path.join(dir('repo'), 'NOTES.md'), 'Alpha fact: the sky is teal today.\n');
  execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'add', '-A'], { cwd: dir('repo') });
  execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'commit', '-m', 'init'], { cwd: dir('repo') });
} catch (e) {
  console.error(`scratch repo init failed: ${e.message}`);
  process.exit(2);
}

// ---- OmpProc: same pattern as docs/spike/subagent-stream-probe.mjs.
class OmpProc {
  constructor(label, { sessionDir, cwd, extraArgs = [], onDialog } = {}) {
    this.label = label;
    this.frames = [];
    this.waiters = [];
    this.buf = Buffer.alloc(0);
    this.exitCode = null;
    this.onDialog = onDialog || (() => false);
    this.log = fs.createWriteStream(path.join(dir('frames'), `${label}.jsonl`));
    this.errLog = fs.createWriteStream(path.join(dir('frames'), `${label}.stderr.log`));
    const args = ['--mode', 'rpc-ui', '--approval-mode=always-ask', ...extraArgs];
    if (sessionDir) args.push('--session-dir', sessionDir);
    if (MODEL !== 'none') args.push('--model', MODEL);
    this.child = spawn(OMP, args, { cwd, env: process.env, stdio: 'pipe', windowsHide: true });
    this.exitPromise = new Promise((resolve) => this.child.on('exit', (code) => ((this.exitCode = code), resolve())));
    this.child.on('error', (e) => console.error(`${label}: omp not found: ${e.message}`));
    this.child.stdout.on('data', (d) => this.#onData(d));
    this.child.stderr.on('data', (d) => this.errLog.write(d));
  }

  #record(dir_, frame) {
    this.log.write(JSON.stringify({ t: Date.now() - T0, dir: dir_, frame }) + '\n');
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
        continue;
      }
      this.#dispatch(frame);
    }
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
      this.write({ type: 'extension_ui_response', id: frame.id, value: 'Deny' });
    } else if (frame.method === 'select' || frame.method === 'input' || frame.method === 'editor') {
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
    if (!r.ok) throw new Error(`${this.label}: process exited before ready frame (code ${this.exitCode}); see frames/${this.label}.stderr.log`);
    if (r.frame.supportedProtocolVersions?.includes(2)) {
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

  hardKill() {
    try {
      if (this.child.exitCode === null) execFileSync('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (e) {
      /* already gone */
    }
  }

  async closeGracefully() {
    this.child.stdin.end();
    const done = await Promise.race([this.exitPromise.then(() => true), new Promise((r) => setTimeout(() => r(false), EXIT_MS))]);
    if (!done) this.hardKill();
  }
}

function approveTaskOnly(frame, proc) {
  const title = frame.data?.title ?? frame.title ?? '';
  if (frame.method === 'select' && /^Allow tool: task\b/.test(title)) {
    proc.write({ type: 'extension_ui_response', id: frame.id, value: 'Approve' });
    return true;
  }
  return false;
}

// Gate finding 10: every request this probe depends on must be asserted, never left to silently
// carry a `success: false` (or missing-data) response forward into `result.json` as if it were
// usable evidence.
function assertSuccess(label, res) {
  if (!res || res.success !== true) {
    throw new Error(`${label} failed: ${JSON.stringify(res)}`);
  }
  return res;
}

let ompVersion = 'unknown';
try {
  ompVersion = execFileSync(OMP, ['--version'], { encoding: 'utf8' }).trim();
} catch (e) {
  console.error(`omp not found; set PINION_OMP (${e.message})`);
  process.exit(2);
}
console.log(`omp ${ompVersion} | model ${MODEL}\nscratch ${ROOT}\n`);

const results = { ompVersion, model: MODEL, scratch: ROOT, error: null };
let scriptFailed = false;
let a, b;

try {
  // ---- Process A: a plain session, no Conversation yet.
  a = new OmpProc('A', { sessionDir: dir('session-dir'), cwd: dir('repo'), onDialog: approveTaskOnly });
  await a.ready();

  results.emptySnapshot = assertSuccess('emptySnapshot', await a.request({ type: 'get_subagents' }));

  // Sent once here, before the task ever starts, and left on for the rest of process A's life:
  // this CONFOUNDS whether `get_subagents` itself needs a subscription to populate its registry
  // with whether it populates regardless -- `midFlightSnapshot` below is only ever observed
  // WITH a subscription already active, never without one while a subagent is genuinely running.
  // Gate finding 9: do not cite this probe as proof that subscription makes "no observable
  // difference" to `get_subagents` -- that specific causal claim was never isolated here.
  results.subscriptionResponse = assertSuccess('subscriptionResponse', await a.request({ type: 'set_subagent_subscription', level: 'progress' }));

  const taskPrompt =
    'Use the task tool to start one subagent (pass a tasks array with one entry, named Alpha). ' +
    'Alpha must read NOTES.md in the current directory and reply with only the "Alpha fact" line ' +
    'it finds.';
  const promptId = 'A-prompt';
  a.write({ id: promptId, type: 'prompt', message: taskPrompt });
  await a.waitFor((f) => f.type === 'response' && f.id === promptId, { what: 'prompt ack' });

  // Catch the subagent genuinely mid-flight: wait for an actual `subagent_progress` frame (the
  // owning `task` tool call's own start/end brackets fire almost immediately, well before the
  // registry itself is populated). Generous timeout: model latency varied 20-90s across runs.
  await a.waitFor((f) => f.type === 'subagent_progress', { timeout: 150_000, what: 'subagent_progress' });
  results.midFlightSnapshot = assertSuccess('midFlightSnapshot', await a.request({ type: 'get_subagents' }));
  // Gate finding 10: a `subagent_progress` frame alone only means a subagent WAS running at some
  // point before this; `get_subagents` reporting at least one entry right here is what actually
  // confirms it is still running right before the kill below, not merely "probably".
  const midFlightSubagents = results.midFlightSnapshot.data?.subagents ?? [];
  if (midFlightSubagents.length === 0) {
    throw new Error(`expected get_subagents to report a running subagent mid-flight, got ${JSON.stringify(results.midFlightSnapshot)}`);
  }

  const stateA = assertSuccess('get_state (A)', await a.request({ type: 'get_state' }));
  results.sessionFile = stateA.data?.sessionFile ?? null;
  if (!results.sessionFile) {
    throw new Error('process A reported no sessionFile from get_state; cannot verify the reattach half of this probe');
  }

  // Simulate the crash: hard-kill process A while the subagent is CONFIRMED still running (see
  // the midFlightSubagents assertion above), without ever waiting for prompt_result/session_settled.
  a.hardKill();
  await a.exitPromise;

  // ---- Process B: a brand-new process, same cwd/session-dir, attaching the SAME Conversation
  // file the same way SessionAgent.attachAndVerify does (`switch_session`, never `--resume`).
  b = new OmpProc('B', { sessionDir: dir('session-dir'), cwd: dir('repo'), onDialog: approveTaskOnly });
  await b.ready();
  results.switchSessionResponse = assertSuccess('switchSessionResponse', await b.request({ type: 'switch_session', sessionPath: results.sessionFile }));
  if (results.switchSessionResponse.data?.cancelled !== false) {
    throw new Error(`switch_session was cancelled: ${JSON.stringify(results.switchSessionResponse)}`);
  }
  results.reattachedSnapshot = assertSuccess('reattachedSnapshot', await b.request({ type: 'get_subagents' }));
  // Gate fixes 2 finding 10: this is the probe's main finding -- a freshly attached process's own
  // `get_subagents` registry never carries over the previous process's genuinely-running
  // subagent, even onto the SAME Conversation file -- and it was only ever eyeballed from the
  // console dump below, never actually asserted.
  const reattachedSubagents = results.reattachedSnapshot.data?.subagents ?? [];
  if (reattachedSubagents.length !== 0) {
    throw new Error(
      `expected a freshly attached process's get_subagents to report no subagents (a previous process's registry never carries over), got ${JSON.stringify(results.reattachedSnapshot)}`,
    );
  }
  const stateB = assertSuccess('get_state (B)', await b.request({ type: 'get_state' }));
  results.reattachedState = { messageCount: stateB.data?.messageCount, isSettled: stateB.data?.isSettled, sessionFile: stateB.data?.sessionFile };

  await b.closeGracefully();
} catch (e) {
  results.error = e.message;
  scriptFailed = true;
  console.error('probe FAILED', e.message);
} finally {
  a?.hardKill();
  b?.hardKill();
}

fs.writeFileSync(path.join(ROOT, 'result.json'), JSON.stringify(results, null, 2));
console.log('\n--- subscriptionResponse ---');
console.log(JSON.stringify(results.subscriptionResponse, null, 2));
console.log('\n--- emptySnapshot (no Conversation, no turn) ---');
console.log(JSON.stringify(results.emptySnapshot, null, 2));
console.log('\n--- midFlightSnapshot (same process, subagent genuinely running) ---');
console.log(JSON.stringify(results.midFlightSnapshot, null, 2));
console.log('\n--- reattachedSnapshot (fresh process, switch_session onto the SAME Conversation, nothing live) ---');
console.log(JSON.stringify(results.reattachedSnapshot, null, 2));
console.log('\n--- reattachedState ---');
console.log(JSON.stringify(results.reattachedState, null, 2));
console.log(`\nscratch dir (raw frames, unredacted): ${ROOT}`);
process.exit(scriptFailed ? 1 : 0);
