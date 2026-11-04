#!/usr/bin/env node
// Live CDP check (#838 agent-to-agent lines, #762 `/models`) against the fake omp's `997-notice-severity` tape.
// #1055's delete-wait timeout needs a genuinely hung git child to provoke; not driven here.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep, resolveCssVarColor } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, citeScreenshots, safeRmSync, requireSharedCargoTarget, switchTheme, clearKnownOutputFiles, assertExeUnchanged } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-p1-agentmsg';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_P1_AGENTMSG_SHOTS_DIR || path.join(tmpdir(), 'refract-p1-agentmsg-shots');
const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' }
];
const SHOT_NAMES = [...THEMES.map((t) => `agent-lines-${t.id}.png`), 'models-settings.png'];

const EXPECTED_ROWS = [
  { key: 'sub-to-main', direction: 'to-main', lucide: 'lucide-message-square-reply', name: 'Agent message from R1_Worker to Main agent' },
  { key: 'from-parent', direction: 'from-main', lucide: 'lucide-message-square-share', name: 'Agent message from Main agent to this agent' },
  { key: 'peer', direction: 'peer', lucide: 'lucide-messages-square', name: 'Agent message from R2_Reviewer to R1_Worker' },
  { key: 'steer', direction: 'from-main', lucide: 'lucide-message-square-share', name: 'Agent message from Main agent to R1_Worker' }
];
const FAILED_STEER_NAME = 'Agent message from Main agent to Nobody failed';

// The trigger button (or plain row) owning an sr-only label that starts with `prefix`.
function rowByLabelExpr(prefix) {
  return `(Array.from(document.querySelectorAll('span.sr-only')).find((el) => (el.textContent ?? '').startsWith(${JSON.stringify(prefix)}))?.closest('button') ?? null)`;
}

