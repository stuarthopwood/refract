// `promote_queued_message` / `remove_queued_message` live RPC probe (issue #540, PLAN row 111's
// "Probe promote_queued_message first", PR #591 quality-gate finding "Verification gap: nothing
// in FINDINGS.md records a probe").
//
// Questions this answers, against the REAL installed omp binary (not assumed from docs/rpc.md):
//   1. Does `promote_queued_message` actually match OMP's documented "first matching follow-up"
//      FIFO rule when TWO queued follow-ups share the exact same text? This is the central
//      assumption behind Refract's renderer-side duplicate-text chip fix (MessageInput.tsx's
//      per-occurrence stable-id pool): if OMP instead promoted an arbitrary (non-FIFO) match,
//      that fix's id-assignment order would need to change.
//   2. Does a THIRD `promote_queued_message` call, once no follow-up with that text remains,
//      really come back `{ promoted: false }` rather than erroring?
//   3. Does `remove_queued_message` with `queue: 'steering'` actually work against a real
//      promoted message (the #540 fix this whole PR ships), and does removing twice drain two
//      duplicate steering entries one at a time, then report `removed: false` once none remain?
//
// This uses Stuart's REAL default OMP profile (no --profile flag), same pattern and same safety
// rationale as docs/spike/chat-lines-probe.mjs: a real model is needed to get a genuine "working"
// status window to queue follow-ups into, but:
//   - `--session-dir` points at a scratch temp directory; his real session history under
//     ~/.omp/agent/sessions is never written to.
//   - cwd is a brand-new scratch git repo, never his real working trees.
//   - `--approval-mode=always-ask` plus a deny-everything dialog handler means no tool call
//     (bash, fs write, etc.) is ever actually executed. The one prompt sent below is pure text
//     generation ("write a short story, no tool use") specifically so no approval dialog should
//     ever even appear; the deny-everything handler is only a defensive fallback.
//   - No `/login` command and no config-changing command is ever sent.
//
// Run:  node docs/spike/promote-queued-message-probe.mjs
// Env:  PINION_OMP          omp executable (default "omp" from PATH)
//       PINION_PROBE_MODEL  model id (default github-copilot/gpt-5.6-luna)

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const OMP = process.env.PINION_OMP || "omp";
const MODEL = process.env.PINION_PROBE_MODEL || "github-copilot/gpt-5.6-luna";
const READY_MS = 120_000;
const REQUEST_MS = 60_000;
const SETTLE_MS = 180_000;
const EXIT_MS = 30_000;

const T0 = Date.now();
const ROOT = path.join(os.tmpdir(), "pinion-promote-queued-message-probe", new Date().toISOString().replace(/[:.]/g, "-"));
const dir = (name) => path.join(ROOT, name);
for (const d of ["repo", "session-dir", "frames"]) {
  fs.mkdirSync(dir(d), { recursive: true });
}

try {
  execFileSync("git", ["init", "-q", "-b", "main", dir("repo")]);
  execFileSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@example.invalid", "commit", "--allow-empty", "-m", "init"], {
    cwd: dir("repo"),
  });
} catch (e) {
  console.error(`scratch repo init failed: ${e.message}`);
  process.exit(2);
}

// ---- OmpProc: copied from docs/spike/chat-lines-probe.mjs's own class (same frame-reassembly,
// request(), and deny-everything dialog handler) -- this probe needs none of that script's
// per-scenario onDialog overrides, since nothing here ever triggers a tool-approval dialog.
class OmpProc {
  constructor(label, { sessionDir, cwd } = {}) {
    this.label = label;
    this.n = 0;
    this.frames = [];
    this.waiters = [];
    this.warnings = [];
    this.chunks = new Map();
    this.buf = Buffer.alloc(0);
    this.exitCode = null;
    this.log = fs.createWriteStream(path.join(dir("frames"), `${label}.jsonl`));
    this.errLog = fs.createWriteStream(path.join(dir("frames"), `${label}.stderr.log`));
    const args = ["--mode", "rpc-ui", "--approval-mode=always-ask"];
    if (sessionDir) args.push("--session-dir", sessionDir);
    if (MODEL !== "none") args.push("--model", MODEL);
    this.child = spawn(OMP, args, { cwd, env: process.env, stdio: "pipe", windowsHide: true });
    this.exitPromise = new Promise((resolve) => {
      this.child.on("exit", (code) => { this.exitCode = code; resolve(); });
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
      try { frame = JSON.parse(line); }
      catch (e) { this.#record("out", line, { parseError: true }); continue; }
      this.#handle(frame);
    }
  }

  #handle(frame) {
    if (frame.type === "rpc_chunk") {
      let c = this.chunks.get(frame.chunkId);
      if (!c) { c = { parts: new Array(frame.count), got: 0, byteLength: frame.byteLength }; this.chunks.set(frame.chunkId, c); }
      c.parts[frame.index] = c.parts[frame.index] ?? Buffer.from(frame.data, "base64");
      c.got++;
      if (c.got !== frame.count) return;
      const whole = Buffer.concat(c.parts);
      this.chunks.delete(frame.chunkId);
      try { frame = JSON.parse(whole.toString("utf8")); }
      catch (e) { this.#record("out", { type: "__probe_protocol_error", error: `chunk ${frame.chunkId}: ${e.message}` }); return; }
    }
    this.#dispatch(frame);
  }

  #dispatch(frame) {
    const idx = this.frames.length;
    this.frames.push({ type: frame.type, frame, t: Date.now() - T0 });
    this.#record("in", frame);
    if (frame.type === "extension_ui_request") this.#answerDialog(frame);
    for (const w of [...this.waiters]) {
      if (idx >= w.from && w.pred(frame)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(frame); }
    }
  }

  #answerDialog(frame) {
    const title = frame.data?.title ?? frame.title ?? "(omitted)";
    this.warnings.push(`dialog denied/cancelled (defensive fallback -- none expected): ${String(title).split("\n")[0]}`);
    if (frame.method === "select") this.write({ type: "extension_ui_response", id: frame.id, value: "Deny" });
    else this.write({ type: "extension_ui_response", id: frame.id, cancelled: true });
  }

