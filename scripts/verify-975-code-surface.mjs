#!/usr/bin/env node
// Live CDP check for issue #975 (a fenced code block's background follows each theme's own
// `--card` colour, not whatever bundled Shiki theme is chosen): renders one deterministic
// JavaScript fence via a fake `omp` reply (`scripts/fixtures/omp-frames/code-surface-975.jsonl`,
// modelled on `verify-439-history-truncate.mjs`'s own fixture-driven pattern -- a real model's
// free-form reply could not guarantee the exact token colours this check measures run over
// run), then for every built-in preset asserts by COMPUTED STYLE that the code block's header
// and body share one literal background, that it equals the theme's own live-resolved `--card`
// (read off a throwaway probe element carrying the same `bg-card` Tailwind class, never a
// hand-copied hex), and that the rendered comment token (the binding case per research.md
// decision 25: the lowest-margin colour across the four `github-dark-default` presets -- Dark,
// Obsidian, Nordic Frost, Cyber Amber; Dark high contrast's own `github-dark-high-contrast`
// comment colour clears with far more margin) clears 4.5:1 against that same background,
// measured live, not recomputed from CSS source. Screenshots every preset (Dark, Obsidian,
// Nordic Frost, Cyber Amber, Dark (high contrast)); Cyber Amber is the headline shot (research.md
// decision 25/issue #975's own motivating case -- the colour-family clash between a warm header
// and a cool `github-dark` body was most visible there).
//
// Drives a fake `omp` (REFRACT_FAKE_OMP_SCENARIO=code-surface-975), scratch cwd/worktree/
// REFRACT_DATA_DIR -- never touches Stuart's real Session list or spends a real model turn.
//
// Usage: CARGO_TARGET_DIR=<shared target dir> CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0 node
// scripts/verify-975-code-surface.mjs (requires a prior `pnpm tauri build --debug --no-bundle`,
// the same convention every `verify-5xx-*.mjs`/`verify-9xx-*.mjs` script documents).

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
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
  switchTheme,
  citeScreenshots
} from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';
import { worktreesDirFor } from './verify-551-helpers.mjs';
import { measuredContrastRatio } from './contrast-math.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR =
  process.env.REFRACT_975_SHOTS_DIR || path.join(tmpdir(), `refract-975-code-surface-shots-${new Date().toISOString().replace(/[:.]/g, '-')}`);

// Cyber Amber is the headline shot (research.md decision 25): the colour-family clash the issue
// reports was most visible there. Dark (high contrast) reuses `github-dark-high-contrast`,
// unaffected by the syntaxTheme swap -- included anyway so the acceptance criteria's "every
// built-in preset" is checked, not assumed from the other four.
const THEMES = [
  { id: 'dark', name: 'Dark', shot: '01-code-surface-dark.png' },
  { id: 'obsidian', name: 'Obsidian', shot: '02-code-surface-obsidian.png' },
  { id: 'nordic-frost', name: 'Nordic Frost', shot: '03-code-surface-nordic-frost.png' },
  { id: 'cyber-amber', name: 'Cyber Amber', shot: '04-code-surface-cyber-amber-HEADLINE.png' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)', shot: '05-code-surface-dark-high-contrast.png' }
];
const SHOT_NAMES = [...THEMES.map((t) => t.shot), 'report.json', 'app.log', 'fake-omp-invocations.log'];

const COMMENT_TEXT = 'a short comment line';

/** Reads the code block's own header/body/`<pre>` computed backgrounds, the header's language
 * label, a live-resolved `--card` probe (a throwaway `div.bg-card`, never a hand-copied hex),
 * and the comment token's own computed colour. `.not-prose` is the one wrapper `CodeBlock`
 * renders (`Markdown.tsx`); this fixture's assistant reply carries exactly one fenced block, so
 * exactly one match is expected -- more than one, or none, is itself a failure the caller
 * reports.
 *
 * Gate round 1 fix (Main, Code1 High): the comment token's own LEAF span is `span.line > span`
 * with no child `<span>` (Shiki wraps each styled run in its own span, nested directly under
 * the line wrapper, never deeper) -- the OUTER `span.line` wrapper also carries the comment text
 * in its own `textContent` (this fixture's comment is the only token on its line) but has no
 * inline colour of its own, so `querySelectorAll('span').find(...)` previously matched that
 * outer wrapper FIRST (document order: ancestor before descendant) and read the `<pre>`'s own
 * INHERITED default foreground instead of the comment's real, dimmer colour. Also reads the raw
 * `<pre>`'s own computed `background-color`/`color` so the caller can hard-fail if Shiki's own
 * background was never actually neutralised (gate round 1, Code2 High) and cross-check the
 * comment span's colour genuinely differs from the `<pre>`'s inherited default. */
