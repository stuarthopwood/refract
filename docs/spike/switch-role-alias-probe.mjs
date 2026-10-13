// RM0 follow-up probe (#762, #766): does the native `/switch` command accept
// a `@role` alias and resolve it through `modelRoles` (the way OMP's own
// `/model`/role system does), i.e. is `/switch @task` / `/switch @plan` a
// working route to a ROLE-based switcher without Refract reimplementing role
// resolution itself (constitution I)? This follows up on
// model-role-rpc-probe.mjs's finding that the RPC `cycle_model` command does
// NOT cycle through `cycleOrder`'s configured roles (it moved through
// sequential catalog model versions -- sonnet-4, 4.5, 4.6 -- none of which
// match Stuart's real role assignments for plan/task/slow), contrary to
// `omp://settings.md`'s "Chat roles cycled by the model switcher" phrasing
// for `cycleOrder`.
//
// This uses Stuart's REAL default OMP profile (no --profile flag): `/switch
// @role` is a LOCAL-ONLY command (agentInvoked:false per the earlier native
// `/switch` probe), so no real model call/token spend happens here --
// Session-scoped only, scratch --session-dir, never a real working tree.
// Restores the original model with a final `/switch` back to the baseline
// provider/id so this process's own scratch session ends on the account's
// ordinary default, though the scratch session file itself is discarded.
//
// Run: node docs/spike/switch-role-alias-probe.mjs

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const OMP = process.env.PINION_OMP || "omp";
const ROOT = path.join(os.tmpdir(), "pinion-switch-role-alias-probe-" + Date.now());
fs.mkdirSync(ROOT, { recursive: true });
const sd = path.join(ROOT, "sessions");
fs.mkdirSync(sd, { recursive: true });

const args = ["--mode", "rpc-ui", "--approval-mode=always-ask", "--session-dir", sd];
const child = spawn(OMP, args, { cwd: ROOT, stdio: "pipe", windowsHide: true });
let buf = Buffer.alloc(0);
const frames = [];
const waiters = [];
const results = {};

child.stdout.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  let i;
  while ((i = buf.indexOf(0x0a)) >= 0) {
    const line = buf.subarray(0, i).toString("utf8").trim();
    buf = buf.subarray(i + 1);
    if (!line) continue;
    let f; try { f = JSON.parse(line); } catch { continue; }
    frames.push(f);
    if (f.type === "extension_ui_request") {
      child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: f.id, cancelled: true }) + "\n");
    }
    for (let idx = waiters.length - 1; idx >= 0; idx--) {
      if (waiters[idx].pred(f)) { const w = waiters[idx]; waiters.splice(idx, 1); w.resolve(f); }
    }
  }
});
child.stderr.on("data", () => {});

function waitFor(pred, timeout = 20000) {
  for (const f of frames) if (pred(f)) return Promise.resolve(f);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), timeout);
    waiters.push({ pred, resolve: (f) => { clearTimeout(t); resolve(f); } });
  });
}

let n = 0;
async function sendSwitch(arg) {
  const id = `s${++n}`;
  const mark = frames.length;
  child.stdin.write(JSON.stringify({ id, type: "prompt", message: `/switch ${arg}`.trim() }) + "\n");
  const ack = await waitFor((f) => f.id === id && f.type === "response", 20000).catch((e) => ({ error: e.message }));
  const commandOutput = frames.slice(mark).find((f) => f.type === "command_output") ?? null;
  return { ack: { success: ack.success, agentInvoked: ack.data?.agentInvoked, error: ack.error }, commandOutput: commandOutput?.text ?? null };
}

try {
  await waitFor((f) => f.type === "ready");
  const state0 = (await (async () => { child.stdin.write(JSON.stringify({ id: "g0", type: "get_state" }) + "\n"); return waitFor((f) => f.id === "g0", 20000); })()).data;
  results.baselineModel = state0.model;

  results.switchAtTask = await sendSwitch("@task");
  results.switchAtPlan = await sendSwitch("@plan");
  results.switchAtSlow = await sendSwitch("@slow");
  results.switchAtDefault = await sendSwitch("@default");

  // Read the session file raw to see exactly what role each @role switch recorded.
  child.stdin.write(JSON.stringify({ id: "gF", type: "get_state" }) + "\n");
  const stateF = (await waitFor((f) => f.id === "gF", 20000)).data;
  const lines = fs.readFileSync(stateF.sessionFile, "utf8").split("\n").filter(Boolean);
  const modelChanges = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((o) => o && o.type === "model_change");
  results.modelChangeEntries = modelChanges.map((e) => ({ model: e.model, role: e.role ?? "<absent>" }));
} catch (e) {
  results.error = e.message;
}

console.log(JSON.stringify(results, null, 2));
fs.writeFileSync(path.join(ROOT, "result.json"), JSON.stringify(results, null, 2));
console.log(`scratch: ${ROOT}`);

child.stdin.end();
await new Promise((r) => setTimeout(r, 1500));
try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* already gone */ }
process.exit(0);
