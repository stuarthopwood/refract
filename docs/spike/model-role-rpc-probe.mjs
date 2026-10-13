// RM0 probe (issues #454, #740, #741, #762): what `set_model` and `cycle_model`
// record and persist in the Session file, what role they record, whether a
// mid-turn `set_model` corrupts the turn, and what a resumed Session restores
// with and without an explicit model override on `open_session`.
//
// Questions answered:
//   1. `set_model` mid-turn: does the turn survive, and does the new model
//      actually serve the rest of it (re-check against #454's open question
//      and FINDINGS item 49d, reconfirmed on the currently-installed version)?
//   2. What does a `model_change` Session-file entry look like after a plain
//      `set_model` call -- is `role` present or omitted (#741 probe (b))?
//   3. What does `cycle_model` actually cycle through -- `cycleOrder`'s
//      configured chat ROLES (`omp://settings.md`), or raw catalog models --
//      and what role does each step's `model_change` entry record (#741
//      probe (c), #762 probe 1)?
//   4. Does `cycle_model`'s own RPC response carry a `role` field, or only
//      the resolved `Model` (#762 probe 1)?
//   5. On `open_session` WITHOUT an explicit model, does the saved model
//      restore (`--continue` semantics, #740 probe 3)? WITH an explicit
//      `provider`/`modelId` different from the saved one, does it override,
//      and what role does the resulting new `model_change` entry carry
//      (#740 probes 3 and 6)?
//   6. `get_available_commands`: does `switch` exist as a distinct OMP
//      command, and are `model`/`models` present with a `source` field, on
//      the currently-installed version (#762's "is /switch already an OMP
//      command" question, re-verified past the 18.8.0 FINDINGS pass)? Is
//      `plan` (and the rest of the previously-recorded ABSENT list) still
//      absent, re-confirming the FINDINGS item 49k/C2 note that no RPC route
//      into plan mode exists (#766 probe 4)?
//
// This uses Stuart's REAL default OMP profile (no --profile flag), matching
// docs/spike/get-state-model-probe.mjs / model-role-probe.mjs / chat-lines-probe.mjs:
// a real model is needed to drive `set_model`/`cycle_model`/resume against real
// catalog entries, but:
//   - `--session-dir` points at a scratch temp directory; his actual session
//     history under ~/.omp/agent/sessions is never written to.
//   - cwd is a brand-new scratch directory, never a real working tree.
//   - No config-changing command is ever sent (`set_model`/`cycle_model` are
//     Session-scoped RPC calls that do not touch `modelRoles` or any other
//     persisted global/project config -- see omp://models.md: "The
//     session-only model picker changes the active model without rewriting
//     role assignments").
//   - Model spend: two single-word-reply tiny prompts (one to get a turn to
//     interrupt mid-stream, one none else). Everything else is RPC
//     bookkeeping (get_state, set_model, cycle_model, open_session), which
//     cost no model tokens on their own.
//
// Raw frames and the real model ids chosen can be personal, so they are
// written only to a temp scratch dir (printed at the end), never this repo.
// Console/FINDINGS output keeps real model ids (this project already records
// them elsewhere, e.g. FINDINGS items 48-50), but nothing session-content-shaped.
//
// Run:  node docs/spike/model-role-rpc-probe.mjs
// Env:  PINION_OMP  omp executable (default "omp" from PATH)

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const OMP = process.env.PINION_OMP || "omp";
const READY_MS = 120_000;
const REQUEST_MS = 60_000;
const TURN_MS = 60_000;
const EXIT_MS = 30_000;

const T0 = Date.now();
const ROOT = path.join(os.tmpdir(), "pinion-model-role-rpc-probe", new Date().toISOString().replace(/[:.]/g, "-"));
const dir = (name) => path.join(ROOT, name);
for (const d of ["wt", "frames", "sessions"]) {
  fs.mkdirSync(dir(d), { recursive: true });
}
fs.writeFileSync(path.join(dir("wt"), "README.md"), "model-role-rpc probe scratch worktree\n");

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
    const args = ["--mode", "rpc-ui", "--approval-mode=always-ask", "--session-dir", sessionDir, ...extraArgs];
    this.child = spawn(OMP, args, { cwd: dir("wt"), stdio: "pipe", windowsHide: true });
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

