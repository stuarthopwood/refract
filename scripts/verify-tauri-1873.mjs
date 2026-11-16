#!/usr/bin/env node
// Live CDP check of the label overflow chip (#1873), isolated from real app data. Reuses the #504 fake `gh`
// (octocat/hello-world#12 has four labels, so its "+2" chip hides "docs" and "p1"; #20 has one label and no chip).
// Asserts the chip is borderless in rest, hover and focus, uses the accent text colour, is named with its hidden
// labels, and still opens the tooltip on hover and keyboard focus. Aborts if the managed gh.exe exists (#1343).

import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, isTargetOwningPort, assertExeMatchesProcess, createReportLogger, resolveCssVarColor } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, buildAndCopyExeFresh, launchBuiltExe, safeRmSync, makeScratchRepo, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { addRepository } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1873_SHOTS_DIR || path.join(tmpdir(), 'refract-1873-shots');

const MANAGED_GH = path.join(process.env.LOCALAPPDATA || '', 'refract', 'tools', 'gh', 'gh.exe');
if (existsSync(MANAGED_GH)) {
  console.error(`ABORT: ${MANAGED_GH} exists; resolve_gh() would prefer it over the fake gh and could reach real GitHub (#1343).`);
  process.exit(2);
}

const ROW = (n) => `document.querySelector('[data-issue-row][data-issue-number="${n}"]')`;
const CHIP = `${ROW(12)}.parentElement.querySelector('button[aria-label^="+2 more labels"]')`;
const TOOLTIP_TEXT = `Array.from(document.querySelectorAll('[data-slot="tooltip-content"]')).map((el) => el.textContent.trim().replace(/\\s+/g, ' ')).join('|')`;
// "Transparent" computed colours carry alpha 0 whatever the theme is.
const CHIP_STYLE = `(() => { const s = getComputedStyle(${CHIP}); return { top: s.borderTopColor, right: s.borderRightColor, bottom: s.borderBottomColor, left: s.borderLeftColor, color: s.color, background: s.backgroundColor, outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth }; })()`;
const isTransparent = (c) => c === 'transparent' || /^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)$/.test(c) || /\/\s*0\s*\)$/.test(c);
const borderless = (s) => [s.top, s.right, s.bottom, s.left].every(isTransparent);

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const log = createReportLogger(path.join(SHOTS_DIR, 'report.txt'));
  const failures = [];
  const pass = (name, detail) => log(`STEP PASS: ${name}${detail ? ` -- ${detail}` : ''}`);
  const fail = (name, detail) => { failures.push(name); log(`STEP FAIL: ${name}${detail ? ` -- ${detail}` : ''}`); };
  const check = (ok, name, detail) => (ok ? pass(name, detail) : fail(name, detail));
  const shot = async (cdp, name) => { const file = path.join(SHOTS_DIR, name); await cdp.screenshot(file); log(`SCREENSHOT ${file}`); };
  log(`verify-tauri-1873: git HEAD under test: ${gitHead(REPO_ROOT)}`);

  const dirs = [];
  const scratch = (prefix) => { const dir = mkdtempSync(path.join(tmpdir(), prefix)); dirs.push(dir); return dir; };
  let child, cdp;
  try {
    const dataDir = scratch('refract-1873-data-');
    const importDir = scratch('refract-1873-import-');
    const shimDir = scratch('refract-1873-launcher-');
    const exeDir = scratch('refract-1873-exe-');
    const ghDir = scratch('refract-1873-gh-');
    const repoParent = scratch('refract-1873-repo-');

    const ghBuild = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-504-fake-gh.rs'), '-o', path.join(ghDir, 'gh.exe')], { encoding: 'utf8', windowsHide: true });
    if (ghBuild.status !== 0) throw new Error(`fake gh build failed: ${ghBuild.stderr}`);
    process.env.PATH = `${ghDir}${path.delimiter}${process.env.PATH}`;
    process.env.FAKE_GH_LOG = path.join(ghDir, 'gh-calls.log');

    for (const [name, id] of [['hello-world', 'repo1873a'], ['spoon-knife', 'repo1873b']]) {
      const dir = makeScratchRepo(path.join(repoParent, name), id);
      spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://github.com/octocat/${name}.git`], { windowsHide: true });
    }

    const launcherExe = buildLauncher(shimDir);
    const { dest: exePath, hash } = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-tauri-1873' });
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir: importDir, logFile: path.join(SHOTS_DIR, 'app-run.log') });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the process this run launched');
    assertExeMatchesProcess(launched.targetPid, exePath, hash);
    log(`verify-tauri-1873: launched pid ${launched.targetPid}, exe sha256 ${hash}`);

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]:not(:disabled)') || !!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Add repository' && !el.disabled)`, { timeoutMs: 45_000, label: 'app ready' });
    await addRepository(cdp, path.join(repoParent, 'hello-world'));
    await addRepository(cdp, path.join(repoParent, 'spoon-knife'));
    await cdp.waitFor(`!!document.querySelector('[role="group"][aria-label="Views"]')`, { timeoutMs: 20_000, label: 'GitHub nav group' });
    await cdp.click(`Array.from(document.querySelectorAll('[role="group"][aria-label="Views"] button')).find((el) => el.textContent.trim() === 'Issues')`);
    await cdp.waitFor(`!!${ROW(12)} && !!${ROW(20)}`, { timeoutMs: 30_000, label: 'issue rows 12 and 20' });

    // Name and shape.
    const chip = await cdp.evaluate(`(() => { const el = ${CHIP}; return el && { label: el.getAttribute('aria-label'), text: el.textContent.trim(), tabIndex: el.tabIndex, tag: el.tagName }; })()`);
    check(!!chip && chip.tag === 'BUTTON' && chip.text === '+2' && chip.tabIndex === 0, 'Issue #12 shows a focusable "+2" chip', JSON.stringify(chip));
    check(!!chip && chip.label === '+2 more labels: docs, p1', 'The chip is named "+2 more labels: docs, p1" (visible "+2" first, then the hidden labels)', JSON.stringify(chip && chip.label));
    check(await cdp.evaluate(`!${ROW(20)}.parentElement.querySelector('button[aria-label*="more label"]')`), 'Issue #20 (one label) shows no chip');

    // Accent text, no border: rest.
    const accent = await resolveCssVarColor(cdp, '--accent-text', 'color');
    const rest = await cdp.evaluate(CHIP_STYLE);
    check(rest.color === accent, 'Rest: chip text is the accent colour', `${rest.color} vs --accent-text ${accent}`);
    check(borderless(rest), 'Rest: chip has no visible border', JSON.stringify(rest));
    await shot(cdp, '01-chip-rest.png');

    // Hover.
    const centre = await cdp.evaluate(`(() => { const r = ${CHIP}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: centre.x, y: centre.y });
    await cdp.waitFor(`${TOOLTIP_TEXT}.includes('docs') && ${TOOLTIP_TEXT}.includes('p1')`, { timeoutMs: 10_000, label: 'hover tooltip' });
    const hover = await cdp.evaluate(CHIP_STYLE);
    const hoverTooltip = await cdp.evaluate(TOOLTIP_TEXT);
    check(hoverTooltip.includes('docs') && hoverTooltip.includes('p1'), 'Hover: the tooltip lists the hidden labels docs and p1', hoverTooltip);
    check(borderless(hover), 'Hover: chip still has no visible border', JSON.stringify(hover));
    check(hover.color === accent, 'Hover: chip text stays the accent colour', hover.color);
    check(hover.background === rest.background, 'Hover: chip background is unchanged from rest (no hover style beyond the tooltip)', `${rest.background} -> ${hover.background}`);
    await shot(cdp, '02-chip-hover.png');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
    await cdp.waitFor(`${TOOLTIP_TEXT} === ''`, { timeoutMs: 10_000, label: 'hover tooltip closed' });

    // Keyboard focus.
    await cdp.evaluate(`${ROW(12)}.focus()`);
    let reached = false;
    for (let i = 0; i < 4 && !reached; i++) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
      reached = await cdp.evaluate(`document.activeElement === ${CHIP}`);
    }
    check(reached, 'Tab from the row title reaches the chip');
    await cdp.waitFor(`${TOOLTIP_TEXT}.includes('docs') && ${TOOLTIP_TEXT}.includes('p1')`, { timeoutMs: 10_000, label: 'focus tooltip' });
    const focus = await cdp.evaluate(CHIP_STYLE);
    const focusTooltip = await cdp.evaluate(TOOLTIP_TEXT);
    check(focusTooltip.includes('docs') && focusTooltip.includes('p1'), 'Focus: the tooltip lists the hidden labels docs and p1', focusTooltip);
    check(borderless(focus), 'Focus: chip has no visible border', JSON.stringify(focus));
    check(focus.outlineStyle === 'solid' && parseFloat(focus.outlineWidth) >= 2, 'Focus: a solid outline of at least 2px marks the chip instead of a border', `${focus.outlineStyle} ${focus.outlineWidth}`);
    await shot(cdp, '03-chip-focus.png');
  } catch (err) {
    fail('Live check ran to completion', String(err && err.stack ? err.stack : err));
    if (cdp) await shot(cdp, '99-failure.png').catch(() => undefined);
  } finally {
    try { cdp?.close(); } catch { /* already closed */ }
    if (child) await stopLauncher(child).catch(() => undefined);
    for (const dir of dirs) await safeRmSync(dir, 'verify-tauri-1873');
  }
  log(failures.length === 0 ? 'RESULT: ALL STEPS PASS' : `RESULT: FAIL (${failures.join('; ')})`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
