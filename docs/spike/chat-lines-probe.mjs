// "Chat lines" wire-shape probe (research.md Unknowns; tasks.md T071).
//
// Question: for each of the live RPC frame shapes a chat transcript needs to
// render per request-type lines (ask-tool multiple-choice, ask-tool free
// text, cancelled ask, todo-tool updates, batch task() subagents, and
// subagent-to-parent IRC-style messages), what does the wire actually look
// like, and where does the "answer" end up in history afterwards?
//
// This uses Stuart's REAL default OMP profile (no --profile flag) because the
// scenarios need a real model to drive the ask/todo/task tools, but:
//   - `--session-dir` points at a scratch temp directory, so his actual
//     session history under ~/.omp/agent/sessions is never written to.
//   - cwd is a brand-new scratch git repo, never his real working trees.
//   - `--approval-mode=always-ask` plus a deny-everything dialog handler
//     means no tool call (bash, fs write, etc.) is ever actually executed --
//     WITH ONE DELIBERATE EXCEPTION: scenarios (e), (e_task_batch_subscribed),
//     and (f) approve the `task` tool's own "Allow tool: task" gate (see
//     `approveTaskOnly` below) so batch-subagent frame shapes can be
//     observed at all; denying it too would make those scenarios unable to
//     run. Every OTHER "Allow tool:" dialog still falls through to the
//     default deny-everything handler -- EXCEPT that a tool call a spawned
//     subagent itself makes is NOT gated at all once `task` is approved (see
//     the SAFETY NOTE below).
//   - SAFETY NOTE FOR ANYONE RERUNNING THIS SCRIPT: because `task` is
//     approved, a malicious or buggy prompt in a scenario could trigger an
//     UNGATED subagent tool call (no approval dialog stands between the
//     subagent and e.g. bash/fs write) under your real, signed-in
//     credentials. Only rerun this with the scratch, throwaway prompts
//     already in the script below -- never with untrusted or user-supplied
//     input.
//   - For scenarios (a)-(d), only the ask/todo tool's own
//     extension_ui_request (which is not an "Allow tool:" approval, it IS
//     the tool's question) gets a scenario answer.
//   - No `/login` command and no config-changing command is ever sent.
//
// This script NEVER reads, prints, or modifies anything under the default
// profile's `~/.omp/agent/` credential or session store, with ONE exception:
// a read-only scan (never a write) of existing session JSONL files under
// `~/.omp/agent/sessions` for lines containing the literal string
// `<advisory`, recording only the `role` and `customType` field values.
//
// Run:  node docs/spike/chat-lines-probe.mjs
// Env:  PINION_OMP          omp executable (default "omp" from PATH)
//       PINION_PROBE_MODEL  model id (default github-copilot/gpt-5.6-luna)
//
// Raw frames (including real prompt/response text) can contain account or
// conversation content, so they are written only to a temp scratch dir
// (printed at the end) and never into this repo. The result file below
// redacts text content to lengths/shapes only.

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const OMP = process.env.PINION_OMP || "omp";
const MODEL = process.env.PINION_PROBE_MODEL || "github-copilot/gpt-5.6-luna";
const READY_MS = 120_000;
const REQUEST_MS = 60_000;
const PROMPT_MS = 120_000;
const EXIT_MS = 30_000;

const T0 = Date.now();
const ROOT = path.join(os.tmpdir(), "pinion-chat-lines-probe", new Date().toISOString().replace(/[:.]/g, "-"));
const dir = (name) => path.join(ROOT, name);
for (const d of ["repo", "session-dir", "frames"]) {
  fs.mkdirSync(dir(d), { recursive: true });
}

// Scratch git repo cwd: never Stuart's real working trees.
try {
  execFileSync("git", ["init", "-q", "-b", "main", dir("repo")]);
  execFileSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@example.invalid", "commit", "--allow-empty", "-m", "init"], {
    cwd: dir("repo"),
  });
} catch (e) {
  console.error(`scratch repo init failed: ${e.message}`);
  process.exit(2);
}

