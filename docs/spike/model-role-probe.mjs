// Model-role RPC probe (research.md Unknowns; tasks.md T061).
//
// Question: does OMP expose a model "role" (chat role like default/smol/slow,
// or memory-kind role like image/web/speech) anywhere in its read-only RPC
// surface, or only provider + model id + thinking level? The status bar's
// model readout (T061) needs to know whether a role field exists to show it.
//
// This probe is READ-ONLY: it spawns `omp --mode rpc-ui --approval-mode=always-ask
// --session-dir <scratch dir under os.tmpdir()>` against Stuart's DEFAULT real
// OMP profile (no --profile flag), in a scratch cwd. It sends NO prompt and
// NEVER sends `/model`, `login`, or any other command that changes
// configuration. It sends exactly four read-only RPC requests:
// get_state, get_available_models, get_available_thinking_levels,
// get_available_commands.
//
// Raw frames can contain personal model/provider/skill names, so they are
// written only to a temp scratch dir (printed at the end) and never into this
// repo. Console/result-summary output redacts concrete model ids to
// "<redacted>", keeping only counts and key names.
//
// Run:  node docs/spike/model-role-probe.mjs
// Env:  PINION_OMP  omp executable (default "omp" from PATH)

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const OMP = process.env.PINION_OMP || "omp";
const READY_MS = 120_000;
const REQUEST_MS = 60_000;
const EXIT_MS = 30_000;

const T0 = Date.now();
const ROOT = path.join(os.tmpdir(), "pinion-model-role-probe", new Date().toISOString().replace(/[:.]/g, "-"));
const dir = (name) => path.join(ROOT, name);
for (const d of ["wt", "frames", "sessions"]) {
  fs.mkdirSync(dir(d), { recursive: true });
}
fs.writeFileSync(path.join(dir("wt"), "README.md"), "model-role probe scratch worktree\n");

// Recursively collects the key names of an object/array tree (keys only, no
// values), and separately collects any key name or string value matching
// /role|profile|tier|alias|purpose/i, so we can see role-shaped fields without
// capturing concrete ids.
function collectKeys(value, matches, pathSoFar) {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, matches, pathSoFar);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (/role|profile|tier|alias|purpose/i.test(k)) matches.add(`${pathSoFar}.${k}`);
      if (typeof v === "string" && /role|profile|tier|alias|purpose/i.test(v)) matches.add(`${pathSoFar}.${k}=<string match>`);
      collectKeys(v, matches, `${pathSoFar}.${k}`);
    }
  }
}

function safeName(label) {
  return label.replace(/[^a-zA-Z0-9_-]/g, "_");
}

class OmpProc {
  constructor(label, sessionDir) {
    this.label = label;
    this.waiters = [];
    this.frames = [];
    this.warnings = [];
    this.chunks = new Map();
    this.buf = Buffer.alloc(0);
    this.readyMs = null;
    this.exitCode = null;
    this.exited = false;
    this.log = fs.createWriteStream(path.join(dir("frames"), `${safeName(label)}.jsonl`));
    this.errLog = fs.createWriteStream(path.join(dir("frames"), `${safeName(label)}.stderr.log`));
    const args = ["--mode", "rpc-ui", "--approval-mode=always-ask", "--session-dir", sessionDir];
    this.startedAt = Date.now();
    this.child = spawn(OMP, args, { cwd: dir("wt"), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.exitPromise = new Promise((resolve) => {
      this.child.on("exit", (code) => { this.exited = true; this.exitCode = code; resolve(); });
      this.child.on("error", (e) => {
        console.error(`${label} spawn not found: ${e.message}`);
        this.exited = true;
        this.exitCode ??= -1;
        resolve();
      });
    });
    this.child.stdout.on("data", (d) => this.#onData(d));
    this.child.stderr.on("data", (d) => this.errLog.write(d));
  }

  #onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (true) {
      const i = this.buf.indexOf(0x0a);
      if (i < 0) break;
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
      c.got++;
      if (c.got === frame.count) {
        this.chunks.delete(frame.chunkId);
        const whole = Buffer.concat(c.parts);
        if (whole.byteLength !== c.byteLength) return;
        try { this.#dispatch(JSON.parse(whole.toString("utf8"))); }
        catch (e) { this.#dispatch({ type: "__probe_protocol_error", error: `chunk ${frame.chunkId}: ${e.message}` }); }
        return;
      }
      return;
    }
    this.#dispatch(frame);
  }

  #dispatch(frame) {
    this.log.write(JSON.stringify({ t: Date.now() - T0, dir: "in", frame }) + "\n");
    this.frames.push(frame);
    if (frame.type === "ready") this.readyMs = Date.now() - this.startedAt;
    const idx = this.waiters.findIndex((w) => w.pred(frame));
    if (idx !== -1) {
      const [w] = this.waiters.splice(idx, 1);
      w.resolve(frame);
    }
  }

  waitFor(pred, timeout, what = "frame") {
    for (const f of this.frames) if (pred(f)) return Promise.resolve(f);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`timeout after ${timeout}ms waiting for ${what}`));
      }, timeout);
      const w = { pred, resolve: (f) => { clearTimeout(t); resolve(f); } };
      this.waiters.push(w);
    });
  }

  async ready() {
    const r = await Promise.race([
      this.waitFor((f) => f.type === "ready", READY_MS, "ready frame").then((f) => ({ ok: true, f })),
      this.exitPromise.then(() => ({ ok: false })),
    ]);
    if (!r.ok) throw new Error(`process exited before ready (code ${this.exitCode}); see frames/${safeName(this.label)}.stderr.log`);
  }

  async request(cmd) {
    this.log.write(JSON.stringify({ t: Date.now() - T0, dir: "out", frame: cmd }) + "\n");
    this.child.stdin.write(JSON.stringify(cmd) + "\n");
    return this.waitFor((f) => f.type === "response" && f.id === cmd.id, REQUEST_MS, `response to ${cmd.type}`);
  }

  async closeGracefully() {
    this.child.stdin.end();
    const done = await Promise.race([this.exitPromise.then(() => true), new Promise((r) => setTimeout(() => r(false), EXIT_MS))]);
    if (!done) this.hardKill();
  }

  hardKill() {
    try { execFileSync("taskkill", ["/PID", String(this.child.pid), "/T", "/F"], { stdio: "ignore" }); }
    catch { /* already gone */ }
  }
}

