#!/usr/bin/env node
// Live CDP check for #1743 (Session usage panel scope and range toggles) against a scratch debug exe.
// Usage: CARGO_TARGET_DIR=<shared target dir> SHOTS_DIR=<evidence dir> node scripts/verify-tauri-1743.mjs
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget, makeScratchRepo } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { buildFakeClis } from './verify-1331-fixtures.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1743';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.SHOTS_DIR || mkdtempSync(path.join(tmpdir(), 'refract-1743-shots-'));
const q = JSON.stringify;
const steps = [];
const record = (name, pass, detail = '') => {
  steps.push({ name, pass: !!pass, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  console.log(`${LOG}: ${pass ? 'PASS' : 'FAIL'} ${name}${pass || !detail ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
};

const entry = (value) => `${JSON.stringify(value)}\n`;
const assistant = (id, ts, cost) =>
  entry({
    type: 'message', id, timestamp: new Date(ts).toISOString(),
    message: {
      role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: ts, model: 'claude-sonnet', provider: 'github-copilot',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost } }
    }
  });
const header = (id, ts) => entry({ type: 'session', id, timestamp: new Date(ts).toISOString(), cwd: 'C:\\Work\\verify1743proj' });

// Session = other.jsonl (1 yesterday + 1 today) + conv.jsonl (2 yesterday + 2 today).
// Expected calls: Session/All 6, Conversation/All 4, Session/Today 3, Conversation/Today 2.
const HOUR = 3600_000;
const EXPECT = { 'session/all': 6, 'conversation/all': 4, 'session/today': 3, 'conversation/today': 2 };
function writeSessions(root) {
  const now = Date.now();
  const sessionDir = path.join(root, 'x-v1743');
  mkdirSync(sessionDir, { recursive: true });
  const convFile = path.join(sessionDir, 'conv.jsonl');
  writeFileSync(path.join(sessionDir, 'other.jsonl'), header('o1', now - 30 * HOUR) + assistant('o-a', now - 30 * HOUR + 1000, 0.1) + assistant('o-b', now - 20 * 60_000, 0.07));
  writeFileSync(
    convFile,
    header('c1', now - 31 * HOUR) + assistant('c-a', now - 31 * HOUR + 1000, 0.02) + assistant('c-b', now - 28 * HOUR, 0.02) +
      assistant('c-c', now - 10 * 60_000, 0.03) + assistant('c-d', now - 5 * 60_000, 0.05)
  );
  return { sessionDir, convFile };
}

const PANEL = `Array.from(document.querySelectorAll('div.overflow-y-auto')).find((el) => el.querySelector('[aria-label="Usage scope"]'))`;
const selected = (cdp) =>
  cdp.evaluate(`(() => { const p = ${PANEL}; if (!p) return null; const on = (l) => (p.querySelector('[aria-label="' + l + '"]')?.querySelector('[data-state="on"]')?.textContent.trim() ?? '').toLowerCase().replace(' time', '');
    return { scope: on('Usage scope'), range: on('Usage range') }; })()`);
const callsShown = (cdp) => cdp.evaluate(`(() => { const p = ${PANEL}; const m = p && /Model calls\\s*([\\d,]+)/.exec(p.innerText); return m ? Number(m[1].replace(/,/g, '')) : null; })()`);
const clickSeg = (cdp, group, text) =>
  cdp.click(`Array.from(${PANEL}.querySelector('[aria-label=${q(group)}]').querySelectorAll('button,[role="radio"]')).find((b) => b.textContent.trim() === ${q(text)})`);
async function settleCalls(cdp, want, label) {
  const ok = await cdp.waitFor(`(() => { const p = ${PANEL}; const m = p && /Model calls\\s*([\\d,]+)/.exec(p.innerText); return !!m && Number(m[1].replace(/,/g, '')) === ${want}; })()`, { timeoutMs: 20_000, label }).then(() => true, () => false);
  return ok;
}
const key = async (cdp, k, code, vk) => {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
  await sleep(300);
};
const focusedLabel = (cdp) => cdp.evaluate(`(() => { const a = document.activeElement; return a ? (a.closest('[aria-label^="Usage "]')?.getAttribute('aria-label') ?? '') + '|' + a.textContent.trim() : null; })()`);

async function openUsagePanel(cdp) {
  const rail = `document.querySelector('[data-rail-button="session-usage"]')`;
  if (!(await cdp.evaluate(`!!${rail}`))) await cdp.click(`document.querySelector('[data-rail-toggle]') ?? document.querySelector('[aria-label="Right pane"]')`);
  await cdp.waitFor(`!!${rail}`, { timeoutMs: 15_000, label: 'Session usage rail button' });
  await cdp.click(rail);
  await sleep(1200);
  if (await cdp.evaluate(`document.body.innerText.includes('Agent Builder')`)) await cdp.clickByText('Session usage');
  await cdp.waitFor(`!!${PANEL}`, { timeoutMs: 20_000, label: 'usage panel with toggles' });
}

async function main() {
  const head = gitHead(REPO_ROOT);
  console.log(`${LOG}: git HEAD ${head}`);
  mkdirSync(SHOTS_DIR, { recursive: true });
  const mk = (n) => mkdtempSync(path.join(tmpdir(), `refract-1743-${n}-`));
  const dataDir = mk('data'), sessionsDir = mk('sessions'), importDir = mk('import'), exeDir = mk('exe'), launcherDir = mk('launcher'), shimDir = mk('shim'), agentDir = mk('agent'), repoDir = mk('repo');
  const dirs = [dataDir, sessionsDir, importDir, exeDir, launcherDir, shimDir, agentDir, repoDir];
  let child, cdp;
  const shot = async (name) => { const f = path.join(SHOTS_DIR, `${name}.png`); await cdp.screenshot(f); console.log(`${LOG}: shot ${f}`); };
  try {
    buildFakeClis(shimDir);
    const { sessionDir, convFile } = writeSessions(sessionsDir);
    makeScratchRepo(repoDir, 'v1743');
    const launcherExe = buildLauncher(launcherDir);
    const exeInfo = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    const launch = async () => {
      const port = await getFreePort();
      const l = await launchBuiltExe(launcherExe, exeInfo.dest, {
        port, dataDir, pathPrepend: shimDir, logFile: path.join(exeDir, 'app.log'),
        extraEnv: {
          REFRACT_IMPORT_SOURCE_DIR: importDir, REFRACT_OMP_SESSIONS_DIR: sessionsDir, PI_CODING_AGENT_DIR: agentDir,
          REFRACT_FAKE_OMP_SCENARIO: 'code-surface-975', REFRACT_FAKE_OMP_CONVERSATION_FILE: convFile
        }
      });
      child = l.child;
      cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
      if (!isTargetOwningPort(port, l.targetPid)) throw new Error(`${LOG}: CDP target is not owned by the launched process`);
      await cdp.evaluate(`window.refract.theme.set('dark')`);
    };
    await launch();
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return !!b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 90_000, label: 'readiness green' });
    await addRepository(cdp, repoDir);
    await createSessionViaQuickCreate(cdp, path.basename(repoDir));
    await cdp.waitFor(`window.refract.sessions.list().then((r) => r.ok && r.value.some((s) => s.sessionDir))`, { timeoutMs: 40_000, label: 'session has sessionDir' });
    record('Dark theme active', await cdp.evaluate(`document.documentElement.className.includes('theme-dark')`));

    // Conversation needs currentConversation; the fake omp persists it once a turn has been sent.
    const hasConv = () => cdp.evaluate(`window.refract.sessions.list().then((r) => r.ok && r.value.some((s) => s.currentConversation))`);
    if (!(await hasConv())) {
      await cdp.typeIntoByLabel('Message', 'hello');
      await cdp.clickByLabel('Send message');
      const approve = await cdp.waitFor(`!!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Approve')`, { timeoutMs: 20_000, label: 'approval' }).then(() => true, () => false);
      if (approve) await cdp.clickByText('Approve');
    }
    record('Session gets a currentConversation', await cdp.waitFor(`window.refract.sessions.list().then((r) => r.ok && r.value.some((s) => s.currentConversation))`, { timeoutMs: 40_000, label: 'currentConversation' }).then(() => true, () => false));

    await openUsagePanel(cdp);
    record('Defaults are Session and All time', JSON.stringify(await selected(cdp)) === '{"scope":"session","range":"all"}', await selected(cdp));
    record(`Session/All shows ${EXPECT['session/all']} calls`, await settleCalls(cdp, EXPECT['session/all'], 'session/all'), await callsShown(cdp));
    await shot('1-session-all');

    await clickSeg(cdp, 'Usage scope', 'Conversation');
    record(`Conversation/All shows ${EXPECT['conversation/all']} calls (one file only)`, await settleCalls(cdp, EXPECT['conversation/all'], 'conversation/all'), await callsShown(cdp));
    await shot('2-conversation-all');
    await clickSeg(cdp, 'Usage range', 'Today');
    record(`Conversation/Today shows ${EXPECT['conversation/today']} calls`, await settleCalls(cdp, EXPECT['conversation/today'], 'conversation/today'), await callsShown(cdp));
    await shot('3-conversation-today');
    await clickSeg(cdp, 'Usage scope', 'Session');
    record(`Session/Today shows ${EXPECT['session/today']} calls`, await settleCalls(cdp, EXPECT['session/today'], 'session/today'), await callsShown(cdp));
    await shot('4-session-today');

    const tz = await cdp.evaluate(`new Date().getTimezoneOffset()`);
    const apiToday = await cdp.evaluate(`window.refract.usage.summary({ range: 'today', sessionDir: ${q(sessionDir)} }, ${tz}).then((r) => r.value?.calls)`);
    record('Session+Today panel equals usage.summary(range today, sessionDir) with the Usage view offset', apiToday === EXPECT['session/today'], { apiToday });
    const apiConv = await cdp.evaluate(`window.refract.usage.summary({ range: 'all', sessionDir: ${q(sessionDir)}, sessionFile: ${q(convFile)} }).then((r) => r.value?.calls)`);
    record('usage.summary(sessionFile) counts the one conversation file', apiConv === EXPECT['conversation/all'], { apiConv });

    await clickSeg(cdp, 'Usage range', 'All time');
    await clickSeg(cdp, 'Usage range', 'All time');
    record('Re-pressing the selected segment keeps it selected', (await selected(cdp))?.range === 'all', await selected(cdp));

    // Keyboard: focus the Session segment, then arrows and Tab.
    await cdp.evaluate(`(() => { const g = ${PANEL}.querySelector('[aria-label="Usage scope"]'); Array.from(g.querySelectorAll('button,[role="radio"]')).find((b) => b.textContent.trim() === 'Session').focus(); })()`);
    await key(cdp, 'ArrowRight', 'ArrowRight', 39);
    const afterArrow = await focusedLabel(cdp);
    await key(cdp, ' ', 'Space', 32);
    const scopeAfterSpace = (await selected(cdp))?.scope;
    record('Keyboard: ArrowRight moves within the scope group and Space selects Conversation', afterArrow === 'Usage scope|Conversation' && scopeAfterSpace === 'conversation', { afterArrow, scopeAfterSpace });
    await key(cdp, 'Tab', 'Tab', 9);
    let afterTab = await focusedLabel(cdp);
    // Radix keeps a stale "focus came from a click" flag after the mouse steps above, so the first Tab can land on the group
    // wrapper instead of forwarding to an item. Re-enter once with Shift+Tab, Tab; a real keyboard session never sets the flag.
    const firstTab = afterTab;
    if (!/^Usage range\|(All time|Today)$/.test(afterTab ?? '')) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
      await sleep(300);
      await key(cdp, 'Tab', 'Tab', 9);
      afterTab = await focusedLabel(cdp);
    }
    record('Keyboard: Tab reaches an item of the range group', /^Usage range\|(All time|Today)$/.test(afterTab ?? ''), { firstTab, afterTab });
    await key(cdp, 'ArrowRight', 'ArrowRight', 39);
    await key(cdp, ' ', 'Space', 32);
    const rangeAfter = (await selected(cdp))?.range;
    record('Keyboard: arrow plus Space changes the range to Today', rangeAfter === 'today', rangeAfter);
    record('Keyboard-chosen Conversation/Today shows 2 calls', await settleCalls(cdp, EXPECT['conversation/today'], 'kb conv/today'), await callsShown(cdp));
    await shot('5-keyboard-conversation-today');

    const prefs = await cdp.evaluate(`window.refract.usage.getPrefs().then((r) => r.value)`);
    record('Prefs store sessionScope=conversation and sessionRange=today', prefs?.sessionScope === 'conversation' && prefs?.sessionRange === 'today', prefs);
    const rejects = await cdp.evaluate(`window.refract.usage.setPrefs({ sessionScope: 'bogus' }).then((r) => r.ok)`);
    record('setPrefs rejects an out-of-allowlist sessionScope', rejects === false, { rejects });

    // Restart with the same data dir: both choices persist.
    await stopLauncher(child);
    child = undefined;
    cdp.close?.();
    await launch();
    await sleep(2000);
    await cdp.click(`document.querySelector('[data-repository-id] li [data-session-open]')`);
    await openUsagePanel(cdp);
    const persisted = await selected(cdp);
    record('Choices persist across restart (Conversation, Today)', persisted?.scope === 'conversation' && persisted?.range === 'today', persisted);
    await shot('6-after-restart');
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
    process.exitCode = steps.every((s) => s.pass) ? 0 : 1;
  }
}

main();
