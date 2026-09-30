// Memory + cold-start probe (Issue #13, memory cost of concurrent omp processes;
// FINDINGS C22, cold start / first token).
//
// Spawns `omp --mode rpc-ui` exactly the way Pinion would (no --session-dir; the
// session lands in omp's cwd-derived default dir):
//
//   (a) Cold start x3 (sequential, one process at a time):
//         spawn -> ready frame; ready -> first `agent_start` / first assistant
//         `text_delta` after a tiny prompt ("Reply with exactly: OK").
//   (b) Memory of one process: idle (ready + 10s settle), then peak working
//       set / private bytes while it answers a 200-word prompt (sampled every 2s).
//   (c) The same idle-after-ready+10s total with 1, then 2, then 3 processes
//       alive at once, to see whether memory cost scales linearly.
//   (d) Every memory sample also records total free physical memory and the
//       count of *other* omp.exe processes on the machine (not spawned by this
//       script), since another experiment may be running concurrently.
//
// Memory is read via a single `Get-CimInstance Win32_Process` (for the parent/
// child tree) + `Get-Process` (for WorkingSet64 / PrivateMemorySize64) snapshot
// per sample, so tree-walk and memory numbers are from the same instant.
//
// Run:  node docs/spike/memory-probe.mjs
// Env:  PINION_OMP          omp executable (default "omp" from PATH)
//       PINION_PROBE_MODEL  model id (default github-copilot/gpt-5.6-luna)
//
// Raw RPC frames are written to a temp scratch dir (printed at the end), never
// into this repo. At most 3 omp processes spawned by this script are alive at
// once; each is torn down with `taskkill /PID <pid> /T /F` (own tree only).

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OMP = process.env.PINION_OMP || "omp";
const MODEL = process.env.PINION_PROBE_MODEL || "github-copilot/gpt-5.6-luna";
const READY_MS = 120_000;
const REQUEST_MS = 60_000;
const TURN_MS = 180_000;
const EXIT_MS = 30_000;
const IDLE_SETTLE_MS = 10_000;
const SAMPLE_INTERVAL_MS = 2_000;

