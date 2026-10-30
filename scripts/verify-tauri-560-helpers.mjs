// Process/CDP/AX plumbing for verify-tauri-560.mjs, split out for the repo's 600-line cap.

import { mkdirSync, existsSync, copyFileSync, createWriteStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { waitForCdpTarget, CdpSession, isTargetOwningPort, launchViaJobObject, sleep } from './verify-tauri-cdp.mjs';
import { addRepository } from './verify-tauri-session-list-helpers.mjs';
import { gitHead, sha256OfFile, buildAndCopyExeFresh } from './verify-tauri-scratch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// No frozen exe is trustworthy (fixes landed since it was frozen), so the expected head/hash are
// impossible values that force `resolveExe` to rebuild rather than reuse a stale binary.
const FROZEN_EXE_DEFAULT = 'C:/Users/shopwood/AppData/Local/Temp/refract-560-scratch/refract-tauri-560.exe';
const FROZEN_EXE_EXPECTED_GIT_HEAD = 'NO-TRUSTWORTHY-FROZEN-EXE-REBUILD-REQUIRED';
const FROZEN_EXE_EXPECTED_HASH = 'NO-TRUSTWORTHY-FROZEN-EXE-REBUILD-REQUIRED';

export function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

export function buildOmpShim(dir) {
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'omp.exe');
  const result = spawnSync_('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-omp-shim.rs'), '-o', out]);
  if (result.status !== 0) throw new Error(`buildOmpShim: rustc failed (exit ${result.status}):\n${result.stderr}`);
  return out;
}

/** Like verify-tauri-559's `copyBuiltExe`, but refuses rather than falling back to the shared
 * `BUILD_OUTPUT_DIR` exe, which a concurrent lane may be mid-rebuild of. */
export function resolveExe(destDir, repoRoot, buildOutputDir) {
  const gitHeadValue = gitHead(repoRoot);
  const frozenSrc = process.env.REFRACT_560_FROZEN_EXE || FROZEN_EXE_DEFAULT;
  const frozenUsable = gitHeadValue === FROZEN_EXE_EXPECTED_GIT_HEAD && existsSync(frozenSrc) && sha256OfFile(frozenSrc).toLowerCase() === FROZEN_EXE_EXPECTED_HASH;
  if (frozenUsable) {
    mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, 'refract-tauri.exe');
    const buildTime = statSync(frozenSrc).mtime.toISOString();
    copyFileSync(frozenSrc, dest);
    const hash = sha256OfFile(dest);
    console.log(`verify-tauri-560: HEAD still ${gitHeadValue} and frozen exe hash still matches -- reusing ${frozenSrc} (copied sha256 ${hash})`);
    return { dest, hash, buildTime, gitHeadValue, rebuilt: false };
  }
  console.log(`verify-tauri-560: frozen exe no longer usable (HEAD ${gitHeadValue}, expected ${FROZEN_EXE_EXPECTED_GIT_HEAD}, frozen file ${existsSync(frozenSrc) ? 'present' : 'MISSING'}) -- rebuilding fresh.`);
  const { dest, hash } = buildAndCopyExeFresh(destDir, buildOutputDir, repoRoot, { label: 'verify-tauri-560' });
  return { dest, hash, buildTime: statSync(dest).mtime.toISOString(), gitHeadValue, rebuilt: true };
}

export async function launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, pathPrepend, extraEnv = {}, logFile }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const webview2DataDir = path.join(path.dirname(exePath), `webview2-data-${stamp}`);
  mkdirSync(webview2DataDir, { recursive: true });
  const pidFile = path.join(path.dirname(exePath), `target-${stamp}.pid`);
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
    REFRACT_DATA_DIR: dataDir,
    REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
    ...extraEnv
  };
  if (pathPrepend) env.PATH = `${pathPrepend};${process.env.PATH}`;
  const { child, targetPid } = await launchViaJobObject(launcherExe, pidFile, exePath, [], { cwd: path.dirname(exePath), env });
  if (logFile) {
    const stream = createWriteStream(logFile);
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
  }
  return { child, targetPid };
}

export function worktreesDirFor(repoDir) {
  return path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
}

export async function connectCdp(port, targetPid) {
  const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
  const cdp = await CdpSession.connect(wsUrl);
  if (!isTargetOwningPort(port, targetPid)) {
    throw new Error(`verify-tauri-560: CDP target on port ${port} is not owned by this run's own process (pid ${targetPid}) -- refusing to drive it`);
  }
  return cdp;
}