async function main() {
  const head = gitHead(REPO_ROOT);
  const dirtyLines = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).stdout.split('\n').filter(Boolean);
  const dirty = dirtyLines.length > 0;
  console.log(`${LOG}: git HEAD ${head}${dirty ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
  clearKnownOutputFiles(SHOTS_DIR, 'refract-p1-agentmsg-shots', [...SHOT_NAMES, 'report.json']);

  const report = [];
  const notExercised = ['#1055 delete-wait timeout: needs a hung git child; code-verified only (cargo test/clippy), not driven live'];
  function check(ok, label, extra) {
    report.push({ step: label, ok: ok === true, ...(extra ? { extra } : {}) });
    if (ok !== true) throw new Error(`FAIL: ${label}${extra ? ` ${JSON.stringify(extra)}` : ''}`);
    console.log(`${LOG}: PASS ${label}`);
  }

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-p1am-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-p1am-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-p1am-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-p1-agentmsg');
  const worktreesRootForCleanup = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-p1am-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-p1am-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-p1am-shim-'));

  let child;
  let cdp;
  let exeInfo;
  try {
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    exeInfo = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    report.push({ step: 'exe', ok: true, exe: exeInfo.dest, sha256: exeInfo.hash });
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
        REFRACT_FAKE_OMP_SCENARIO: '997-notice-severity'
      }
    });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error(`${LOG}: CDP target on port ${port} is not owned by pid ${launched.targetPid}`);

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
    await cdp.openLocalFolderDialog();
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add project', { inDialog: true });
    await cdp.waitFor(`!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`, { timeoutMs: 30_000, label: 'Scratch repository added' });
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, { timeoutMs: 15_000, label: 'Create session enabled' });
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'Composer enabled' });

    // Hook is trusted only because the real first send is captured by it below.
    const hook = await cdp.evaluate(`(() => {
      window.__p1amChatSends = [];
      const original = window.fetch;
      const patched = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        let body = '';
        const raw = init && init.body;
        if (typeof raw === 'string') body = raw;
        else if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) body = new TextDecoder().decode(raw);
        const headerText = init && init.headers ? JSON.stringify(init.headers instanceof Headers ? Object.fromEntries(init.headers) : init.headers) : '';
        if ((url + body + headerText).includes('chat.send')) window.__p1amChatSends.push(body);
        return original.apply(this, arguments);
      };
      window.fetch = patched;
      return window.fetch === patched;
    })()`);
    check(hook === true, 'fetch hook installed on the IPC path');

    await cdp.typeIntoByLabel('Message', 'trigger the scripted turn');
    await cdp.clickByLabel('Send message');
    const realSends = await cdp.waitFor(`window.__p1amChatSends.length`, { timeoutMs: 10_000, label: 'the real send was captured by the hook' });
    check(realSends >= 1, 'hook proven live: the real chat.send was captured', { realSends });

    await cdp.waitFor(`document.querySelectorAll('[data-agent-message-direction]').length >= 4`, { timeoutMs: 30_000, label: 'agent-message direction glyphs rendered' });
    check(true, 'story marker: [data-agent-message-direction] glyphs present');

    await cdp.send('Accessibility.enable');
    async function axName(expr) {
      const evalResult = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: false });
      const objectId = evalResult.result?.objectId;
      if (!objectId) return null;
      const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { objectId, fetchRelatives: false });
      return { name: nodes?.[0]?.name?.value ?? null, role: nodes?.[0]?.role?.value ?? null };
    }
    for (const row of EXPECTED_ROWS) {
      const info = await cdp.evaluate(`(() => {
        const btn = ${rowByLabelExpr(row.name)};
        if (!btn) return null;
        const svg = btn.querySelector('svg[data-agent-message-direction]');
        return { direction: svg?.getAttribute('data-agent-message-direction') ?? null, svgClass: svg?.getAttribute('class') ?? '', text: btn.textContent };
      })()`);
      check(info !== null, `${row.key}: row found by its sr-only label`, { name: row.name });
      check(info.direction === row.direction && info.svgClass.includes(row.lucide), `${row.key}: ${row.direction} glyph (${row.lucide})`, info);
      const ax = await axName(rowByLabelExpr(row.name));
      const pair = row.name.slice('Agent message from '.length);
      const pairCount = typeof ax?.name === 'string' ? ax.name.split(pair).length - 1 : 0;
      check(ax?.role === 'button' && ax.name.startsWith(row.name) && pairCount === 1, `${row.key}: accessible name starts with "${row.name}" and states the pair once`, { ...ax, pairCount });
    }

    const layout = await cdp.evaluate(`(() => {
      const steer = ${rowByLabelExpr('Agent message from Main agent to R1_Worker')};
      const readRows = Array.from(document.querySelectorAll('button')).filter((b) => (b.textContent ?? '').includes('README.md') && !(b.textContent ?? '').includes('Agent message'));
      const ordered = readRows.length === 2 && steer && (readRows[0].compareDocumentPosition(steer) & Node.DOCUMENT_POSITION_FOLLOWING) && (steer.compareDocumentPosition(readRows[1]) & Node.DOCUMENT_POSITION_FOLLOWING);
      return { readRows: readRows.length, readTexts: readRows.map((b) => (b.textContent ?? '').slice(0, 80)), logButtons: Array.from(document.querySelectorAll('[role="log"] button')).map((b) => (b.textContent ?? '').slice(0, 60)), ordered: !!ordered, steerText: steer?.textContent ?? null };
    })()`);
    check(layout.readRows === 2 && layout.ordered, 'steer ends the read run: two separate read rows, steer between them', layout);
    check(!/\bwrite\b|agent:\/\//.test(layout.steerText ?? 'write'), 'steer row shows no raw "write"/"agent://" text', layout);
    const failed = await cdp.evaluate(`(() => {
      const btn = ${rowByLabelExpr(FAILED_STEER_NAME)};
      if (!btn) return null;
      const label = Array.from(btn.querySelectorAll('span')).find((s) => s.getAttribute('data-slot') === 'collapsed-line-label');
      return { labelClass: label?.className ?? '', labelColor: label ? getComputedStyle(label).color : null, glyph: btn.querySelector('svg')?.getAttribute('class') ?? '', directionGlyph: !!btn.querySelector('[data-agent-message-direction]') };
    })()`);
    const errorColor = await resolveCssVarColor(cdp, '--severity-error', 'color');
    check(failed !== null, 'failed steer row found ("... to Nobody failed")');
    check(failed.labelColor === errorColor && !failed.labelClass.includes('text-agent-message') && !failed.directionGlyph, 'failed steer: error colour label, no violet, status glyph instead of a bubble', { ...failed, errorColor });

    for (const theme of THEMES) {
      if (theme.id !== 'dark') await switchTheme(cdp, theme.id, theme.name);
      const agentColor = await resolveCssVarColor(cdp, '--agent-message', 'color');
      const mutedColor = await resolveCssVarColor(cdp, '--muted-foreground', 'color');
      for (const row of EXPECTED_ROWS) {
        const colors = await cdp.evaluate(`(() => {
          const btn = ${rowByLabelExpr(row.name)};
          if (!btn) return null;
          const svg = btn.querySelector('svg[data-agent-message-direction]');
          const label = Array.from(btn.querySelectorAll('span')).find((s) => s.className.includes('text-agent-message'));
          const summary = Array.from(btn.querySelectorAll('span')).find((s) => s.className.includes('flex-1') && s.className.includes('truncate'));
          return { glyph: svg ? getComputedStyle(svg).color : null, label: label ? getComputedStyle(label).color : null, summary: summary ? getComputedStyle(summary).color : null };
        })()`);
        check(colors !== null && colors.glyph === agentColor && colors.label === agentColor, `${theme.name}: ${row.key} glyph and label are --agent-message`, { colors, agentColor });
        check(colors.summary === mutedColor, `${theme.name}: ${row.key} preview stays --muted-foreground`, { colors, mutedColor });
      }
      await cdp.evaluate(`(() => { const b = ${rowByLabelExpr('Agent message from R1_Worker to Main agent')}; b?.scrollIntoView({ block: 'center' }); return true; })()`);
      await sleep(300);
      await cdp.screenshot(path.join(SHOTS_DIR, `agent-lines-${theme.id}.png`));
    }
    await switchTheme(cdp, 'dark', 'Dark');

    const sendsBefore = await cdp.evaluate('window.__p1amChatSends.length');
    await cdp.typeIntoByLabel('Message', '/models');
    const menuOption = await cdp.waitFor(`(() => { const o = Array.from(document.querySelectorAll('[role="option"]')).find((el) => (el.textContent ?? '').includes('Open model role settings')); return o ? o.textContent : null; })()`, { timeoutMs: 10_000, label: '/models listed in the slash menu' });
    check(typeof menuOption === 'string' && menuOption.includes('models'), '/models listed in the slash menu as "Open model role settings"', { menuOption });
    // Enter on a top-level row only completes to "/models "; the next Enter sends it.
    await cdp.pressEnter();
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && el.value === '/models '; })()`, { timeoutMs: 5_000, label: 'Enter completed the draft to "/models "' });
    await cdp.pressEnter();
    const current = await cdp.waitFor(`(() => { const b = document.querySelector('nav[aria-label="Settings sections"] button[aria-current="page"]'); return b ? b.textContent.trim() : null; })()`, { timeoutMs: 10_000, label: 'Settings open' });
    check(current === 'Model roles', '/models opens Settings at Model roles', { current });
    await sleep(500);
    await cdp.screenshot(path.join(SHOTS_DIR, 'models-settings.png'));
    const sendsAfter = await cdp.evaluate('window.__p1amChatSends.length');
    check(sendsAfter === sendsBefore, '/models sent no chat.send', { sendsBefore, sendsAfter });
    await cdp.clickByLabel('Back to chat');
    const draft = await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return el ? JSON.stringify(el.value) : null; })()`, { timeoutMs: 10_000, label: 'back in chat' });
    check(draft === '""', 'Back returns to the chat with the /models draft cleared', { draft });

    assertExeUnchanged(exeInfo.dest, exeInfo.hash, 'end of run', LOG);
    report.push({ step: 'screenshots', ok: true, screenshots: citeScreenshots(SHOTS_DIR, SHOT_NAMES) });
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    throw err;
  } finally {
    const failures = report.filter((r) => r.ok === false).map((r) => r.step);
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, dirty, exeSha256: exeInfo?.hash ?? null, failures, notExercised, results: report }, null, 2));
    } catch (writeErr) {
      console.error(`${LOG}: failed to write report.json: ${writeErr}`);
    }
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
  console.log(`${LOG}: done; evidence in ${SHOTS_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
