#!/usr/bin/env node
// Live CDP check for the Personal Agent launcher row (#2006): placeholder order and first Tab stop, lazy
// creation by keyboard Enter, search immunity, the protected row menus, the project group staying clean,
// the row surviving a restart, and light/dark screenshots.
// Usage: CARGO_TARGET_DIR=<shared target dir> node scripts/verify-tauri-2006.mjs
// Env: REFRACT_2006_SHOTS_DIR overrides the evidence directory; REFRACT_2006_SCRATCH_DIR the scratch root.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { getFreePort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget, gitHead, computeDirty, buildAndCopyExeFresh } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe, buildOmpShim, connectCdp, worktreesDirFor, pressRealEnter } from './verify-tauri-560-helpers.mjs';
import { pressTab, pressEscape, pressKey, hoverRow, rightClick, SEARCH_INPUT_FINDER, FILTER_TOGGLE_FINDER } from './verify-tauri-session-list-helpers.mjs';

/** A tooltip can take the first Escape, so press until the menu is gone. */
async function closeMenu(cdp) {
  for (let i = 0; i < 3; i += 1) {
    await pressEscape(cdp);
    await sleep(300);
    if (!(await cdp.evaluate(`!!document.querySelector('[role="menu"]')`))) return;
  }
  throw new Error('menu did not close');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-2006';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SCRATCH_ROOT = process.env.REFRACT_2006_SCRATCH_DIR || 'C:/Users/shopwood/AppData/Local/Temp/scratch/lane-2006/work';
const SHOTS_DIR = process.env.REFRACT_2006_SHOTS_DIR || 'C:/Users/shopwood/AppData/Local/Temp/scratch/lane-2006/evidence';

const report = [];
function check(ok, label, evidence) {
  report.push({ step: label, ok: ok === true, evidence });
  console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label} ${evidence === undefined ? '' : JSON.stringify(evidence)}`);
  if (ok !== true) process.exitCode = 1;
}

const norm = (p) => path.resolve(p).toLowerCase();
const invocations = (file) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => / argv=\[/.test(l) && l.includes('rpc-ui') && !l.includes('"--no-session"'))
        .map((l) => ({ argv: JSON.parse(l.match(/argv=(\[.*\]) cwd=/)[1]), cwd: l.slice(l.indexOf(' cwd=') + 5) }))
    : [];
const scratch = (label) => mkdtempSync(path.join(SCRATCH_ROOT, `refract-2006-${label}-`));
const shot = (cdp, name) => cdp.screenshot(path.join(SHOTS_DIR, name));
const registryOf = (dataDir) => JSON.parse(readFileSync(path.join(dataDir, 'registry.json'), 'utf8'));

const PERSONAL_UL = `document.querySelector('ul[aria-label="Personal Agent"]')`;
const PERSONAL_OPEN = `${PERSONAL_UL}?.querySelector('[data-session-open]')`;
const PLACEHOLDER = `Array.from(${PERSONAL_UL}?.querySelectorAll('button') ?? []).find((b) => !b.hasAttribute('data-session-open') && b.textContent.trim() === 'My Agent')`;

/** Reads every item of the open menu with its disabled state and the reason a screen reader would hear. */
function readMenu(cdp) {
  return cdp.evaluate(`(() => {
    const menu = document.querySelector('[role="menu"]');
    if (!menu) return null;
    return Array.from(menu.querySelectorAll('[role="menuitem"]')).map((el) => {
      const describedBy = el.getAttribute('aria-describedby');
      return {
        label: el.textContent.trim().replace(/\\s+/g, ' '),
        ariaDisabled: el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled'),
        reason: describedBy ? document.getElementById(describedBy)?.textContent.trim() ?? null : null
      };
    });
  })()`);
}

async function startApp({ launcherExe, exePath, shimDir, importSourceDir, dataDir, debugLog, tag }) {
  const port = await getFreePort();
  const launched = await launchBuiltExe(launcherExe, exePath, {
    port,
    dataDir,
    importSourceDir,
    pathPrepend: shimDir,
    logFile: path.join(SHOTS_DIR, `app-${tag}.log`),
    extraEnv: {
      REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
      REFRACT_FAKE_OMP_NODE: process.execPath,
      REFRACT_FAKE_OMP_DEBUG_LOG: debugLog
    }
  });
  const cdp = await connectCdp(port, launched.targetPid);
  await cdp.waitFor(`!!window.refract?.sessions`, { timeoutMs: 60_000, label: 'bridge ready' });
  await sleep(3_000);
  return { child: launched.child, cdp };
}

async function guarded(label, fn) {
  try {
    await fn();
  } catch (err) {
    check(false, `${label} crashed`, String(err && err.message ? err.message : err));
  }
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const [dataDir, importSourceDir, repoDirBase, exeDir, launcherDir, shimDir] = ['data', 'import', 'repo', 'exe', 'launcher', 'shim'].map(scratch);
  const repoDir = makeScratchRepo(repoDirBase, 'verify-2006');
  const projectName = path.basename(repoDir);
  const dirs = [dataDir, importSourceDir, repoDirBase, worktreesDirFor(repoDir), exeDir, launcherDir, shimDir];
  const debugLog = path.join(exeDir, 'fake-omp-invocations.log');
  const home = os.homedir();
  let app;
  try {
    const launcherExe = buildLauncher(launcherDir);
    buildOmpShim(shimDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    const dirty = computeDirty(REPO_ROOT);
    check(dirty === false, 'build identity: built from a clean committed head', { head: gitHead(REPO_ROOT), dirty, exeSha256: built.hash, builtDuringThisRun: built.builtDuringThisRun });
    const launchArgs = { launcherExe, exePath: built.dest, shimDir, importSourceDir, dataDir, debugLog };

    app = await startApp({ ...launchArgs, tag: '1' });
    let { cdp } = app;
    const added = await cdp.evaluate(`window.refract.repositories.add(${JSON.stringify(repoDir)}).then((r) => r)`);
    const created = added.ok ? await cdp.evaluate(`window.refract.sessions.create({ repositoryId: ${JSON.stringify(added.value.id)}, baseBranch: 'main' }).then((r) => r)`) : added;
    check(added.ok && created.ok, 'setup: scratch Project with one Session', { project: projectName, error: added.error ?? created.error });
    const projectSessionName = created.value?.name;
    await cdp.send('Page.reload');
    await cdp.waitFor(`!!window.refract?.sessions && !!document.querySelector('[data-repository-id]')`, { timeoutMs: 60_000, label: 'list reloaded with the Project' });
    await sleep(1_500);

    const groupText = () => cdp.evaluate(`document.querySelector('[data-repository-id]')?.querySelector('[aria-expanded]')?.getAttribute('aria-label') ?? document.querySelector('[data-repository-id]')?.textContent.slice(0, 120)`);
    const groupBefore = await groupText();

    // a. order and first Tab stop
    await guarded('a', async () => {
      const layout = await cdp.evaluate(`(() => {
        const ul = ${PERSONAL_UL};
        const sep = Array.from(document.querySelectorAll('[data-slot="separator"]')).find((el) => ul && (ul.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
        const h2 = Array.from(document.querySelectorAll('h2')).find((el) => el.textContent.trim() === 'Projects');
        const group = document.querySelector('[data-repository-id]');
        const before = (a, b) => !!a && !!b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
        const toolbar = document.querySelector('[data-session-filter-toggle]');
        return { placeholder: !!(${PLACEHOLDER}), separator: !!sep, h2: !!h2, order: before(ul, sep) && before(sep, h2) && before(h2, toolbar) && before(toolbar, group) };
      })()`);
      // Focus the last tab stop before the Personal Agent so one Tab shows the first stop in the list region.
      await cdp.evaluate(`(() => { const nav = document.querySelector('nav[aria-label="Sessions"]'); const first = Array.from(nav.querySelectorAll('button, a, [tabindex="0"]')).filter((el) => !el.closest('ul[aria-label="Personal Agent"]') && (el.compareDocumentPosition(document.querySelector('ul[aria-label="Personal Agent"]')) & Node.DOCUMENT_POSITION_FOLLOWING)); first[first.length - 1].focus(); })()`);
      await pressTab(cdp);
      const focused = await cdp.evaluate(`(() => { const a = document.activeElement; return { text: a?.textContent.trim(), inPersonal: !!a?.closest('ul[aria-label="Personal Agent"]'), tag: a?.tagName }; })()`);
      await shot(cdp, 'a-fresh-list.png');
      check(layout.placeholder && layout.separator && layout.h2 && layout.order && focused.inPersonal && focused.text === 'My Agent', 'a. placeholder, separator, h2 "Projects", toolbar, group in order; placeholder is the first Tab stop after the Views group', { layout, focused });
    });

    // b. keyboard Enter creates the one personal row
    await guarded('b', async () => {
      await pressRealEnter(cdp);
      await cdp.waitFor(`!!(${PERSONAL_OPEN})`, { timeoutMs: 30_000, label: 'real row replaces the placeholder' });
      await cdp.waitFor(`window.refract.sessions.list().then((r) => r.ok && ['idle','working','needs-you'].includes(r.value.find((s) => s.kind === 'personal')?.status))`, { timeoutMs: 60_000, label: 'Personal Agent running' });
      await sleep(1_000);
      const personalRows = registryOf(dataDir).sessions.filter((s) => s.kind === 'personal');
      const runs = invocations(debugLog).filter((r) => norm(r.cwd) === norm(home));
      const row = await cdp.evaluate(`(() => { const b = ${PERSONAL_OPEN}; return { name: b?.getAttribute('aria-label'), current: b?.getAttribute('aria-current'), placeholderGone: !(${PLACEHOLDER}) }; })()`);
      await shot(cdp, 'b-after-enter.png');
      check(personalRows.length === 1 && runs.length === 1 && runs[0].argv.includes(`--cwd=${home}`) && row.placeholderGone && /^My Agent, \S/.test(row.name ?? '') && row.current === 'true', 'b. Enter creates exactly one personal registry row, launches in home with --cwd, row is a selected real SessionRow named "My Agent" with a status', { rows: personalRows.length, runs, row });
    });

    // c. search
    await guarded('c', async () => {
      await cdp.click(FILTER_TOGGLE_FINDER);
      await cdp.waitFor(`!!(${SEARCH_INPUT_FINDER})`, { timeoutMs: 10_000, label: 'search field' });
      await cdp.click(SEARCH_INPUT_FINDER);
      await cdp.send('Input.insertText', { text: 'zzz-no-such-session' });
      await cdp.waitFor(`!document.querySelector('[data-repository-id]')`, { timeoutMs: 10_000, label: 'groups filtered out' });
      const none = await cdp.evaluate(`({ personal: !!(${PERSONAL_OPEN}), groups: document.querySelectorAll('[data-repository-id]').length, empty: document.body.textContent.includes('No sessions match') })`);
      await shot(cdp, 'c-search-no-match.png');
      await cdp.evaluate(`(() => { const i = ${SEARCH_INPUT_FINDER}; i.focus(); i.select(); })()`);
      await cdp.send('Input.insertText', { text: projectSessionName });
      await cdp.waitFor(`!!document.querySelector('[data-repository-id]')`, { timeoutMs: 10_000, label: 'group back for a matching query' });
      const match = await cdp.evaluate(`({ personal: !!(${PERSONAL_OPEN}), groups: document.querySelectorAll('[data-repository-id]').length })`);
      await cdp.evaluate(`(() => { const i = ${SEARCH_INPUT_FINDER}; i.focus(); i.select(); })()`);
      await cdp.send('Input.insertText', { text: 'My Agent' });
      await sleep(600);
      const mine = await cdp.evaluate(`({ personal: !!(${PERSONAL_OPEN}), groups: document.querySelectorAll('[data-repository-id]').length })`);
      await cdp.evaluate(`(() => { const i = ${SEARCH_INPUT_FINDER}; i.focus(); i.select(); })()`);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' });
      await cdp.waitFor(`!!document.querySelector('[data-repository-id]')`, { timeoutMs: 10_000, label: 'group back after clearing' });
      check(none.personal && none.groups === 0 && none.empty && match.personal && match.groups === 1 && mine.personal && mine.groups === 0, 'c. Personal Agent row stays visible for no-match, project-match and own-name queries; groups filter as before', { none, match, mine });
    });

    // d. menus and rename
    await guarded('d', async () => {
      const trigger = `document.querySelector('button[aria-label="More actions for My Agent"]')`;
      await hoverRow(cdp, `${PERSONAL_OPEN}.closest('li')`);
      await cdp.waitFor(`(() => { const el = ${trigger}; return !!el && parseFloat(getComputedStyle(el).opacity) > 0.5; })()`, { timeoutMs: 10_000, label: 'overflow trigger revealed' });
      await cdp.click(trigger);
      await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'overflow menu' });
      const overflow = await readMenu(cdp);
      await hoverRow(cdp, `Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim().startsWith('Archive'))`);
      await sleep(1_200);
      const tooltip = await cdp.evaluate(`Array.from(document.querySelectorAll('[role="tooltip"], [data-slot="tooltip-content"]')).map((el) => el.textContent.trim())`);
      await shot(cdp, 'd1-overflow-menu.png');
      await closeMenu(cdp);

      await rightClick(cdp, PERSONAL_OPEN);
      await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'context menu' });
      const context = await readMenu(cdp);
      await shot(cdp, 'd2-context-menu-right-click.png');
      await closeMenu(cdp);

      await cdp.evaluate(`${PERSONAL_OPEN}.focus()`);
      await pressKey(cdp, 93, 'ContextMenu', 'ContextMenu');
      let keyboard = null;
      try {
        await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'keyboard context menu' });
        keyboard = await readMenu(cdp);
        await shot(cdp, 'd3-context-menu-keyboard.png');
        await closeMenu(cdp);
      } catch {
        keyboard = null;
      }

      const verdict = (items) =>
        !!items &&
        items.some((i) => i.label === 'Rename') &&
        ['Archive', 'Delete…'].every((l) => {
          const item = items.find((i) => i.label.startsWith(l));
          return item && item.ariaDisabled && /Personal Agent cannot be archived or deleted/.test(item.reason ?? '');
        }) &&
        !items.some((i) => /worktree|Reveal|Hide|New session/i.test(i.label));
      check(verdict(overflow) && verdict(context) && verdict(keyboard) && tooltip.some((t) => /cannot be archived or deleted/.test(t)), 'd1. overflow, right-click and menu-key menus: Rename present, Archive and Delete disabled with a readable reason (description + tooltip), no worktree actions', { overflow, context, keyboard, tooltip });

      await rightClick(cdp, PERSONAL_OPEN);
      await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'context menu for rename' });
      await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Rename')`);
      await cdp.waitFor(`!!${PERSONAL_UL}.querySelector('input[aria-label="Session name"]')`, { timeoutMs: 10_000, label: 'rename input' });
      await cdp.evaluate(`${PERSONAL_UL}.querySelector('input[aria-label="Session name"]').select()`);
      await cdp.send('Input.insertText', { text: 'Helper' });
      await pressRealEnter(cdp);
      await cdp.waitFor(`(${PERSONAL_OPEN})?.getAttribute('aria-label')?.startsWith('Helper')`, { timeoutMs: 15_000, label: 'row shows Helper' });
      await sleep(700);
      const saved = registryOf(dataDir).sessions.find((s) => s.kind === 'personal')?.name;
      await shot(cdp, 'd4-renamed-helper.png');
      check(saved === 'Helper', 'd2. rename to "Helper": row shows Helper and registry.json persists it', { saved });
    });

    // e. group unchanged
    await guarded('e', async () => {
      const personalId = registryOf(dataDir).sessions.find((s) => s.kind === 'personal')?.id;
      const groupAfter = await groupText();
      const inside = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-repository-id]')).some((g) => g.querySelector('[data-session-open="${personalId}"]'))`);
      const sessionsInGroup = await cdp.evaluate(`document.querySelector('[data-repository-id]').querySelectorAll('li [data-session-open]').length`);
      const trigger = `document.querySelector('[data-repository-id] [aria-expanded]')`;
      await cdp.click(trigger);
      await cdp.waitFor(`${trigger}.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 10_000, label: 'group collapsed' });
      const collapsed = await cdp.evaluate(`({ rows: document.querySelector('[data-repository-id]').querySelectorAll('li [data-session-open]').length, personal: !!(${PERSONAL_OPEN}) })`);
      await cdp.click(trigger);
      await cdp.waitFor(`${trigger}.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: 'group expanded' });
      check(!inside && sessionsInGroup === 1 && groupAfter === groupBefore && collapsed.rows === 0 && collapsed.personal, 'e. group header and count unchanged, collapse works, Personal Agent never inside a group', { groupBefore, groupAfter, sessionsInGroup, collapsed });
    });

    // g. themes (taken here while the real row exists; the placeholder is compared in the first run's shot a)
    await guarded('g', async () => {
      for (const theme of ['light', 'dark']) {
        await cdp.evaluate(`window.refract.theme.set(${JSON.stringify(theme)}).then((r) => r)`);
        await cdp.waitFor(`document.documentElement.className.includes('theme-${theme}') || document.documentElement.classList.contains('${theme}')`, { timeoutMs: 10_000, label: `${theme} applied` });
        await sleep(400);
        await shot(cdp, `g-real-row-${theme}.png`);
      }
      check(true, 'g1. light and dark screenshots of the real row captured (g-real-row-*.png)');
    });

    cdp.close();
    await stopLauncher(app.child).catch(() => {});
    app = undefined;

    // f. restart on the same data folder
    app = await startApp({ ...launchArgs, tag: '2' });
    cdp = app.cdp;
    await guarded('f', async () => {
      await cdp.waitFor(`!!(${PERSONAL_OPEN})`, { timeoutMs: 30_000, label: 'real row after restart' });
      const state = await cdp.evaluate(`({ placeholder: !!(${PLACEHOLDER}), rows: document.querySelectorAll('ul[aria-label="Personal Agent"] li').length, name: (${PERSONAL_OPEN}).getAttribute('aria-label') })`);
      const personalRows = registryOf(dataDir).sessions.filter((s) => s.kind === 'personal');
      await shot(cdp, 'f-after-restart.png');
      check(!state.placeholder && state.rows === 1 && /^Helper,/.test(state.name) && personalRows.length === 1, 'f. after restart the row is the real Session row, not the placeholder, and not duplicated', { state, registryRows: personalRows.length });
    });

    // g2. placeholder vs real row, both themes: fresh data folder placeholder shot in light and dark
    cdp.close();
    await stopLauncher(app.child).catch(() => {});
    app = undefined;
    const freshData = scratch('data-fresh');
    dirs.push(freshData);
    app = await startApp({ ...launchArgs, dataDir: freshData, tag: '3' });
    await guarded('g2', async () => {
      for (const theme of ['light', 'dark']) {
        await app.cdp.evaluate(`window.refract.theme.set(${JSON.stringify(theme)}).then((r) => r)`);
        await sleep(700);
        await shot(app.cdp, `g-placeholder-${theme}.png`);
      }
      const geometry = await app.cdp.evaluate(`(() => { const b = ${PLACEHOLDER}; const r = b?.getBoundingClientRect(); return r ? { left: r.left, height: r.height, width: r.width, textLeft: (() => { const range = document.createRange(); range.selectNodeContents(b); return range.getBoundingClientRect().left; })() } : null; })()`);
      writeFileSync(path.join(SHOTS_DIR, 'placeholder-geometry.json'), JSON.stringify(geometry, null, 2));
      check(!!geometry, 'g2. placeholder light and dark screenshots captured (g-placeholder-*.png)', geometry);
    });
    // h. creating the Personal Agent while a filter is active must not announce "hidden by the session filter"
    await guarded('h', async () => {
      const c = app.cdp;
      await c.evaluate(`window.__ann = []; new MutationObserver(() => { for (const el of document.querySelectorAll('[role="status"], [aria-live]')) { const t = el.textContent.trim(); if (t) window.__ann.push(t); } }).observe(document.body, { subtree: true, childList: true, characterData: true });`);
      await c.click(FILTER_TOGGLE_FINDER);
      await c.waitFor(`!!(${SEARCH_INPUT_FINDER})`, { timeoutMs: 10_000, label: 'search field (h)' });
      await c.click(SEARCH_INPUT_FINDER);
      await c.send('Input.insertText', { text: 'zzz-no-such-session' });
      await sleep(600);
      await c.evaluate(`${PLACEHOLDER}.focus()`);
      await pressRealEnter(c);
      await c.waitFor(`!!(${PERSONAL_OPEN})`, { timeoutMs: 30_000, label: 'Personal Agent created under a filter' });
      await sleep(2_500);
      const ann = await c.evaluate(`window.__ann`);
      await shot(c, 'h-created-under-filter.png');
      check(!ann.some((t) => /hidden by the session filter/.test(t)), 'h. creating the Personal Agent under an active filter does not announce "hidden by the session filter"', { announcements: [...new Set(ann)] });
    });
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    console.error(err);
    try { if (app) await shot(app.cdp, '99-crash.png'); } catch {}
    process.exitCode = 1;
  } finally {
    if (app) {
      app.cdp.close();
      await stopLauncher(app.child).catch(() => {});
    }
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    for (const dir of dirs) await safeRmSync(dir, LOG);
  }
  const failed = report.filter((r) => !r.ok);
  console.log(`${LOG}: ${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`}; evidence in ${SHOTS_DIR}`);
}

main();
