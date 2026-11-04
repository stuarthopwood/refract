#!/usr/bin/env node
// Live CDP check for #1583 (tool row targets as inline-code chips) against the fake `omp` shim
// and the `tool-chips-1583` tape. Proves chip fill/shape, muted chip text, wrapped-target
// alignment, and icon/prose left-edge alignment; screenshots in several themes.
// Usage: CARGO_TARGET_DIR=<shared target dir> node scripts/verify-1583-tool-chips.mjs

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget, switchTheme } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1583';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1583_SHOTS_DIR || path.join(tmpdir(), 'refract-1583-shots');
const THEMES = [
  ['dark', 'Dark'],
  ['obsidian', 'Obsidian'],
  ['dark-high-contrast', 'Dark (high contrast)']
];

const report = [];
function check(ok, label, evidence) {
  report.push({ step: label, ok: ok === true, evidence });
  console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label} ${evidence === undefined ? '' : JSON.stringify(evidence)}`);
}
const shot = async (cdp, name) => {
  await sleep(400);
  await cdp.screenshot(path.join(SHOTS_DIR, name));
};

const CHIPS = `(() => {
  const probe = (cls, prop) => { const el = document.createElement('span'); el.className = cls; document.body.appendChild(el); const v = getComputedStyle(el)[prop]; el.remove(); return v; };
  const style = (el) => { const s = getComputedStyle(el); return { bg: s.backgroundColor, color: s.color, font: s.fontFamily, size: s.fontSize, ratio: (parseFloat(s.fontSize) / parseFloat(getComputedStyle(el.parentElement).fontSize)).toFixed(2), radius: s.borderTopLeftRadius, padL: s.paddingLeft, padR: s.paddingRight }; };
  const chips = Array.from(document.querySelectorAll('[data-slot="tool-target"]')).filter((el) => el.offsetParent !== null);
  const prose = Array.from(document.querySelectorAll('[data-slot="message"] [data-slot="inline-code"]')).pop();
  return {
    fill: probe('bg-md-code-bg', 'backgroundColor'),
    muted: probe('text-tool-row-fg', 'color'),
    chips: chips.map((el) => ({ text: el.textContent.slice(0, 40), ...style(el), display: getComputedStyle(el).display })),
    prose: prose ? { text: prose.textContent, ...style(prose) } : null
  };
})()`;
const ICON_VS_PROSE = `(() => {
  const icon = Array.from(document.querySelectorAll('[data-slot="message-scroller-item"] button[aria-expanded] svg')).find((el) => el.getBoundingClientRect().width > 0);
  const para = Array.from(document.querySelectorAll('[data-slot="message"] p')).pop();
  return { iconLeft: icon ? icon.getBoundingClientRect().left : null, proseLeft: para ? para.getBoundingClientRect().left : null };
})()`;
const WRAPPED_ROW = () => `(() => {
  const btn = Array.from(document.querySelectorAll('button[aria-expanded]')).find((b) => b.textContent.includes('vitest'));
  if (!btn) return null;
  const chip = btn.querySelector('[data-slot="tool-target"]');
  const label = btn.querySelector('[data-slot="collapsed-line-label"]');
  const rects = Array.from(chip.getClientRects());
  return { expanded: btn.getAttribute('aria-expanded'), lines: rects.length, labelLeft: label ? label.getBoundingClientRect().left : null, chipLefts: rects.map((r) => Math.round(r.left)), rowRight: Math.round(btn.getBoundingClientRect().right), chipRights: rects.map((r) => Math.round(r.right)) };
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
      REFRACT_FAKE_OMP_SCENARIO: 'tool-chips-1583'
    }
  });
  const cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
  if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target not owned by launched pid');
  console.log(`${LOG}: launched exe pid ${launched.targetPid} on port ${port}`);
  return { cdp, child: launched.child };
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1583-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1583-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1583-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1583-chips');
  const worktreesRoot = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1583-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1583-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1583-shim-'));
  const exe = path.join(exeDir, 'refract-tauri.exe');
  let session;
  try {
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    copyFileSync(path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe'), exe);
    session = await launch({ launcherExe, exe, dataDir, shimDir, importSourceDir });
    const { cdp } = session;

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
    await cdp.send('Input.insertText', { text: 'show the tool rows' });
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`Array.from(document.querySelectorAll('[data-slot="message"]')).some((m) => m.textContent.includes('FINAL-REPLY-1583'))`, { timeoutMs: 60_000, label: 'Final reply' });
    await sleep(1000);

    const c = await cdp.evaluate(CHIPS);
    check(c.chips.length >= 4, 'Tool targets render as chips (read, bash, grep, group failing command)', c.chips.map((x) => x.text));
    check(c.chips.every((x) => x.bg === c.fill), 'Every chip uses the Markdown inline-code fill (--md-code-bg)', { fill: c.fill, bgs: [...new Set(c.chips.map((x) => x.bg))] });
    check(c.chips.every((x) => x.color === c.muted), 'Every chip text is the muted tool-row colour', { muted: c.muted, colours: [...new Set(c.chips.map((x) => x.color))] });
    const shapeOf = (x) => ({ font: x.font, ratio: x.ratio, radius: x.radius, padL: x.padL, padR: x.padR });
    const shapeMismatch = c.chips.filter((x) => JSON.stringify(shapeOf(x)) !== JSON.stringify(shapeOf(c.prose)));
    check(c.prose !== null && shapeMismatch.length === 0, 'Chip font, size, radius and padding match the prose inline-code chip', { prose: shapeOf(c.prose ?? {}), mismatched: shapeMismatch });
    const align = await cdp.evaluate(ICON_VS_PROSE);
    check(align.iconLeft !== null && align.proseLeft !== null && Math.abs(align.iconLeft - align.proseLeft) <= 1, 'Tool row icon lines up with the prose left edge', align);

    await shot(cdp, '10-collapsed-dark.png');
    await cdp.click(`Array.from(document.querySelectorAll('button[aria-expanded]')).find((b) => b.textContent.includes('vitest'))`);
    await sleep(500);
    const wrapped = await cdp.evaluate(WRAPPED_ROW());
    check(wrapped && wrapped.expanded === 'true' && wrapped.lines > 1, 'Expanded long command wraps across several chip lines', wrapped);
    check(wrapped && wrapped.chipLefts.slice(1).every((l) => Math.abs(l - wrapped.labelLeft) <= 2), 'Wrapped lines restart under the label, not in a narrow column', wrapped);
    await shot(cdp, '11-expanded-wrap-dark.png');
    await cdp.click(`Array.from(document.querySelectorAll('button[aria-expanded]')).find((b) => b.textContent.includes('vitest'))`);
    await sleep(300);

    for (const [id, name] of THEMES) {
      await switchTheme(cdp, id, name);
      await sleep(600);
      const t = await cdp.evaluate(CHIPS);
      check(t.chips.length >= 4 && t.chips.every((x) => x.bg === t.fill && x.color === t.muted), `${name}: chips keep the inline-code fill and muted colour`, { fill: t.fill, muted: t.muted });
      await shot(cdp, `20-theme-${id}.png`);
    }
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    console.error(err);
    try { if (session) await session.cdp.screenshot(path.join(SHOTS_DIR, 'crash.png')); } catch {}
    process.exitCode = 1;
  } finally {
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
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
