// Real Job Object probe (Issue #12 follow-up): assign the ACTUAL omp process (not a bare
// child) to a Windows Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE immediately after
// spawn, drive the same bash `ping -n 120 127.0.0.1` prompt used by orphan-probe.mjs, force-
// kill only the parent (no /T), and see whether every descendant (ping.exe, its conhost, and
// omp's own MCP-server children) dies with it. Runs twice: once with the job assignment done
// as fast as possible after spawn() returns, once with it deliberately delayed 1500ms, to show
// what (if anything) escapes the job when assignment is late.
//
// Run:  node docs/spike/job-object-probe.mjs
// Env:  PINION_OMP          omp executable (default "omp" from PATH)
//       PINION_PROBE_MODEL  model id (default github-copilot/gpt-5.6-luna)
//
// This script installs `koffi` (prebuilt binary, no native compile step) into a scratch
// project dir under os.tmpdir() and spawns at most one omp process at a time.

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

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
// Shared CTRL-event bus (used both for raw omp frames inside OmpLink and for
// parsed CTRL lines the driver reads from a parent's stdout).
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
      const w = { pred, resolve: (v) => { clearTimeout(t); resolve(v); } };
      const t = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error("timeout waiting for CTRL event"));
      }, timeoutMs);
      waiters.push(w);
    });
  }
  return { push, waitFor, items };
}

// ---------------------------------------------------------------------------
// PARENT-SIDE: raw JSONL RPC link to one omp child process (same shape as
// docs/spike/resume-probe.mjs's OmpProc / docs/spike/orphan-probe.mjs's OmpLink).
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
      const w = { from, pred, resolve: (f) => { clearTimeout(t); resolve(f); } };
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
// koffi FFI: Job Object (create + KILL_ON_JOB_CLOSE) and Toolhelp32 process
// enumeration (fast, in-process — avoids pwsh's ~1-4s startup cost so it can
// run right at the assignment instant without perturbing the timing measurement).
// ---------------------------------------------------------------------------
async function loadWin32(koffiModulePath) {
  const koffi = (await import(pathToFileURL(koffiModulePath).href)).default;
  const k32 = koffi.load("kernel32.dll");
  const CreateJobObjectW = k32.func("__stdcall", "CreateJobObjectW", "void *", ["void *", "void *"]);
  const OpenProcess = k32.func("__stdcall", "OpenProcess", "void *", ["uint32", "int", "uint32"]);
  const SetInformationJobObject = k32.func("__stdcall", "SetInformationJobObject", "int", ["void *", "int", "void *", "uint32"]);
  const AssignProcessToJobObject = k32.func("__stdcall", "AssignProcessToJobObject", "int", ["void *", "void *"]);
  const GetLastError = k32.func("__stdcall", "GetLastError", "uint32", []);
  const CreateToolhelp32Snapshot = k32.func("__stdcall", "CreateToolhelp32Snapshot", "void *", ["uint32", "uint32"]);
  const PROCESSENTRY32W = koffi.struct("PROCESSENTRY32W", {
    dwSize: "uint32",
    cntUsage: "uint32",
    th32ProcessID: "uint32",
    th32DefaultHeapID: "uintptr",
    th32ModuleID: "uint32",
    cntThreads: "uint32",
    th32ParentProcessID: "uint32",
    pcPriClassBase: "int32",
    dwFlags: "uint32",
    szExeFile: koffi.array("uint16", 260),
  });
  const Process32FirstW = k32.func("__stdcall", "Process32FirstW", "bool", ["void *", koffi.inout(koffi.pointer(PROCESSENTRY32W))]);
  const Process32NextW = k32.func("__stdcall", "Process32NextW", "bool", ["void *", koffi.inout(koffi.pointer(PROCESSENTRY32W))]);
  const CloseHandle = k32.func("__stdcall", "CloseHandle", "bool", ["void *"]);

  function utf16ToString(arr) {
    let end = arr.indexOf(0);
    if (end < 0) end = arr.length;
    return String.fromCharCode(...arr.slice(0, end));
  }

  function listProcesses() {
    const TH32CS_SNAPPROCESS = 0x00000002;
    const snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    const entries = [];
    const entry = { dwSize: koffi.sizeof(PROCESSENTRY32W) };
    let ok = Process32FirstW(snap, entry);
    while (ok) {
      entries.push({ pid: entry.th32ProcessID, ppid: entry.th32ParentProcessID, name: utf16ToString(entry.szExeFile) });
      ok = Process32NextW(snap, entry);
    }
    CloseHandle(snap);
    return entries;
  }

  function createKillOnCloseJob() {
    const hJob = CreateJobObjectW(null, null);
    if (!hJob) throw new Error(`CreateJobObjectW failed, GetLastError=${GetLastError()}`);
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION, x64: 144 bytes; BasicLimitInformation.LimitFlags
    // (DWORD) at offset 16. Verified against a live kill in docs/spike/orphan-probe.mjs variant 3.
    const buf = Buffer.alloc(144);
    buf.writeUInt32LE(0x2000, 16); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    const JobObjectExtendedLimitInformation = 9;
    const setOk = !!SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, buf, buf.length);
    return { hJob, setOk };
  }

  function assignPidToJob(hJob, pid) {
    // PROCESS_TERMINATE (0x0001) | PROCESS_SET_QUOTA (0x0100)
    const hProc = OpenProcess(0x0101, 0, pid);
    if (!hProc) return { assignOk: false, error: `OpenProcess failed, GetLastError=${GetLastError()}` };
    const assignOk = !!AssignProcessToJobObject(hJob, hProc);
    return { assignOk, error: assignOk ? undefined : `AssignProcessToJobObject failed, GetLastError=${GetLastError()}` };
  }

  return { listProcesses, createKillOnCloseJob, assignPidToJob };
}

