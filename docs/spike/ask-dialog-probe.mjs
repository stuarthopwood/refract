// Live probe (#572 Task 0): does the real `ask` extension_ui_request frame
// arrive over rpc-ui once `set_ask_dialog {enabled:true}` is sent, for a
// two-question call (one single-select with `recommended`, one multi-select)?
// This gates the whole structured-dialog build: if the frame never arrives,
// #572 ships only the fallback restyle (D18-D20).
//
// Pattern follows docs/spike/probe-batch-18.8.0.mjs (OmpProc class, scratch
// --session-dir under os.tmpdir(), real signed-in default profile, small
// model calls only, read-only / no destructive config writes).
//
// Run:  node docs/spike/ask-dialog-probe.mjs
// Env:  PINION_OMP  omp executable (default "omp" from PATH)

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const OMP = process.env.PINION_OMP || "omp";
const READY_MS = 120_000;
const REQUEST_MS = 60_000;
const ASK_FRAME_MS = 90_000;
const EXIT_MS = 30_000;

const ROOT = path.join(os.tmpdir(), "pinion-ask-dialog-probe", new Date().toISOString().replace(/[:.]/g, "-"));
for (const d of ["wt", "frames", "sessions"]) fs.mkdirSync(path.join(ROOT, d), { recursive: true });

function safeName(label) {
  return label.replace(/[^a-zA-Z0-9_-]/g, "_");
}

class OmpProc {
  constructor(label, sessionDir, extraArgs = []) {
    this.label = label;
    this.waiters = [];
    this.frames = [];
    this.buf = Buffer.alloc(0);
    this.readyMs = null;
    this.exitCode = null;
    this.exited = false;
    this.log = fs.createWriteStream(path.join(ROOT, "frames", `${safeName(label)}.jsonl`));
    this.errLog = fs.createWriteStream(path.join(ROOT, "frames", `${safeName(label)}.stderr.log`));
    const args = ["--mode", "rpc-ui", "--approval-mode=yolo", "--session-dir", sessionDir, ...extraArgs];
    this.startedAt = Date.now();
    this.child = spawn(OMP, args, { cwd: path.join(ROOT, "wt"), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.exitPromise = new Promise((resolve) => {
      this.child.on("exit", (code) => { this.exited = true; this.exitCode = code ?? -1; resolve(code); });
      this.child.on("error", (e) => { console.error(`[${label}] spawn not found: ${e.message}`); this.exited = true; this.exitCode = -1; resolve(-1); });
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
      try { frame = JSON.parse(line); } catch (e) { continue; }
      this.#handle(frame);
    }
  }
  #handle(frame) {
    if (frame.type === "rpc_chunk") {
      let c = this.chunks?.get(frame.chunkId);
      if (!c) { c = { parts: new Array(frame.count), got: 0 }; this.chunks ??= new Map(); this.chunks.set(frame.chunkId, c); }
      c.parts[frame.index] = Buffer.from(frame.data, "base64");
      c.got++;
      if (c.got === frame.count) {
        const whole = Buffer.concat(c.parts).toString("utf8");
        this.chunks.delete(frame.chunkId);
        try { this.#dispatch(JSON.parse(whole)); } catch (e) { }
      }
      return;
    }
    this.#dispatch(frame);
  }
  #dispatch(frame) {
    this.log.write(JSON.stringify(frame) + "\n");
    this.frames.push(frame);
    if (frame.type === "ready") this.readyMs = Date.now() - this.startedAt;
    for (let idx = this.waiters.length - 1; idx >= 0; idx--) {
      const w = this.waiters[idx];
      if (w.pred(frame)) { this.waiters.splice(idx, 1); w.resolve(frame); }
    }
  }
  waitFor(pred, timeoutMs, what) {
    for (const f of this.frames) if (pred(f)) return Promise.resolve(f);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); reject(new Error(`timeout after ${timeoutMs}ms waiting for ${what}`)); }, timeoutMs);
      const w = { pred, resolve: (f) => { clearTimeout(t); resolve(f); }, timeout: t };
      this.waiters.push(w);
    });
  }
  async ready() {
    const r = await Promise.race([this.waitFor((f) => f.type === "ready", READY_MS, "ready frame"), this.exitPromise.then((c) => ({ ok: false, exitCode: c }))]);
    if (r && r.ok === false) throw new Error(`process exited before ready (code ${r.exitCode}); see frames/${safeName(this.label)}.stderr.log`);
    return r;
  }
  async send(cmd, timeoutMs = REQUEST_MS) {
    this.log.write(JSON.stringify({ _sent: cmd }) + "\n");
    this.child.stdin.write(JSON.stringify(cmd) + "\n");
    return this.waitFor((f) => f.type === "response" && f.id === cmd.id, timeoutMs, `response to ${cmd.type}`);
  }
  raw(obj) {
    this.log.write(JSON.stringify({ _sent: obj }) + "\n");
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }
  async closeGracefully() {
    this.child.stdin.end();
    const done = await Promise.race([this.exitPromise.then(() => true), new Promise((r) => setTimeout(() => r(false), EXIT_MS))]);
    if (!done) { try { execFileSync("taskkill", ["/PID", String(this.child.pid), "/T", "/F"]); } catch (e) { } }
  }
}

