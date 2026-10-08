// get_messages_page probe (docs/spike/FINDINGS.md, probe batch item 13, PLAN.md row A0 slice 4).
//
// Question: does omp's rpc-ui RPC surface expose a `get_messages_page` request at all, and if
// so what parameters does it take and what shape does it return? Constitution IV: this MUST be
// probed against a real binary before `get_messages_page` is used in src/main -- it is not
// referenced anywhere in contracts/omp-usage.md or any prior probe script.
//
// Run:  node docs/spike/get-messages-page-probe.mjs
// Env:  PINION_OMP          omp executable (default "omp" from PATH)
//       PINION_PROBE_MODEL  model id (default github-copilot/gpt-5.6-luna; "none" = no --model)
//
// Raw frames may contain personal skill names, so they are written to a temp scratch dir
// (printed at the end) and never into this repo.

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OMP = process.env.PINION_OMP || "omp";
const MODEL = process.env.PINION_PROBE_MODEL || "github-copilot/gpt-5.6-luna";
const READY_MS = 120_000;
const TURN_MS = 180_000;
const REQUEST_MS = 60_000;
const EXIT_MS = 30_000;

const T0 = Date.now();
const ROOT = path.join(os.tmpdir(), "pinion-get-messages-page-probe", new Date().toISOString().replace(/[:.]/g, "-"));
const dir = (name) => path.join(ROOT, name);
for (const d of ["wt", "sessions", "frames"]) fs.mkdirSync(dir(d), { recursive: true });
fs.writeFileSync(path.join(dir("wt"), "README.md"), "get_messages_page probe worktree\n");

class OmpProc {
  constructor(label, sessionDir, extra = [], cwd = dir("wt")) {
    this.label = label;
    this.frames = [];
    this.waiters = [];
    this.buf = Buffer.alloc(0);
    this.n = 0;
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
    this.child = spawn(OMP, args, { cwd, stdio: "pipe", windowsHide: true });
    this.exitPromise = new Promise((resolve) => {
      this.child.on("exit", (code) => { this.exited = true; this.exitCode ??= code; resolve(); });
    });
    this.child.on("error", (e) => { console.error(`omp not found; set PINION_OMP (${e.message})`); process.exit(2); });
    this.child.stdout.on("data", (d) => this.#onData(d));
    this.child.stderr.on("data", (d) => this.errLog.write(d));
  }

  #record(dirn, frame) { this.log.write(JSON.stringify({ t: Date.now() - T0, dir: dirn, frame }) + "\n"); }

  #onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
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
      this.write({ type: "extension_ui_response", id: f.id, value: "Deny" });
    } else if (["select", "confirm", "input", "editor"].includes(f.method)) {
      this.write({ type: "extension_ui_response", id: f.id, cancelled: true });
    }
  }

  write(obj) { this.#record("in", obj); this.child.stdin.write(JSON.stringify(obj) + "\n"); }

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
    const res = await this.waitFor((f) => f.type === "prompt_result", mark, TURN_MS, "prompt_result");
    if (res.status !== "completed") throw new Error(`turn status ${res.status}: ${JSON.stringify(res.error ?? {})}`);
    if (res.sessionSettled !== true) {
      await this.waitFor((f) => f.type === "session_settled", mark, TURN_MS, "session_settled");
    }
  }

  async getState() { return (await this.request({ type: "get_state" })).data; }
  async getMessages() { return await this.request({ type: "get_messages" }); }
  async getMessagesPage(extra) { return await this.request({ type: "get_messages_page", ...extra }); }

  async closeGracefully() {
    this.child.stdin.end();
    const done = await Promise.race([this.exitPromise.then(() => true), new Promise((r) => setTimeout(() => r(false), EXIT_MS))]);
    if (!done) await this.hardKill();
  }

  async hardKill() {
    if (!this.exited) {
      try { execFileSync("taskkill", ["/PID", String(this.child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { }
      await Promise.race([this.exitPromise, new Promise((r) => setTimeout(r, EXIT_MS))]);
    }
  }
}

let ompVersion = "unknown";
try { ompVersion = execFileSync(OMP, ["--version"], { encoding: "utf8" }).trim(); }
catch (e) { console.error(`omp not found; set PINION_OMP (${e.message})`); process.exit(2); }
console.log(`omp ${ompVersion} | model ${MODEL}\nscratch ${ROOT}\n`);

let exitCode = 1;
try {
  const p = new OmpProc("A", dir("sessions"));
  console.log("spawning and waiting for ready...");
  await p.ready();
  console.log(`ready in use (protocol negotiated)`);

  console.log("sending two short no-tool turns to build up message history...");
  await p.turn("Do not use any tools. Reply with exactly: ONE");
  await p.turn("Do not use any tools. Reply with exactly: TWO");

  const state = await p.getState();
  console.log(`get_state: messageCount=${state.messageCount}, sessionFile=${state.sessionFile}`);

  const full = await p.getMessages();
  console.log(`\nget_messages: success=${full.success} data keys=${full.data ? Object.keys(full.data).join(",") : "n/a"} message count=${full.data?.messages?.length}`);

  // Try a handful of plausible parameter shapes for get_messages_page.
  const attempts = [
    {},
    { limit: 1 },
    { limit: 1, offset: 0 },
    { pageSize: 1 },
    { before: null, limit: 1 },
    { cursor: null, limit: 1 },
    { fromEnd: true, limit: 1 },
  ];
  for (const extra of attempts) {
    const r = await p.getMessagesPage(extra);
    console.log(`\nget_messages_page(${JSON.stringify(extra)}):`);
    console.log(JSON.stringify(r, null, 2).slice(0, 2000));
  }

  await p.closeGracefully();
  exitCode = 0;
} catch (e) {
  console.error(`probe aborted: ${e.message}`);
} finally {
  console.log(`\nscratch dir (frames, logs): ${ROOT}`);
  process.exit(exitCode);
}
