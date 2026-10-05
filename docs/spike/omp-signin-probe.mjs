// OMP sign-in/out probe (T002, research.md decision 6, contracts/omp-usage.md "Sign-in/out:
// UNVERIFIED pending the Phase 1 probe").
//
// Question: does a scratch `omp --mode rpc-ui` process's `available_commands_update` offer
// `/login` and `/logout`, and if so, what does sending each as a bare `/login`/`/logout` prompt
// (no arguments) produce -- an `extension_ui_request` dialog, plain `command_output` text, or
// both -- and can any dialog it raises actually be driven to completion over rpc-ui, or does the
// flow stall waiting on something only a real terminal provides?
//
// ISOLATION IS MANDATORY (identical rule to docs/spike/slash-commands-probe.mjs):
//   - the omp process uses --profile pinion-probe-signin (a brand-new profile name, never used
//     before), --session-dir under a scratch temp dir, and a scratch cwd -- never ~/.omp itself;
//   - the child environment has every credential-shaped var removed (sanitizedEnv(), copied from
//     docs/spike/slash-commands-probe.mjs / signed-in-probe.mjs);
//   - before sending anything, a pre-flight check (assertIsolatedProfile) asserts the live
//     process's get_state.model resolves to the probe-fake/probe-fake-model provider seeded
//     solely under the isolated profile's own agent directory, AND that get_available_models
//     reports that model's contextWindow as exactly 8000; either check failing prints "ABORT: not
//     running against the isolated profile" and exits non-zero before sending anything;
//   - every extension_ui_request this process ever receives is answered with `cancelled: true`
//     the instant it arrives (OmpProc#dispatch, below, unconditionally) -- this is what makes it
//     safe to actually send /login: even if it raises a real device-code or provider-picker
//     dialog, the probe cancels it before any choice is made or any code is read out, so no
//     external account or credential is ever touched, and the isolated profile has zero real
//     provider credentials configured in the first place (only the unreachable fake model below);
//   - as an after-the-fact net (not a pre-flight check), this script snapshots the name + mtime
//     (NOT contents) of every top-level entry directly under ~/.omp/agent exactly twice: once
//     before the run starts and once after it completes; a changed mtime on the four known
//     host-session churn files (agent.db, agent.db-wal, models.db, models.db-wal) is expected and
//     ignored, any OTHER difference prints "ISOLATION BREACH" and exits 3;
//   - this script itself never deletes anything -- the agent running it for T002 removes both the
//     scratch temp dir (printed below) and ~/.omp/profiles/pinion-probe-signin by hand
//     immediately after capturing the result, per the task's own cleanup requirement.
//
// Run:  node docs/spike/omp-signin-probe.mjs
// Env:  PINION_OMP  omp executable (default "omp" from PATH)

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const OMP = process.env.PINION_OMP || "omp";
const PROFILE = "pinion-probe-signin";
// Single source of truth for OMP's config-dir root so the isolation snapshot
// (snapshotAgentDir) and the seeded-profile writer (ensureFakeModel) can never silently diverge
// onto two different directories.
const CONFIG_DIR_NAME = process.env.PI_CONFIG_DIR || ".omp";
const READY_MS = 120_000;
const REQUEST_MS = 60_000;
const OBSERVE_MS = 20_000;
const SETTLE_MS = 20_000;
const EXIT_MS = 30_000;

const T0 = Date.now();
const ROOT = path.join(os.tmpdir(), "pinion-probe-signin", new Date().toISOString().replace(/[:.]/g, "-"));
const dir = (name) => path.join(ROOT, name);
for (const d of ["wt", "frames", "sessions"]) {
  fs.mkdirSync(dir(d), { recursive: true });
}
fs.writeFileSync(path.join(dir("wt"), "README.md"), "omp-signin probe scratch worktree\n");

// Strip anything credential-shaped so the isolated profile cannot fall back
// to an ambient env-var API key. PATH/HOME/USERPROFILE/SystemRoot/etc. are
// left alone -- they are needed to spawn the process at all on Windows.
function sanitizedEnv() {
  const credentialPattern = /API_KEY|OAUTH|TOKEN|SECRET|CREDENTIAL|PASSWORD|_PAT\b|AUTH|_KEY\b/i;
  const out = { ...process.env };
  for (const key of Object.keys(out)) {
    if (credentialPattern.test(key)) delete out[key];
  }
  return out;
}

