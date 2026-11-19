#!/usr/bin/env node
// Live CDP check for #2070 (Conversation scope counts its subagent and advisor folder; Main agent is the file alone).
// Usage: CARGO_TARGET_DIR=<shared target dir> SHOTS_DIR=<evidence dir> node scripts/verify-tauri-2070.mjs
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget, makeScratchRepo, getAccessibleNameAndRole } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { buildFakeClis } from './verify-1331-fixtures.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-2070';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.SHOTS_DIR || mkdtempSync(path.join(tmpdir(), 'refract-2070-shots-'));
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
const header = (id, ts) => entry({ type: 'session', id, timestamp: new Date(ts).toISOString(), cwd: 'C:\\Work\\verify2070proj' });

// One Session, one Conversation (conv.jsonl) with its sibling folder: 2 main calls, 3 subagent calls, 1 advisor call.
// Expected: Session 6, Conversation 6 (they must agree), Main agent 2 (the old Conversation figure).
const MIN = 60_000;
const EXPECT = { session: 6, conversation: 6, main: 2 };
function writeSessions(root) {
  const now = Date.now();
  const sessionDir = path.join(root, 'x-v2070');
  const convFile = path.join(sessionDir, 'conv.jsonl');
  mkdirSync(path.join(sessionDir, 'conv', 'task'), { recursive: true });
  writeFileSync(convFile, header('c1', now - 30 * MIN) + assistant('c-a', now - 29 * MIN, 0.02) + assistant('c-b', now - 20 * MIN, 0.03));
  writeFileSync(
    path.join(sessionDir, 'conv', 'task', '0-Sub.jsonl'),
    header('s1', now - 25 * MIN) + assistant('s-a', now - 24 * MIN, 0.01) + assistant('s-b', now - 23 * MIN, 0.01) + assistant('s-c', now - 22 * MIN, 0.01)
  );
  writeFileSync(path.join(sessionDir, 'conv', '__advisor1.jsonl'), header('a1', now - 21 * MIN) + assistant('a-a', now - 19 * MIN, 0.04));
  return { sessionDir, convFile };
}

const PANEL = `Array.from(document.querySelectorAll('div.overflow-y-auto')).find((el) => el.querySelector('[aria-label="Usage scope"]'))`;
const selected = (cdp) =>
  cdp.evaluate(`(() => { const p = ${PANEL}; if (!p) return null; const on = (l) => (p.querySelector('[aria-label="' + l + '"]')?.querySelector('[data-state="on"]')?.textContent.trim() ?? '').toLowerCase().replace(' time', '');
    return { scope: on('Usage scope'), range: on('Usage range') }; })()`);
const callsShown = (cdp) => cdp.evaluate(`(() => { const p = ${PANEL}; const m = p && /Model calls\\s*([\\d,]+)/.exec(p.innerText); return m ? Number(m[1].replace(/,/g, '')) : null; })()`);
const panelText = (cdp) => cdp.evaluate(`(${PANEL})?.innerText ?? ''`);
const clickSeg = (cdp, group, text) =>
  cdp.click(`Array.from(${PANEL}.querySelector('[aria-label=${q(group)}]').querySelectorAll('button,[role="radio"]')).find((b) => b.textContent.trim() === ${q(text)})`);
const settleCalls = (cdp, want, label) =>
  cdp.waitFor(`(() => { const p = ${PANEL}; const m = p && /Model calls\\s*([\\d,]+)/.exec(p.innerText); return !!m && Number(m[1].replace(/,/g, '')) === ${want}; })()`, { timeoutMs: 20_000, label }).then(() => true, () => false);
const key = async (cdp, k, code, vk) => {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
  await sleep(300);
};
const focusedLabel = (cdp) => cdp.evaluate(`(() => { const a = document.activeElement; return a ? (a.closest('[aria-label^="Usage "]')?.getAttribute('aria-label') ?? '') + '|' + a.textContent.trim() : null; })()`);
const SCOPE_LINES = {
  session: 'All conversations in this session, with their subagents and advisors.',
  conversation: 'This conversation, with its subagents and advisors.',
  main: "This conversation's main agent only. Excludes subagents and advisors."
};
// The visible scope line and the id the scope group points at with aria-describedby.
const scopeLine = (cdp) =>
  cdp.evaluate(`(() => { const g = ${PANEL}.querySelector('[aria-label="Usage scope"]'); const id = g?.getAttribute('aria-describedby'); const el = id ? document.getElementById(id) : null;
    return { describedBy: id, text: el?.textContent.trim() ?? null, visible: !!el && el.getClientRects().length > 0, muted: !!el && el.classList.contains('text-muted-foreground') }; })()`);