function flattenCommands(list, prefix = "") {
  const out = [];
  for (const c of list || []) {
    const name = prefix ? `${prefix} ${c.name}` : c.name;
    out.push({ name, source: c.source, aliases: c.aliases });
    if (Array.isArray(c.subcommands) && c.subcommands.length) out.push(...flattenCommands(c.subcommands, name));
  }
  return out;
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

// ---- main ----
let ompVersion = "unknown";
try { ompVersion = execFileSync(OMP, ["--version"], { encoding: "utf8" }).trim(); }
catch (e) { console.error(`omp not found; set PINION_OMP (${e.message})`); process.exit(2); }
console.log(`omp ${ompVersion}\nscratch ${ROOT}\n`);

const results = { ompVersion, scratch: ROOT };
let scriptFailed = false;

try {
  const sd1 = dir(path.join("sessions", "s1"));
  fs.mkdirSync(sd1, { recursive: true });
  const p1 = new OmpProc("p1", sd1);
  await p1.ready();

  // ---- get_available_commands: reserved/native-command inventory ----
  const cmdsResp = await p1.request({ type: "get_available_commands" });
  const allCmds = flattenCommands(cmdsResp.data?.commands ?? []);
  const byName = new Map(allCmds.map((c) => [c.name, c]));
  const watch = ["switch", "model", "models", "plan", "new", "resume", "fork", "settings", "pause", "plan-review", "btw"];
  results.availableCommandsCount = allCmds.length;
  results.watchedCommands = Object.fromEntries(
    watch.map((name) => [name, byName.has(name) ? { present: true, source: byName.get(name).source, aliases: byName.get(name).aliases } : { present: false }])
  );

  // ---- baseline model ----
  const state0 = (await p1.request({ type: "get_state" })).data;
  const modelA = state0.model;
  results.baselineModel = modelA;

  const modelsResp = await p1.request({ type: "get_available_models" });
  const catalog = modelsResp.data?.models ?? [];
  const otherModel = catalog.find((m) => !(m.provider === modelA.provider && m.id === modelA.id));
  const thirdModel = catalog.find((m) => otherModel && !(m.provider === otherModel.provider && m.id === otherModel.id) && !(m.provider === modelA.provider && m.id === modelA.id));
  results.catalogSize = catalog.length;
  results.pickedModels = { modelA, otherModel: otherModel ? { provider: otherModel.provider, id: otherModel.id } : null, thirdModel: thirdModel ? { provider: thirdModel.provider, id: thirdModel.id } : null };

  if (!otherModel) throw new Error("catalog has no second distinct model to switch to -- cannot probe set_model");

  // ---- mid-turn set_model safety reconfirm (#454 open question) ----
  const turnId = "turn-1";
  const promptResultPromise = p1.waitFor((f) => f.type === "prompt_result" && f.id === turnId, { timeout: TURN_MS, what: "prompt_result" });
  p1.log.write(JSON.stringify({ t: Date.now() - T0, dir: "out", frame: { id: turnId, type: "prompt", message: "Count slowly from one to five, one number per line." } }) + "\n");
  p1.child.stdin.write(JSON.stringify({ id: turnId, type: "prompt", message: "Count slowly from one to five, one number per line." }) + "\n");
  await new Promise((r) => setTimeout(r, 1500)); // let streaming start
  const midTurnSetModel = await p1.request({ type: "set_model", provider: otherModel.provider, modelId: otherModel.id });
  results.midTurnSetModel = { success: midTurnSetModel.success, error: midTurnSetModel.error, returnedModel: midTurnSetModel.data ? { provider: midTurnSetModel.data.provider, id: midTurnSetModel.data.id } : null };
  const promptResult = await promptResultPromise.catch((e) => ({ status: "timeout", detail: e.message }));
  results.midTurnPromptResult = { status: promptResult.status, error: promptResult.error };
  const stateAfterMidTurn = (await p1.request({ type: "get_state" })).data;
  results.modelAfterMidTurnSwitch = stateAfterMidTurn.model;

  // ---- plain set_model: what does the Session-file model_change entry look like? ----
  const beforeEntries = readModelChangeEntries(stateAfterMidTurn.sessionFile).length;
  const setModelResp = await p1.request({ type: "set_model", provider: modelA.provider, modelId: modelA.id });
  results.plainSetModelResponseKeys = Object.keys(setModelResp.data ?? {}).sort();
  await new Promise((r) => setTimeout(r, 500)); // let the append land
  const entriesAfterPlainSet = readModelChangeEntries(stateAfterMidTurn.sessionFile);
  results.plainSetModelNewEntry = entriesAfterPlainSet[entriesAfterPlainSet.length - 1] ?? null;
  results.plainSetModelEntryCountDelta = entriesAfterPlainSet.length - beforeEntries;

  // ---- cycleOrder config (read-only, real profile -- safe, matches FINDINGS item 49j convention) ----
  try {
    const cycleOrderRaw = execFileSync(OMP, ["config", "get", "cycleOrder", "--json"], { encoding: "utf8" });
    results.cycleOrderConfig = JSON.parse(cycleOrderRaw);
  } catch (e) {
    results.cycleOrderConfig = { error: e.message };
  }

  // ---- cycle_model x3: response shape + resulting model_change.role sequence ----
  results.cycleModelSteps = [];
  for (let i = 0; i < 3; i++) {
    const before = readModelChangeEntries(stateAfterMidTurn.sessionFile).length;
    const resp = await p1.request({ type: "cycle_model" });
    await new Promise((r) => setTimeout(r, 500));
    const entries = readModelChangeEntries(stateAfterMidTurn.sessionFile);
    const newEntry = entries.length > before ? entries[entries.length - 1] : null;
    results.cycleModelSteps.push({
      success: resp.success,
      responseKeys: Object.keys(resp.data ?? {}).sort(),
      responseModel: resp.data?.model ? { provider: resp.data.model.provider, id: resp.data.model.id } : (resp.data ? { provider: resp.data.provider, id: resp.data.id } : null),
      responseRole: resp.data?.role ?? "<absent>",
      sessionFileNewEntryAppended: newEntry !== null,
      sessionFileEntryRole: newEntry ? (newEntry.role ?? "<absent, defaults to default>") : null,
      sessionFileEntryModel: newEntry ? newEntry.model : null,
    });
  }

  const stateBeforeClose = (await p1.request({ type: "get_state" })).data;
  const lastSavedModel = stateBeforeClose.model;
  results.modelBeforeClose = lastSavedModel;
  const sessionFile = stateBeforeClose.sessionFile;

  await p1.closeGracefully();

  // ---- resume WITHOUT override: does the saved model restore? (#740 probe 3) ----
  const sd2 = dir(path.join("sessions", "s2-throwaway"));
  fs.mkdirSync(sd2, { recursive: true });
  const p2 = new OmpProc("p2", sd2);
  await p2.ready();
  const openResp1 = await p2.request({ type: "open_session", sessionDir: sd1 });
  results.resumeWithoutOverride = { success: openResp1.success, resumed: openResp1.data?.resumed, error: openResp1.error };
  const stateResumed = (await p2.request({ type: "get_state" })).data;
  results.resumeWithoutOverrideModel = stateResumed.model;
  results.resumeRestoredSavedModel = stateResumed.model?.provider === lastSavedModel.provider && stateResumed.model?.id === lastSavedModel.id;

  // ---- resume WITH explicit override back to modelA: does it replace the saved model, and what role does the new entry record? (#740 probes 3 and 6) ----
  const entriesBeforeOverride = readModelChangeEntries(sessionFile).length;
  const openResp2 = await p2.request({ type: "open_session", sessionDir: sd1, provider: modelA.provider, modelId: modelA.id });
  results.resumeWithOverride = { success: openResp2.success, resumed: openResp2.data?.resumed, error: openResp2.error };
  const stateOverridden = (await p2.request({ type: "get_state" })).data;
  results.resumeWithOverrideModel = stateOverridden.model;
  results.resumeOverrideApplied = stateOverridden.model?.provider === modelA.provider && stateOverridden.model?.id === modelA.id;
  await new Promise((r) => setTimeout(r, 500));
  const entriesAfterOverride = readModelChangeEntries(sessionFile);
  results.resumeOverrideNewEntryAppended = entriesAfterOverride.length > entriesBeforeOverride;
  results.resumeOverrideNewEntry = entriesAfterOverride.length > entriesBeforeOverride ? entriesAfterOverride[entriesAfterOverride.length - 1] : null;

  await p2.closeGracefully();
} catch (e) {
  results.error = e.message;
  scriptFailed = true;
  console.error("probe FAILED:", e.message);
}

console.log(JSON.stringify(results, null, 2));
fs.writeFileSync(path.join(ROOT, "result.json"), JSON.stringify(results, null, 2));
console.log(`\nscratch dir (raw frames, unredacted): ${ROOT}`);
process.exit(scriptFailed ? 1 : 0);
