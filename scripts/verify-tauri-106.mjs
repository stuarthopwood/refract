#!/usr/bin/env node
// Live CDP check for spec 106 (issue #1470): overflow labels, 24 px session strip, resting surface token, AttachmentStrip Remove offset, five presets.
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_106_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-106.mjs

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_106_SHOTS_DIR || mkdtempSync(path.join(tmpdir(), 'refract-106-shots-'));
mkdirSync(SHOTS_DIR, { recursive: true });

const THEMES = ['theme-dark', 'theme-obsidian', 'theme-dark-high-contrast', 'theme-nordic-frost', 'theme-cyber-amber'];
const REPORT = [];
const SHOTS = [];
const STEPS = [];
const SKIPPED = ['Disabled input fill and the other token swaps: class-level changes, covered by check:alpha-modifiers and the 077 token resolution check'];
const log = (line) => {
  console.log(line);
  REPORT.push(line);
};
function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
  STEPS.push(message);
  log(`PASS: ${message}`);
}
const shot = async (cdp, name) => {
  await cdp.screenshot(path.join(SHOTS_DIR, name));
  SHOTS.push(name);
};

const FILL = (v) => `(() => { const d = document.createElement('div'); d.style.background = 'var(${v})'; document.body.appendChild(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; })()`;

async function checkLabels(cdp, repoName) {
  const labels = await cdp.evaluate(`Array.from(document.querySelectorAll('button[aria-label]')).map((b) => b.getAttribute('aria-label')).filter((l) => /actions/i.test(l))`);
  log(`action labels: ${JSON.stringify(labels)}`);
  assert(labels.includes(`More actions for ${repoName}`), 'repository header trigger reads "More actions for <project>"');
  assert(!labels.some((l) => /^Project actions for|^(?!More actions).+ actions$|^More actions, /.test(l)), 'no legacy overflow label wording remains');
}

async function checkStrip(cdp) {
  const strip = await cdp.evaluate(`(() => { const b = Array.from(document.querySelectorAll('[data-session-open]')).map((o) => o.parentElement).find(Boolean); const s = b && Array.from(b.querySelectorAll('button')).find((x) => /^More actions for /.test(x.getAttribute('aria-label') || ''))?.parentElement; return s ? { h: s.getBoundingClientRect().height, btn: s.querySelector('button').getBoundingClientRect().height } : null; })()`);
  assert(strip && Math.round(strip.h) === 24 && Math.round(strip.btn) === 24, `session row action strip is 24 px (${JSON.stringify(strip)})`);
}

async function checkAttachment(cdp) {
  await cdp.evaluate(`(async () => {
    const c = document.createElement('canvas'); c.width = 40; c.height = 40;
    const x = c.getContext('2d'); x.fillStyle = '#c33'; x.fillRect(0, 0, 40, 40);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const ta = document.querySelector('textarea[aria-label="Message"]'); ta.focus();
    for (let i = 0; i < 2; i += 1) {
      const dt = new DataTransfer(); dt.items.add(new File([blob], 'p' + i + '.png', { type: 'image/png' }));
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 800));
    }
  })()`);
  await cdp.waitFor(`document.querySelectorAll('button[aria-label^="Remove image"]').length >= 2`, { timeoutMs: 15_000, label: 'two pending images' });
  const geo = await cdp.evaluate(`(() => { const [a, b] = Array.from(document.querySelectorAll('button[aria-label^="Remove image"]')); const ra = a.getBoundingClientRect(); const rb = b.getBoundingClientRect(); const ta = a.parentElement.getBoundingClientRect(); const tb = b.parentElement.getBoundingClientRect(); const ov = (r, t) => Math.max(0, Math.min(r.right, t.right) - Math.max(r.left, t.left)) * Math.max(0, Math.min(r.bottom, t.bottom) - Math.max(r.top, t.top)); return { ownCover: ov(ra, ta) / (ta.width * ta.height), crossA: ov(ra, tb), crossB: ov(rb, ta), size: ra.width }; })()`);
  await shot(cdp, '03-attachments.png');
  assert(geo.crossA === 0 && geo.crossB === 0, `Remove button does not overlap the neighbouring thumbnail (${JSON.stringify(geo)})`);
  assert(geo.ownCover < 0.2, `Remove button covers under 20% of its own thumbnail (${geo.ownCover.toFixed(2)})`);
}

async function checkThemes(cdp) {
  for (const cls of THEMES) {
    await cdp.evaluate(`(() => { const r = document.documentElement; Array.from(r.classList).filter((c) => c.startsWith('theme-')).forEach((c) => r.classList.remove(c)); r.classList.add(${JSON.stringify(cls)}); })()`);
    const [a, b] = await cdp.evaluate(`[${FILL('--surface-subtle')}, ${FILL('--row-hover-bg')}]`);
    assert(a === b && a !== 'rgba(0, 0, 0, 0)', `${cls}: --surface-subtle paints the row-hover fill (${a})`);
    await shot(cdp, `theme-${cls.replace('theme-', '')}.png`);
  }
}

async function main() {
  const head = gitHead(REPO_ROOT);
  log(`verify-tauri-106: head ${head}, shots ${SHOTS_DIR}`);
  const dirs = [];
  const tmp = (name) => {
    const dir = mkdtempSync(path.join(tmpdir(), `refract-106-${name}-`));
    dirs.push(dir);
    return dir;
  };
  let ok = false;
  let child;
  let cdp;
  try {
    const shimDir = tmp('shim');
    const launcherExe = buildLauncher(tmp('launcher'));
    buildOmpShim(shimDir);
    const built = buildAndCopyExeFresh(tmp('exe'), BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-106' });
    const repoDir = makeScratchRepo(path.join(tmp('repo'), 'hello-106'), 'verify-106');
    const repoName = path.basename(repoDir);
    const port = await getFreePort();
    const launched = await launchBuiltExeWithEnv(launcherExe, built.dest, {
      port,
      dataDir: tmp('data'),
      importSourceDir: tmp('import'),
      pathPrepend: shimDir,
      logFile: path.join(SHOTS_DIR, 'app.log'),
      extraEnv: { REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'), REFRACT_FAKE_OMP_NODE: process.execPath }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the launched process');
    log(`app pid ${launched.targetPid}, port ${port}`);
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
    await addRepository(cdp, repoDir);
    await createSessionViaQuickCreate(cdp, repoName);
    await shot(cdp, '01-session.png');
    await checkLabels(cdp, repoName);
    await checkStrip(cdp);
    await shot(cdp, '02-strip.png');
    await checkAttachment(cdp);
    await checkThemes(cdp);
    log(`verify-tauri-106: ALL STEPS PASS (${STEPS.length}) at head ${head}`);
    ok = true;
  } catch (err) {
    if (cdp) await shot(cdp, 'fail.png').catch(() => {});
    throw err;
  } finally {
    cdp?.close();
    if (child) await stopLauncher(child).catch(() => {});
    writeFileSync(path.join(SHOTS_DIR, 'report.txt'), REPORT.join('\n'));
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, ok, steps: STEPS, skipped: SKIPPED, screenshots: SHOTS }, null, 2));
    for (const dir of dirs) await safeRmSync(dir);
  }
}

main().catch((err) => {
  console.error('verify-tauri-106: FAIL');
  console.error(err);
  process.exitCode = 1;
});