async function readCodeSurfaceEvidence(cdp) {
  return cdp.evaluate(`(() => {
    const wrappers = Array.from(document.querySelectorAll('.not-prose'));
    if (wrappers.length !== 1) return { wrapperCount: wrappers.length };
    const wrapper = wrappers[0];
    const header = wrapper.children[0];
    const bodyRow = wrapper.children[1];
    const body = bodyRow ? bodyRow.children[bodyRow.children.length - 1] : null;
    if (!header || !body) return { wrapperCount: wrappers.length, headerFound: !!header, bodyFound: !!body };
    const label = header.querySelector('span.truncate');
    const pre = body.querySelector('pre');
    const commentSpan = pre
      ? Array.from(pre.querySelectorAll('span.line > span')).find(
          (s) => s.children.length === 0 && s.textContent.trimStart().startsWith('//')
        )
      : null;
    const probe = document.createElement('div');
    probe.className = 'bg-card';
    probe.style.position = 'fixed';
    probe.style.visibility = 'hidden';
    document.body.appendChild(probe);
    const cardProbe = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      wrapperCount: wrappers.length,
      headerFound: true,
      bodyFound: true,
      headerBg: getComputedStyle(header).backgroundColor,
      bodyBg: getComputedStyle(body).backgroundColor,
      preFound: !!pre,
      preBg: pre ? getComputedStyle(pre).backgroundColor : null,
      preColor: pre ? getComputedStyle(pre).color : null,
      cardProbe,
      label: label ? label.textContent.trim() : null,
      commentColor: commentSpan ? getComputedStyle(commentSpan).color : null
    };
  })()`);
}

