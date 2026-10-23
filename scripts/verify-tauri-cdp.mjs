// Reusable CDP driver for the Tauri/WebView2 build (issue #795 part 1, R12a). Ported pattern
// from the Electron skill (verify-refract-ui-via-cdp): trusted `Input.dispatchMouseEvent`
// clicks at an element's own `getBoundingClientRect` centre, `Input.insertText` for typing,
// polling for every DOM condition (never a fixed sleep), `Page.captureScreenshot` for evidence.
//
// WebView2's own remote-debugging route (the only documented one, spec 016 part 1's own
// research note): `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>` set on
// the spawned dev process (not the launcher), discovered over the DevTools `/json/list` HTTP
// endpoint exactly like Chrome/Electron.
//
// Process lifecycle (gate-fix, security review HIGH, round 2): the built exe is never spawned
// directly. It runs inside `scripts/verify-tauri-launcher.rs`'s own kill-on-close Win32 Job
// Object, so tearing down the whole tree (WebView2, the fake-omp PATH shim, its own node child)
// is a single OS-level job termination, never a Win32_Process snapshot or a `taskkill` of a
// computed pid -- there is no pid-reuse window to reason about at all, because the kill is scoped
// by actual job membership, not by a guessed ancestry chain.

import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Asks the OS for a free TCP port (binds to port 0, reads back the one actually assigned, then
 * releases it) instead of a fixed guess: a fixed port can already be held by another lane's own
 * `verify:tauri` run, a stale instance left by a killed run, or anything else on the machine, and
 * `waitForCdpTarget` would then silently attach to that OTHER instance instead of failing. */
export async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Polls `http://127.0.0.1:<port>/json/list` until a `page` target's `webSocketDebuggerUrl`
 * appears (WebView2 does not expose one on every target, e.g. a devtools-internal page). */
export async function waitForCdpTarget(port, { timeoutMs = 60_000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const list = await res.json();
        const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`waitForCdpTarget: no page target on port ${port} within ${timeoutMs}ms (last error: ${lastErr?.message})`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Thin wrapper over one CDP WebSocket connection: request/response correlation by id, plus the
 * handful of domain calls this harness needs. Node's global `WebSocket` (Node 24+, per
 * README.md's own prerequisite) -- no extra dependency.
 *
 * Fails closed on a dropped connection (gate-fix, code review HIGH): if the app or WebView2
 * crashes mid-run, the socket's own `close`/`error` event rejects every request still pending
 * AND every request sent afterwards, instead of leaving them to hang forever past `waitFor`'s own
 * timeout (the timeout never fires because the underlying `send()` promise itself never
 * resolves or rejects without this). Each individual `send()` also carries its own timeout, so a
 * CDP command that the browser process never answers (not a close, just silence) fails the same
 * way. */
export class CdpSession {
  constructor(ws, { requestTimeoutMs = 20_000 } = {}) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.requestTimeoutMs = requestTimeoutMs;
    const failAll = (reason) => {
      if (this.closed) return;
      this.closed = true;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      }
      this.pending.clear();
    };
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    });
    ws.addEventListener('close', () => failAll(new Error('CdpSession: WebSocket closed (the app or WebView2 likely crashed or exited)')));
    ws.addEventListener('error', (err) => failAll(new Error(`CdpSession: WebSocket error: ${err?.message ?? err}`)));
  }

  static async connect(wsUrl, { timeoutMs = 20_000 } = {}) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CdpSession.connect: timed out')), timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(t);
        resolve();
      });
      ws.addEventListener('error', (err) => {
        clearTimeout(t);
        reject(err);
      });
    });
    const session = new CdpSession(ws);
    await session.send('Runtime.enable');
    await session.send('Page.enable');
    return session;
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error(`CdpSession: send(${method}) after the connection closed`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CdpSession: ${method} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }

  /** Evaluates `expression` in the page, returning the plain JS value (must be JSON-safe). */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(`evaluate failed: ${result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)} | line=${result.exceptionDetails.lineNumber} col=${result.exceptionDetails.columnNumber} | EXPR>>>${expression}<<<EXPR`);
    }
    return result.result.value;
  }

  /** Polls `expression` (must return a JSON-safe value) until it is truthy, no fixed sleeps. */
  async waitFor(expression, { timeoutMs = 30_000, intervalMs = 250, label = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastValue;
    while (Date.now() < deadline) {
      lastValue = await this.evaluate(expression);
      if (lastValue) return lastValue;
      await sleep(intervalMs);
    }
    throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label} (last value: ${JSON.stringify(lastValue)})`);
  }

  /** Clicks the centre of the first element matching `finderExpr` (a JS expression evaluating to
   * an Element or null/undefined). Throws if nothing matched within `timeoutMs`. */
  async click(finderExpr, { timeoutMs = 15_000 } = {}) {
    const rect = await this.waitFor(
      `(() => { const el = ${finderExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      { timeoutMs, label: `click target: ${finderExpr}` },
    );
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  }

  /** Matches an exact `aria-label` anywhere, optionally scoped to the open dialog (used for
   * "New session from a branch in ..." and the composer's Send/Stop buttons). */
  clickByLabel(label, { inDialog = false, prefix = false } = {}) {
    const scope = inDialog ? `document.querySelector('[role="dialog"]')` : 'document.body';
    const finder = prefix
      ? `(() => { const root = ${scope}; if (!root) return null; return Array.from(root.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith(${JSON.stringify(label)})); })()`
      : `(() => { const root = ${scope}; if (!root) return null; return root.querySelector('[aria-label=${JSON.stringify(label)}]'); })()`;
    return this.click(finder);
  }

  /** Matches a button/element by its exact trimmed visible text, optionally scoped to the open
   * dialog (used for "Add repository" / "Create session", whose accessible name is their text
   * content, not an `aria-label`). */
  clickByText(text, { inDialog = false, tag = 'button' } = {}) {
    const scope = inDialog ? `document.querySelector('[role="dialog"]')` : 'document.body';
    const finder = `(() => { const root = ${scope}; if (!root) return null; return Array.from(root.querySelectorAll('${tag}')).find((el) => el.textContent.trim() === ${JSON.stringify(text)}); })()`;
    return this.click(finder);
  }

  async typeIntoByLabel(label, text, { inDialog = false } = {}) {
    const scope = inDialog ? `document.querySelector('[role="dialog"]')` : 'document.body';
    const finder = `(() => { const root = ${scope}; if (!root) return null; return root.querySelector('[aria-label=${JSON.stringify(label)}]'); })()`;
    await this.click(finder);
    await this.send('Input.insertText', { text });
  }

  async pressEnter() {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13 });
  }

  async screenshot(outPath) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(outPath, Buffer.from(data, 'base64'));
    return outPath;
  }
}

