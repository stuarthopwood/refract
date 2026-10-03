// Word-prediction RPC probe (T102).
//
// Question: do OMP's documented `predict_word` / `predict_word_feedback` RPC
// commands (docs/rpc.md "Word prediction", added omp 18.4.9) behave as
// documented against the CURRENT installed omp version?
//
// ISOLATION IS MANDATORY (same pattern as docs/spike/slash-commands-probe.mjs):
//   - the omp process uses --profile pinion-probe-predict-word (a brand-new
//     profile name, never used before), --session-dir under a scratch temp
//     dir, and a scratch cwd;
//   - the child environment has every credential-shaped var removed
//     (sanitizedEnv());
//   - before sending any predict_word/predict_word_feedback command, a
//     pre-flight check (assertIsolatedProfile) asserts the live process's
//     `get_state.model` resolves to the `probe-fake`/`probe-fake-model`
//     provider, AND that `get_available_models` reports that model's
//     `contextWindow` as exactly 8000 -- both values only exist if
//     ensureFakeModel()'s seeded models.yml, written solely under the
//     isolated profile's own agent directory, was actually read; if either
//     check fails, the script prints "ABORT: not running against the
//     isolated profile" and exits non-zero before sending anything;
//   - separately, as an after-the-fact net, this script snapshots the name +
//     mtime (NOT contents) of every top-level entry directly under
//     ~/.omp/agent exactly twice: once before the run starts and once after
//     the whole run completes; a changed mtime on four known host-session
//     churn files (agent.db, agent.db-wal, models.db, models.db-wal) is
//     expected and ignored, any OTHER difference prints "ISOLATION BREACH"
//     and exits 3;
//   - this script never deletes anything -- the integrator removes the
//     ~/.omp/profiles/pinion-probe-predict-word directory by hand afterward.
//
// `predict_word`'s own prediction engine is documented as running through a
// "shared prediction daemon" independent of the session's configured chat
// model (docs/rpc.md: "answers from the engine selected by
// `spelling.autocomplete`"), gated only by that boolean setting -- NOT by
// which model/provider is configured for the session. This probe exercises
// predict_word with the isolated profile's fake/unreachable chat model
// (same as every other probe in this repo) specifically to test that claim:
// if predict_word still returns non-null suggestions despite the chat model
// being unreachable, that is direct evidence the engine does not depend on
// the session's chat model.
//
// Run:  node C:/tmp/predict-word-probe.mjs
// Env:  PINION_OMP  omp executable (default "omp" from PATH)

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const OMP = process.env.PINION_OMP || "omp";
const PROFILE = "pinion-probe-predict-word";
const CONFIG_DIR_NAME = process.env.PI_CONFIG_DIR || ".omp";
const READY_MS = 120_000;
const REQUEST_MS = 150_000; // predict_word cold start can take ~2 minutes per docs
const EXIT_MS = 30_000;

const T0 = Date.now();
const ROOT = path.join(os.tmpdir(), "pinion-probe-predict-word", new Date().toISOString().replace(/[:.]/g, "-"));
const dir = (name) => path.join(ROOT, name);
for (const d of ["wt", "frames", "sessions"]) {
  fs.mkdirSync(dir(d), { recursive: true });
}
fs.writeFileSync(path.join(dir("wt"), "README.md"), "predict-word probe scratch worktree\n");

function sanitizedEnv() {
  const credentialPattern = /API_KEY|OAUTH|TOKEN|SECRET|CREDENTIAL|PASSWORD|_PAT\b|AUTH|_KEY\b/i;
  const out = { ...process.env };
  for (const key of Object.keys(out)) {
    if (credentialPattern.test(key)) delete out[key];
  }
  return out;
}

function snapshotAgentDir() {
  const agentDir = path.join(os.homedir(), CONFIG_DIR_NAME, "agent");
  let entries;
  try {
    entries = fs.readdirSync(agentDir);
  } catch {
    return {};
  }
  const snap = {};
  for (const name of entries) {
    try {
      const st = fs.statSync(path.join(agentDir, name));
      snap[name] = st.mtimeMs;
    } catch {
      snap[name] = null;
    }
  }
  return snap;
}