export async function addRepositoryDiag(cdp, dir, evidenceDir, log) {
  try {
    await addRepository(cdp, dir);
  } catch (err) {
    const diag = await cdp.evaluate(
      `(() => ({ dialogPresent: !!document.querySelector('[role="dialog"]'), dialogInputValue: document.querySelector('[role="dialog"] input')?.value ?? null, dialogButtons: Array.from(document.querySelectorAll('[role="dialog"] button')).map((b) => b.textContent.trim()), activeElement: document.activeElement?.tagName }))()`
    );
    log(`verify-tauri-560: addRepository FAILED -- diagnostics: ${JSON.stringify(diag, null, 2)}`);
    await cdp.screenshot(path.join(evidenceDir, '99-diag-add-repository-failure.png'));
    throw err;
  }
}

/** Enter needs both `text`/`unmodifiedText` (native button activation) and `key`/`code` (Chromium treats it as the real key); `pressKey` alone moved focus nowhere. */
export async function pressRealEnter(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
}

/** Concatenates every direct child's AX name in DOM order. `nodes[0]` is unreliable for plain text,
 * `fetchRelatives` pulls in ancestors (document title), and JSX like `Low memory ({n} agents)`
 * renders as three sibling text nodes, so the first child alone is a truncated fragment. */
export async function axText(cdp, selectorExpr) {
  await cdp.send('Accessibility.enable');
  const evalResult = await cdp.send('Runtime.evaluate', { expression: selectorExpr, returnByValue: false });
  const objectId = evalResult.result?.objectId;
  if (!objectId) return null;
  const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { objectId, fetchRelatives: false });
  const target = nodes?.[0];
  if (!target) return null;
  if (target.name?.value) return target.name.value;
  if (!target.nodeId) return null;
  const { nodes: children } = await cdp.send('Accessibility.getChildAXNodes', { id: target.nodeId });
  const names = (children ?? []).map((child) => child.name?.value).filter((value) => value != null);
  return names.length > 0 ? names.join('') : null;
}

/** Collects every sampled value while `aliveExpr` holds, so a title that blanks mid Radix exit
 * animation is caught. Both expressions run in ONE `evaluate` so the container can't unmount
 * between the check and the read; a `null` sample therefore means the title really went blank. */
export async function sampleWhileAlive(cdp, textExpr, aliveExpr, { intervalMs = 20, timeoutMs = 5_000 } = {}) {
  const samples = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await cdp.evaluate(`(() => { const alive = !!(${aliveExpr}); return alive ? { alive: true, text: (${textExpr}) ?? null } : { alive: false, text: null }; })()`);
    if (!snapshot.alive) break;
    samples.push(snapshot.text);
    await sleep(intervalMs);
  }
  return samples;
}

export async function waitForSessionStatus(cdp, sessionId, status, { timeoutMs = 60_000 } = {}) {
  await cdp.waitFor(
    `window.refract.sessions.list().then((r) => r.ok && r.value.find((s) => s.id === ${JSON.stringify(sessionId)})?.status === ${JSON.stringify(status)})`,
    { timeoutMs, label: `session ${sessionId} reaches status ${status}` }
  );
}

/** Reads `session.id` from `data-session-open`. `excludeIds` is needed because a STOPPED session
 * stays in the DOM, so a positional "first match" would keep returning the old one. */
export async function latestSessionIdAndName(cdp, repoName, excludeIds = []) {
  const result = await cdp.evaluate(
    `(() => { const group = Array.from(document.querySelectorAll('[data-repository-id]')).find((el) => el.textContent.includes(${JSON.stringify(repoName)})); if (!group) return null; const exclude = new Set(${JSON.stringify(excludeIds)}); const btn = Array.from(group.querySelectorAll('li [data-session-open]')).find((el) => !exclude.has(el.getAttribute('data-session-open'))); if (!btn) return null; return { id: btn.getAttribute('data-session-open'), name: btn.getAttribute('aria-label').split(',')[0] }; })()`
  );
  assert(result && result.id, `a new Session must exist in ${repoName} not among ${JSON.stringify(excludeIds)} (got ${JSON.stringify(result)})`);
  return result;
}
