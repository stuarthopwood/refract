// #1184: live proof of the OMP settings guard against a scratch OMP agent dir.
// Safety: OMP honours PI_CODING_AGENT_DIR, so the app and every `omp config` call here use
// C:\Users\shopwood\r1184\agent; Stuart's real ~/.omp/agent config is never read or written.
// Usage: node scripts/verify-1184-omp-settings-guard.mjs   (builds the debug exe, then drives it)
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, isTargetOwningPort, sleep } from './verify-tauri-cdp.mjs';
import {
  buildLauncher, buildAndCopyExeFresh, launchBuiltExe, requireSharedCargoTarget, gitHead, sha256OfFile, safeRmSync,
} from './verify-tauri-scratch-helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = 'C:\\Users\\shopwood\\r1184';
const AGENT_DIR = path.join(ROOT, 'agent');
const SHOTS = path.join(ROOT, 'shots');
const CDP_PORT = 9347;

function omp(args) {
  const r = spawnSync('omp', args, { encoding: 'utf8', shell: true, windowsHide: true, env: { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR } });
  if (r.status !== 0) throw new Error(`omp ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

function ompGet(key) {
  return JSON.parse(omp(['config', 'get', key, '--json'])).value;
}

function check(name, ok, detail = '') {
  if (!ok) throw new Error(`CHECK FAILED: ${name} ${detail}`);
  console.log(`verify-1184: ok - ${name}`);
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(AGENT_DIR, { recursive: true });
  const scratchPath = omp(['config', 'path']);
  check('omp config path follows the scratch agent dir', scratchPath.toLowerCase().startsWith(AGENT_DIR.toLowerCase()), scratchPath);
  omp(['config', 'set', 'advisor.reviewMode', 'turn']);
  omp(['config', 'set', 'task.softRequestBudget', '--json', '--', '999']);
  const before = { review: ompGet('advisor.reviewMode'), budget: ompGet('task.softRequestBudget') };
  check('scratch config starts drifted', before.review === 'turn' && Number(before.budget) === 999, JSON.stringify(before));

  const head = gitHead(REPO_ROOT);
  console.log(`verify-1184: HEAD ${head}`);
  const exeDir = ROOT;
  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1184-data-'));
  const launcherExe = buildLauncher(exeDir);
  const { dest: exePath, hash } = buildAndCopyExeFresh(exeDir, requireSharedCargoTarget(REPO_ROOT), REPO_ROOT, { label: 'verify-1184' });
  console.log(`verify-1184: exe ${exePath} sha256 ${hash}`);
  let child, cdp;
  try {
    process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
    const launched = await launchBuiltExe(launcherExe, exePath, { port: CDP_PORT, dataDir, importSourceDir: path.join(ROOT, 'no-import'), logFile: path.join(ROOT, 'app.log') });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(CDP_PORT, { timeoutMs: 60_000 }));
    check('CDP target is the launched app', isTargetOwningPort(CDP_PORT, launched.targetPid));

    await cdp.waitFor(`!!document.querySelector('[data-sonner-toast]')`, { timeoutMs: 45_000, label: 'guard toast shown' });
    const toastText = await cdp.evaluate(`document.querySelector('[data-sonner-toast]').innerText`);
    check('toast names the reset', /Reset \d+ OMP settings?/.test(toastText) && toastText.includes('advisor.reviewMode turn → agent-end'), toastText);
    const live = await cdp.evaluate(`!!document.querySelector('[data-sonner-toaster]') && document.querySelectorAll('[data-sonner-toast]').length`);
    check('exactly one guard toast', live === 1, String(live));
    await sleep(1000);
    await cdp.screenshot(path.join(SHOTS, '01-guard-toast.png'));

    // KEYBOARD: Tab to the toast's Details button and require a painted outline (a11y gate).
    const tab = async () => {
      for (const type of ['keyDown', 'keyUp']) {
        await cdp.send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      }
    };
    const onDetails = `!!document.activeElement?.matches?.('[data-sonner-toast] [data-button]') && document.activeElement.innerText.trim() === 'Details'`;
    await cdp.evaluate('document.activeElement?.blur?.()');
    let reached = false;
    for (let i = 0; i < 80 && !reached; i++) {
      await tab();
      reached = await cdp.evaluate(onDetails);
    }
    check('Tab reaches the toast Details button', reached);
    const ring = await cdp.evaluate(`(() => { const s = getComputedStyle(document.activeElement); return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), color: s.outlineColor }; })()`);
    check('focused Details button paints a visible outline', ring.style === 'solid' && ring.width >= 2 && ring.color !== 'rgba(0, 0, 0, 0)', JSON.stringify(ring));
    await cdp.screenshot(path.join(SHOTS, '03-details-keyboard-focus.png'));

    await cdp.evaluate(`document.activeElement.click()`);
    await cdp.waitFor(`!!document.querySelector('[data-testid="omp-guard-details"]')`, { label: 'Details dialog open' });
    const details = await cdp.evaluate(`document.querySelector('[data-testid="omp-guard-details"]').innerText`);
    check('Details lists advisor.reviewMode old → new', details.includes('advisor.reviewMode: turn → agent-end'), details);
    check('Details lists task.softRequestBudget old → new', details.includes('task.softRequestBudget: 999 → 80'), details);
    await cdp.screenshot(path.join(SHOTS, '02-guard-details.png'));

    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.waitFor(`!document.querySelector('[data-testid="omp-guard-details"]') && document.activeElement !== document.body`, { label: 'focus leaves <body> after Details closes' });
    check('scratch advisor.reviewMode reset to agent-end', ompGet('advisor.reviewMode') === 'agent-end');
    check('scratch task.softRequestBudget reset to 80', Number(ompGet('task.softRequestBudget')) === 80);
    const shots = ['01-guard-toast.png', '02-guard-details.png', '03-details-keyboard-focus.png'].map((n) => ({ n, sha256: sha256OfFile(path.join(SHOTS, n)) }));
    const report = { head, exe: exePath, exeSha256: hash, scratchAgentDir: AGENT_DIR, before, shots };
    writeFileSync(path.join(ROOT, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`verify-1184: PASS ${JSON.stringify(report)}`);
  } finally {
    cdp?.close();
    if (child) await stopLauncher(child);
    await safeRmSync(dataDir, 'verify-1184');
  }
}

main().catch((err) => {
  console.error('verify-1184: FAIL');
  console.error(err);
  process.exitCode = 1;
});
