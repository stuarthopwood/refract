// RPC default-session-directory probe (Issue #15: "default session directory without
// --session-dir").
//
// Questions:
//   (1) Spawn `omp --mode rpc-ui` with NO --session-dir, cwd = fresh scratch dir C1. Where does
//       the session file land under ~/.omp/agent/sessions/? Does the encoded bucket name match
//       the "On-Disk Layout" rule in omp://session.md?
//   (2) Two different worktrees (C1, C2) of the same scratch git repo: do they land in
//       different buckets?
//   (3) After killing the C1 process: does `--resume <file>` at spawn bring history back? Does
//       `open_session {sessionDir}` bring history back? Does a brand-new process with the same
//       cwd and no resume auto-continue anything (it should not)?
//   (4) `switch_session` from a process whose cwd is C1 to a session file recorded under C2 --
//       what happens?
//   (5) Can a host list a bucket's Conversations by scanning *.jsonl, and what is cheaply
//       readable from each file's header/first entries?
//
// Run:  node docs/spike/session-dir-probe.mjs
// Env:  PINION_OMP          omp executable (default "omp" from PATH)
//       PINION_PROBE_MODEL  model id (default github-copilot/gpt-5.6-luna; "none" = no --model)
//
// Reuses the frame/dialog/request/OmpProc logic from docs/spike/resume-probe.mjs, adapted to
// allow spawning WITHOUT --session-dir. Raw frames stay in a temp scratch dir (printed at the
// end) and never enter this repo. The script creates its own throwaway buckets under
// ~/.omp/agent/sessions/ and deletes only the ones it created (listed before deletion).

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
const ROOT = path.join(os.tmpdir(), "pinion-session-dir-probe", new Date().toISOString().replace(/[:.]/g, "-"));
const dir = (name) => path.join(ROOT, name);
for (const d of ["repo", "frames"]) fs.mkdirSync(dir(d), { recursive: true });

const SESSIONS_ROOT = path.join(os.homedir(), ".omp", "agent", "sessions");

const CODE1 = "SDP1-" + crypto.randomBytes(3).toString("hex").toUpperCase();
const CODE2 = "SDP2-" + crypto.randomBytes(3).toString("hex").toUpperCase();
const seedMsg = (code) => `Remember this codeword for later in this conversation: ${code}. Do not use any tools. Reply with exactly: STORED`;
const RECALL = "Without using any tools, reply with only the codeword I asked you to remember earlier in this conversation.";

const sameFile = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// ---- OmpProc: adapted from docs/spike/resume-probe.mjs, sessionDir may be null (omits
// --session-dir entirely so OMP falls back to its default per-cwd bucket). ----
class OmpProc {
  constructor(label, sessionDir, extra = [], cwd) {
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
      ...(sessionDir ? ["--session-dir", sessionDir] : []),
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
const record = (id, detail) => { checks.push({ id, detail }); console.log(`${id}  ${detail}`); };
async function step(id, fn) {
  try { await fn(); }
  catch (e) { record(`${id}.ERROR`, e.message); }
}

// ---- scratch git repo + two worktrees (C1, C2) ----
execFileSync("git", ["init", "-q"], { cwd: dir("repo") });
execFileSync("git", ["config", "user.email", "session-dir-probe@example.com"], { cwd: dir("repo") });
execFileSync("git", ["config", "user.name", "Session Dir Probe"], { cwd: dir("repo") });
fs.writeFileSync(path.join(dir("repo"), "README.md"), "session-dir-probe scratch repo\n");
execFileSync("git", ["add", "-A"], { cwd: dir("repo") });
execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir("repo") });
execFileSync("git", ["worktree", "add", dir("C1"), "-b", "probe-wt1"], { cwd: dir("repo") });
execFileSync("git", ["worktree", "add", dir("C2"), "-b", "probe-wt2"], { cwd: dir("repo") });
const C1 = dir("C1");
const C2 = dir("C2");

let bucketsBefore = new Set();
try { bucketsBefore = new Set(fs.readdirSync(SESSIONS_ROOT)); } catch { /* sessions root may not exist yet */ }

let ompVersion = "unknown";
try { ompVersion = execFileSync(OMP, ["--version"], { encoding: "utf8" }).trim(); }
catch (e) { console.error(`omp not found; set PINION_OMP (${e.message})`); process.exit(2); }
if (!ompVersion.includes("18.4.4")) console.log("WARN: FINDINGS were recorded on omp 18.4.4");
console.log(`omp ${ompVersion} | model ${MODEL}\nscratch ${ROOT}\nC1=${C1}\nC2=${C2}\nsessions root=${SESSIONS_ROOT}\n`);