const KNOWN_LIVE_CHURN_FILES = new Set(["agent.db", "agent.db-wal", "models.db", "models.db-wal"]);

function snapshotsEqual(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (KNOWN_LIVE_CHURN_FILES.has(k)) continue;
    if (a[k] !== b[k]) return false;
  }
  return true;
}

// ---- OmpProc: RPC-UI subprocess wrapper (pattern from slash-commands-probe.mjs) ----
class OmpProc {
  constructor(label, sessionDir, extraArgs = []) {
    this.label = label;
    this.waiters = [];
    this.frames = [];
    this.warnings = [];
    this.chunks = new Map();
    this.buf = Buffer.alloc(0);
    this.n = 0;
    this.exitCode = null;
    this.exited = false;
    this.log = fs.createWriteStream(path.join(dir("frames"), `${label}.stderr.log`));
    const args = [
      "--mode", "rpc-ui",
      "--approval-mode=always-ask",
      "--profile", PROFILE,
      "--session-dir", sessionDir,
      ...extraArgs,
    ];
    this.child = spawn(OMP, args, { cwd: dir("wt"), stdio: "pipe", windowsHide: true, env: sanitizedEnv() });
    this.exitPromise = new Promise((resolve) => {
      this.child.on("exit", (code) => { this.exitCode = code; this.exited = true; resolve(); });
    });
    this.child.on("error", (err) => { console.error(`[omp:${label}] spawn error: ${err.message}`); process.exit(2); });
    this.child.stdout.on("data", (d) => this.#onData(d));
    this.child.stderr.on("data", (d) => this.log.write(d));
  }

  #record(dirn, frame, extra = {}) {
    this.log.write(JSON.stringify({ t: Date.now() - T0, dir: dirn, frame, ...extra }) + "\n");
  }

