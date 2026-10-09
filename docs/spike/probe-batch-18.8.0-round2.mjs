// Probe batch round 2 (B2/B5, #520): remaining items after round 1 (probe-batch-18.8.0.mjs)
// left several inconclusive. Same read-only intent, scratch --session-dir under
// os.tmpdir(), real signed-in default profile, --approval-mode=yolo.
//
// Covers: item 10 end-to-end (host tool call, now as a session's SECOND turn,
// after a cheap warm-up turn, to rule out the first-turn-cost hypothesis from
// round 1), item 3 (@path expansion, also as a later turn), item 12 (/shake,
// /shake elide, /shake images, /shake thinking and their messageCount effect).
//
// Run:  node docs/spike/probe-batch-18.8.0-round2.mjs

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const OMP = process.env.PINION_OMP || "omp";
const READY_MS = 120_000;
const REQUEST_MS = 60_000;
const EXIT_MS = 30_000;

const ROOT = path.join(os.tmpdir(), "pinion-probe-batch-520-round2", new Date().toISOString().replace(/[:.]/g, "-"));
const dir = (name) => path.join(ROOT, name);
for (const d of ["wt", "frames", "sessions"]) fs.mkdirSync(dir(d), { recursive: true });
fs.writeFileSync(path.join(dir("wt"), "README.md"), "probe-batch-520 round-2 scratch worktree\n");

function safeName(label) { return label.replace(/[^a-zA-Z0-9_-]/g, "_"); }

class OmpProc {
  constructor(label, sessionDir, extraArgs = []) {
    this.label = label;
    this.waiters = [];
    this.frames = [];
    this.buf = Buffer.alloc(0);
    this.exited = false;
    this.log = fs.createWriteStream(path.join(dir("frames"), `${safeName(label)}.jsonl`));
    this.errLog = fs.createWriteStream(path.join(dir("frames"), `${safeName(label)}.stderr.log`));
    const args = ["--mode", "rpc-ui", "--approval-mode=yolo", "--session-dir", sessionDir, ...extraArgs];
    this.startedAt = Date.now();
    this.child = spawn(OMP, args, { cwd: dir("wt"), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.exitPromise = new Promise((resolve) => {
      this.child.on("exit", (code) => { this.exited = true; this.exitCode = code ?? -1; resolve(code); });
      this.child.on("error", (e) => { console.error(`[${label}] spawn not found: ${e.message}`); this.exited = true; resolve(-1); });
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
    for (let idx = this.waiters.length - 1; idx >= 0; idx--) {
      const w = this.waiters[idx];
      if (w.pred(frame)) { this.waiters.splice(idx, 1); w.resolve(frame); }
    }
  }
  waitFor(pred, timeoutMs, what) {
    for (const f of this.frames) if (pred(f)) return Promise.resolve(f);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); reject(new Error(`timeout after ${timeoutMs}ms waiting for ${what}`)); }, timeoutMs);
      const w = { pred, resolve: (f) => { clearTimeout(t); resolve(f); } };
      this.waiters.push(w);
    });
  }
  async ready() {
    const r = await Promise.race([this.waitFor((f) => f.type === "ready", READY_MS, "ready frame"), this.exitPromise.then((c) => ({ ok: false, exitCode: c }))]);
    if (r && r.ok === false) throw new Error(`process exited before ready (code ${r.exitCode})`);
    return r;
  }
  async send(cmd, timeoutMs = REQUEST_MS) {
    this.log.write(JSON.stringify({ _sent: cmd }) + "\n");
    this.child.stdin.write(JSON.stringify(cmd) + "\n");
    return this.waitFor((f) => f.type === "response" && f.id === cmd.id, timeoutMs, `response to ${cmd.type}`);
  }
  async closeGracefully() {
    this.child.stdin.end();
    const done = await Promise.race([this.exitPromise.then(() => true), new Promise((r) => setTimeout(() => r(false), EXIT_MS))]);
    if (!done) { try { execFileSync("taskkill", ["/PID", String(this.child.pid), "/T", "/F"]); } catch (e) { } }
  }
}

let ompVersion = "unknown";
try { ompVersion = execFileSync(OMP, ["--version"], { encoding: "utf8" }).trim(); }
catch (e) { console.error(`omp not found (${e.message})`); process.exit(2); }
console.log(`omp ${ompVersion}\nscratch ${ROOT}\n`);

