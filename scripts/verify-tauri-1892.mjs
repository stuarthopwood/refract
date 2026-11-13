#!/usr/bin/env node
// Live CDP check for issue #1892: the Starting agent notice blurs the history behind it (blur, not just a dim), keeps the notice itself sharp,
// clears the blur on transcript focus and once the agent is ready, and shows it without an animated transition under reduced motion.
// Fails on main (the transcript is only `opacity-40`, computed filter `none`); passes with the shared `blur-sm` treatment.
// Reuses the #672 harness: scratch Tauri debug build + fake omp shim (never a real omp), real timers, about two minutes.
// Usage: CARGO_TARGET_DIR=<shared target dir> node scripts/verify-tauri-1892.mjs
// Env: REFRACT_1892_SHOTS_DIR overrides the evidence directory.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { sleep } from './verify-tauri-cdp.mjs';
import { buildLauncher, safeRmSync, requireSharedCargoTarget, gitHead, computeDirty, buildAndCopyExeFresh } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { GROUP, REGION0, OVERLAY, focusLastTabbableOrSelf, quickCreateSessionId, restartAgent, setupLaunch, teardownLaunch, waitForStartProgressKind, clickSessionRow } from './verify-672-start-message-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1892';
const SHOTS_DIR = process.env.REFRACT_1892_SHOTS_DIR || 'C:/Users/shopwood/AppData/Local/Temp/scratch/refract-1892/evidence';
// Long enough to run every assertion below while the notice is up, under the 60s "Keep waiting" prompt stage.
const READY_DELAY_MS = 40_000;
const TURN_SENTINEL = 't1892turn';

