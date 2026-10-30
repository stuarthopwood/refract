#!/usr/bin/env node
// Probes display scaling (125%/150%) and streaming for #802 against the pre-fix `h-full` code
// (run on probe/802-h-full-revert). One-off investigation: it records findings, never gates.
// Scaling uses --force-device-scale-factor via WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS for real
// renderer layout rounding, unlike a DevTools-only override.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, copyFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, getProcessExecutablePath } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  buildAndCopyExeFresh,
  safeRmSync,
  requireSharedCargoTarget,
  clearKnownOutputFiles,
  switchTheme
} from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR =
  process.env.REFRACT_802_SCALE_STREAM_SHOTS_DIR ||
  path.join(tmpdir(), `refract-802-scale-stream-shots-${new Date().toISOString().replace(/[:.]/g, '-')}`);

const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' }
];
const WIDTHS = [
  { px: 240, label: 'Min' },
  { px: 520, label: 'Max' }
];
const SCALES = [1.25, 1.5];

const QUESTION = 'Give me a long answer with a bulleted list, a wide table, and a long code block.';
const LAST_LINE_MARKER = 'ISSUE802-LAST-LINE-MARKER';
const RIGHT_PANE_SELECTOR = '#right-pane-active-panel';

// Same probe expression as verify-802-side-chat-scrollbars.mjs so numbers are comparable.
const SCROLL_PROBE_EXPR = `(() => {
  const anchor = document.querySelector(${JSON.stringify(RIGHT_PANE_SELECTOR)});
  if (!anchor) return null;
  const panel = anchor.closest('[data-panel]') ?? anchor;
  const subtree = [panel, ...panel.querySelectorAll('*')];
  const ancestors = [];
  for (let el = panel.parentElement; el; el = el.parentElement) {
    ancestors.push(el);
    if (el === document.body) break;
  }
  const scopedCandidates = [...subtree, ...ancestors];
  const pageCandidates = Array.from(document.querySelectorAll('*'));
  const describe = (el) => {
    const style = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName,
      className: el.className || null,
      id: el.id || null,
      dataAttrs: Object.fromEntries(Array.from(el.attributes).filter((a) => a.name.startsWith('data-')).map((a) => [a.name, a.value])),
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      rect: { top: r.top, left: r.left, width: r.width, height: r.height },
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      offsetWidth: el.offsetWidth,
      clientWidth: el.clientWidth
    };
  };
  const hasRenderedVerticalScrollbar = (el) => (el.offsetWidth - el.clientWidth) > 0 && el.scrollHeight > el.clientHeight;
  const scopedScrollers = scopedCandidates.filter(hasRenderedVerticalScrollbar).map(describe);
  const pageWideScrollers = pageCandidates.filter(hasRenderedVerticalScrollbar).map(describe);
  const horizontalOverflow = scopedCandidates.filter((el) => el.scrollWidth > el.clientWidth && !el.closest('.sr-only')).map(describe);
  return { scopedScrollers, pageWideScrollers, horizontalOverflow, devicePixelRatio: window.devicePixelRatio };
})()`;

async function measureScrollContainers(cdp) {
  const result = await cdp.evaluate(SCROLL_PROBE_EXPR);
  if (!result) throw new Error('verify-802-scale-stream: right pane not found when measuring scroll containers');
  return result;
}

