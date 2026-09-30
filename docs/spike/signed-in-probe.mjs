// "OMP signed in" readiness probe (research.md Unknowns row 2; contracts/ipc.md
// `readiness.check()` -> `ompSignedIn`; tasks.md T005).
//
// Question: what does OMP tell an RPC host about auth state, and which signal is
// deterministic? Two processes are probed:
//   P1  the real dev machine's default profile (whatever the user is actually
//       signed in to) -- read-only: no prompt is sent, nothing is mutated.
//   P2  a brand-new, never-used `--profile pinion-probe-empty` with every
//       credential-shaped env var stripped from its environment -- this is the
//       safe way to produce an "unsigned" state without touching real
//       credentials. `--profile` isolates auth/sessions/settings/caches under
//       `~/.omp/profiles/<name>/` (see `pi-utils/src/dirs.ts`), a location
//       distinct from the real default-profile store under `~/.omp/agent/`.
//       This probe deletes that profile directory again once P2 exits.
//
// Both processes call, in order: get_available_models, get_state, and
// get_login_providers. P2 additionally sends one prompt to observe the error
// shape when no provider is authenticated.
//
// This script NEVER reads, prints, copies, or modifies anything under the
// default profile's `~/.omp/agent/` credential store, and NEVER sends a
// `login` command.
//
// Run:  node docs/spike/signed-in-probe.mjs
// Env:  PINION_OMP          omp executable (default "omp" from PATH)
//       PINION_PROBE_MODEL  model id (default github-copilot/gpt-5.6-luna; "none" = no --model)
//
// Raw frames and model/provider id lists can contain personal skill/model/
// account names, so they are written only to a temp scratch dir (printed at
// the end) and never into this repo. Console/result-summary output redacts
// concrete model ids to "<redacted>", keeping only counts and provider ids
// (provider ids like "github-copilot" are a fixed catalog category, not
// personal data).

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const OMP = process.env.PINION_OMP || "omp";
const MODEL = process.env.PINION_PROBE_MODEL || "github-copilot/gpt-5.6-luna";
const ISOLATED_PROFILE = "pinion-probe-empty";
const READY_MS = 120_000;
const REQUEST_MS = 60_000;
const PROMPT_MS = 60_000;
const EXIT_MS = 30_000;

const T0 = Date.now();
const ROOT = path.join(os.tmpdir(), "pinion-signed-in-probe", new Date().toISOString().replace(/[:.]/g, "-"));
const dir = (name) => path.join(ROOT, name);
for (const d of ["wt", "wt2", "frames", "sessions-signedin", "sessions-isolated"]) {
  fs.mkdirSync(dir(d), { recursive: true });
}
fs.writeFileSync(path.join(dir("wt"), "README.md"), "signed-in probe worktree\n");
fs.writeFileSync(path.join(dir("wt2"), "README.md"), "signed-in probe isolated-profile worktree\n");

// Strip anything credential-shaped so the isolated-profile process cannot fall
// back to an ambient env-var API key. PATH/HOME/USERPROFILE/SystemRoot/etc.
// are left alone -- they are needed to spawn the process at all on Windows.
function sanitizedEnv() {
  const out = { ...process.env };
  const credentialPattern = /API_KEY|OAUTH|TOKEN|SECRET|CREDENTIAL/i;
  for (const key of Object.keys(out)) {
    if (credentialPattern.test(key)) delete out[key];
  }
  return out;
}

const redactModelId = (id) => (typeof id === "string" ? "<redacted>" : id);

