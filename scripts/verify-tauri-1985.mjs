#!/usr/bin/env node
// Live CDP check for issue #1985: the Ask card's recommended option is visibly marked, preselected, focused and one key from accepted.
// Drives the scratch Tauri debug build with the fake omp `ask` tape (Database: single choice, recommended index 1 = SQLite; Features: multiple choice, none).
// On main the SQLite row has no badge, no tint, no preselection, no focus and there is no "Use Recommended" button, so the first checks fail.
// Usage: CARGO_TARGET_DIR=<shared target dir> node scripts/verify-tauri-1985.mjs
// Env: REFRACT_1985_SHOTS_DIR overrides the evidence directory.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getFreePort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget, gitHead, computeDirty, sha256OfFile, buildAndCopyExeFresh } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe, buildOmpShim, connectCdp, pressRealEnter, worktreesDirFor } from './verify-tauri-560-helpers.mjs';
import { addRepository, createSessionViaQuickCreate, getAccessibleName } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1985';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1985_SHOTS_DIR || 'C:/Users/shopwood/AppData/Local/Temp/scratch/refract-1985/evidence';

const report = [];
const shotNames = [];
function check(ok, label, evidence) {
  report.push({ step: label, ok: ok === true, evidence });
  console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label} ${evidence === undefined ? '' : JSON.stringify(evidence)}`);
  if (ok !== true) process.exitCode = 1;
}

// The label span's first text node is the option's own label; the badge and the screen-reader suffix come after it.
const ROW = (role, label) => `Array.from(document.querySelectorAll('[role="${role}"]')).find((el) => el.querySelector('.col-start-2.break-words')?.firstChild?.nodeValue?.trim() === ${JSON.stringify(label)})`;
const BUTTON = (text) => `Array.from(document.querySelectorAll('button')).find((b) => b.textContent.replace(/\\s+/g, ' ').trim().startsWith(${JSON.stringify(text)}))`;
const TAB = (label) => `Array.from(document.querySelectorAll('[role="tab"]')).find((el) => el.querySelector('span')?.textContent.trim() === ${JSON.stringify(label)})`;
const FOCUSED_LABEL = `(() => { const a = document.activeElement; return { role: a?.getAttribute?.('role') ?? null, label: a?.querySelector?.('.col-start-2.break-words')?.firstChild?.nodeValue?.trim() ?? null, isBody: !a || a === document.body }; })()`;

async function shoot(cdp, name) {
  await sleep(500);
  await cdp.screenshot(path.join(SHOTS_DIR, name));
  shotNames.push(name);
}

/** A real key press, not a synthetic DOM event, so the row's own keydown handler and the radio group's arrow handling both run. */
async function pressKey(cdp, key, vk) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: vk, key, code: key });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: vk, key, code: key });
}

async function sendPrompt(cdp, text) {
  await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'composer enabled' });
  await cdp.click(`document.querySelector('[aria-label="Message"]')`);
  await cdp.send('Input.insertText', { text });
  await pressRealEnter(cdp);
}

const checked = (cdp, role, label) => cdp.evaluate(`(${ROW(role, label)})?.getAttribute('aria-checked') ?? null`);

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const scratch = (label) => mkdtempSync(path.join(tmpdir(), `refract-1985-${label}-`));
  const [dataDir, importSourceDir, repoDirBase, exeDir, launcherDir, shimDir] = ['data', 'import', 'repo', 'exe', 'launcher', 'shim'].map(scratch);
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1985');
  const debugLog = path.join(exeDir, 'fake-omp-invocations.log');
  const dirs = [dataDir, importSourceDir, repoDirBase, worktreesDirFor(repoDir), exeDir, launcherDir, shimDir];
  let cdp;
  let child;
  try {
    const launcherExe = buildLauncher(launcherDir);
    buildOmpShim(shimDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    report.push({ step: 'build identity', ok: true, evidence: { head: gitHead(REPO_ROOT), dirty: computeDirty(REPO_ROOT), exeSha256: built.hash, exeMtime: built.mtime, builtDuringThisRun: built.builtDuringThisRun } });
    check([exeDir, dataDir, importSourceDir].every((d) => d.startsWith(tmpdir())), 'Isolation: exe, data dir and import source are scratch dirs', { dataDir });

    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, built.dest, {
      port,
      dataDir,
      importSourceDir,
      pathPrepend: shimDir,
      logFile: path.join(SHOTS_DIR, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_DEBUG_LOG: debugLog,
        REFRACT_FAKE_OMP_SCENARIO: 'ask'
      }
    });
    child = launched.child;
    cdp = await connectCdp(port, launched.targetPid);

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]') || !!document.querySelector('[aria-label="Settings"]')`, { timeoutMs: 60_000, label: 'Readiness or main screen' });
    if (await cdp.evaluate(`!document.querySelector('[aria-label="Settings"]')`)) {
      await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return !!b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 90_000, label: 'Readiness green' });
      await addRepository(cdp, repoDir);
    }
    await createSessionViaQuickCreate(cdp, path.basename(repoDir));
    await sendPrompt(cdp, 'Please ask me the batch of questions now.');
    await cdp.waitFor(`document.querySelectorAll('[role="tab"]').length === 2 && !!(${ROW('radio', 'SQLite')})`, { timeoutMs: 90_000, label: 'ask card rendered with the Database question open' });
    await sleep(500);
    await shoot(cdp, '01-card-open-recommended-visible.png');

    // 1. The cue is visible text and an icon, not only the screen-reader suffix.
    const cue = await cdp.evaluate(`(() => {
      const row = ${ROW('radio', 'SQLite')}; const other = ${ROW('radio', 'Postgres')};
      const badge = row.querySelector('[data-recommended-badge]'); const r = badge?.getBoundingClientRect();
      return { hasBadge: !!badge, badgeText: badge?.textContent.trim() ?? null, hasIcon: !!badge?.querySelector('svg'), visible: !!r && r.width > 0 && r.height > 0, marked: row.hasAttribute('data-ask-recommended'), otherHasBadge: !!other.querySelector('[data-recommended-badge]') };
    })()`);
    check(cue.hasBadge && cue.badgeText === 'Recommended' && cue.hasIcon && cue.visible && cue.marked && !cue.otherHasBadge, '1. The recommended row shows an icon plus the text "Recommended"; the other row does not', cue);

    // 2. The row is tinted, so the cue is not text alone.
    const tint = await cdp.evaluate(`(() => { const bg = (el) => getComputedStyle(el).backgroundColor; return { recommended: bg(${ROW('radio', 'SQLite')}), plain: bg(${ROW('radio', 'Postgres')}) }; })()`);
    check(tint.recommended !== tint.plain && tint.recommended !== 'rgba(0, 0, 0, 0)', '2. The recommended row has its own surface tint, different from a plain row', tint);

    // 3. Screen readers still hear it.
    const name = await getAccessibleName(cdp, ROW('radio', 'SQLite'));
    check(/Recommended/.test(String(name?.name ?? name)), '3. The recommended row\'s accessible name still contains "Recommended"', name);

    // 4. Preselected and focused when the question opens.
    const picked = { sqlite: await checked(cdp, 'radio', 'SQLite'), postgres: await checked(cdp, 'radio', 'Postgres') };
    check(picked.sqlite === 'true' && picked.postgres === 'false', '4. The recommended option is preselected when a single-choice question opens', picked);
    const focus = await cdp.evaluate(FOCUSED_LABEL);
    check(focus.role === 'radio' && focus.label === 'SQLite', '5. The recommended row has focus when the card opens', focus);

    // 5. The button is present and labelled.
    const useButton = await cdp.evaluate(`(() => { const b = ${BUTTON('Use Recommended')}; return b ? { text: b.textContent.replace(/\\s+/g, ' ').trim(), disabled: b.getAttribute('aria-disabled') } : null; })()`);
    check(useButton !== null && useButton.text === 'Use Recommended ↵', '6. A "Use Recommended ↵" button is in the footer', useButton);

    // 6. Arrow up moves the pick off the recommendation; the button puts it back and moves on.
    await pressKey(cdp, 'ArrowUp', 38);
    await cdp.waitFor(`(${ROW('radio', 'Postgres')})?.getAttribute('aria-checked') === 'true'`, { timeoutMs: 10_000, label: 'arrow key moved the pick to Postgres' });
    await shoot(cdp, '02-pick-moved-off-recommended.png');
    await cdp.click(BUTTON('Use Recommended'));
    await cdp.waitFor(`${TAB('Features')}?.getAttribute('aria-selected') === 'true'`, { timeoutMs: 15_000, label: 'Use Recommended moved on to Features' });
    await cdp.click(TAB('Database'));
    await cdp.waitFor(`!!(${ROW('radio', 'SQLite')})`, { timeoutMs: 10_000, label: 'Database tab reopened' });
    check((await checked(cdp, 'radio', 'SQLite')) === 'true' && (await checked(cdp, 'radio', 'Postgres')) === 'false', '7. "Use Recommended" picked SQLite over the earlier Postgres pick', { sqlite: await checked(cdp, 'radio', 'SQLite') });

    // 7. Enter on the focused recommended row accepts it and moves on.
    await cdp.evaluate(`(${ROW('radio', 'SQLite')}).focus()`);
    await pressRealEnter(cdp);
    await cdp.waitFor(`${TAB('Features')}?.getAttribute('aria-selected') === 'true'`, { timeoutMs: 15_000, label: 'Enter on the recommended row moved on to Features' });
    check(true, '8. Enter on the recommended row accepts it and moves to the next question');
    const second = await cdp.evaluate(`({ useRecommended: !!(${BUTTON('Use Recommended')}), recommendedRows: document.querySelectorAll('[data-ask-recommended]').length, preticked: Array.from(document.querySelectorAll('[role="checkbox"]')).some((el) => el.getAttribute('aria-checked') === 'true') })`);
    check(!second.useRecommended && second.recommendedRows === 0 && !second.preticked, '9. A question with no recommendation shows no cue, no button and no pre-ticked box', second);
    await shoot(cdp, '03-features-no-recommendation.png');

    // 8. The wire answer carries the recommended pick.
    await cdp.click(ROW('checkbox', 'Auth'));
    await cdp.waitFor(`(${ROW('checkbox', 'Auth')})?.getAttribute('aria-checked') === 'true'`, { timeoutMs: 10_000, label: 'Auth ticked' });
    await cdp.waitFor(`!!(${BUTTON('Submit')})`, { timeoutMs: 15_000, label: 'primary button reads Submit' });
    await cdp.click(BUTTON('Submit'));
    await cdp.waitFor(`!${BUTTON('Submit')}`, { timeoutMs: 30_000, label: 'live card gone' });
    await sleep(1_000);
    const sentLine = readFileSync(debugLog, 'utf8').split('\n').find((l) => l.includes('RECV') && l.includes('"extension_ui_response"') && l.includes('"answers"'));
    const sent = sentLine ? JSON.parse(sentLine.match(/RECV (\{.*\}) \(waitingFor/)?.[1] ?? 'null') : null;
    const [db, features] = sent?.answers ?? [];
    check(JSON.stringify(db?.selectedOptions) === '["SQLite"]' && JSON.stringify(features?.selectedOptions) === '["Auth"]', '10. The agent received SQLite for Database and Auth for Features', sent);
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    console.error(err);
    try { if (cdp) await cdp.screenshot(path.join(SHOTS_DIR, '99-crash.png')); } catch {}
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    const hashes = {};
    for (const name of shotNames) {
      const file = path.join(SHOTS_DIR, name);
      if (existsSync(file)) hashes[name] = sha256OfFile(file);
    }
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    writeFileSync(path.join(SHOTS_DIR, 'sha256.json'), JSON.stringify(hashes, null, 2));
    for (const dir of dirs) await safeRmSync(dir, LOG);
  }
  const failed = report.filter((r) => !r.ok);
  console.log(`${LOG}: ${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`}; evidence in ${SHOTS_DIR}`);
}

main();
