// #741 decision 2 probe: "probe a real fallback first" -- does a repeated-failure retry onto a
// configured `retry.fallbackChains.default` target actually get recorded as a `model_change`
// Session-file entry with `resolvedModelIsFallback: true` (FINDINGS item 51/341 established the
// FIELD exists and is always `false` in every scenario probed so far, but never forced `true`)?
//
// ISOLATION (identical discipline to docs/spike/omp-signin-probe.mjs / slash-commands-probe.mjs):
//   - --profile pinion-probe-fallback-741 (brand-new profile name, never used before), a scratch
//     --session-dir, and a scratch cwd -- never ~/.omp itself;
//   - the child environment has every credential-shaped var removed (sanitizedEnv());
//   - BOTH the "default" role model AND the configured fallback-chain target are fake, unreachable
//     custom models (closed local port, auth: none) seeded solely under the isolated profile's own
//     models.yml -- this needs NO real credentials at all: proving the MECHANISM (does OMP ever
//     switch the active model and mark the transition `resolvedModelIsFallback: true` after
//     repeated failures) does not require the fallback attempt to actually succeed, only that OMP
//     decided to retry with the configured fallback selector;
//   - a pre-flight check (assertIsolatedProfile) aborts before sending anything unless the live
//     process's own get_state.model resolves to the probe-fake-a model seeded solely under this
//     isolated profile;
//   - zero real provider credentials are configured anywhere in this profile; nothing here can
//     reach a real model or spend real tokens.
//
// Run:  node docs/spike/fallback-probe-741.mjs
// Env:  PINION_OMP  omp executable (default "omp" from PATH)

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const OMP = process.env.PINION_OMP || "omp";
const PROFILE = "pinion-probe-fallback-741";
const CONFIG_DIR_NAME = process.env.PI_CONFIG_DIR || ".omp";
const READY_MS = 120_000;
const REQUEST_MS = 60_000;
const TURN_MS = 90_000;
const EXIT_MS = 30_000;

const T0 = Date.now();
const ROOT = path.join(os.tmpdir(), "pinion-fallback-probe-741", new Date().toISOString().replace(/[:.]/g, "-"));
const dir = (name) => path.join(ROOT, name);
for (const d of ["wt", "frames", "sessions"]) {
  fs.mkdirSync(dir(d), { recursive: true });
}
fs.writeFileSync(path.join(dir("wt"), "README.md"), "fallback-probe-741 scratch worktree\n");

function sanitizedEnv() {
  const credentialPattern = /API_KEY|OAUTH|TOKEN|SECRET|CREDENTIAL|PASSWORD|_PAT\b|AUTH|_KEY\b/i;
  const out = { ...process.env };
  for (const key of Object.keys(out)) {
    if (credentialPattern.test(key)) delete out[key];
  }
  return out;
}

// Two fake, unreachable, keyless models under one fake provider: "a" is modelRoles.default,
// "b" is the sole retry.fallbackChains.default entry. Neither can ever actually complete a
// request (closed local port) -- this probe only needs to observe whether OMP ever DECIDES to
// retry onto "b" and records that decision, not whether "b" itself then succeeds.
function ensureFakeModelsAndConfig() {
  const agentDir = path.join(os.homedir(), CONFIG_DIR_NAME, "profiles", PROFILE, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const modelsYml = [
    "providers:",
    "  probe-fake:",
    "    baseUrl: http://127.0.0.1:1",
    "    auth: none",
    "    api: openai-completions",
    "    models:",
    "      - id: probe-fake-model-a",
    "        name: Probe Fake Model A",
    "        api: openai-completions",
    "        contextWindow: 8000",
    "        maxTokens: 1000",
    "      - id: probe-fake-model-b",
    "        name: Probe Fake Model B",
    "        api: openai-completions",
    "        contextWindow: 8000",
    "        maxTokens: 1000",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(agentDir, "models.yml"), modelsYml);
  const configYml = [
    "modelRoles:",
    "  default: probe-fake/probe-fake-model-a",
    "retry:",
    "  fallbackChains:",
    "    default:",
    "      - probe-fake/probe-fake-model-b",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(agentDir, "config.yml"), configYml);
}

function readModelChangeEntries(sessionFile) {
  if (!sessionFile || !fs.existsSync(sessionFile)) return [];
  const lines = fs.readFileSync(sessionFile, "utf8").split("\n").filter(Boolean);
  const out = [];
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === "model_change") out.push(obj);
  }
  return out;
}