  write(obj) {
    this.#record("out", obj);
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  async waitFor(pred, { timeout = REQUEST_MS, what } = {}) {
    const from = this.frames.length;
    for (let i = 0; i < from; i++) if (pred(this.frames[i].frame)) return this.frames[i].frame;
    return new Promise((resolve, reject) => {
      const w = { pred, from, resolve };
      const t = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`${this.label}: timeout after ${timeout}ms waiting for ${what ?? "<frame>"}`));
      }, timeout);
      w.resolve = (f) => { clearTimeout(t); resolve(f); };
      this.waiters.push(w);
    });
  }

  async ready() {
    const r = await Promise.race([
      this.waitFor((f) => f.type === "ready", { timeout: READY_MS, what: "ready frame" }).then((f) => ({ ok: true, frame: f })),
      this.exitPromise.then(() => ({ ok: false })),
    ]);
    if (!r.ok) throw new Error(`${this.label}: process exited before ready (code ${this.exitCode}); see frames/${this.label}.stderr.log`);
    if (r.frame.supportedProtocolVersions?.includes(2)) {
      const neg = await this.request({ type: "negotiate_protocol", protocolVersion: 2 });
      if (!neg.success) throw new Error(`negotiate_protocol failed: ${neg.error}`);
    }
    return r.frame;
  }

  async request(cmd, { timeout = REQUEST_MS } = {}) {
    const id = `${this.label}-${this.n++}`;
    this.write({ ...cmd, id });
    return this.waitFor((f) => f.type === "response" && f.id === id, { timeout, what: `response to ${cmd.type}` });
  }

  async close() {
    const done = await Promise.race([this.exitPromise.then(() => true), new Promise((r) => setTimeout(() => r(false), EXIT_MS))]);
    if (!done) {
      try { execFileSync("taskkill", ["/pid", String(this.child.pid), "/T", "/F"]); }
      catch { try { this.child.kill("SIGKILL"); } catch { /* already gone */ } }
      await Promise.race([this.exitPromise, new Promise((r) => setTimeout(r, EXIT_MS))]);
    }
    this.exitCode = this.exitCode === null ? "killed" : this.exitCode;
    this.log.end();
    this.errLog.end();
    return { label: this.label, exitCode: this.exitCode, warnings: this.warnings };
  }
}

let ompVersion = "unknown";
try { ompVersion = execFileSync(OMP, ["--version"], { encoding: "utf8" }).trim(); }
catch (e) { console.error(`omp not found; set PINION_OMP (${e.message})`); process.exit(2); }
console.log(`omp ${ompVersion} | model ${MODEL}\nscratch ${ROOT}\n`);

const results = { ompVersion, model: MODEL };
let scriptFailed = false;
let proc;

