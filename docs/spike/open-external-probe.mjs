// openExternal breakaway probe (issue #68, the second check of tasks.md T004): does a browser
// that Refract starts through `shell.openExternal` die with Refract's kill-on-close Job Object?
//
// Starts the built app (`out/`) as an isolated instance (its own --user-data-dir, so it never
// touches the live instance's Sessions or single-instance lock) with a CDP port, makes its
// renderer call `window.open(<probe url>)` (the real setWindowOpenHandler -> openExternalSafe
// path), waits for the browser to request the probe URL from a local HTTP server, force-kills
// only the Electron main pid (no /T), and reports whether the browser processes survived.
//
// The probe URL also checks that the URL arrives unmangled: a comma, a `%20`, and a literal
// `%USERNAME%` that must not be expanded by anything on the way to the browser.
//
// Run:  pnpm build, fully close the default browser, then
//       node docs/spike/open-external-probe.mjs <label>
// Env:  REFRACT_PROBE_BROWSER  browser image name to watch (default firefox.exe)
//
// Prints one JSON line. Exit 0 when the browser requested the URL, 1 when it did not (or the
// app never exposed a CDP page), 2 when the browser was already running.
// Never deletes anything and never kills a browser process.

import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ELECTRON = path.join(REPO_ROOT, "node_modules", "electron", "dist", "electron.exe");
const USER_DATA_DIR = "C:\\tmp\\refract-probe-userdata";
const CDP_PORT = 9333;
const BROWSER = process.env.REFRACT_PROBE_BROWSER ?? "firefox.exe";
const SYSTEM32 = path.join(process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows", "System32");

const CDP_WAIT_MS = 30_000;
const HIT_WAIT_MS = 30_000;
const AFTER_KILL_MS = 5_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function browserPids() {
  const out = execFileSync(
    path.join(SYSTEM32, "tasklist.exe"),
    ["/fo", "csv", "/nh", "/fi", `IMAGENAME eq ${BROWSER}`],
    { encoding: "utf8" },
  );
  const pids = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("INFO:")) continue;
    const cols = line.split('","');
    const pid = Number(cols[1]);
    if (Number.isInteger(pid)) pids.push(pid);
  }
  return pids;
}

function forceKill(pid) {
  try {
    execFileSync(path.join(SYSTEM32, "taskkill.exe"), ["/PID", String(pid), "/F"], { stdio: "ignore" });
  } catch {
    // Already gone.
  }
}

function startServer(hits) {
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<title>refract-probe</title>ok");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function waitForPageTarget() {
  const deadline = Date.now() + CDP_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page");
      if (page) return page;
    } catch {
      // Not listening yet.
    }
    await sleep(500);
  }
  return undefined;
}

function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Runtime.evaluate timed out"));
    }, 10_000);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, userGesture: true } }));
    });
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      resolve(msg);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("CDP WebSocket error"));
    });
  });
}

async function waitForHit(hits) {
  const deadline = Date.now() + HIT_WAIT_MS;
  while (Date.now() < deadline && hits.length === 0) await sleep(250);
  return hits[0] ?? null;
}

async function main() {
  const label = process.argv[2] ?? "unlabelled";

  if (browserPids().length > 0) {
    console.log(JSON.stringify({ ok: false, reason: "browser-running", browser: BROWSER }));
    process.exit(2);
  }

  const hits = [];
  const server = await startServer(hits);
  const probeUrl = `http://127.0.0.1:${server.address().port}/probe?a=1,2&b=x%20y&c=%USERNAME%`;

  const child = spawn(ELECTRON, [".", `--user-data-dir=${USER_DATA_DIR}`, `--remote-debugging-port=${CDP_PORT}`], {
    cwd: REPO_ROOT,
    stdio: "ignore",
  });
  const electronPid = child.pid;

  const page = await waitForPageTarget();
  if (!page) {
    forceKill(electronPid);
    server.close();
    console.log(JSON.stringify({ ok: false, reason: "no-cdp-target", label, electronPid }));
    process.exit(1);
  }

  await evaluate(page.webSocketDebuggerUrl, `window.open(${JSON.stringify(probeUrl)}); true`);

  const hit = await waitForHit(hits);
  const pidsAtHit = browserPids();

  forceKill(electronPid);
  await sleep(AFTER_KILL_MS);
  const pidsAfterKill = browserPids();

  console.log(
    JSON.stringify({
      label,
      electronPid,
      hit,
      commaIntact: hit !== null && hit.startsWith("/probe?a=1,2&"),
      spaceIntact: hit !== null && hit.includes("b=x%20y"),
      // A browser may percent-encode the literal `%`; either form proves nothing expanded it.
      envNotExpanded: hit !== null && /c=(%|%25)USERNAME(%|%25)/.test(hit),
      pidsAtHit,
      pidsAfterKill,
      browserSurvived: pidsAtHit.some((pid) => pidsAfterKill.includes(pid)),
    }),
  );
  server.close();
  process.exit(hit === null ? 1 : 0);
}

await main();
