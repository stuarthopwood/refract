#!/usr/bin/env node
// Live CDP check for #1612 (fixed row-action gutter) against the fake `omp` shim and the `row-gutter-1612` tape.
// Proves every expandable row shares one chevron x, the hover surface spans the whole row (kebab and chain
// action included), the kebab is hidden at rest and revealed on hover without moving the chevron, and the
// reserved gutter is not focusable. Screenshots: default, hovered tool row, failed row, hovered chain, hovered kebab.
// Usage: CARGO_TARGET_DIR=<shared target dir> SHOTS_DIR=<evidence dir> node scripts/verify-tauri-1612.mjs

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget, gitHead, computeDirty, sha256OfFile } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-tauri-1612';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
// Default evidence dir lives under the OS temp dir, never a repo or user-profile path.
const SHOTS_DIR = process.env.SHOTS_DIR || path.join(tmpdir(), 'verify-1612-shots');
const CHEVRON_TOLERANCE_PX = 1;
const WIDTH_TOLERANCE_PX = 0.5;

const report = [];
function check(ok, label, evidence) {
  report.push({ step: label, ok: ok === true, evidence });
  console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label} ${evidence === undefined ? '' : JSON.stringify(evidence)}`);
}
const shot = async (cdp, name) => {
  await sleep(300);
  await cdp.screenshot(path.join(SHOTS_DIR, name));
};
const isClear = (v) => !v || v === 'transparent' || /,\s*0(\.0+)?\s*\)$/.test(v) || /\/\s*0(\.0+)?%?\s*\)$/.test(v);
const mouseTo = (cdp, x, y) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
const tab = async (cdp) => {
  for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
};

// Every disclosure row in the transcript: the trigger sits in a `group/line` header wrapper inside the row root.
const TRIGGERS = `(() => {
  const t = document.querySelector('[aria-label="Transcript"]');
  return t ? Array.from(t.querySelectorAll('button[aria-expanded]')).filter((b) => b.offsetParent !== null && b.parentElement && b.parentElement.classList.contains('group/line')) : [];
})()`;

// Scrolls row `idx` into view and reports its geometry and paint. Opacity is the product up the tree so a wrapper cannot hide a fade.
const rowState = (idx, scroll) => `(() => {
  const trig = ${TRIGGERS}[${idx}];
  if (!trig) return null;
  const wrapper = trig.parentElement;
  const root = wrapper.parentElement;
  if (${scroll}) root.scrollIntoView({ block: 'center' });
  const rect = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; };
  const opacityOf = (el) => { let o = 1; for (let e = el; e && e !== root; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity); return o; };
  const kids = Array.from(trig.children);
  const spacer = kids[kids.length - 1];
  const chevron = kids[kids.length - 2].querySelector('svg');
  const kebab = root.querySelector('button[aria-label^="More actions"]');
  const panel = root.querySelector('button[aria-label="Show subagents panel"]');
  const action = kebab || panel;
  const labelEl = trig.querySelector('[data-slot="collapsed-line-label"]');
  const focusable = 'a[href],button,input,textarea,select,[tabindex]';
  return {
    label: (labelEl ? labelEl.textContent : trig.textContent).trim().slice(0, 40),
    actionKind: kebab ? 'kebab' : panel ? 'chain-panel' : null,
    failed: !!trig.querySelector('[class*="text-tool-row-error-fg"]'),
    rootW: root.getBoundingClientRect().width,
    wrapperW: wrapper.getBoundingClientRect().width,
    triggerW: trig.getBoundingClientRect().width,
    chevronX: chevron ? rect(chevron).cx : null,
    spacer: { ariaHidden: spacer.getAttribute('aria-hidden'), tabindex: spacer.getAttribute('tabindex'), focusableInside: spacer.matches(focusable) || !!spacer.querySelector(focusable), w: spacer.getBoundingClientRect().width },
    actionOpacity: action ? opacityOf(action) : null,
    triggerBg: getComputedStyle(trig).backgroundColor,
    hovered: trig.matches(':hover') || wrapper.matches(':hover'),
    trig: rect(trig),
    act: action ? rect(action) : null
  };
})()`;

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
      REFRACT_FAKE_OMP_SCENARIO: 'row-gutter-1612'
    }
  });
  const cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
  if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target not owned by launched pid');
  console.log(`${LOG}: launched exe pid ${launched.targetPid} on port ${port}`);
  return { cdp, child: launched.child };
}

async function openSessionAndSend(cdp, repoDir) {
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness' });
  await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
  await cdp.click(`document.querySelector('[data-readiness-primary]')`);
  await cdp.clickByText('Local folder…', { tag: '[role="menuitem"]' });
  await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add project dialog' });
  await cdp.click(`document.querySelector('[role="dialog"] input')`);
  await cdp.send('Input.insertText', { text: repoDir });
  await cdp.clickByText('Add project', { inDialog: true });
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`, { timeoutMs: 30_000, label: 'Repo added' });
  await cdp.clickByLabel('New session from a branch in ', { prefix: true });
  await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, { timeoutMs: 15_000, label: 'New session dialog' });
  await cdp.clickByText('Create session', { inDialog: true });
  await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 90_000, label: 'dialog closed' });
  await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'composer enabled' });
  await sleep(3000);
  await cdp.click(`document.querySelector('[aria-label="Message"]')`);
  await cdp.send('Input.insertText', { text: 'show the row gutter' });
  await cdp.clickByLabel('Send message');
  await cdp.waitFor(`Array.from(document.querySelectorAll('[data-slot="message"]')).some((m) => m.textContent.includes('FINAL-REPLY-1612'))`, { timeoutMs: 60_000, label: 'Final reply' });
  await sleep(1000);
}

