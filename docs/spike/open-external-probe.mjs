// openExternal breakaway probe (issue #68, the second check of tasks.md T004): does a browser
// that Refract starts through `shell.openExternal` die with Refract's kill-on-close Job Object?
//
// Starts the built app (`out/`) as an isolated instance (its own --user-data-dir, so it never
// touches the live instance's Sessions or single-instance lock) with a CDP port, makes its
// renderer call `window.open(<probe url>)` (the real setWindowOpenHandler -> openExternalSafe
// path), waits for the browser to request the probe URL from a local HTTP server, force-kills
// only the Electron main pid (no /T), and reports whether the browser processes survived.
//
// Controls, so a "survived" result cannot come from a broken run:
// - jobJoined: a `mailto:` open first makes openExternalSafe log "disallowed protocol", which
//   proves the main process's console reaches this script; the run then requires that the
//   main process never logged "joinKillOnCloseJob failed".
// - electronGone: the spawned Electron really exited after the force-kill.
// - pidsAtHit is non-empty: the watched browser image is the one that served the request.
// - browserRootParents: the parent of each browser process whose parent is not itself a
//   browser process, read at the hit (`startedByElectron` when that parent is the Electron pid).
// `conclusive` is true only when every control holds; the exit code is 0 only then.
//
// The probe URL also checks that the URL arrives unmangled: a comma, a `%20`, and a literal
// `%USERNAME%` that must not be expanded by anything on the way to the browser.
//
// Run:  pnpm build, fully close the default browser, then
//       node docs/spike/open-external-probe.mjs <label>
// Env:  REFRACT_PROBE_BROWSER  browser image name to watch (default firefox.exe)
//
// Prints one JSON line. Exit 0 for a conclusive run, 1 for an inconclusive one, 2 when the
// browser was already running or the CDP port was already taken.
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
const SYSTEM_ROOT = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
const SYSTEM32 = path.join(SYSTEM_ROOT, "System32");
const POWERSHELL = path.join(SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe");

const CDP_WAIT_MS = 30_000;
// A cold browser start that restores a large session can take well over 30 s to request the
// new tab's URL (first run, 2026-10-02: Firefox got the URL but fetched it after a 30 s window).
const HIT_WAIT_MS = 120_000;
const CONTROL_LOG_WAIT_MS = 5_000;
const AFTER_KILL_MS = 5_000;

const CONTROL_LOG = "dropped an external open request with a disallowed protocol (mailto:)";
const JOB_FAILED_LOG = "joinKillOnCloseJob failed";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!/^[\w.-]+\.exe$/i.test(BROWSER)) {
  console.log(JSON.stringify({ ok: false, reason: "bad-browser-name", browser: BROWSER }));
  process.exit(2);
}

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

/** Each browser process with its parent pid and the parent's image name (null once exited). */
function browserTree() {
  const script = [
    "$all = Get-CimInstance Win32_Process",
    "$names = @{}; foreach ($p in $all) { $names[[int]$p.ProcessId] = $p.Name }",
    `$rows = @($all | Where-Object Name -eq '${BROWSER}' | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; parentName = $names[[int]$_.ParentProcessId] } })`,
    "ConvertTo-Json -Compress -InputObject $rows",
  ].join("; ");
  const out = execFileSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  const parsed = JSON.parse(out.trim() || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function forceKill(child) {
  if (hasExited(child)) return;
  try {
    execFileSync(path.join(SYSTEM32, "taskkill.exe"), ["/PID", String(child.pid), "/F"], { stdio: "ignore" });
  } catch {
    // Exited between the check and the kill.
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

async function cdpPortBusy() {
  try {
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    return true;
  } catch {
    return false;
  }
}

async function waitForPageTarget(child) {
  const deadline = Date.now() + CDP_WAIT_MS;
  while (Date.now() < deadline && !hasExited(child)) {
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

/** Runs one `Runtime.evaluate`; resolves with an error string when the expression threw. */
function evaluate(wsUrl, id, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Runtime.evaluate timed out"));
    }, 10_000);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, userGesture: true } }));
    });
    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch (err) {
        clearTimeout(timer);
        ws.close();
        reject(err);
        return;
      }
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.close();
      const threw = msg.error?.message ?? msg.result?.exceptionDetails?.text;
      resolve(threw ?? null);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("CDP WebSocket error"));
    });
  });
}