// ---- main ----
let ompVersion = "unknown";
try { ompVersion = execFileSync(OMP, ["--version"], { encoding: "utf8" }).trim(); }
catch (e) { console.error(`omp not found; set PINION_OMP (${e.message})`); process.exit(2); }
console.log(`omp ${ompVersion}\nscratch ${ROOT}\n`);

const observations = {
  ompVersion,
  scratch: ROOT,
  getState: null,
  getAvailableModels: null,
  getAvailableThinkingLevels: null,
  getAvailableCommands: null,
  roleMatches: [],
  error: null,
};

let scriptFailed = false;
try {
  const p = new OmpProc("probe", dir("sessions"));
  await p.ready();

  const roleMatches = new Set();

  const stateResp = await p.request({ id: "req-state", type: "get_state" });
  observations.getState = {
    success: stateResp.success,
    keys: stateResp.data ? Object.keys(stateResp.data) : [],
  };
  collectKeys(stateResp.data, roleMatches, "get_state");

  const modelsResp = await p.request({ id: "req-models", type: "get_available_models" });
  const modelsList = modelsResp.data?.models ?? modelsResp.data ?? [];
  observations.getAvailableModels = {
    success: modelsResp.success,
    count: Array.isArray(modelsList) ? modelsList.length : null,
    exampleEntryKeys: Array.isArray(modelsList) && modelsList.length > 0 ? Object.keys(modelsList[0]) : [],
  };
  collectKeys(modelsResp.data, roleMatches, "get_available_models");

  const levelsResp = await p.request({ id: "req-levels", type: "get_available_thinking_levels" });
  observations.getAvailableThinkingLevels = {
    success: levelsResp.success,
    levels: levelsResp.data?.levels ?? null,
  };
  collectKeys(levelsResp.data, roleMatches, "get_available_thinking_levels");

  const commandsResp = await p.request({ id: "req-commands", type: "get_available_commands" });
  const commands = commandsResp.data?.commands ?? [];
  const modelCommand = Array.isArray(commands) ? commands.find((c) => c.name === "model" || c.name === "models") : null;
  observations.getAvailableCommands = {
    success: commandsResp.success,
    count: Array.isArray(commands) ? commands.length : null,
    modelDescriptorKeys: modelCommand ? Object.keys(modelCommand) : [],
  };
  collectKeys(commandsResp.data, roleMatches, "get_available_commands");

  observations.roleMatches = [...roleMatches].sort();

  await p.closeGracefully();
} catch (e) {
  observations.error = e.message;
  scriptFailed = true;
  console.error("probe FAILED", e.message);
}

console.log("get_state keys:", observations.getState?.keys);
console.log("get_available_models example entry keys:", observations.getAvailableModels?.exampleEntryKeys, "count:", observations.getAvailableModels?.count);
console.log("get_available_thinking_levels:", observations.getAvailableThinkingLevels?.levels);
console.log("get_available_commands model descriptor keys:", observations.getAvailableCommands?.modelDescriptorKeys, "count:", observations.getAvailableCommands?.count);
console.log("role/profile/tier/alias/purpose matches:", observations.roleMatches);

fs.writeFileSync(path.join(ROOT, "result.json"), JSON.stringify(observations, null, 2));
console.log(`\nscratch dir (raw frames, unredacted): ${ROOT}`);
process.exit(scriptFailed ? 1 : 0);
