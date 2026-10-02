// Slash-command inventory probe (T092).
//
// Question: of every command `get_available_commands` reports, which can be
// exercised safely in a brand-new, never-signed-in, isolated OMP profile
// without touching Stuart's real credentials, settings, or sessions, and what
// happens when each is sent as a bare `/<name>` prompt?
//
// ISOLATION IS MANDATORY:
//   - every omp process uses --profile pinion-probe-slash (a brand-new
//     profile name, never used before), --session-dir under a scratch temp
//     dir, and a scratch cwd;
//   - the child environment has every credential-shaped var removed
//     (sanitizedEnv(), copied from docs/spike/signed-in-probe.mjs);
//   - before sending any command, a pre-flight check (assertIsolatedProfile)
//     asserts that the first live process's `get_state.model` resolves to
//     the `probe-fake`/`probe-fake-model` provider ensureFakeModel() seeded
//     only under the isolated profile's own agent directory; if it does not,
//     the script prints "ABORT: not running against the isolated profile"
//     and exits non-zero before sending anything;
//   - separately, as an after-the-fact net (not a pre-flight check), this
//     script snapshots the name + mtime (NOT contents) of every top-level
//     entry directly under ~/.omp/agent exactly twice: once before the run
//     starts and once after the whole run completes (never per-command); a
//     changed mtime on four known host-session churn files (agent.db,
//     agent.db-wal, models.db, models.db-wal) is expected and ignored, any
//     OTHER difference prints "ISOLATION BREACH" and exits 3;
//   - this script never deletes anything -- the integrator removes the
//     ~/.omp/profiles/pinion-probe-slash directory by hand afterward.
//
// A command matching DENYLIST is never sent; it is recorded as
// `needs-decision`. Every other discovered command (and subcommand) is sent
// as `/<name>` with no arguments and observed for up to 20s. Any
// extension_ui_request dialog is answered with `cancelled: true`. If a
// command leaves the session unsettled, this script sends `abort`, waits up
// to 20s for `session_settled`, and restarts the omp process before the next
// command so one stuck command cannot poison the rest of the run.
//
// Run:  node docs/spike/slash-commands-probe.mjs
// Env:  PINION_OMP  omp executable (default "omp" from PATH)

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const OMP = process.env.PINION_OMP || "omp";
const PROFILE = "pinion-probe-slash";
// Single source of truth for OMP's config-dir root so the isolation
// snapshot (snapshotAgentDir) and the seeded-profile writer (ensureFakeModel)
// can never silently diverge onto two different directories.
const CONFIG_DIR_NAME = process.env.PI_CONFIG_DIR || ".omp";
const READY_MS = 120_000;
const REQUEST_MS = 60_000;
const OBSERVE_MS = 20_000;
const SETTLE_MS = 20_000;
const EXIT_MS = 30_000;

const T0 = Date.now();
const ROOT = path.join(os.tmpdir(), "pinion-probe-slash-commands", new Date().toISOString().replace(/[:.]/g, "-"));
const dir = (name) => path.join(ROOT, name);
for (const d of ["wt", "frames", "sessions"]) {
  fs.mkdirSync(dir(d), { recursive: true });
}
fs.writeFileSync(path.join(dir("wt"), "README.md"), "slash-commands probe scratch worktree\n");

// NOT exhaustive: this is a known-dangerous-name blocklist, not a
// verified-safe allowlist. The "send if not denied" default below fails
// open for any command name not yet listed here. A prior run of this
// script actually executed several commands with real side effects on
// Stuart's desktop before these names were added: `/todo copy` (overwrote
// the real clipboard), `/todo edit`/`import` (opens $EDITOR / reads files),
// `/stats`/`/trace` (started local dashboards/servers), `/review`,
// `/security scan`/`import`/`disposition`, `/wt`, `/move`, `/ssh add`/
// `remove`, `/session pin`, `/browser visible`, `/computer on`. After any
// OMP version bump, treat every newly-discovered command name with the
// same suspicion before trusting the default -- grep its own
// description/help text for side-effect verbs before assuming it is safe
// to send with no arguments.
const DENYLIST =
  /login|logout|settings|config|model|advisor|plugin|skill|mcp|marketplace|update|exit|quit|share|export|delete|drop|reset|memory|theme|setup|handoff|compact|loop|vibe|collab|new|resume|fork|plan|btw|copy|edit|import|stats|trace|review|security|wt|move|ssh|pin|browser|computer|disposition/i;

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

