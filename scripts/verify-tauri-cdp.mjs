// Reusable CDP driver for the Tauri/WebView2 build (issue #795 part 1, R12a). Ported pattern
// from the Electron skill (verify-refract-ui-via-cdp): trusted `Input.dispatchMouseEvent`
// clicks at an element's own `getBoundingClientRect` centre, `Input.insertText` for typing,
// polling for every DOM condition (never a fixed sleep), `Page.captureScreenshot` for evidence.
//
// WebView2's own remote-debugging route (the only documented one, spec 016 part 1's own
// research note): `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>` set on
// the spawned dev process (not the launcher), discovered over the DevTools `/json/list` HTTP
// endpoint exactly like Chrome/Electron.

import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

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
 * README.md's own prerequisite) -- no extra dependency. */
export class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    });
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
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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
      throw new Error(`evaluate failed: ${result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)}`);
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

/** Spawns a process, returning its pid up front (before any CDP work) so the caller can clean up
 * on any later failure; never resolved by waiting for readiness here -- that is the caller's
 * `waitForCdpTarget` call. */
export function launch(command, args, options) {
  const child = spawn(command, args, { windowsHide: true, ...options });
  return child;
}

/** Snapshots every live process's (pid, parent pid) once via PowerShell/CIM. Windows records a
 * process's parent pid at creation time and never updates it, so this still finds a process
 * whose intermediate ancestor (a `cmd.exe`/pnpm/node wrapper that has already exited, handing
 * off to a long-lived `cargo run` + built exe) is long gone -- the gap `taskkill /PID <pid> /T`
 * cannot cross once `<pid>` itself is no longer resolvable. */
function liveProcessTree() {
  const result = spawnSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout) return [];
  const parsed = JSON.parse(result.stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Every currently-live pid transitively descended from `rootPid` (rootPid itself excluded),
 * found by walking the live-process snapshot's recorded parent links -- works even when
 * `rootPid` or an intermediate ancestor has already exited. */
function liveDescendants(rootPid) {
  const rows = liveProcessTree();
  const childrenOf = new Map();
  for (const row of rows) {
    const list = childrenOf.get(row.ParentProcessId) ?? [];
    list.push(row.ProcessId);
    childrenOf.set(row.ParentProcessId, list);
  }
  const out = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    for (const child of childrenOf.get(pid) ?? []) {
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

function killByPid(pid) {
  return new Promise((resolve) => {
    const tk = spawn('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true, stdio: 'ignore' });
    tk.on('exit', resolve);
    tk.on('error', resolve);
  });
}

/** Stops the process this script itself started: asks it to exit, then force-kills it and every
 * pid still transitively descended from it (see `liveDescendants`'s own doc comment -- needed
 * because a dev-server CLI wrapper (`cmd.exe`/pnpm/the Tauri CLI) can exit on its own once it
 * hands off to a long-lived `cargo run`, orphaning the built app and WebView2 from the pid this
 * script holds). Every kill is a literal, explicit pid -- never a kill by image name -- matching
 * AGENTS.md's destructive-operations rule applied to processes. */
export async function stopProcess(child, { graceMs = 5000 } = {}) {
  const pid = child?.pid;
  if (!pid) return;
  if (!child.killed && child.exitCode === null) {
    try {
      child.kill();
    } catch {
      // already gone
    }
    await Promise.race([new Promise((resolve) => child.once('exit', () => resolve(true))), sleep(graceMs).then(() => false)]);
  }
  const descendants = liveDescendants(pid);
  for (const descendantPid of descendants) await killByPid(descendantPid);
  await killByPid(pid);
}

export { sleep };
