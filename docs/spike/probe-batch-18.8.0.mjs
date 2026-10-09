// Probe batch (B2/B5, #520): re-verify Refract's OMP RPC contract assumptions on the
// installed omp 18.8.0 (NOT 18.6.3 exactly -- no 18.6.3 binary exists on this machine;
// 18.8.0 is the oldest version this probe can run against, and it is >= the 18.6.3
// minimum the plan wants verified). Covers probe-batch items 1, 3, 6, 10, 14, 15, 16,
// 17, 19 against the real signed-in default profile in a scratch --session-dir under
// os.tmpdir(). READ-ONLY intent: no destructive git/config calls, no --profile config
// mutation. Spends real model calls (small, short turns only), per the issue's own
// "signed-in probe" rule.
//
// Run:  node docs/spike/probe-batch-18.8.0.mjs
// Env:  PINION_OMP  omp executable (default "omp" from PATH)

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const OMP = process.env.PINION_OMP || "omp";
const READY_MS = 120_000;
const REQUEST_MS = 60_000;
const EXIT_MS = 30_000;

const ROOT = path.join(os.tmpdir(), "pinion-probe-batch-520", new Date().toISOString().replace(/[:.]/g, "-"));
const dir = (name) => path.join(ROOT, name);
for (const d of ["wt", "frames", "sessions"]) fs.mkdirSync(dir(d), { recursive: true });
fs.writeFileSync(path.join(dir("wt"), "README.md"), "probe-batch-520 scratch worktree\n");

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
    this.log = fs.createWriteStream(path.join(dir("frames"), `${safeName(label)}.jsonl`));
    this.errLog = fs.createWriteStream(path.join(dir("frames"), `${safeName(label)}.stderr.log`));
    const args = ["--mode", "rpc-ui", "--approval-mode=yolo", "--session-dir", sessionDir, ...extraArgs];
    this.startedAt = Date.now();
    this.child = spawn(OMP, args, { cwd: dir("wt"), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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

const results = { ompVersion, scratchRoot: ROOT, items: {} };

function onePx1x1PngBase64() {
  // Smallest valid 1x1 transparent PNG, for abort_and_restore_queue image test.
  return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
}

let failed = false;
let proc;
try {
  // ---- Session A: main probe session (items 1, 3, 6, 10, 14, 15, 17, 19) ----
  proc = new OmpProc("sessionA", dir("sessions"));
  await proc.ready();
  console.log(`sessionA ready in ${proc.readyMs}ms`);

  // Item 17: get_state baseline fields.
  const state0 = await proc.send({ id: "r1", type: "get_state" });
  results.items.item17 = {
    success: state0.success,
    hasUsageLimitField: "usageLimit" in (state0.data ?? {}),
    slowModeSupported: state0.data?.slowModeSupported,
    slowModeEnabled: state0.data?.slowModeEnabled,
    slowModeScope: state0.data?.slowModeScope,
    model: state0.data?.model ? `${state0.data.model.provider}/${state0.data.model.id}` : null,
  };

  // Item 6: set_ask_dialog.
  const askDialog = await proc.send({ id: "r2", type: "set_ask_dialog", enabled: true });
  results.items.item6 = { success: askDialog.success, data: askDialog.data, error: askDialog.error };

  // Item 10: set_host_tools, round trip. loadMode "essential" so the tool is
  // always in the active tool set (default "discoverable" may hide it from
  // the model's tool list, which the first two attempts at this probe appear
  // to have hit: the model never emitted a host_tool_call at all).
  const hostTools = await proc.send({
    id: "r3", type: "set_host_tools",
    tools: [{ name: "echo_host_probe", label: "Echo Host Probe", description: "Echo a fixed string back to confirm the host-tool round trip. Call this tool whenever asked to.", parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false }, loadMode: "essential" }],
  });
  results.items.item10 = { setHostToolsSuccess: hostTools.success, toolNames: hostTools.data?.toolNames };

  // Item 19: set_event_filter, delta projection baseline (applied before the prompts below).
  const filterDelta = await proc.send({ id: "r4", type: "set_event_filter", events: null, messageUpdates: "delta" });
  results.items.item19 = { setSuccess: filterDelta.success, echoed: filterDelta.data };

  // Item 10: host tool call round trip. A tiny, fast, deterministic turn --
  // nothing else in the prompt, so there is no risk of a slow unrelated tool
  // call (e.g. a large file read) delaying the host_tool_call frame.
  const probeToken = "PINION-PROBE-18.8.0-OK";
  const p1 = await proc.send({
    id: "r5", type: "prompt",
    message: `Call the echo_host_probe tool with message "${probeToken}" and nothing else. Do not call any other tool.`,
  });
  results.items.item10_prompt_ack = { success: p1.success, agentInvoked: p1.data?.agentInvoked };

  let hostToolCallFrame = null;
  try {
    hostToolCallFrame = await proc.waitFor((f) => f.type === "host_tool_call" && f.name === "echo_host_probe", REQUEST_MS, "host_tool_call echo_host_probe");
    proc.child.stdin.write(JSON.stringify({ type: "host_tool_result", id: hostToolCallFrame.id, result: { content: [{ type: "text", text: `echoed:${hostToolCallFrame.arguments?.message}` }] } }) + "\n");
  } catch (e) {
    results.items.item10_hostToolCallError = e.message;
  }

  // Capture a few message_update frames while this turn streams, to inspect
  // the delta projection shape live (item 19).
  const deltaSamples = [];
  const deltaWatchStart = Date.now();
  while (Date.now() - deltaWatchStart < 20_000 && deltaSamples.length < 3) {
    try {
      const f = await proc.waitFor((fr) => fr.type === "message_update" && !deltaSamples.includes(fr), 2_000, "message_update");
      deltaSamples.push(f);
    } catch (e) { break; }
  }
  results.items.item19.deltaSampleCount = deltaSamples.length;
  results.items.item19.deltaSampleKeys = deltaSamples[0] ? Object.keys(deltaSamples[0]) : [];
  results.items.item19.deltaSamplePartialOmitted = deltaSamples[0] ? !("partial" in (deltaSamples[0].assistantMessageEvent ?? {})) : null;

  try {
    const pr1 = await proc.waitFor((f) => f.type === "prompt_result" && f.id === "r5", REQUEST_MS, "prompt_result r5");
    results.items.item10_prompt_result = { status: pr1.status, agentInvoked: pr1.agentInvoked };
  } catch (e) {
    results.items.item10_prompt_result = { error: e.message };
  }
  results.items.item10.hostToolCallReceived = !!hostToolCallFrame;
  results.items.item10.hostToolCallArgs = hostToolCallFrame?.arguments;

  // Item 3: literal @path expansion over RPC. A tiny, throwaway scratch file
  // with a known unique marker, so the reply is falsifiable (a model that
  // never saw the expanded content cannot know the marker). Non-fatal: if
  // item 10's turn above is still finishing up or misbehaving, this and the
  // remaining items still get a chance to run.
  try {
    const atPathMarker = "PINION-ATPATH-MARKER-7a91";
    const atPathFile = path.join(dir("wt"), "atpath-probe.txt");
    fs.writeFileSync(atPathFile, `${atPathMarker}\nThis is a scratch file for the @path expansion probe.\n`);
    const p2a = await proc.send({ id: "r5b", type: "prompt", message: "Read @atpath-probe.txt and reply with ONLY its first line, nothing else." });
    results.items.item3_prompt_ack = { success: p2a.success, agentInvoked: p2a.data?.agentInvoked };
    const pr2a = await proc.waitFor((f) => f.type === "prompt_result" && f.id === "r5b", REQUEST_MS, "prompt_result r5b");
    const lastAssistant = await proc.send({ id: "r6", type: "get_last_assistant_text" });
    results.items.item3 = {
      promptResultStatus: pr2a.status,
      replyText: lastAssistant.data,
      markerEchoed: typeof lastAssistant.data === "string" && lastAssistant.data.includes(atPathMarker),
    };
  } catch (e) {
    results.items.item3 = { error: e.message };
  }

  // Item 1: set_model / set_thinking_level, including mid-turn.
  const models = await proc.send({ id: "r7", type: "get_available_models" });
  const levels = await proc.send({ id: "r8", type: "get_available_thinking_levels" });
  const modelList = Array.isArray(models.data) ? models.data : (models.data?.models ?? []);
  const currentModel = state0.data?.model;
  const altModel = modelList.find((m) => m && (m.provider !== currentModel?.provider || m.id !== currentModel?.id));
  results.items.item1_discovery = { modelCount: modelList.length, levels: levels.data?.levels, currentModel, altModelFound: !!altModel };

  if (altModel) {
    // Start a longer turn, then switch model and thinking level MID-STREAM.
    const p2 = await proc.send({ id: "r9", type: "prompt", message: "Count slowly from one to twenty, one number per line, with a short pause of thought between each number explaining why that number is interesting." });
    results.items.item1_midTurnPromptAck = { success: p2.success, agentInvoked: p2.data?.agentInvoked };
    await new Promise((r) => setTimeout(r, 1500)); // let streaming start
    const setModelMid = await proc.send({ id: "r10", type: "set_model", provider: altModel.provider, modelId: altModel.id }, 20_000);
    const setLevelMid = await proc.send({ id: "r11", type: "set_thinking_level", level: "xhigh" }, 20_000);
    results.items.item1_midTurn = {
      setModelSuccess: setModelMid.success, setModelData: setModelMid.data, setModelError: setModelMid.error,
      setLevelSuccess: setLevelMid.success, setLevelData: setLevelMid.data, setLevelError: setLevelMid.error,
    };
    // Let the original turn settle (it may continue on the old model per rpc.md, or
    // the new one -- recorded, not assumed) before issuing abort_and_restore_queue.
    try {
      await proc.waitFor((f) => f.type === "prompt_result" && f.id === "r9", REQUEST_MS, "prompt_result r9");
    } catch (e) {
      results.items.item1_midTurn.turnNeverSettled = e.message;
    }
    const state1 = await proc.send({ id: "r12", type: "get_state" });
    results.items.item1_midTurn.modelAfterTurn = state1.data?.model;
    results.items.item1_midTurn.thinkingLevelAfterTurn = state1.data?.thinkingLevel;
  } else {
    results.items.item1_midTurn = { skipped: "no alternate model available in this account's catalog" };
  }

  // Item 15: abort_and_restore_queue with two follow-ups (one with an image) then Stop.
  await proc.send({ id: "r13", type: "prompt", message: "Count slowly from one to thirty, one number per line." });
  await new Promise((r) => setTimeout(r, 800));
  proc.child.stdin.write(JSON.stringify({ id: "r14", type: "follow_up", message: "Then also list the primary colors." }) + "\n");
  await proc.waitFor((f) => f.type === "response" && f.id === "r14", REQUEST_MS, "response r14");
  proc.child.stdin.write(JSON.stringify({ id: "r15", type: "follow_up", message: "Then draw the attached shape in ASCII art.", images: [{ type: "image", mimeType: "image/png", data: onePx1x1PngBase64() }] }) + "\n");
  await proc.waitFor((f) => f.type === "response" && f.id === "r15", REQUEST_MS, "response r15");
  const abortRestore = await proc.send({ id: "r16", type: "abort_and_restore_queue" }, REQUEST_MS);
  results.items.item15 = {
    success: abortRestore.success,
    steeringCount: abortRestore.data?.steering?.length ?? null,
    followUpCount: abortRestore.data?.followUp?.length ?? null,
    followUpHasImages: abortRestore.data?.followUp?.some((m) => Array.isArray(m.images) && m.images.length > 0) ?? null,
    imagesDropped: abortRestore.data?.imagesDropped ?? null,
    truncated: abortRestore.data?.truncated ?? null,
  };
  // Confirm no new turn started: wait briefly for any further agent_start; none expected.
  let unexpectedAgentStart = false;
  try { await proc.waitFor((f) => f.type === "agent_start", 5_000, "unexpected agent_start"); unexpectedAgentStart = true; } catch (e) { }
  results.items.item15.unexpectedAgentStartAfterAbort = unexpectedAgentStart;

  // Item 14: btw during idle (session is now idle/settled after the abort+restore).
  const msgsBeforeBtw = await proc.send({ id: "r17", type: "get_messages" });
  const btw1 = await proc.send({ id: "r18", type: "btw", question: "What is 2 + 2? Answer with just the number." }, REQUEST_MS);
  results.items.item14_response = { success: btw1.success, recordStatus: btw1.data?.record?.status, recordFrameCount: null };
  // Collect btw_delta/btw_record frames for this record.
  const recordId = btw1.data?.record?.id;
  const btwFrameCount = proc.frames.filter((f) => (f.type === "btw_delta" || f.type === "btw_record") && (f.recordId === recordId || f.record?.id === recordId)).length;
  results.items.item14_response.recordFrameCount = btwFrameCount;
  let finalBtwRecord = null;
  const btwWatchStart = Date.now();
  while (Date.now() - btwWatchStart < 20_000) {
    const f = proc.frames.find((fr) => fr.type === "btw_record" && fr.record?.id === recordId && fr.record?.status === "complete");
    if (f) { finalBtwRecord = f.record; break; }
    await new Promise((r) => setTimeout(r, 300));
  }
  const msgsAfterBtw = await proc.send({ id: "r19", type: "get_messages" });
  results.items.item14 = {
    btwDeltaCount: proc.frames.filter((f) => f.type === "btw_delta" && f.recordId === recordId).length,
    btwRecordFrameCount: proc.frames.filter((f) => f.type === "btw_record" && f.record?.id === recordId).length,
    finalAnswer: finalBtwRecord?.answer,
    finalStatus: finalBtwRecord?.status,
    messageCountUnchanged: (msgsBeforeBtw.data?.messages?.length ?? msgsBeforeBtw.data?.length) === (msgsAfterBtw.data?.messages?.length ?? msgsAfterBtw.data?.length),
  };

  const stateFinal = await proc.send({ id: "r20", type: "get_state" });
  results.items.item17.sessionFile = stateFinal.data?.sessionFile;
  results.sessionAFile = stateFinal.data?.sessionFile;

  await proc.closeGracefully();

  // ---- get_btw_history after a restart (item 14) ----
  const sessionDirA = dir("sessions");
  const proc2 = new OmpProc("sessionA-restart", sessionDirA);
  await proc2.ready();
  await proc2.send({ id: "r1", type: "switch_session", sessionPath: results.sessionAFile });
  const btwHistory = await proc2.send({ id: "r2", type: "get_btw_history" });
  results.items.item14.btwHistoryAfterRestartCount = btwHistory.data?.records?.length ?? null;
  results.items.item14.btwHistoryHasOurRecord = !!btwHistory.data?.records?.find((r) => r.id === recordId);
  await proc2.closeGracefully();

  // ---- Item 16: switch_session with an unrestorable saved model ----
  // Copy the session file from Session A (byte copy, never the original) and
  // corrupt its recorded model to a provider/id that cannot possibly exist.
  const srcFile = results.sessionAFile;
  const corruptDir = dir("sessions-corrupt");
  fs.mkdirSync(corruptDir, { recursive: true });
  const corruptFile = path.join(corruptDir, path.basename(srcFile));
  let raw = fs.readFileSync(srcFile, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const fakeProvider = "pinion-probe-fake-provider";
  const fakeModelId = "pinion-probe-fake-model-does-not-exist";
  // Best-effort: rewrite every occurrence of the real provider/id pair in the file
  // to the fake one, so whichever entry OMP reads as "the saved model" is fake.
  if (currentModel) {
    const reP = new RegExp(JSON.stringify(currentModel.provider), "g");
    const reId = new RegExp(JSON.stringify(currentModel.id), "g");
    raw = raw.replace(reP, JSON.stringify(fakeProvider)).replace(reId, JSON.stringify(fakeModelId));
  }
  fs.writeFileSync(corruptFile, raw);

  const proc3 = new OmpProc("sessionB-corrupt-model", dir("sessions-fresh"));
  await proc3.ready();
  const switchBad = await proc3.send({ id: "r1", type: "switch_session", sessionPath: corruptFile }, REQUEST_MS);
  results.items.item16 = {
    rewroteModelRef: !!currentModel,
    switchSuccess: switchBad.success,
    switchError: switchBad.error,
    switchData: switchBad.data,
  };
  // Now retry with explicit provider/modelId, which rpc.md says should bind and skip the check.
  if (altModel) {
    const switchWithExplicit = await proc3.send({ id: "r2", type: "switch_session", sessionPath: corruptFile, provider: altModel.provider, modelId: altModel.id }, REQUEST_MS);
    results.items.item16.switchWithExplicitModelSuccess = switchWithExplicit.success;
    results.items.item16.switchWithExplicitModelData = switchWithExplicit.data;
    results.items.item16.switchWithExplicitModelError = switchWithExplicit.error;
  }
  await proc3.closeGracefully();

} catch (e) {
  failed = true;
  results.error = e.message;
  console.error("PROBE FAILED", e.stack ?? e.message);
} finally {
  try { if (proc && !proc.exited) { execFileSync("taskkill", ["/PID", String(proc.child.pid), "/T", "/F"]); } } catch (e) { }
}

fs.writeFileSync(path.join(ROOT, "result.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
console.log(`\nscratch dir (raw frames, unredacted; left on disk, not deleted): ${ROOT}`);
process.exit(failed ? 1 : 0);
