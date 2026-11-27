#!/usr/bin/env node
// Live CDP check for epic #2225 session-list UI: #1760 (Session details card opens after 1200 ms, stays closed after a click) and
// #1854 (collapsed Project header shows the active-Session count badge and tooltip). Two Sessions are held mid-turn by the
// never-settling `1067-enter-queued` fake-omp tape, so both stay working.
// Usage: CARGO_TARGET_DIR=<shared target dir> SHOTS_DIR=<evidence dir> node scripts/verify-tauri-2225-session-list-ui.mjs
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget, makeScratchRepo } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { buildFakeClis } from './verify-1331-fixtures.mjs';
import { addRepository, createSessionViaQuickCreate, groupTriggerFinder, hoverRow } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-2225-ui';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.SHOTS_DIR || mkdtempSync(path.join(tmpdir(), 'refract-2225-shots-'));
const q = JSON.stringify;
const OPEN_DELAY_MS = 1200;
const steps = [];
const record = (name, pass, detail = '') => {
  steps.push({ name, pass: !!pass, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  console.log(`${LOG}: ${pass ? 'PASS' : 'FAIL'} ${name}${pass || !detail ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
};

const CARD = `document.querySelector('[data-slot="hover-card-content"]')`;
const cardOpen = (cdp) => cdp.evaluate(`!!${CARD}`);
const rowFinder = (name) => `Array.from(document.querySelectorAll('[data-repository-id] li [data-session-open]')).find((el) => el.getAttribute('aria-label').startsWith(${q(name)}))`;

/** Pointer parked away from every row, long enough for any open card to close. */
async function parkPointer(cdp) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
  await cdp.waitFor(`!${CARD}`, { timeoutMs: 5_000, label: 'details card closed with the pointer parked' }).catch(() => null);
  await sleep(300);
}

/** Polls every 40 ms for up to `withinMs`; resolves the elapsed ms since `t0` when the card first appears, else null. */
async function cardAppearsAfter(cdp, t0, withinMs) {
  while (Date.now() - t0 < withinMs) {
    if (await cardOpen(cdp)) return Date.now() - t0;
    await sleep(40);
  }
  return null;
}

async function main() {
  const head = gitHead(REPO_ROOT);
  console.log(`${LOG}: git HEAD ${head}`);
  mkdirSync(SHOTS_DIR, { recursive: true });
  const mk = (n) => mkdtempSync(path.join(tmpdir(), `refract-2225-${n}-`));
  const dataDir = mk('data'), sessionsDir = mk('sessions'), importDir = mk('import'), exeDir = mk('exe'), launcherDir = mk('launcher'), shimDir = mk('shim'), agentDir = mk('agent'), repoDir = mk('repo');
  const dirs = [dataDir, sessionsDir, importDir, exeDir, launcherDir, shimDir, agentDir, repoDir];
  let child, cdp;
  const shot = async (name) => { const f = path.join(SHOTS_DIR, `${name}.png`); await cdp.screenshot(f); console.log(`${LOG}: shot ${f}`); };
  try {
    buildFakeClis(shimDir);
    makeScratchRepo(repoDir, 'v2225');
    const launcherExe = buildLauncher(launcherDir);
    const exeInfo = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    const port = await getFreePort();
    const l = await launchBuiltExe(launcherExe, exeInfo.dest, {
      port, dataDir, pathPrepend: shimDir, logFile: path.join(exeDir, 'app.log'),
      extraEnv: { REFRACT_IMPORT_SOURCE_DIR: importDir, REFRACT_OMP_SESSIONS_DIR: sessionsDir, PI_CODING_AGENT_DIR: agentDir, REFRACT_FAKE_OMP_SCENARIO: '1067-enter-queued' }
    });
    child = l.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, l.targetPid)) throw new Error(`${LOG}: CDP target is not owned by the launched process`);
    await cdp.evaluate(`window.refract.theme.set('dark')`);
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return !!b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 90_000, label: 'readiness green' });
    const repoName = path.basename(repoDir);
    await addRepository(cdp, repoDir);
    // Each new Session becomes the open one; its composer starts the never-settling turn that keeps it `working`.
    const startWorking = async (n) => {
      await createSessionViaQuickCreate(cdp, repoName);
      await cdp.typeIntoByLabel('Message', `Start the long task ${n} (issue #2225 live check)`);
      await cdp.clickByLabel('Send message');
      await cdp.waitFor(`window.refract.sessions.list().then((r) => r.ok && r.value.filter((s) => s.status !== 'idle' && s.status !== 'stopped').length === ${n})`, { timeoutMs: 40_000, label: `${n} Session(s) active` });
    };
    await startWorking(1);
    await startWorking(2);
    const listed = await cdp.evaluate(`window.refract.sessions.list().then((r) => r.ok ? r.value.map((s) => ({ id: s.id, name: s.name, status: s.status })) : [])`);
    record('Two Sessions exist in the scratch Project and both are active', listed.length === 2 && listed.every((s) => s.status !== 'idle' && s.status !== 'stopped'), listed);

    // ---- #1760: hover delay, then no reopen after a click.
    const selectedNow = await cdp.evaluate(`(() => { const el = Array.from(document.querySelectorAll('[data-repository-id] li [data-session-open]')).find((b) => b.getAttribute('aria-current') === 'true'); return el ? el.getAttribute('aria-label') : null; })()`);
    const target = listed.find((s) => !(selectedNow ?? '').startsWith(s.name)) ?? listed[0];
    const finder = rowFinder(target.name);
    await parkPointer(cdp);
    record('Card is closed before hovering', !(await cardOpen(cdp)));
    await hoverRow(cdp, finder);
    const t0 = Date.now();
    await sleep(700);
    record('Card is still closed at ~750 ms (old delay would have opened it)', !(await cardOpen(cdp)), { elapsedMs: Date.now() - t0 });
    await sleep(300);
    const early = await cardOpen(cdp);
    record('Card is still closed at ~1050 ms', !early, { elapsedMs: Date.now() - t0 });
    const openedAt = await cardAppearsAfter(cdp, t0, 4_000);
    record(`Card opens after the ${OPEN_DELAY_MS} ms delay`, openedAt !== null && openedAt >= OPEN_DELAY_MS - 100, { openedAfterMs: openedAt });
    await shot('1-hover-card-open-after-delay');

    await parkPointer(cdp);
    await hoverRow(cdp, finder);
    await sleep(OPEN_DELAY_MS + 600);
    const beforeClick = await cardOpen(cdp);
    await cdp.click(finder);
    await sleep(300);
    const closedByClick = !(await cardOpen(cdp));
    await sleep(OPEN_DELAY_MS + 1200);
    const reopened = await cardOpen(cdp);
    record('Card was open before the click', beforeClick);
    record('Click closes the card and it does not reopen while the pointer stays on the row', closedByClick && !reopened, { closedByClick, reopened });
    await shot('2-after-click-no-reopen');

    await parkPointer(cdp);
    await hoverRow(cdp, finder);
    const t1 = Date.now();
    const reopenedAfterLeave = await cardAppearsAfter(cdp, t1, 4_000);
    record('Leaving the row and coming back opens the card again after the delay', reopenedAfterLeave !== null && reopenedAfterLeave >= OPEN_DELAY_MS - 100, { openedAfterMs: reopenedAfterLeave });
    await parkPointer(cdp);

    // ---- #1854: collapsed Project header badge.
    const trigger = groupTriggerFinder(repoName);
    const expandedBadge = await cdp.evaluate(`(() => { const t = ${trigger}; return !!t && !!t.querySelector('[data-slot="badge"]'); })()`);
    record('Expanded Project header shows no badge', !expandedBadge);
    await cdp.click(trigger);
    await cdp.waitFor(`${trigger}.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 10_000, label: 'Project collapsed' });
    const badge = await cdp.waitFor(`(() => { const t = ${trigger}; const b = t && t.querySelector('[data-slot="badge"]'); return b ? { text: b.textContent.trim(), label: t.getAttribute('aria-label') } : null; })()`, { timeoutMs: 10_000, label: 'badge on the collapsed header' }).catch(() => null);
    record('Collapsed header shows a "2" badge', badge?.text === '2', badge);
    record('Trigger accessible name lists both Sessions with their statuses', !!badge && badge.label.includes('2 active Sessions') && listed.every((s) => badge.label.includes(`${s.name}: `)), badge);
    await cdp.evaluate(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
    await hoverRow(cdp, trigger);
    const tip = await cdp.waitFor(`(() => { const t = document.querySelector('[data-slot="tooltip-content"]'); return t ? t.textContent : null; })()`, { timeoutMs: 8_000, label: 'tooltip' }).catch(() => null);
    record('Tooltip names both Sessions', !!tip && listed.every((s) => tip.includes(`${s.name}: `)), { tip });
    await shot('3-collapsed-badge-tooltip');
    await parkPointer(cdp);

    await cdp.click(trigger);
    await cdp.waitFor(`${trigger}.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: 'Project expanded again' });
    const badgeAfterExpand = await cdp.evaluate(`(() => { const t = ${trigger}; return !!t && !!t.querySelector('[data-slot="badge"]'); })()`);
    record('Expanding the Project removes the badge', !badgeAfterExpand);
  } catch (err) {
    record('script completed without error', false, String(err?.stack ?? err));
    if (cdp) await shot('error').catch(() => null);
  } finally {
    try { cdp?.close?.(); } catch {}
    if (child) await stopLauncher(child).catch(() => null);
    for (const d of dirs) {
      try { await safeRmSync(d, LOG); } catch (e) { console.log(`${LOG}: cleanup ${d}: ${e.message}`); }
    }
    const reportPath = path.join(SHOTS_DIR, 'report.json');
    writeFileSync(reportPath, JSON.stringify({ gitHead: head, steps }, null, 2));
    console.log(`${LOG}: report ${reportPath}`);
    process.exitCode = steps.length > 0 && steps.every((s) => s.pass) ? 0 : 1;
  }
}

main();
