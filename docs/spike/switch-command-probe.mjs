// RM0 follow-up probe (#762): the inventory probe (config-watch-role-probe.mjs)
// found `/switch` listed by `get_available_commands` with `source: "builtin"`
// and description "Switch model for this session only" -- i.e. OMP ALREADY
// ships this as a native command, contrary to issue #762's framing of it as
// something Refract might need to build itself. This follow-up sends it for
// real (as a `prompt`) to see HOW it completes: locally (`agentInvoked:
// false`, matching `set_model`'s own RPC contract) or as a dispatched turn,
// and what argument shape it accepts (bare model id vs `provider/modelId`,
// and the no-argument form).
//
// Same isolation posture as config-watch-role-probe.mjs: isolated
// --profile pinion-probe-rm0-config (already seeded with the unreachable
// probe-fake/probe-fake-model), credential-shaped env stripped, scratch cwd
// and session dir. No real credentials, no real model call.
//
// Run: node docs/spike/switch-command-probe.mjs

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const OMP = process.env.PINION_OMP || "omp";
const PROFILE = "pinion-probe-rm0-config";

function sanitizedEnv() {
  const p = /API_KEY|OAUTH|TOKEN|SECRET|CREDENTIAL|PASSWORD|_PAT\b|AUTH|_KEY\b/i;
  const out = { ...process.env };
  for (const k of Object.keys(out)) if (p.test(k)) delete out[k];
  return out;
}

const ROOT = path.join(os.tmpdir(), "pinion-switch-probe-" + Date.now());
fs.mkdirSync(ROOT, { recursive: true });
const sd = path.join(ROOT, "sessions");
fs.mkdirSync(sd, { recursive: true });

const args = ["--mode", "rpc-ui", "--approval-mode=always-ask", "--profile", PROFILE, "--session-dir", sd, "--model", "probe-fake/probe-fake-model"];
const child = spawn(OMP, args, { cwd: ROOT, stdio: "pipe", windowsHide: true, env: sanitizedEnv() });
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

function waitFor(pred, timeout = 15000) {
  for (const f of frames) if (pred(f)) return Promise.resolve(f);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), timeout);
    waiters.push({ pred, resolve: (f) => { clearTimeout(t); resolve(f); } });
  });
}

try {
  await waitFor((f) => f.type === "ready");

  // 1. /switch <provider/modelId> to the SAME currently-active model (a safe no-op pick).
  const mark1 = frames.length;
  child.stdin.write(JSON.stringify({ id: "a1", type: "prompt", message: "/switch probe-fake/probe-fake-model" }) + "\n");
  const ack1 = await waitFor((f) => f.id === "a1" && f.type === "response", 15000);
  const commandOutput1 = await waitFor((f) => f.type === "command_output", 5000).catch(() => null);
  const dialog1 = frames.slice(mark1).find((f) => f.type === "extension_ui_request") ?? null;
  results.switchWithExactSelector = { ack: { success: ack1.success, data: ack1.data, error: ack1.error }, commandOutput: commandOutput1?.text ?? commandOutput1 ?? null, dialog: dialog1, framesSeen: frames.slice(mark1).map((f) => f.type) };

  // 2. bare /switch with no argument.
  const mark2 = frames.length;
  child.stdin.write(JSON.stringify({ id: "a2", type: "prompt", message: "/switch" }) + "\n");
  const ack2 = await waitFor((f) => f.id === "a2" && f.type === "response", 15000).catch((e) => ({ error: e.message }));
  const commandOutput2 = frames.slice(mark2).find((f) => f.type === "command_output") ?? null;
  results.switchBareNoArg = { ack: { success: ack2.success, data: ack2.data, error: ack2.error }, commandOutput: commandOutput2?.text ?? commandOutput2 ?? null, framesSeen: frames.slice(mark2).map((f) => f.type) };

  // 3. /switch with an unknown/unresolvable model selector.
  const mark3 = frames.length;
  child.stdin.write(JSON.stringify({ id: "a3", type: "prompt", message: "/switch no-such-provider/no-such-model-xyz" }) + "\n");
  const ack3 = await waitFor((f) => f.id === "a3" && f.type === "response", 15000).catch((e) => ({ error: e.message }));
  const commandOutput3 = await waitFor((f) => f.type === "command_output", 5000).catch(() => null);
  results.switchUnknownModel = { ack: { success: ack3.success, data: ack3.data, error: ack3.error }, commandOutput: commandOutput3?.text ?? commandOutput3 ?? null };
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