// ---------------------------------------------------------------------------
// PARENT MODE: `node job-object-probe.mjs --as-parent <json config>`
// ---------------------------------------------------------------------------
async function runAsParent(config) {
  const t0 = Date.now();
  const ctrl = (event, extra = {}) => process.stdout.write(`CTRL ${JSON.stringify({ event, t: Date.now() - t0, ...extra })}\n`);
  fs.mkdirSync(path.join(config.root, "frames"), { recursive: true });

  const win32 = await loadWin32(config.koffiModulePath);
  const { hJob, setOk } = win32.createKillOnCloseJob();
  ctrl("jobCreated", { setOk });

  const spawnMoment = Date.now();
  const link = new OmpLink(
    config.label,
    config.args,
    config.cwd,
    path.join(config.root, "frames", `${config.label}.jsonl`),
    path.join(config.root, "frames", `${config.label}.stderr.log`),
  );
  link.proc.on("exit", (code) => ctrl("ompExited", { code }));
  ctrl("ompPid", { pid: link.pid });

  if (config.assignDelayMs > 0) await sleep(config.assignDelayMs);

  const assignStart = Date.now();
  const { assignOk, error: assignError } = win32.assignPidToJob(hJob, link.pid);
  const assignEnd = Date.now();
  const descendantsAtAssignment = win32.listProcesses().filter((p) => p.ppid === link.pid);
  ctrl("assigned", {
    spawnToAssignStartMs: assignStart - spawnMoment,
    assignCallMs: assignEnd - assignStart,
    assignOk,
    assignError,
    descendantsAtAssignmentCount: descendantsAtAssignment.length,
    descendantsAtAssignment,
  });

  try {
    const readyStart = Date.now();
    await link.ready();
    ctrl("ready", { readyMs: Date.now() - readyStart });
    const mark = link.frames.length;
    const ack = await link.request({ type: "prompt", message: config.promptText }, 30_000);
    if (!ack.success) {
      ctrl("error", { phase: "promptAck", detail: JSON.stringify(ack) });
      return;
    }
    ctrl("promptAck", { agentInvoked: ack.data?.agentInvoked !== false });
    const startFrame = await link.waitFor((f) => f.type === "tool_execution_start" && f.toolName === "bash", mark, TOOL_START_MS);
    ctrl("toolStarted", { toolCallId: startFrame.toolCallId, args: startFrame.args });
  } catch (e) {
    ctrl("error", { phase: "setup", message: e.message });
  }
  await new Promise(() => {}); // keep alive; the driver terminates this process
}