// ---- isolation snapshot of ~/.omp/agent (name + mtime only, never content) ----
// This only ever looks at the TOP-LEVEL entries of ~/.omp/agent by name and
// mtime; it does not see changes inside subdirectories (e.g. a file rewritten
// in place under an existing folder), the clipboard, open ports, or spawned
// processes. A clean (non-BREACH) report is evidence of "no top-level churn
// beyond the known host-session files" -- not a full isolation proof.
function snapshotAgentDir() {
  const agentDir = path.join(os.homedir(), CONFIG_DIR_NAME, "agent");
  let entries;
  try {
    entries = fs.readdirSync(agentDir);
  } catch {
    return {}; // directory does not exist -- that is a valid, stable state
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

// These four files churn from ordinary host-session activity (e.g. this
// very OMP session's own agent.db/-wal and models.db/-wal mtimes change just
// from running concurrently), so mtime changes to exactly these names are
// NOT treated as a breach. A changed mtime on any OTHER top-level file or
// directory, or any top-level entry added or removed, still is.
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
    this.readyMs = null;
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
      catch { this.warnings.push(`parseError: ${line}`); continue; }
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
    const dialogCancelled = { type: "extension_ui_response", id: f.id, cancelled: true };
    this.write(dialogCancelled);
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

  async close() {
    const done = await Promise.race([this.exitPromise.then(() => true), new Promise((r) => setTimeout(() => r(false), EXIT_MS))]);
    if (!done) await this.hardKill();
    this.exitCode = this.exitCode === null ? "killed" : this.exitCode;
    this.log.end();
    return { label: this.label, exitCode: this.exitCode, readyMs: this.readyAt, warnings: this.warnings };
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

async function waitSettled(p, timeout = SETTLE_MS) {
  try {
    await p.waitFor((f) => f.type === "session_settled", { timeout, what: "session_settled" });
    return true;
  } catch {
    const st = await p.request({ type: "get_state" }).catch(() => null);
    return !!st?.data?.isSettled;
  }
}

// `available_commands_update` entries are top-level only (SlashCommandDescriptor's own
// `subcommands` is for e.g. `/model <id>`-style args, not relevant here): /login and /logout are
// plain single-word commands, so a plain top-level name/alias match is all that is needed.
function findCommand(commands, name) {
  return commands.find((c) => c.name === name || (c.aliases ?? []).includes(name)) ?? null;
}

// The isolated profile has no models configured (no credentials, no catalog
// cache), so omp refuses to start rpc-ui at all ("No models available").
// Seed a single unreachable, keyless, fake custom model so the process can
// reach `ready` and answer get_available_commands. This never touches real
// credentials: baseUrl points at a closed local port and auth is `none`.
// Any prompt actually routed to this model simply fails to connect, which is
// fine -- an unsigned-in profile is expected to be unable to run a real turn.
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

// ---- pre-flight isolation guard ----
// ensureFakeModel() is the ONLY place that defines a provider named
// "probe-fake" with model "probe-fake-model", and it writes that definition
// solely under the isolated profile's own agent directory
// (~/<CONFIG_DIR_NAME>/profiles/pinion-probe-signin/agent/models.yml). A real,
// previously-used profile (including the developer's default one) has no
// such provider, so if the live process's own `get_state.model` reports
// back exactly {provider: "probe-fake", id: "probe-fake-model"}, that is
// strong evidence the process read its config from the isolated profile --
// not merely that we *asked* it to with --profile. On its own this check has
// one gap: `get_state.model` carries only {provider, id}, and this script
// also passes `--model probe-fake/probe-fake-model` on the command line, so
// in principle an omp build that echoed an unresolved CLI selector back
// without ever reading a config file could produce the same {provider, id}
// pair. To close that gap, this also checks `get_available_models` for an
// entry whose `contextWindow` is exactly 8000 -- a value chosen to be
// implausible to collide with any real provider's model, and one that only
// exists if the actual seeded models.yml file was parsed (a bare CLI model
// selector carries no contextWindow at all). Both checks must pass.
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

// Sends `/<name>` as a bare prompt, waits for its ack, then keeps observing for up to OBSERVE_MS
// (ended early by that same invocation's own `prompt_result`, which cannot be followed by
// anything else for this `id`), and returns every extension_ui_request / command_output /
// prompt_result frame produced in that window, verbatim. Dialogs are already auto-cancelled by
// OmpProc#dispatch the instant they arrive -- this only records what was raised and cancelled.
async function sendAndObserve(proc, name) {
  const message = `/${name}`;
  const mark = proc.frames.length;
  const id = `${proc.label}-${++proc.n}`;
  proc.write({ id, type: "prompt", message });
  let ack;
  try {
    ack = await proc.waitFor((f) => f.type === "response" && f.id === id, { from: mark, timeout: REQUEST_MS, what: `${message} ack` });
  } catch (e) {
    ack = { success: false, error: e.message };
  }
  await Promise.race([
    proc.waitFor((f) => f.type === "prompt_result" && f.id === id, { from: mark, timeout: OBSERVE_MS, what: "prompt_result" }).catch(() => undefined),
    new Promise((r) => setTimeout(r, OBSERVE_MS)),
  ]);
  const since = proc.frames.slice(mark);
  return {
    ack: { success: ack.success, data: ack.data, error: ack.error },
    dialogs: since.filter((f) => f.type === "extension_ui_request").map((f) => ({ method: f.method, title: f.title, message: f.message, options: f.options, optionDetails: f.optionDetails })),
    outputs: since.filter((f) => f.type === "command_output").map((f) => ({ text: f.text, message: f.message })),
    promptResults: since.filter((f) => f.type === "prompt_result").map((f) => ({ id: f.id, agentInvoked: f.agentInvoked, status: f.status, sessionSettled: f.sessionSettled, error: f.error })),
  };
}

// ---- main ----
let ompVersion = "unknown";
try { ompVersion = execFileSync(OMP, ["--version"], { encoding: "utf8" }).trim(); }
catch (e) { console.error(`omp not found; set PINION_OMP (${e.message})`); process.exit(2); }
console.log(`omp ${ompVersion} | profile ${PROFILE}\nscratch ${ROOT}\n`);

ensureFakeModel();
const beforeSnap = snapshotAgentDir();

let n = 0;
const freshSessionDir = () => dir(path.join("sessions", `s${++n}`));
async function startProc() {
  const sd = freshSessionDir();
  fs.mkdirSync(sd, { recursive: true });
  const p = new OmpProc(`p${n}`, sd, ["--model", "probe-fake/probe-fake-model"]);
  await p.ready();
  return p;
}

let scriptFailed = false;
const results = { available: null, login: { present: false }, logout: { present: false } };

try {
  let proc = await startProc();
  await assertIsolatedProfile(proc);

  const cmdsFrame = await proc.waitFor((f) => f.type === "available_commands_update", { timeout: READY_MS, what: "available_commands_update" });
  const commands = cmdsFrame.commands ?? [];
  const loginCmd = findCommand(commands, "login");
  const logoutCmd = findCommand(commands, "logout");
  results.available = { total: commands.length, login: loginCmd, logout: logoutCmd };
  console.log(`available_commands_update: ${commands.length} top-level command(s); login=${!!loginCmd} logout=${!!logoutCmd}`);

  for (const [name, found] of [["login", loginCmd], ["logout", logoutCmd]]) {
    if (!found) {
      console.log(`/${name}: absent from available_commands_update; not sent`);
      continue;
    }
    console.log(`sending /${name} ...`);
    const obs = await sendAndObserve(proc, name);

    const state = await proc.request({ type: "get_state" }).catch(() => null);
    const settled = state?.data?.isSettled !== false;
    let settleNote = "settled";
    if (!settled) {
      await proc.request({ type: "abort" }).catch(() => { });
      const ok = await waitSettled(proc);
      settleNote = ok ? "was unsettled after prompt; abort + settled" : "was unsettled; abort sent, did NOT settle before timeout";
      await proc.close();
      proc = await startProc();
      await assertIsolatedProfile(proc);
    }

    results[name] = { present: true, description: found.description, ...obs, settleNote };
  }

  await proc.close();
} catch (e) {
  scriptFailed = true;
  console.error("probe failed:", e.message);
}

const afterSnap = snapshotAgentDir();
const breached = !snapshotsEqual(beforeSnap, afterSnap);
const isolationResult = breached ? "BREACH" : "unchanged";

fs.writeFileSync(path.join(ROOT, "result.json"), JSON.stringify({ ompVersion, profile: PROFILE, isolation: isolationResult, results }, null, 2));
console.log(`\nscratch dir (raw frames, unredacted): ${ROOT}`);
console.log(JSON.stringify(results, null, 2));

if (breached) {
  console.error("ISOLATION BREACH: ~/.omp/agent top-level entries changed during the probe run");
  fs.writeFileSync(path.join(ROOT, "isolation-breach.json"), JSON.stringify({ before: beforeSnap, after: afterSnap }, null, 2));
  process.exit(3);
}

console.log("\nisolation check: unchanged");
process.exit(scriptFailed ? 1 : 0);
