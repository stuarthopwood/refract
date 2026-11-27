#!/usr/bin/env node
// Live CDP check for #472 (FR-194..FR-196): the nested Conversation list under each Session row. Covers the default-collapsed
// row, the chevron with its 5-newest cap and "Show all (N)", activating and deleting entries, the arrow-key model, no chevron
// on an archived Session, and the expand state surviving an app restart. All data is scratch (REFRACT_DATA_DIR, the recorded-
// frame fake omp in serve mode), never the real %APPDATA%\refract-tauri or ~/.omp.
// Usage: CARGO_TARGET_DIR=<shared target> node scripts/verify-tauri-472.mjs

import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, statSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget, assertExeUnchanged, citeScreenshots } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate, pressKey, ARCHIVED_TRIGGER_FINDER, groupState } from './verify-tauri-session-list-helpers.mjs';
import { HISTORY_DIALOG_FINDER, rowButtonFinder } from './verify-439-history-truncate-fixtures.mjs';
import { latestSessionIdAndName, waitForSessionStatus } from './verify-tauri-560-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TASK_DIR = process.env.REFRACT_472_DIR || path.join(tmpdir(), 'scratch', 'live-472');
const EVIDENCE_DIR = path.join(TASK_DIR, 'evidence');
const LOG = 'verify-472';

const SEED_PREFIX_MS = Date.UTC(2026, 0, 1);
const fileStamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-');
const ALERT = `document.querySelector('[data-slot="alert-dialog-content"]')`;
const KEY = { right: [39, 'ArrowRight'], left: [37, 'ArrowLeft'], down: [40, 'ArrowDown'], up: [38, 'ArrowUp'] };

// A Session's own `<li>`: the open button sits in an inner element, the nested lists beside it.
const sessionLi = (id) => `document.querySelector('[data-session-open="${id}"]')?.closest('li')`;
const chevron = (id) => `(${sessionLi(id)})?.querySelector('[data-testid="session-conversations"] button[aria-expanded]')`;
const groupOf = (id) => `document.getElementById('${id}-conversations')`;
const openButton = (id) => `document.querySelector('[data-session-open="${id}"]')`;
const entryByName = (id, ordinal) => `(${groupOf(id)})?.querySelector('[data-conversation-file*="_seed-${String(ordinal).padStart(2, '0')}.jsonl"]')`;

/** Writes an older Conversation file with a user message, so Refract lists it (a title-only file is hidden). */
function seedConversation(dir, ordinal) {
  const id = `seed-${String(ordinal).padStart(2, '0')}`;
  const file = path.join(dir, `${fileStamp(SEED_PREFIX_MS + ordinal * 60_000)}_${id}.jsonl`);
  const message = { role: 'user', content: [{ type: 'text', text: `Seeded Conversation ${ordinal}` }], timestamp: 0 };
  writeFileSync(file, `${JSON.stringify({ type: 'title', title: `Seed ${ordinal}` })}\n${JSON.stringify({ type: 'message', message })}\n`);
  return file;
}

