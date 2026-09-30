// Edit/write tool result-shape probe (specs/001-core-session-workspace/contracts/omp-usage.md,
// "Tool row fields" section, T006).
//
// Question: when the agent calls the `edit` tool then the `write` tool, does OMP's
// `tool_execution_end` frame (or the later toolResult message) carry a unified diff or
// before/after text anywhere, or must Pinion build the diff itself from the call args
// (and if so, is `git diff` in the worktree after the call a reliable fallback)?
//
// Run:  node docs/spike/edit-diff-probe.mjs
// Env:  PINION_OMP          omp executable (default "omp" from PATH)
//       PINION_PROBE_MODEL  model id (default github-copilot/gpt-5.6-luna; "none" = no --model)
//
// The scratch git repo and raw frame logs are not personal (the file content is a fixed
// three-line test fixture), so nothing is redacted; everything is written under a temp
// scratch dir (printed at the end) and never into this repo. The scratch dir is left in
// place afterwards as evidence, same convention as resume-probe.mjs.

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const OMP = process.env.PINION_OMP || "omp";
const MODEL = process.env.PINION_PROBE_MODEL || "github-copilot/gpt-5.6-luna";
const READY_MS = 120_000;
const TURN_MS = 180_000;
const REQUEST_MS = 60_000;
const EXIT_MS = 30_000;

const T0 = Date.now();
const ROOT = path.join(os.tmpdir(), "pinion-edit-diff-probe", new Date().toISOString().replace(/[:.]/g, "-"));
const dir = (name) => path.join(ROOT, name);
for (const d of ["repo", "sessions", "frames"]) fs.mkdirSync(dir(d), { recursive: true });

const git = (args) => execFileSync("git", args, { cwd: dir("repo"), encoding: "utf8" });

// ---- scratch git repo: git init + one commit containing a small text file ----
const NOTES_BEFORE = "line one\nline two\nline three\n";
fs.writeFileSync(path.join(dir("repo"), "notes.txt"), NOTES_BEFORE);
git(["init", "-q"]);
git(["config", "user.email", "probe@pinion.local"]);
git(["config", "user.name", "Pinion probe"]);
git(["add", "notes.txt"]);
git(["commit", "-q", "-m", "seed notes.txt"]);

const PROMPT =
  "First, use the read tool to read notes.txt. Then, using the edit tool, change the line " +
  "\"line two\" to \"line TWO EDITED\" in notes.txt. Then, using the write tool, create a new " +
  "file named second.txt with exactly this content: \"created by write tool\\n\". Make exactly " +
  "those three tool calls now; do not explain, do not read any other files, do not run any " +
  "other tools.";
class OmpProc {
  constructor(label, sessionDir, cwd) {
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
      "--approval-mode=yolo",
      ...(MODEL === "none" ? [] : ["--model", MODEL]),
      "--session-dir", sessionDir,
    ];
    this.startedAt = Date.now();
    this.child = spawn(OMP, args, { cwd, stdio: "pipe", windowsHide: true });
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

