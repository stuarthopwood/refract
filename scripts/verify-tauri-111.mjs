#!/usr/bin/env node
// Live CDP check for #1302 (one option-button and tab look): computed styles and screenshots at each changed site, against a
// built debug exe with the recorded-frame fake omp, a scratch REFRACT_DATA_DIR and its own debugging port.
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_111_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-111.mjs

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate, clickMenuItem, groupTriggerFinder } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_111_SHOTS_DIR || path.join(tmpdir(), 'refract-111-shots');
mkdirSync(SHOTS_DIR, { recursive: true });

const sites = {};
const gaps = [];
const failures = [];
let shotIndex = 0;

const ITEMS = `'[role="tab"], [data-slot="toggle-group-item"]'`;

// Selected/rest styles of every tab or option button in `scope`, including the ::after bar and the transparent border.
const MEASURE = (scope) => `(() => {
  const root = ${scope};
  if (!root) return null;
  const read = (el) => {
    const cs = getComputedStyle(el);
    const after = getComputedStyle(el, '::after');
    const selected = el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-checked') === 'true' || el.getAttribute('data-state') === 'on';
    return {
      label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24),
      selected,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      backgroundImage: cs.backgroundImage,
      borderTopColor: cs.borderTopColor,
      borderTopWidth: cs.borderTopWidth,
      afterHeight: after.height,
      afterBackground: after.backgroundColor,
      afterLeft: after.left,
      afterContent: after.content,
      afterTransform: after.transform,
      afterOpacity: after.opacity
    };
  };
  return Array.from(root.querySelectorAll(${ITEMS})).map(read);
})()`;

const isTransparent = (c) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent';

function judge(items) {
  const selected = items.filter((i) => i.selected);
  const rest = items.filter((i) => !i.selected);
  const problems = [];
  if (selected.length === 0) problems.push('no selected item found');
  for (const s of selected) {
    if (!isTransparent(s.backgroundColor) || s.backgroundImage !== 'none') problems.push(`selected "${s.label}" has a fill: ${s.backgroundColor} ${s.backgroundImage}`);
    if (parseFloat(s.afterHeight) !== 2) problems.push(`selected "${s.label}" bar height ${s.afterHeight}, want 2px`);
    if (isTransparent(s.afterBackground)) problems.push(`selected "${s.label}" bar has no colour`);
  }
  for (const r of rest) {
    if (!isTransparent(r.backgroundColor)) problems.push(`resting "${r.label}" has a fill: ${r.backgroundColor}`);
  }
  return problems;
}

async function shot(cdp, name) {
  shotIndex += 1;
  const file = `${String(shotIndex).padStart(2, '0')}-${name}.png`;
  await cdp.screenshot(path.join(SHOTS_DIR, file));
  return file;
}

async function hoverFirstResting(cdp, scope) {
  const rect = await cdp.evaluate(`(() => {
    const root = ${scope};
    const el = Array.from(root?.querySelectorAll(${ITEMS}) ?? []).find((e) => !(e.getAttribute('aria-selected') === 'true' || e.getAttribute('aria-checked') === 'true' || e.getAttribute('data-state') === 'on'));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24) };
  })()`);
  if (!rect) return null;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await sleep(250);
  const hovered = await cdp.evaluate(`(() => {
    const el = document.elementFromPoint(${rect.x}, ${rect.y})?.closest(${ITEMS});
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { label: ${JSON.stringify(rect.label)}, color: cs.color, backgroundColor: cs.backgroundColor };
  })()`);
  return hovered;
}

// Records one site: rest + selected styles, a hover sample, and screenshots. Any failure is a recorded gap, not an abort.
async function capture(cdp, name, scope, prepare) {
  try {
    if (prepare) await prepare();
    await cdp.waitFor(`!!(${scope})`, { timeoutMs: 15_000, label: `${name} present` });
    await sleep(400);
    const items = await cdp.evaluate(MEASURE(scope));
    const rest = await shot(cdp, `${name}-rest`);
    const hover = await hoverFirstResting(cdp, scope);
    const hoverShot = hover ? await shot(cdp, `${name}-hover`) : null;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    const problems = judge(items);
    sites[name] = { items, hover, problems, screenshots: [rest, hoverShot].filter(Boolean) };
    if (hover && items.length) {
      const sel = items.find((i) => i.selected);
      const res = items.find((i) => !i.selected);
      if (res && hover.color === res.color && sel && sel.color !== res.color) problems.push(`hover on "${hover.label}" kept the resting colour ${hover.color}`);
      if (!isTransparent(hover.backgroundColor)) problems.push(`hover on "${hover.label}" added a fill ${hover.backgroundColor}`);
    }
    console.log(`${problems.length ? 'FAIL' : 'PASS'}: ${name} (${items.length} items)${problems.length ? ' ' + problems.join('; ') : ''}`);
    if (problems.length) failures.push(`${name}: ${problems.join('; ')}`);
  } catch (err) {
    gaps.push(`${name}: ${err.message}`);
    console.log(`GAP: ${name}: ${err.message}`);
  }
}

async function openProfileItem(cdp, item) {
  await cdp.click(`document.querySelector('[data-profile-name-button]')`);
  await cdp.waitFor(`!!document.querySelector('[role="menuitem"]')`, { timeoutMs: 10_000, label: 'profile menu open' });
  await clickMenuItem(cdp, item);
}