async function main() {
  const failures = [];
  const findings = [];
  const results = [];
  let current = null;
  const check = (condition, message) => {
    (condition ? findings : failures).push(condition ? `PASS: ${message}` : message);
    current?.[condition ? 'pass' : 'fail'].push(message);
    if (!condition) console.error(`${LOG}: FAIL: ${message}`);
  };
  const realRegistry = path.join(process.env.APPDATA ?? '', 'refract-tauri', 'registry.json');
  const realRegistryMtimeBefore = existsSync(realRegistry) ? statSync(realRegistry).mtimeMs : null;
  let child, cdp, exeHash, exePath, runDir;
  const shots = [];
  try {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const buildOutputDir = requireSharedCargoTarget(REPO_ROOT);
    runDir = mkdtempSync(path.join(TASK_DIR, 'run-'));
    const dirs = Object.fromEntries(['shim', 'data', 'import', 'repo', 'exe', 'launcher', 'serve'].map((n) => [n, path.join(runDir, n)]));
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
    const repoDir = makeScratchRepo(path.join(dirs.repo, 'proj472'), 'verify-472');
    const repoName = path.basename(repoDir);

    buildOmpShim(dirs.shim);
    const launcherExe = buildLauncher(dirs.launcher);
    const built = buildAndCopyExeFresh(dirs.exe, buildOutputDir, REPO_ROOT, { label: LOG });
    exePath = built.dest;
    exeHash = built.hash;

    const launch = async (first) => {
      const port = await getFreePort();
      const launched = await launchBuiltExeWithEnv(launcherExe, exePath, {
        port,
        dataDir: dirs.data,
        importSourceDir: dirs.import,
        pathPrepend: dirs.shim,
        logFile: path.join(dirs.exe, 'app.log'),
        extraEnv: {
          REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
          REFRACT_FAKE_OMP_NODE: process.execPath,
          REFRACT_FAKE_OMP_SCENARIO: 'conversations-1861',
          REFRACT_FAKE_OMP_SERVE_ROOT: dirs.serve,
          REFRACT_FAKE_OMP_DEBUG_LOG: path.join(dirs.exe, 'fake-omp-invocations.log')
        }
      });
      child = launched.child;
      cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
      if (!isTargetOwningPort(port, launched.targetPid)) throw new Error(`${LOG}: CDP target on port ${port} is not owned by pid ${launched.targetPid}`);
      assertExeUnchanged(exePath, exeHash, 'after launch', LOG);
      // The first-run button only exists before a Project is added; a relaunch lands on the Session list.
      if (first) await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
    };
    await launch(true);

    const shot = async (name) => {
      await cdp.screenshot(path.join(EVIDENCE_DIR, name));
      shots.push(name);
    };
    const scenario = async (name, title, fn) => {
      current = { name, title, pass: [], fail: [] };
      try {
        await fn();
      } catch (err) {
        current.fail.push(`threw: ${err?.message ?? err}`);
        failures.push(`${name}: threw: ${err?.stack ?? err}`);
        console.error(`${LOG}: ${name} threw:`, err?.stack ?? err);
        await shot(`zz-${name}-error.png`).catch(() => {});
      }
      results.push({ name, title, verdict: current.fail.length === 0 && current.pass.length > 0 ? 'PASS' : 'FAIL', pass: current.pass, fail: current.fail });
      console.log(`${LOG}: [${results.at(-1).verdict}] ${name}: ${title}`);
      current = null;
    };
    const readList = (id) =>
      cdp.evaluate(`(() => {
        const g = ${groupOf(id)};
        if (!g) return null;
        const rows = Array.from(g.querySelectorAll('[data-conversation-file]'));
        return {
          entries: g.querySelectorAll('[data-conversation-entry]').length,
          files: rows.map((r) => r.dataset.conversationFile),
          titles: rows.map((r) => r.querySelector('button span')?.textContent ?? ''),
          current: rows.filter((r) => r.querySelector('button')?.getAttribute('aria-current') === 'true' && r.querySelector('[data-slot="badge"]')).map((r) => r.dataset.conversationFile),
          text: g.textContent
        };
      })()`);
    const expanded = (id) => cdp.evaluate(`(${chevron(id)})?.getAttribute('aria-expanded') ?? null`);
    const ipcConversations = async (id) => {
      const r = await cdp.evaluate(`window.refract.conversations.list(${JSON.stringify(id)})`);
      if (!r.ok) throw new Error(`conversations.list failed: ${JSON.stringify(r)}`);
      return r.value;
    };
    const newSession = async (label) => {
      const before = (await cdp.evaluate(`window.refract.sessions.list().then((r) => r.value.map((s) => s.id))`)) ?? [];
      await createSessionViaQuickCreate(cdp, repoName);
      const found = await latestSessionIdAndName(cdp, repoName, before);
      await waitForSessionStatus(cdp, found.id, 'idle');
      const sent = await cdp.evaluate(`window.refract.chat.send(${JSON.stringify(found.id)}, ${JSON.stringify(`First message of ${label}`)})`);
      if (!sent.ok) throw new Error(`chat.send failed: ${JSON.stringify(sent)}`);
      await cdp.waitFor(`window.refract.sessions.list().then((r) => r.ok && r.value.some((s) => s.id === ${JSON.stringify(found.id)} && s.sessionDir && s.currentConversation))`, { timeoutMs: 30_000, label: `${label} has a Conversation` });
      await waitForSessionStatus(cdp, found.id, 'idle');
      const row = await cdp.evaluate(`window.refract.sessions.list().then((r) => r.value.find((s) => s.id === ${JSON.stringify(found.id)}))`);
      return { id: found.id, name: found.name, sessionDir: row.sessionDir };
    };

    await addRepository(cdp, repoDir);
    const a = await newSession('A');
    const seeded = [];
    for (let i = 1; i <= 6; i++) seeded.push(seedConversation(a.sessionDir, i));
    const seedFile = (ordinal) => seeded[ordinal - 1];

    // --- 1. Seven Conversations, one current; the row is collapsed by default. ---
    await scenario('s1-collapsed-default', 'row with 7 Conversations is collapsed by default', async () => {
      await cdp.waitFor(`window.refract.conversations.list(${JSON.stringify(a.id)}).then((r) => r.ok && r.value.length === 7)`, { timeoutMs: 20_000, label: '7 Conversations listed' });
      const all = await ipcConversations(a.id);
      check(all.length === 7 && all.filter((c) => c.isCurrent).length === 1, `the Session has 7 Conversations, exactly one current (got ${all.length}, ${all.filter((c) => c.isCurrent).length} current)`);
      await cdp.waitFor(`!!(${chevron(a.id)})`, { timeoutMs: 20_000, label: 'chevron rendered on the Session row' });
      check((await expanded(a.id)) === 'false', `chevron reports aria-expanded=false, got ${await expanded(a.id)}`);
      check((await cdp.evaluate(`!(${groupOf(a.id)})`)) === true, 'no Conversation list is mounted while collapsed');
      await shot('01-collapsed-default.png');
    });

    // --- 2. Expand: 5 newest + "Show all (7)", reveal all, mark the current one. ---
    await scenario('s2-expand-cap-showall', 'chevron expands to 5 newest plus Show all (7); all 7 reveal; current marked', async () => {
      await cdp.click(chevron(a.id));
      await cdp.waitFor(`(${groupOf(a.id)})?.querySelectorAll('[data-conversation-file]').length === 5`, { timeoutMs: 20_000, label: '5 Conversations shown' });
      check((await expanded(a.id)) === 'true', 'chevron reports aria-expanded=true once clicked');
      let list = await readList(a.id);
      check(list.files.length === 5, `5 Conversations shown (got ${list.files.length})`);
      const newest = [6, 5, 4, 3].map((n) => `_seed-0${n}.jsonl`);
      check(newest.every((suffix, i) => list.files[i + 1]?.endsWith(suffix)), `after the current one the order is newest first (${list.files.map((f) => path.basename(f)).join(', ')})`);
      check(list.text.includes('Show all (7)'), '"Show all (7)" is offered');
      check(list.current.length === 1, `exactly one entry is marked current (${list.current.length})`);
      await shot('02-expanded-capped.png');
      await cdp.click(`Array.from((${groupOf(a.id)}).querySelectorAll('button')).find((b) => b.textContent.trim() === 'Show all (7)')`);
      await cdp.waitFor(`(${groupOf(a.id)})?.querySelectorAll('[data-conversation-file]').length === 7`, { timeoutMs: 20_000, label: 'all 7 shown' });
      list = await readList(a.id);
      check(list.files.length === 7 && !list.text.includes('Show all'), 'Show all reveals all 7 and the action goes away');
      const all = await ipcConversations(a.id);
      const currentFile = all.find((c) => c.isCurrent)?.file;
      check(list.current.length === 1 && list.current[0] === currentFile, `the marked entry is the current Conversation from IPC (${path.basename(currentFile ?? '')})`);
      await shot('03-expanded-all.png');
    });

    // --- 3. Activate a non-current entry. ---
    await scenario('s3-activate', 'activating a non-current entry makes it current; header switcher agrees', async () => {
      const target = seedFile(6);
      const title = await cdp.evaluate(`(${entryByName(a.id, 6)})?.querySelector('button span')?.textContent ?? null`);
      check(!!title, `entry for seed-06 found with title ${JSON.stringify(title)}`);
      await cdp.click(`(${entryByName(a.id, 6)})?.querySelector('button')`);
      await cdp.waitFor(`(${entryByName(a.id, 6)})?.querySelector('button')?.getAttribute('aria-current') === 'true'`, { timeoutMs: 30_000, label: 'seed-06 becomes current' });
      const list = await readList(a.id);
      check(list.current.length === 1 && list.current[0] === target, `seed-06 is the only current entry (${list.current.map((f) => path.basename(f))})`);
      const ipc = (await ipcConversations(a.id)).find((c) => c.isCurrent);
      check(ipc?.file === target, `IPC agrees: current is ${path.basename(ipc?.file ?? '')}`);
      await cdp.waitFor(`!!document.querySelector('[aria-label="Conversation history"]')`, { timeoutMs: 15_000, label: 'header switcher present' });
      await cdp.clickByLabel('Conversation history');
      await cdp.waitFor(`!!(${rowButtonFinder(title)})`, { timeoutMs: 20_000, label: 'history dialog lists seed-06' });
      check((await cdp.evaluate(`!!(${rowButtonFinder(title)})?.querySelector('[data-slot="badge"]')`)) === true, 'header switcher shows the Current badge on the same Conversation');
      await shot('04-activated-switcher-agrees.png');
      await cdp.click(`Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => /^close$/i.test((b.getAttribute('aria-label') || b.textContent).trim()))`);
      await cdp.waitFor(`!(${HISTORY_DIALOG_FINDER})`, { timeoutMs: 10_000, label: 'history dialog closed' });
    });

    // --- 4. Delete a non-current entry via the dialog. ---
    await scenario('s4-delete', 'deleting a non-current entry removes it from the list and from disk', async () => {
      const doomed = seedFile(2);
      const title = await cdp.evaluate(`(${entryByName(a.id, 2)})?.querySelector('button span')?.textContent ?? null`);
      check(existsSync(doomed) && !!title, `seed-02 ("${title}") is listed and on disk before the delete`);
      await cdp.click(`(${entryByName(a.id, 2)})?.querySelector('button[aria-label^="Delete "]')`);
      await cdp.waitFor(`(${ALERT})?.textContent.includes(${JSON.stringify(title)}) === true`, { timeoutMs: 20_000, label: 'delete confirm dialog names the Conversation' });
      check(existsSync(doomed), 'file still on disk while the confirm is open');
      await shot('05-delete-confirm.png');
      await cdp.click(`Array.from(document.querySelectorAll('[data-slot="alert-dialog-action"]')).find((el) => el.textContent.trim() === 'Delete')`);
      const outcome = await cdp.waitFor(`(() => { if (!(${entryByName(a.id, 2)})) return 'gone'; const t = document.querySelector('p[role="alert"]')?.textContent.trim(); return t ? 'failed: ' + t : false; })()`, { timeoutMs: 30_000, label: 'entry gone from the list or a delete failure' });
      check(outcome === 'gone', `the entry left the list (${outcome}; file on disk: ${existsSync(doomed)})`);
      await cdp.waitFor(`!(${ALERT})`, { timeoutMs: 10_000, label: 'confirm dialog closed' });
      check(!existsSync(doomed), 'the Conversation file is gone from disk');
      const list = await readList(a.id);
      check(list.files.length === 6 && !list.files.some((f) => f === doomed), `the list now shows 6 entries without it (${list.files.length})`);
      check(!(await ipcConversations(a.id)).some((c) => c.file === doomed), 'conversations.list no longer reports it');
      await shot('06-after-delete.png');
    });

    // --- 5. Keyboard model. ---
    await scenario('s5-keyboard', 'Right expands, Down enters the list, Down/Up move, Left returns to the Session row', async () => {
      await cdp.click(chevron(a.id));
      await cdp.waitFor(`!(${groupOf(a.id)})`, { timeoutMs: 10_000, label: 'list collapsed again' });
      await cdp.evaluate(`(${openButton(a.id)}).focus()`);
      check((await cdp.evaluate(`document.activeElement === ${openButton(a.id)}`)) === true, 'the Session row open button is focused');
      const hasChildren = await cdp.evaluate(`(${sessionLi(a.id)})?.querySelectorAll('[data-session-open]').length > 1`);
      check(hasChildren === false, 'the Session has no child Sessions, so plain Right (not Alt+Right) applies');
      await pressKey(cdp, ...KEY.right, KEY.right[1]);
      await cdp.waitFor(`(${groupOf(a.id)})?.querySelectorAll('[data-conversation-entry]').length > 0`, { timeoutMs: 20_000, label: 'list opened by Right' });
      check((await expanded(a.id)) === 'true', 'Right expanded the list');
      const focusIndex = () => cdp.evaluate(`(() => { const g = ${groupOf(a.id)}; const entries = Array.from(g?.querySelectorAll('[data-conversation-entry]') ?? []); return entries.indexOf(document.activeElement); })()`);
      await pressKey(cdp, ...KEY.down, KEY.down[1]);
      check((await focusIndex()) === 0, `Down from the Session row focuses the first entry (index ${await focusIndex()})`);
      await pressKey(cdp, ...KEY.down, KEY.down[1]);
      check((await focusIndex()) === 1, `Down moves to the second entry (index ${await focusIndex()})`);
      await shot('07-keyboard-entry-focus.png');
      await pressKey(cdp, ...KEY.up, KEY.up[1]);
      check((await focusIndex()) === 0, `Up moves back to the first entry (index ${await focusIndex()})`);
      await pressKey(cdp, ...KEY.left, KEY.left[1]);
      check((await cdp.evaluate(`document.activeElement === ${openButton(a.id)}`)) === true, 'Left returns focus to the Session row open button');
    });

    // --- 6. Archived Session: no chevron. ---
    await scenario('s6-archived-no-chevron', 'an archived Session shows no chevron', async () => {
      const b = await newSession('B');
      await cdp.waitFor(`!!(${chevron(b.id)})`, { timeoutMs: 20_000, label: 'active Session B has a chevron' });
      const archived = await cdp.evaluate(`window.refract.sessions.archive(${JSON.stringify(b.id)})`);
      check(archived.ok === true, `sessions.archive succeeded (${JSON.stringify(archived)})`);
      await cdp.waitFor(`!!document.querySelector('[data-archived-group]')`, { timeoutMs: 20_000, label: 'archived group rendered' });
      if ((await groupState(cdp, ARCHIVED_TRIGGER_FINDER)) === 'closed') await cdp.click(ARCHIVED_TRIGGER_FINDER);
      await cdp.waitFor(`!!document.querySelector('[data-archived-group] [data-session-open="${b.id}"]')`, { timeoutMs: 20_000, label: 'archived Session B row visible' });
      check((await cdp.evaluate(`!(${chevron(b.id)})`)) === true, 'the archived Session row has no Conversation chevron');
      check((await cdp.evaluate(`!(${sessionLi(b.id)})?.querySelector('[data-testid="session-conversations"]')`)) === true, 'the archived Session row has no Conversation list region at all');
      check((await cdp.evaluate(`!!(${chevron(a.id)})`)) === true, 'the active Session A still has its chevron (the check can fail)');
      await shot('08-archived-no-chevron.png');
    });

    // --- 7. Expand state survives a restart. ---
    await scenario('s7-restart-persists', 'expand state survives an app restart on the same data dir', async () => {
      check((await expanded(a.id)) === 'true', 'Session A is expanded before the restart');
      await sleep(1500);
      cdp.close();
      await stopLauncher(child);
      await sleep(1500);
      await launch(false);
      await cdp.waitFor(`!!(${chevron(a.id)})`, { timeoutMs: 60_000, label: 'Session A row back after restart' });
      await cdp.waitFor(`(${chevron(a.id)})?.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 20_000, label: 'Session A still expanded' });
      check((await expanded(a.id)) === 'true', 'Session A is still expanded after the restart');
      await cdp.waitFor(`(${groupOf(a.id)})?.querySelectorAll('[data-conversation-file]').length >= 1`, { timeoutMs: 20_000, label: 'entries listed after restart' });
      const list = await readList(a.id);
      check(list.files.length >= 5, `its Conversations are listed again (${list.files.length})`);
      await shot('09-restart-still-expanded.png');
    });
  } catch (err) {
    failures.push(`unhandled: ${err?.stack ?? err}`);
    console.error(`${LOG}: unhandled error:`, err?.stack ?? err);
    if (cdp) await cdp.screenshot(path.join(EVIDENCE_DIR, 'zz-error.png')).catch(() => {});
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    const realRegistryMtimeAfter = existsSync(realRegistry) ? statSync(realRegistry).mtimeMs : null;
    if (realRegistryMtimeBefore !== realRegistryMtimeAfter) failures.push('the real %APPDATA%\\refract-tauri\\registry.json mtime changed during the run');
    try {
      for (const name of ['app.log', 'fake-omp-invocations.log']) {
        const from = path.join(runDir ?? '', 'exe', name);
        if (runDir && existsSync(from)) copyFileSync(from, path.join(EVIDENCE_DIR, name));
      }
      const dirty = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).stdout.split('\n').filter(Boolean);
      writeFileSync(
        path.join(EVIDENCE_DIR, 'report.json'),
        JSON.stringify({ gitHead: gitHead(REPO_ROOT), dirty, exeSha256: exeHash ?? null, realRegistryMtimeBefore, realRegistryMtimeAfter, results, failures, screenshots: shots.length ? citeScreenshots(EVIDENCE_DIR, shots) : [] }, null, 2)
      );
    } catch (err) {
      console.warn(`${LOG}: could not write report.json: ${err.message}`);
    }
    if (runDir) await safeRmSync(runDir, LOG);
    for (const r of results) console.log(`${LOG}: ${r.verdict} ${r.name}${r.fail.length ? ` -- ${r.fail.join(' | ')}` : ''}`);
    console.log(`${LOG}: ${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILURE(S)`} (${findings.length} checks passed); evidence in ${EVIDENCE_DIR}`);
    if (failures.length > 0) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`${LOG}: unhandled error:`, err?.stack ?? err);
  process.exitCode = 1;
});
