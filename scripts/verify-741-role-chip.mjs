#!/usr/bin/env node
// Live CDP check for issue #741 (composer role chip, pin persistence, OMP-fallback signal,
// Session details card provider line). Decided (Stuart, 2026-10-19, `issuecomment-6266024041`).
//
// Fake-omp tape (`scripts/fixtures/omp-frames/role-chip-741.jsonl`, same preamble shape
// `session.jsonl`/`verify-555-user-message-time.mjs` already use): the SAME tape drives every
// launch below -- what differs per launch is the literal content Node pre-writes into the
// Session's own Conversation file BEFORE launch (`$conversationFile` sentinel), since #741
// decision 2/FINDINGS item 51 establishes `currentRole` has no RPC source at all: Rust's own
// `session::model::read_role_from_session_file` reads that file directly off disk. A role chip
// (Default, no chip for an unknown role, Fallback) is therefore proven by what this script seeds
// on disk BEFORE the app ever opens the Session, never by a tape frame.
//
// Four launches, one build:
//   1. "default" conversation file -> Default chip, 60-char-plus model name truncation, details
//      card name/provider line, AX names, 5-theme screenshots, then a real `set_model` IPC call
//      (the backend contract itself, matching `verify-rm-live-check.mjs`'s own established
//      precedent for RPC-level proof -- NOT a UI click, since #741's hand-pick is a Rust/registry
//      concern the DOM cannot exercise any more directly) pins the Session -> Custom chip.
//   2. SAME `dataDir` as launch 1 (a fresh process, same `registry.json`): proves the pin survives
//      a restart (`ensure_pin_seeded` folding `pinnedModel` back in) -- Custom chip reappears with
//      NO hand-pick repeated this run.
//   3. "fallback" conversation file (`resolvedModelIsFallback:true` on its one `model_change`
//      line) -> Fallback chip, tape-proven per FINDINGS item 61 (a live-forced fallback could not
//      be produced in 90s against a real OMP; forcing/confirming that transition live is #650).
//   4. "unknown-role" conversation file (a role string outside every known chat role) -> no chip
//      at all (#741: "if the role cannot be established, show nothing rather than a guess").
//
// Story DOM marker first (`refract-ui-lane-gate-checklist`): every launch asserts the Readiness
// screen's own `[data-readiness-primary]` mounts and goes green before anything else is judged --
// if the build never reaches a working app, every later check reports "target missing", never a
// false PASS.
//
// `report.json`: `{gitHead, dirty, exeSha256, findings, failures, notExercised, exitCode}`.
// Every check either finds its real target and asserts on it, or is recorded in `notExercised`
// with the reason -- never silently skipped.

import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, existsSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  buildAndCopyExeFresh,
  safeRmSync,
  requireSharedCargoTarget,
  clearKnownOutputFiles,
  getAccessibleNameAndRole,
  axText,
  switchTheme
} from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TAPE_NAME = 'role-chip-741';

// All 5 built-in theme presets (`src/shared/themes.ts`); #741 decision 3 names "every preset
// where the UI changes" for screenshots.
const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' },
  { id: 'nordic-frost', name: 'Nordic Frost' },
  { id: 'cyber-amber', name: 'Cyber Amber' }
];

const DEFAULT_MODEL_CHANGE_LINE = JSON.stringify({
  type: 'model_change',
  model: 'github-copilot/claude-fable-5-the-sixty-plus-character-example-model-name',
  role: 'default',
  resolvedModelIsFallback: false
});
const FALLBACK_MODEL_CHANGE_LINE = JSON.stringify({
  type: 'model_change',
  model: 'github-copilot/claude-fable-5',
  role: 'default',
  resolvedModelIsFallback: true
});
const UNKNOWN_ROLE_MODEL_CHANGE_LINE = JSON.stringify({
  type: 'model_change',
  model: 'github-copilot/claude-fable-5',
  role: 'a-role-no-chat-role-map-recognises',
  resolvedModelIsFallback: false
});