const results = { ompVersion, scratchRoot: ROOT, items: {} };
let failed = false;
let proc;
try {
  proc = new OmpProc("r2", dir("sessions"));
  await proc.ready();

  const hostTools = await proc.send({
    id: "h1", type: "set_host_tools",
    tools: [{ name: "echo_host_probe2", label: "Echo Host Probe 2", description: "Echo a fixed string back. Call this whenever asked to.", parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false }, loadMode: "essential" }],
  });
  results.items.item10_setup = { success: hostTools.success, toolNames: hostTools.data?.toolNames };

  // Warm-up turn (first turn in this session): deliberately trivial.
  const warm = await proc.send({ id: "w1", type: "prompt", message: "Reply with just the single word: hello" });
  results.items.warmup_ack = { success: warm.success, agentInvoked: warm.data?.agentInvoked };
  const warmResult = await proc.waitFor((f) => f.type === "prompt_result" && f.id === "w1", REQUEST_MS, "prompt_result w1");
  results.items.warmup_result = { status: warmResult.status };

  // Item 10, second turn: host tool call.
  const probeToken = "PINION-PROBE2-18.8.0-OK";
  const p1 = await proc.send({ id: "h2", type: "prompt", message: `Call the echo_host_probe2 tool with message "${probeToken}" and nothing else.` });
  results.items.item10_prompt_ack = { success: p1.success, agentInvoked: p1.data?.agentInvoked };
  let hostToolCallFrame = null;
  try {
    hostToolCallFrame = await proc.waitFor((f) => f.type === "host_tool_call" && f.name === "echo_host_probe2", REQUEST_MS, "host_tool_call echo_host_probe2");
    proc.child.stdin.write(JSON.stringify({ type: "host_tool_result", id: hostToolCallFrame.id, result: { content: [{ type: "text", text: `echoed:${hostToolCallFrame.arguments?.message}` }] } }) + "\n");
  } catch (e) { results.items.item10_hostToolCallError = e.message; }
  try {
    const pr = await proc.waitFor((f) => f.type === "prompt_result" && f.id === "h2", REQUEST_MS, "prompt_result h2");
    results.items.item10_prompt_result = { status: pr.status };
  } catch (e) { results.items.item10_prompt_result = { error: e.message }; }
  results.items.item10_final = { hostToolCallReceived: !!hostToolCallFrame, hostToolCallArgs: hostToolCallFrame?.arguments };

  // Item 3, third turn: @path expansion with a tiny marker file.
  const atPathMarker = "PINION-ATPATH2-MARKER-91ab";
  fs.writeFileSync(path.join(dir("wt"), "atpath-probe2.txt"), `${atPathMarker}\nscratch file for the @path probe (round 2).\n`);
  try {
    const p2 = await proc.send({ id: "a1", type: "prompt", message: "Read @atpath-probe2.txt and reply with ONLY its first line, nothing else." });
    results.items.item3_ack = { success: p2.success };
    await proc.waitFor((f) => f.type === "prompt_result" && f.id === "a1", REQUEST_MS, "prompt_result a1");
    const last = await proc.send({ id: "a2", type: "get_last_assistant_text" });
    results.items.item3 = { replyText: last.data, markerEchoed: typeof last.data === "string" && last.data.includes(atPathMarker) };
  } catch (e) {
    results.items.item3 = { error: e.message };
  }

  // Item 12: build some real content (thinking + a file read), then /shake variants.
  try {
    const stateBefore = await proc.send({ id: "s0", type: "get_state" });
    await proc.send({ id: "c1", type: "prompt", message: "Read @docs/DESIGN.md and summarize its first section in exactly 2 short sentences. Think step by step before answering." });
    await proc.waitFor((f) => f.type === "prompt_result" && f.id === "c1", REQUEST_MS, "prompt_result c1");
    const stateAfterContent = await proc.send({ id: "s1", type: "get_state" });
    results.items.item12_content = { messageCountBefore: stateBefore.data?.messageCount, messageCountAfterContent: stateAfterContent.data?.messageCount };

    const shakeOutputs = {};
    for (const variant of ["/shake", "/shake elide", "/shake images", "/shake thinking"]) {
      const id = `shake_${safeName(variant)}`;
      const r = await proc.send({ id, type: "prompt", message: variant }, 30_000);
      // Local slash commands may emit command_output frames; collect any that
      // arrive within a short window after the ack.
      const outputs = [];
      const start = Date.now();
      while (Date.now() - start < 5_000) {
        try {
          const f = await proc.waitFor((fr) => fr.type === "command_output" && !outputs.includes(fr), 1_000, "command_output");
          outputs.push(f);
        } catch (e) { break; }
      }
      const stateAfter = await proc.send({ id: `${id}_state`, type: "get_state" });
      shakeOutputs[variant] = { ack: { success: r.success, agentInvoked: r.data?.agentInvoked }, outputTexts: outputs.map((o) => o.text ?? o.content ?? JSON.stringify(o)), messageCountAfter: stateAfter.data?.messageCount };
    }
    results.items.item12 = shakeOutputs;
  } catch (e) {
    results.items.item12 = { error: e.message };
  }

  const stateFinal = await proc.send({ id: "zz", type: "get_state" });
  results.sessionFile = stateFinal.data?.sessionFile;
  await proc.closeGracefully();
} catch (e) {
  failed = true;
  results.error = e.message;
  console.error("ROUND2 PROBE FAILED", e.stack ?? e.message);
} finally {
  try { if (proc && !proc.exited) execFileSync("taskkill", ["/PID", String(proc.child.pid), "/T", "/F"]); } catch (e) { }
}

fs.writeFileSync(path.join(ROOT, "result.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
console.log(`\nscratch dir (left on disk): ${ROOT}`);
process.exit(failed ? 1 : 0);