const checkScopeLine = async (cdp, scope) => {
  const line = await scopeLine(cdp);
  record(`Scope line for ${scope} is visible and linked by aria-describedby`, line.visible && line.muted && line.text === SCOPE_LINES[scope], line);
};

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
  const mk = (n) => mkdtempSync(path.join(tmpdir(), `refract-2070-${n}-`));
  const dataDir = mk('data'), sessionsDir = mk('sessions'), importDir = mk('import'), exeDir = mk('exe'), launcherDir = mk('launcher'), shimDir = mk('shim'), agentDir = mk('agent'), repoDir = mk('repo');
  const dirs = [dataDir, sessionsDir, importDir, exeDir, launcherDir, shimDir, agentDir, repoDir];
  let child, cdp;
  const shot = async (name) => { const f = path.join(SHOTS_DIR, `${name}.png`); await cdp.screenshot(f); console.log(`${LOG}: shot ${f}`); };
  try {
    buildFakeClis(shimDir);
    const { sessionDir, convFile } = writeSessions(sessionsDir);
    makeScratchRepo(repoDir, 'v2070');
    const launcherExe = buildLauncher(launcherDir);
    const exeInfo = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
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
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return !!b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 90_000, label: 'readiness green' });
    await addRepository(cdp, repoDir);
    await createSessionViaQuickCreate(cdp, path.basename(repoDir));
    await cdp.waitFor(`window.refract.sessions.list().then((r) => r.ok && r.value.some((s) => s.sessionDir))`, { timeoutMs: 40_000, label: 'session has sessionDir' });

    const hasConv = () => cdp.evaluate(`window.refract.sessions.list().then((r) => r.ok && r.value.some((s) => s.currentConversation))`);
    if (!(await hasConv())) {
      await cdp.typeIntoByLabel('Message', 'hello');
      await cdp.clickByLabel('Send message');
      const approve = await cdp.waitFor(`!!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Approve')`, { timeoutMs: 20_000, label: 'approval' }).then(() => true, () => false);
      if (approve) await cdp.clickByText('Approve');
    }
    record('Session gets a currentConversation', await cdp.waitFor(`window.refract.sessions.list().then((r) => r.ok && r.value.some((s) => s.currentConversation))`, { timeoutMs: 40_000, label: 'currentConversation' }).then(() => true, () => false));
    const target = await cdp.evaluate(`window.refract.sessions.list().then((r) => r.value.find((s) => s.currentConversation))`);
    record('Session sessionDir and currentConversation are the fixture paths', path.resolve(target.sessionDir) === path.resolve(sessionDir) && path.resolve(target.currentConversation) === path.resolve(convFile), { sessionDir: target.sessionDir, currentConversation: target.currentConversation });

    await openUsagePanel(cdp);
    record('Defaults are Session and All time', JSON.stringify(await selected(cdp)) === '{"scope":"session","range":"all"}', await selected(cdp));
    const sessionOk = await settleCalls(cdp, EXPECT.session, 'session/all');
    const sessionText = await panelText(cdp);
    record(`Session/All shows ${EXPECT.session} calls`, sessionOk, await callsShown(cdp));
    await shot('1-session-total');
    await checkScopeLine(cdp, 'session');

    await clickSeg(cdp, 'Usage scope', 'Conversation');
    const convOk = await settleCalls(cdp, EXPECT.conversation, 'conversation/all');
    const convText = await panelText(cdp);
    record(`Conversation/All shows ${EXPECT.conversation} calls (file plus subagent and advisor folder)`, convOk, await callsShown(cdp));
    const spend = (t) => /Spend\s*\n?\s*(\$[\d.,]+)/.exec(t)?.[1] ?? null;
    record('Session total spend equals Conversation total spend', spend(sessionText) !== null && spend(sessionText) === spend(convText), { session: spend(sessionText), conversation: spend(convText) });
    await shot('2-conversation-total');
    await checkScopeLine(cdp, 'conversation');

    await clickSeg(cdp, 'Usage scope', 'Main agent');
    record(`Main agent/All shows ${EXPECT.main} calls (the Conversation file alone)`, await settleCalls(cdp, EXPECT.main, 'main/all'), await callsShown(cdp));
    record('Main agent segment is the selected scope', (await selected(cdp))?.scope === 'main agent', await selected(cdp));
    await checkScopeLine(cdp, 'main');
    await shot('3-main-agent');

    const apiConv = await cdp.evaluate(`window.refract.usage.summary({ range: 'all', sessionDir: ${q(sessionDir)}, sessionFile: ${q(convFile)} }).then((r) => r.value?.calls)`);
    const apiMain = await cdp.evaluate(`window.refract.usage.summary({ range: 'all', sessionDir: ${q(sessionDir)}, sessionFile: ${q(convFile)}, agentType: 'main' }).then((r) => r.value?.calls)`);
    record('usage.summary API agrees: Conversation 6, Main agent 2', apiConv === EXPECT.conversation && apiMain === EXPECT.main, { apiConv, apiMain });

    const mainSeg = `Array.from(${PANEL}.querySelectorAll('[aria-label="Usage scope"] [role="radio"],[aria-label="Usage scope"] button')).find((x) => x.textContent.trim() === 'Main agent')`;
    const ax = await getAccessibleNameAndRole(cdp, mainSeg);
    record('Main agent has the accessible name "Main agent" and a radio role', ax.name === 'Main agent' && ax.role === 'radio', ax);
    const attrs = await cdp.evaluate(`(() => { const b = ${mainSeg}; return b ? { role: b.getAttribute('role'), checked: b.getAttribute('aria-checked'), pressed: b.getAttribute('aria-pressed'), title: b.getAttribute('title'), disabled: b.disabled } : null; })()`);
    record('Main agent segment is enabled and carries no title hint (the visible line replaces it)', attrs && !attrs.disabled && attrs.title === null, attrs);

    // Keyboard: focus Session, ArrowRight twice reaches Main agent, Space selects it; Tab leaves the scope group.
    await clickSeg(cdp, 'Usage scope', 'Session');
    await cdp.evaluate(`(() => { const g = ${PANEL}.querySelector('[aria-label="Usage scope"]'); Array.from(g.querySelectorAll('button,[role="radio"]')).find((b) => b.textContent.trim() === 'Session').focus(); })()`);
    await key(cdp, 'ArrowRight', 'ArrowRight', 39);
    const afterOne = await focusedLabel(cdp);
    await key(cdp, 'ArrowRight', 'ArrowRight', 39);
    const afterTwo = await focusedLabel(cdp);
    await key(cdp, ' ', 'Space', 32);
    const scopeAfterSpace = (await selected(cdp))?.scope;
    record('Keyboard: ArrowRight twice reaches Main agent and Space selects it', afterOne === 'Usage scope|Conversation' && afterTwo === 'Usage scope|Main agent' && scopeAfterSpace === 'main agent', { afterOne, afterTwo, scopeAfterSpace });
    record('Keyboard-chosen Main agent shows 2 calls', await settleCalls(cdp, EXPECT.main, 'kb main'), await callsShown(cdp));
    await key(cdp, 'Tab', 'Tab', 9);
    let afterTab = await focusedLabel(cdp);
    const firstTab = afterTab;
    if (!/^Usage range\|(All time|Today)$/.test(afterTab ?? '')) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
      await sleep(300);
      await key(cdp, 'Tab', 'Tab', 9);
      afterTab = await focusedLabel(cdp);
    }
    record('Keyboard: Tab leaves the scope group for the range group', /^Usage range\|(All time|Today)$/.test(afterTab ?? ''), { firstTab, afterTab });
    await shot('4-keyboard-main-agent');

    const prefs = await cdp.evaluate(`window.refract.usage.getPrefs().then((r) => r.value)`);
    record('Prefs store sessionScope=main', prefs?.sessionScope === 'main', prefs);
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