async function clickNav(cdp, label) {
  await cdp.click(`document.querySelector('[aria-label="${label}"]')`);
}

async function backToChat(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`).catch(() => {});
  await sleep(500);
}

// One more forced-colours pass: selected items must show the Highlight border, not the bar.
async function forcedColoursCheck(cdp, scope) {
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
  await sleep(500);
  const data = await cdp.evaluate(`(() => {
    const el = Array.from(document.querySelectorAll(${ITEMS})).find((e) => e.getAttribute('aria-selected') === 'true' || e.getAttribute('aria-checked') === 'true' || e.getAttribute('data-state') === 'on');
    if (!el) return null;
    const cs = getComputedStyle(el);
    const after = getComputedStyle(el, '::after');
    return { label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24), borderTopColor: cs.borderTopColor, borderTopWidth: cs.borderTopWidth, afterDisplay: after.display, afterContent: after.content };
  })()`);
  const file = await shot(cdp, 'forced-colours');
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'none' }] });
  sites['forced-colours'] = { data, screenshots: [file], scope };
  const ok = !!data && parseFloat(data.borderTopWidth) >= 1 && (data.afterDisplay === 'none' || data.afterContent === 'none');
  console.log(`${ok ? 'PASS' : 'FAIL'}: forced-colours selected item shows a border and no bar ${JSON.stringify(data)}`);
  if (!ok) failures.push(`forced-colours: ${JSON.stringify(data)}`);
}

async function runChecks(cdp, { repoA, repoAName }) {
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness mounted' });
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
    { timeoutMs: 60_000, label: 'Readiness green' }
  );
  await addRepository(cdp, repoA);
  await cdp.waitFor(groupTriggerFinder(repoAName) + ' !== undefined', { timeoutMs: 15_000, label: 'Project rendered' });
  await createSessionViaQuickCreate(cdp, repoAName);

  await capture(cdp, 'panel-tab-bar', `document.querySelector('[role="tablist"]')`);

  await capture(cdp, 'manage-sessions-toolbar', `document.querySelector('section [role="tablist"]')`, async () => {
    await openProfileItem(cdp, 'Manage sessions');
    await cdp.waitFor(`!!document.querySelector('ul[aria-label="All sessions across projects"]')`, { timeoutMs: 15_000, label: 'Manage list' });
  });
  await backToChat(cdp);

  await capture(cdp, 'usage-date-range', `document.querySelector('section[aria-label="Usage"]')`, async () => {
    await clickNav(cdp, 'Usage');
    await cdp.waitFor(`!!document.querySelector('section[aria-label="Usage"]')`, { timeoutMs: 15_000, label: 'Usage view' });
  });

  await capture(cdp, 'home-filters', `document.querySelector('[role="region"][aria-label="Home"]')`, async () => {
    await clickNav(cdp, 'Home');
    await cdp.waitFor(`!!document.querySelector('[role="region"][aria-label="Home"]')`, { timeoutMs: 15_000, label: 'Home view' });
  });

  await capture(cdp, 'settings-chat-row-spacing', `document.querySelector('[role="radiogroup"], [data-slot="toggle-group"]')?.closest('section, div')`, async () => {
    await openProfileItem(cdp, 'Settings').catch(async () => clickNav(cdp, 'Settings'));
    await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings opened' });
  });
  const groups = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-slot="toggle-group"]')).map((g, i) => ({ i, label: g.getAttribute('aria-label') || g.closest('section,div')?.textContent.slice(0, 30) }))`).catch(() => []);
  for (const g of groups) {
    await capture(cdp, `settings-toggle-group-${g.i}`, `document.querySelectorAll('[data-slot="toggle-group"]')[${g.i}]`);
  }
  await forcedColoursCheck(cdp, 'settings');
  await backToChat(cdp);
}

async function main() {
  const head = gitHead(REPO_ROOT);
  console.log(`verify-tauri-111: head ${head}, shots ${SHOTS_DIR}`);
  let shimDir, dataDir, importDir, exeDir, repoA, child, cdp;
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-111-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-111-data-'));
    importDir = mkdtempSync(path.join(tmpdir(), 'refract-111-import-'));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-111-exe-'));
    repoA = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-111-repo-')), 'A');
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(shimDir);
    const src = path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
    if (!existsSync(src)) throw new Error(`built exe not found at ${src}`);
    const exePath = path.join(exeDir, 'refract-tauri.exe');
    copyFileSync(src, exePath);
    const port = await getFreePort();
    const launched = await launchBuiltExeWithEnv(launcherExe, exePath, {
      port,
      dataDir,
      importSourceDir: importDir,
      pathPrepend: shimDir,
      logFile: path.join(SHOTS_DIR, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath
      }
    });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the launched process');
    await runChecks(cdp, { repoA, repoAName: path.basename(repoA) });
  } catch (err) {
    failures.push(`script error: ${err.message}`);
    console.error(err);
  } finally {
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, sites, gaps, failures }, null, 2));
    cdp?.close();
    if (child) await stopLauncher(child);
    for (const dir of [shimDir, dataDir, importDir, exeDir, repoA]) if (dir) await safeRmSync(dir);
  }
  console.log(`verify-tauri-111: ${failures.length ? 'FAIL' : 'DONE'} (${Object.keys(sites).length} sites, ${gaps.length} gaps) at head ${head}`);
  if (failures.length) process.exitCode = 1;
}

main();
