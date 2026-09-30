// Orphan-after-crash probe (Issue #12): do tool subprocesses survive a force-killed Pinion?
//
// Simulates Pinion's Electron main process by spawning a small Node "parent" (this same
// file, re-invoked with --as-parent <json config>) that itself spawns `omp --mode rpc-ui`.
// The parent drives one prompt that makes the model call the bash tool with a long-running
// command (`ping -n 120 127.0.0.1`), waits for the OS process to actually be running (not
// just the `tool_execution_start` event), then the *driver* force-kills only the parent's
// pid (no /T) and polls the exact recorded descendant pids to see whether they survive.
//
// A second variant observes omp's idle child processes (MCP/LSP servers) under the user's
// normal, unmodified config, with no tool prompt.
//
// A third, independent experiment proves whether a Windows Job Object with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (created via the `koffi` npm package's FFI to
// kernel32.dll, no native compile step) can force such children to die with the parent.
//
// Run:  node docs/spike/orphan-probe.mjs
// Env:  PINION_OMP          omp executable (default "omp" from PATH)
//       PINION_PROBE_MODEL  model id (default github-copilot/gpt-5.6-luna)
//
// Raw frames/results are written to a temp scratch dir (printed at the end), never into
// this repo. This script itself spawns at most one omp process at a time.

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const OMP = process.env.PINION_OMP || "omp";
const MODEL = process.env.PINION_PROBE_MODEL || "github-copilot/gpt-5.6-luna";
const READY_MS = 90_000;
const REQUEST_MS = 30_000;
const TOOL_START_MS = 90_000;
const DESCENDANT_POLL_BUDGET_MS = 25_000;
const SURVIVOR_OFFSETS_MS = [1_000, 3_000, 5_000, 10_000, 30_000];
const SELF_PATH = fileURLToPath(import.meta.url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Shared: tiny event bus used both inside OmpLink (raw omp frames) and in the
// driver (parsed CTRL lines from a parent's stdout).
// ---------------------------------------------------------------------------
function makeWaiter() {
  const items = [];
  const waiters = [];
  function push(item) {
    items.push(item);
    for (const w of [...waiters]) {
      if (w.pred(item)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(item);
      }
    }
  }
  function waitFor(pred, timeoutMs) {
    const existing = items.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const w = {
        pred,
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
      };
      const t = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error(`timeout after ${timeoutMs}ms waiting for CTRL event`));
      }, timeoutMs);
      waiters.push(w);
    });
  }
  return { push, waitFor, items };
}

// ---------------------------------------------------------------------------
// PARENT-SIDE: raw JSONL RPC link to one omp child process. Adapted from
// docs/spike/resume-probe.mjs's OmpProc (frame decode, rpc_chunk reassembly,
// ready/negotiate, request/waitFor, dialog auto-deny).
// ---------------------------------------------------------------------------
class OmpLink {
  n = 0;