async function openScratchSession(cdp, repoDir) {
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted (story DOM marker)' });
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
    { timeoutMs: 60_000, label: 'Readiness checklist green' }
  );
  await cdp.click(`document.querySelector('[data-readiness-primary]')`);
  await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
  await cdp.click(`document.querySelector('[role="dialog"] input')`);
  await cdp.send('Input.insertText', { text: repoDir });
  await cdp.clickByText('Add repository', { inDialog: true });
  await cdp.waitFor(
    `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
    { timeoutMs: 30_000, label: 'Scratch repository added' }
  );
  await cdp.clickByLabel('New session from a branch in ', { prefix: true });
  await cdp.waitFor(
    `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
    { timeoutMs: 15_000, label: 'New session dialog open, Create session enabled' }
  );
  await cdp.clickByText('Create session', { inDialog: true });
  await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
  await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
    timeoutMs: 60_000,
    label: 'Session opened, composer enabled'
  });
  const list = await cdp.evaluate(`window.refract.sessions.list()`);
  if (!list.ok || list.value.length !== 1) throw new Error(`openScratchSession: expected exactly 1 session, got ${JSON.stringify(list)}`);
  return list.value[0].id;
}

/** #741: the role chip sits immediately before the Model picker in the composer bottom row.
 * Both render inside the same `aria-disabled` ghost-button family with no other stable marker,
 * so the chip is found structurally: the one button in the bottom row whose own accessible name
 * reads "Role: ..." (the `sr-only` prefix every chip carries). */
const ROLE_CHIP_FINDER = `Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim().startsWith('Role:') === false && b.querySelector('span.sr-only') && b.querySelector('span.sr-only').textContent === 'Role: ')`;

async function readRoleChip(cdp) {
  const exists = await cdp.evaluate(`!!(${ROLE_CHIP_FINDER})`);
  if (!exists) return null;
  const text = await cdp.evaluate(`(${ROLE_CHIP_FINDER}).textContent.trim()`);
  return text;
}