const T0 = Date.now();
const ROOT = path.join(os.tmpdir(), "pinion-memory-probe", new Date().toISOString().replace(/[:.]/g, "-"));
const dir = (name) => path.join(ROOT, name);
for (const d of ["frames", "wtA1", "wtA2", "wtA3", "wtB", "wtC2", "wtC3"]) fs.mkdirSync(dir(d), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (bytes) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

// ---------------------------------------------------------------------------
// RPC link, adapted from docs/spike/resume-probe.mjs's OmpProc: frame decode,
// rpc_chunk reassembly, ready/negotiate, request/waitFor, dialog auto-deny.
// This probe never passes --session-dir (cwd's default session location).
// ---------------------------------------------------------------------------
class OmpProc {
  constructor(label, cwd) {
    this.label = label;
    this.frames = [];
    this.waiters = [];
    this.warnings = [];
    this.chunks = new Map();
    this.buf = Buffer.alloc(0);
    this.n = 0;
    this.readyMs = null;
    this.readyAt = null;
    this.exitCode = null;
    this.exited = false;
    this.log = fs.createWriteStream(path.join(dir("frames"), `${label}.jsonl`));
    this.errLog = fs.createWriteStream(path.join(dir("frames"), `${label}.stderr.log`));
    const args = ["--mode", "rpc-ui", "--approval-mode=always-ask", "--model", MODEL];
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
    this.readyAt = Date.now();
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

  /** Sends a tiny prompt and times: ready->first agent_start, ready->first text_delta, full turn. */
  async promptTiming(message) {
    const id = `${this.label}-${++this.n}`;
    const mark = this.frames.length;
    const sentAt = Date.now();
    this.write({ id, type: "prompt", message });
    const ack = await this.waitFor((f) => f.type === "response" && f.id === id, mark, REQUEST_MS, "prompt ack");
    if (!ack.success) throw new Error(`prompt rejected: ${ack.error}`);
    if (ack.data?.agentInvoked === false) throw new Error("prompt handled locally (agentInvoked:false)");
    const agentStart = await this.waitFor((f) => f.type === "agent_start", mark, TURN_MS, "agent_start")
      .catch((e) => { this.warnings.push(e.message); return null; });
    const firstAgentStartMs = agentStart ? Date.now() - this.readyAt : null;
    const textDelta = await this.waitFor(
      (f) => f.type === "message_update" && f.assistantMessageEvent?.type === "text_delta",
      mark, TURN_MS, "first text_delta",
    ).catch((e) => { this.warnings.push(e.message); return null; });
    const firstTextDeltaMs = textDelta ? Date.now() - this.readyAt : null;
    const res = await this.waitFor((f) => f.type === "prompt_result" && f.id === id, mark, TURN_MS, "prompt_result");
    if (res.status !== "completed") throw new Error(`turn status ${res.status}: ${JSON.stringify(res.error ?? {})}`);
    if (res.sessionSettled !== true) await this.waitFor((f) => f.type === "session_settled", mark, TURN_MS, "session_settled");
    return { firstAgentStartMs, firstTextDeltaMs, turnMs: Date.now() - sentAt };
  }

  /** Fires a turn without waiting for it; caller polls frames/samples memory, then calls settleTurn. */
  beginTurn(message) {
    const id = `${this.label}-${++this.n}`;
    const mark = this.frames.length;
    this.write({ id, type: "prompt", message });
    return { id, mark };
  }

  turnDone(mark, id) {
    return this.frames.slice(mark).some((f) => f.type === "prompt_result" && f.id === id);
  }

  async settleTurn(mark, id) {
    const res = this.frames.slice(mark).find((f) => f.type === "prompt_result" && f.id === id);
    if (res.status !== "completed") this.warnings.push(`turn status ${res.status}`);
    if (res.sessionSettled !== true) await this.waitFor((f) => f.type === "session_settled", mark, TURN_MS, "session_settled").catch((e) => this.warnings.push(e.message));
  }

  async closeGracefully() {
    if (this.exited) return;
    this.child.stdin.end();
    const done = await Promise.race([this.exitPromise.then(() => true), new Promise((r) => setTimeout(() => r(false), EXIT_MS))]);
    if (!done) await this.hardKill();
  }

  async hardKill() {
    if (!this.exited) {
      try { execFileSync("taskkill", ["/PID", String(this.child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* already gone */ }
      await Promise.race([this.exitPromise, new Promise((r) => setTimeout(r, EXIT_MS))]);
    }
    this.exitCode = this.exitCode ?? "killed";
  }

  close() { this.log.end(); this.errLog.end(); }
}

// ---------------------------------------------------------------------------
// Process-tree memory snapshot: one combined pwsh call per sample (Win32_Process
// for the parent/child tree, Get-Process for WorkingSet64/PrivateMemorySize64,
// Win32_OperatingSystem for free physical memory).
// ---------------------------------------------------------------------------
function snapshotSystem() {
  const script = [
    "$procs = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name",
    "$mem = Get-Process -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,WorkingSet64,PrivateMemorySize64",
    "$os = Get-CimInstance Win32_OperatingSystem | Select-Object FreePhysicalMemory",
    "[PSCustomObject]@{ procs = @($procs); mem = @($mem); freeKB = $os.FreePhysicalMemory } | ConvertTo-Json -Depth 4 -Compress",
  ].join("\n");
  const out = execFileSync("pwsh", ["-NoProfile", "-Command", script], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}

function childrenOf(pid, procs) { return procs.filter((p) => Number(p.ParentProcessId) === pid); }

function walkDescendants(rootPid, procs, maxDepth = 8) {
  const out = [];
  let frontier = [rootPid];
  const seen = new Set(frontier);
  let depth = 0;
  while (frontier.length && depth < maxDepth) {
    const next = [];
    for (const pid of frontier) {
      for (const c of childrenOf(pid, procs)) {
        const cpid = Number(c.ProcessId);
        if (seen.has(cpid)) continue;
        seen.add(cpid);
        out.push(cpid);
        next.push(cpid);
      }
    }
    frontier = next;
    depth++;
  }
  return out;
}

/** Sums working set / private bytes over every root's descendant tree (union, de-duplicated). */
function measureRoots(label, rootPids, snap) {
  const memById = new Map(snap.mem.map((p) => [Number(p.Id), p]));
  const allPids = new Set();
  for (const root of rootPids) {
    allPids.add(root);
    for (const d of walkDescendants(root, snap.procs)) allPids.add(d);
  }
  const rows = [];
  for (const pid of allPids) {
    const m = memById.get(pid);
    if (!m) continue; // exited between the two sub-queries of this snapshot
    rows.push({ pid, name: m.ProcessName, wsBytes: m.WorkingSet64 ?? 0, pmBytes: m.PrivateMemorySize64 ?? 0 });
  }
  const totalWSBytes = rows.reduce((s, r) => s + r.wsBytes, 0);
  const totalPMBytes = rows.reduce((s, r) => s + r.pmBytes, 0);
  const top3 = [...rows].sort((a, b) => b.wsBytes - a.wsBytes).slice(0, 3)
    .map((r) => `${r.name}#${r.pid}=${mb(r.wsBytes)}MB`);
  const otherOmpCount = snap.procs.filter((p) => /^omp(\.exe)?$/i.test(p.Name) && !allPids.has(Number(p.ProcessId))).length;
  return {
    label, processCount: rows.length,
    totalWSMB: mb(totalWSBytes), totalPMMB: mb(totalPMBytes),
    top3, freeMB: mb(snap.freeKB * 1024), otherOmpCount,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const allProcs = [];
const coldStart = [];
const memory = [];
let ompVersion = "unknown";
try { ompVersion = execFileSync(OMP, ["--version"], { encoding: "utf8" }).trim(); }
catch (e) { console.error(`omp not found; set PINION_OMP (${e.message})`); process.exit(2); }
console.log(`omp ${ompVersion} | model ${MODEL}\nscratch ${ROOT}\n`);

try {
  // --- (a) cold start x3, sequential, one process at a time ---
  for (let i = 1; i <= 3; i++) {
    const p = new OmpProc(`A${i}`, dir(`wtA${i}`));
    allProcs.push(p);
    try {
      await p.ready();
      const timing = await p.promptTiming("Reply with exactly: OK");
      coldStart.push({ run: i, readyMs: p.readyMs, ...timing, warnings: p.warnings.slice() });
    } finally {
      await p.closeGracefully();
      p.close();
    }
  }

  // --- (b)+(c): spawn B, measure idle (n=1) then mid-turn peak, then add C2/C3 ---
  const pB = new OmpProc("B", dir("wtB"));
  allProcs.push(pB);
  await pB.ready();
  await sleep(IDLE_SETTLE_MS);
  memory.push(measureRoots("idle+10s (n=1)", [pB.child.pid], snapshotSystem()));

  const { id: turnId, mark: turnMark } = pB.beginTurn("Write exactly 200 words about the history of the bicycle. Do not use any tools.");
  let peak = null;
  while (!pB.turnDone(turnMark, turnId)) {
    await sleep(SAMPLE_INTERVAL_MS);
    const m = measureRoots("mid-turn (n=1)", [pB.child.pid], snapshotSystem());
    if (!peak || m.totalWSMB > peak.totalWSMB) peak = m;
  }
  await pB.settleTurn(turnMark, turnId);
  memory.push(peak ?? measureRoots("mid-turn (n=1)", [pB.child.pid], snapshotSystem()));

  const pC2 = new OmpProc("C2", dir("wtC2"));
  allProcs.push(pC2);
  await pC2.ready();
  await sleep(IDLE_SETTLE_MS);
  memory.push(measureRoots("idle+10s (n=2)", [pB.child.pid, pC2.child.pid], snapshotSystem()));

  const pC3 = new OmpProc("C3", dir("wtC3"));
  allProcs.push(pC3);
  await pC3.ready();
  await sleep(IDLE_SETTLE_MS);
  memory.push(measureRoots("idle+10s (n=3)", [pB.child.pid, pC2.child.pid, pC3.child.pid], snapshotSystem()));

  await Promise.all([pC3, pC2, pB].map((p) => p.hardKill()));
  for (const p of [pC3, pC2, pB]) p.close();
} finally {
  // Safety net: hard-kill anything still alive if an earlier step threw.
  for (const p of allProcs) if (!p.exited) { try { await p.hardKill(); } catch { /* best effort */ } try { p.close(); } catch { /* already closed */ } }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log("-- (a) cold start, sequential (ms) --");
console.log("run  readyMs  firstAgentStartMs  firstTokenMs  turnMs");
for (const r of coldStart) console.log(`${r.run}    ${r.readyMs}      ${r.firstAgentStartMs}              ${r.firstTextDeltaMs}          ${r.turnMs}`);

console.log("\n-- (b)+(c) memory (MB) --");
console.log("label              procs  totalWS  totalPrivate  freePhys  otherOmp  top3");
for (const m of memory) {
  console.log(`${m.label.padEnd(18)} ${String(m.processCount).padEnd(6)} ${String(m.totalWSMB).padEnd(8)} ${String(m.totalPMMB).padEnd(13)} ${String(m.freeMB).padEnd(9)} ${String(m.otherOmpCount).padEnd(9)} ${m.top3.join(", ")}`);
}

const otherOmpSeen = memory.some((m) => m.otherOmpCount > 0);
if (otherOmpSeen) console.log("\nNOTE: other omp.exe processes (not spawned by this script) were present during at least one sample; totals above are not machine-isolated.");

const n1 = memory.find((m) => m.label === "idle+10s (n=1)");
const n2 = memory.find((m) => m.label === "idle+10s (n=2)");
const n3 = memory.find((m) => m.label === "idle+10s (n=3)");
const midTurn = memory.find((m) => m.label === "mid-turn (n=1)");
const marginalMB = n1 && n3 ? Math.round(((n3.totalWSMB - n1.totalWSMB) / 2) * 10) / 10 : null;
const avgReady = coldStart.length ? Math.round(coldStart.reduce((s, r) => s + r.readyMs, 0) / coldStart.length) : null;
const avgFirstToken = coldStart.filter((r) => r.firstTextDeltaMs != null).length
  ? Math.round(coldStart.filter((r) => r.firstTextDeltaMs != null).reduce((s, r) => s + r.firstTextDeltaMs, 0) / coldStart.filter((r) => r.firstTextDeltaMs != null).length)
  : null;
const projected5 = n1 && marginalMB != null ? Math.round((n1.totalWSMB + marginalMB * 4) * 10) / 10 : null;

console.log("\n-- analysis --");
console.log(`avg cold-start (spawn->ready): ${avgReady} ms`);
console.log(`avg ready->first token: ${avgFirstToken} ms`);
if (n1 && n2 && n3) console.log(`idle working set: n=1 ${n1.totalWSMB} MB, n=2 ${n2.totalWSMB} MB, n=3 ${n3.totalWSMB} MB (marginal/session ~${marginalMB} MB)`);
if (midTurn && n1) console.log(`mid-turn peak (n=1): ${midTurn.totalWSMB} MB working set (vs ${n1.totalWSMB} MB idle)`);
if (projected5 != null) console.log(`5 concurrent sessions, projected working set: ~${projected5} MB (base ${n1.totalWSMB} MB + 4 x marginal ${marginalMB} MB)`);

fs.writeFileSync(dir("result.json"), JSON.stringify({ ompVersion, model: MODEL, scratch: ROOT, coldStart, memory, analysis: { avgReady, avgFirstToken, marginalMB, projected5 } }, null, 2));
console.log(`\nfull result: ${dir("result.json")}`);