  constructor(label, args, cwd, frameLogPath, stderrLogPath) {
    this.label = label;
    this.frames = [];
    this.waiters = [];
    this.chunks = new Map();
    this.buf = Buffer.alloc(0);
    this.frameLog = fs.createWriteStream(frameLogPath);
    this.stderrLog = fs.createWriteStream(stderrLogPath);
    this.startedAt = Date.now();
    this.proc = spawn(OMP, args, { cwd, stdio: "pipe", windowsHide: true });
    this.pid = this.proc.pid;
    this.proc.on("error", (e) => this.#log("out", { probeSpawnError: true, error: e.message }));
    this.proc.stdout.on("data", (d) => this.#onData(d));
    this.proc.stderr.on("data", (d) => this.stderrLog.write(d));
  }

  #log(dir, frame) {
    this.frameLog.write(JSON.stringify({ t: Date.now() - this.startedAt, dir, frame }) + "\n");
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
        this.#log("out", { parseError: true, raw: line, error: e.message });
        continue;
      }
      this.#handle(frame);
    }
  }

  #handle(frame) {
    if (frame.type === "rpc_chunk") {
      let c = this.chunks.get(frame.chunkId);
      if (!c) {
        c = { parts: new Array(frame.count), got: 0 };
        this.chunks.set(frame.chunkId, c);
      }
      if (!c.parts[frame.index]) {
        c.parts[frame.index] = Buffer.from(frame.data, "base64");
        c.got++;
      }
      if (c.got === frame.count) {
        this.chunks.delete(frame.chunkId);
        const whole = Buffer.concat(c.parts);
        if (whole.length !== frame.byteLength) {
          this.#dispatch({ type: "__probe_chunk_error__", error: `chunk ${frame.chunkId} got ${whole.length} bytes, expected ${frame.byteLength}` });
          return;
        }
        try {
          this.#dispatch(JSON.parse(whole.toString("utf8")));
        } catch (e) {
          this.#dispatch({ type: "__probe_parse_error__", error: `chunk ${frame.chunkId}: ${e.message}` });
        }
      }
      return;
    }
    this.#dispatch(frame);
  }

  #dispatch(frame) {
    const idx = this.frames.length;
    this.frames.push(frame);
    this.#log("out", frame);
    if (frame.type === "extension_ui_request") this.#answerDialog(frame);
    for (const w of [...this.waiters]) {
      if (idx >= w.from && w.pred(frame)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(frame);
      }
    }
  }

  #answerDialog(frame) {
    const title = String(frame.title ?? "");
    if (frame.method === "select" && title.startsWith("Allow tool:")) {
      this.write({ type: "extension_ui_response", id: frame.id, value: "Deny" });
    } else if (["select", "confirm", "input", "editor"].includes(frame.method)) {
      this.write({ type: "extension_ui_response", id: frame.id, cancelled: true });
    }
  }

  write(obj) {
    this.#log("in", obj);
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  waitFor(pred, from = 0, timeoutMs = REQUEST_MS) {
    const already = this.frames.slice(from).find(pred);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const w = {
        from,
        pred,
        resolve: (f) => {
          clearTimeout(t);
          resolve(f);
        },
      };
      const t = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`timeout after ${timeoutMs}ms waiting for frame`));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  async ready(timeoutMs = READY_MS) {
    await this.waitFor((f) => f.type === "ready", 0, timeoutMs);
    if ((this.frames[0].supportedProtocolVersions || []).includes(2)) {
      const r = await this.request({ type: "negotiate_protocol", protocolVersion: 2 });
      if (!r.success) throw new Error(`negotiate_protocol failed: ${JSON.stringify(r.error)}`);
    }
  }

  async request(cmd, timeoutMs = REQUEST_MS) {
    const id = `${this.label}-${++this.n}`;
    const mark = this.frames.length;
    this.write({ id, ...cmd });
    return this.waitFor((f) => f.type === "response" && f.id === id, mark, timeoutMs);
  }
}

// ---------------------------------------------------------------------------
// PARENT MODE: `node orphan-probe.mjs --as-parent <json config>`
// Represents the Pinion-like host process. Never self-exits; the driver kills it.
// ---------------------------------------------------------------------------
async function runAsParent(config) {
  const t0 = Date.now();
  const ctrl = (event, extra = {}) => process.stdout.write(`CTRL ${JSON.stringify({ event, t: Date.now() - t0, ...extra })}\n`);
  fs.mkdirSync(path.join(config.root, "frames"), { recursive: true });
  const link = new OmpLink(
    config.role,
    config.args,
    config.cwd,
    path.join(config.root, "frames", `${config.role}.jsonl`),
    path.join(config.root, "frames", `${config.role}.stderr.log`),
  );
  link.proc.on("exit", (code) => ctrl("ompExited", { code }));
  try {
    const readyStart = Date.now();
    await link.ready();
    ctrl("ready", { readyMs: Date.now() - readyStart });
    ctrl("ompPid", { pid: link.pid });
    if (config.role === "tool") {
      const mark = link.frames.length;
      const ack = await link.request({ type: "prompt", message: config.promptText }, 30_000);
      if (!ack.success) {
        ctrl("error", { phase: "promptAck", detail: JSON.stringify(ack) });
        return;
      }
      ctrl("promptAck", { agentInvoked: ack.data?.agentInvoked !== false });
      const startFrame = await link.waitFor((f) => f.type === "tool_execution_start" && f.toolName === "bash", mark, TOOL_START_MS);
      ctrl("toolStarted", { toolCallId: startFrame.toolCallId, args: startFrame.args });
    } else if (config.role === "idle") {
      await sleep(config.settleMs ?? 10_000);
      ctrl("settled", {});
    }
  } catch (e) {
    ctrl("error", { phase: "setup", message: e.message });
  }
  // Keep the event loop alive indefinitely; the driver terminates this process.
  await new Promise(() => {});
}

