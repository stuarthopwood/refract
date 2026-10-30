// Secondary launch scenarios for verify-1048-holiday-touches.mjs. Each is a fresh launch that
// appends to the caller's shared `report` array.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { buildLauncher, makeScratchRepo, buildAndCopyExeFresh, citeScreenshots, safeRmSync } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { settleForScreenshot } from './verify-1048-holiday-touches-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG = 'verify-1048';


/** Off-season baseline: with a repository added the real chat pane mounts, so the absence check
 * cannot pass trivially on the Readiness screen, which never mounts it. */
export async function runOffSeasonBaseline(ctx) {
  const { repoRoot, buildOutputDir, shotsDir, dateOverride, hallowenIconClass, emptyLine, report } = ctx;
  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1048-baseline-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1048-baseline-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1048-baseline-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1048-holiday-touches-baseline');
  const worktreesRootForCleanup = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1048-baseline-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1048-baseline-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1048-baseline-shim-'));
  let child;
  let cdp;
  try {
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const exeInfo = buildAndCopyExeFresh(exeDir, buildOutputDir, repoRoot, { label: `${LOG}-baseline` });
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exeInfo.dest, {
      port,
      dataDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(exeDir, 'fake-omp-invocations.log'),
        REFRACT_FAKE_OMP_SCENARIO: 'session',
        REFRACT_DATE_OVERRIDE: dateOverride
      }
    });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) {
      throw new Error(`${LOG}: baseline CDP target on port ${port} is not owned by the process this run launched`);
    }
    const overridesResult = await cdp.evaluate(`window.refract.debug.getOverrides()`);
    const overridesMatch = overridesResult.ok === true && overridesResult.value.date === dateOverride;
    report.push({ step: 'Off-season override baseline: debug.getOverrides() reports the REFRACT_DATE_OVERRIDE env var verbatim', ok: overridesMatch, actual: overridesResult });
    if (!overridesMatch) throw new Error(`FAIL: off-season baseline debug.getOverrides() mismatch: ${JSON.stringify(overridesResult)}`);
    console.log(`${LOG}: PASS off-season override baseline: debug.getOverrides() reports the REFRACT_DATE_OVERRIDE env var verbatim`);

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'off-season baseline: Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'off-season baseline: Readiness green (fake omp)' }
    );
    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'off-season baseline: Add repository dialog open' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add repository', { inDialog: true });
    await cdp.waitFor(
      `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
      { timeoutMs: 30_000, label: 'off-season baseline: scratch repository added' }
    );
    await cdp.waitFor(`!!document.querySelector('[data-chat-empty-state]')`, { timeoutMs: 15_000, label: 'off-season baseline: real empty chat pane mounted' });

    const noHoliday = await cdp.evaluate(`(() => {
      const watermark = document.querySelector('.watermark-mark-holiday');
      const sidebarAccessory = document.querySelector('.drag-region svg.${hallowenIconClass}');
      const ambientLoop = document.querySelector('.holiday-ambient-loop');
      const emptyPaneText = document.querySelector('[data-chat-empty-state]')?.textContent ?? '';
      return {
        watermarkPresent: !!watermark,
        sidebarAccessoryPresent: !!sidebarAccessory,
        ambientLoopPresent: !!ambientLoop,
        emptyPaneHasHolidayLine: emptyPaneText.includes('${emptyLine}')
      };
    })()`);
    const ok = !noHoliday.watermarkPresent && !noHoliday.sidebarAccessoryPresent && !noHoliday.ambientLoopPresent && !noHoliday.emptyPaneHasHolidayLine;
    report.push({ step: 'Off-season override baseline (outside every window): nothing holiday-related renders anywhere, including the real empty chat pane', ok, actual: noHoliday });
    if (!ok) throw new Error(`FAIL: off-season baseline still shows holiday content: ${JSON.stringify(noHoliday)}`);
    console.log(`${LOG}: PASS off-season override baseline: nothing holiday-related renders anywhere`);
    await settleForScreenshot(cdp);
    await cdp.screenshot(path.join(shotsDir, 'baseline-off-season.png'));
    report.push({ step: 'off-season override baseline screenshot', ok: true, screenshots: citeScreenshots(shotsDir, ['baseline-off-season.png']) });
  } catch (err) {
    report.push({ step: 'off-season override baseline crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    throw err;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    await safeRmSync(dataDir, LOG);
    await safeRmSync(importSourceDir, LOG);
    await safeRmSync(repoDirBase, LOG);
    await safeRmSync(worktreesRootForCleanup, LOG);
    await safeRmSync(exeDir, LOG);
    await safeRmSync(launcherDir, LOG);
    await safeRmSync(shimDir, LOG);
  }
}

/** Proves live that an invalid date override (2026-02-30) resolves to null, via the app's own
 * `debug_get_overrides` path, which answers before Readiness resolves. */
export async function runInvalidDateOverrideCheck(ctx) {
  const { repoRoot, buildOutputDir, report } = ctx;
  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1048-invaliddate-data-'));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1048-invaliddate-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1048-invaliddate-launcher-'));
  let child;
  let cdp;
  try {
    const launcherExe = buildLauncher(launcherDir);
    const exeInfo = buildAndCopyExeFresh(exeDir, buildOutputDir, repoRoot, { label: `${LOG}-invaliddate` });
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exeInfo.dest, { port, dataDir, logFile: path.join(exeDir, 'app.log'), extraEnv: { REFRACT_DATE_OVERRIDE: '2026-02-30' } });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) {
      throw new Error(`${LOG}: invalid-date CDP target on port ${port} is not owned by the process this run launched`);
    }
    await cdp.waitFor(`!!(window.refract && window.refract.debug)`, { timeoutMs: 30_000, label: 'invalid-date check: window.refract.debug available' });
    const overridesResult = await cdp.evaluate(`window.refract.debug.getOverrides()`);
    const ok = overridesResult.ok === true && overridesResult.value.date === null;
    report.push({ step: 'REFRACT_DATE_OVERRIDE=2026-02-30 (not a real calendar day) resolves to null, not silently rolled forward', ok, actual: overridesResult });
    if (!ok) throw new Error(`FAIL: invalid date override was not rejected: ${JSON.stringify(overridesResult)}`);
    console.log(`${LOG}: PASS REFRACT_DATE_OVERRIDE=2026-02-30 resolves to null (rejected, not rolled forward)`);
  } catch (err) {
    report.push({ step: 'invalid-date override check crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    throw err;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    await safeRmSync(dataDir, LOG);
    await safeRmSync(exeDir, LOG);
    await safeRmSync(launcherDir, LOG);
  }
}
