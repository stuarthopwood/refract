#!/usr/bin/env node
// Live CDP check of the brand watermark (#406) against the FAKE `omp` and `gh` shims: one mark per
// view, hidden on Settings and under forced-colors/reduced-transparency, never intercepts clicks.
// Usage: CARGO_TARGET_DIR=<shared target dir> node scripts/verify-406-watermark.mjs
// (requires a prior `pnpm exec tauri build --debug --no-bundle`).

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-406';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_406_SHOTS_DIR || path.join(tmpdir(), 'refract-406-shots');

const report = [];
function check(ok, label, evidence) {
  report.push({ step: label, ok: ok === true, evidence });
  console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label} ${evidence === undefined ? '' : JSON.stringify(evidence)}`);
}
const shot = async (cdp, name) => {
  await sleep(300);
  await cdp.screenshot(path.join(SHOTS_DIR, name));
};

// Live (corner) marks only: the Settings preview is the same class without `--live`.
const LIVE = `Array.from(document.querySelectorAll('.watermark-mark--live'))`;
const MARKS = `(() => ${LIVE}.map((el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom, display: s.display, pe: s.pointerEvents, opacity: s.opacity, ariaHidden: el.getAttribute('aria-hidden'), tabindex: el.getAttribute('tabindex') }; }))()`;
const PREVIEW_COUNT = `document.querySelectorAll('.watermark-mark:not(.watermark-mark--live)').length`;

function buildGhShim(dir) {
  const out = path.join(dir, 'gh.exe');
  const result = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-883-gh-shim.rs'), '-o', out], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`rustc gh shim failed:\n${result.stderr}`);
}

async function launch(env) {
  const port = await getFreePort();
  const launched = await launchBuiltExe(env.launcherExe, env.exe, {
    port,
    dataDir: env.dataDir,
    pathPrepend: env.shimDir,
    logFile: path.join(SHOTS_DIR, `app-${port}.log`),
    extraEnv: {
      REFRACT_IMPORT_SOURCE_DIR: env.importSourceDir,
      REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
      REFRACT_FAKE_OMP_NODE: process.execPath,
      REFRACT_FAKE_OMP_SCENARIO: 'session',
      REFRACT_883_CALL_LOG: path.join(env.shimDir, 'gh-calls.log'),
      // A date with no holiday, so the plain mark (not a seasonal glyph) renders.
      REFRACT_DATE_OVERRIDE: env.dateOverride ?? '2026-06-15'
    }
  });
  const cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
  if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target not owned by launched pid');
  console.log(`${LOG}: launched exe pid ${launched.targetPid} on port ${port}`);
  return { cdp, child: launched.child };
}

async function openAppearance(cdp) {
  if (!(await cdp.evaluate(`!!document.querySelector('[aria-label="Back to chat"]')`))) {
    await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  }
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings opened' });
  await cdp.click(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === 'Appearance')`);
  await cdp.waitFor(`!!document.getElementById('watermark-toggle')`, { timeoutMs: 10_000, label: 'Watermark switch mounted' });
  await cdp.evaluate(`document.getElementById('watermark-toggle').scrollIntoView({ block: 'center' })`);
  await sleep(300);
}
const switchState = (cdp) => cdp.evaluate(`document.getElementById('watermark-toggle')?.getAttribute('aria-checked')`);
const pressTab = async (cdp, shift = false) => {
  for (const type of ['rawKeyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, ...(shift ? { modifiers: 8 } : {}) });
  await sleep(150);
};
const activeInfo = (cdp) => cdp.evaluate(`(() => { const a = document.activeElement; return { id: a?.id ?? '', tag: a?.tagName ?? '', inMark: !!a?.closest('.watermark-mark, .watermark-mark-holiday') }; })()`);

// Real Tab key presses (not .focus()) through the Appearance switch, then the accessibility tree.
async function runKeyboardAndA11yChecks(cdp) {
  await openAppearance(cdp);
  await cdp.send('Accessibility.enable');
  await cdp.evaluate(`(() => { const sel = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'; const all = Array.from(document.querySelectorAll(sel)).filter((el) => !el.disabled && el.getClientRects().length); const i = all.findIndex((el) => el.id === 'watermark-toggle'); all[i - 1].focus(); })()`);
  await pressTab(cdp);
  const onSwitch = await activeInfo(cdp);
  check(onSwitch.id === 'watermark-toggle', 'Tab from the previous control lands on the Background watermark switch', onSwitch);
  const walked = [];
  for (let i = 0; i < 6; i++) { await pressTab(cdp); walked.push(await activeInfo(cdp)); }
  check(walked.every((w) => w.inMark === false && w.tag !== 'BODY'), 'Six more Tab presses never land inside a watermark mark', walked);
  await pressTab(cdp, true);
  for (let i = 0; i < 5; i++) await pressTab(cdp, true);
  const back = await activeInfo(cdp);
  check(back.inMark === false, 'Shift+Tab walk back never lands inside a watermark mark', back);

  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  const sw = nodes.filter((n) => n.role?.value === 'switch' && n.name?.value === 'Background watermark' && !n.ignored);
  const described = sw[0]?.properties?.some((p) => p.name === 'describedby') || sw[0]?.description?.value?.includes('faint');
  check(sw.length === 1 && !!described, 'Accessibility tree: one "Background watermark" switch, described by its hint', { count: sw.length, description: sw[0]?.description?.value });
  const { result } = await cdp.send('Runtime.evaluate', { expression: `document.querySelector('.watermark-mark:not(.watermark-mark--live)')` });
  const partial = result?.objectId ? await cdp.send('Accessibility.getPartialAXTree', { objectId: result.objectId, fetchRelatives: false }) : { nodes: [] };
  check(partial.nodes.length > 0 && partial.nodes.every((n) => n.ignored === true), 'Accessibility tree: the preview mark is ignored (decorative)', partial.nodes.map((n) => ({ ignored: n.ignored, role: n.role?.value })));
  await shot(cdp, '15-keyboard-a11y.png');
}
async function setSwitch(cdp, wanted) {
  await openAppearance(cdp);
  if ((await switchState(cdp)) !== String(wanted)) await cdp.click(`document.getElementById('watermark-toggle')`);
  await cdp.waitFor(`document.getElementById('watermark-toggle')?.getAttribute('aria-checked') === '${wanted}'`, { timeoutMs: 5_000, label: `switch ${wanted}` });
}
async function backToChat(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
  await cdp.waitFor(`!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 10_000, label: 'Back in chat' });
  await sleep(400);
}

async function createSession(cdp) {
  await cdp.clickByLabel('New session from a branch in ', { prefix: true });
  await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, { timeoutMs: 15_000, label: 'New session dialog' });
  await cdp.clickByText('Create session', { inDialog: true });
  await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 90_000, label: 'dialog closed' });
  await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'composer enabled' });
  await sleep(1500);
}

const layoutState = (cdp) => cdp.evaluate(`(() => {
  const marks = ${LIVE};
  const m = marks[0];
  if (!m) return { n: marks.length };
  const r = m.getBoundingClientRect();
  const pane = m.closest('#split-pane-1') || document;
  const composer = pane.querySelector('[aria-label="Message"]');
  const composerTop = composer ? composer.getBoundingClientRect().top : null;
  const chat = document.getElementById('chat');
  return { n: marks.length, w: Math.round(r.width), x: Math.round(r.x), right: Math.round(r.right), bottom: Math.round(r.bottom), composerTop: composerTop && Math.round(composerTop), vw: innerWidth, chatW: chat ? Math.round(chat.getBoundingClientRect().width) : null,
    ok: marks.length === 1 && r.x >= 0 && r.right <= innerWidth && (composerTop === null || r.bottom <= composerTop + 0.5) };
})()`);

async function drag(cdp, from, to) {
  const mouse = (type, p, extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', ...extra });
  await mouse('mouseMoved', from);
  await mouse('mousePressed', from, { buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 8; i++) await mouse('mouseMoved', { x: from.x + ((to.x - from.x) * i) / 8, y: from.y + ((to.y - from.y) * i) / 8 }, { buttons: 1 });
  await mouse('mouseReleased', to, { buttons: 0, clickCount: 1 });
  await sleep(400);
}
const center = (cdp, selector) => cdp.evaluate(`(() => { const el = ${selector}; if (!el) return null; const r = el.getBoundingClientRect(); return r.width || r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);

// Composer growth, resize, drag-select, divider drags, right pane toggles, Manage sessions.
async function runLayoutChecks(cdp) {
  const composerSel = `(document.querySelector('#split-pane-1 [aria-label="Message"]') || document.querySelector('[aria-label="Message"]'))`;
  const baseline = await layoutState(cdp);

  // Composer growth to its maximum: the mark must stay above the composer.
  await cdp.click(composerSel);
  const h0 = await cdp.evaluate(`${composerSel}.getBoundingClientRect().height`);
  await cdp.send('Input.insertText', { text: Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') });
  await sleep(400);
  const grown = await layoutState(cdp);
  const h12 = await cdp.evaluate(`${composerSel}.getBoundingClientRect().height`);
  await cdp.send('Input.insertText', { text: '\n' + Array.from({ length: 12 }, (_, i) => `more ${i + 1}`).join('\n') });
  await sleep(400);
  const maxed = await layoutState(cdp);
  const h24 = await cdp.evaluate(`${composerSel}.getBoundingClientRect().height`);
  check(h12 > h0 && grown.ok === true && maxed.ok === true && h24 >= h12, 'Composer growth: grows then caps, the mark stays above it', { h0, h12, h24, baseline, grown, maxed });
  await shot(cdp, '09-composer-grown.png');
  await cdp.evaluate(`(() => { const el = ${composerSel}; el.focus(); el.select(); document.execCommand('delete'); })()`);
  await sleep(300);

  const chipOverlap = `(() => { const bad = []; for (const h of document.querySelectorAll('header')) { const H = h.getBoundingClientRect(); const els = [...h.querySelectorAll('button,[data-slot=badge]')].filter((e) => e.offsetWidth); els.forEach((a, i) => { const r = a.getBoundingClientRect(); if (r.left < H.left - 0.5 || r.right > H.right + 0.5) bad.push('overflow:' + (a.getAttribute('aria-label') || a.textContent.trim())); els.slice(i + 1).forEach((b) => { if (a.contains(b) || b.contains(a)) return; const s = b.getBoundingClientRect(); if (!(r.right <= s.left + 0.5 || s.right <= r.left + 0.5 || r.bottom <= s.top + 0.5 || s.bottom <= r.top + 0.5)) bad.push('overlap:' + (a.getAttribute('aria-label') || a.textContent.trim()) + '|' + (b.getAttribute('aria-label') || b.textContent.trim())); }); }); } return bad; })()`;
  const sizes = [];
  let chips620 = [];
  for (const width of [1100, 800, 620]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 700, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    sizes.push({ width, ...(await layoutState(cdp)) });
    if (width === 620) chips620 = await cdp.evaluate(chipOverlap);
  }
  check(chips620.length === 0, 'Header chips at 620px: none overlap or overflow the header', chips620);
  await shot(cdp, '10-resized-narrow.png');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(600);
  const restored = await layoutState(cdp);
  check(sizes.every((s) => s.ok === true) && restored.ok === true, 'Window resize: always exactly one mark, inside the window, above the composer', { sizes, restored });

  // Drag-select across the mark over real transcript text: send a long message so it fills the width.
  const marker = 'WMARK406';
  await cdp.click(composerSel);
  await cdp.send('Input.insertText', { text: `${marker} ${'selectable words '.repeat(80)}` });
  for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
  await cdp.waitFor(`document.body.innerText.includes('${marker}')`, { timeoutMs: 20_000, label: 'Message echoed in the transcript' });
  await sleep(1200);
  // The transcript's end padding keeps prose clear of the mark, so the drag starts at the message text
  // and ends on the mark's own centre: the selection must still complete, passing through the mark.
  const sel = await cdp.evaluate(`(() => {
    const m = ${LIVE}[0]; const mr = m.getBoundingClientRect();
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node; let first = null; let overlap = 0;
    while ((node = w.nextNode())) {
      if (!node.nodeValue.includes('selectable words')) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      for (const r of range.getClientRects()) {
        if (!first) first = { l: r.left, t: r.top, h: r.height };
        if (r.right > mr.left && r.left < mr.right && r.bottom > mr.top && r.top < mr.bottom) overlap++;
      }
    }
    return { overlap, first, end: { x: mr.left + mr.width / 2, y: mr.top + mr.height / 2 } };
  })()`);
  let selection = { overlap: sel.overlap, text: '' };
  if (sel.first) {
    await drag(cdp, { x: sel.first.l + 2, y: sel.first.t + sel.first.h / 2 }, sel.end);
    selection = await cdp.evaluate(`(() => { const s = getSelection(); const m = ${LIVE}[0]; const r = m.getBoundingClientRect(); const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { text: s.toString(), inMark: !!(s.anchorNode && m.contains(s.anchorNode)) || !!(s.focusNode && m.contains(s.focusNode)), endHit: el === m || m.contains(el) }; })()`);
    selection.overlap = sel.overlap;
    await shot(cdp, '11-drag-select-over-mark.png');
    await cdp.evaluate(`getSelection().removeAllRanges()`);
  }
  check(selection.text.includes('selectable words') && selection.inMark === false && selection.endHit === false, 'Drag-select: a drag ending on the mark selects the message text and the mark never intercepts', { ...selection, text: selection.text.slice(0, 60) });
  // Divider drags through their full range; the chat panel keeps its 360px floor.
  const labels = await cdp.evaluate(`Array.from(document.querySelectorAll('[role="separator"]')).map((el) => el.getAttribute('aria-label'))`);
  const drags = [];
  for (const label of labels.filter(Boolean)) {
    const sep = `Array.from(document.querySelectorAll('[role="separator"]')).find((el) => el.getAttribute('aria-label') === ${JSON.stringify(label)})`;
    for (const dx of [-700, 700, -300]) {
      const c = await center(cdp, sep);
      if (!c) break;
      await drag(cdp, c, { x: Math.max(5, c.x + dx), y: c.y });
      drags.push({ label, dx, ...(await layoutState(cdp)) });
    }
  }
  await shot(cdp, '12-after-divider-drags.png');
  check(drags.length > 0 && drags.every((d) => d.ok === true && (d.chatW === null || d.chatW >= 359)), 'Divider drags: one mark, above the composer, chat panel never below its 360px floor', { labels, drags });

  // Right pane (and the Subagent panel) open and close repeatedly.
  const toggles = [];
  for (let i = 0; i < 3; i++) {
    await cdp.click(`document.querySelector('[data-rail-toggle]')`);
    await sleep(700);
    const subBtn = await center(cdp, `document.querySelector('[data-rail-button="subagents"]')`);
    if (subBtn) { await cdp.click(`document.querySelector('[data-rail-button="subagents"]')`); await sleep(700); }
    toggles.push({ open: await cdp.evaluate(`document.querySelector('[data-rail-toggle]')?.getAttribute('aria-expanded')`), subagents: !!subBtn, ...(await layoutState(cdp)) });
    if (i === 0) await shot(cdp, '13-right-pane-open.png');
  }
  check(toggles.every((t) => t.ok === true), 'Right pane and Subagent panel opened three times: one mark, above the composer', toggles);
  if ((await cdp.evaluate(`document.querySelector('[data-rail-toggle]')?.getAttribute('aria-expanded')`)) === 'true') await cdp.click(`document.querySelector('[data-rail-toggle]')`);
  await sleep(500);

  await cdp.click(`document.querySelector('[data-profile-name-button]')`);
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('[role="menu"][data-state="open"]')).find((el) => el.textContent.includes('Manage sessions'))`, { timeoutMs: 10_000, label: 'Profile menu open' });
  await sleep(300);
  await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Manage sessions')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Manage sessions opened' });
  await sleep(500);
  check((await cdp.evaluate(`${LIVE}.length`)) === 0, 'Manage sessions screen: no live mark', null);
  await shot(cdp, '14-manage-sessions.png');
  await backToChat(cdp);
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-406-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-406-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-406-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-406-watermark');
  const worktreesRoot = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-406-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-406-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-406-shim-'));
  const exe = path.join(exeDir, 'refract-tauri.exe');
  let session;
  try {
    buildOmpShim(shimDir);
    buildGhShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    copyFileSync(path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe'), exe);
    const env = { launcherExe, exe, dataDir, shimDir, importSourceDir };
    session = await launch(env);
    let { cdp } = session;

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness' });
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
    check((await cdp.evaluate(`${LIVE}.length`)) === 0, 'Readiness screen: no live mark', null);
    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    const localFolder = `Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim().startsWith('Local folder'))`;
    await cdp.waitFor(`!!(${localFolder})`, { timeoutMs: 10_000, label: 'Add project menu open' });
    await cdp.click(localFolder);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repo dialog' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add project', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 30_000, label: 'Add project dialog closed' });
    await cdp.waitFor(`!!document.querySelector('[data-chat-empty-state]') || document.body.innerText.includes('Quick actions')`, { timeoutMs: 30_000, label: 'Empty chat state or Home' });
    await sleep(500);
    const onEmpty = await cdp.evaluate(`!!document.querySelector('[data-chat-empty-state]')`);
    if (onEmpty) check((await cdp.evaluate(`${LIVE}.length`)) === 1, 'Empty state (no pane open): one mark', await cdp.evaluate(MARKS));
    else check((await cdp.evaluate(`${LIVE}.length`)) === 0, 'Home view (full-screen, not a chat area): no live mark', null);
    await shot(cdp, '01-empty-state.png');

    await createSession(cdp);
    const single = await cdp.evaluate(MARKS);
    const composerTop = await cdp.evaluate(`document.querySelector('[aria-label="Message"]').getBoundingClientRect().top`);
    check(single.length === 1, 'Single pane: exactly one mark', single);
    const m = single[0] ?? {};
    check(m.pe === 'none' && m.ariaHidden === 'true' && m.tabindex === null && m.display !== 'none', 'Single pane: pointer-events none, aria-hidden, no tabindex, displayed', m);
    check(m.bottom <= composerTop + 0.5, 'Single pane: mark sits above the composer (reading area, not behind it)', { markBottom: m.bottom, composerTop });
    const hit = await cdp.evaluate(`(() => { const m = ${LIVE}[0]; const r = m.getBoundingClientRect(); const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { hitIsMark: el === m || m.contains(el), hit: el ? el.tagName + '.' + String(el.className).slice(0, 60) : null }; })()`);
    check(hit.hitIsMark === false, 'Click-through: elementFromPoint at the mark centre is real content, not the mark', hit);
    const focusableInMark = await cdp.evaluate(`${LIVE}[0].querySelectorAll('a,button,input,select,textarea,[tabindex]').length`);
    check(focusableInMark === 0, 'No focusable markup inside the mark', focusableInMark);
    await shot(cdp, '02-single-pane.png');

    // Split: create a second session, then Ctrl+click the first row (the real openInSplit path).
    const ids = await cdp.evaluate(`window.refract.sessions.list().then((r) => (r.ok ? r.value.map((s) => s.id) : []))`);
    await createSession(cdp);
    const allIds = await cdp.evaluate(`window.refract.sessions.list().then((r) => (r.ok ? r.value.map((s) => s.id) : []))`);
    const firstId = ids[0] ?? allIds[0];
    await cdp.evaluate(`document.querySelector('[data-session-open=${JSON.stringify(firstId)}]')?.scrollIntoView({ block: 'center' })`);
    const rect = await cdp.evaluate(`(() => { const r = document.querySelector('[data-session-open=${JSON.stringify(firstId)}]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1, modifiers: 2 });
    await cdp.waitFor(`!!document.getElementById('split-pane-1')`, { timeoutMs: 15_000, label: 'Split open' });
    await sleep(800);
    const split = await cdp.evaluate(MARKS);
    const inRight = await cdp.evaluate(`${LIVE}.map((el) => !!el.closest('#split-pane-1'))`);
    const inLeft = await cdp.evaluate(`${LIVE}.map((el) => !!el.closest('#split-pane-0'))`);
    check(split.length === 1 && inRight[0] === true && inLeft[0] === false, 'Split: exactly one mark, inside the right pane only', { split, inRight, inLeft });
    await shot(cdp, '03-split.png');

    await openAppearance(cdp);
    check((await cdp.evaluate(`${LIVE}.length`)) === 0, 'Settings: no live corner mark', null);
    check((await cdp.evaluate(PREVIEW_COUNT)) === 1, 'Settings: exactly one preview mark', null);
    check((await switchState(cdp)) === 'true', 'Settings: switch defaults to on', null);
    await shot(cdp, '04-settings-on.png');
    await runKeyboardAndA11yChecks(cdp);

    await setSwitch(cdp, false);
    check((await cdp.evaluate(PREVIEW_COUNT)) === 0, 'Switch off: preview disappears immediately', null);
    await shot(cdp, '05-settings-off.png');
    await backToChat(cdp);
    check((await cdp.evaluate(`${LIVE}.length`)) === 0, 'Switch off: the live mark is gone with no restart', null);
    await setSwitch(cdp, true);
    await backToChat(cdp);
    check((await cdp.evaluate(`${LIVE}.length`)) === 1, 'Switch on: the live mark returns', null);

    // Media features under CDP emulation.
    const supported = await cdp.evaluate(`({ forced: matchMedia('(forced-colors)').media, transparency: matchMedia('(prefers-reduced-transparency: reduce)').media })`);
    check(supported.forced === '(forced-colors)' && supported.transparency !== 'not all', 'WebView2 recognises both media features', supported);
    for (const [feature, value, name] of [['forced-colors', 'active', 'forced-colors'], ['prefers-reduced-transparency', 'reduce', 'reduced-transparency']]) {
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: feature, value }] });
      await sleep(400);
      const hiddenNow = await cdp.evaluate(`${LIVE}.length === 1 && ${LIVE}.every((el) => getComputedStyle(el).display === 'none')`);
      check(hiddenNow === true, `Emulated ${name}: the mark is display none`, null);
      await shot(cdp, `06-${name}.png`);
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: feature, value: feature === 'forced-colors' ? 'none' : 'no-preference' }] });
      await sleep(300);
    }
    check((await cdp.evaluate(`${LIVE}.length === 1 && ${LIVE}.every((el) => getComputedStyle(el).display !== 'none')`)) === true, 'Emulation cleared: the mark returns', null);

    await runLayoutChecks(cdp);

    // Persistence: off, restart, still off.
    await setSwitch(cdp, false);
    const restart = async (mutate) => {
      session.cdp.close();
      await stopLauncher(session.child).catch(() => {});
      await sleep(2500);
      if (mutate) mutate();
      session = await launch(env);
      cdp = session.cdp;
      await cdp.waitFor(`!!document.querySelector('[aria-label="Settings"]')`, { timeoutMs: 60_000, label: 'app after relaunch' });
      await sleep(1500);
    };
    const settingsFile = () => readdirSync(dataDir).filter((f) => f.endsWith('.json')).map((f) => path.join(dataDir, f)).find((f) => readFileSync(f, 'utf8').includes('watermarkEnabled'));
    let files = [];
    await restart(() => {
      files = readdirSync(dataDir).filter((f) => f.endsWith('.json'));
      const onDisk = settingsFile() ? readFileSync(settingsFile(), 'utf8') : '';
      check(/"watermarkEnabled":\s*false/.test(onDisk), 'Persisted: settings file holds watermarkEnabled false', files);
    });
    check((await cdp.evaluate(`${LIVE}.length`)) === 0, 'After relaunch: the mark is still off', null);
    await openAppearance(cdp);
    check((await switchState(cdp)) === 'false', 'After relaunch: the switch still reads off', null);
    await shot(cdp, '07-after-relaunch-off.png');

    // Hand-edited settings.json: a missing key and a non-boolean value both fall back to on.
    for (const [name, edit] of [['missing key', (o) => { delete o.watermarkEnabled; }], ['non-boolean value', (o) => { o.watermarkEnabled = 'nope'; }]]) {
      await restart(() => {
        const file = settingsFile() ?? path.join(dataDir, 'settings.json');
        const obj = JSON.parse(readFileSync(file, 'utf8'));
        edit(obj);
        writeFileSync(file, JSON.stringify(obj));
      });
      const markCount = await cdp.evaluate(`${LIVE}.length`);
      await openAppearance(cdp);
      const sw = await switchState(cdp);
      check(sw === 'true' && markCount === 1, `Hand-edited settings.json (${name}): the app starts and falls back to on`, { markCount, switchState: sw });
      if (name === 'missing key') await shot(cdp, '08-hand-edited-missing-key.png');
    }

    // A holiday date: the Settings preview must still show the plain mark, like the session pane (#1256).
    env.dateOverride = '2026-10-31';
    await restart();
    await openAppearance(cdp);
    const holidayPreview = await cdp.evaluate(`({ plain: document.querySelectorAll('.watermark-mark:not(.watermark-mark--live)').length, holiday: document.querySelectorAll('.watermark-mark-holiday').length, live: ${LIVE}.length })`);
    check(holidayPreview.plain === 1 && holidayPreview.holiday === 0, 'Holiday date: the Settings preview is the plain mark, not holiday art', holidayPreview);
    await shot(cdp, '16-settings-holiday-date.png');

    const ghLog = path.join(shimDir, 'gh-calls.log');
    let ghCalls = [];
    try { ghCalls = readFileSync(ghLog, 'utf8').split('\n').filter(Boolean); } catch {}
    console.log(`${LOG}: fake gh answered ${ghCalls.length} call(s)`);
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    console.error(err);
    try { if (session) await session.cdp.screenshot(path.join(SHOTS_DIR, 'crash.png')); } catch {}
    process.exitCode = 1;
  } finally {
    const git = (...args) => spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true }).stdout.trim();
    const out = { gitHead: git('rev-parse', 'HEAD'), dirty: git('status', '--short').length > 0, failures: report.filter((r) => !r.ok).map((r) => r.step), results: report };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(out, null, 2));
    if (session) {
      session.cdp.close();
      await stopLauncher(session.child).catch(() => {});
    }
    for (const dir of [dataDir, importSourceDir, repoDirBase, worktreesRoot, exeDir, launcherDir, shimDir]) await safeRmSync(dir, LOG);
  }
  if (report.some((r) => !r.ok)) process.exitCode = 1;
  console.log(`${LOG}: done; evidence in ${SHOTS_DIR}`);
}

main();