// ---- OmpProc: RPC-UI subprocess wrapper (pattern from signed-in-probe.mjs) ----
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

  // Sends one prompt and returns whichever terminal shape arrives first: an
  // immediate failed response, a locally-handled complete (agentInvoked:
  // false), or the eventual prompt_result frame (completed or error).
  async promptOnce(message, timeout = OBSERVE_MS) {
    const id = `${this.label}-${++this.n}`;
    const mark = this.frames.length;
    this.write({ id, type: "prompt", message });
    const ack = await this.waitFor((f) => f.type === "response" && f.id === id, { from: mark, timeout: REQUEST_MS, what: "prompt ack" });
    if (!ack.success) return { stage: "response", success: false, error: ack.error, code: ack.code };
    if (ack.data?.agentInvoked === false) return { stage: "response", success: true, agentInvoked: false, data: ack.data };
    const outcome = await Promise.race([
      this.waitFor((f) => f.type === "response" && f.id === id && f.success === false, { from: mark, timeout, what: "late error response" }).then((f) => ({ stage: "response", success: false, error: f.error, code: f.code })),
      this.waitFor((f) => f.type === "prompt_result", { from: mark, timeout, what: "prompt_result" }).then((f) => ({ stage: "prompt_result", status: f.status, error: f.error })),
    ]).catch((e) => ({ stage: "timeout", detail: e.message }));
    return outcome;
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

function flattenCommands(list, prefix = "") {
  const out = [];
  for (const c of list || []) {
    const name = prefix ? `${prefix} ${c.name}` : c.name;
    out.push({ name, description: c.description ?? "" });
    if (Array.isArray(c.subcommands) && c.subcommands.length) {
      out.push(...flattenCommands(c.subcommands, name));
    }
  }
  return out;
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
// (~/<CONFIG_DIR_NAME>/profiles/pinion-probe-slash/agent/models.yml). A real,
// previously-used profile (including the developer's default one) has no
// such provider, so if the live process's own `get_state.model` reports
// back exactly {provider: "probe-fake", id: "probe-fake-model"}, that is
// direct proof the process read its config from the isolated profile --
// not merely that we *asked* it to with --profile. If it reports anything
// else (a real model, or none at all), the process did not resolve against
// the isolated profile and this script must not send it any command.
async function assertIsolatedProfile(proc) {
  const state = await proc.request({ type: "get_state" }).catch((e) => ({ success: false, error: e.message }));
  const model = state?.data?.model;
  if (model?.provider !== "probe-fake" || model?.id !== "probe-fake-model") {
    console.error(`ABORT: not running against the isolated profile (get_state.model=${JSON.stringify(model)}, expected provider "probe-fake" / id "probe-fake-model" seeded under ~/${CONFIG_DIR_NAME}/profiles/${PROFILE}/agent/models.yml)`);
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

const results = []; // { name, description, class, evidence }
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


try {
  let proc = await startProc();
  await assertIsolatedProfile(proc);
  const cmdsResp = await proc.request({ type: "get_available_commands" });
  if (!cmdsResp.success) throw new Error(`get_available_commands failed: ${JSON.stringify(cmdsResp.error)}`);
  const commands = flattenCommands(cmdsResp.data?.commands ?? cmdsResp.data ?? []);
  console.log(`discovered ${commands.length} command(s)/subcommand(s)`);

  for (const cmd of commands) {
    if (DENYLIST.test(cmd.name)) {
      results.push({ name: cmd.name, description: cmd.description, class: "needs-decision", evidence: "name matches denylist; not sent" });
      continue;
    }
    console.log(`testing /${cmd.name} ...`);
    let outcome;
    try {
      outcome = await proc.promptOnce(`/${cmd.name}`);
    } catch (e) {
      outcome = { stage: "exception", detail: e.message };
    }

    let cls, evidence;
    if (outcome.stage === "timeout") {
      cls = "broken";
      evidence = `timeout: ${outcome.detail}`;
    } else if (outcome.stage === "exception") {
      cls = "broken";
      evidence = `exception: ${outcome.detail}`;
    } else if (outcome.stage === "response" && outcome.success === true && outcome.agentInvoked === false) {
      cls = "works-local";
      evidence = "ack: agentInvoked=false (completed synchronously, no prompt_result)";
    } else if (outcome.stage === "response" && outcome.success === false) {
      const msg = String(outcome.error?.message ?? outcome.error ?? "");
      if (/terminal|interactive|tty/i.test(msg)) {
        cls = "terminal-only";
        evidence = `error: ${msg.slice(0, 120)}`;
      } else {
        cls = "broken";
        evidence = `error (${outcome.code ?? "?"}): ${msg.slice(0, 120)}`;
      }
    } else if (outcome.stage === "prompt_result") {
      if (outcome.status === "error") {
        const msg = String(outcome.error?.message ?? outcome.error ?? "");
        if (/terminal|interactive|tty/i.test(msg)) {
          cls = "terminal-only";
          evidence = `prompt_result error: ${msg.slice(0, 120)}`;
        } else {
          cls = "broken";
          evidence = `prompt_result error: ${msg.slice(0, 120)}`;
        }
      } else {
        // Completed without an agent turn visibly starting -> works-local,
        // unless get_state shows an in-progress turn we need to abort.
        cls = "works-local";
        evidence = `prompt_result status=${outcome.status}`;
      }
    } else {
      cls = "broken";
      evidence = `unrecognised outcome: ${JSON.stringify(outcome).slice(0, 160)}`;
    }

    // Check whether this looks like an agent turn actually started (agentInvoked
    // surfaces on the prompt ack path in some builds; fall back to get_state).
    const state = await proc.request({ type: "get_state" }).catch(() => null);
    const settled = state?.data?.isSettled !== false;
    if (!settled) {
      cls = "starts-agent-turn";
      evidence += "; get_state.isSettled=false after prompt -> aborting";
      await proc.request({ type: "abort" }).catch(() => { });
      const ok = await waitSettled(proc);
      evidence += ok ? "; settled after abort" : "; did NOT settle after abort, restarting process";
      await proc.close();
      proc = await startProc();
    }

    results.push({ name: cmd.name, description: cmd.description, class: cls, evidence });
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