// ---------------------------------------------------------------------------
// DRIVER-SIDE process-tree helpers (Win32_Process via pwsh — used for the full
// descendant tree and the survival poll, which are not timing-critical).
// ---------------------------------------------------------------------------
function snapshotProcesses() {
  const out = execFileSync(
    "pwsh",
    ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Depth 3 -Compress -AsArray"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(out);
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
  return cmd.includes("ping") || name.includes("omp") || cmd.includes("omp") || name.includes("cmd") || name.includes("pwsh") || name.includes("bash");
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

// ---------------------------------------------------------------------------
// One end-to-end run: spawn parent, create+assign job, drive bash tool, kill
// parent (no /T), poll descendant survival.
// ---------------------------------------------------------------------------
async function runOnce(root, label, assignDelayMs, koffiModulePath) {
  const cwd = path.join(root, `wt-${label}`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, "README.md"), `job-object probe worktree (${label})\n`);
  const promptText =
    "Call the bash tool now with the command set to exactly `ping -n 120 127.0.0.1`. Do not explain first, do not run any other command, and do not wait for it to finish before responding.";
  const config = {
    label,
    root,
    cwd,
    args: ["--mode", "rpc-ui", "--approval-mode=yolo", "--model", MODEL, "--no-session"],
    promptText,
    assignDelayMs,
    koffiModulePath,
  };
  const parent = spawn(process.execPath, [SELF_PATH, "--as-parent", JSON.stringify(config)], { stdio: "pipe", windowsHide: true });
  const P = parent.pid;
  const bus = makeWaiter();
  const unexpected = [];
  attachParentReader(parent, (e) => bus.push(e), (line) => unexpected.push(line));

  const result = { label, assignDelayMs, parentPid: P, unexpected };
  try {
    const ompPidEv = await bus.waitFor((e) => e.event === "ompPid" || e.event === "error", READY_MS);
    if (ompPidEv.event === "error") throw new Error(`parent error before ompPid: ${JSON.stringify(ompPidEv)}`);
    const ompPid = ompPidEv.pid;
    result.ompPid = ompPid;

    const assignedEv = await bus.waitFor((e) => e.event === "assigned", READY_MS);
    result.assignment = {
      spawnToAssignStartMs: assignedEv.spawnToAssignStartMs,
      assignCallMs: assignedEv.assignCallMs,
      assignOk: assignedEv.assignOk,
      assignError: assignedEv.assignError,
      descendantsAtAssignmentCount: assignedEv.descendantsAtAssignmentCount,
      descendantsAtAssignment: assignedEv.descendantsAtAssignment,
    };

    const toolEv = await bus.waitFor((e) => e.event === "toolStarted" || e.event === "error", TOOL_START_MS + READY_MS);
    if (toolEv.event === "error") throw new Error(`parent error waiting for tool start: ${JSON.stringify(toolEv)}`);
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

    result.escaped = result.tree
      .filter((orig) => (result.assignment.descendantsAtAssignment || []).some((d) => d.pid === orig.pid))
      .map((orig) => orig.pid);
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

function printResult(r) {
  console.log(`\n=== ${r.label} (assignDelayMs=${r.assignDelayMs}) ===`);
  console.log(`parentPid=${r.parentPid} ompPid=${r.ompPid ?? "?"}`);
  if (r.unexpected.length) console.log("unexpected parent stdout lines:", r.unexpected);
  if (r.error) {
    console.log(`ERROR: ${r.error}`);
    return;
  }
  console.log(
    `assignment: spawnToAssignStartMs=${r.assignment.spawnToAssignStartMs} assignCallMs=${r.assignment.assignCallMs} assignOk=${r.assignment.assignOk} descendantsAtAssignmentCount=${r.assignment.descendantsAtAssignmentCount}`,
  );
  if (r.assignment.descendantsAtAssignmentCount) console.log("  descendants already present at assignment:", JSON.stringify(r.assignment.descendantsAtAssignment));
  console.log(`foundPingDescendant=${r.foundPingDescendant} (polled ${r.descendantPollMs}ms)`);
  console.log("descendant tree at kill time:");
  for (const row of r.tree) console.log(`  pid=${row.pid} ppid=${row.ppid} name=${row.name} cmd=${row.commandLine}`);
  console.log(`killed parent /PID ${r.parentPid} /F ; parent exit=${JSON.stringify(r.parentExit)}`);
  console.log("survivor timeline:");
  for (const row of r.timeline) console.log(`  target +${row.offsetMs}ms (actual +${row.tMs}ms): ` + row.rows.map((x) => `${x.name}(${x.pid})=${x.status}`).join(", "));
  console.log("cleanup:", JSON.stringify(r.cleanup));
  console.log("escaped (present at assignment time, i.e. pre-existed the job):", JSON.stringify(r.escaped));
}

function tryVersion() {
  try {
    return execFileSync(OMP, ["--version"], { encoding: "utf8" }).trim();
  } catch (e) {
    console.error(`omp not found; set PINION_OMP (${e.message})`);
    process.exit(2);
  }
}

async function runDriver() {
  const ompVersion = tryVersion();
  const root = path.join(os.tmpdir(), "pinion-job-object-probe", new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(root, { recursive: true });
  console.log(`omp ${ompVersion} | model ${MODEL}\nscratch ${root}\n`);

  const koffiProj = path.join(root, "koffi-proj");
  fs.mkdirSync(koffiProj, { recursive: true });
  const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  execFileSync(process.execPath, [npmCli, "install", "--no-audit", "--no-fund", "koffi"], { cwd: koffiProj, stdio: "pipe", timeout: 120_000 });
  const koffiModulePath = path.join(koffiProj, "node_modules", "koffi", "index.js");
  if (!fs.existsSync(koffiModulePath)) throw new Error(`koffi entry point not found at ${koffiModulePath}`);

  const immediate = await runOnce(root, "immediate-assign", 0, koffiModulePath);
  printResult(immediate);

  const delayed = await runOnce(root, "delayed-1500ms-assign", 1500, koffiModulePath);
  printResult(delayed);

  fs.writeFileSync(path.join(root, "result.json"), JSON.stringify({ ompVersion, model: MODEL, scratch: root, immediate, delayed }, null, 2));
  console.log(`\nresult.json written to ${path.join(root, "result.json")}`);
}

const asParentIdx = process.argv.indexOf("--as-parent");
if (asParentIdx >= 0) {
  const config = JSON.parse(process.argv[asParentIdx + 1]);
  await runAsParent(config);
} else {
  await runDriver();
}