async function resizePane(cdp, widthPx, label) {
  const finder = `Array.from(document.querySelectorAll('[aria-label="Pane width"] button')).find((el) => el.textContent.trim() === ${JSON.stringify(label)})`;
  await cdp.click(finder);
  await cdp.waitFor(
    `(() => { const anchor = document.querySelector(${JSON.stringify(RIGHT_PANE_SELECTOR)}); const panel = anchor?.closest('[data-panel]'); return !!panel && Math.abs(panel.getBoundingClientRect().width - ${widthPx}) <= 2; })()`,
    { timeoutMs: 10_000, label: `Pane resized to ${widthPx}px (${label})` }
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const findings = [];
  const notExercised = [];
  let secondScrollerEverFound = false;
  let gitHeadSha = null;
  let dirty = 'unknown';
  let shimDir, launcherDir, exeDir;
  const perLaunchDirs = [];

  try {
    clearKnownOutputFiles(SHOTS_DIR, 'refract-802-scale-stream-shots', []);
    mkdirSync(SHOTS_DIR, { recursive: true });
    const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
    dirty = dirtyLines === null ? 'unknown' : dirtyLines.length ? dirtyLines : false;
    console.log(`verify-802-scale-stream: git HEAD ${gitHeadSha}${dirtyLines && dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);

    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-802ss-shim-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-802ss-launcher-'));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-802ss-exe-'));
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-802-scale-stream' });
    const exePath = built.dest;
    console.log(`verify-802-scale-stream: built exe copied to ${exePath} (reused across every launch below)`);

    // `extraBrowserArgs` is appended after the mandatory --remote-debugging-port, which must be
    // rebuilt here because overriding the launcher's default would lose CDP.
    async function launchOnce(label, scenario, extraBrowserArgs) {
      const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-802ss-data-'));
      const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-802ss-import-'));
      const repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-802ss-repo-')), `verify-802ss-${label}`);
      perLaunchDirs.push(dataDir, importSourceDir, repoDir);
      const repoName = path.basename(repoDir);
      const port = await getFreePort();
      const browserArgs = extraBrowserArgs ? `--remote-debugging-port=${port} ${extraBrowserArgs}` : `--remote-debugging-port=${port}`;
      const launched = await launchBuiltExeWithEnv(launcherExe, exePath, {
        port,
        dataDir,
        importSourceDir,
        pathPrepend: shimDir,
        logFile: path.join(exeDir, `app-${label}.log`),
        extraEnv: {
          WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArgs,
          REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
          REFRACT_FAKE_OMP_NODE: process.execPath,
          REFRACT_FAKE_OMP_SCENARIO: scenario,
          REFRACT_FAKE_OMP_DEBUG_LOG: path.join(exeDir, `fake-omp-invocations-${label}.log`)
        }
      });
      const { child, targetPid } = launched;
      const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
      const cdp = await CdpSession.connect(wsUrl);
      if (!isTargetOwningPort(port, targetPid)) {
        throw new Error(`verify-802-scale-stream: [${label}] CDP target on port ${port} is not owned by the launched process (pid ${targetPid})`);
      }
      await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: `[${label}] Readiness screen mounted` });
      await cdp.waitFor(
        `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
        { timeoutMs: 60_000, label: `[${label}] Readiness green` }
      );
      const dpr = await cdp.evaluate('window.devicePixelRatio');
      findings.push(`[${label}] App launched (scenario=${scenario}, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="${browserArgs}"); window.devicePixelRatio = ${dpr}.`);
      await addRepository(cdp, repoDir);
      await createSessionViaQuickCreate(cdp, repoName);
      await cdp.clickByLabel('Side chat panel');
      await cdp.waitFor(`!!document.querySelector('[aria-label="Side chat question"]')`, { timeoutMs: 15_000, label: `[${label}] Side chat composer mounted` });
      await cdp.waitFor(
        `!document.querySelector('[aria-label="Side chat question"]').hasAttribute('aria-describedby')`,
        { timeoutMs: 15_000, label: `[${label}] Side chat history loaded` }
      );
      await cdp.typeIntoByLabel('Side chat question', QUESTION);
      await cdp.pressEnter();
      return { cdp, child, targetPid, label };
    }

    async function closeLaunch({ cdp, child, targetPid, label }) {
      cdp.close();
      await stopLauncher(child).catch(() => {});
      if (targetPid != null) {
        const stillRunningExePath = getProcessExecutablePath(targetPid);
        if (stillRunningExePath) {
          console.warn(`verify-802-scale-stream: [${label}] process ${targetPid} still appears to be running after stopLauncher.`);
        } else {
          console.log(`verify-802-scale-stream: [${label}] confirmed process ${targetPid} exited after stopLauncher.`);
        }
      }
    }

    // Part 1: display-scaling matrix.
    for (const scale of SCALES) {
      const scaleLabel = `scale${scale}`;
      const launch = await launchOnce(scaleLabel, 'side-chat-long-answer', `--force-device-scale-factor=${scale}`);
      const { cdp } = launch;
      await cdp.waitFor(
        `document.querySelector(${JSON.stringify(RIGHT_PANE_SELECTOR)})?.textContent.includes(${JSON.stringify(LAST_LINE_MARKER)}) ?? false`,
        { timeoutMs: 20_000, label: `[${scaleLabel}] Long side-chat answer rendered` }
      );
      for (const theme of THEMES) {
        for (const width of WIDTHS) {
          await switchTheme(cdp, theme.id, theme.name);
          await resizePane(cdp, width.px, width.label);
          const measurement = await measureScrollContainers(cdp);
          const comboLabel = `scale ${scale} / ${theme.name} / ${width.px}px`;
          findings.push(
            `[${comboLabel}] devicePixelRatio=${measurement.devicePixelRatio}; page-wide scroll containers: ${measurement.pageWideScrollers.length}: ${JSON.stringify(measurement.pageWideScrollers)}`
          );
          if (measurement.pageWideScrollers.length > 1) secondScrollerEverFound = true;
          const tableWrapper = measurement.horizontalOverflow.find((el) => el.className?.includes('overflow-x-auto rounded-md border'));
          const codeWrapper = measurement.horizontalOverflow.find((el) => el.className?.includes('[&>pre]'));
          if (tableWrapper) findings.push(`[${comboLabel}] table wrapper: scrollHeight=${tableWrapper.scrollHeight} clientHeight=${tableWrapper.clientHeight} (${tableWrapper.scrollHeight > tableWrapper.clientHeight ? 'EXCEEDS -- second scrollbar expected' : 'does not exceed'})`);
          if (codeWrapper) findings.push(`[${comboLabel}] code wrapper: scrollHeight=${codeWrapper.scrollHeight} clientHeight=${codeWrapper.clientHeight} (${codeWrapper.scrollHeight > codeWrapper.clientHeight ? 'EXCEEDS -- second scrollbar expected' : 'does not exceed'})`);
          const shot = `side-chat-${scaleLabel}-${theme.id}-${width.px}px.png`;
          await cdp.screenshot(path.join(SHOTS_DIR, shot));
          findings.push(`Screenshot captured: ${comboLabel} (${shot}).`);
        }
      }
      await closeLaunch(launch);
    }

    // Part 2: streaming answer, sampled while btw_delta frames arrive.
    {
      const launch = await launchOnce('stream', 'side-chat-streaming-answer', null);
      const { cdp } = launch;
      const streamFindings = [];
      const streamStart = Date.now();
      const STREAM_SAMPLE_WINDOW_MS = 7000; // 20 deltas * 300ms __delay__ plus slack
      let sampleCount = 0;
      let maxPageWideScrollers = 0;
      while (Date.now() - streamStart < STREAM_SAMPLE_WINDOW_MS) {
        const t = Date.now() - streamStart;
        try {
          const measurement = await measureScrollContainers(cdp);
          sampleCount += 1;
          maxPageWideScrollers = Math.max(maxPageWideScrollers, measurement.pageWideScrollers.length);
          if (measurement.pageWideScrollers.length > 1) {
            secondScrollerEverFound = true;
            streamFindings.push(`[stream t=${t}ms] ${measurement.pageWideScrollers.length} page-wide scroll containers (SECOND SCROLLER): ${JSON.stringify(measurement.pageWideScrollers)}`);
          } else if (sampleCount % 5 === 0) {
            // Throttled to keep report.json small; any >1 sample is always logged above.
            streamFindings.push(`[stream t=${t}ms] ${measurement.pageWideScrollers.length} page-wide scroll container(s), scrollHeight=${measurement.pageWideScrollers[0]?.scrollHeight ?? 'n/a'} clientHeight=${measurement.pageWideScrollers[0]?.clientHeight ?? 'n/a'}`);
          }
        } catch (err) {
          streamFindings.push(`[stream t=${t}ms] measurement threw (right pane likely not mounted yet): ${err.message}`);
        }
        await sleep(200);
      }
      findings.push(`Streaming sample window: ${sampleCount} samples taken over ${STREAM_SAMPLE_WINDOW_MS}ms (every 200ms); max page-wide scroll containers seen at any instant: ${maxPageWideScrollers}.`);
      findings.push(...streamFindings);

      // Final measurement once the terminal btw_record is applied.
      await cdp.waitFor(
        `document.querySelector(${JSON.stringify(RIGHT_PANE_SELECTOR)})?.textContent.includes(${JSON.stringify(LAST_LINE_MARKER)}) ?? false`,
        { timeoutMs: 20_000, label: '[stream] Streamed answer settled (last-line marker present)' }
      );
      const afterSettle = await measureScrollContainers(cdp);
      if (afterSettle.pageWideScrollers.length > 1) secondScrollerEverFound = true;
      findings.push(`[stream, after settle] ${afterSettle.pageWideScrollers.length} page-wide scroll container(s): ${JSON.stringify(afterSettle.pageWideScrollers)}`);
      await cdp.screenshot(path.join(SHOTS_DIR, 'side-chat-stream-after-settle.png'));
      findings.push('Screenshot captured: streamed answer after settle (side-chat-stream-after-settle.png).');

      await closeLaunch(launch);
    }

    const report = {
      gitHead: gitHeadSha,
      dirty,
      scalesTested: SCALES,
      secondScrollerEverFound,
      findings,
      notExercised,
      exitCode: 0
    };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== verify-802-scale-stream: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log(`\nsecondScrollerEverFound: ${secondScrollerEverFound}`);
    console.log(`Screenshots and report.json: ${SHOTS_DIR}`);
    console.log('verify-802-scale-stream: DONE.');
  } catch (err) {
    try {
      writeFileSync(
        path.join(SHOTS_DIR, 'report.json'),
        JSON.stringify({ gitHead: gitHeadSha, dirty, findings, notExercised, error: String(err?.stack ?? err), exitCode: 1 }, null, 2)
      );
    } catch {
      // best-effort only
    }
    console.error('verify-802-scale-stream: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    try {
      if (exeDir) {
        const fs = await import('node:fs');
        for (const f of fs.readdirSync(exeDir).filter((f) => f.endsWith('.log'))) {
          copyFileSync(path.join(exeDir, f), path.join(SHOTS_DIR, f));
        }
      }
    } catch (err) {
      console.warn('verify-802-scale-stream: could not preserve logs:', err.message);
    }
    await safeRmSync(shimDir);
    await safeRmSync(launcherDir);
    await safeRmSync(exeDir);
    for (const dir of perLaunchDirs) await safeRmSync(dir);
  }
}

main().catch((err) => {
  console.error('verify-802-scale-stream: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