class OmpProc {
  constructor(label, sessionDir, extraArgs = []) {
    this.label = label;
    this.waiters = [];
    this.frames = [];
    this.chunks = new Map();
    this.buf = Buffer.alloc(0);
    this.n = 0;
    this.exitCode = null;
    this.exited = false;
    this.log = fs.createWriteStream(path.join(dir("frames"), `${label}.jsonl`));
    this.errLog = fs.createWriteStream(path.join(dir("frames"), `${label}.stderr.log`));
    const args = ["--mode", "rpc-ui", "--approval-mode=always-ask", "--profile", PROFILE, "--session-dir", sessionDir, ...extraArgs];
    this.child = spawn(OMP, args, { cwd: dir("wt"), stdio: "pipe", windowsHide: true, env: sanitizedEnv() });
    this.exitPromise = new Promise((resolve) => {
      this.child.on("exit", (code) => { this.exitCode = code; this.exited = true; resolve(); });
      this.child.on("error", (e) => { console.error(`${label} spawn error: ${e.message}`); this.exited = true; this.exitCode ??= -1; resolve(); });
    });
    this.child.stdout.on("data", (d) => this.#onData(d));
    this.child.stderr.on("data", (d) => this.errLog.write(d));
  }

  #onData(buf) {
    this.buf = Buffer.concat([this.buf, buf]);
    let i;
    while ((i = this.buf.indexOf(0x0a)) >= 0) {
      const line = this.buf.subarray(0, i).toString("utf8").trim();
      this.buf = this.buf.subarray(i + 1);
      if (!line) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      this.#handle(frame);
    }
  }

  #handle(frame) {
    if (frame.type === "rpc_chunk") {
      let c = this.chunks.get(frame.chunkId);
      if (!c) { c = { parts: new Array(frame.count), got: 0, byteLength: frame.byteLength }; this.chunks.set(frame.chunkId, c); }
      c.parts[frame.index] = Buffer.from(frame.data, "base64");
      if (++c.got === frame.count) {
        this.chunks.delete(frame.chunkId);
        const whole = Buffer.concat(c.parts);
        if (whole.byteLength === c.byteLength) {
          try { this.#dispatch(JSON.parse(whole.toString("utf8"))); } catch { /* ignore */ }
        }
      }
      return;
    }
    this.#dispatch(frame);
  }

  #dispatch(frame) {
    this.log.write(JSON.stringify({ t: Date.now() - T0, dir: "in", frame }) + "\n");
    this.frames.push(frame);
    if (frame.type === "extension_ui_request") {
      this.child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: frame.id, cancelled: true }) + "\n");
    }
    for (let idx = this.waiters.length - 1; idx >= 0; idx--) {
      const w = this.waiters[idx];
      if (w.pred(frame)) { this.waiters.splice(idx, 1); w.resolve(frame); }
    }
  }

  waitFor(pred, { from = 0, timeout = REQUEST_MS, what = "frame" } = {}) {
    for (let i = from; i < this.frames.length; i++) if (pred(this.frames[i])) return Promise.resolve(this.frames[i]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      const t = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); reject(new Error(`[${this.label}] timeout after ${timeout}ms waiting for ${what}`)); }, timeout);
      w.resolve = (f) => { clearTimeout(t); resolve(f); };
      this.waiters.push(w);
    });
  }

  async request(cmd, timeout = REQUEST_MS) {
    const id = `${this.label}-${++this.n}`;
    const mark = this.frames.length;
    this.log.write(JSON.stringify({ t: Date.now() - T0, dir: "out", frame: { id, ...cmd } }) + "\n");
    this.child.stdin.write(JSON.stringify({ id, ...cmd }) + "\n");
    return this.waitFor((f) => f.type === "response" && f.id === id, { from: mark, timeout, what: `${cmd.type} response` });
  }

  async ready() {
    const r = await Promise.race([
      this.waitFor((f) => f.type === "ready", { timeout: READY_MS, what: "ready frame" }).then((f) => ({ ok: true, f })),
      this.exitPromise.then(() => ({ ok: false })),
    ]);
    if (!r.ok) throw new Error(`[${this.label}] process exited before ready (code ${this.exitCode}); see frames/${this.label}.stderr.log`);
  }

  async closeGracefully() {
    this.child.stdin.end();
    const done = await Promise.race([this.exitPromise.then(() => true), new Promise((r) => setTimeout(() => r(false), EXIT_MS))]);
    if (!done) this.hardKill();
    await this.exitPromise;
  }

  hardKill() {
    try { execFileSync("taskkill", ["/PID", String(this.child.pid), "/T", "/F"], { stdio: "ignore" }); }
    catch { /* already gone */ }
  }
}