class OmpProc {
  constructor(label, sessionDir, extra = [], cwd = dir("wt"), env = process.env) {
    this.label = label;
    this.frames = [];
    this.waiters = [];
    this.warnings = [];
    this.chunks = new Map();
    this.buf = Buffer.alloc(0);
    this.n = 0;
    this.readyMs = null;
    this.exitCode = null;
    this.exited = false;
    this.log = fs.createWriteStream(path.join(dir("frames"), `${label}.jsonl`));
    this.errLog = fs.createWriteStream(path.join(dir("frames"), `${label}.stderr.log`));
    const args = [
      "--mode", "rpc-ui",
      "--approval-mode=always-ask",
      ...(MODEL === "none" ? [] : ["--model", MODEL]),
      "--session-dir", sessionDir,
      ...extra,
    ];
    this.startedAt = Date.now();
    this.child = spawn(OMP, args, { cwd, stdio: "pipe", windowsHide: true, env });
    this.exitPromise = new Promise((resolve) => {
      this.child.on("exit", (code) => { this.exited = true; this.exitCode ??= code; resolve(); });
    });
    this.child.on("error", (e) => {
      console.error(`omp not found; set PINION_OMP (${e.message})`);
      process.exit(2);
    });
    this.child.stdout.on("data", (d) => this.#onData(d));
    this.child.stderr.on("data", (d) => this.errLog.write(d));
  }

  #record(dirn, frame, extra = {}) {
    this.log.write(JSON.stringify({ t: Date.now() - T0, dir: dirn, frame, ...extra }) + "\n");
  }

  #onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    let i;
    while ((i = this.buf.indexOf(0x0a)) >= 0) {
      const line = this.buf.subarray(0, i).toString("utf8").trim();
      this.buf = this.buf.subarray(i + 1);
      if (!line) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { this.#record("out", line, { parseError: true }); continue; }
      this.#handle(frame);
    }
  }