  #onData(buf) {
    this.buf = Buffer.concat([this.buf, buf]);
    let i;
    while ((i = this.buf.indexOf(0x0a)) >= 0) {
      const line = this.buf.subarray(0, i).toString("utf8").trim();
      this.buf = this.buf.subarray(i + 1);
      if (!line) continue;
      let frame;
      try { frame = JSON.parse(line); }
      catch (e) { this.warnings.push(`parseError: ${line}`); continue; }
      this.#handle(frame);
    }
  }

  #handle(frame) {
    this.#record("in", frame);
    if (frame.type === "rpc_chunk") {
      let c = this.chunks.get(frame.chunkId);
      if (!c) { c = { parts: new Array(frame.count), got: 0, byteLength: frame.byteLength, chunkId: frame.chunkId }; this.chunks.set(frame.chunkId, c); }
      c.parts[frame.index] = Buffer.from(frame.data, "base64");
      if (++c.got === frame.count) {
        const whole = Buffer.concat(c.parts);
        this.chunks.delete(frame.chunkId);
        if (whole.length !== c.byteLength) { this.#dispatch({ type: "__probe_protocol_error", error: `chunk ${frame.chunkId} got ${whole.length} bytes, expected ${c.byteLength}` }); return; }
        try { this.#dispatch(JSON.parse(whole.toString("utf8"))); }
        catch (e) { this.#dispatch({ type: "__probe_protocol_error", error: `chunk ${frame.chunkId}: ${e.message}` }); }
      }
      return;
    }
    this.#dispatch(frame);
  }

  #dispatch(frame) {
    this.frames.push(frame);
    for (let idx = this.waiters.length - 1; idx >= 0; idx--) {
      const w = this.waiters[idx];
      if (w.pred(frame)) { this.waiters.splice(idx, 1); w.resolve(frame); }
    }
    if (frame.type === "extension_ui_request") this.#answerDialog(frame);
  }

  #answerDialog(f) {
    const title = String(f.title ?? "");
    const method = String(f.method ?? "");
    this.write({ type: "extension_ui_response", id: f.id, cancelled: true });
    this.#record("auto-deny-dialog", { method, title });
  }

  write(obj) {
    this.#record("out", obj);
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  waitFor(pred, { from = 0, timeout = REQUEST_MS, what = "frame" } = {}) {
    for (let i = from; i < this.frames.length; i++) if (pred(this.frames[i])) return Promise.resolve(this.frames[i]);
    return new Promise((resolve, reject) => {
      const w = { pred, from, resolve };
      const t = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); reject(new Error(`[${this.label}] timeout after ${timeout}ms waiting for ${what}`)); }, timeout);
      w.resolve = (f) => { clearTimeout(t); resolve(f); };
      this.waiters.push(w);
    });
  }

  async request(cmd, timeout = REQUEST_MS) {
    const id = `${this.label}-${++this.n}`;
    const mark = this.frames.length;
    this.write({ id, ...cmd });
    return this.waitFor((f) => f.type === "response" && f.id === id, { from: mark, timeout, what: `${cmd.type} response` });
  }

  // Sends a request and returns immediately with {id}; caller awaits the
  // matching response separately. Used for the overlapping in-flight test.
  send(cmd) {
    const id = `${this.label}-${++this.n}`;
    const mark = this.frames.length;
    this.write({ id, ...cmd });
    return { id, mark };
  }

  async close() {
    const done = await Promise.race([this.exitPromise.then(() => true), new Promise((r) => setTimeout(() => r(false), EXIT_MS))]);
    if (!done) await this.hardKill();
    this.exitCode = this.exitCode === null ? "killed" : this.exitCode;
    this.log.end();
    return { label: this.label, exitCode: this.exitCode, warnings: this.warnings };
  }

  async ready() {
    const w = this.waitFor((f) => f.type === "ready", { timeout: READY_MS, what: "ready frame" });
    const r = await Promise.race([w.then((f) => ({ ok: true, frame: f })), this.exitPromise.then(() => ({ ok: false, frame: null }))]);
    if (!r.ok) throw new Error(`[${this.label}] process exited before ready (code ${this.exitCode}); see frames/${this.label}.stderr.log`);
    this.readyAt = Date.now() - T0;
    if (r.frame.supportedProtocolVersions?.includes(2)) {
      const neg = await this.request({ type: "negotiate_protocol", protocolVersion: 2 });
      if (!neg.success) throw new Error(`negotiate_protocol failed: ${neg.error}`);
    }
    return { label: this.label, readyAt: this.readyAt };
  }

  async hardKill() {
    try { execFileSync("taskkill", ["/pid", String(this.child.pid), "/T", "/F"]); }
    catch { try { this.child.kill("SIGKILL"); } catch { /* already gone */ } }
    await Promise.race([this.exitPromise, new Promise((r) => setTimeout(r, EXIT_MS))]);
  }
}

