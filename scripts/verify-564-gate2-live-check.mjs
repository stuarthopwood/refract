// Gate round 2 live-check (#564): proves the Default-persistence fix across a settle AND a
// relaunch, the fresh-Session "Reasoning not reported" state, the keyboard-active row highlight,
// and the Model picker genuinely open in a screenshot (round 1's own screenshot was taken AFTER
// closing the popover with Escape). Isolated REFRACT_DATA_DIR/WEBVIEW2_USER_DATA_FOLDER/
// REFRACT_IMPORT_SOURCE_DIR/OMP_PROFILE and a scratch git repo; the seeded provider is
// unreachable (`http://127.0.0.1:1`), so no real credentials or network calls are ever made.
// Usage: CARGO_TARGET_DIR=<shared dir> node scripts/verify-564-gate2-live-check.mjs (requires a
// prior `pnpm tauri build --debug --no-bundle`).

import { mkdirSync, existsSync, copyFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForCdpTarget, CdpSession, launchViaJobObject, stopLauncher, sleep } from './verify-tauri-cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR;
const BUILD_OUTPUT_DIR = CARGO_TARGET_DIR ? path.join(CARGO_TARGET_DIR, 'debug') : path.join(REPO_ROOT, 'src-tauri', 'target', 'debug');
const CONFIG_DIR_NAME = process.env.PI_CONFIG_DIR || '.omp';
const SHOTS_DIR = 'C:/Users/shopwood/AppData/Local/Temp/refract-564-gate2-shots';

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${result.status}): ${result.stderr || result.stdout}`);
  return result;
}

function buildLauncher(dir) {
  mkdirSync(dir, { recursive: true });
  const src = path.join(__dirname, 'verify-tauri-launcher.rs');
  const out = path.join(dir, 'verify-tauri-launcher.exe');
  run('rustc', ['--edition', '2021', '-O', src, '-o', out]);
  return out;
}

function makeScratchRepo(dir) {
  mkdirSync(dir, { recursive: true });
  run('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  run('git', ['-C', dir, '-c', 'user.name=verify-564', '-c', 'user.email=verify-564@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}

// Non-reporting fake model (same pattern as the round 1 fixture): its own `get_state` never
// carries `thinkingLevel` back, which is exactly the condition both the Default-persistence fix
// and the "Reasoning not reported" state are for.
function ensureFakeModel(profile) {
  const agentDir = path.join(homedir(), CONFIG_DIR_NAME, 'profiles', profile, 'agent');
  mkdirSync(agentDir, { recursive: true });
  const yml = [
    'providers:',
    '  probe-fake:',
    '    baseUrl: http://127.0.0.1:1',
    '    auth: none',
    '    api: openai-completions',
    '    models:',
    '      - id: probe-fake-model',
    '        name: Probe Fake Model',
    '        api: openai-completions',
    '        contextWindow: 8000',
    '        maxTokens: 1000',
    '',
  ].join('\n');
  writeFileSync(path.join(agentDir, 'models.yml'), yml);
}

async function main() {
  const stamp = nowStamp();
  const scratchRoot = path.join(tmpdir(), `refract-564-gate2-live-check-${stamp}`);
  mkdirSync(scratchRoot, { recursive: true });
  const dataDir = path.join(scratchRoot, 'data'); // reused across BOTH launches, deliberately
  const repoDir = path.join(scratchRoot, 'repo');
  const exeDir = path.join(scratchRoot, 'exe');
  const importSourceDir = path.join(scratchRoot, 'electron-import-source-empty');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(importSourceDir, { recursive: true });
  makeScratchRepo(repoDir);
  mkdirSync(exeDir, { recursive: true });
  const exeSrc = path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
  if (!existsSync(exeSrc)) {
    throw new Error(`built exe not found at ${exeSrc} (CARGO_TARGET_DIR=${CARGO_TARGET_DIR ?? '(unset)'}) -- run the debug build first`);
  }
  const exePath = path.join(exeDir, 'refract-tauri.exe');
  copyFileSync(exeSrc, exePath);
  const webview2DataDir = path.join(exeDir, 'webview2-data'); // reused across BOTH launches too
  mkdirSync(webview2DataDir, { recursive: true });
  const launcherExe = buildLauncher(path.join(scratchRoot, 'launcher'));
  mkdirSync(SHOTS_DIR, { recursive: true });

  const results = [];
  function record(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' -- ' + JSON.stringify(detail) : ''}`);
  }

  const profile = `refract-564-gate2-${stamp.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}`;
  ensureFakeModel(profile);
  run('omp', ['--profile', profile, 'config', 'set', 'modelRoles', '{"default":"probe-fake/probe-fake-model"}', '--json']);

  async function launchAndConnect(port, pidFileName) {
    const env = {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
      REFRACT_DATA_DIR: dataDir,
      REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
      OMP_PROFILE: profile,
    };
    const pidFile = path.join(exeDir, pidFileName);
    const { child } = await launchViaJobObject(launcherExe, pidFile, exePath, [], { cwd: exeDir, env });
    const logLines = [];
    child.stdout?.on('data', (d) => logLines.push(d.toString()));
    child.stderr?.on('data', (d) => logLines.push(d.toString()));
    await waitForCdpTarget(port, { timeoutMs: 60_000 });
    const listResp = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const page = listResp.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) throw new Error('no page target with a debugger URL');
    const cdp = await CdpSession.connect(page.webSocketDebuggerUrl);
    await cdp.waitFor(`typeof window.refract === 'object'`, { timeoutMs: 30_000, label: 'bridge ready' });
    return { child, cdp, logLines };
  }

  let first;
  let second;
  try {
    // --- Launch 1: add repository, create/open a Session, exercise the Model picker and the
    // Default-persistence fix across a settle. ---
    first = await launchAndConnect(9391, 'target1.pid');
    record('bridge ready (launch 1)', true);

    // Drives the real UI (readiness screen -> Add repository dialog -> New session dialog) --
    // never raw `window.refract.*` calls for this part, since those update the backend without
    // the renderer's own stores necessarily reacting fast enough for the composer to actually be
    // in the DOM yet (round 1's own live check hit this exact timing bug).
    await first.cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'readiness green, Add repository enabled' },
    );
    await first.cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await first.cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
    await first.cdp.click(`document.querySelector('[role="dialog"] input')`);
    await first.cdp.send('Input.insertText', { text: repoDir });
    await first.cdp.clickByText('Add repository', { inDialog: true });
    await first.cdp.waitFor(
      `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
      { timeoutMs: 30_000, label: 'repository added, session-list row rendered' },
    );
    record('repository added via the UI', true);
    await first.cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await first.cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
      { timeoutMs: 15_000, label: 'New session dialog open, Create session enabled' },
    );
    await first.cdp.clickByText('Create session', { inDialog: true });
    await first.cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
    await first.cdp.waitFor(`!!document.querySelector('textarea[aria-label="Message"]')`, { timeoutMs: 60_000, label: 'composer mounted' });
    const sessionId = await first.cdp.evaluate(`window.refract.sessions.list().then(r => r.ok ? r.value[0]?.id : null)`);
    await first.cdp.waitFor(
      `window.refract.sessions.list().then(r => r.ok && r.value.find(s => s.id === ${JSON.stringify(sessionId)})?.status === 'idle')`,
      { timeoutMs: 60_000, label: 'session idle' },
    );
    record('session created and opened via the UI, composer mounted', true);

    // Fresh Session, nothing ever requested: must show "Reasoning not reported", NOT "Default"
    // (Stuart's correction -- the opposite of an earlier, wrong version of this same fix).
    const freshLabel = await first.cdp.evaluate(
      `Array.from(document.querySelectorAll('button')).find(e => (e.getAttribute('aria-label')||'').startsWith('Reasoning:'))?.textContent.trim()`,
    );
    record('A fresh Session (nothing ever requested) shows "Reasoning not reported", not "Default"', freshLabel === 'Reasoning not reported', { freshLabel });
    await first.cdp.screenshot(path.join(SHOTS_DIR, '1-composer-idle-fresh-not-reported.png'));

    // Model picker: open it and screenshot WHILE STILL OPEN (round 1's own screenshot was taken
    // after Escape had already closed it).
    await first.cdp.clickByLabel('Model: probe-fake/Probe Fake Model', { prefix: true });
    await first.cdp.waitFor(`!!document.querySelector('input[aria-label="Filter models"]')`, { timeoutMs: 5000, label: 'model popover open' });
    const popoverLabelled = await first.cdp.evaluate(
      `document.querySelector('[role="dialog"]')?.getAttribute('aria-label')`,
    );
    record('The Model popover has an accessible name ("Choose model")', popoverLabelled === 'Choose model', { popoverLabelled });
    await first.cdp.waitFor(
      `!Array.from(document.querySelectorAll('[role="option"]')).some(e => e.textContent.includes('Loading models'))`,
      { timeoutMs: 15_000, label: 'model catalog finished loading' },
    );
    await first.cdp.screenshot(path.join(SHOTS_DIR, '2-model-picker-open.png'));
    record('screenshot 2 (Model picker genuinely open, not closed)', true);

    // Real typing + ArrowDown to move the active option, screenshot the highlighted row.
    for (const ch of 'robe') {
      await first.cdp.send('Input.insertText', { text: ch });
      await sleep(30);
    }
    await first.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 40, key: 'ArrowDown' });
    await first.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 40, key: 'ArrowDown' });
    await sleep(100);
    const activeRowBorder = await first.cdp.evaluate(`(() => {
      const active = document.querySelector('[data-active="true"]');
      if (!active) return null;
      const style = getComputedStyle(active);
      return { borderLeftColor: style.borderLeftColor, borderLeftWidth: style.borderLeftWidth };
    })()`);
    record('The keyboard-active option has a real, non-transparent left border (gate round 2 contrast fix)', activeRowBorder && activeRowBorder.borderLeftColor !== 'rgba(0, 0, 0, 0)', activeRowBorder);
    await first.cdp.screenshot(path.join(SHOTS_DIR, '3-model-picker-active-row.png'));

    // Right-click guard still holds with the onMouseDown->onClick move (gate round 2 fix 4).
    const optionRect = await first.cdp.waitFor(
      `(() => { const el = document.querySelector('[role="option"][data-active="true"]'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`,
      { timeoutMs: 5000, label: 'active model option rect' },
    );
    await first.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: optionRect.x, y: optionRect.y, button: 'right', clickCount: 1 });
    await first.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: optionRect.x, y: optionRect.y, button: 'right', clickCount: 1 });
    await sleep(300);
    const afterRightClick = await first.cdp.evaluate(
      `window.refract.sessions.list().then(r => r.ok ? r.value.find(s => s.id === ${JSON.stringify(sessionId)})?.lastModel?.id : r)`,
    );
    record('A right-click on the active option still applies nothing (onClick, not onMouseDown)', afterRightClick === 'probe-fake-model', { afterRightClick });
    await first.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 27, key: 'Escape' });
    await first.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape' });
    await first.cdp.waitFor(`!document.querySelector('input[aria-label="Filter models"]')`, { timeoutMs: 5000, label: 'popover closed after Escape' });

    // Select Default: no toast, label flips to "Default".
    const toastsBefore = await first.cdp.evaluate(`document.querySelectorAll('[data-sonner-toast]').length`);
    await first.cdp.click(`Array.from(document.querySelectorAll('button')).find(e => (e.getAttribute('aria-label')||'').startsWith('Reasoning:'))`);
    await first.cdp.waitFor(`!!document.querySelector('[role="menuitemradio"]')`, { timeoutMs: 5000, label: 'reasoning menu open' });
    await first.cdp.click(`Array.from(document.querySelectorAll('[role="menuitemradio"]')).find(e => e.textContent.trim() === 'Default')`);
    await first.cdp.waitFor(
      `!!Array.from(document.querySelectorAll('button')).find(e => (e.getAttribute('aria-label')||'').startsWith('Reasoning: Default'))`,
      { timeoutMs: 10_000, label: 'Reasoning picker shows Default' },
    );
    const toastsAfterDefault = await first.cdp.evaluate(`document.querySelectorAll('[data-sonner-toast]').length`);
    record('Selecting Default applies with no new toast', toastsAfterDefault === toastsBefore, { toastsBefore, toastsAfterDefault });

    // Force a settle (a real turn against the unreachable provider, which will fail, but the
    // settle/sync_from_state path still runs) and confirm Default SURVIVES it (gate round 2's
    // central High fix).
    void first.cdp.evaluate(`window.refract.chat.send(${JSON.stringify(sessionId)}, 'hello')`);
    await first.cdp
      .waitFor(
        `window.refract.sessions.list().then(r => r.ok && r.value.find(s => s.id === ${JSON.stringify(sessionId)})?.status !== 'working')`,
        { timeoutMs: 30_000, label: 'turn settles (expected to fail, unreachable provider)' },
      )
      .catch(() => {});
    await sleep(500);
    const labelAfterSettle = await first.cdp.evaluate(
      `Array.from(document.querySelectorAll('button')).find(e => (e.getAttribute('aria-label')||'').startsWith('Reasoning:'))?.textContent.trim()`,
    );
    record('Default SURVIVES a settle (a real turn), not erased back to "Reasoning not reported"', labelAfterSettle === 'Default', { labelAfterSettle });
    await first.cdp.screenshot(path.join(SHOTS_DIR, '4-default-survives-settle.png'));
  } finally {
    if (first?.cdp) first.cdp.close();
    if (first?.child) await stopLauncher(first.child).catch(() => {});
  }

  // --- Relaunch (same REFRACT_DATA_DIR/profile): confirm Default survives an app restart too. ---
  try {
    second = await launchAndConnect(9392, 'target2.pid');
    record('bridge ready (relaunch)', true);
    const sessionsAfterRelaunch = await second.cdp.evaluate(`window.refract.sessions.list()`);
    const relaunchedSession = sessionsAfterRelaunch.ok ? sessionsAfterRelaunch.value[0] : null;
    record('The relaunched instance sees the same persisted Session', !!relaunchedSession, { lastThinkingLevel: relaunchedSession?.lastThinkingLevel });
    if (relaunchedSession) {
      await second.cdp.waitFor(`!!document.querySelector('[data-session-open]')`, { timeoutMs: 30_000, label: 'session row rendered after relaunch' });
      await second.cdp.click(`document.querySelector('[data-session-open=${JSON.stringify(relaunchedSession.id)}]')`);
      await second.cdp.waitFor(`!!document.querySelector('textarea[aria-label="Message"]')`, { timeoutMs: 30_000, label: 'composer mounted after relaunch' });
      const labelAfterRelaunch = await second.cdp.evaluate(
        `Array.from(document.querySelectorAll('button')).find(e => (e.getAttribute('aria-label')||'').startsWith('Reasoning:'))?.textContent.trim()`,
      );
      record('Default SURVIVES a full app relaunch', labelAfterRelaunch === 'Default', { labelAfterRelaunch });
      await second.cdp.screenshot(path.join(SHOTS_DIR, '5-default-survives-relaunch.png'));
      await sleep(300);

      // After a relaunch, the agent for this Session has not been (re)started in the new process
      // yet, so the Reasoning (and Model) pickers must refuse accessibly -- same contract as the
      // "not-idle" guard, just the other edge of it (decision 3, 2026-10-15, issue #564).
      const triggerState = await second.cdp.evaluate(`(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(e => (e.getAttribute('aria-label')||'').startsWith('Reasoning:'));
        return btn ? { label: btn.getAttribute('aria-label'), disabled: btn.getAttribute('aria-disabled') } : null;
      })()`);
      record(
        'Reasoning picker is accessibly disabled before the agent restarts after relaunch',
        triggerState?.disabled === 'true' && /start the agent/i.test(triggerState?.label || ''),
        triggerState,
      );
      await second.cdp.screenshot(path.join(SHOTS_DIR, '6-reasoning-disabled-before-restart.png'));
    }
  } catch (err) {
    console.error('verify-564-gate2-live-check: aborted during relaunch phase:', err);
    process.exitCode = 1;
  } finally {
    if (second?.cdp) second.cdp.close();
    if (second?.child) await stopLauncher(second.child).catch(() => {});
  }

  console.log('\n--- summary ---');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}: ${r.name}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} passed`);
  console.log(`scratch dir (to remove after this run): ${scratchRoot}`);
  console.log(`isolated profile (to remove after this run): ${path.join(homedir(), CONFIG_DIR_NAME, 'profiles', profile)}`);
  console.log(`screenshots: ${SHOTS_DIR}`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
