#!/usr/bin/env node
// Live CDP check: Close chat pane shows `MessageSquareX` (#680); "New conversation" is a ghost
// button with hover tint and focus-visible ring (#686). Does NOT build; run with
//   REFRACT_680_686_EXE=<copied exe> REFRACT_680_686_SHA256=<its sha256> CARGO_TARGET_DIR=<shared> \
//   node scripts/verify-680-686-chat-header.mjs
// Exit code is 1 on any failed check or when nothing ran.

import { mkdtempSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  computeDirty,
  buildLauncher,
  makeScratchRepo,
  citeScreenshots,
  safeRmSync,
  assertExeUnchanged,
  sha256OfFile,
  switchTheme,
  clearKnownOutputFiles
} from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, worktreesDirFor } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { createSessionViaQuickCreate, getAccessibleName, pressKey } from './verify-tauri-session-list-helpers.mjs';
import { settleForScreenshot } from './verify-700-todo-pin-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-680-686';
const SHOTS_DIR = path.join(tmpdir(), 'refract-680-686-shots');
const TRANSPARENT = 'rgba(0, 0, 0, 0)';
const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' }
];
const CLOSE_BUTTONS = `Array.from(document.querySelectorAll('button')).filter((b) => /^Close .+ chat pane$/.test(b.getAttribute('aria-label') ?? ''))`;
const NEW_CONVERSATION_BUTTONS = `Array.from(document.querySelectorAll('button')).filter((b) => b.textContent.trim() === 'New conversation')`;

const results = { passed: 0, failed: 0, checks: [] };
function check(name, ok, detail = '') {
  const pass = ok === true;
  results[pass ? 'passed' : 'failed']++;
  results.checks.push({ name, pass, detail });
  console.log(`${LOG}: ${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
}

// `raw` skips `settleForScreenshot`, which moves the pointer away and blurs focus: fatal for the
// hover and focus captures, whose whole point is that state.
async function shot(cdp, name, shotNames, raw = false) {
  if (!raw) await settleForScreenshot(cdp);
  shotNames.push(name);
  await cdp.screenshot(path.join(SHOTS_DIR, name));
}

async function checkCloseButtons(cdp, label, expectedCount) {
  const info = await cdp.evaluate(`(() => ${CLOSE_BUTTONS}.map((b, i) => ({
    index: i,
    label: b.getAttribute('aria-label'),
    headerName: b.closest('header')?.querySelector('span.font-medium')?.textContent ?? null,
    hasMessageSquareX: !!b.querySelector('svg.lucide-message-square-x'),
    hasPanelRightClose: !!b.querySelector('svg.lucide-panel-right-close'),
    iconSize: b.querySelector('svg')?.getBoundingClientRect().width ?? null
  })))()`);
  check(`${label}: ${expectedCount} close button(s) rendered`, info.length === expectedCount, `found ${info.length}`);
  for (const b of info) {
    check(`${label}: close button #${b.index} uses lucide message-square-x`, b.hasMessageSquareX);
    check(`${label}: close button #${b.index} has no panel-right-close svg`, !b.hasPanelRightClose);
    check(`${label}: close button #${b.index} icon is 16px`, b.iconSize === 16, `width ${b.iconSize}`);
    const ax = await getAccessibleName(cdp, `${CLOSE_BUTTONS}[${b.index}]`);
    check(
      `${label}: close button #${b.index} AX name is "Close <name> chat pane"`,
      !!b.headerName && ax === `Close ${b.headerName} chat pane`,
      `AX ${JSON.stringify(ax)}, header ${JSON.stringify(b.headerName)}`
    );
  }
}

async function offPointer(cdp) {
  const { width } = await cdp.evaluate(`({ width: window.innerWidth })`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: width - 20, y: 450 });
  await sleep(300);
}

async function readButton(cdp, index) {
  return cdp.evaluate(`(() => {
    const b = ${NEW_CONVERSATION_BUTTONS}[${index}];
    if (!b) return null;
    const s = getComputedStyle(b);
    return {
      bg: s.backgroundColor,
      borderColor: s.borderTopColor,
      borderWidth: s.borderTopWidth,
      boxShadow: s.boxShadow,
      hovered: b.matches(':hover'),
      focusVisible: b.matches(':focus-visible'),
      active: document.activeElement === b,
      hasPlusIcon: !!b.querySelector('svg.lucide-plus'),
      className: b.className
    };
  })()`);
}