// Same provenance reasoning as slash-commands-probe.mjs's ensureFakeModel:
// this is the ONLY place that defines provider "probe-fake" / model
// "probe-fake-model", solely under the isolated profile's agent dir.
function ensureFakeModel() {
  const agentDir = path.join(os.homedir(), CONFIG_DIR_NAME, "profiles", PROFILE, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const yml = [
    "providers:",
    "  probe-fake:",
    "    baseUrl: http://127.0.0.1:1",
    "    auth: none",
    "    api: openai-completions",
    "    models:",
    "      - id: probe-fake-model",
    "        name: Probe Fake Model",
    "        api: openai-completions",
    "        contextWindow: 8000",
    "        maxTokens: 1000",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(agentDir, "models.yml"), yml);
}

async function assertIsolatedProfile(proc) {
  const state = await proc.request({ type: "get_state" }).catch((e) => ({ success: false, error: e.message }));
  const model = state?.data?.model;
  if (model?.provider !== "probe-fake" || model?.id !== "probe-fake-model") {
    console.error(`ABORT: not running against the isolated profile (get_state.model=${JSON.stringify(model)}, expected provider "probe-fake" / id "probe-fake-model" seeded under ~/${CONFIG_DIR_NAME}/profiles/${PROFILE}/agent/models.yml)`);
    await proc.close();
    process.exit(1);
  }
  const modelsResp = await proc.request({ type: "get_available_models" }).catch((e) => ({ success: false, error: e.message }));
  const available = modelsResp?.data?.models ?? modelsResp?.data ?? [];
  const fakeEntry = Array.isArray(available)
    ? available.find((m) => m?.provider === "probe-fake" || m?.id === "probe-fake-model")
    : undefined;
  if (fakeEntry?.contextWindow !== 8000) {
    console.error(`ABORT: not running against the isolated profile (get_available_models has no probe-fake-model entry with contextWindow=8000: ${JSON.stringify(fakeEntry)}) -- the seeded models.yml under the isolated profile was not actually read`);
    await proc.close();
    process.exit(1);
  }
}

// ---- main ----
let ompVersion = "unknown";
try { ompVersion = execFileSync(OMP, ["--version"], { encoding: "utf8" }).trim(); }
catch (e) { console.error(`omp not found; set PINION_OMP (${e.message})`); process.exit(2); }
console.log(`omp ${ompVersion} | profile ${PROFILE}\nscratch ${ROOT}\n`);

ensureFakeModel();
const beforeSnap = snapshotAgentDir();

const results = {};
let scriptFailed = false;
let proc;

try {
  const sd = dir(path.join("sessions", "s1"));
  fs.mkdirSync(sd, { recursive: true });
  proc = new OmpProc("p1", sd, ["--model", "probe-fake/probe-fake-model"]);
  await proc.ready();
  await assertIsolatedProfile(proc);
  console.log("isolation preflight OK");

  // --- 1. Gating cases: expect suffix: null (or an error/no-suggestion) ---
  const gating = {};

  // cursor mid-word ("hel|lo" with cursor inside the word, not at its end)
  {
    const text = "I think we should hello there";
    const cursor = text.indexOf("hello") + 3; // inside "hel|lo"
    const r = await proc.request({ type: "predict_word", text, cursor });
    gating.midWord = { text, cursor, response: r };
  }

  // cursor NOT at end of its line (cursor sits mid-line, with more text
  // after it on the same line -- distinct from the earlier "end of an
  // earlier line" case, which the docs' gate actually treats as a valid
  // end-of-line position)
  {
    const text = "hello wor";
    const cursor = 2; // mid "hello", with "llo wor" still following on the same line
    const r = await proc.request({ type: "predict_word", text, cursor });
    gating.notEndOfLine = { text, cursor, response: r };
  }

  // text that looks like a file path
  {
    const text = "see src/components/Foo";
    const cursor = text.length;
    const r = await proc.request({ type: "predict_word", text, cursor });
    gating.filePath = { text, cursor, response: r };
  }

  // text that looks like a slash command
  {
    const text = "/mo";
    const cursor = text.length;
    const r = await proc.request({ type: "predict_word", text, cursor });
    gating.slashCommand = { text, cursor, response: r };
  }

  results.gating = gating;
  console.log("gating cases:", JSON.stringify(gating, null, 2));

  // --- 2. Normal case: plausible partial prose word at end of a line ---
  {
    const text = "The quick brown fox jumped over the laz";
    const cursor = text.length;
    const started = Date.now();
    const r = await proc.request({ type: "predict_word", text, cursor });
    results.normalCase = { text, cursor, response: r, latencyMs: Date.now() - started };
    console.log("normal case:", JSON.stringify(results.normalCase, null, 2));
  }

  // --- 3. Model-dependency check: does predict_word still answer despite
  // the session's configured chat model (probe-fake) being unreachable? ---
  // (this doubles as additional cold-start evidence if request #2 above was
  // the actual cold start; recorded separately below as the official
  // "cold start" measurement using a brand-new process.)

  // --- 4. Cold-start latency: brand-new process, first predict_word call ---
  await proc.close();
  const sd2 = dir(path.join("sessions", "s2"));
  fs.mkdirSync(sd2, { recursive: true });
  const proc2 = new OmpProc("p2", sd2, ["--model", "probe-fake/probe-fake-model"]);
  await proc2.ready();
  await assertIsolatedProfile(proc2);
  const coldText = "I am writing a sent";
  const coldCursor = coldText.length;
  const coldStart = Date.now();
  const coldResp = await proc2.request({ type: "predict_word", text: coldText, cursor: coldCursor }, 150_000);
  const coldLatencyMs = Date.now() - coldStart;
  results.coldStart = { text: coldText, cursor: coldCursor, response: coldResp, latencyMs: coldLatencyMs };
  console.log(`cold-start predict_word latency: ${coldLatencyMs}ms`, JSON.stringify(coldResp));

  results.modelDependency = {
    note: "proc2 ran with the isolated profile's unreachable probe-fake/probe-fake-model chat model (confirmed via assertIsolatedProfile) for its ENTIRE lifetime; the cold-start predict_word call above used this same unreachable-chat-model process.",
    coldStartSucceededDespiteUnreachableChatModel: coldResp.success === true,
  };

  // --- 3 (continued). One-in-flight-replaces-older: fire a burst of
  // predict_word requests back to back (different ids, no await between
  // sends) before any could plausibly have resolved, so the server's
  // "one engine request in flight per session" slot is genuinely contended.
  // (The first two-request version of this test, run earlier, completed
  // both at ~1-9ms each with no supersession -- this machine's engine is
  // fast enough that a two-request gap alone does not reproduce the race;
  // widen to a tight burst to increase collision odds.)
  {
    const BURST = 10;
    const text = "The quick brown fox jumped over the laz";
    const cursor = text.length; // same valid, answerable request every time ("laz" -> "y")
    const sent = [];
    for (let i = 0; i < BURST; i++) {
      sent.push({ ...proc2.send({ type: "predict_word", text, cursor }), text, cursor });
    }
    const responses = await Promise.all(
      sent.map((s) => proc2.waitFor((f) => f.type === "response" && f.id === s.id, { from: s.mark, timeout: 150_000, what: `predict_word burst ${s.id} response` }))
    );
    const supersededCount = responses.filter((r) => r?.data?.suffix === null).length;
    const lastResp = responses[responses.length - 1];
    results.inFlightReplace = {
      burstSize: BURST,
      text,
      cursor,
      responses,
      supersededCount,
      lastOneAnswered: lastResp?.success === true && lastResp?.data?.suffix === "y",
    };
    console.log("in-flight replace (burst, identical requests):", JSON.stringify(results.inFlightReplace, null, 2));
  }

  // --- 5. predict_word_feedback for both accepted:true and accepted:false ---
  {
    const fbAccept = await proc2.request({
      type: "predict_word_feedback",
      text: "I am writing a sent",
      cursor: "I am writing a sent".length,
      suggestion: "ence",
      accepted: true,
    });
    const fbReject = await proc2.request({
      type: "predict_word_feedback",
      text: "I am writing a sent",
      cursor: "I am writing a sent".length,
      suggestion: "ence",
      accepted: false,
    });
    results.feedback = { accepted: fbAccept, rejected: fbReject };
    console.log("feedback:", JSON.stringify(results.feedback, null, 2));
  }

  await proc2.close();
} catch (e) {
  scriptFailed = true;
  console.error("probe failed:", e.message, e.stack);
  if (proc) await proc.close().catch(() => { });
}

const afterSnap = snapshotAgentDir();
const breached = !snapshotsEqual(beforeSnap, afterSnap);
const isolationResult = breached ? "BREACH" : "unchanged";

fs.writeFileSync(path.join(ROOT, "result.json"), JSON.stringify({ ompVersion, profile: PROFILE, isolation: isolationResult, results }, null, 2));
console.log(`\nscratch dir (raw frames, unredacted): ${ROOT}`);

if (breached) {
  console.error("ISOLATION BREACH: ~/.omp/agent top-level entries changed during the probe run");
  fs.writeFileSync(path.join(ROOT, "isolation-breach.json"), JSON.stringify({ before: beforeSnap, after: afterSnap }, null, 2));
  process.exit(3);
}

console.log("\nisolation check: unchanged");
process.exit(scriptFailed ? 1 : 0);