/** Spawns `scripts/verify-tauri-launcher.exe` (already built by the caller), which creates a
 * kill-on-close Job Object, spawns `targetExe` inside it, and writes the target's own pid to
 * `pidFile` once assigned. Returns `{ child, targetPid }`: `child` is the LAUNCHER's own
 * `ChildProcess` (Node's own handle on it, so its pid can never be silently reused while this
 * harness holds it), `targetPid` is the real app's pid (for `isTargetOwningPort` only -- never
 * used to construct a kill target). */
export async function launchViaJobObject(launcherExe, pidFile, targetExe, targetArgs, { cwd, env } = {}) {
  const child = spawn(launcherExe, [pidFile, targetExe, ...targetArgs], { windowsHide: true, cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });

  const deadline = Date.now() + 15_000;
  let targetPid = null;
  while (Date.now() < deadline) {
    if (existsSync(pidFile)) {
      const content = readFileSync(pidFile, 'utf8').trim();
      if (/^\d+$/.test(content)) {
        targetPid = Number(content);
        break;
      }
    }
    if (child.exitCode !== null) {
      throw new Error(`launchViaJobObject: launcher exited (code ${child.exitCode}) before writing ${pidFile}`);
    }
    await sleep(100);
  }
  if (targetPid == null) {
    throw new Error(`launchViaJobObject: timed out waiting for ${pidFile}`);
  }
  return { child, targetPid };
}

/** Stops the launcher (gate-fix, security review HIGH, round 2): closes its stdin, the shutdown
 * signal `verify-tauri-launcher.rs` watches for, which terminates its Job Object (and so the
 * whole tree inside it) immediately. If the launcher itself does not exit within `graceMs` (it
 * should exit almost immediately once its own job is torn down), it is force-killed directly by
 * Node's own `ChildProcess.kill()` -- always safe: Node holds this exact process handle itself,
 * so there is no pid to compute and no reuse window to reason about. */
export async function stopLauncher(child, { graceMs = 5000 } = {}) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    child.stdin.end();
  } catch {
    // already gone
  }
  const exited = await Promise.race([new Promise((resolve) => child.once('exit', () => resolve(true))), sleep(graceMs).then(() => false)]);
  if (!exited) {
    try {
      child.kill();
    } catch {
      // already gone
    }
  }
}