const report = [];
function check(ok, label, evidence) {
  report.push({ step: label, ok: ok === true, evidence });
  console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label} ${evidence === undefined ? '' : JSON.stringify(evidence)}`);
  if (ok !== true) process.exitCode = 1;
}

/** Computed paint state of the transcript region, the notice and the notice's own ancestors up to the overlay. */
const READ_STATE = `(() => {
  const region = ${REGION0}, group = ${GROUP}, overlay = ${OVERLAY};
  if (!region) return null;
  const rs = getComputedStyle(region);
  const blur = /blur\\(([\\d.]+)px\\)/.exec(rs.filter);
  const noticeChain = [];
  for (let el = group; el; el = el.parentElement) {
    noticeChain.push(getComputedStyle(el).filter);
    if (el === overlay) break;
  }
  return {
    regionFilter: rs.filter,
    regionBlurPx: blur ? Number(blur[1]) : 0,
    regionOpacity: Number(rs.opacity),
    regionTransitionProperty: rs.transitionProperty,
    regionTransitionDuration: rs.transitionDuration,
    noticeMounted: !!group,
    noticeChainFilters: noticeChain,
    noticeOpacity: group ? Number(getComputedStyle(group).opacity) : null,
    overlayOpacity: overlay ? Number(getComputedStyle(overlay).opacity) : null
  };
})()`;

/** Polls the state until `predicate` holds; the filter transition can leave a single read mid-way. */
async function pollState(cdp, predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.evaluate(READ_STATE);
    if (last && predicate(last)) return { ok: true, state: last };
    await sleep(100);
  }
  return { ok: false, state: last };
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  let launch = null;
  let exeDir, launcherDir, shimDir;
  try {
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1892-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1892-launcher-'));
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1892-shim-'));
    const launcherExe = buildLauncher(launcherDir);
    buildOmpShim(shimDir);
    const built = buildAndCopyExeFresh(exeDir, requireSharedCargoTarget(REPO_ROOT), REPO_ROOT, { label: LOG });
    report.push({ step: 'build identity', ok: true, evidence: { head: gitHead(REPO_ROOT), dirty: computeDirty(REPO_ROOT), exeSha256: built.hash } });

    launch = await setupLaunch(built.dest, launcherExe, 'blur', { REFRACT_FAKE_OMP_READY_DELAY_MS: String(READY_DELAY_MS), REFRACT_FAKE_OMP_DEBUG_LOG: path.join(SHOTS_DIR, 'fake-omp.log') }, shimDir);
    const cdp = launch.cdp;

    // History first: one real turn through the fake-omp tape, so the next start happens over existing messages.
    const session = await quickCreateSessionId(cdp, 'blur/A');
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: READY_DELAY_MS + 60_000, label: 'Session ready for the first turn' });
    await cdp.click(`document.querySelector('[aria-label="Message"]')`);
    await cdp.send('Input.insertText', { text: `Reply with exactly the single word ${TURN_SENTINEL} and nothing else.` });
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`!!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Approve')`, { timeoutMs: 30_000, label: 'tool-call approval card rendered' });
    await cdp.clickByText('Approve');
    await cdp.waitFor(`Array.from(document.querySelectorAll('[aria-label="Transcript"]')).some((r) => /${TURN_SENTINEL}/.test(r.textContent))`, { timeoutMs: 60_000, label: 'first turn settled' });

    // The long ready delay keeps the notice up while every assertion below runs.
    await restartAgent(cdp, session.id);
    await waitForStartProgressKind(cdp, session.id, 'waiting', 10_000);
    await cdp.waitFor(`!!${GROUP}`, { timeoutMs: 10_000, label: 'Starting agent notice mounted over history' });

    const blurred = await pollState(cdp, (s) => s.regionBlurPx > 0);
    check(blurred.ok, '1. While the agent starts over history, the transcript viewport has a blur filter', blurred.state);
    check(blurred.state?.regionOpacity === 1, '2. The history is blurred, not dimmed (viewport opacity stays 1)', { opacity: blurred.state?.regionOpacity });
    check(blurred.state?.noticeChainFilters.every((f) => f === 'none') && blurred.state?.noticeOpacity === 1, '3. The notice and its overlay stay sharp (no filter anywhere from the notice up to the overlay, opacity 1)', { filters: blurred.state?.noticeChainFilters, opacity: blurred.state?.noticeOpacity });
    await cdp.screenshot(path.join(SHOTS_DIR, '01-starting-notice-blurred-history.png'));

    // Reduced motion: the transition property drops to `none`, so the blur appears and clears with no animation.
    const normalMotion = blurred.state;
    check(/filter/.test(normalMotion?.regionTransitionProperty ?? '') && /0\.15s/.test(normalMotion?.regionTransitionDuration ?? ''), '4a. With motion allowed the blur animates (transition-property filter, 150ms)', { property: normalMotion?.regionTransitionProperty, duration: normalMotion?.regionTransitionDuration });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const reduced = await pollState(cdp, (s) => s.regionTransitionProperty === 'none');
    check(reduced.ok && reduced.state.regionBlurPx > 0, '4b. With reduced motion on, the blur stays and its transition is none', { property: reduced.state?.regionTransitionProperty, blurPx: reduced.state?.regionBlurPx });
    await cdp.screenshot(path.join(SHOTS_DIR, '02-reduced-motion-blur.png'));
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });

    // Focusing the transcript clears the blur so the history can be read.
    await focusLastTabbableOrSelf(cdp, REGION0);
    const focused = await pollState(cdp, (s) => s.regionBlurPx === 0);
    check(focused.ok, '5. Focusing the transcript clears the blur (focus-within)', { filter: focused.state?.regionFilter });
    await cdp.screenshot(path.join(SHOTS_DIR, '03-transcript-focused-blur-cleared.png'));
    await cdp.evaluate(`document.activeElement?.blur()`);
    const reblurred = await pollState(cdp, (s) => s.regionBlurPx > 0);
    check(reblurred.ok, '6. Leaving the transcript brings the blur back while the agent is still starting', { filter: reblurred.state?.regionFilter });

    // The start finishes: the notice and the blur go together.
    await cdp.waitFor(`!${GROUP}`, { timeoutMs: READY_DELAY_MS + 30_000, label: 'start reached ready, notice cleared' });
    const cleared = await pollState(cdp, (s) => s.regionBlurPx === 0 && !s.noticeMounted);
    check(cleared.ok, '7. Once the agent is ready the blur clears with the notice', cleared.state);
    await cdp.screenshot(path.join(SHOTS_DIR, '04-ready-blur-cleared.png'));
    await clickSessionRow(cdp, session.id).catch(() => {});
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    console.error(err);
    try { if (launch) await launch.cdp.screenshot(path.join(SHOTS_DIR, '99-crash.png')); } catch {}
    process.exitCode = 1;
  } finally {
    await teardownLaunch(launch);
    for (const dir of [exeDir, launcherDir, shimDir]) if (dir) await safeRmSync(dir);
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`${LOG}: ${report.every((r) => r.ok) ? 'ALL PASS' : 'FAILURES'}; evidence in ${SHOTS_DIR}`);
  }
}

main();
