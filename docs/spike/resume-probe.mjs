// RPC resume-after-restart probe (docs/spike/FINDINGS.md, row C16, RPC column).
//
// Question: can a FRESH `omp --mode rpc-ui` process reattach a session written by a
// process that was killed? Three mechanisms are tried against isolated copies of the
// same seed session:
//   A  switch_session { sessionPath } in a running fresh process
//   B  --resume <file> at spawn
//   C  open_session { sessionDir } in a pre-spawned process
//
// Run:  node docs/spike/resume-probe.mjs
// Env:  PINION_OMP          omp executable (default "omp" from PATH)
//       PINION_PROBE_MODEL  model id (default github-copilot/gpt-5.6-luna; "none" = no --model)
//
// Raw frames contain personal skill names, so they are written to a temp scratch dir
// (printed at the end) and never into this repo.

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const OMP = process.env.PINION_OMP || "omp";
const MODEL = process.env.PINION_PROBE_MODEL || "github-copilot/gpt-5.6-luna";
const READY_MS = 120_000;
const TURN_MS = 180_000;
const REQUEST_MS = 60_000;
const EXIT_MS = 30_000;

const T0 = Date.now();
const ROOT = path.join(os.tmpdir(), "pinion-resume-probe", new Date().toISOString().replace(/[:.]/g, "-"));
const dir = (name) => path.join(ROOT, name);
for (const d of ["wt", "wt2", "frames", "sessions-seed", "sessions-A", "sessions-B", "sessions-C", "sessions-E", "sessions-boot"]) {
  fs.mkdirSync(dir(d), { recursive: true });
}
fs.writeFileSync(path.join(dir("wt"), "README.md"), "resume probe worktree\n");
fs.writeFileSync(path.join(dir("wt2"), "README.md"), "resume probe other worktree\n");

const CODE = "PINION-" + crypto.randomBytes(3).toString("hex").toUpperCase();
const SEED = `Remember this codeword for later in this conversation: ${CODE}. Do not use any tools. Reply with exactly: STORED`;
const RECALL = "Without using any tools, reply with only the codeword I asked you to remember earlier in this conversation.";

const sameFile = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const countJsonl = (d) => fs.readdirSync(d).filter((f) => f.endsWith(".jsonl")).length;

class OmpProc {
  constructor(label, sessionDir, extra = [], cwd = dir("wt")) {
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
  }

