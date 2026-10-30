#!/usr/bin/env node
// Live CDP check for #1402 (Session usage panel), #1409 (WATCHDOG.yml advisor roster) against a real
// debug exe, scratch data and its own port. #1400 (loading overlay) is skipped: the 504 fake gh cannot delay a call.
// Usage: CARGO_TARGET_DIR=<shared target dir> SHOTS_DIR=<evidence dir> node scripts/verify-tauri-1402-1409.mjs

import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget, makeScratchRepo } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { buildFakeClis } from './verify-1331-fixtures.mjs';
import { addRepository, createSessionViaQuickCreate, rightClick } from './verify-tauri-session-list-helpers.mjs';
import { ADVISOR_MODEL, EXPECT_ALL, EXPECT_SESSION, ROSTER_MODELS, ROSTER_YAML, writeEmptySessions, writePopulatedSessions } from './verify-tauri-1402-1409-fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1402-1409';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.SHOTS_DIR || mkdtempSync(path.join(tmpdir(), 'refract-1402-1409-shots-'));

const steps = [];
const screenshots = [];
const skipped = [];
const record = (name, pass, detail = '') => {
  steps.push({ name, pass: !!pass, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  console.log(`${LOG}: ${pass ? 'PASS' : 'FAIL'} ${name}${pass || !detail ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
};
const q = JSON.stringify;
const body = `document.body.innerText`;

async function shot(cdp, name) {
  const file = path.join(SHOTS_DIR, `${name}.png`);
  await cdp.screenshot(file);
  screenshots.push(file);
  return file;
}

const PANEL_SCROLLER = `Array.from(document.querySelectorAll('div.overflow-y-auto')).find((el) => el.innerText.includes('By model'))`;

async function overflowOf(cdp) {
  return cdp.evaluate(`(() => { const s = ${PANEL_SCROLLER}; if (!s) return null; const root = s.parentElement;
    return { scroller: [s.scrollWidth, s.clientWidth], root: [root.scrollWidth, root.clientWidth], width: Math.round(root.getBoundingClientRect().width) }; })()`);
}

async function setPaneWidth(cdp, label) {
  await rightClick(cdp, `document.querySelector('[role="separator"][aria-label^="Resize right pane"]')`);
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('[role="menuitem"],[role="menuitemradio"]')).find((el) => el.textContent.includes(${q(label)}))`, { timeoutMs: 10_000, label: `width menu ${label}` });
  await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"],[role="menuitemradio"]')).find((el) => el.textContent.includes(${q(label)}))`);
  await sleep(600);
}

async function openUsagePanel(cdp) {
  const rail = `document.querySelector('[data-rail-button="session-usage"]')`;
  if (!(await cdp.evaluate(`!!${rail}`))) await cdp.click(`document.querySelector('[data-rail-toggle]') ?? document.querySelector('[aria-label="Right pane"]')`);
  await cdp.waitFor(`!!${rail}`, { timeoutMs: 15_000, label: 'Session usage rail button' });
  await cdp.click(rail);
  await sleep(1200);
  // A persisted active panel makes the rail click close it, leaving the picker; pick the panel from there.
  if (await cdp.evaluate(`document.body.innerText.includes('Agent Builder')`)) await cdp.clickByText('Session usage');
}

async function bannerState(cdp) {
  return cdp.evaluate(`(() => { const b = document.querySelector('[data-slot="advisor-roster-notice"]'); if (!b) return null;
    const btns = Array.from(b.querySelectorAll('button')).map((x) => x.textContent.trim()); return { text: b.innerText, btns }; })()`);
}

async function settingsAdvisorText(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`document.body.innerText.includes('Models')`, { timeoutMs: 15_000, label: 'Settings open' });
  await cdp.clickByText('Models');
  await cdp.waitFor(`document.body.innerText.includes('Advisor')`, { timeoutMs: 20_000, label: 'Advisor row' });
  await sleep(1500);
  return cdp.evaluate(`document.body.innerText`);
}

async function backToChat(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
  await sleep(500);
}

async function main() {
  const head = gitHead(REPO_ROOT);
  console.log(`${LOG}: git HEAD ${head}`);
  mkdirSync(SHOTS_DIR, { recursive: true });
  const mk = (n) => mkdtempSync(path.join(tmpdir(), `refract-1402-${n}-`));
  const dataDir = mk('data'), sessionsDir = mk('sessions'), importDir = mk('import'), exeDir = mk('exe'), launcherDir = mk('launcher'), shimDir = mk('shim'), agentDir = mk('agent'), repoDir = mk('repo');
  const dirs = [dataDir, sessionsDir, importDir, exeDir, launcherDir, shimDir, agentDir, repoDir];
  const rosterFile = path.join(agentDir, 'WATCHDOG.yml');
  let child;
  let cdp;
  try {
    buildFakeClis(shimDir);
    const populated = writePopulatedSessions(sessionsDir);
    const empty = writeEmptySessions(sessionsDir);
    writeFileSync(rosterFile, ROSTER_YAML);
    makeScratchRepo(repoDir, 'v1402');
    const launcherExe = buildLauncher(launcherDir);
    const exeInfo = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    const launch = async (conversationFile) => {
      const port = await getFreePort();
      const l = await launchBuiltExe(launcherExe, exeInfo.dest, {
        port,
        dataDir,
        pathPrepend: shimDir,
        logFile: path.join(exeDir, 'app.log'),
        extraEnv: {
          REFRACT_IMPORT_SOURCE_DIR: importDir,
          REFRACT_OMP_SESSIONS_DIR: sessionsDir,
          PI_CODING_AGENT_DIR: agentDir,
          REFRACT_FAKE_OMP_SCENARIO: 'activity-line-526',
          REFRACT_FAKE_OMP_CONVERSATION_FILE: conversationFile
        }
      });
      child = l.child;
      cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
      if (!isTargetOwningPort(port, l.targetPid)) throw new Error(`${LOG}: CDP target is not owned by the launched process`);
    };
    await launch(populated.mainFile);
    const repoName = path.basename(repoDir);
    await addRepository(cdp, repoDir);
    await createSessionViaQuickCreate(cdp, repoName);

    // #1409: banner on launch with the roster present.
    await cdp.waitFor(`!!document.querySelector('[data-slot="advisor-roster-notice"]')`, { timeoutMs: 30_000, label: 'advisor roster banner' }).catch(() => null);
    const banner = await bannerState(cdp);
    record('#1409 PaneBanner shows roster warning with 2 advisors', !!banner && /2 advisors/.test(banner.text) && banner.text.includes(ROSTER_MODELS[0]), banner ?? 'banner absent');
    record('#1409 banner has Open file, Copy path and the file path', !!banner && ['Open file', 'Copy path'].every((b) => banner.btns.includes(b)) && banner.text.includes('WATCHDOG.yml'), banner ?? '');
    await shot(cdp, '1409-banner');
    if (banner?.btns.includes('Copy path')) {
      await cdp.clickByText('Copy path');
      const toast = await cdp.waitFor(`document.body.innerText.includes('Path copied')`, { timeoutMs: 8000, label: 'Path copied toast' }).then(() => true, () => false);
      record('#1409 Copy path gives a "Path copied" confirmation', toast);
    }
    const settingsText = await settingsAdvisorText(cdp);
    record('#1409 Settings > Models Advisor row shows the Warning note', /Warning:/.test(settingsText) && settingsText.includes('WATCHDOG.yml') && /2 advisors/.test(settingsText), settingsText.slice(0, 400));
    await shot(cdp, '1409-settings-warning');
    await backToChat(cdp);

    // #1402: panel with seeded data.
    await openUsagePanel(cdp);
    await cdp.waitFor(`document.body.innerText.includes('By model')`, { timeoutMs: 40_000, label: 'Session usage panel populated' });
    await sleep(1500);
    const panel = await cdp.evaluate(`(() => { const s = ${PANEL_SCROLLER}; return s ? s.innerText : ''; })()`);
    const has = (t) => panel.includes(t);
    record('#1402 panel shows By model, By tool, Recent calls, Token mix, spend chart', ['By model', 'By tool', 'Recent calls', 'Token mix', 'Spend over time'].every(has), panel.slice(0, 900));
    record('#1402 rail button named "Session usage"', await cdp.evaluate(`(document.querySelector('[data-rail-button="session-usage"]')?.getAttribute('aria-label') ?? '').startsWith('Session usage')`));
    record('#1402 counts include subagent and exclude the x-foo-bar sibling', new RegExp(`Recent calls[^\\d]*${EXPECT_SESSION.calls}\\b`).test(panel) && !has('1,000') && !has('2,000'), panel.slice(0, 900));
    const api = await cdp.evaluate(`Promise.all([window.refract.usage.summary({ range: 'all', sessionDir: ${q(populated.sessionDir)} }), window.refract.usage.summary({ range: 'all' })])`);
    const [bySession, all] = (api ?? []).map((r) => r?.value);
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    record('#1402 usage.summary(sessionDir) = 4 calls, 360 tokens, $0.10, 2 tool calls; sibling excluded', bySession?.calls === EXPECT_SESSION.calls && bySession?.totalTokens === EXPECT_SESSION.totalTokens && near(bySession?.spendUsd, EXPECT_SESSION.spendUsd) && bySession?.toolCalls === EXPECT_SESSION.toolCalls, { bySession, all });
    record('#1402 unfiltered summary sees all fixture calls (sibling + advisor exist)', (all?.calls ?? 0) > EXPECT_SESSION.calls && (all?.calls ?? 0) >= EXPECT_ALL.calls, all);
    await setPaneWidth(cdp, 'Narrow');
    const narrow = await overflowOf(cdp);
    await shot(cdp, '1402-panel-narrow');
    record('#1402 narrow width (240px) has no horizontal overflow', !!narrow && narrow.scroller[0] <= narrow.scroller[1] && narrow.root[0] <= narrow.root[1], narrow);
    await setPaneWidth(cdp, 'Wide');
    const wide = await overflowOf(cdp);
    await shot(cdp, '1402-panel-wide');
    record('#1402 wide width (520px) has no horizontal overflow', !!wide && wide.scroller[0] <= wide.scroller[1] && wide.root[0] <= wide.root[1], wide);

    // Advisor caption lives in the full Usage view's calls table.
    await cdp.clickByText('Usage');
    await cdp.waitFor(`!!document.querySelector('section[aria-label="Usage"] h1')`, { timeoutMs: 20_000, label: 'Usage view' });
    const caption = await cdp.waitFor(`document.querySelector('section[aria-label="Usage"]').innerText.includes('Advisor (WATCHDOG.yml roster)')`, { timeoutMs: 20_000, label: 'advisor caption' }).then(() => true, () => false);
    record(`#1409 Usage calls table captions the ${ADVISOR_MODEL} advisor call "Advisor (WATCHDOG.yml roster)"`, caption);
    await shot(cdp, '1409-usage-advisor-caption');

    // Empty state: a Session whose directory has no model calls.
    await stopLauncher(child);
    child = undefined;
    cdp.close?.();
    await launch(empty.mainFile);
    await createSessionViaQuickCreate(cdp, repoName);
    await openUsagePanel(cdp);
    const emptyOk = await cdp.waitFor(`document.body.innerText.includes('No usage yet in this session')`, { timeoutMs: 40_000, label: 'empty state' }).then(() => true, () => false);
    record('#1402 empty state "No usage yet in this session" for a call-less Session', emptyOk);
    await shot(cdp, '1402-panel-empty');

    // #1409: remove the roster; the next Session launch has no warning.
    if (!rosterFile.startsWith(agentDir) || !existsSync(rosterFile)) throw new Error('roster file missing before removal');
    await safeRmSync(rosterFile, LOG);
    await stopLauncher(child);
    child = undefined;
    await launch(populated.mainFile);
    await createSessionViaQuickCreate(cdp, repoName);
    await sleep(3000);
    const after = await bannerState(cdp);
    record('#1409 banner gone after the roster file is removed', after === null, after ?? '');
    await shot(cdp, '1409-banner-gone');
    const settingsAfter = await settingsAdvisorText(cdp);
    record('#1409 Settings Advisor row has no roster Warning after removal', !/WATCHDOG\.yml/.test(settingsAfter), settingsAfter.slice(0, 300));
    await shot(cdp, '1409-settings-clean');
    skipped.push({ name: '#1400 loading overlay', reason: 'the 504 fake gh has no delay hook, and adding one is not cheap' });
  } catch (err) {
    record('script completed without error', false, String(err?.stack ?? err));
    if (cdp) await shot(cdp, 'error').catch(() => null);
  } finally {
    try { cdp?.close?.(); } catch {}
    if (child) await stopLauncher(child).catch(() => null);
    for (const d of dirs) {
      try { await safeRmSync(d, LOG); } catch (e) { console.log(`${LOG}: cleanup ${d}: ${e.message}`); }
    }
    const reportPath = path.join(SHOTS_DIR, 'report.json');
    writeFileSync(reportPath, JSON.stringify({ gitHead: head, steps, skipped, screenshots }, null, 2));
    console.log(`${LOG}: report ${reportPath}`);
    process.exitCode = steps.every((s) => s.pass) ? 0 : 1;
  }
}

main();
