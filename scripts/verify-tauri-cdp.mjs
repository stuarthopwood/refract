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
import { createServer } from 'node:net';

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

/** Snapshots every live process's pid, parent pid, command line and creation time (as raw
 * `DateTime.Ticks`, a plain sortable number -- avoids parsing WMI's own DMTF datetime string
 * format) via PowerShell/CIM. Tolerates a malformed/empty response (process list queries are
 * inherently racy) by returning no rows rather than throwing. */
function liveProcessTree() {
  const script =
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,@{N='CreationTicks';E={ if ($_.CreationDate) { $_.CreationDate.Ticks } else { 0 } }} | ConvertTo-Json -Compress";
  const result = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || !result.stdout) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/** The live creation-ticks of exactly this pid right now, or `null` if it is not currently a
 * live process (already exited, or never existed). */
function creationTicksOf(pid) {
  const row = liveProcessTree().find((r) => r.ProcessId === pid);
  return row ? row.CreationTicks : null;
}

/** Every currently-live process (full row: pid, parent pid, command line, creation ticks)
 * transitively descended from `rootPid`, validated against `rootCreationTicks` (captured once,
 * right after this script spawned the root, while it was still known-alive): a parent -> child
 * link is followed only when the recorded child's own creation time is at or after the parent's
 * (gate-fix, security review HIGH). Windows never updates a process's own recorded parent pid,
 * and pids get reused -- without this check, a long-lived, wholly unrelated process (Stuart's
 * own terminal, a live Refract tree, anything started by a launcher that has since exited) whose
 * stale recorded parent pid happens to equal a pid this harness used earlier would be
 * force-killed as if it were "our child". */
function liveDescendants(rootPid, rootCreationTicks) {
  const rows = liveProcessTree();
  const childrenOf = new Map();
  for (const row of rows) {
    const list = childrenOf.get(row.ParentProcessId) ?? [];
    list.push(row);
    childrenOf.set(row.ParentProcessId, list);
  }
  const out = [];
  const visited = new Set([rootPid]);
  const queue = [{ pid: rootPid, creationTicks: rootCreationTicks }];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const child of childrenOf.get(current.pid) ?? []) {
      if (visited.has(child.ProcessId)) continue;
      if (typeof child.CreationTicks !== 'number' || typeof current.creationTicks !== 'number') continue;
      if (child.CreationTicks < current.creationTicks) continue; // stale/reused parent link
      visited.add(child.ProcessId);
      out.push(child);
      queue.push({ pid: child.ProcessId, creationTicks: child.CreationTicks });
    }
  }
  return out;
}

/** Confirms the process actually listening with `--remote-debugging-port=<port>` on its own
 * command line is a genuine descendant of `child` (gate-fix, security review MEDIUM): even with
 * `getFreePort()` removing the usual collision window, this is a belt-and-braces check that the
 * CDP target `waitForCdpTarget` attached to truly belongs to the process this script launched,
 * not some other instance that raced onto the same port between the check and the connect. */
export function isPortOwnedBy(port, child) {
  const rootCreationTicks = child?.__refractCreationTicks;
  if (!child?.pid || rootCreationTicks == null) return false;
  const needle = `--remote-debugging-port=${port}`;
  const descendants = liveDescendants(child.pid, rootCreationTicks);
  return descendants.some((row) => typeof row.CommandLine === 'string' && row.CommandLine.includes(needle));
}

function killByPid(pid) {
  return new Promise((resolve) => {
    const tk = spawn('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true, stdio: 'ignore' });
    tk.on('exit', resolve);
    tk.on('error', resolve);
  });
}

/** Spawns a process and immediately records its own creation time (while its pid is certainly
 * still live and certainly still this process), attaching it as `child.__refractCreationTicks`
 * for `stopProcess` to validate against later. Callers MUST use this (not a bare `spawn`) for
 * anything `stopProcess` will later tear down. */
export async function launchTracked(command, args, options) {
  const child = spawn(command, args, { windowsHide: true, ...options });
  child.__refractCreationTicks = child.pid ? creationTicksOf(child.pid) : null;
  return child;
}

/** Stops the process this script itself started: asks it to exit, then force-kills every
 * process still transitively descended from it (descendants first, the root last -- see
 * `liveDescendants`'s own doc comment for why each link is validated by creation time). Every
 * kill is a literal, explicit pid -- never a kill by image name -- matching AGENTS.md's
 * destructive-operations rule applied to processes.
 *
 * Needed because the launched exe's own WebView2 process tree (and anything further it spawns,
 * like the fake `omp` shim) must be torn down too: a crash or an already-exited parent leaves
 * Windows' own parent-pid bookkeeping as the only trace of that relationship, so a plain
 * `taskkill /T` against an already-dead pid cannot find them.
 *
 * Gate-fix (security review HIGH): the root pid itself is force-killed only while this function
 * can still prove, by BOTH pid and creation time, that it is the exact same process `child` --
 * never after `child`'s own `exit` event has already fired (the pid may have been reused by an
 * unrelated process in the meantime), and the creation-time check that gates descendant discovery
 * applies here too. */
export async function stopProcess(child, { graceMs = 5000 } = {}) {
  const pid = child?.pid;
  if (!pid) return;
  // Captured at launch time by `launchTracked`, never re-derived here: by the time this function
  // runs the pid may already be gone (or reused), so a lazy query here could silently adopt the
  // wrong process's creation time.
  const rootCreationTicks = child.__refractCreationTicks ?? null;

  let rootAlreadyExited = child.exitCode !== null || child.killed;
  if (!rootAlreadyExited) {
    try {
      child.kill();
    } catch {
      // already gone
    }
    rootAlreadyExited = await Promise.race([new Promise((resolve) => child.once('exit', () => resolve(true))), sleep(graceMs).then(() => false)]);
  }

  if (rootCreationTicks != null) {
    for (const descendant of liveDescendants(pid, rootCreationTicks)) await killByPid(descendant.ProcessId);
  }

  if (!rootAlreadyExited && rootCreationTicks != null && creationTicksOf(pid) === rootCreationTicks) {
    await killByPid(pid);
  }
}

export { sleep };
