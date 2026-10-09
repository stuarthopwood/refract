// Item 13 (partial): live session_exit capture. Spawns a real signed-in
// session, sends one trivial turn (so there is assistant history), then
// force-kills the process (taskkill /T /F, a hard crash, not graceful
// shutdown) and reads the raw .jsonl file directly for a `session_exit`
// custom entry, per omp://session.md's documented schema.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const OMP = process.env.PINION_OMP || "omp";
const ROOT = path.join(os.tmpdir(), "pinion-probe-520-item13", new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(path.join(ROOT, "wt"), { recursive: true });
fs.mkdirSync(path.join(ROOT, "sessions"), { recursive: true });
console.log("scratch", ROOT);

const child = spawn(OMP, ["--mode", "rpc-ui", "--approval-mode=yolo", "--session-dir", path.join(ROOT, "sessions")], { cwd: path.join(ROOT, "wt"), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
let buf = Buffer.alloc(0);
const frames = [];
let sessionFile = null;
child.stdout.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  while (true) {
    const i = buf.indexOf(0x0a);
    if (i < 0) break;
    const line = buf.subarray(0, i).toString("utf8").trim();
    buf = buf.subarray(i + 1);
    if (!line) continue;
    try { frames.push(JSON.parse(line)); } catch (e) { }
  }
});
child.stderr.on("data", () => { });

function waitFor(pred, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      const f = frames.find(pred);
      if (f) { clearInterval(iv); resolve(f); }
      else if (Date.now() - start > timeoutMs) { clearInterval(iv); reject(new Error("timeout")); }
    }, 200);
  });
}

try {
  await waitFor((f) => f.type === "ready", 60_000);
  child.stdin.write(JSON.stringify({ id: "p1", type: "prompt", message: "Reply with just the word: hi" }) + "\n");
  await waitFor((f) => f.type === "response" && f.id === "p1", 30_000);
  await waitFor((f) => f.type === "prompt_result" && f.id === "p1", 60_000);
  child.stdin.write(JSON.stringify({ id: "s1", type: "get_state" }) + "\n");
  const stateResp = await waitFor((f) => f.type === "response" && f.id === "s1", 10_000);
  sessionFile = stateResp.data?.sessionFile;
  console.log("sessionFile", sessionFile);

  // Hard crash: no graceful stdin close, go straight to taskkill /T /F.
  await new Promise((r) => setTimeout(r, 300));
  execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
  await new Promise((r) => setTimeout(r, 1500)); // let postmortem teardown flush

  const raw = fs.readFileSync(sessionFile, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const entries = lines.map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  const exitEntry = entries.find((e) => e.type === "custom" && e.customType === "session_exit");
  console.log("total entries", entries.length);
  console.log("session_exit entry found:", !!exitEntry);
  if (exitEntry) console.log(JSON.stringify(exitEntry, null, 2));
  else console.log("entry types seen:", entries.map((e) => e.type).join(","));
} catch (e) {
  console.error("FAILED", e.message);
}
console.log("scratch dir (left on disk):", ROOT);
