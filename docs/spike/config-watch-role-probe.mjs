// RM0 probe (issues #740, #762, #766, #760): does a running `rpc-ui` process
// pick up an externally-written `modelRoles`/`cycleOrder` config change on its
// own active Session (config watch/reload, #740 probes 1 and 5); what shape
// `cycleOrder` round-trips as; whether `/switch` exists as a distinct OMP
// command; whether plan mode has any RPC route at all (#766 probe 4); and
// what `source` `get_available_commands` reports for project/user-authored
// command files versus built-ins (#760 probes 1 and 6).
//
// ISOLATION IS MANDATORY (same pattern as docs/spike/slash-commands-probe.mjs
// and docs/spike/omp-signin-probe.mjs):
//   - every omp process uses --profile pinion-probe-rm0-config (a brand-new
//     profile name, never used before), --session-dir under a scratch temp
//     dir, and a scratch cwd -- never ~/.omp itself, never the real default
//     profile's config.yml;
//   - the child environment has every credential-shaped var removed
//     (sanitizedEnv());
//   - the isolated profile has no real models configured. A single
//     unreachable, keyless, fake custom model is seeded so the process can
//     reach `ready` (same ensureFakeModel() trick as slash-commands-probe.mjs);
//     this never touches real credentials and spends no model tokens --
//     nothing in this script ever completes a real agent turn;
//   - before sending anything, assertIsolatedProfile() checks the live
//     process's get_state.model resolves to probe-fake/probe-fake-model;
//   - this script snapshots name+mtime of every top-level entry directly
//     under ~/.omp/agent (never contents) once before and once after the
//     whole run; a changed mtime on the four known host-session churn files
//     (agent.db, agent.db-wal, models.db, models.db-wal) is expected and
//     ignored, any OTHER difference prints "ISOLATION BREACH" and exits 3;
//   - all `omp config` writes in this script target --profile
//     pinion-probe-rm0-config exclusively, never the default profile;
//   - this script never deletes anything -- the integrator removes
//     ~/.omp/profiles/pinion-probe-rm0-config by hand afterward.
//
// Run:  node docs/spike/config-watch-role-probe.mjs
// Env:  PINION_OMP  omp executable (default "omp" from PATH)

import { spawn, execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);
const OMP = process.env.PINION_OMP || "omp";
const PROFILE = "pinion-probe-rm0-config";
const CONFIG_DIR_NAME = process.env.PI_CONFIG_DIR || ".omp";
const READY_MS = 120_000;
const REQUEST_MS = 60_000;
const RELOAD_WAIT_MS = 6_000; // settings.md: "reloaded after a short debounce"

const T0 = Date.now();
const ROOT = path.join(os.tmpdir(), "pinion-config-watch-role-probe", new Date().toISOString().replace(/[:.]/g, "-"));
const dir = (name) => path.join(ROOT, name);
for (const d of ["wt", "frames", "sessions"]) fs.mkdirSync(dir(d), { recursive: true });
fs.writeFileSync(path.join(dir("wt"), "README.md"), "config-watch-role probe scratch worktree\n");

function sanitizedEnv() {
  const credentialPattern = /API_KEY|OAUTH|TOKEN|SECRET|CREDENTIAL|PASSWORD|_PAT\b|AUTH|_KEY\b/i;
  const out = { ...process.env };
  for (const key of Object.keys(out)) if (credentialPattern.test(key)) delete out[key];
  return out;
}

function snapshotAgentDir() {
  const agentDir = path.join(os.homedir(), CONFIG_DIR_NAME, "agent");
  let entries;
  try { entries = fs.readdirSync(agentDir); } catch { return {}; }
  const snap = {};
  for (const name of entries) {
    try { snap[name] = fs.statSync(path.join(agentDir, name)).mtimeMs; } catch { snap[name] = null; }
  }
  return snap;
}
const KNOWN_LIVE_CHURN_FILES = new Set(["agent.db", "agent.db-wal", "models.db", "models.db-wal"]);
function snapshotsEqual(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) { if (KNOWN_LIVE_CHURN_FILES.has(k)) continue; if (a[k] !== b[k]) return false; }
  return true;
}

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
  return agentDir;
}