async function main() {
  let dataDir, importSourceDir, repoDir, exeDir, launcherDir, shimDir;
  let child;
  let targetPid;
  let cdp;
  const findings = [];
  const failures = [];
  const notExercised = [
    'A real model turn\'s own free-form code block: this fixture\'s reply is a fixed, hand-written string precisely so every token colour measured is deterministic run over run -- see scripts/fixtures/omp-frames/README.md\'s own row for code-surface-975.jsonl.',
    'Light/system themes: this app ships dark-only presets (docs/DESIGN.md "Look and feel"); every declared ThemeId is covered above, there is no "Light" preset to check.'
  ];
  let exeHash = null;
  let gitHeadSha = null;
  let dirty = 'unknown';
  try {
    clearKnownOutputFiles(SHOTS_DIR, 'refract-975-code-surface-shots', SHOT_NAMES);
    mkdirSync(SHOTS_DIR, { recursive: true });
    const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
    dirty = dirtyLines === null ? 'unknown' : dirtyLines.length ? dirtyLines : false;

    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-975-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-975-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-975-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-975-repo-')), 'verify-975-code-surface');
    const repoName = path.basename(repoDir);
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-975-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-975-launcher-'));
    const port = await getFreePort();

    console.log(`verify-975: git HEAD ${gitHeadSha}${dirtyLines && dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
    console.log(`verify-975: shots dir ${SHOTS_DIR}`);

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-975' });
    const exePath = built.dest;
    exeHash = built.hash;
    console.log(`verify-975: built exe copied to ${exePath}`);

    const launched = await launchBuiltExeWithEnv(launcherExe, exePath, {
      port,
      dataDir,
      importSourceDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'code-surface-975',
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(exeDir, 'fake-omp-invocations.log')
      }
    });
    child = launched.child;
    targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-975: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green' }
    );

    await addRepository(cdp, repoDir);
    await createSessionViaQuickCreate(cdp, repoName);
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 60_000,
      label: 'Session opened, composer enabled'
    });
    findings.push('Session created in the scratch repo, fake omp attached (code-surface-975 scenario).');

    await cdp.click(`document.querySelector('[aria-label="Message"]')`);
    await cdp.send('Input.insertText', { text: 'Show me a short JavaScript snippet.' });
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`!!document.querySelector('.not-prose span.truncate')`, { timeoutMs: 30_000, label: 'Code block header rendered' });
    const labelReady = await cdp
      .waitFor(`(() => { const l = document.querySelector('.not-prose span.truncate'); return !!l && l.textContent.trim() === 'javascript'; })()`, {
        timeoutMs: 15_000,
        label: 'Code block highlighted (header reads "javascript", not "text")'
      })
      .then(() => true, () => false);
    if (!labelReady) {
      failures.push('Code block header never read "javascript" within the timeout -- Shiki highlighting did not complete (or fell back to plain text), so this run cannot measure Shiki token colours at all.');
    } else {
      findings.push('Code block highlighted by Shiki (header reads "javascript").');
    }

    for (const theme of THEMES) {
      if (theme.id !== 'dark') {
        await switchTheme(cdp, theme.id, theme.name);
      }
      await cdp.waitFor(`document.documentElement.classList.contains(${JSON.stringify(`theme-${theme.id}`)})`, {
        timeoutMs: 15_000,
        label: `<html> class theme-${theme.id} applied`
      });

      const evidence = await readCodeSurfaceEvidence(cdp);
      if (evidence.wrapperCount !== 1) {
        failures.push(`${theme.name}: expected exactly one ".not-prose" code block wrapper, found ${evidence.wrapperCount}.`);
      } else if (!evidence.headerFound || !evidence.bodyFound) {
        failures.push(`${theme.name}: code block header or body element not found inside the wrapper.`);
      } else {
        if (evidence.label !== 'javascript') {
          failures.push(`${theme.name}: code block header reads "${evidence.label}", expected "javascript".`);
        }
        if (evidence.headerBg !== evidence.bodyBg) {
          failures.push(`${theme.name}: header background (${evidence.headerBg}) != body background (${evidence.bodyBg}) -- they must share one literal surface (issue #975).`);
        } else {
          findings.push(`${theme.name}: header and body share one literal background (${evidence.headerBg}).`);
        }
        if (evidence.headerBg !== evidence.cardProbe || evidence.bodyBg !== evidence.cardProbe) {
          failures.push(`${theme.name}: code block background (header ${evidence.headerBg}, body ${evidence.bodyBg}) does not equal this theme's own live-resolved --card (${evidence.cardProbe}).`);
        } else {
          findings.push(`${theme.name}: code block background equals this theme's own live-resolved --card (${evidence.cardProbe}).`);
        }
        // Gate round 1 fix (Main, Code2 High): the previous check above only read the WRAPPER
        // div, which carries `bg-card` itself regardless of whether Shiki's own neutralisation
        // actually worked -- a hard, separate check that the raw `<pre>` Shiki injected is
        // itself transparent is the only way to prove the neutralisation, not just the div's
        // own class.
        if (!evidence.preFound) {
          failures.push(`${theme.name}: Shiki's own <pre> element not found inside the body.`);
        } else if (evidence.preBg !== 'rgba(0, 0, 0, 0)') {
          failures.push(`${theme.name}: Shiki's own <pre> background is "${evidence.preBg}", expected transparent ("rgba(0, 0, 0, 0)") -- colorReplacements did not actually neutralise it.`);
        } else {
          findings.push(`${theme.name}: Shiki's own <pre> background is transparent, confirming colorReplacements neutralised it (not merely absent from the wrapper div's own bg-card).`);
        }
        if (!evidence.commentColor) {
          failures.push(`${theme.name}: comment token span ("${COMMENT_TEXT}") not found in the rendered code block.`);
        } else if (evidence.commentColor === evidence.preColor) {
          failures.push(`${theme.name}: comment token's computed colour (${evidence.commentColor}) equals the <pre>'s own inherited default colour -- the leaf token span was not actually selected (gate round 1 regression guard).`);
        } else {
          const ratio = measuredContrastRatio(evidence.commentColor, evidence.cardProbe);
          if (ratio === null) {
            failures.push(`${theme.name}: could not parse the comment token's colour (${evidence.commentColor}) or --card (${evidence.cardProbe}) for a measured ratio.`);
          } else if (ratio < 4.5) {
            failures.push(`${theme.name}: comment token measures ${ratio.toFixed(2)}:1 against the live code-block background, below the 4.5:1 floor (research.md decision 25).`);
          } else {
            findings.push(`${theme.name}: comment token (${evidence.commentColor}, distinct from the <pre>'s own inherited ${evidence.preColor}) measures ${ratio.toFixed(2)}:1 against the live code-block background (>=4.5:1).`);
          }
        }
      }

      await cdp.screenshot(path.join(SHOTS_DIR, theme.shot));
      findings.push(`Screenshot captured: code block under the ${theme.name} theme (${theme.shot}).`);
    }

    const report = {
      gitHead: gitHeadSha,
      dirty,
      exeSha256: exeHash,
      screenshots: citeScreenshots(SHOTS_DIR, THEMES.map((t) => t.shot)),
      findings,
      failures,
      notExercised,
      exitCode: failures.length > 0 ? 1 : 0
    };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== verify-975: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-975: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-975: NOT EXERCISED (genuine skips only) ===');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-975: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
    process.exitCode = failures.length > 0 ? 1 : 0;
  } catch (err) {
    try {
      writeFileSync(
        path.join(SHOTS_DIR, 'report.json'),
        JSON.stringify({ gitHead: gitHeadSha, dirty, exeSha256: exeHash, findings, failures, notExercised, error: String(err?.stack ?? err), exitCode: 1 }, null, 2)
      );
    } catch {
      // best-effort only
    }
    console.error('verify-975: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) {
      await stopLauncher(child).catch(() => {});
      if (targetPid != null) {
        const stillRunningExePath = getProcessExecutablePath(targetPid);
        if (stillRunningExePath) {
          console.warn(`verify-975: process ${targetPid} still appears to be running after stopLauncher (exe path: ${stillRunningExePath}) -- cleanup may be incomplete.`);
        } else {
          console.log(`verify-975: confirmed process ${targetPid} exited after stopLauncher.`);
        }
      }
    }
    await safeRmSync(shimDir);
    await safeRmSync(dataDir);
    await safeRmSync(importSourceDir);
    await safeRmSync(repoDir);
    if (repoDir) await safeRmSync(worktreesDirFor(repoDir));
    await safeRmSync(exeDir);
    await safeRmSync(launcherDir);
  }
}

main().catch((err) => {
  console.error('verify-975: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