// ---------------------------------------------------------------------------
// DRIVER MODE: process-tree inspection helpers (Win32_Process via pwsh).
// ---------------------------------------------------------------------------
function snapshotProcesses() {
  const out = execFileSync(
    "pwsh",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Depth 3 -Compress -AsArray",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(out);
}

function pidAlive(pid) {
  try {
    const out = execFileSync(
      "pwsh",
      ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Measure-Object).Count`],
      { encoding: "utf8" },
    ).trim();
    return out === "1";
  } catch {
    return false;
  }
}

function childrenOf(pid, snap) {
  return snap.filter((p) => Number(p.ParentProcessId) === Number(pid));
}

function walkDescendants(rootPid, snap, maxDepth = 8) {
  const out = [];
  let frontier = [Number(rootPid)];
  const seen = new Set(frontier);
  let depth = 0;
  while (frontier.length && depth < maxDepth) {
    const next = [];
    for (const pid of frontier) {
      for (const c of childrenOf(pid, snap)) {
        const cpid = Number(c.ProcessId);
        if (seen.has(cpid)) continue;
        seen.add(cpid);
        out.push(c);
        next.push(cpid);
      }
    }
    frontier = next;
    depth++;
  }
  return out;
}

function toRow(p) {
  return { pid: Number(p.ProcessId), ppid: Number(p.ParentProcessId), name: p.Name, commandLine: (p.CommandLine || "").slice(0, 120) };
}

function confirmLineage(pid, tree, snap) {
  const rec = snap.find((p) => Number(p.ProcessId) === pid);
  if (!rec) return false;
  const treeIds = new Set(tree.map((r) => r.pid));
  const ppid = Number(rec.ParentProcessId);
  if (treeIds.has(ppid)) return true;
  const parentStillAlive = snap.some((p) => Number(p.ProcessId) === ppid);
  if (parentStillAlive) return false;
  const cmd = String(rec.CommandLine || "").toLowerCase();
  const name = String(rec.Name || "").toLowerCase();
  return cmd.includes("ping -n 120") || cmd.includes("ping") || name.includes("omp") || cmd.includes("omp") || name.includes("cmd") || name.includes("pwsh") || name.includes("bash");
}

function attachParentReader(child, onCtrl, onOther) {
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line) continue;
      if (line.startsWith("CTRL ")) {
        try {
          onCtrl(JSON.parse(line.slice(5)));
        } catch (e) {
          onOther(`CTRL-parse-error: ${line} (${e.message})`);
        }
      } else {
        onOther(line);
      }
    }
  });
  child.stderr.on("data", (d) => onOther(`stderr: ${d.toString("utf8")}`));
}

function spawnParent(config) {
  return spawn(process.execPath, [SELF_PATH, "--as-parent", JSON.stringify(config)], { stdio: "pipe", windowsHide: true });
}

// ---------------------------------------------------------------------------
// VARIANT 1: force-kill the parent mid-tool-execution; observe descendant survival.
// ---------------------------------------------------------------------------
async function runVariant1(root) {
  const cwd = path.join(root, "wt-tool");
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, "README.md"), "orphan probe worktree (tool variant)\n");
  const promptText =
    "Call the bash tool now with the command set to exactly `ping -n 120 127.0.0.1`. Do not explain first, do not run any other command, and do not wait for it to finish before responding.";
  const config = {
    role: "tool",
    root,
    cwd,
    args: ["--mode", "rpc-ui", "--approval-mode=yolo", "--model", MODEL, "--no-session"],
    promptText,
  };
  const parent = spawnParent(config);
  const P = parent.pid;
  const bus = makeWaiter();
  const unexpected = [];
  attachParentReader(parent, (e) => bus.push(e), (line) => unexpected.push(line));

  const result = { variant: "tool", parentPid: P, unexpected, events: bus.items };
  try {
    const ompPidEv = await bus.waitFor((e) => e.event === "ompPid" || e.event === "error", READY_MS);
    if (ompPidEv.event === "error") throw new Error(`parent reported error before ompPid: ${JSON.stringify(ompPidEv)}`);
    const ompPid = ompPidEv.pid;
    result.ompPid = ompPid;

    const toolEv = await bus.waitFor((e) => e.event === "toolStarted" || e.event === "error", TOOL_START_MS + READY_MS);
    if (toolEv.event === "error") throw new Error(`parent reported error waiting for tool start: ${JSON.stringify(toolEv)}`);
    result.toolStarted = toolEv;

    let descendants = [];
    let found = false;
    const pollStart = Date.now();
    while (Date.now() - pollStart < DESCENDANT_POLL_BUDGET_MS) {
      const snap = snapshotProcesses();
      descendants = walkDescendants(ompPid, snap);
      if (descendants.some((p) => String(p.CommandLine ?? "").toLowerCase().includes("ping"))) {
        found = true;
        break;
      }
    }
    result.foundPingDescendant = found;
    result.descendantPollMs = Date.now() - pollStart;
    result.tree = [
      { pid: ompPid, ppid: P, name: "omp.exe", commandLine: "(root; pid reported by parent via CTRL ompPid)" },
      ...descendants.map(toRow),
    ];

    const killMoment = Date.now();
    try {
      execFileSync("taskkill", ["/PID", String(P), "/F"], { stdio: "ignore" });
    } catch (e) {
      result.killError = e.message;
    }
    const parentExit = new Promise((resolve) => parent.on("exit", (code, signal) => resolve({ code, signal })));
    result.parentExit = await Promise.race([parentExit, sleep(5000).then(() => ({ code: null, signal: "no-exit-event-in-5s" }))]);

    const timeline = [];
    for (const off of SURVIVOR_OFFSETS_MS) {
      const wait = killMoment + off - Date.now();
      if (wait > 0) await sleep(wait);
      const snap = snapshotProcesses();
      const byPid = new Map(snap.map((p) => [Number(p.ProcessId), p]));
      const rows = result.tree.map((orig) => {
        const rec = byPid.get(orig.pid);
        if (!rec) return { pid: orig.pid, name: orig.name, status: "GONE" };
        const nameMatches = String(rec.Name).toLowerCase() === String(orig.name).toLowerCase();
        return { pid: orig.pid, name: orig.name, status: nameMatches ? "ALIVE" : "ALIVE(name-mismatch, possible pid reuse)" };
      });
      timeline.push({ offsetMs: off, tMs: Date.now() - killMoment, rows });
    }
    result.timeline = timeline;

    const finalSnap = snapshotProcesses();
    const cleanup = [];
    for (const row of timeline[timeline.length - 1].rows) {
      if (row.status.startsWith("ALIVE")) {
        const ok = confirmLineage(row.pid, result.tree, finalSnap);
        if (!ok) {
          cleanup.push({ pid: row.pid, action: "skipped-lineage-unconfirmed" });
          continue;
        }
        try {
          execFileSync("taskkill", ["/PID", String(row.pid), "/F"], { stdio: "ignore" });
          cleanup.push({ pid: row.pid, action: "killed" });
        } catch (e) {
          cleanup.push({ pid: row.pid, action: "kill-failed", error: e.message });
        }
      }
    }
    result.cleanup = cleanup;
  } catch (e) {
    result.error = e.message;
    try {
      execFileSync("taskkill", ["/PID", String(P), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// VARIANT 2: idle omp children (MCP/LSP) under the user's normal, unmodified config.
// No tool prompt; cleaned up as a whole tree since this variant is not testing crash survival.
// ---------------------------------------------------------------------------
async function runVariant2(root) {
  const cwd = path.join(root, "wt-idle");
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, "README.md"), "orphan probe worktree (idle variant)\n");
  const config = {
    role: "idle",
    root,
    cwd,
    args: ["--mode", "rpc-ui", "--approval-mode=always-ask", "--model", MODEL],
    settleMs: 10_000,
  };
  const parent = spawnParent(config);
  const P = parent.pid;
  const bus = makeWaiter();
  const unexpected = [];
  attachParentReader(parent, (e) => bus.push(e), (line) => unexpected.push(line));
  const result = { variant: "idle", parentPid: P, unexpected };
  try {
    const ompPidEv = await bus.waitFor((e) => e.event === "ompPid" || e.event === "error", READY_MS);
    if (ompPidEv.event === "error") throw new Error(`parent reported error before ompPid: ${JSON.stringify(ompPidEv)}`);
    result.ompPid = ompPidEv.pid;
    const settledOrErr = await bus.waitFor((e) => e.event === "settled" || e.event === "error", READY_MS + 15_000);
    if (settledOrErr.event === "error") throw new Error(`parent reported error waiting to settle: ${JSON.stringify(settledOrErr)}`);
    const snap = snapshotProcesses();
    const tree = walkDescendants(result.ompPid, snap);
    result.idleChildren = tree.map(toRow);
    if (tree.length === 0) result.note = "no children observed under omp at the idle settle point (10s after ready)";
  } catch (e) {
    result.error = e.message;
  } finally {
    try {
      execFileSync("taskkill", ["/PID", String(P), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// VARIANT 3: Windows Job Object KILL_ON_JOB_CLOSE proof via koffi FFI (no native
// compile step: koffi ships prebuilt binaries for win32-x64).
// ---------------------------------------------------------------------------
const JOB_PARENT_SOURCE = `import koffi from "koffi";
import { spawn } from "node:child_process";

const k32 = koffi.load("kernel32.dll");
const CreateJobObjectW = k32.func("__stdcall", "CreateJobObjectW", "void *", ["void *", "void *"]);
const OpenProcess = k32.func("__stdcall", "OpenProcess", "void *", ["uint32", "int", "uint32"]);
const SetInformationJobObject = k32.func("__stdcall", "SetInformationJobObject", "int", ["void *", "int", "void *", "uint32"]);
const AssignProcessToJobObject = k32.func("__stdcall", "AssignProcessToJobObject", "int", ["void *", "void *"]);
const GetLastError = k32.func("__stdcall", "GetLastError", "uint32", []);

const hJob = CreateJobObjectW(null, null);
if (!hJob) throw new Error("CreateJobObjectW failed, GetLastError=" + GetLastError());

// JOBOBJECT_EXTENDED_LIMIT_INFORMATION, x64 layout: 144 bytes total.
// BasicLimitInformation.LimitFlags (DWORD) sits at offset 16.
const buf = Buffer.alloc(144);
buf.writeUInt32LE(0x2000, 16); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE

const JobObjectExtendedLimitInformation = 9;
const setOk = SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, buf, buf.length);

const child = spawn("ping", ["-n", "60", "127.0.0.1"], { windowsHide: true, stdio: "ignore" });

// PROCESS_TERMINATE (0x0001) | PROCESS_SET_QUOTA (0x0100)
const hProc = OpenProcess(0x0101, 0, child.pid);
const assignOk = AssignProcessToJobObject(hJob, hProc);

process.stdout.write(
  "CTRL " + JSON.stringify({ event: "ready", parentPid: process.pid, childPid: child.pid, setOk: !!setOk, assignOk: !!assignOk }) + "\\n",
);

await new Promise(() => {});
`;

async function runKoffiProof(root) {
  const proj = path.join(root, "koffi-proof");
  fs.mkdirSync(proj, { recursive: true });
  const out = { attempted: true };
  try {
    const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    execFileSync(process.execPath, [npmCli, "install", "--no-audit", "--no-fund", "koffi"], { cwd: proj, stdio: "pipe", timeout: 120_000 });
  } catch (e) {
    return { attempted: true, installed: false, verified: false, note: `npm install koffi failed: ${e.message}` };
  }
  out.installed = true;
  const parentPath = path.join(proj, "job-parent.mjs");
  fs.writeFileSync(parentPath, JOB_PARENT_SOURCE);
  const parent = spawn(process.execPath, [parentPath], { cwd: proj, stdio: "pipe", windowsHide: true });
  const bus = makeWaiter();
  const unexpected = [];
  attachParentReader(parent, (e) => bus.push(e), (l) => unexpected.push(l));
  out.parentPid = parent.pid;
  out.unexpected = unexpected;
  try {
    const readyEv = await bus.waitFor((e) => e.event === "ready", 20_000);
    out.childPid = readyEv.childPid;
    out.setOk = readyEv.setOk;
    out.assignOk = readyEv.assignOk;
    await sleep(500);
    out.beforeKill = { parentAlive: pidAlive(parent.pid), childAlive: pidAlive(out.childPid) };
    execFileSync("taskkill", ["/PID", String(parent.pid), "/F"], { stdio: "ignore" });
    const killMoment = Date.now();
    const timeline = [];
    for (const off of [1_000, 3_000]) {
      const wait = killMoment + off - Date.now();
      if (wait > 0) await sleep(wait);
      timeline.push({ offsetMs: off, parentAlive: pidAlive(parent.pid), childAlive: pidAlive(out.childPid) });
    }
    out.timeline = timeline;
    out.verified =
      out.beforeKill.childAlive && timeline.every((r) => !r.parentAlive) && !timeline[timeline.length - 1].childAlive;
  } catch (e) {
    out.error = e.message;
    out.verified = false;
    try {
      execFileSync("taskkill", ["/PID", String(parent.pid), "/F"], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
    if (out.childPid) {
      try {
        execFileSync("taskkill", ["/PID", String(out.childPid), "/F"], { stdio: "ignore" });
      } catch {
        /* already gone */
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
function tryVersion() {
  try {
    return execFileSync(OMP, ["--version"], { encoding: "utf8" }).trim();
  } catch (e) {
    console.error(`omp not found; set PINION_OMP (${e.message})`);
    process.exit(2);
  }
}

function printVariant1(v) {
  console.log("\n=== Variant 1: force-kill Pinion-like parent mid bash-tool run ===");
  console.log(`parentPid=${v.parentPid} ompPid=${v.ompPid ?? "?"}`);
  if (v.unexpected.length) console.log("unexpected parent stdout lines:", v.unexpected);
  if (v.error) {
    console.log(`ERROR: ${v.error}`);
    return;
  }
  console.log(`foundPingDescendant=${v.foundPingDescendant} (polled ${v.descendantPollMs}ms)`);
  console.log("descendant tree at kill time:");
  for (const r of v.tree) console.log(`  pid=${r.pid} ppid=${r.ppid} name=${r.name} cmd=${r.commandLine}`);
  console.log(`killed parent /PID ${v.parentPid} /F ; parent exit=${JSON.stringify(v.parentExit)}`);
  console.log("survivor timeline:");
  for (const row of v.timeline) {
    console.log(`  target +${row.offsetMs}ms (actual +${row.tMs}ms): ` + row.rows.map((r) => `${r.name}(${r.pid})=${r.status}`).join(", "));
  }
  console.log("cleanup:", JSON.stringify(v.cleanup));
}

function printVariant2(v) {
  console.log("\n=== Variant 2: idle omp children (MCP/LSP) under normal config ===");
  console.log(`parentPid=${v.parentPid} ompPid=${v.ompPid ?? "?"}`);
  if (v.unexpected.length) console.log("unexpected parent stdout lines:", v.unexpected);
  if (v.error) {
    console.log(`ERROR: ${v.error}`);
    return;
  }
  if (v.note) console.log(v.note);
  for (const r of v.idleChildren ?? []) console.log(`  pid=${r.pid} ppid=${r.ppid} name=${r.name} cmd=${r.commandLine}`);
}

function printKoffi(k) {
  console.log("\n=== Variant 3: koffi Job Object (KILL_ON_JOB_CLOSE) proof ===");
  console.log(JSON.stringify(k, null, 2));
}

async function runDriver() {
  const ompVersion = tryVersion();
  const root = path.join(os.tmpdir(), "pinion-orphan-probe", new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(root, { recursive: true });
  console.log(`omp ${ompVersion} | model ${MODEL}\nscratch ${root}\n`);

  const variant1 = await runVariant1(root);
  printVariant1(variant1);

  const variant2 = await runVariant2(root);
  printVariant2(variant2);

  const koffi = await runKoffiProof(root);
  printKoffi(koffi);

  const result = { ompVersion, model: MODEL, scratch: root, variant1, variant2, koffi };
  fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(result, null, 2));
  console.log(`\nresult.json written to ${path.join(root, "result.json")}`);
}

const asParentIdx = process.argv.indexOf("--as-parent");
if (asParentIdx >= 0) {
  const config = JSON.parse(process.argv[asParentIdx + 1]);
  await runAsParent(config);
} else {
  await runDriver();
}