  // Yolo mode should auto-approve edit/write (they are not `exec`), so no "Allow tool:"
  // dialog is expected here. Approve one anyway if it appears, so the tool call still runs
  // and we can observe its result shape; cancel anything else (there is no reason for this
  // tiny turn to ask a question).
  #answerDialog(f) {
    const title = String(f.title ?? "");
    if (f.method === "select" && title.startsWith("Allow tool:")) {
      this.warnings.push(`approval dialog seen under yolo mode, approved: ${title.split("\n")[0]}`);
      this.write({ type: "extension_ui_response", id: f.id, value: "Approve" });
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

  async ready() {
    await this.waitFor((f) => f.type === "ready", 0, READY_MS, "ready frame").then((f) => { this.readyFrame = f; });
    this.readyMs = Date.now() - this.startedAt;
    if (this.readyFrame.supportedProtocolVersions?.includes(2)) {
      const r = await this.request({ type: "negotiate_protocol", protocolVersion: 2 });
      if (!r.success) throw new Error(`negotiate_protocol failed: ${r.error}`);
    }
  }

  async request(cmd, timeout = REQUEST_MS) {
    const id = `${this.label}-${++this.n}`;
    const mark = this.frames.length;
    this.write({ id, ...cmd });
    return this.waitFor((f) => f.type === "response" && f.id === id, mark, timeout, `response to ${cmd.type}`);
  }

  async turn(message) {
    const id = `${this.label}-${++this.n}`;
    const mark = this.frames.length;
    this.write({ id, type: "prompt", message });
    const ack = await this.waitFor((f) => f.type === "response" && f.id === id, mark, REQUEST_MS, "prompt ack");
    if (!ack.success) throw new Error(`prompt rejected: ${ack.error}`);
    if (ack.data?.agentInvoked === false) throw new Error("prompt was handled locally (agentInvoked:false)");
    const res = await this.waitFor((f) => f.type === "prompt_result" && f.id === id, mark, TURN_MS, "prompt_result");
    if (res.status !== "completed") throw new Error(`turn status ${res.status}: ${JSON.stringify(res.error ?? {})}`);
    if (res.sessionSettled !== true) {
      await this.waitFor((f) => f.type === "session_settled", mark, TURN_MS, "session_settled");
    }
    return mark;
  }

  async getMessages() { return (await this.request({ type: "get_messages" })).data.messages; }

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

// ---- main ----
let ompVersion = "unknown";
try { ompVersion = execFileSync(OMP, ["--version"], { encoding: "utf8" }).trim(); }
catch (e) { console.error(`omp not found; set PINION_OMP (${e.message})`); process.exit(2); }
if (!ompVersion.includes("18.4.4")) console.log("WARN: FINDINGS were recorded on omp 18.4.4");
console.log(`omp ${ompVersion} | model ${MODEL}\nscratch ${ROOT}\n`);

const result = { ompVersion, model: MODEL, scratch: ROOT, toolFrames: {}, gitDiffAfter: null, verdict: null };
let exitCode = 1;
const p = new OmpProc("edit-diff", dir("sessions"), dir("repo"));
try {
  await p.ready();
  const mark = await p.turn(PROMPT);

  // Pull every tool_execution_* frame emitted from the turn onward, plus any message frame
  // carrying a toolResult part (message_update / message_end).
  const toolFrames = p.frames.slice(mark).filter((f) =>
    f.type === "tool_execution_start" || f.type === "tool_execution_update" || f.type === "tool_execution_end");
  const messageFrames = p.frames.slice(mark).filter((f) =>
    (f.type === "message_update" || f.type === "message_end") &&
    JSON.stringify(f).includes("toolResult"));

  console.log(`captured ${toolFrames.length} tool_execution_* frames, ${messageFrames.length} message frames with a toolResult part`);
  for (const f of toolFrames) {
    console.log(`  ${f.type}  toolName=${f.toolName ?? "?"}  toolCallId=${f.toolCallId ?? "?"}`);
  }

  // Group tool_execution_start/end pairs by toolCallId so each tool call's args and result
  // are recorded together.
  const byCallId = new Map();
  for (const f of toolFrames) {
    const id = f.toolCallId;
    if (!id) continue;
    if (!byCallId.has(id)) byCallId.set(id, { toolCallId: id, toolName: f.toolName, start: null, updates: [], end: null });
    const entry = byCallId.get(id);
    if (f.type === "tool_execution_start") { entry.start = f; entry.toolName ??= f.toolName; }
    else if (f.type === "tool_execution_update") entry.updates.push(f);
    else if (f.type === "tool_execution_end") entry.end = f;
  }
  result.toolCalls = [...byCallId.values()];
  result.toolFrames.raw = toolFrames;
  result.messageFramesWithToolResult = messageFrames;

  // Disk-level verification: did the two tool calls actually take effect?
  const notesAfter = fs.readFileSync(path.join(dir("repo"), "notes.txt"), "utf8");
  const secondPath = path.join(dir("repo"), "second.txt");
  const secondExists = fs.existsSync(secondPath);
  const secondAfter = secondExists ? fs.readFileSync(secondPath, "utf8") : null;
  result.disk = { notesAfter, secondExists, secondAfter };
  console.log(`\nnotes.txt after: ${JSON.stringify(notesAfter)}`);
  console.log(`second.txt exists: ${secondExists}  content: ${JSON.stringify(secondAfter)}`);

  // git diff in the worktree after the call: candidate fallback diff source.
  git(["add", "-A"]);
  result.gitDiffAfter = git(["diff", "--cached"]);
  console.log(`\ngit diff --cached after the turn:\n${result.gitDiffAfter}`);

  // Does any captured frame contain a unified diff (a line starting with "@@" or "+++"/"---")
  // or an explicit before/after text pair, anywhere in its JSON?
  const allCaptured = JSON.stringify({ toolCalls: result.toolCalls, messageFramesWithToolResult: messageFrames });
  const hasUnifiedDiffMarker = /@@ |\\n\+\+\+ |\\n--- /.test(allCaptured);
  result.hasUnifiedDiffMarker = hasUnifiedDiffMarker;

  const messages = await p.getMessages();
  result.messagesTail = messages.slice(-6);

  exitCode = 0;
} catch (e) {
  result.error = e.message;
  console.error(`probe error: ${e.message}`);
} finally {
  await p.closeGracefully();
  result.process = p.summary();
}

fs.writeFileSync(path.join(ROOT, "result.json"), JSON.stringify(result, null, 2));
console.log(`\nwrote ${path.join(ROOT, "result.json")}`);
console.log(`exit ${exitCode}`);
process.exit(exitCode);