  async getState() { return (await this.request({ type: "get_state" })).data; }
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

// ---- result bookkeeping ----
const checks = [];
const processes = [];
const record = (variant, check, status, detail = "") => {
  checks.push({ variant, check, status, detail });
  console.log(`${variant}.${check}`.padEnd(22), status.padEnd(5), detail);
};

// Runs steps in order; after the first failure every remaining step is marked FAIL.
class Steps {
  constructor(variant) { this.variant = variant; this.failed = null; }
  async run(check, fn) {
    if (this.failed) return record(this.variant, check, "FAIL", `skipped after ${this.failed}`);
    try {
      const detail = await fn();
      record(this.variant, check, "PASS", detail ?? "");
    } catch (e) {
      this.failed = check;
      record(this.variant, check, "FAIL", e.message);
    }
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ---- main ----
let ompVersion = "unknown";
try { ompVersion = execFileSync(OMP, ["--version"], { encoding: "utf8" }).trim(); }
catch (e) { console.error(`omp not found; set PINION_OMP (${e.message})`); process.exit(2); }
if (!ompVersion.includes("18.4.4")) console.log("WARN: FINDINGS were recorded on omp 18.4.4");
console.log(`omp ${ompVersion} | model ${MODEL} | code ${CODE}\nscratch ${ROOT}\n`);

let seed = {};
let exitCode = 1;
try {
  // P0: seed a session, then simulate a crash.
  const s0 = new Steps("seed");
  const p0 = new OmpProc("P0-seed", dir("sessions-seed"));
  let F, ID, N0;
  await s0.run("turn", async () => { await p0.ready(); await p0.turn(SEED); });
  await s0.run("history", async () => {
    const st = await p0.getState();
    const msgs = await p0.getMessages();
    F = st.sessionFile; ID = st.sessionId; N0 = msgs.length;
    assert(N0 >= 2, `only ${N0} messages`);
    assert(JSON.stringify(msgs).includes(CODE), "codeword missing from live history");
    return `${N0} messages, ${path.basename(F)}`;
  });
  await p0.hardKill();
  await s0.run("durable", async () => {
    assert(F && fs.existsSync(F), `session file missing: ${F}`);
    assert(fs.readFileSync(F, "utf8").includes(CODE), "codeword not on disk after kill");
    return "on disk after hard kill";
  });
  processes.push(p0.summary());
  seed = { sessionFile: F, sessionId: ID, messageCount: N0 };
  if (s0.failed) throw new Error("seed phase failed; variants need the seed session");

  // Isolated copies so variants cannot contaminate each other.
  const copy = {}; const entriesBefore = {};
  // OMP rewrites the file on load (byte size can shrink), so growth is measured in entries.
  const countEntries = (f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).length;
  for (const X of ["A", "B", "C", "E"]) {
    const dst = dir(`sessions-${X}`);
    copy[X] = path.join(dst, path.basename(F));
    fs.copyFileSync(F, copy[X]);
    const side = path.join(path.dirname(F), path.basename(F, ".jsonl"));
    if (fs.existsSync(side)) fs.cpSync(side, path.join(dst, path.basename(side)), { recursive: true });
    entriesBefore[X] = countEntries(copy[X]);
  }

  async function common(X, p, s) {
    await s.run("identity", async () => {
      const st = await p.getState();
      assert(sameFile(st.sessionFile, copy[X]), `sessionFile ${st.sessionFile} != ${copy[X]}`);
      assert(st.sessionId === ID, `sessionId ${st.sessionId} != ${ID}`);
    });
    await s.run("history", async () => {
      const msgs = await p.getMessages();
      assert(msgs.length === N0, `messageCount ${msgs.length}, expected ${N0}`);
      assert(JSON.stringify(msgs).includes(CODE), "codeword missing from history");
      return `${msgs.length} messages`;
    });
    await s.run("continue", async () => {
      await p.turn(RECALL);
      const text = (await p.request({ type: "get_last_assistant_text" })).data?.text ?? "";
      assert(text.toUpperCase().includes(CODE), `reply lacked codeword: ${JSON.stringify(text).slice(0, 120)}`);
      return `reply ${JSON.stringify(text.trim()).slice(0, 60)}`;
    });
    await s.run("appended", async () => {
      const st = await p.getState();
      assert(sameFile(st.sessionFile, copy[X]), `sessionFile moved to ${st.sessionFile}`);
      assert(st.messageCount >= N0 + 2, `messageCount ${st.messageCount}, expected >= ${N0 + 2}`);
      return `${st.messageCount} messages`;
    });
  }
  const persisted = (X, s) => s.run("persisted", async () => {
    const n = countEntries(copy[X]);
    assert(n > entriesBefore[X], `no new entries on disk (${n} <= ${entriesBefore[X]})`);
    assert(fs.readFileSync(copy[X], "utf8").includes("reply with only the codeword"), "recall prompt not on disk");
    return `${entriesBefore[X]} -> ${n} entries`;
  });

  // Variant A: switch_session in a fresh process.
  {
    const s = new Steps("A");
    const f0 = countJsonl(dir("sessions-A"));
    const p = new OmpProc("P1-switch", dir("sessions-A"));
    let fReady;
    await s.run("attach", async () => {
      await p.ready();
      fReady = countJsonl(dir("sessions-A"));
      const r = await p.request({ type: "switch_session", sessionPath: copy.A });
      assert(r.success === true && r.data?.cancelled === false, `response ${JSON.stringify(r).slice(0, 200)}`);
      return `ready ${p.readyMs}ms`;
    });
    record("A", "files", "INFO", `*.jsonl in session dir: spawn ${f0}, after ready ${fReady}, after attach ${countJsonl(dir("sessions-A"))}`);
    await common("A", p, s);
    {
      try { // INFO control: does a missing path silently start an empty session?
        const missing = path.join(dir("sessions-A"), "missing-session.jsonl");
        const r = await p.request({ type: "switch_session", sessionPath: missing });
        const st = await p.getState();
        record("A", "control", "INFO", `missing path -> success:${r.success} cancelled:${r.data?.cancelled} messageCount:${st.messageCount}`);
      } catch (e) { record("A", "control", "INFO", `errored: ${e.message}`); }
    }
    await p.closeGracefully();
    await persisted("A", s);
    processes.push(p.summary());
  }

  // Variant B: --resume <file> at spawn.
  {
    const s = new Steps("B");
    const f0 = countJsonl(dir("sessions-B"));
    const p = new OmpProc("P2-resume", dir("sessions-B"), ["--resume", copy.B]);
    await s.run("attach", async () => { await p.ready(); return `ready ${p.readyMs}ms`; });
    record("B", "files", "INFO", `*.jsonl in session dir: spawn ${f0}, after ready ${countJsonl(dir("sessions-B"))}`);
    await common("B", p, s);
    await p.hardKill();
    await persisted("B", s);
    processes.push(p.summary());
  }

  // Variant C: pre-spawned process adopts a directory.
  {
    const s = new Steps("C");
    const p = new OmpProc("P3-open", dir("sessions-boot"));
    let fReady;
    await s.run("attach", async () => {
      await p.ready();
      fReady = countJsonl(dir("sessions-boot"));
      const r = await p.request({ type: "open_session", sessionDir: dir("sessions-C") });
      assert(r.success && r.data?.cancelled === false && r.data?.resumed === true && sameFile(r.data.sessionFile, copy.C),
        `response ${JSON.stringify(r).slice(0, 240)}`);
      return `ready ${p.readyMs}ms`;
    });
    record("C", "files", "INFO", `*.jsonl: boot dir after ready ${fReady}, target dir ${countJsonl(dir("sessions-C"))}, boot dir after attach ${countJsonl(dir("sessions-boot"))}`);
    await common("C", p, s);
    await p.closeGracefully();
    await persisted("C", s);
    processes.push(p.summary());
  }

  // Variant D: real restart on the ORIGINAL seed file in its ORIGINAL dir (no copy), via --resume
  // (the route Principle III of the constitution requires).
  {
    copy.D = F; entriesBefore.D = countEntries(F);
    const s = new Steps("D");
    const p = new OmpProc("P4-restart", dir("sessions-seed"), ["--resume", F]);
    await s.run("attach", async () => { await p.ready(); return "original file reopened via --resume"; });
    await common("D", p, s);
    await p.closeGracefully();
    await persisted("D", s);
    record("D", "files", "INFO", `*.jsonl in seed dir after restart: ${countJsonl(dir("sessions-seed"))}`);
    processes.push(p.summary());
  }

  // Variant N: does open_session pick the newest NON-EMPTY session when a newer empty one exists?
  {
    const s = new Steps("N");
    const empty = path.join(dir("sessions-A"), "missing-session.jsonl");
    const p = new OmpProc("P5-newest", dir("sessions-boot"));
    await s.run("nonempty", async () => {
      assert(fs.existsSync(empty), "control file from variant A missing");
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(empty, later, later); // make the empty session the newest by mtime
      await p.ready();
      const r = await p.request({ type: "open_session", sessionDir: dir("sessions-A") });
      assert(r.success && r.data?.resumed === true && sameFile(r.data.sessionFile, copy.A),
        `picked ${r.data?.sessionFile} (resumed:${r.data?.resumed}), expected ${copy.A}`);
      return `skipped newer empty session, picked ${path.basename(r.data.sessionFile)}`;
    });
    await p.closeGracefully();
    processes.push(p.summary());
  }

  // Variant E: negative control. Process cwd differs from the session's recorded cwd (wt).
  {
    const p = new OmpProc("P6-othercwd", dir("sessions-E"), [], dir("wt2"));
    try {
      await p.ready();
      const r = await p.request({ type: "switch_session", sessionPath: copy.E });
      const st = await p.getState();
      record("E", "othercwd", "INFO", `switch_session success:${r.success} cancelled:${r.data?.cancelled} error:${r.error ?? "-"} messageCount:${st.messageCount} sessionFile:${path.basename(st.sessionFile ?? "")}`);
    } catch (e) { record("E", "othercwd", "INFO", `errored: ${e.message}`); }
    await p.closeGracefully();
    processes.push(p.summary());
  }

  exitCode = checks.filter((c) => c.status !== "INFO").every((c) => c.status === "PASS") ? 0 : 1;
} catch (e) {
  console.error(`probe aborted: ${e.message}`);
} finally {
  fs.writeFileSync(path.join(ROOT, "result.json"), JSON.stringify({ ompVersion, model: MODEL, code: CODE, scratch: ROOT, seed, checks, processes }, null, 2));
  console.log(`\nresult.json: ${path.join(ROOT, "result.json")}`);
  process.exit(exitCode);
}