// Project command file (`.omp/commands/check-build.md`) in the scratch cwd,
// and a user command file under the isolated profile's own agent dir --
// #760 probe 1: what `source` does get_available_commands report for each?
function seedCommandFiles(agentDir) {
  const projectCommandsDir = path.join(dir("wt"), ".omp", "commands");
  fs.mkdirSync(projectCommandsDir, { recursive: true });
  fs.writeFileSync(path.join(projectCommandsDir, "check-build.md"), "---\ndescription: Run the project build check\n---\nRun the build and report pass/fail for $ARGUMENTS.\n");

  const userCommandsDir = path.join(agentDir, "commands");
  fs.mkdirSync(userCommandsDir, { recursive: true });
  fs.writeFileSync(path.join(userCommandsDir, "probe-user-cmd.md"), "---\ndescription: RM0 probe user command\n---\nThis is a probe-only user command body.\n");

  // Shadow test (#760 probe 6): a project command sharing a name with the
  // user command above, to see which source wins and what the entry reports.
  fs.writeFileSync(path.join(projectCommandsDir, "probe-user-cmd.md"), "---\ndescription: RM0 probe project command (shadow)\n---\nThis is the PROJECT copy, shadowing the user one.\n");
}

// Minimal skill so the enableSkillCommands toggle has something to list.
function seedSkillFile(agentDir) {
  const skillDir = path.join(agentDir, "skills", "probe-rm0-skill");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: probe-rm0-skill\ndescription: RM0 probe skill, never invoked for real\n---\nProbe-only skill body.\n");
}