/** Confirms the process actually listening on `port` is the app this harness launched, or one of
 * its own direct children (WebView2's own browser process is typically one hop below the Tauri
 * exe) -- a pid-based check (`Get-NetTCPConnection`'s own `OwningProcess`), never a command-line
 * substring match (gate-fix, security review round 2). This is read-only verification, never a
 * kill decision, so a shallow one-hop parent check is sufficient: the worst case of a wrong
 * answer here is an aborted run, not a touched process. */
export function isTargetOwningPort(port, targetPid) {
  const script = `
$conn = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $conn) { Write-Output '{}'; exit }
$owner = $conn.OwningProcess
$parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$owner" -ErrorAction SilentlyContinue).ParentProcessId
@{ owner = $owner; parent = $parent } | ConvertTo-Json -Compress
`.trim();
  const result = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || !result.stdout) return false;
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return false;
  }
  if (!parsed.owner) return false;
  return parsed.owner === targetPid || parsed.parent === targetPid;
}

/** The real OS-level executable path backing `pid`, via `Win32_Process.ExecutablePath` -- proves
 * the process a CDP session is actually driving is the exact scratch copy a caller just built
 * and hashed, not a stale instance or a substituted binary (gate round 2 fix, test-reviewer
 * Medium: the exe hash used to be logged but never actually checked against anything). `null`
 * if the process cannot be queried (already exited, insufficient permissions, etc). */
export function getProcessExecutablePath(pid) {
  const script = `
$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue
if (-not $p) { Write-Output '{}'; exit }
@{ path = $p.ExecutablePath } | ConvertTo-Json -Compress
`.trim();
  const result = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || !result.stdout) return null;
  try {
    return JSON.parse(result.stdout).path ?? null;
  } catch {
    return null;
  }
}

/** Combines `getProcessExecutablePath` with a fresh sha256 read of the file at that path, and
 * throws if either has drifted from what the caller expects -- the actual check round 1's PR
 * claimed but never ran (it only logged the hash once, at copy time). */
export function assertExeMatchesProcess(pid, expectedExePath, expectedHash) {
  const actualPath = getProcessExecutablePath(pid);
  if (!actualPath || path.resolve(actualPath) !== path.resolve(expectedExePath)) {
    throw new Error(`assertExeMatchesProcess: process ${pid}'s own exe path is ${actualPath ?? 'unknown'}, expected ${expectedExePath}`);
  }
  const actualHash = createHash('sha256').update(readFileSync(actualPath)).digest('hex');
  if (actualHash !== expectedHash) {
    throw new Error(`assertExeMatchesProcess: exe at ${actualPath} now hashes to ${actualHash}, expected ${expectedHash}`);
  }
}

/** A tiny logger that both `console.log`s a line and appends it to `filePath`, so a run's own
 * STEP PASS/FAIL trail survives on disk next to its screenshots -- not only as stdout a caller
 * might not have captured (gate round 2 fix, test-reviewer Medium: no run record was kept). */
export function createReportLogger(filePath) {
  writeFileSync(filePath, `# verify run started ${new Date().toISOString()}\n`);
  return function log(line) {
    console.log(line);
    appendFileSync(filePath, `${line}\n`);
  };
}

/** Item 4 (M3, settled/resolved outline colours, `verify-927-928-quiet-composer.mjs`): the
 * EXPECTED outline colour for a token like `--composer-focus`/`--ring` is resolved through a
 * REAL probe element's own `getComputedStyle()` -- several theme presets resolve these through
 * `color-mix()`/`var()` chains only the browser's own cascade can finish computing, so string-
 * comparing the token's CSS text would be wrong.
 *
 * Gate round 3 fix (Low, Main): used to unconditionally read back `.outlineColor` regardless of
 * `property`, relying on `outline-color`'s own `currentColor` default to coincidentally pick up
 * whatever `property` (e.g. `color`) had actually been set -- a trick that only works for
 * properties CSS itself happens to resolve through `currentColor`, silently wrong for anything
 * else a future caller might pass (e.g. `background-color`, whose own initial value is
 * `transparent`, never `currentColor`). Reads back the SAME property that was set, converted to
 * its camelCase `CSSStyleDeclaration` key. */
export async function resolveCssVarColor(cdp, varName, property = 'outline-color') {
  return cdp.evaluate(`(() => {
    const probe = document.createElement('div');
    probe.style.position = 'fixed';
    probe.style.top = '-9999px';
    probe.style.left = '-9999px';
    probe.style.pointerEvents = 'none';
    probe.style.outlineStyle = 'solid';
    probe.style.outlineWidth = '1px';
    probe.style.setProperty('${property}', 'var(${varName})');
    document.body.appendChild(probe);
    const camel = '${property}'.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = getComputedStyle(probe)[camel];
    probe.remove();
    return value;
  })()`);
}

export { sleep };
