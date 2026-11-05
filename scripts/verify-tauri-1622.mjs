#!/usr/bin/env node
// Live CDP check for #1622: the Subagents card draws a rail from the header icon, an elbow into each Stage, and a nested
// elbowed rail for a Stage's agents (one or many), with one icon column per level and every row centred on its icon.
// Fixture: scripts/fixtures/omp-frames/stages-1622.jsonl (a one-agent Stage, then a three-agent Stage with a long name).

import { mkdtempSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget, switchTheme } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';
import { latestSessionIdAndName } from './verify-tauri-560-helpers.mjs';
import { settleForScreenshot } from './verify-700-todo-pin-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR = process.env.REFRACT_1622_SHOTS_DIR || path.join(tmpdir(), `refract-1622-shots-${Date.now()}`);
const CDP_PORT = 9261;
const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'light', name: 'Light' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' },
  { id: 'light-high-contrast', name: 'Light (high contrast)' }
];
const CHAIN_TRIGGER = `Array.from(document.querySelectorAll('[data-slot="collapsible-trigger"]')).find((b) => (b.getAttribute('aria-label') || '').startsWith('Subagents, '))`;

// Measures the card's geometry: icon centres per level, rail x, elbows, and each row's text/duration centre vs its icon.
const MEASURE = `(() => {
  const trigger = ${CHAIN_TRIGGER};
  const content = trigger.closest('[data-slot="collapsible"]').querySelector('[data-slot="collapsible-content"]');
  const centre = (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, r: r.right, h: r.height }; };
  const headerIcon = Array.from(trigger.querySelectorAll('span')).find((s) => s.classList.contains('h-5') && s.classList.contains('w-4'));
  const outer = content.querySelector('ol');
  const railX = (ol) => ol.getBoundingClientRect().x + 0.5;
  const row = (el) => {
    const icon = Array.from(el.children).find((c) => c.classList.contains('h-5') && c.classList.contains('w-4')) ?? el.querySelector('span.h-5.w-4');
    const iconC = centre(icon);
    const kids = Array.from(el.children).filter((c) => c !== icon);
    const title = kids[0];
    const last = kids[kids.length - 1];
    const dur = last && last !== title && /\\d/.test(last.textContent) && /^\\d/.test(last.textContent.trim()) ? last : null;
    return {
      iconX: iconC.x, iconY: iconC.y, rowH: el.getBoundingClientRect().height, rowRight: el.getBoundingClientRect().right,
      titleDy: title ? Math.abs(centre(title).y - iconC.y) : null,
      titleOverflow: title ? title.scrollWidth > title.clientWidth : false,
      titleText: title ? title.textContent.trim() : '',
      durDy: dur ? Math.abs(centre(dur).y - iconC.y) : null,
      durRight: dur ? centre(dur).r : null,
      durText: dur ? dur.textContent.trim() : null
    };
  };
  const stages = Array.from(outer.children).map((li) => {
    const group = li.querySelector('[role="group"]');
    const agentOl = group.querySelector(':scope > ol');
    const stageRow = row(group.firstElementChild);
    return {
      hasElbow: !!li.querySelector(':scope > span[aria-hidden="true"] > span.border-t'),
      stage: stageRow,
      agentRailX: railX(agentOl),
      agents: Array.from(agentOl.children).map((ali) => ({
        hasElbow: !!ali.querySelector(':scope > span[aria-hidden="true"] > span.border-t'),
        tag: ali.querySelector('button') ? 'button' : 'span',
        ...row(ali.querySelector('button') ?? ali.querySelector(':scope > span:not([aria-hidden])'))
      })),
      groupBelow: group.firstElementChild.getBoundingClientRect().bottom <= agentOl.getBoundingClientRect().top + 1
    };
  });
  const elbowColor = getComputedStyle(outer.querySelector('li > span > span.border-t')).borderTopColor;
  return { headerIconX: headerIcon ? centre(headerIcon).x : null, outerRailX: railX(outer), isOl: outer.tagName === 'OL', stages, elbowColor };
})()`;