let ompVersion = "unknown";
try { ompVersion = execFileSync(OMP, ["--version"], { encoding: "utf8" }).trim(); }
catch (e) { console.error(`omp not found; set PINION_OMP (${e.message})`); process.exit(2); }
console.log(`omp ${ompVersion}\nscratch ${ROOT}\n`);

const results = { ompVersion, scratchRoot: ROOT, probe: "ask-dialog-572" };
let failed = false;
let proc;
try {
  proc = new OmpProc("askProbe", path.join(ROOT, "sessions"));
  await proc.ready();
  console.log(`ready in ${proc.readyMs}ms`);

  const enable = await proc.send({ id: "r1", type: "set_ask_dialog", enabled: true });
  results.setAskDialog = { success: enable.success, data: enable.data, error: enable.error };
  console.log("set_ask_dialog:", JSON.stringify(results.setAskDialog));
  if (!enable.success) {
    results.verdict = "set_ask_dialog command failed outright; fallback-only build confirmed necessary.";
    throw new Error("set_ask_dialog failed");
  }

  const p1 = await proc.send({
    id: "r2",
    type: "prompt",
    message:
      'Call the ask tool exactly once with these two questions and nothing else: ' +
      '(1) id "db", question "Which database?", header "Database", options [{label:"Postgres", description:"Relational"}, {label:"SQLite", description:"Embedded"}], recommended 1 (SQLite). ' +
      '(2) id "features", question "Which features?", header "Features", multi true, options [{label:"Auth"}, {label:"Billing"}, {label:"Search"}]. ' +
      "Do not call any other tool first.",
  });
  results.promptAck = { success: p1.success, agentInvoked: p1.data?.agentInvoked };
  console.log("prompt ack:", JSON.stringify(results.promptAck));

  let askFrame = null;
  try {
    askFrame = await proc.waitFor((f) => f.type === "extension_ui_request" && f.method === "ask", ASK_FRAME_MS, "extension_ui_request method=ask");
    results.askFrame = { received: true, id: askFrame.id, questions: askFrame.questions, timeout: askFrame.timeout };
    console.log("ASK FRAME RECEIVED:", JSON.stringify(askFrame));
  } catch (e) {
    results.askFrame = { received: false, error: e.message };
    console.log("ASK FRAME NOT RECEIVED:", e.message);
  }

  if (askFrame) {
    proc.raw({
      type: "extension_ui_response",
      id: askFrame.id,
      answers: [
        { id: "db", selectedOptions: [], customInput: "DuckDB" },
        { id: "features", selectedOptions: ["Auth", "Search"] },
      ],
    });
    try {
      const pr = await proc.waitFor((f) => f.type === "prompt_result" && f.id === "r2", REQUEST_MS, "prompt_result r2");
      results.promptResult = { status: pr.status, agentInvoked: pr.agentInvoked };
    } catch (e) {
      results.promptResult = { error: e.message };
    }
    const lastAssistant = await proc.send({ id: "r3", type: "get_last_assistant_text" });
    results.lastAssistantText = lastAssistant.data;
    results.verdict = "ask frame arrived live and the extension_ui_response round trip completed the tool call; build the structured dialog path.";
  } else {
    results.verdict = "ask frame never arrived; build only the fallback restyle (D18-D20).";
  }
} catch (e) {
  failed = true;
  results.error = e.message;
} finally {
  if (proc) {
    await proc.closeGracefully();
  }
}

fs.writeFileSync(path.join(ROOT, "result.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
console.log(`\nscratch dir (raw frames, unredacted; left on disk, not deleted): ${ROOT}`);
process.exit(failed && !results.askFrame ? 1 : 0);
