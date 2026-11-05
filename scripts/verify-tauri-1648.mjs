#!/usr/bin/env node
// Live CDP check for #1648: a slash command's reply renders as Markdown (code fence, table, list, heading) and `/usage` renders as a
// card with a progress bar per account. One light and one dark theme; scratch REFRACT_DATA_DIR, CDP port 9248.
// Usage: CARGO_TARGET_DIR=<shared target dir> [REFRACT_1648_SHOTS_DIR=<dir>] node scripts/verify-tauri-1648.mjs

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget, switchTheme } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1648';
const PORT = 9248;
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1648_SHOTS_DIR || path.join(tmpdir(), 'lane1648', 'shots');
const THEMES = [
  { id: 'light', name: 'Light' },
  { id: 'dark', name: 'Dark' }
];
const MARKDOWN_SUMMARY = 'Tools report 1648';

async function main() {
  const head = gitHead(REPO_ROOT);
  console.log(`${LOG}: git HEAD ${head}`);
  mkdirSync(SHOTS_DIR, { recursive: true });
  const report = [];
  const failures = [];
  let passes = 0;
  const check = (ok, label, extra) => {
    report.push({ step: label, ok, ...(extra !== undefined ? { extra } : {}) });
    if (ok) passes += 1;
    else failures.push(label);
    console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label}${ok || extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`);
  };

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1648-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1648-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1648-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1648-command-output');
  const worktreesRootForCleanup = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1648-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1648-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1648-shim-'));

  let child;
  let cdp;
  try {
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const exeInfo = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    const launched = await launchBuiltExe(launcherExe, exeInfo.dest, {
      port: PORT,
      dataDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(exeDir, 'fake-omp-invocations.log'),
        REFRACT_FAKE_OMP_SCENARIO: '997-notice-severity'
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(PORT, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(PORT, launched.targetPid)) throw new Error(`${LOG}: CDP target on port ${PORT} is not owned by pid ${launched.targetPid}`);

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green (fake omp)' }
    );
    await cdp.openLocalFolderDialog();
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add project', { inDialog: true });
    await cdp.waitFor(
      `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
      { timeoutMs: 30_000, label: 'Scratch repository added' }
    );
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
      { timeoutMs: 15_000, label: 'New session dialog open' }
    );
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 60_000,
      label: 'Session composer enabled'
    });

    await cdp.typeIntoByLabel('Message', 'trigger the scripted command output');
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`document.querySelectorAll('[role="progressbar"]').length >= 3`, { timeoutMs: 30_000, label: 'Usage card progress bars rendered' });
    await cdp.waitFor(`Array.from(document.querySelectorAll('button')).some((b) => (b.textContent ?? '').includes(${JSON.stringify(MARKDOWN_SUMMARY)}))`, {
      timeoutMs: 15_000,
      label: 'Markdown command output summary rendered'
    });

    const summary = await cdp.evaluate(
      `(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent ?? '').includes(${JSON.stringify(MARKDOWN_SUMMARY)})); return b ? b.textContent.trim() : null; })()`
    );
    check(typeof summary === 'string' && !summary.includes('#') && !summary.includes('|'), 'collapsed summary has Markdown markers stripped', { summary });

    await cdp.evaluate(
      `(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent ?? '').includes(${JSON.stringify(MARKDOWN_SUMMARY)})); if (b && b.getAttribute('aria-expanded') !== 'true') b.click(); })()`
    );
    const mdExpr = `(() => {
      const trigger = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent ?? '').includes(${JSON.stringify(MARKDOWN_SUMMARY)}));
      const scope = trigger?.closest('[data-slot="collapsible"]');
      if (!scope) return null;
      return {
        expanded: trigger.getAttribute('aria-expanded'),
        heading: !!scope.querySelector('h1,h2,h3,h4,h5,h6'),
        headingText: scope.querySelector('h1,h2,h3,h4,h5,h6')?.textContent ?? '',
        listItems: scope.querySelectorAll('li').length,
        tableCells: scope.querySelectorAll('table td').length,
        tableHeaders: scope.querySelectorAll('table th').length,
        pre: scope.querySelectorAll('pre').length,
        codeText: Array.from(scope.querySelectorAll('pre code, pre')).map((el) => el.textContent ?? '').join('|'),
        rawMarkers: (scope.textContent ?? '').includes('## Tools report') || (scope.textContent ?? '').includes('| --- |')
      };
    })()`;
    await cdp.waitFor(`(() => { const r = ${mdExpr}; return !!r && r.listItems > 0; })()`, { timeoutMs: 15_000, label: 'Markdown content expanded' });
    const md = await cdp.evaluate(mdExpr);
    check(md.expanded === 'true', 'command output expands on click', md);
    check(md.heading && md.headingText.includes('Tools report 1648'), 'Markdown heading rendered', md);
    check(md.listItems >= 2, 'Markdown list items rendered (li)', md);
    check(md.tableHeaders === 2 && md.tableCells === 4, 'Markdown table rendered (th/td)', md);
    check(md.pre >= 1 && md.codeText.includes('echo hello-1648'), 'Markdown code fence rendered (pre/code)', md);
    check(!md.rawMarkers, 'no raw Markdown markers left in the text', md);

    const usageExpr = `(() => {
      const bars = Array.from(document.querySelectorAll('[role="progressbar"]')).filter((el) => (el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent?.includes('-1648')));
      return bars.map((el) => ({
        label: document.getElementById(el.getAttribute('aria-labelledby')).textContent,
        now: el.getAttribute('aria-valuenow'),
        fill: el.firstElementChild?.className ?? ''
      }));
    })()`;
    for (const theme of THEMES) {
      await switchTheme(cdp, theme.id, theme.name);
      const bars = await cdp.evaluate(usageExpr);
      const byAccount = (name) => bars.find((b) => b.label.startsWith(name));
      check(bars.length === 3, `${theme.name}: usage card has one progress bar per account`, bars);
      const ok = byAccount('alpha-1648');
      const warn = byAccount('beta-1648');
      const err = byAccount('gamma-1648');
      check(ok?.now === '40' && ok.fill.includes('bg-foreground') && !/near the limit|limit reached/.test(ok.label), `${theme.name}: ok state (40 used, neutral fill, no state label)`, ok);
      check(warn?.now === '90' && warn.fill.includes('bg-severity-warning') && warn.label.endsWith(', near the limit'), `${theme.name}: warning state (label "near the limit", warning fill)`, warn);
      check(err?.now === '100' && err.fill.includes('bg-severity-error') && err.label.endsWith(', limit reached'), `${theme.name}: error state (label "limit reached", error fill)`, err);
      const title = await cdp.evaluate(`Array.from(document.querySelectorAll('h3,[data-slot="card-title"]')).map((el) => el.textContent).find((t) => t.startsWith('Usage')) ?? null`);
      check(title === 'Usage (4m ago)', `${theme.name}: usage card title shows the fetch age`, { title });
      await cdp.evaluate(`document.querySelector('[role="progressbar"]')?.scrollIntoView({ block: 'center' })`);
      await cdp.screenshot(path.join(SHOTS_DIR, `usage-card-${theme.id}.png`));
      await cdp.evaluate(`Array.from(document.querySelectorAll('button')).find((x) => (x.textContent ?? '').includes(${JSON.stringify(MARKDOWN_SUMMARY)}))?.scrollIntoView({ block: 'center' })`);
      await cdp.screenshot(path.join(SHOTS_DIR, `markdown-output-${theme.id}.png`));
    }
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    failures.push('run crashed');
    console.error(`${LOG}: FAIL run crashed`, err);
  } finally {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, passes, failures, results: report }, null, 2));
    } catch (writeErr) {
      console.error(`${LOG}: failed to write report.json: ${writeErr}`);
    }
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    for (const dir of [dataDir, importSourceDir, repoDirBase, worktreesRootForCleanup, exeDir, launcherDir, shimDir]) await safeRmSync(dir, LOG);
  }

  console.log(`${LOG}: ${failures.length ? `FAILED (${failures.length})` : `all ${passes} checks passed`}; evidence in ${SHOTS_DIR}`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(`${LOG}: FAILED`, err);
  process.exit(1);
});