const processes = [];
let F1, ID1, bucket1, F2, ID2, bucket2;

// (1) fresh process, cwd=C1, NO --session-dir.
await step("Q1", async () => {
  const p = new OmpProc("Q1-c1", null, [], C1);
  await p.ready();
  await p.turn(seedMsg(CODE1));
  const st = await p.getState();
  F1 = st.sessionFile; ID1 = st.sessionId; bucket1 = path.dirname(F1);
  record("Q1.get_state.sessionFile", F1);
  record("Q1.get_state.sessionId", ID1);
  record("Q1.bucket-dir-name", path.basename(bucket1));
  await p.hardKill();
  processes.push(p.summary());

  const realC1 = fs.realpathSync(C1);
  const tmpReal = fs.realpathSync(os.tmpdir());
  const homeReal = fs.realpathSync(os.homedir());
  const relToTmp = path.relative(tmpReal, realC1).split(path.sep).join("-");
  const relToHome = path.relative(homeReal, realC1).split(path.sep).join("-");
  const candidates = [`--tmp-${relToTmp}`, `--tmp-${relToTmp}--`, relToHome];
  const observed = path.basename(bucket1);
  const matched = candidates.find((c) => c === observed);
  record("Q1.encoding-rule-check",
    matched ? `matches candidate "${matched}" (session.md On-Disk Layout rule)`
      : `NO exact-string match; observed="${observed}" candidates=${JSON.stringify(candidates)}`);
});

// (2) second worktree C2, different bucket?
await step("Q2", async () => {
  const p = new OmpProc("Q2-c2", null, [], C2);
  await p.ready();
  await p.turn(seedMsg(CODE2));
  const st = await p.getState();
  F2 = st.sessionFile; ID2 = st.sessionId; bucket2 = path.dirname(F2);
  record("Q2.get_state.sessionFile", F2);
  record("Q2.bucket-dir-name", path.basename(bucket2));
  record("Q2.buckets-differ", bucket1 && bucket1.toLowerCase() !== bucket2.toLowerCase()
    ? `YES: bucket1=${path.basename(bucket1)} bucket2=${path.basename(bucket2)}`
    : `NO (unexpected): both=${path.basename(bucket2)}`);
  await p.closeGracefully();
  processes.push(p.summary());
});

// (3a) kill-then-resume via --resume <file>.
await step("Q3a", async () => {
  const p = new OmpProc("Q3a-resume", null, ["--resume", F1], C1);
  await p.ready();
  const st = await p.getState();
  record("Q3a.identity", `sessionFile=${st.sessionFile} sessionId=${st.sessionId} match=${sameFile(st.sessionFile, F1) && st.sessionId === ID1}`);
  const msgs = await p.getMessages();
  record("Q3a.history", `messageCount=${msgs.length} codewordPresent=${JSON.stringify(msgs).includes(CODE1)}`);
  await p.turn(RECALL);
  const text = (await p.request({ type: "get_last_assistant_text" })).data?.text ?? "";
  record("Q3a.recall", `reply=${JSON.stringify(text.trim()).slice(0, 80)} containsCode=${text.toUpperCase().includes(CODE1)}`);
  await p.closeGracefully();
  processes.push(p.summary());
});

// (3b) open_session {sessionDir: bucket1} on a fresh, un-resumed process.
await step("Q3b", async () => {
  const p = new OmpProc("Q3b-open", null, [], C1);
  await p.ready();
  const r = await p.request({ type: "open_session", sessionDir: bucket1 });
  record("Q3b.open_session-response", JSON.stringify(r.data ?? { error: r.error }));
  const st = await p.getState();
  record("Q3b.identity", `sessionFile=${st.sessionFile} sessionId=${st.sessionId} match=${sameFile(st.sessionFile, F1) && st.sessionId === ID1}`);
  const msgs = await p.getMessages();
  record("Q3b.history", `messageCount=${msgs.length} codewordPresent=${JSON.stringify(msgs).includes(CODE1)}`);
  await p.closeGracefully();
  processes.push(p.summary());
});