  #handle(frame) {
    if (frame.type === "rpc_chunk") {
      let c = this.chunks.get(frame.chunkId);
      if (!c) { c = { parts: new Array(frame.count), got: 0, byteLength: frame.byteLength }; this.chunks.set(frame.chunkId, c); }
      if (!c.parts[frame.index]) c.got++;
      c.parts[frame.index] = Buffer.from(frame.data, "base64");
      if (c.got === frame.count) {
        this.chunks.delete(frame.chunkId);
        const whole = Buffer.concat(c.parts);
        if (whole.length !== c.byteLength) {
          this.#dispatch({ type: "__probe_protocol_error", error: `chunk ${frame.chunkId}: got ${whole.length} bytes, expected ${c.byteLength}` });
          return;
        }
        try { this.#dispatch(JSON.parse(whole.toString("utf8"))); }
        catch (e) { this.#dispatch({ type: "__probe_protocol_error", error: `chunk ${frame.chunkId}: ${e.message}` }); }
      }
      return;
    }
    this.#dispatch(frame);
  }

  #dispatch(frame) {
    const idx = this.frames.length;
    this.frames.push(frame);
    this.#record("out", frame.type === "response" && frame.command === "get_state"
      ? { ...frame, data: { ...frame.data, systemPrompt: "[omitted]", dumpTools: "[omitted]" } }
      : frame);
    if (frame.type === "extension_ui_request") this.#answerDialog(frame);
    for (const w of [...this.waiters]) {
      if (idx >= w.from && w.pred(frame)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(frame); }
    }
  }

  #answerDialog(f) {
    const title = String(f.title ?? "");
    if (f.method === "select" && title.startsWith("Allow tool:")) {
      this.warnings.push(`approval denied: ${title.split("\n")[0]}`);
      this.write({ type: "extension_ui_response", id: f.id, value: "Deny" });
    } else if (["select", "confirm", "input", "editor"].includes(f.method)) {
      this.warnings.push(`dialog cancelled: ${f.method} ${title.split("\n")[0]}`);
      this.write({ type: "extension_ui_response", id: f.id, cancelled: true });
    }
  }

  write(obj) {
    this.#record("in", obj);
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  waitFor(pred, from, timeout, what = "frame") {
    for (let i = from; i < this.frames.length; i++) if (pred(this.frames[i])) return Promise.resolve(this.frames[i]);
    return new Promise((resolve, reject) => {
      const w = { pred, from, resolve: (f) => { clearTimeout(t); resolve(f); } };
      const t = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`${this.label}: timeout after ${timeout}ms waiting for ${what}`));
      }, timeout);
      this.waiters.push(w);
    });
  }

  // Races the ready frame against process exit, so a startup crash in the
  // isolated-profile process is reported as a distinct, readable failure
  // instead of a generic waitFor timeout.
  async ready() {
    const r = await Promise.race([
      this.waitFor((f) => f.type === "ready", 0, READY_MS, "ready frame").then((f) => ({ ok: true, frame: f })),
      this.exitPromise.then(() => ({ ok: false })),
    ]);
    if (!r.ok) {
      throw new Error(`process exited before ready (code ${this.exitCode}); see frames/${this.label}.stderr.log`);
    }
    this.readyFrame = r.frame;
    this.readyMs = Date.now() - this.startedAt;
    if (this.readyFrame.supportedProtocolVersions?.includes(2)) {
      const neg = await this.request({ type: "negotiate_protocol", protocolVersion: 2 });
      if (!neg.success) throw new Error(`negotiate_protocol failed: ${neg.error}`);
    }
  }

  async request(cmd, timeout = REQUEST_MS) {
    const id = `${this.label}-${++this.n}`;
    const mark = this.frames.length;
    this.write({ id, ...cmd });
    return this.waitFor((f) => f.type === "response" && f.id === id, mark, timeout, `response to ${cmd.type}`);
  }

  async getState() { return (await this.request({ type: "get_state" })).data; }

  // Sends one prompt and returns whichever terminal shape arrives first: an
  // immediate failed response, a locally-handled response (agentInvoked:
  // false), or the eventual prompt_result frame (completed or error).
  async promptOnce(message) {
    const id = `${this.label}-${++this.n}`;
    const mark = this.frames.length;
    this.write({ id, type: "prompt", message });
    const ack = await this.waitFor((f) => f.type === "response" && f.id === id, mark, REQUEST_MS, "prompt ack");
    if (!ack.success) return { stage: "response", success: false, error: ack.error, code: ack.code };
    if (ack.data?.agentInvoked === false) return { stage: "response", success: true, agentInvoked: false };
    const outcome = await Promise.race([
      this.waitFor((f) => f.type === "response" && f.id === id && f.success === false, mark, PROMPT_MS, "late error response").then((f) => ({ stage: "response", success: false, error: f.error, code: f.code })),
      this.waitFor((f) => f.type === "prompt_result" && f.id === id, mark, PROMPT_MS, "prompt_result").then((f) => ({ stage: "prompt_result", status: f.status, error: f.error })),
    ]).catch((e) => ({ stage: "timeout", detail: e.message }));
    return outcome;
  }

  async closeGracefully() {
    this.child.stdin.end();
    const done = await Promise.race([this.exitPromise.then(() => true), new Promise((r) => setTimeout(() => r(false), EXIT_MS))]);
    if (!done) { await this.hardKill(); this.exitCode = "timeout->killed"; }
  }

  async hardKill() {
    if (!this.exited) {
      try { execFileSync("taskkill", ["/PID", String(this.child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* already gone */ }
      await Promise.race([this.exitPromise, new Promise((r) => setTimeout(r, EXIT_MS))]);
      this.exitCode = this.exitCode === null ? "killed" : this.exitCode;
    }
  }

  summary() {
    this.log.end(); this.errLog.end();
    return { label: this.label, readyMs: this.readyMs, exitCode: this.exitCode, warnings: this.warnings };
  }
}

// Runs the three read-only probe calls common to both phases and returns a
// redacted observation object (see module header: no concrete model ids).
async function probeAuthSignals(p) {
  const models = await p.request({ type: "get_available_models" });
  const modelsData = models.success ? models.data.models : null;
  const providersSeen = modelsData ? [...new Set(modelsData.map((m) => m.provider))] : [];

  const state = await p.getState();

  const login = await p.request({ type: "get_login_providers" });
  const loginProviders = login.success ? login.data.providers : [];

  return {
    modelsCall: { success: models.success, error: models.success ? undefined : models.error, count: modelsData?.length ?? null, providers: providersSeen },
    stateModel: { present: !!state.model?.id, provider: state.model?.provider ?? null, id: redactModelId(state.model?.id) },
    loginProviders: {
      success: login.success,
      error: login.success ? undefined : login.error,
      count: loginProviders.length,
      authenticatedCount: loginProviders.filter((pr) => pr.authenticated).length,
      providers: loginProviders.map((pr) => ({ id: pr.id, name: pr.name, available: pr.available, authenticated: pr.authenticated })),
    },
  };
}

// ---- main ----
let ompVersion = "unknown";
try { ompVersion = execFileSync(OMP, ["--version"], { encoding: "utf8" }).trim(); }
catch (e) { console.error(`omp not found; set PINION_OMP (${e.message})`); process.exit(2); }
if (!ompVersion.includes("18.4.4")) console.log("WARN: FINDINGS were recorded on omp 18.4.4");
console.log(`omp ${ompVersion} | model ${MODEL}\nscratch ${ROOT}\n`);

const observations = { ompVersion, model: MODEL, scratch: ROOT, signedIn: null, isolated: null };
let scriptFailed = false;

// P1: the real dev machine's default profile. Read-only: no prompt is sent.
try {
  const p1 = new OmpProc("P1-signedin", dir("sessions-signedin"));
  await p1.ready();
  observations.signedIn = await probeAuthSignals(p1);
  await p1.closeGracefully();
  console.log("signedIn.ready       PASS", `readyMs=${p1.readyMs}`);
  console.log("signedIn.models      INFO", JSON.stringify(observations.signedIn.modelsCall));
  console.log("signedIn.state.model INFO", JSON.stringify(observations.signedIn.stateModel));
  console.log("signedIn.loginProv   INFO", JSON.stringify({ ...observations.signedIn.loginProviders, providers: undefined }));
  console.log("signedIn.loginProv[] INFO", JSON.stringify(observations.signedIn.loginProviders.providers));
} catch (e) {
  scriptFailed = true;
  observations.signedIn = { error: e.message };
  console.log("signedIn             FAIL", e.message);
}

// P2: brand-new, never-used profile with credential-shaped env vars stripped.
// `--profile` isolates auth/sessions/settings/caches under
// ~/.omp/profiles/<name>/, distinct from the real ~/.omp/agent/ store.
let profileRootToClean = null;
try {
  const configDirName = process.env.PI_CONFIG_DIR || ".omp";
  profileRootToClean = path.join(os.homedir(), configDirName, "profiles", ISOLATED_PROFILE);

  const p2 = new OmpProc("P2-isolated", dir("sessions-isolated"), ["--profile", ISOLATED_PROFILE], dir("wt2"), sanitizedEnv());
  try {
    await p2.ready();
    observations.isolated = await probeAuthSignals(p2);
    observations.isolated.prompt = await p2.promptOnce("Reply with the word hello");
    console.log("isolated.ready       PASS", `readyMs=${p2.readyMs}`);
    console.log("isolated.models      INFO", JSON.stringify(observations.isolated.modelsCall));
    console.log("isolated.state.model INFO", JSON.stringify(observations.isolated.stateModel));
    console.log("isolated.loginProv   INFO", JSON.stringify({ ...observations.isolated.loginProviders, providers: undefined }));
    console.log("isolated.loginProv[] INFO", JSON.stringify(observations.isolated.loginProviders.providers));
    console.log("isolated.prompt      INFO", JSON.stringify(observations.isolated.prompt));
  } catch (e) {
    observations.isolated = { error: e.message };
    console.log("isolated             INFO", `could not reach ready: ${e.message}`);
  } finally {
    await p2.closeGracefully();
  }
} catch (e) {
  scriptFailed = true;
  observations.isolated = { ...(observations.isolated ?? {}), scriptError: e.message };
  console.log("isolated             FAIL", e.message);
} finally {
  // Clean up the scratch profile directory. Guard the path shape before
  // deleting anything: it must end in profiles/<exact isolated profile name>,
  // so this can never touch the real default-profile credential store.
  if (profileRootToClean) {
    const expectedSuffix = path.join("profiles", ISOLATED_PROFILE);
    if (profileRootToClean.endsWith(expectedSuffix) && fs.existsSync(profileRootToClean)) {
      fs.rmSync(profileRootToClean, { recursive: true, force: true });
      console.log(`cleaned up ${profileRootToClean}`);
    }
  }
}

fs.writeFileSync(path.join(ROOT, "result.json"), JSON.stringify(observations, null, 2));
console.log(`\nscratch dir (raw frames, unredacted): ${ROOT}`);
process.exit(scriptFailed ? 1 : 0);