// Idle, then hovered over the row body, then (when the row has an action) hovered over the action itself.
async function measureRow(cdp, idx) {
  await cdp.evaluate(rowState(idx, true));
  await sleep(200);
  await mouseTo(cdp, 1, 1);
  await sleep(450);
  const idle = await cdp.evaluate(rowState(idx, false));
  await mouseTo(cdp, idle.trig.l + idle.trig.w / 2, idle.trig.cy);
  await sleep(500);
  const hover = await cdp.evaluate(rowState(idx, false));
  let onAction = null;
  if (hover.act) {
    await mouseTo(cdp, hover.act.cx, hover.act.cy);
    await sleep(500);
    onAction = await cdp.evaluate(rowState(idx, false));
  }
  return { idle, hover, onAction };
}

// Focuses the row trigger and presses Tab: focus must leave the trigger without landing in the gutter spacer.
async function tabFrom(cdp, idx) {
  await mouseTo(cdp, 1, 1);
  return cdp.evaluate(`(() => {
    const trig = ${TRIGGERS}[${idx}];
    trig.focus();
    return true;
  })()`).then(async () => {
    await tab(cdp);
    await sleep(200);
    return cdp.evaluate(`(() => {
      const trig = ${TRIGGERS}[${idx}];
      const spacer = trig.lastElementChild;
      const a = document.activeElement;
      const root = trig.parentElement.parentElement;
      const kebab = root.querySelector('button[aria-label^="More actions"], button[aria-label="Show subagents panel"]');
      return { leftTrigger: a !== trig, inSpacer: !!a && (a === spacer || spacer.contains(a)), onAction: !!kebab && a === kebab, aria: a ? (a.getAttribute('aria-label') || a.tagName) : null };
    })()`);
  });
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1612-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1612-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1612-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1612-gutter');
  const worktreesRoot = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1612-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1612-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1612-shim-'));
  const exe = path.join(exeDir, 'refract-tauri.exe');
  let session;
  try {
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    copyFileSync(path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe'), exe);
    session = await launch({ launcherExe, exe, dataDir, shimDir, importSourceDir });
    const { cdp } = session;
    await openSessionAndSend(cdp, repoDir);

    await mouseTo(cdp, 1, 1);
    const count = await cdp.evaluate(`${TRIGGERS}.length`);
    const idleAll = [];
    for (let i = 0; i < count; i++) idleAll.push(await cdp.evaluate(rowState(i, false)));
    console.log(`${LOG}: rows: ${JSON.stringify(idleAll.map((r) => `${r.label}${r.actionKind ? ` [${r.actionKind}]` : ''}${r.failed ? ' (failed)' : ''}`))}`);
    const labels = idleAll.map((r) => r.label);
    check(labels.some((l) => /^Thought/.test(l)) && labels.includes('Note') && labels.includes('Asked user'), 'Fixture rendered a thought, a note and an asked-user row', labels);
    check(idleAll.filter((r) => r.actionKind === 'kebab').length >= 2 && idleAll.some((r) => r.failed), 'Fixture rendered kebab tool rows including a failed one', labels);
    const chainPresent = idleAll.some((r) => r.actionKind === 'chain-panel');
    console.log(`${LOG}: subagent chain row present: ${chainPresent}`);

    const xs = idleAll.map((r) => r.chevronX);
    const spread = Math.max(...xs) - Math.min(...xs);
    check(xs.every((x) => x !== null) && spread <= CHEVRON_TOLERANCE_PX, `All ${count} expandable rows share one chevron x (within ${CHEVRON_TOLERANCE_PX}px)`, { spread, xs: idleAll.map((r) => [r.label, Math.round(r.chevronX * 10) / 10]) });
    const widthOff = idleAll.filter((r) => Math.abs(r.triggerW - r.rootW) > WIDTH_TOLERANCE_PX || Math.abs(r.wrapperW - r.rootW) > WIDTH_TOLERANCE_PX);
    check(widthOff.length === 0, 'Trigger and hover wrapper width equal the row width in every row', widthOff.map((r) => ({ label: r.label, trigger: r.triggerW, wrapper: r.wrapperW, root: r.rootW })));
    const spacerBad = idleAll.filter((r) => r.spacer.ariaHidden !== 'true' || r.spacer.tabindex !== null || r.spacer.focusableInside || r.spacer.w < 1);
    check(spacerBad.length === 0, 'Gutter spacer is aria-hidden, has no tabindex, holds nothing focusable and reserves width', spacerBad.map((r) => ({ label: r.label, spacer: r.spacer })));
    await shot(cdp, '01-default.png');

    let shotTool = false;
    let shotFailed = false;
    let shotChain = false;
    for (let i = 0; i < count; i++) {
      const { idle, hover, onAction } = await measureRow(cdp, i);
      const name = idle.label;
      check(hover.hovered && !isClear(hover.triggerBg) && hover.triggerBg !== idle.triggerBg, `${name}: hover paints a fill on the row trigger`, { idle: idle.triggerBg, hover: hover.triggerBg, failed: idle.failed });
      check(Math.abs(hover.chevronX - idle.chevronX) <= 0.5, `${name}: chevron x unchanged on hover`, { idle: idle.chevronX, hover: hover.chevronX });
      check(Math.abs(hover.wrapperW - hover.rootW) <= WIDTH_TOLERANCE_PX && Math.abs(hover.triggerW - hover.rootW) <= WIDTH_TOLERANCE_PX, `${name}: hover surface spans the full row width`, { trigger: hover.triggerW, wrapper: hover.wrapperW, root: hover.rootW });
      if (idle.actionKind === 'kebab') {
        check(idle.actionOpacity === 0, `${name}: kebab is invisible at rest`, idle.actionOpacity);
        check(hover.actionOpacity === 1, `${name}: kebab is fully visible on row hover`, hover.actionOpacity);
      }
      if (onAction) {
        check(onAction.actionOpacity === 1 && !isClear(onAction.triggerBg) && Math.abs(onAction.chevronX - idle.chevronX) <= 0.5, `${name}: hovering the ${idle.actionKind} keeps the row fill, action visible and chevron still`, { opacity: onAction.actionOpacity, bg: onAction.triggerBg, chevronX: onAction.chevronX });
      }
      if (idle.actionKind === 'kebab' && !idle.failed && !shotTool) {
        shotTool = true;
        await mouseTo(cdp, hover.trig.l + hover.trig.w / 2, hover.trig.cy);
        await shot(cdp, '02-hover-tool-row.png');
        await mouseTo(cdp, onAction.act.cx, onAction.act.cy);
        await shot(cdp, '03-hover-kebab.png');
      }
      if (idle.failed && !shotFailed) {
        shotFailed = true;
        await mouseTo(cdp, hover.trig.l + hover.trig.w / 2, hover.trig.cy);
        await shot(cdp, '04-hover-failed-row.png');
      }
      if (idle.actionKind === 'chain-panel' && !shotChain) {
        shotChain = true;
        await mouseTo(cdp, hover.trig.l + hover.trig.w / 2, hover.trig.cy);
        await shot(cdp, '05-hover-subagent-chain.png');
      }
    }
    check(shotTool && shotFailed, 'Captured hovered tool row, kebab and failed row screenshots', { shotTool, shotFailed, shotChain });

    // Tab order: the gutter never takes focus; from an action row the next stop is its action, otherwise focus moves on.
    for (let i = 0; i < count; i++) {
      const t = await tabFrom(cdp, i);
      const hasAction = idleAll[i].actionKind !== null;
      check(t.leftTrigger && !t.inSpacer && (!hasAction || t.onAction), `${idleAll[i].label}: Tab from the row skips the gutter${hasAction ? ' and lands on its action' : ''}`, t);
    }
    await cdp.evaluate(`document.activeElement && document.activeElement.blur()`);
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    console.error(err);
    try { if (session) await session.cdp.screenshot(path.join(SHOTS_DIR, 'crash.png')); } catch {}
    process.exitCode = 1;
  } finally {
    const meta = { gitHead: gitHead(REPO_ROOT), dirty: computeDirty(REPO_ROOT), exeSha256: (() => { try { return sha256OfFile(path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe')); } catch (e) { return `unavailable: ${e}`; } })() };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ ...meta, steps: report }, null, 2));
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