// (3c) brand-new process, cwd=C1, no resume/open/switch: must NOT auto-continue F1.
await step("Q3c", async () => {
  const before = fs.existsSync(bucket1) ? fs.readdirSync(bucket1).filter((f) => f.endsWith(".jsonl")) : [];
  const p = new OmpProc("Q3c-fresh", null, [], C1);
  await p.ready();
  const st = await p.getState();
  const autoContinued = sameFile(st.sessionFile, F1) && st.sessionId === ID1 && (st.messageCount ?? 0) > 0;
  record("Q3c.get_state", `sessionFile=${st.sessionFile} sessionId=${st.sessionId} messageCount=${st.messageCount}`);
  record("Q3c.auto-continues-prior-session", autoContinued ? "YES (unexpected)" : "NO, confirmed fresh/empty");
  const after = fs.existsSync(bucket1) ? fs.readdirSync(bucket1).filter((f) => f.endsWith(".jsonl")) : [];
  record("Q3c.no-new-file-materialized-while-idle", `*.jsonl before=${before.length} after=${after.length}`);
  await p.closeGracefully();
  processes.push(p.summary());
});

// (4) switch_session from a C1-cwd process to a session file recorded under C2.
await step("Q4", async () => {
  const p = new OmpProc("Q4-crosscwd", null, [], C1);
  await p.ready();
  const r = await p.request({ type: "switch_session", sessionPath: F2 });
  record("Q4.switch_session-response", `success=${r.success} cancelled=${r.data?.cancelled} error=${r.error ?? "-"}`);
  const st = await p.getState();
  record("Q4.identity-after-switch", `sessionFile=${st.sessionFile} sessionId=${st.sessionId} messageCount=${st.messageCount} matchesC2Session=${sameFile(st.sessionFile, F2) && st.sessionId === ID2}`);
  await p.closeGracefully();
  processes.push(p.summary());
});

// (5) list bucket1's Conversations by scanning *.jsonl; cheaply read title/created/first message.
await step("Q5", async () => {
  const files = fs.readdirSync(bucket1).filter((f) => f.endsWith(".jsonl"));
  record("Q5.bucket-listing", `${files.length} file(s): ${files.join(", ")}`);
  for (const f of files) {
    const full = path.join(bucket1, f);
    const fd = fs.openSync(full, "r");
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const lines = buf.subarray(0, n).toString("utf8").split("\n");
    let header = {};
    try { header = JSON.parse(lines[0]); } catch { /* unparseable in the head chunk */ }
    let firstUserMessage = null;
    for (const line of lines.slice(1)) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === "message" && e.message?.role === "user") {
          const block = (e.message.content || []).find((c) => c.type === "text");
          firstUserMessage = block?.text ?? null;
          break;
        }
      } catch { /* line may be cut off at the 8KB read boundary */ }
    }
    record(`Q5.file[${f}]`, `title=${JSON.stringify(header.title ?? null)} created=${header.timestamp ?? "(none)"} firstUserMessageFound=${firstUserMessage !== null} firstUserMessageLen=${firstUserMessage?.length ?? 0}`);
  }
  if (files.length) {
    const full = path.join(bucket1, files[0]);
    const firstLineRaw = fs.readFileSync(full, "utf8").split("\n")[0];
    let redacted = "(unparseable)";
    try {
      const h = JSON.parse(firstLineRaw);
      redacted = JSON.stringify({ type: h.type, version: h.version, id: h.id, timestamp: h.timestamp, cwd: "[REDACTED]", title: h.title ?? null });
    } catch { /* keep default */ }
    record("Q5.sample-header-line-redacted", redacted);
  }
});

// ---- cleanup: delete ONLY the buckets this run created; list them first ----
let bucketsAfter = new Set();
try { bucketsAfter = new Set(fs.readdirSync(SESSIONS_ROOT)); } catch { /* ignore */ }
const createdBuckets = [...bucketsAfter].filter((b) => !bucketsBefore.has(b));
console.log(`\ncreated buckets under ${SESSIONS_ROOT}:\n  ${createdBuckets.join("\n  ") || "(none)"}`);
for (const b of createdBuckets) fs.rmSync(path.join(SESSIONS_ROOT, b), { recursive: true, force: true });
console.log(`deleted ${createdBuckets.length} scratch bucket(s)`);

fs.writeFileSync(path.join(ROOT, "result.json"), JSON.stringify({
  ompVersion, model: MODEL, scratch: ROOT, C1, C2, sessionsRoot: SESSIONS_ROOT,
  checks, createdBuckets, processes,
}, null, 2));
console.log(`\nresult.json: ${path.join(ROOT, "result.json")}`);