class OmpProc {
  constructor(label, sessionDir, cwd = dir("wt")) {
    this.label = label;
    this.waiters = [];
    this.frames = [];
    this.chunks = new Map();
    this.buf = Buffer.alloc(0);
    this.n = 0;
    this.exitCode = null;
    this.log = fs.createWriteStream(path.join(dir("frames"), `${label}.jsonl`));
    this.errLog = fs.createWriteStream(path.join(dir("frames"), `${label}.stderr.log`));
    const args = ["--mode", "rpc-ui", "--approval-mode=always-ask", "--profile", PROFILE, "--session-dir", sessionDir, "--model", "probe-fake/probe-fake-model"];
    this.child = spawn(OMP, args, { cwd, stdio: "pipe", windowsHide: true, env: sanitizedEnv() });
    this.exitPromise = new Promise((resolve) => {
      this.child.on("exit", (code) => { this.exitCode = code; resolve(); });
      this.child.on("error", (e) => { console.error(`${label} spawn error: ${e.message}`); this.exitCode ??= -1; resolve(); });
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
      this.#dispatch(frame);
    }
  }

  #dispatch(frame) {
    this.log.write(JSON.stringify({ t: Date.now() - T0, dir: "in", frame }) + "\n");
    this.frames.push(frame);
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

  framesSince(markIdx) { return this.frames.slice(markIdx); }

  async ready() {
    const r = await Promise.race([
      this.waitFor((f) => f.type === "ready", { timeout: READY_MS, what: "ready frame" }).then((f) => ({ ok: true })),
      this.exitPromise.then(() => ({ ok: false })),
    ]);
    if (!r.ok) throw new Error(`[${this.label}] process exited before ready (code ${this.exitCode}); see frames/${this.label}.stderr.log`);
  }

  async close() {
    this.child.stdin.end();
    const done = await Promise.race([this.exitPromise.then(() => true), new Promise((r) => setTimeout(() => r(false), 30_000))]);
    if (!done) { try { execFileSync("taskkill", ["/PID", String(this.child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ } }
    await this.exitPromise;
  }
}

function flattenCommands(list, prefix = "") {
  const out = [];
  for (const c of list || []) {
    const name = prefix ? `${prefix} ${c.name}` : c.name;
    out.push({ name, source: c.source, description: c.description });
    if (Array.isArray(c.subcommands) && c.subcommands.length) out.push(...flattenCommands(c.subcommands, name));
  }
  return out;
}

async function assertIsolatedProfile(proc) {
  const state = await proc.request({ type: "get_state" }).catch((e) => ({ success: false, error: e.message }));
  const model = state?.data?.model;
  if (model?.provider !== "probe-fake" || model?.id !== "probe-fake-model") {
    throw new Error(`ABORT: not running against the isolated profile (get_state.model=${JSON.stringify(model)})`);
  }
}

// ---- main ----
let ompVersion = "unknown";
try { ompVersion = execFileSync(OMP, ["--version"], { encoding: "utf8" }).trim(); }
catch (e) { console.error(`omp not found; set PINION_OMP (${e.message})`); process.exit(2); }
console.log(`omp ${ompVersion} | profile ${PROFILE}\nscratch ${ROOT}\n`);

const agentDir = ensureFakeModel();
seedCommandFiles(agentDir);
seedSkillFile(agentDir);

const beforeSnap = snapshotAgentDir();
const results = { ompVersion, profile: PROFILE, scratch: ROOT };
let scriptFailed = false;

try {
  // ---- cycleOrder / modelRoles CLI round trip (isolated profile, no real creds needed) ----
  const setCycleOrder = await execFileAsync(OMP, ["--profile", PROFILE, "config", "set", "cycleOrder", '["smol","slow"]', "--json"], { env: sanitizedEnv(), windowsHide: true });
  results.cycleOrderSet = JSON.parse(setCycleOrder.stdout);
  const getCycleOrder = await execFileAsync(OMP, ["--profile", PROFILE, "config", "get", "cycleOrder", "--json"], { env: sanitizedEnv(), windowsHide: true });
  results.cycleOrderGet = JSON.parse(getCycleOrder.stdout);

  // ---- skills.enableSkillCommands toggle: does it change get_available_commands? (#760 probe 2) ----
  await execFileAsync(OMP, ["--profile", PROFILE, "config", "set", "skills.enableSkillCommands", "false", "--json"], { env: sanitizedEnv(), windowsHide: true });

  const sd1 = dir(path.join("sessions", "s1"));
  fs.mkdirSync(sd1, { recursive: true });
  const p1 = new OmpProc("p1", sd1);
  await p1.ready();
  await assertIsolatedProfile(p1);

  const cmdsOff = (await p1.request({ type: "get_available_commands" })).data?.commands ?? [];
  const flatOff = flattenCommands(cmdsOff);
  results.commandsWithSkillCommandsOff = {
    total: flatOff.length,
    hasSkillInvoke: flatOff.some((c) => c.name.startsWith("skill:")),
    projectCheckBuild: flatOff.find((c) => c.name === "check-build") ?? null,
    shadowedProbeUserCmd: flatOff.find((c) => c.name === "probe-user-cmd") ?? null,
  };

  // Native-command inventory on this isolated, credential-less profile too
  // (cheap re-check alongside the real-profile one in model-role-rpc-probe.mjs).
  const watch = ["switch", "model", "models", "plan", "new", "resume", "fork", "settings", "pause", "plan-review", "btw"];
  const byName = new Map(flatOff.map((c) => [c.name, c]));
  results.watchedCommandsIsolated = Object.fromEntries(watch.map((name) => [name, byName.has(name) ? { present: true, source: byName.get(name).source } : { present: false }]));

  // ---- config watch/reload: does an EXTERNAL modelRoles write reach this running process? (#740 probes 1 and 5) ----
  const stateBeforeRoleChange = (await p1.request({ type: "get_state" })).data;
  const framesMarkBeforeRoleChange = p1.frames.length;
  await execFileAsync(OMP, ["--profile", PROFILE, "config", "set", "modelRoles", '{"default":"probe-fake/probe-fake-model","smol":"probe-fake/probe-fake-model"}', "--json"], { env: sanitizedEnv(), windowsHide: true });
  await new Promise((r) => setTimeout(r, RELOAD_WAIT_MS)); // settings.md: "reloaded after a short debounce"
  const stateAfterRoleChange = (await p1.request({ type: "get_state" })).data;
  const framesObservedAfterRoleChange = p1.framesSince(framesMarkBeforeRoleChange).map((f) => f.type).filter((t) => t !== "response");
  results.configWatchRoleChange = {
    modelBefore: stateBeforeRoleChange.model,
    modelAfter: stateAfterRoleChange.model,
    activeSessionModelChangedByExternalRoleWrite: JSON.stringify(stateBeforeRoleChange.model) !== JSON.stringify(stateAfterRoleChange.model),
    framesObservedInWindow: framesObservedAfterRoleChange,
  };

  // Now toggle skills.enableSkillCommands ON on a FRESH process (config.yml
  // live-reload per omp://settings.md applies to subsequent reads; a fresh
  // process is the clean way to observe the startup-time effect too).
  await execFileAsync(OMP, ["--profile", PROFILE, "config", "set", "skills.enableSkillCommands", "true", "--json"], { env: sanitizedEnv(), windowsHide: true });
  await p1.close();

  const sd2 = dir(path.join("sessions", "s2"));
  fs.mkdirSync(sd2, { recursive: true });
  const p2 = new OmpProc("p2", sd2);
  await p2.ready();
  await assertIsolatedProfile(p2);
  const cmdsOn = (await p2.request({ type: "get_available_commands" })).data?.commands ?? [];
  const flatOn = flattenCommands(cmdsOn);
  results.commandsWithSkillCommandsOn = {
    total: flatOn.length,
    hasSkillInvoke: flatOn.some((c) => c.name.startsWith("skill:")),
    probeSkillEntry: flatOn.find((c) => c.name === "skill:probe-rm0-skill") ?? null,
  };

  // ---- custom command dispatch shape: recognized (not unknown-command) even though the fake model cannot actually answer (#760 probe 3, partial) ----
  const promptId = "check-build-1";
  const mark = p2.frames.length;
  p2.log.write(JSON.stringify({ t: Date.now() - T0, dir: "out", frame: { id: promptId, type: "prompt", message: "/check-build main" } }) + "\n");
  p2.child.stdin.write(JSON.stringify({ id: promptId, type: "prompt", message: "/check-build main" }) + "\n");
  const ack = await p2.waitFor((f) => f.type === "response" && f.id === promptId, { from: mark, timeout: REQUEST_MS, what: "prompt ack" });
  results.customCommandDispatch = { ackSuccess: ack.success, ackError: ack.error, agentInvoked: ack.data?.agentInvoked };
  if (ack.success && ack.data?.agentInvoked !== false) {
    const outcome = await Promise.race([
      p2.waitFor((f) => f.type === "prompt_result" && f.id === promptId, { from: mark, timeout: 30_000, what: "prompt_result" }).then((f) => ({ status: f.status, error: f.error })),
      new Promise((r) => setTimeout(() => r({ status: "timeout" }), 30_000)),
    ]);
    results.customCommandDispatch.outcome = outcome;
  }

  await p2.close();
} catch (e) {
  results.error = e.message;
  scriptFailed = true;
  console.error("probe FAILED:", e.message);
}

const afterSnap = snapshotAgentDir();
const breached = !snapshotsEqual(beforeSnap, afterSnap);
results.isolation = breached ? "BREACH" : "unchanged";

console.log(JSON.stringify(results, null, 2));
fs.writeFileSync(path.join(ROOT, "result.json"), JSON.stringify(results, null, 2));
console.log(`\nscratch dir (raw frames, unredacted): ${ROOT}`);
if (breached) { console.error("ISOLATION BREACH -- default profile top-level entries changed"); process.exit(3); }
process.exit(scriptFailed ? 1 : 0);