async function checkNewConversation(cdp, label, index, shotPrefix, shotNames) {
  await offPointer(cdp);
  const rest = await readButton(cdp, index);
  check(`${label}: New conversation button #${index} exists`, !!rest);
  if (!rest) return;
  check(`${label}: #${index} not hovered at rest`, rest.hovered === false);
  check(`${label}: #${index} has no fill at rest`, rest.bg === TRANSPARENT, rest.bg);
  check(`${label}: #${index} has no visible border at rest`, rest.borderColor === TRANSPARENT, `${rest.borderWidth} ${rest.borderColor}`);
  check(`${label}: #${index} keeps its plus icon`, rest.hasPlusIcon);
  if (shotPrefix) await shot(cdp, `${shotPrefix}-rest.png`, shotNames);

  const pos = await cdp.evaluate(`(() => { const r = ${NEW_CONVERSATION_BUTTONS}[${index}].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
  await cdp
    .waitFor(`(() => { const b = ${NEW_CONVERSATION_BUTTONS}[${index}]; return !!b && b.matches(':hover') && b.getAnimations().length === 0; })()`, { timeoutMs: 5_000, label: 'hover settled' })
    .catch(() => {});
  const hover = await readButton(cdp, index);
  check(`${label}: #${index} shows a hover tint`, hover?.hovered === true && hover.bg !== TRANSPARENT && hover.bg !== rest.bg, `${rest.bg} -> ${hover?.bg}`);
  if (shotPrefix) await shot(cdp, `${shotPrefix}-hover.png`, shotNames, true);
  await offPointer(cdp);

  // Keyboard Tab from the document start until the button holds focus.
  await cdp.evaluate(`(() => { document.activeElement?.blur(); document.body.focus(); })()`);
  let reached = false;
  for (let i = 0; i < 80 && !reached; i++) {
    await pressKey(cdp, 9, 'Tab', 'Tab');
    await sleep(40);
    reached = await cdp.evaluate(`document.activeElement === ${NEW_CONVERSATION_BUTTONS}[${index}]`);
  }
  check(`${label}: #${index} reachable by keyboard Tab`, reached);
  if (!reached) return;
  await cdp
    .waitFor(`(() => { const b = ${NEW_CONVERSATION_BUTTONS}[${index}]; return !!b && b.getAnimations().length === 0; })()`, { timeoutMs: 5_000, label: 'focus settled' })
    .catch(() => {});
  const focus = await readButton(cdp, index);
  check(`${label}: #${index} matches :focus-visible after Tab`, focus.focusVisible === true);
  check(`${label}: #${index} shows a focus ring (box-shadow)`, focus.boxShadow !== 'none' && focus.boxShadow !== '', focus.boxShadow);
  if (shotPrefix) await shot(cdp, `${shotPrefix}-focus.png`, shotNames, true);
  await cdp.evaluate(`document.activeElement?.blur()`);
}

async function runPhase(cdp, phase, paneCount, shotNames) {
  for (const theme of THEMES) {
    await switchTheme(cdp, theme.id, theme.name);
    await sleep(250);
    const label = `${phase}/${theme.name}`;
    await checkCloseButtons(cdp, label, paneCount);
    const count = await cdp.evaluate(`${NEW_CONVERSATION_BUTTONS}.length`);
    check(`${label}: ${paneCount} New conversation button(s) rendered`, count === paneCount, `found ${count}`);
    for (let i = 0; i < count; i++) {
      await checkNewConversation(cdp, label, i, i === 0 ? `${theme.id}-${phase}` : null, shotNames);
    }
    await offPointer(cdp);
    await shot(cdp, `${theme.id}-${phase}-header.png`, shotNames);
  }
}

async function main() {
  const exePath = process.env.REFRACT_680_686_EXE;
  const expectedHash = (process.env.REFRACT_680_686_SHA256 ?? '').toLowerCase();
  if (!exePath || !path.isAbsolute(exePath) || !/^[0-9a-f]{64}$/.test(expectedHash)) {
    throw new Error(`${LOG}: set REFRACT_680_686_EXE (absolute path of the copied exe) and REFRACT_680_686_SHA256 (its sha256)`);
  }
  const actual = sha256OfFile(exePath).toLowerCase();
  check('launched exe sha256 equals the recorded build hash', actual === expectedHash, actual);
  if (actual !== expectedHash) throw new Error(`${LOG}: exe hash mismatch`);

  const shotNames = [];
  const head = gitHead(REPO_ROOT);
  console.log(`${LOG}: git HEAD ${head}${computeDirty(REPO_ROOT) === true ? ' (DIRTY)' : ''}`);
  const themed = ['rest', 'hover', 'focus', 'header'];
  clearKnownOutputFiles(SHOTS_DIR, 'refract-680-686', [
    ...THEMES.flatMap((t) => [
      ...['single', 'split'].flatMap((p) => themed.map((k) => `${t.id}-${p}-${k}.png`))
    ]),
    'report.json',
    'app.log'
  ]);

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-680-686-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-680-686-import-'));
  const repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-680-686-repo-')), 'verify-680-686');
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-680-686-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-680-686-shim-'));
  const repoName = path.basename(repoDir);
  let child;
  let cdp;
  try {
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exePath, {
      port,
      dataDir,
      pathPrepend: shimDir,
      logFile: path.join(SHOTS_DIR, 'app.log'),
      extraEnv: {
        REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'session'
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    check('CDP target is owned by the launched process', isTargetOwningPort(port, launched.targetPid) === true);
    assertExeUnchanged(exePath, expectedHash, 'post-launch', LOG);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });

    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, {
      timeoutMs: 60_000,
      label: 'Readiness green (fake omp)'
    });
    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add repository', { inDialog: true });
    await cdp.waitFor(
      `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
      { timeoutMs: 30_000, label: 'Scratch repository added' }
    );
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
      { timeoutMs: 15_000, label: 'Create session enabled' }
    );
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 60_000,
      label: 'Session composer enabled'
    });

    await runPhase(cdp, 'single', 1, shotNames);

    await createSessionViaQuickCreate(cdp, repoName);
    const otherRow = `Array.from(document.querySelectorAll('button[data-session-open]')).find((b) => b.getAttribute('aria-current') !== 'true')`;
    await cdp.waitFor(`!!(${otherRow})`, { timeoutMs: 15_000, label: 'A second, non-visible Session row exists' });
    const rect = await cdp.evaluate(`(() => { const r = (${otherRow}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    const ctrl = { button: 'left', clickCount: 1, modifiers: 2 };
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, ...ctrl });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, ...ctrl });
    await cdp.waitFor(`${CLOSE_BUTTONS}.length === 2`, { timeoutMs: 15_000, label: 'Split opened: two close buttons' });

    await runPhase(cdp, 'split', 2, shotNames);
  } catch (err) {
    check('driver ran to completion', false, err?.stack ?? String(err));
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    await safeRmSync(dataDir);
    await safeRmSync(importSourceDir);
    await safeRmSync(worktreesDirFor(repoDir));
    await safeRmSync(repoDir);
    await safeRmSync(launcherDir);
    await safeRmSync(shimDir);
  }

  let cited = [];
  try {
    cited = citeScreenshots(SHOTS_DIR, shotNames);
  } catch (err) {
    check('screenshots readable for citation', false, String(err));
  }
  const total = results.passed + results.failed;
  const report = { head, exeSha256: expectedHash, passed: results.passed, failed: results.failed, total, screenshots: cited, checks: results.checks };
  writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`${LOG}: ${results.passed}/${total} checks passed, ${results.failed} failed; ${cited.length} screenshots in ${SHOTS_DIR}`);
  for (const s of cited) console.log(`${LOG}: shot ${s.name} ${s.sha256}`);
  if (total === 0 || results.failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`${LOG}: unhandled error:`, err?.stack ?? err);
  process.exitCode = 1;
});