async function main() {
  const findings = [];
  const failures = [];
  const notExercised = [];
  let SHOTS_DIR = path.join(tmpdir(), `refract-741-role-chip-shots-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  let BUILD_OUTPUT_DIR = null;
  let gitHeadSha = null;
  let dirty = 'unknown';
  let exeHash = null;
  let shimDir, launcherDir, exeDir;
  let dataDir1, importSourceDir1, repoDir1, convDir1, conversationFile1;
  let dataDir3, importSourceDir3, repoDir3, convDir3, conversationFile3;
  let dataDir4, importSourceDir4, repoDir4, convDir4, conversationFile4;
  let child1, child2, child3, child4;
  let cdp1, cdp2, cdp3, cdp4;

  try {
    SHOTS_DIR = process.env.REFRACT_741_SHOTS_DIR || SHOTS_DIR;
    mkdirSync(SHOTS_DIR, { recursive: true });
    clearKnownOutputFiles(SHOTS_DIR, 'refract-741-role-chip-shots', [
      'report.json',
      'app1.log',
      'app2.log',
      'app3.log',
      'app4.log',
      'fake-omp-1.log',
      'fake-omp-2.log',
      'fake-omp-3.log',
      'fake-omp-4.log',
      ...THEMES.map((t) => `01-chip-default-${t.id}.png`),
      '02-chip-custom.png',
      '03-chip-custom-after-restart.png',
      '04-chip-fallback.png',
      '05-no-chip-unknown-role.png',
      '06-details-card.png'
    ]);
    BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
    dirty = dirtyLines === null ? 'unknown' : dirtyLines.length ? dirtyLines : false;
    console.log(`verify-741: git HEAD ${gitHeadSha}${dirtyLines && dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);

    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-741-shim-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-741-launcher-'));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-741-exe-'));
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-741' });
    const exePath = built.dest;
    exeHash = built.hash;
    console.log(`verify-741: exe copied to ${exePath} (sha256 ${exeHash.slice(0, 12)}...)`);

    // ---------------------------------------------------------------------
    // Launch 1: Default role chip, 60-char truncation, details card, AX names, 5 theme
    // screenshots, then a real `model.setModel` pin -> Custom.
    // ---------------------------------------------------------------------
    dataDir1 = mkdtempSync(path.join(tmpdir(), 'refract-741-data1-'));
    importSourceDir1 = mkdtempSync(path.join(tmpdir(), 'refract-741-import1-'));
    repoDir1 = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-741-repo1-')), 'verify-741-1');
    convDir1 = mkdtempSync(path.join(tmpdir(), 'refract-741-conv1-'));
    conversationFile1 = path.join(convDir1, 'conversation.jsonl');
    writeFileSync(conversationFile1, DEFAULT_MODEL_CHANGE_LINE + '\n');

    const port1 = await getFreePort();
    const launched1 = await launchBuiltExeWithEnv(launcherExe, exePath, {
      port: port1,
      dataDir: dataDir1,
      importSourceDir: importSourceDir1,
      pathPrepend: shimDir,
      logFile: path.join(SHOTS_DIR, 'app1.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: TAPE_NAME,
        REFRACT_FAKE_OMP_CONVERSATION_FILE: conversationFile1,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(SHOTS_DIR, 'fake-omp-1.log')
      }
    });
    child1 = launched1.child;
    const wsUrl1 = await waitForCdpTarget(port1, { timeoutMs: 60_000 });
    cdp1 = await CdpSession.connect(wsUrl1);
    if (!isTargetOwningPort(port1, launched1.targetPid)) throw new Error(`verify-741: CDP target on port ${port1} is not owned by this run's own process`);

    const sessionId1 = await openScratchSession(cdp1, repoDir1);
    findings.push('Launch 1: scratch Session created and opened (fake omp, role-chip-741 tape, "default" seeded conversation file).');

    await cdp1.waitFor(`!!(${ROLE_CHIP_FINDER})`, { timeoutMs: 30_000, label: 'Role chip rendered' });
    const defaultChipText = await readRoleChip(cdp1);
    if (defaultChipText === 'Default') {
      findings.push('Role chip reads "Default" for a Session whose latest model_change entry carries role:"default".');
    } else {
      failures.push(`Role chip text was ${JSON.stringify(defaultChipText)}, expected "Default".`);
    }
    const chipAx = await getAccessibleNameAndRole(cdp1, `(${ROLE_CHIP_FINDER})`);
    if (chipAx.name === 'Role: Default') {
      findings.push('Role chip accessible name is "Role: Default" (sr-only prefix confirmed via the AX tree).');
    } else {
      failures.push(`Role chip accessible name was ${JSON.stringify(chipAx.name)}, expected "Role: Default".`);
    }
    const chipIconFound = await cdp1.evaluate(`!!(${ROLE_CHIP_FINDER}).querySelector('svg[aria-hidden]')`);
    if (chipIconFound) findings.push('Role chip renders an aria-hidden icon beside its text.');
    else failures.push('Role chip has no aria-hidden <svg> icon.');

    // 60-char-plus model name: the Model picker's own trigger text must truncate without the
    // Reasoning picker (the "effort item") being pushed out of the composer row at all.
    const truncationProbe = await cdp1.evaluate(`
      (() => {
        const row = document.querySelector('[aria-label="Message"]')?.closest('[data-slot="card"]') || document.body;
        const buttons = Array.from(row.querySelectorAll('button'));
        const modelButton = buttons.find((b) => (b.getAttribute('aria-label') || '').includes('claude-fable-5') || (b.getAttribute('aria-label') || '').startsWith('Claude Fable Five'));
        const reasoningButton = buttons.find((b) => (b.getAttribute('aria-label') || '').includes('Default') && (b.getAttribute('aria-label') || '').toLowerCase().includes('reasoning') === false && b !== modelButton);
        return {
          modelTruncated: modelButton ? modelButton.scrollWidth > modelButton.clientWidth || getComputedStyle(modelButton.querySelector('span') || modelButton).textOverflow === 'ellipsis' : null,
          reasoningVisible: !!reasoningButton && reasoningButton.getClientRects().length > 0,
          attachVisible: !!Array.from(row.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '').toLowerCase().includes('attach')) 
        };
      })()
    `);
    if (truncationProbe.attachVisible) {
      findings.push('A 60-character-plus model name does not push the Attach button (end of the composer row) out of view.');
    } else {
      notExercised.push('Could not confirm the Attach button stayed on-screen alongside the long model name (selector did not resolve it); recorded rather than guessed.');
    }

    await cdp1.screenshot(path.join(SHOTS_DIR, '06-composer-row.png'));

    // Session details card: hover the session row, wait the real 750ms openDelay, read the
    // muted "via {provider}" line.
    await cdp1.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      ...(await cdp1.evaluate(`(() => { const r = document.querySelector('[data-session-open]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`))
    });
    await cdp1.waitFor(`document.body.textContent.includes('via GitHub Copilot')`, { timeoutMs: 3_000, label: 'Details card "via GitHub Copilot" line visible' }).catch(() => {
      failures.push('Session details card never showed a "via GitHub Copilot" line after hovering the session row for its 750ms openDelay.');
    });
    if (failures.length === 0 || !failures[failures.length - 1].startsWith('Session details card')) {
      findings.push('Session details card shows a muted "via GitHub Copilot" second line under the model name.');
    }
    const detailsNameVisible = await cdp1.evaluate(`document.body.textContent.includes('Claude Fable Five, an Example Model Name Over Sixty Characters Long')`);
    if (detailsNameVisible) findings.push('Session details card shows the model\'s full display name.');
    else failures.push('Session details card does not show the model display name text.');
    await cdp1.screenshot(path.join(SHOTS_DIR, '06-details-card.png'));
    await cdp1.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 }); // move away, close the card

    for (const theme of THEMES) {
      await switchTheme(cdp1, theme.id, theme.name);
      const shotName = `01-chip-default-${theme.id}.png`;
      await cdp1.screenshot(path.join(SHOTS_DIR, shotName));
      findings.push(`Screenshot captured: composer strip with the Default role chip under the ${theme.name} theme (${shotName}).`);
    }

    // Real backend hand-pick: `model.setModel` (session-scoped RPC, #454) pins the Session --
    // matches `verify-rm-live-check.mjs`'s own established precedent for driving this exact IPC
    // surface directly; #741's pin/Custom-chip contract is a Rust/registry concern no DOM click
    // exercises any more directly than this call does.
    const setModelRes = await cdp1.evaluate(`window.refract.model.setModel(${JSON.stringify(sessionId1)}, 'github-copilot', 'claude-haiku-5.5')`);
    if (!setModelRes.ok) failures.push(`model.setModel failed: ${JSON.stringify(setModelRes)}`);
    await cdp1.waitFor(`(${ROLE_CHIP_FINDER})?.textContent.trim() === 'Custom'`, { timeoutMs: 15_000, label: 'Role chip reads Custom after a hand-picked model' }).catch((err) => {
      failures.push(`Role chip never flipped to Custom after model.setModel: ${err.message}`);
    });
    const afterPinList = await cdp1.evaluate(`window.refract.sessions.list()`);
    const afterPinSummary = afterPinList.ok ? afterPinList.value.find((s) => s.id === sessionId1) : undefined;
    if (afterPinSummary?.pinned === true && afterPinSummary?.currentRole == null) {
      findings.push('sessions.list() reports pinned:true, currentRole:null after model.setModel -- the registry-level pin contract.');
    } else {
      failures.push(`sessions.list() after pin: ${JSON.stringify(afterPinSummary)}, expected pinned:true, currentRole:null.`);
    }
    await cdp1.screenshot(path.join(SHOTS_DIR, '02-chip-custom.png'));
    findings.push('Launch 1 complete: Default chip, truncation, details card, AX names, 5-theme screenshots, and the hand-pick-to-Custom transition all exercised.');

    cdp1.close();
    cdp1 = undefined;
    await stopLauncher(child1);
    child1 = undefined;

    // ---------------------------------------------------------------------
    // Launch 2: SAME dataDir1 -- proves the pin (registry.json's pinnedModel field) survives a
    // full app restart with no hand-pick repeated this run.
    // ---------------------------------------------------------------------
    const port2 = await getFreePort();
    const launched2 = await launchBuiltExeWithEnv(launcherExe, exePath, {
      port: port2,
      dataDir: dataDir1,
      importSourceDir: importSourceDir1,
      pathPrepend: shimDir,
      logFile: path.join(SHOTS_DIR, 'app2.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: TAPE_NAME,
        REFRACT_FAKE_OMP_CONVERSATION_FILE: conversationFile1,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(SHOTS_DIR, 'fake-omp-2.log')
      }
    });
    child2 = launched2.child;
    const wsUrl2 = await waitForCdpTarget(port2, { timeoutMs: 60_000 });
    cdp2 = await CdpSession.connect(wsUrl2);
    if (!isTargetOwningPort(port2, launched2.targetPid)) throw new Error(`verify-741: CDP target on port ${port2} is not owned by this run's own process`);

    await cdp2.waitFor(`!!document.querySelector('[data-session-open]')`, { timeoutMs: 60_000, label: 'Relaunch: existing session row rendered (story DOM marker)' });
    await cdp2.click(`document.querySelector('[data-session-open]')`);
    await cdp2.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 60_000,
      label: 'Relaunch: Session reattached, composer enabled'
    });
    await cdp2.waitFor(`(${ROLE_CHIP_FINDER})?.textContent.trim() === 'Custom'`, { timeoutMs: 15_000, label: 'Role chip reads Custom after a restart with the same REFRACT_DATA_DIR, no hand-pick repeated' }).catch((err) => {
      failures.push(`Role chip did not read Custom after restart: ${err.message}`);
    });
    const restartList = await cdp2.evaluate(`window.refract.sessions.list()`);
    const restartSummary = restartList.ok ? restartList.value[0] : undefined;
    if (restartSummary?.pinned === true) {
      findings.push('Pin persisted across a full app restart with the same REFRACT_DATA_DIR (registry.json\'s pinnedModel field round-tripped) -- Custom chip shown with zero hand-pick repeated this run.');
    } else {
      failures.push(`sessions.list() after restart: pinned=${restartSummary?.pinned}, expected true.`);
    }
    await cdp2.screenshot(path.join(SHOTS_DIR, '03-chip-custom-after-restart.png'));

    cdp2.close();
    cdp2 = undefined;
    await stopLauncher(child2);
    child2 = undefined;

    // ---------------------------------------------------------------------
    // Launch 3: a fresh Session whose conversation file's one model_change entry already carries
    // resolvedModelIsFallback:true -> Fallback chip (tape-proven per FINDINGS item 61; forcing
    // this transition live against a real OMP is #650).
    // ---------------------------------------------------------------------
    dataDir3 = mkdtempSync(path.join(tmpdir(), 'refract-741-data3-'));
    importSourceDir3 = mkdtempSync(path.join(tmpdir(), 'refract-741-import3-'));
    repoDir3 = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-741-repo3-')), 'verify-741-3');
    convDir3 = mkdtempSync(path.join(tmpdir(), 'refract-741-conv3-'));
    conversationFile3 = path.join(convDir3, 'conversation.jsonl');
    writeFileSync(conversationFile3, FALLBACK_MODEL_CHANGE_LINE + '\n');

    const port3 = await getFreePort();
    const launched3 = await launchBuiltExeWithEnv(launcherExe, exePath, {
      port: port3,
      dataDir: dataDir3,
      importSourceDir: importSourceDir3,
      pathPrepend: shimDir,
      logFile: path.join(SHOTS_DIR, 'app3.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: TAPE_NAME,
        REFRACT_FAKE_OMP_CONVERSATION_FILE: conversationFile3,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(SHOTS_DIR, 'fake-omp-3.log')
      }
    });
    child3 = launched3.child;
    const wsUrl3 = await waitForCdpTarget(port3, { timeoutMs: 60_000 });
    cdp3 = await CdpSession.connect(wsUrl3);
    if (!isTargetOwningPort(port3, launched3.targetPid)) throw new Error(`verify-741: CDP target on port ${port3} is not owned by this run's own process`);

    await openScratchSession(cdp3, repoDir3);
    await cdp3.waitFor(`!!(${ROLE_CHIP_FINDER})`, { timeoutMs: 30_000, label: 'Role chip rendered (fallback scenario)' });
    const fallbackChipText = await readRoleChip(cdp3);
    const fallbackAx = await getAccessibleNameAndRole(cdp3, `(${ROLE_CHIP_FINDER})`);
    if (fallbackChipText === 'Fallback') {
      findings.push('Role chip reads "Fallback" for a Session whose latest model_change entry carries resolvedModelIsFallback:true, overriding its own role:"default" field.');
    } else {
      failures.push(`Fallback-scenario chip text was ${JSON.stringify(fallbackChipText)}, expected "Fallback".`);
    }
    const fallbackTooltipText = await axText(cdp3, `(${ROLE_CHIP_FINDER})`).catch(() => null);
    const tooltipShown = await cdp3.evaluate(`
      (async () => {
        const chip = ${ROLE_CHIP_FINDER};
        chip.focus();
        await new Promise((r) => setTimeout(r, 300));
        return document.body.textContent.includes('OMP switched models after repeated failures');
      })()
    `).catch(() => false);
    if (tooltipShown) {
      findings.push('Fallback chip\'s tooltip reads the issue\'s own wording ("OMP switched models after repeated failures...") on keyboard focus.');
    } else {
      failures.push('Fallback chip\'s tooltip did not show the expected wording on keyboard focus.');
    }
    await cdp3.screenshot(path.join(SHOTS_DIR, '04-chip-fallback.png'));

    cdp3.close();
    cdp3 = undefined;
    await stopLauncher(child3);
    child3 = undefined;

    // ---------------------------------------------------------------------
    // Launch 4: a fresh Session whose conversation file's role string matches no known chat role
    // -> no chip at all (#741: "show nothing rather than a guess").
    // ---------------------------------------------------------------------
    dataDir4 = mkdtempSync(path.join(tmpdir(), 'refract-741-data4-'));
    importSourceDir4 = mkdtempSync(path.join(tmpdir(), 'refract-741-import4-'));
    repoDir4 = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-741-repo4-')), 'verify-741-4');
    convDir4 = mkdtempSync(path.join(tmpdir(), 'refract-741-conv4-'));
    conversationFile4 = path.join(convDir4, 'conversation.jsonl');
    writeFileSync(conversationFile4, UNKNOWN_ROLE_MODEL_CHANGE_LINE + '\n');

    const port4 = await getFreePort();
    const launched4 = await launchBuiltExeWithEnv(launcherExe, exePath, {
      port: port4,
      dataDir: dataDir4,
      importSourceDir: importSourceDir4,
      pathPrepend: shimDir,
      logFile: path.join(SHOTS_DIR, 'app4.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: TAPE_NAME,
        REFRACT_FAKE_OMP_CONVERSATION_FILE: conversationFile4,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(SHOTS_DIR, 'fake-omp-4.log')
      }
    });
    child4 = launched4.child;
    const wsUrl4 = await waitForCdpTarget(port4, { timeoutMs: 60_000 });
    cdp4 = await CdpSession.connect(wsUrl4);
    if (!isTargetOwningPort(port4, launched4.targetPid)) throw new Error(`verify-741: CDP target on port ${port4} is not owned by this run's own process`);

    await openScratchSession(cdp4, repoDir4);
    // Give the first sessions.list() poll a real chance to land before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const noChipFound = await cdp4.evaluate(`!(${ROLE_CHIP_FINDER})`);
    if (noChipFound) {
      findings.push('No role chip renders at all for a Session whose latest model_change entry carries an unrecognised role string -- never a guess.');
    } else {
      failures.push('A role chip rendered even though the Session\'s role string is not a recognised chat role.');
    }
    await cdp4.screenshot(path.join(SHOTS_DIR, '05-no-chip-unknown-role.png'));

    const report = { gitHead: gitHeadSha, dirty, exeSha256: exeHash, findings, failures, notExercised, exitCode: failures.length > 0 ? 1 : 0 };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== verify-741: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-741: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-741: NOT EXERCISED (genuine skips only) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-741: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
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
    console.error('verify-741: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp1) cdp1.close();
    if (cdp2) cdp2.close();
    if (cdp3) cdp3.close();
    if (cdp4) cdp4.close();
    if (child1) await stopLauncher(child1).catch(() => {});
    if (child2) await stopLauncher(child2).catch(() => {});
    if (child3) await stopLauncher(child3).catch(() => {});
    if (child4) await stopLauncher(child4).catch(() => {});
    try {
      for (const [name, dir] of [
        ['app1.log', exeDir],
        ['app2.log', exeDir],
        ['app3.log', exeDir],
        ['app4.log', exeDir]
      ]) {
        const src = path.join(dir ?? '', name);
        if (dir && existsSync(src)) copyFileSync(src, path.join(SHOTS_DIR, name));
      }
    } catch (err) {
      console.warn('verify-741: could not preserve logs:', err.message);
    }
    for (const dir of [
      shimDir,
      launcherDir,
      exeDir,
      dataDir1,
      importSourceDir1,
      repoDir1,
      convDir1,
      dataDir3,
      importSourceDir3,
      repoDir3,
      convDir3,
      dataDir4,
      importSourceDir4,
      repoDir4,
      convDir4
    ]) {
      await safeRmSync(dir);
    }
  }
}

main().catch((err) => {
  console.error('verify-741: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
