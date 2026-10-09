// Item 3 clean retry: literal @path expansion over RPC, in isolation (no
// host-tool or prior-turn entanglement this time -- rounds 1 and 2 both had
// a confound immediately before this turn).
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const OMP = process.env.PINION_OMP || "omp";
const ROOT = path.join(os.tmpdir(), "pinion-probe-520-item3-clean", new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(path.join(ROOT, "wt"), { recursive: true });
fs.mkdirSync(path.join(ROOT, "sessions"), { recursive: true });
const marker = "PINION-ATPATH-CLEAN-MARKER-5f2c";
fs.writeFileSync(path.join(ROOT, "wt", "atpath-clean.txt"), `${marker}\nclean isolated @path probe.\n`);
console.log("scratch", ROOT);

const child = spawn(OMP, ["--mode", "rpc-ui", "--approval-mode=yolo", "--session-dir", path.join(ROOT, "sessions")], { cwd: path.join(ROOT, "wt"), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
let buf = Buffer.alloc(0);
const frames = [];
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
  child.stdin.write(JSON.stringify({ id: "a1", type: "prompt", message: "Read @atpath-clean.txt and reply with ONLY its first line, nothing else." }) + "\n");
  const ack = await waitFor((f) => f.type === "response" && f.id === "a1", 30_000);
  console.log("ack", JSON.stringify(ack));
  if (ack.success) {
    await waitFor((f) => f.type === "prompt_result" && f.id === "a1", 60_000);
    child.stdin.write(JSON.stringify({ id: "a2", type: "get_last_assistant_text" }) + "\n");
    const last = await waitFor((f) => f.type === "response" && f.id === "a2", 10_000);
    console.log("replyText", JSON.stringify(last.data));
    console.log("markerEchoed", typeof last.data === "string" && last.data.includes(marker));
  }
} catch (e) {
  console.error("FAILED", e.message);
} finally {
  try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]); } catch (e) { }
}
console.log("scratch dir (left on disk):", ROOT);
