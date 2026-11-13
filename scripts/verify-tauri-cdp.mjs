// CDP driver for the Tauri/WebView2 build: trusted input events, polled DOM conditions, screenshots.
// WebView2 is reached via WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>.
// The exe runs inside a kill-on-close Job Object, so teardown never computes a pid to kill.

import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Asks the OS for a free port; a fixed one could attach `waitForCdpTarget` to another instance. */
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

/** Polls `/json/list` for a `page` target's `webSocketDebuggerUrl`; not every target exposes one. */
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

/** One CDP WebSocket connection (Node's global `WebSocket`, Node 24+).
 * Fails closed: a dropped socket rejects pending and later requests, and each `send()` has its own
 * timeout, otherwise `waitFor`'s timeout never fires on a silent browser. */
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

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(`evaluate failed: ${result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)} | line=${result.exceptionDetails.lineNumber} col=${result.exceptionDetails.columnNumber}`);
    }
    return result.result.value;
  }

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

  async click(finderExpr, { timeoutMs = 15_000 } = {}) {
    const rect = await this.waitFor(
      `(() => { const el = ${finderExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      { timeoutMs, label: `click target: ${finderExpr}` },
    );
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  }

  clickByLabel(label, { inDialog = false, prefix = false } = {}) {
    const scope = inDialog ? `document.querySelector('[role="dialog"]')` : 'document.body';
    const finder = prefix
      ? `(() => { const root = ${scope}; if (!root) return null; return Array.from(root.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith(${JSON.stringify(label)})); })()`
      : `(() => { const root = ${scope}; if (!root) return null; return root.querySelector('[aria-label=${JSON.stringify(label)}]'); })()`;
    return this.click(finder);
  }

  /** Text match, for buttons whose accessible name is their text content rather than an `aria-label`. */
  clickByText(text, { inDialog = false, tag = 'button' } = {}) {
    const scope = inDialog ? `document.querySelector('[role="dialog"]')` : 'document.body';
    const finder = `(() => { const root = ${scope}; if (!root) return null; return Array.from(root.querySelectorAll('${tag}')).find((el) => el.textContent.trim() === ${JSON.stringify(text)}); })()`;
    return this.click(finder);
  }

  /** Opens the "Add project" menu (readiness primary button on first run, else the list footer's) and picks "Local folder…"; resolves once the dialog's path input is mounted. */
  async openLocalFolderDialog() {
    const item = `Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Local folder…')`;
    await this.click(`document.querySelector('[data-readiness-primary]') ?? Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Add project')`);
    await this.waitFor(`!!(${item})`, { timeoutMs: 10_000, label: 'Add project menu open' });
    await this.click(item);
    await this.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add project dialog open' });
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

/** Spawns the Job Object launcher around `targetExe`; `targetPid` is for `isTargetOwningPort` only, never a kill target. */
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

/** Closing stdin tells the launcher to end its Job Object (and the whole tree); falls back to Node's own handle kill. */
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

/** Checks by pid (not command-line match) that the port owner is the app or its direct child
 * (WebView2's browser process). Read-only, so a one-hop check suffices. */
export function isTargetOwningPort(port, targetPid) {
  const script = `
$conn = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $conn) { Write-Output '{}'; exit }
$owner = $conn.OwningProcess
$parent = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $owner) -ErrorAction SilentlyContinue).ParentProcessId
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

/** Real exe path of `pid`, to prove the driven process is the scratch copy just built; `null` if unqueryable. */
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

/** Throws if the process's exe path or a fresh sha256 of it differs from what the caller built. */
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

/** Logs to stdout and appends to `filePath` so the STEP trail survives next to the screenshots. */
export function createReportLogger(filePath) {
  writeFileSync(filePath, `# verify run started ${new Date().toISOString()}\n`);
  return function log(line) {
    console.log(line);
    appendFileSync(filePath, `${line}\n`);
  };
}

/** Resolves a CSS var through a real probe element: theme tokens use `color-mix()`/`var()` chains
 * only the browser can compute. Reads back the same `property` that was set (not `currentColor`). */
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