async function assertIsolatedProfile(proc) {
  const state = await proc.request({ type: "get_state" }).catch((e) => ({ success: false, error: e.message }));
  const model = state?.data?.model;
  if (model?.provider !== "probe-fake" || model?.id !== "probe-fake-model-a") {
    console.error(`ABORT: not running against the isolated profile (get_state.model=${JSON.stringify(model)})`);
    await proc.closeGracefully();
    process.exit(1);
  }
}

// ---- main ----
let ompVersion = "unknown";
try { ompVersion = execFileSync(OMP, ["--version"], { encoding: "utf8" }).trim(); }
catch (e) { console.error(`omp not found; set PINION_OMP (${e.message})`); process.exit(2); }
console.log(`omp ${ompVersion} | profile ${PROFILE}\nscratch ${ROOT}\n`);

ensureFakeModelsAndConfig();

const results = { ompVersion, profile: PROFILE, scratch: ROOT };
let scriptFailed = false;

try {
  const sd1 = dir(path.join("sessions", "s1"));
  fs.mkdirSync(sd1, { recursive: true });
  const p1 = new OmpProc("p1", sd1);
  await p1.ready();
  await assertIsolatedProfile(p1);

  const state0 = (await p1.request({ type: "get_state" })).data;
  results.baselineModel = state0.model;
  results.sessionFile = state0.sessionFile;

  // One short prompt against the unreachable default model. It can never complete; the only
  // question is what OMP does about it -- retry the same model, error out immediately, or
  // retry onto the configured fallback chain target and record that transition.
  const turnId = "turn-1";
  const resultPromise = p1.waitFor((f) => f.type === "prompt_result" && f.id === turnId, { timeout: TURN_MS, what: "prompt_result" });
  const fallbackAppliedPromise = p1.waitFor((f) => f.type === "retry_fallback_applied", { timeout: TURN_MS, what: "retry_fallback_applied" }).catch(() => null);
  const fallbackSucceededPromise = p1.waitFor((f) => f.type === "retry_fallback_succeeded", { timeout: TURN_MS, what: "retry_fallback_succeeded" }).catch(() => null);
  const modelChangedPromise = p1.waitFor((f) => f.type === "model_changed", { timeout: TURN_MS, what: "model_changed" }).catch(() => null);
  p1.log.write(JSON.stringify({ t: Date.now() - T0, dir: "out", frame: { id: turnId, type: "prompt", message: "hello" } }) + "\n");
  p1.child.stdin.write(JSON.stringify({ id: turnId, type: "prompt", message: "hello" }) + "\n");

  const [promptResult, fallbackApplied, fallbackSucceeded, modelChanged] = await Promise.all([
    resultPromise.catch((e) => ({ status: "timeout", detail: e.message })),
    fallbackAppliedPromise,
    fallbackSucceededPromise,
    modelChangedPromise,
  ]);
  results.promptResult = { status: promptResult.status, error: promptResult.error, sessionSettled: promptResult.sessionSettled };
  results.retryFallbackAppliedFrame = fallbackApplied;
  results.retryFallbackSucceededFrame = fallbackSucceeded;
  results.modelChangedFrame = modelChanged;

  await new Promise((r) => setTimeout(r, 1000)); // let any trailing append land
  const stateAfter = (await p1.request({ type: "get_state" })).data;
  results.modelAfterTurn = stateAfter.model;
  const entries = readModelChangeEntries(state0.sessionFile);
  results.modelChangeEntries = entries;
  results.anyResolvedModelIsFallbackTrue = entries.some((e) => e.resolvedModelIsFallback === true);

  await p1.closeGracefully();
} catch (e) {
  results.error = e.message;
  scriptFailed = true;
  console.error("probe FAILED:", e.message);
}

console.log(JSON.stringify(results, null, 2));
fs.writeFileSync(path.join(ROOT, "result.json"), JSON.stringify(results, null, 2));
console.log(`\nscratch dir (raw frames, unredacted): ${ROOT}`);
console.log(`\nCLEANUP REQUIRED: remove ~/${CONFIG_DIR_NAME}/profiles/${PROFILE} by hand (literal path, never a variable-built delete target).`);
process.exit(scriptFailed ? 1 : 0);