try {
  proc = new OmpProc("p1", { sessionDir: dir("session-dir"), cwd: dir("repo") });
  await proc.ready();

  // A real turn long enough to leave a "working" window for every RPC call below -- no tool use
  // requested, so no approval dialog should appear at all.
  const longPrompt =
    "Write a 200-word short story about a lighthouse keeper watching a storm. " +
    "Do not use any tools -- just write the story as your reply.";
  proc.write({ id: "p1-0", type: "prompt", message: longPrompt });
  const ack1 = await proc.waitFor((f) => f.type === "response" && f.id === "p1-0", { what: "prompt ack" });
  results.firstPromptAck = { success: ack1.success, agentInvoked: ack1.agentInvoked };
  await proc.waitFor((f) => f.type === "agent_start", { what: "agent_start" });
  console.log("agent_start observed; session is now working -- sending follow-ups");

  const DUPLICATE_TEXT = "please also mention a seagull";

  // --- 1. Queue the SAME text twice as a follow-up while working. ---
  const q1 = await proc.request({ type: "prompt", message: DUPLICATE_TEXT, streamingBehavior: "followUp" });
  const q2 = await proc.request({ type: "prompt", message: DUPLICATE_TEXT, streamingBehavior: "followUp" });
  results.queueTwoDuplicates = { first: q1, second: q2 };
  const afterQueueTwo = await proc.waitFor(
    (f) => f.type === "queue_update" && f.followUp.filter((t) => t === DUPLICATE_TEXT).length === 2,
    { what: "queue_update with 2 duplicate follow-ups" }
  );
  results.queueStateAfterTwoDuplicates = { followUp: afterQueueTwo.followUp, steering: afterQueueTwo.steering };
  console.log("after queuing 2 duplicates:", JSON.stringify(results.queueStateAfterTwoDuplicates));

  // --- 2. Promote ONE of the two duplicates: does OMP promote the first (FIFO) match, leaving
  // exactly one follow-up and one steering entry (never both-or-neither)? ---
  const promote1 = await proc.request({ type: "promote_queued_message", message: DUPLICATE_TEXT });
  results.promote1 = promote1;
  const afterPromote1 = await proc.waitFor(
    (f) => f.type === "queue_update" && f.steering.filter((t) => t === DUPLICATE_TEXT).length === 1,
    { what: "queue_update after first promote" }
  );
  results.queueStateAfterPromote1 = { followUp: afterPromote1.followUp, steering: afterPromote1.steering };
  console.log("after promoting 1 of 2 duplicates:", JSON.stringify({ promoted: promote1.data, queue: results.queueStateAfterPromote1 }));

  // --- 3. Promote the SECOND (last remaining) duplicate follow-up. ---
  const promote2 = await proc.request({ type: "promote_queued_message", message: DUPLICATE_TEXT });
  results.promote2 = promote2;
  const afterPromote2 = await proc.waitFor(
    (f) => f.type === "queue_update" && f.steering.filter((t) => t === DUPLICATE_TEXT).length === 2,
    { what: "queue_update after second promote" }
  );
  results.queueStateAfterPromote2 = { followUp: afterPromote2.followUp, steering: afterPromote2.steering };
  console.log("after promoting both duplicates:", JSON.stringify({ promoted: promote2.data, queue: results.queueStateAfterPromote2 }));

  // --- 4. A THIRD promote, with nothing left in follow-up for this text: must report
  // `promoted: false`, never error or silently re-promote a steering entry. ---
  const promote3 = await proc.request({ type: "promote_queued_message", message: DUPLICATE_TEXT });
  results.promote3NoFollowUpLeft = promote3;
  console.log("third promote (nothing left in follow-up):", JSON.stringify(promote3.data ?? promote3));

  // --- 5. Remove one of the two now-steering duplicates. ---
  const remove1 = await proc.request({ type: "remove_queued_message", message: DUPLICATE_TEXT, queue: "steering" });
  results.remove1FromSteering = remove1;
  console.log("remove 1 from steering:", JSON.stringify(remove1.data ?? remove1));

  // --- 6. Remove the other one. ---
  const remove2 = await proc.request({ type: "remove_queued_message", message: DUPLICATE_TEXT, queue: "steering" });
  results.remove2FromSteering = remove2;
  console.log("remove 2 from steering:", JSON.stringify(remove2.data ?? remove2));

  // --- 7. A THIRD remove from steering, with none left: must report `removed: false`. ---
  const remove3 = await proc.request({ type: "remove_queued_message", message: DUPLICATE_TEXT, queue: "steering" });
  results.remove3NoneLeftInSteering = remove3;
  console.log("third remove from steering (none left):", JSON.stringify(remove3.data ?? remove3));

  // --- Cleanup: abort the still-running first turn, wait for it to settle, close. ---
  await proc.request({ type: "abort" });
  await proc.waitFor((f) => f.type === "session_settled", { timeout: SETTLE_MS, what: "session_settled after abort" });
  await proc.close();
} catch (e) {
  scriptFailed = true;
  console.error("probe failed:", e.message, e.stack);
  if (proc) await proc.close().catch(() => { });
}

fs.writeFileSync(path.join(ROOT, "result.json"), JSON.stringify(results, null, 2));
console.log(`\nscratch dir (raw frames, unredacted -- contains real model output): ${ROOT}`);
process.exit(scriptFailed ? 1 : 0);