function assertGeometry(m, themeId, findings, failures) {
  const tag = `${themeId}:`;
  const near = (a, b, tol = 1) => a != null && b != null && Math.abs(a - b) <= tol;
  if (!m.isOl) failures.push(`${tag} the Stage list is not an <ol>`);
  if (m.stages.length !== 2) failures.push(`${tag} expected 2 Stages, saw ${m.stages.length}`);
  if (!near(m.outerRailX, m.headerIconX)) failures.push(`${tag} rail x ${m.outerRailX} is not under the header icon centre ${m.headerIconX}`);
  const stageIconXs = m.stages.map((s) => s.stage.iconX);
  if (new Set(stageIconXs.map((x) => Math.round(x))).size !== 1) failures.push(`${tag} Stage icons are not one column: ${stageIconXs}`);
  const agentIconXs = m.stages.flatMap((s) => s.agents.map((a) => a.iconX));
  if (new Set(agentIconXs.map((x) => Math.round(x))).size !== 1) failures.push(`${tag} agent icons are not one column: ${agentIconXs}`);
  if (agentIconXs[0] != null && stageIconXs[0] != null && agentIconXs[0] <= stageIconXs[0]) failures.push(`${tag} agent column is not nested right of the Stage column`);
  const counts = m.stages.map((s) => s.agents.length);
  if (counts.join() !== '1,3') failures.push(`${tag} agent counts per Stage ${counts} (want 1,3: agents always listed, even for one)`);
  for (const [i, s] of m.stages.entries()) {
    if (!s.hasElbow) failures.push(`${tag} Stage ${i + 1} has no elbow`);
    if (!s.groupBelow) failures.push(`${tag} Stage ${i + 1} agents are not below the Stage row`);
    if (!near(s.agentRailX, s.stage.iconX)) failures.push(`${tag} Stage ${i + 1} agent rail x ${s.agentRailX} is not under the Stage icon ${s.stage.iconX}`);
    if (s.stage.titleDy > 1) failures.push(`${tag} Stage ${i + 1} title is ${s.stage.titleDy}px off the icon centre line`);
    if (s.stage.durDy != null && s.stage.durDy > 1) failures.push(`${tag} Stage ${i + 1} duration is ${s.stage.durDy}px off the icon centre line`);
    if (s.stage.rowH > 22) failures.push(`${tag} Stage ${i + 1} row wrapped (height ${s.stage.rowH})`);
    for (const [j, a] of s.agents.entries()) {
      const label = `Stage ${i + 1} agent ${j + 1}`;
      if (!a.hasElbow) failures.push(`${tag} ${label} has no elbow`);
      if (a.titleDy > 1) failures.push(`${tag} ${label} title is ${a.titleDy}px off the icon centre line`);
      if (a.durDy != null && a.durDy > 1) failures.push(`${tag} ${label} duration is ${a.durDy}px off the icon centre line`);
      if (a.rowH > 22) failures.push(`${tag} ${label} row wrapped (height ${a.rowH})`);
      if (a.tag !== 'button') failures.push(`${tag} ${label} is not a clickable button`);
    }
  }
  // The long-name truncation check runs in a narrow viewport pass below; at the default width the name simply fits.
  findings.push(`${tag} ${JSON.stringify({ headerIconX: m.headerIconX, outerRailX: m.outerRailX, stageIconX: stageIconXs, agentIconX: agentIconXs[0], elbowColor: m.elbowColor, counts, stageDurations: m.stages.map((s) => s.stage.durText) })}`);
}

