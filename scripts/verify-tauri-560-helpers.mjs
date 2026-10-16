// Helper functions for verify-tauri-560.mjs, split out solely to keep that script under the
// repo's 600-line soft cap (scripts/check-file-size.mjs) -- no behaviour change from the
// original single-file version. See verify-tauri-560.mjs's own header comment for what this
// live check proves; this module holds the process/CDP/AX plumbing it drives through, not any
// of the actual assertions.

import { mkdirSync, existsSync, copyFileSync, createWriteStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { waitForCdpTarget, CdpSession, isTargetOwningPort, launchViaJobObject, sleep } from './verify-tauri-cdp.mjs';
import { addRepository } from './verify-tauri-session-list-helpers.mjs';
import { gitHead, sha256OfFile, buildAndCopyExeFresh } from './verify-tauri-scratch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// This story's own frozen copy (recorded at freeze time, round 1: built from HEAD
// f3014aeb89ee74ddeab90fd08e3823c8675a4d4a). No frozen exe is currently trustworthy: TWO more
// commits of real, app-behaviour-changing fixes (f3014ae's own round-1 remediation was the
// commit that exe was frozen from, plus round-2's 96b662f on top of it, plus the current
// uncommitted round-2 remediation) have landed since that freeze, none of them exercised by any
// frozen copy -- `FROZEN_EXE_EXPECTED_GIT_HEAD` is deliberately an impossible value so
// `resolveExe` below always falls through to a fresh `buildAndCopyExeFresh` rebuild rather than
// silently reusing a stale binary that predates these fixes.
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

/** Same freeze-and-reuse posture as verify-tauri-559.mjs's own `copyBuiltExe`, but refuses (and
 * tells the caller to rebuild) rather than silently falling back to a shared `BUILD_OUTPUT_DIR`
 * exe that a DIFFERENT, concurrently-running lane may be mid-rebuild of -- confirmed live in
 * this exact run (`cargo`/`rustc`/`link` processes observed running, not started by this
 * script) that the shared target dir is not a safe fallback source right now. */
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

/** Combines `CdpSession.pressEnter()`'s own `text`/`unmodifiedText` fields (needed for a native
 * default button-activation action to fire) with `pressKey`'s explicit `key`/`code` (needed for
 * Chromium to treat it as the real key per that helper's own doc comment) -- round 1 of this
 * script used `pressKey` alone (no text fields) and Enter moved focus nowhere, confirmed live:
 * the HealthCheckDialog never opened. */
export async function pressRealEnter(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
}

/** `getAccessibleNameAndRole` reads `nodes[0]`'s own `name`, which is reliable for a WIDGET
 * (a button with an `aria-label`) but not for a plain text-content `<span>`: Chromium's AX tree
 * computes "name" on the role the text is naturally exposed through, often nested leaves under
 * the requested node rather than on the node itself. Round 1 used `fetchRelatives: true` and
 * scanned every returned node for the first non-null name, which actually made things WORSE,
 * confirmed live: that also pulls in ANCESTORS (up to the document root), so the first hit was
 * the document title ("Refract"), not the span. Round 2 fixed that by fetching only the exact
 * node's own DIRECT children via `Accessibility.getChildAXNodes`, but then returned just the
 * FIRST child's name -- still wrong, confirmed live again: `Low memory ({warning.liveAgents}
 * agents)` is JSX with an interpolated expression between two string literals, which React
 * renders as THREE separate sibling text nodes (`"Low memory ("`, the number, `" agents)"`),
 * each its own leaf AX node -- the first child alone is a truncated fragment. Concatenates
 * every direct child's own name in DOM order instead of stopping at the first. */
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

/** Polls `textExpr` every `intervalMs` while `aliveExpr` stays true, collecting EVERY sampled
 * value -- not just the first or the last -- so a title/description that goes blank partway
 * through a Radix exit animation (the DOM node stays mounted for the animation's duration
 * before unmounting) is caught even though both endpoints look fine. Checks `aliveExpr` BEFORE
 * each text read (round 1 of this helper sampled text unconditionally then checked `aliveExpr`
 * after, so the loop's own final iteration -- taken the instant the container had already
 * unmounted -- always recorded a trailing `null`, confirmed live: that is this helper sampling
 * its own teardown, not the app going blank, and does not belong in the returned samples).
 * Returns once `aliveExpr` goes false or `timeoutMs` elapses. */
export async function sampleWhileAlive(cdp, textExpr, aliveExpr, { intervalMs = 20, timeoutMs = 5_000 } = {}) {
  const samples = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await cdp.evaluate(aliveExpr))) break;
    samples.push(await cdp.evaluate(`${textExpr} ?? null`));
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

/** The open button's own `data-session-open` attribute holds `session.id` directly
 * (SessionRow.tsx) -- reads it straight off the DOM instead of needing a second IPC round trip
 * just to learn which Session a quick-create click just produced. `excludeIds` (already-known
 * Session ids in this same Project) matters once a second Session exists alongside a first,
 * STOPPED one that never leaves the DOM (stopping never archives it) -- a positional "first
 * match" would silently keep re-returning the first Session instead of the new one, regardless
 * of render order. */
export async function latestSessionIdAndName(cdp, repoName, excludeIds = []) {
  const result = await cdp.evaluate(
    `(() => { const group = Array.from(document.querySelectorAll('[data-repository-id]')).find((el) => el.textContent.includes(${JSON.stringify(repoName)})); if (!group) return null; const exclude = new Set(${JSON.stringify(excludeIds)}); const btn = Array.from(group.querySelectorAll('li [data-session-open]')).find((el) => !exclude.has(el.getAttribute('data-session-open'))); if (!btn) return null; return { id: btn.getAttribute('data-session-open'), name: btn.getAttribute('aria-label').split(',')[0] }; })()`
  );
  assert(result && result.id, `a new Session must exist in ${repoName} not among ${JSON.stringify(excludeIds)} (got ${JSON.stringify(result)})`);
  return result;
}