// ---- OmpProc: copied from docs/spike/signed-in-probe.mjs's frame-reassembly
// and request() pattern, generalized with an optional per-scenario dialog
// answer override (`onDialog`) that runs BEFORE the default deny-everything
// fallback, so an ask/todo/task tool's own extension_ui_request can be
// answered with the scenario's real answer while every other "Allow tool:"
// (or any other) approval dialog still gets denied -- unless the scenario's
// own `onDialog` override approves it, as scenarios (e)/(e-subscribed)/(f)
// deliberately do for the `task` tool's own gate (see the SAFETY NOTE above).
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
    this.log = fs.createWriteStream(path.join(dir("frames"), `${label}.jsonl`));
    this.errLog = fs.createWriteStream(path.join(dir("frames"), `${label}.stderr.log`));
    const args = ["--mode", "rpc-ui", "--approval-mode=always-ask"];
    if (sessionDir) args.push("--session-dir", sessionDir);
    if (MODEL !== "none") args.push("--model", MODEL);
    this.startedAt = Date.now();
    this.child = spawn(OMP, args, { cwd, env: process.env, stdio: "pipe", windowsHide: true });
    this.exitPromise = new Promise((resolve) => {
      this.child.on("exit", (code) => {
        this.exitCode = code;
        resolve();
      });
    });
    this.child.on("error", (e) => console.error(`${label}: omp not found: ${e.message}`));
    this.child.stdout.on("data", (d) => this.#onData(d));
    this.child.stderr.on("data", (d) => this.errLog.write(d));
  }

  #record(dir_, frame, extra = {}) {
    this.log.write(JSON.stringify({ t: Date.now() - T0, dir: dir_, frame, ...extra }) + "\n");
  }

  #onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    let i;
    while ((i = this.buf.indexOf(0x0a)) >= 0) {
      const line = this.buf.subarray(0, i).toString("utf8").trim();
      this.buf = this.buf.subarray(i + 1);
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch (e) {
        this.#record("out", line, { parseError: true });
        continue;
      }
      this.#handle(frame);
    }
  }

  #handle(frame) {
    if (frame.type === "rpc_chunk") {
      let c = this.chunks.get(frame.chunkId);
      if (!c) {
        c = { parts: new Array(frame.count), got: 0, byteLength: frame.byteLength, data: "base64" };
        this.chunks.set(frame.chunkId, c);
      }
      c.parts[frame.index] = c.parts[frame.index] ?? Buffer.from(frame.data, "base64");
      c.got++;
      if (c.got !== frame.count) return;
      const whole = Buffer.concat(c.parts);
      this.chunks.delete(frame.chunkId);
      if (whole.length !== c.byteLength) {
        this.#record("out", { type: "__probe_protocol_error", error: `chunk ${frame.chunkId}: got ${whole.length} bytes, expected ${c.byteLength}` });
        return;
      }
      try {
        frame = JSON.parse(whole.toString("utf8"));
      } catch (e) {
        this.#record("out", { type: "__probe_protocol_error", error: `chunk ${frame.chunkId}: ${e.message}` });
        return;
      }
    }
    this.#dispatch(frame);
  }

  #dispatch(frame) {
    const idx = this.frames.length;
    this.frames.push({ type: frame.type, data: frame, frame, t: Date.now() - T0 });
    this.#record("in", frame);
    if (frame.type === "extension_ui_request") {
      if (this.onDialog(frame, this)) return;
      this.#answerDialog(frame);
    }
    for (const w of [...this.waiters]) {
      if (idx >= w.from && w.pred(frame)) this.waiters.splice(this.waiters.indexOf(w), 1), w.resolve(frame);
    }
  }

  #answerDialog(frame) {
    const title = frame.data?.title ?? "(omitted)";
    if (frame.method === "select" && title.startsWith("Allow tool:")) {
      this.warnings.push(`approval denied: ${title.split("\n")[0]}`);
      this.write({ type: "extension_ui_response", id: frame.id, value: "Deny" });
    } else if (frame.method === "select" || frame.method === "input" || frame.method === "editor") {
      this.warnings.push(`dialog cancelled: ${title.split("\n")[0]}`);
      this.write({ type: "extension_ui_response", id: frame.id, cancelled: true });
    } else {
      this.write({ type: "extension_ui_response", id: frame.id, cancelled: true });
    }
  }

  write(obj) {
    this.#record("out", obj);
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  async waitFor(pred, { timeout = REQUEST_MS, what } = {}) {
    const from = this.frames.length;
    for (let i = from; i < this.frames.length; i++) if (pred(this.frames[i].frame)) return this.frames[i].frame;
    return new Promise((resolve, reject) => {
      const w = { pred, from, resolve };
      const t = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`${this.label}: timeout waiting for ${what ?? "<frame>"}`));
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
      this.waitFor((f) => f.type === "ready", { timeout: READY_MS, what: "ready frame" }).then((f) => ({ ok: true, frame: f })),
      this.exitPromise.then(() => ({ ok: false })),
    ]);
    if (!r.ok) throw new Error(`process exited before ready frame (code ${this.exitCode}); see frames/${this.label}.stderr.log`);
    const readyFrame = r.frame;
    this.readyMs = Date.now() - this.startedAt;
    if (!readyFrame.supportedProtocolVersions?.includes(2)) throw new Error("negotiate_protocol failed: wrong protocol version");
    const neg = await this.request({ type: "negotiate_protocol", protocolVersion: 2 });
    if (!neg.success) throw new Error(`negotiate_protocol failed: ${neg.error}`);
    return neg;
  }

  async request(cmd, { timeout = REQUEST_MS } = {}) {
    const id = `${this.label}-${this.n++}`;
    this.write({ ...cmd, id });
    const mark = await this.waitFor((f) => f.type === "response" && f.id === id, { timeout, what: `response to ${cmd.type}` });
    return mark;
  }

  async getState() {
    return (await this.request({ type: "get_state" })).data;
  }

  async getMessages() {
    return (await this.request({ type: "get_messages" })).data;
  }

  // Sends a prompt and returns whichever terminal shape arrives first: an
  // immediate error response, a handled-locally response (agentInvoked:
  // false), or the eventual prompt_result frame (completed turn).
  async promptOnce(message) {
    const id = `${this.label}-${this.n++}`;
    this.write({ id, type: "prompt", message });
    const ack = await this.waitFor((f) => f.type === "response" && f.id === id, { timeout: REQUEST_MS, what: "prompt ack" });
    if (!ack.success) return { stage: "response", success: false, error: ack.error, code: ack.code };
    if (ack.agentInvoked === false) return { stage: "response", success: true, agentInvoked: false };
    try {
      const frame = await this.waitFor((f) => f.type === "prompt_result" && f.id === id, { timeout: PROMPT_MS, what: "prompt_result" });
      return { stage: "prompt_result", frame };
    } catch (e) {
      return { stage: "timeout", detail: e.message };
    }
  }

  n = 0;

  async closeGracefully() {
    this.child.stdin.end();
    const done = await Promise.race([this.exitPromise.then(() => true), new Promise((r) => setTimeout(() => r(false), EXIT_MS))]);
    if (!done) this.hardKill();
    return this.exitCode;
  }

  hardKill() {
    try {
      if (this.child.exitCode === null) execFileSync("taskkill", ["/PID", String(this.child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch (e) {
      /* already gone */
    }
  }

  summary() {
    return { label: this.label, readyMs: this.readyMs, exitCode: this.exitCode, warnings: this.warnings };
  }
}

// ---- redaction helpers ----
function shapeOf(v, depth = 0) {
  if (v === null || v === undefined) return v;
  if (typeof v === "string") return `string(len=${v.length})`;
  if (typeof v === "number" || typeof v === "boolean") return typeof v;
  if (Array.isArray(v)) return depth > 2 ? `array(len=${v.length})` : v.map((x) => shapeOf(x, depth + 1));
  if (typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = depth > 2 ? typeof v[k] : shapeOf(v[k], depth + 1);
    return o;
  }
  return typeof v;
}
function frameShape(f) {
  return { type: f.type, keys: Object.keys(f), shape: shapeOf(f) };
}

// ---- main ----
let ompVersion = "unknown";
try {
  ompVersion = execFileSync(OMP, ["--version"], { encoding: "utf8" }).trim();
} catch (e) {
  console.error(`omp not found; set PINION_OMP (${e.message})`);
  process.exit(2);
}
console.log(`omp ${ompVersion} | model ${MODEL}\nscratch ${ROOT}\n`);

const results = { ompVersion, model: MODEL, scratch: ROOT, scenarios: {}, advisoryScan: null };
let scriptFailed = false;

async function runScenario(name, prompt, onDialog) {
  const sessionDir = dir(`session-dir-${name}`);
  fs.mkdirSync(sessionDir, { recursive: true });
  const p = new OmpProc(name, { sessionDir, cwd: dir("repo"), onDialog });
  const scenario = { prompt, liveFrames: [], outcome: null, messages: null, state: null, error: null };
  try {
    await p.ready();
    const outcome = await p.promptOnce(prompt);
    scenario.outcome = outcome.stage === "prompt_result" ? { stage: "prompt_result", frame: frameShape(outcome.frame) } : outcome;
    scenario.liveFrames = p.frames.map((fr) => frameShape(fr.frame));
    scenario.messages = await p.getMessages();
    scenario.state = await p.getState();
  } catch (e) {
    scenario.error = e.message;
    scriptFailed = true;
  } finally {
    await p.closeGracefully();
  }
  scenario.summary = p.summary();
  results.scenarios[name] = scenario;
  return { proc: p, scenario };
}

// Shared dialog handler: when the ask-tool's own question (an
// extension_ui_request whose title does NOT start with "Allow tool:") shows
// up, answer it per-scenario; every genuine tool-approval dialog still falls
// through to the default deny-everything logic in #answerDialog.
function makeAskAnswerer(answer) {
  return (frame, proc) => {
    const title = frame.data?.title ?? frame.title ?? "";
    if (title.startsWith("Allow tool:")) return false; // let default deny handle it
    if (frame.method === "select") {
      if (answer.value !== undefined) {
        proc.write({ type: "extension_ui_response", id: frame.id, value: answer.value });
        return true;
      }
      if (answer.text !== undefined) {
        // Free-text answers surface as a select whose only/extra option opens
        // a follow-up free-text input ("Other (type your own)"); pick it so
        // the next extension_ui_request is the actual text-entry dialog.
        const other = (frame.options || []).find((o) => /^other/i.test(o));
        if (other) {
          proc.write({ type: "extension_ui_response", id: frame.id, value: other });
          return true;
        }
      }
      if (answer.cancelled) {
        proc.write({ type: "extension_ui_response", id: frame.id, cancelled: true });
        return true;
      }
      return false;
    }
    if ((frame.method === "input" || frame.method === "editor") && answer.text !== undefined) {
      proc.write({ type: "extension_ui_response", id: frame.id, value: answer.text });
      return true;
    }
    if (answer.cancelled) {
      proc.write({ type: "extension_ui_response", id: frame.id, cancelled: true });
      return true;
    }
    return false;
  };
}

(async () => {
  // (a) ask tool, multiple choice, answered A.
  await runScenario("a_ask_multiple_choice", "Use the ask tool to ask me one multiple-choice question with options A and B, then state my answer.", makeAskAnswerer({ value: "A" }));

  // (b) ask tool, free text, answered "hello".
  await runScenario("b_ask_free_text", "Use the ask tool to ask me one free-text question, then state my answer.", makeAskAnswerer({ text: "hello" }));

  // (c) ask tool, cancelled/dismissed.
  await runScenario("c_ask_cancelled", "Use the ask tool to ask me one multiple-choice question with options A and B, then state my answer.", makeAskAnswerer({ cancelled: true }));

  // (d) todo tool.
  await runScenario("d_todo", "Use the todo tool to create two tasks, mark the first one done, then reply done.", () => false);

  // Approves ONLY the task tool's own "Allow tool: task" gate (orchestration,
  // not an executor) so batch-subagent frame shapes can be observed; every
  // other "Allow tool:" dialog still falls through to the default
  // deny-everything logic -- but a tool call a spawned subagent itself makes
  // is NOT gated at all (see the SAFETY NOTE above).
  function approveTaskOnly(frame, proc) {
    const title = frame.data?.title ?? frame.title ?? "";
    if (frame.method === "select" && /^Allow tool: task\b/.test(title)) {
      proc.write({ type: "extension_ui_response", id: frame.id, value: "Approve" });
      return true;
    }
    return false;
  }

  // (e) batch task() with two subagents, default subscription, then with
  // set_subagent_subscription on if that RPC exists.
  const taskPrompt = "Use the task tool to start two subagents in one call (pass a tasks array with two entries named Alpha and Beta) that each reply only with their own name.";
  await runScenario("e_task_batch_default_subscription", taskPrompt, approveTaskOnly);

  {
    const sessionDir = dir("session-dir-e_task_batch_subscribed");
    fs.mkdirSync(sessionDir, { recursive: true });
    const p = new OmpProc("e_task_batch_subscribed", { sessionDir, cwd: dir("repo"), onDialog: approveTaskOnly });
    const scenario = { prompt: taskPrompt, liveFrames: [], outcome: null, messages: null, state: null, error: null, subscriptionRpcExists: null };
    try {
      await p.ready();
      const commandsResp = await p.request({ type: "get_available_commands" });
      const commandNames = JSON.stringify(commandsResp.data ?? {});
      scenario.subscriptionRpcExists = commandNames.includes("set_subagent_subscription");
      if (scenario.subscriptionRpcExists) {
        await p.request({ type: "set_subagent_subscription", subscribe: true }).catch((e) => {
          scenario.subscriptionRpcError = e.message;
        });
      }
      const outcome = await p.promptOnce(taskPrompt);
      scenario.outcome = outcome.stage === "prompt_result" ? { stage: "prompt_result", frame: frameShape(outcome.frame) } : outcome;
      scenario.liveFrames = p.frames.map((fr) => frameShape(fr.frame));
      scenario.messages = await p.getMessages();
      scenario.state = await p.getState();
    } catch (e) {
      scenario.error = e.message;
      scriptFailed = true;
    } finally {
      await p.closeGracefully();
    }
    scenario.summary = p.summary();
    results.scenarios["e_task_batch_subscribed"] = scenario;
  }

  // (f) subagent-to-parent IRC-style message, best effort.
  await runScenario("f_subagent_irc_message", "Start a subagent named Pinger and have it send an IRC-style message to its parent saying hi.", approveTaskOnly);
  if (!results.scenarios.f_subagent_irc_message.liveFrames.some((f) => JSON.stringify(f).toLowerCase().includes("irc"))) {
    results.scenarios.f_subagent_irc_message.note = "could not trigger: no IRC-shaped frame observed within the prompt's timeout for this prompt";
  }

  // ---- read-only <advisory scan over Stuart's REAL session store (never
  // written to; only role/customType of matching entries are recorded). ----
  try {
    const sessionsRoot = path.join(os.homedir(), ".omp", "agent", "sessions");
    const advisoryHits = [];
    if (fs.existsSync(sessionsRoot)) {
      const walk = (d) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            const text = fs.readFileSync(full, "utf8");
            for (const line of text.split("\n")) {
              if (!line.includes("<advisory")) continue;
              try {
                const obj = JSON.parse(line);
                advisoryHits.push({ role: obj.role ?? null, customType: obj.customType ?? null });
              } catch (e) {
                advisoryHits.push({ role: "(parse error)", customType: null });
              }
            }
          }
        }
      };
      walk(sessionsRoot);
    }
    results.advisoryScan = { sessionsRoot, hitCount: advisoryHits.length, hits: advisoryHits };
  } catch (e) {
    results.advisoryScan = { error: e.message };
  }

  fs.writeFileSync(path.join(ROOT, "result.json"), JSON.stringify(results, null, 2));
  console.log(`\nscratch dir (raw frames, unredacted): ${ROOT}`);
  process.exit(scriptFailed ? 1 : 0);
})();