async function main() {
  const findings = [];
  const failures = [];
  const dirs = {};
  let child, cdp, gitHeadSha = null;
  try {
    mkdirSync(SHOTS_DIR, { recursive: true });
    const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
    gitHeadSha = gitHead(REPO_ROOT);
    for (const n of ['shim', 'data', 'import', 'exe', 'launcher']) dirs[n] = mkdtempSync(path.join(tmpdir(), `refract-1622-${n}-`));
    dirs.repo = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-1622-repo-')), 'verify-1622');
    buildOmpShim(dirs.shim);
    const launcherExe = buildLauncher(dirs.launcher);
    const built = buildAndCopyExeFresh(dirs.exe, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-1622' });
    const launched = await launchBuiltExeWithEnv(launcherExe, built.dest, {
      port: CDP_PORT,
      dataDir: dirs.data,
      importSourceDir: dirs.import,
      pathPrepend: dirs.shim,
      logFile: path.join(dirs.exe, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'stages-1622'
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(CDP_PORT, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(CDP_PORT, launched.targetPid)) throw new Error('CDP target is not owned by the launched process');
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 90_000, label: 'Readiness green' });
    const repoName = path.basename(dirs.repo);
    await addRepository(cdp, dirs.repo);
    await createSessionViaQuickCreate(cdp, repoName);
    await latestSessionIdAndName(cdp, repoName, []);
    await cdp.typeIntoByLabel('Message', 'Run the one-agent then three-agent chain (issue #1622 live check).');
    await cdp.clickByLabel('Send message');

    await cdp.waitFor(`!!(${CHAIN_TRIGGER})`, { timeoutMs: 30_000, label: 'Subagents chain row mounted' });
    await cdp.waitFor(`!!(${CHAIN_TRIGGER})?.innerText.includes('Failed') || !!(${CHAIN_TRIGGER})?.innerText.includes('Finished')`, { timeoutMs: 30_000, label: 'chain settled' });
    if ((await cdp.evaluate(`${CHAIN_TRIGGER}.getAttribute('aria-expanded')`)) !== 'true') await cdp.click(CHAIN_TRIGGER);
    await cdp.waitFor(`document.querySelectorAll('[data-slot="collapsible"] [role="group"]').length >= 2`, { timeoutMs: 15_000, label: 'both Stage groups visible' });
    await cdp.waitFor(`document.body.innerText.includes('BetaThree')`, { timeoutMs: 15_000, label: 'three-agent Stage agents rendered' });

    for (const theme of THEMES) {
      if (theme.id !== 'dark') await switchTheme(cdp, theme.id, theme.name);
      await cdp.evaluate(`${CHAIN_TRIGGER}.scrollIntoView({ block: 'center' })`);
      assertGeometry(await cdp.evaluate(MEASURE), theme.id, findings, failures);
      await settleForScreenshot(cdp);
      await cdp.screenshot(path.join(SHOTS_DIR, `1622-chain-${theme.id}.png`));
      if (theme.id === 'dark-high-contrast') {
        // Rails and elbows are CSS borders, so forced-colors must keep them (CanvasText), not drop them like a background.
        await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
        await new Promise((r) => setTimeout(r, 400));
        const forced = await cdp.evaluate(`(() => { const el = ${CHAIN_TRIGGER}.closest('[data-slot="collapsible"]').querySelector('[data-slot="collapsible-content"] ol'); const cs = getComputedStyle(el); const e = getComputedStyle(el.querySelector('li > span > span.border-t')); return { rail: cs.borderLeftColor + ' ' + cs.borderLeftWidth, elbow: e.borderTopColor + ' ' + e.borderTopWidth }; })()`);
        findings.push(`forced-colors: ${JSON.stringify(forced)}`);
        if (/ 0px$/.test(forced.rail) || / 0px$/.test(forced.elbow)) failures.push(`forced-colors dropped the rail or elbow: ${JSON.stringify(forced)}`);
        await cdp.screenshot(path.join(SHOTS_DIR, '1622-chain-forced-colors.png'));
        await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'none' }] });
      }
    }
    // Narrow viewport: the long agent name must truncate and every row must stay one line (no wrapping).
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 640, height: 800, deviceScaleFactor: 1, mobile: false });
    await new Promise((r) => setTimeout(r, 500));
    await cdp.evaluate(`${CHAIN_TRIGGER}.scrollIntoView({ block: 'center' })`);
    const narrow = await cdp.evaluate(MEASURE);
    const narrowAgents = narrow.stages.flatMap((s) => s.agents);
    const longAgent = narrow.stages[1]?.agents[1];
    if (!longAgent?.titleOverflow) failures.push('narrow: the long agent name did not truncate');
    if (narrowAgents.some((a) => a.rowH > 22) || narrow.stages.some((s) => s.stage.rowH > 22)) failures.push('narrow: a row wrapped');
    findings.push(`narrow: ${JSON.stringify({ longTitleOverflow: longAgent?.titleOverflow, rowHeights: narrowAgents.map((a) => a.rowH), longDurRight: longAgent?.durRight, rowRight: longAgent?.rowRight })}`);
    await settleForScreenshot(cdp);
    await cdp.screenshot(path.join(SHOTS_DIR, '1622-chain-narrow.png'));
    await cdp.send('Emulation.clearDeviceMetricsOverride', {});
    // The three-agent Stage's own agent still opens the Subagents panel (button behaviour unchanged, #1001).
    const clickable = await cdp.evaluate(`document.body.innerText.includes('BetaOne') && !!Array.from(document.querySelectorAll('[role="group"] button')).find((b) => b.innerText.includes('BetaOne'))`);
    findings.push(`BetaOne is a button: ${clickable}`);
    if (!clickable) failures.push('BetaOne agent row is not a clickable button');

    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, findings, failures, exitCode: failures.length ? 1 : 0 }, null, 2));
    console.log(JSON.stringify({ shots: SHOTS_DIR, findings, failures }, null, 2));
    process.exitCode = failures.length ? 1 : 0;
  } catch (err) {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, findings, failures, error: String(err?.stack ?? err), exitCode: 1 }, null, 2));
    } catch {}
    console.error('verify-1622: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    try {
      if (dirs.exe && existsSync(path.join(dirs.exe, 'app.log'))) copyFileSync(path.join(dirs.exe, 'app.log'), path.join(SHOTS_DIR, 'app.log'));
    } catch {}
    for (const d of Object.values(dirs)) await safeRmSync(d);
  }
}

main();