async function waitFor(predicate, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !predicate()) await sleep(250);
  return predicate();
}

async function run(label, child, server, hits, output) {
  const electronPid = child.pid;
  const probeUrl = `http://127.0.0.1:${server.address().port}/probe?a=1,2&b=x%20y&c=%USERNAME%`;

  const page = await waitForPageTarget(child);
  if (!page) return { ok: false, reason: hasExited(child) ? "electron-exited-early" : "no-cdp-target", label, electronPid };

  const controlThrew = await evaluate(page.webSocketDebuggerUrl, 1, `window.open("mailto:probe@example.invalid"); true`);
  if (controlThrew) return { ok: false, reason: "evaluate-threw", detail: controlThrew, label, electronPid };
  const controlLogged = await waitFor(() => output.text.includes(CONTROL_LOG), CONTROL_LOG_WAIT_MS);

  const openedAt = Date.now();
  const probeThrew = await evaluate(page.webSocketDebuggerUrl, 2, `window.open(${JSON.stringify(probeUrl)}); true`);
  if (probeThrew) return { ok: false, reason: "evaluate-threw", detail: probeThrew, label, electronPid };

  await waitFor(() => hits.length > 0, HIT_WAIT_MS);
  const hit = hits[0] ?? null;
  const hitAfterMs = hit === null ? null : Date.now() - openedAt;
  const pidsAtHit = browserPids();
  const tree = browserTree();
  const browserRootParents = tree
    .filter((row) => !pidsAtHit.includes(row.ppid))
    .map((row) => ({ pid: row.pid, ppid: row.ppid, parentName: row.parentName ?? null }));

  forceKill(child);
  await sleep(AFTER_KILL_MS);
  const electronGone = hasExited(child);
  const pidsAfterKill = browserPids();

  const jobJoined = controlLogged && !output.text.includes(JOB_FAILED_LOG);
  const browserSurvived = pidsAtHit.length === 0 ? null : pidsAtHit.some((pid) => pidsAfterKill.includes(pid));
  const conclusive = hit !== null && jobJoined && electronGone && pidsAtHit.length > 0;

  return {
    ok: conclusive,
    label,
    electronPid,
    hit,
    hitAfterMs,
    commaIntact: hit !== null && hit.startsWith("/probe?a=1,2&"),
    spaceIntact: hit !== null && hit.includes("b=x%20y"),
    // A browser may percent-encode the literal `%`; either form proves nothing expanded it.
    envNotExpanded: hit !== null && /c=(%|%25)USERNAME(%|%25)/.test(hit),
    controlLogged,
    jobJoined,
    electronGone,
    pidsAtHit,
    browserRootParents,
    startedByElectron: browserRootParents.some((row) => row.ppid === electronPid),
    pidsAfterKill,
    browserSurvived,
    conclusive,
  };
}

async function main() {
  const label = process.argv[2] ?? "unlabelled";

  if (browserPids().length > 0) {
    console.log(JSON.stringify({ ok: false, reason: "browser-running", browser: BROWSER }));
    process.exit(2);
  }
  if (await cdpPortBusy()) {
    console.log(JSON.stringify({ ok: false, reason: "cdp-port-busy", port: CDP_PORT }));
    process.exit(2);
  }

  const hits = [];
  const server = await startServer(hits);
  // detached keeps Electron out of libuv's own kill-on-close job (which allows silent breakaway),
  // so Refract's self-joined job is its only job, exactly as in a shortcut or Start-Process launch.
  // The finally block below still kills it on every path.
  const child = spawn(ELECTRON, [".", `--user-data-dir=${USER_DATA_DIR}`, `--remote-debugging-port=${CDP_PORT}`], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { text: "" };
  child.stdout.on("data", (chunk) => (output.text += chunk));
  child.stderr.on("data", (chunk) => (output.text += chunk));

  let result;
  try {
    result = await run(label, child, server, hits, output);
  } catch (err) {
    result = { ok: false, reason: "probe-error", detail: String(err), label, electronPid: child.pid };
  } finally {
    forceKill(child);
    server.close();
  }
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

await main();
