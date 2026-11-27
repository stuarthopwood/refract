#!/usr/bin/env node
// Live CDP check for #2161 (FR-186..FR-190): sizes and total in the history dialog, deleting a non-current
// Conversation (confirm, freed space, file and attachments gone), the current-Conversation refusal, and the
// two Settings > Sessions cleanup previews (which must delete nothing). Every step also asserts the disk.
// All data is scratch (REFRACT_DATA_DIR, REFRACT_OMP_SESSIONS_DIR, the recorded-frame fake omp), never the
// real %APPDATA%\refract-tauri or ~/.omp. The cleanup confirm buttons are unit-tested in Rust, not driven here.

import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, getProcessExecutablePath, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget, assertExeUnchanged, citeScreenshots } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate, pressEscape } from './verify-tauri-session-list-helpers.mjs';
import { HISTORY_DIALOG_FINDER, rowButtonFinder, writeConversationFile, conversationFileName } from './verify-439-history-truncate-fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TASK_DIR = process.env.REFRACT_2161_DIR || path.join(tmpdir(), 'scratch', 'lane-2161-live');
const EVIDENCE_DIR = path.join(TASK_DIR, 'evidence');
const LOG = 'verify-2161';

const CURRENT_TITLE = 'Current conversation (#2161 check)';
const DOOMED_TITLE = 'Doomed conversation (#2161 check)';
const KEPT_TITLE = 'Kept conversation (#2161 check)';
const AGED_TITLE = 'Aged conversation (#2161 check)';
const PROMPT_TEXT = 'Issue #2161 check: settle a turn so the current Conversation is marked.';
const DAY_MS = 86_400_000;

const ALERT = `document.querySelector('[data-slot="alert-dialog-content"]')`;
const navButton = (label) => `Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === ${JSON.stringify(label)})`;
const previewButton = (label) => `Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === ${JSON.stringify(label)})`;
const RETENTION_PREVIEW = 'Preview old Conversations…';
const SWEEP_PREVIEW = 'Preview leftover logs…';

/** Same rounding as `formatByteSize` in the renderer, so the expected text is computed independently of the UI. */
function formatByteSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** How OMP names a session folder for a cwd: lower-cased, `\` folded, `:`/`\` to `-`, wrapped in `--` (mirrors `encode_cwd`). */
function encodeFolder(cwd) {
  const normalised = cwd.replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '');
  return `--${normalised.replace(/[:\\]/g, '-')}--`;
}

/** Every file under `dir` as relative path -> byte size; the disk-state evidence each step compares. */
function snapshot(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = statSync(full).size;
    }
  };
  walk(dir);
  return out;
}

const treeBytes = (dir) => Object.values(snapshot(dir)).reduce((sum, size) => sum + size, 0);

function conversationLines(id, iso, title, cwd, padBytes) {
  return [
    { type: 'title', title },
    { type: 'session', version: 3, id, timestamp: iso, cwd },
    { type: 'message', id: `${id}-m1`, parentId: null, timestamp: iso, message: { role: 'user', content: `First message of ${title}` } },
    { type: 'message', id: `${id}-m2`, parentId: `${id}-m1`, timestamp: iso, message: { role: 'assistant', content: 'x'.repeat(padBytes) } }
  ];
}

async function main() {
  const failures = [];
  const findings = [];
  const check = (condition, message) => {
    if (condition) findings.push(`PASS: ${message}`);
    else {
      failures.push(message);
      console.error(`${LOG}: FAIL: ${message}`);
    }
  };
  const realRegistry = path.join(process.env.APPDATA ?? '', 'refract-tauri', 'registry.json');
  const realRegistryMtimeBefore = existsSync(realRegistry) ? statSync(realRegistry).mtimeMs : null;
  let child, targetPid, cdp, exeHash, exePath, runDir;
  const shots = [];
  try {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    mkdirSync(path.join(TASK_DIR), { recursive: true });
    const buildOutputDir = requireSharedCargoTarget(REPO_ROOT);
    runDir = mkdtempSync(path.join(TASK_DIR, 'run-'));
    const dirs = Object.fromEntries(['shim', 'data', 'import', 'repo', 'exe', 'launcher', 'sessions'].map((n) => [n, path.join(runDir, n)]));
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
    const repoDir = makeScratchRepo(path.join(dirs.repo, 'proj2161'), 'verify-2161');
    const repoName = path.basename(repoDir);

    // --- Seed the scratch Sessions folder: the Session's own folder (four Conversations), an orphan worktree log folder and a plain folder. ---
    const sessionFolder = path.join(dirs.sessions, encodeFolder(repoDir));
    mkdirSync(sessionFolder, { recursive: true });
    const seed = (iso, id, title, pad) => writeConversationFile(sessionFolder, iso, id, conversationLines(id, iso, title, repoDir, pad));
    const currentFile = seed('2026-11-20T10:00:00.000Z', 'cur2161', CURRENT_TITLE, 2_000);
    const doomedFile = seed('2026-11-21T10:00:00.000Z', 'del2161', DOOMED_TITLE, 40_000);
    const keptFile = seed('2026-11-22T10:00:00.000Z', 'keep2161', KEPT_TITLE, 300_000);
    const agedFile = seed('2026-07-01T10:00:00.000Z', 'old2161', AGED_TITLE, 5_000);
    const doomedArtifacts = doomedFile.replace(/\.jsonl$/, '');
    mkdirSync(doomedArtifacts, { recursive: true });
    writeFileSync(path.join(doomedArtifacts, 'attachment.bin'), Buffer.alloc(12_000, 7));
    const aged = new Date(Date.now() - 120 * DAY_MS);
    utimesSync(agedFile, aged, aged);

    const worktreesRoot = path.join(path.dirname(repoDir), 'pinion-worktrees', repoName);
    const orphanName = encodeFolder(path.join(worktreesRoot, 'quiet-otter'));
    const orphanDir = path.join(dirs.sessions, orphanName);
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(path.join(orphanDir, conversationFileName('2026-11-01T09:00:00.000Z', 'orphan2161')), 'orphan log\n'.repeat(500));
    const plainName = encodeFolder(path.join(runDir, 'plain-notes'));
    const plainDir = path.join(dirs.sessions, plainName);
    mkdirSync(plainDir, { recursive: true });
    writeFileSync(path.join(plainDir, conversationFileName('2026-11-01T09:00:00.000Z', 'plain2161')), 'plain folder log\n'.repeat(300));

    const sizeOf = (file) => statSync(file).size + (existsSync(file.replace(/\.jsonl$/, '')) ? treeBytes(file.replace(/\.jsonl$/, '')) : 0);
    const expected = new Map([
      [CURRENT_TITLE, sizeOf(currentFile)],
      [DOOMED_TITLE, sizeOf(doomedFile)],
      [KEPT_TITLE, sizeOf(keptFile)],
      [AGED_TITLE, sizeOf(agedFile)]
    ]);
    const orphanBytes = treeBytes(orphanDir);

    buildOmpShim(dirs.shim);
    const launcherExe = buildLauncher(dirs.launcher);
    const built = buildAndCopyExeFresh(dirs.exe, buildOutputDir, REPO_ROOT, { label: LOG });
    exePath = built.dest;
    exeHash = built.hash;
    const port = await getFreePort();
    const launched = await launchBuiltExeWithEnv(launcherExe, exePath, {
      port,
      dataDir: dirs.data,
      importSourceDir: dirs.import,
      pathPrepend: dirs.shim,
      logFile: path.join(dirs.exe, 'app.log'),
      extraEnv: {
        REFRACT_OMP_SESSIONS_DIR: dirs.sessions,
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'user-message-time',
        REFRACT_FAKE_OMP_CONVERSATION_FILE: currentFile,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(dirs.exe, 'fake-omp-invocations.log')
      }
    });
    child = launched.child;
    targetPid = launched.targetPid;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, targetPid)) throw new Error(`${LOG}: CDP target on port ${port} is not owned by pid ${targetPid}`);
    assertExeUnchanged(exePath, exeHash, 'after launch', LOG);

    const shot = async (name) => {
      await cdp.screenshot(path.join(EVIDENCE_DIR, name));
      shots.push(name);
    };
    const waitForDialogText = (needle, label) =>
      cdp.waitFor(`(${ALERT})?.textContent.includes(${JSON.stringify(needle)}) === true`, { timeoutMs: 20_000, label });
    const cancelAlert = async (label) => {
      await cdp.click(`Array.from((${ALERT})?.querySelectorAll('button') ?? []).find((el) => ['Cancel', 'Close'].includes(el.textContent.trim()))`);
      await cdp.waitFor(`!(${ALERT})`, { timeoutMs: 10_000, label });
    };

    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green' }
    );
    const debugFirstLine = (readFileSync(path.join(dirs.exe, 'fake-omp-invocations.log'), 'utf8').split('\n')[0] ?? '');
    check(/^pid=\d+ argv=/.test(debugFirstLine), 'fake omp shim ran (debug log starts with its own pid line)');
    await addRepository(cdp, repoDir);
    await createSessionViaQuickCreate(cdp, repoName);
    await cdp.typeIntoByLabel('Message', PROMPT_TEXT);
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`!!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Approve')`, { timeoutMs: 30_000, label: 'Tool-call approval card' });
    await cdp.clickByText('Approve');
    await cdp.waitFor(`(document.querySelector('[aria-label="Transcript"]')?.textContent ?? '').includes('xyzzy9')`, { timeoutMs: 60_000, label: 'Turn settled' });
    await cdp.waitFor(`window.refract.sessions.list().then((r) => r.ok && r.value.length === 1 && r.value[0].currentConversation != null && r.value[0].status === 'idle')`, {
      timeoutMs: 30_000,
      label: 'Session idle with its current Conversation set'
    });
    const sessions = await cdp.evaluate(`window.refract.sessions.list().then((r) => r.value.map((s) => ({ id: s.id, sessionDir: s.sessionDir, currentConversation: s.currentConversation })))`);
    check(sessions.length === 1 && path.resolve(sessions[0].sessionDir ?? '').toLowerCase() === path.resolve(sessionFolder).toLowerCase(), 'the only Session is the scratch one, its session_dir is the seeded folder');

    // --- 1. Switcher: sizes per row and the total. ---
    await cdp.clickByLabel('Conversation history');
    await cdp.waitFor(`!!(${HISTORY_DIALOG_FINDER}) && (${HISTORY_DIALOG_FINDER}).querySelectorAll('ul li').length === 4`, { timeoutMs: 20_000, label: 'History dialog lists 4 Conversations' });
    const readSizes = () =>
      cdp.evaluate(`(() => { const dialog = ${HISTORY_DIALOG_FINDER}; return { summary: dialog.querySelector('p.text-xs')?.textContent ?? null, rows: Array.from(dialog.querySelectorAll('ul li')).map((li) => ({ title: li.querySelector('button')?.children[0]?.querySelector('span')?.textContent ?? '', meta: li.querySelector('button')?.children[1]?.textContent ?? '' })) }; })()`);
    const before = await readSizes();
    for (const [title, bytes] of expected) {
      const row = before.rows.find((r) => r.title === title);
      check(row?.meta.endsWith(`· ${formatByteSize(bytes)}`) === true, `row "${title}" shows ${formatByteSize(bytes)} (file plus attachments, from disk): got ${JSON.stringify(row?.meta)}`);
    }
    const totalBytes = [...expected.values()].reduce((a, b) => a + b, 0);
    check(before.summary === `4 Conversations · ${formatByteSize(totalBytes)} total`, `summary reads "4 Conversations · ${formatByteSize(totalBytes)} total": got ${JSON.stringify(before.summary)}`);
    await shot('01-switcher-sizes-total.png');

    // --- 2. Delete a non-current Conversation. ---
    await cdp.clickByLabel(`Delete ${DOOMED_TITLE}`);
    await waitForDialogText('cannot be undone', 'Delete confirm dialog open');
    const confirmText = await cdp.evaluate(`(${ALERT}).textContent`);
    check(confirmText.includes(DOOMED_TITLE) && confirmText.includes(formatByteSize(expected.get(DOOMED_TITLE))), `confirm names the Conversation and its size ${formatByteSize(expected.get(DOOMED_TITLE))}`);
    check(existsSync(doomedFile), 'file still on disk while the confirm is open');
    await shot('02-delete-confirm.png');
    await cdp.click(`Array.from(document.querySelectorAll('[data-slot="alert-dialog-action"]')).find((el) => el.textContent.trim() === 'Delete')`);
    const freedText = `Deleted “${DOOMED_TITLE}”. Freed ${formatByteSize(expected.get(DOOMED_TITLE))}.`;
    await cdp.waitFor(`(${HISTORY_DIALOG_FINDER})?.textContent.includes(${JSON.stringify(freedText)}) === true`, { timeoutMs: 20_000, label: `freed notice "${freedText}"` });
    const afterDelete = await readSizes();
    check(!afterDelete.rows.some((r) => r.title === DOOMED_TITLE) && afterDelete.rows.length === 3, 'deleted row left the list (3 rows remain)');
    check(afterDelete.summary === `3 Conversations · ${formatByteSize(totalBytes - expected.get(DOOMED_TITLE))} total`, `summary updated to the remaining total: got ${JSON.stringify(afterDelete.summary)}`);
    check(!existsSync(doomedFile) && !existsSync(doomedArtifacts), 'disk: Conversation file and its attachments folder are gone');
    check([currentFile, keptFile, agedFile].every(existsSync) && existsSync(orphanDir) && existsSync(plainDir), 'disk: the other Conversations and both log folders are untouched');
    await shot('03-deleted-freed-space.png');

    // --- 3. The current Conversation is refused. ---
    await cdp.clickByLabel(`Delete ${CURRENT_TITLE}`);
    await waitForDialogText('The current Conversation cannot be deleted.', 'refusal dialog open');
    const refusal = await cdp.evaluate(`({ text: (${ALERT}).textContent, hasDelete: Array.from((${ALERT}).querySelectorAll('button')).some((el) => el.textContent.trim() === 'Delete') })`);
    check(refusal.text.includes('This Conversation cannot be deleted') && !refusal.hasDelete, 'refusal shown with no Delete button offered');
    check(existsSync(currentFile), 'disk: the current Conversation file is still there');
    await shot('04-current-refused.png');
    await cancelAlert('refusal dialog closed');
    await pressEscape(cdp);
    await cdp.waitFor(`!(${HISTORY_DIALOG_FINDER})`, { timeoutMs: 10_000, label: 'history dialog closed' });

    // --- 4. Settings > Sessions > Conversation cleanup. ---
    await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
    await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings open' });
    await cdp.click(navButton('Sessions'));
    await cdp.waitFor(`document.body.textContent.includes('Conversation cleanup')`, { timeoutMs: 30_000, label: 'Sessions section rendered' });
    await cdp.click(`document.getElementById('conversation-retention-toggle')`);
    await cdp.waitFor(`document.getElementById('conversation-retention-toggle')?.getAttribute('aria-checked') === 'true' && ${previewButton(RETENTION_PREVIEW)}?.getAttribute('aria-disabled') !== 'true'`, {
      timeoutMs: 15_000,
      label: 'retention switched on, Preview enabled'
    });
    const diskBeforePreviews = snapshot(dirs.sessions);

    await cdp.click(previewButton(RETENTION_PREVIEW));
    await waitForDialogText('in total', 'retention preview open');
    const retention = await cdp.evaluate(`({ title: (${ALERT}).querySelector('[data-slot="alert-dialog-title"]')?.textContent, text: (${ALERT}).textContent, items: Array.from((${ALERT}).querySelectorAll('ul li')).map((li) => li.textContent) })`);
    check(retention.title === 'Delete old Conversations?', 'retention preview dialog opened');
    check(retention.items.length === 1 && retention.items[0].includes(path.basename(agedFile)), `retention preview lists exactly the aged file ${path.basename(agedFile)}: got ${JSON.stringify(retention.items)}`);
    check(retention.text.includes(`1 Conversation, ${formatByteSize(expected.get(AGED_TITLE))} in total.`), `retention preview totals ${formatByteSize(expected.get(AGED_TITLE))}`);
    check(!retention.text.includes(path.basename(currentFile)) && !retention.text.includes(path.basename(keptFile)), 'retention preview omits the current and the recent Conversation');
    await shot('05-retention-preview.png');
    check(JSON.stringify(snapshot(dirs.sessions)) === JSON.stringify(diskBeforePreviews), 'disk: retention preview deleted nothing');
    await cancelAlert('retention preview closed');

    await cdp.click(previewButton(SWEEP_PREVIEW));
    await waitForDialogText('in total', 'sweep preview open');
    const sweep = await cdp.evaluate(`({ title: (${ALERT}).querySelector('[data-slot="alert-dialog-title"]')?.textContent, text: (${ALERT}).textContent, items: Array.from((${ALERT}).querySelectorAll('ul li')).map((li) => li.textContent) })`);
    check(sweep.title === 'Delete leftover Session logs?', 'sweep preview dialog opened');
    check(sweep.items.length === 1 && sweep.items[0].includes(orphanName), `sweep preview lists exactly the orphan folder ${orphanName}: got ${JSON.stringify(sweep.items)}`);
    check(!sweep.text.includes(plainName) && !sweep.text.includes(path.basename(sessionFolder)), 'sweep preview omits the plain non-Project folder and the live Session folder');
    check(sweep.text.includes(`1 log folder, ${formatByteSize(orphanBytes)} in total.`), `sweep preview totals ${formatByteSize(orphanBytes)}`);
    await shot('06-sweep-preview.png');
    check(JSON.stringify(snapshot(dirs.sessions)) === JSON.stringify(diskBeforePreviews), 'disk: sweep preview deleted nothing');
    await cancelAlert('sweep preview closed');
    await sleep(200);
    assertExeUnchanged(exePath, exeHash, 'end of run', LOG);
  } catch (err) {
    failures.push(`run aborted: ${err?.stack ?? err}`);
    console.error(`${LOG}: FAILED:`, err?.stack ?? err);
    try {
      if (cdp) await cdp.screenshot(path.join(EVIDENCE_DIR, '99-failure.png'));
    } catch {
      // best effort
    }
  } finally {
    if (cdp) cdp.close();
    if (child) {
      await stopLauncher(child).catch(() => {});
      if (targetPid != null && getProcessExecutablePath(targetPid)) failures.push(`target pid ${targetPid} still running after stopLauncher`);
    }
    const realRegistryMtimeAfter = existsSync(realRegistry) ? statSync(realRegistry).mtimeMs : null;
    const realUntouched = realRegistryMtimeBefore === realRegistryMtimeAfter;
    if (!realUntouched) failures.push('the real %APPDATA%\\refract-tauri\\registry.json mtime changed during the run');
    const dirty = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).stdout.split('\n').filter(Boolean);
    try {
      writeFileSync(
        path.join(EVIDENCE_DIR, 'report.json'),
        JSON.stringify({ gitHead: gitHead(REPO_ROOT), dirty, exeSha256: exeHash ?? null, realRegistryMtimeBefore, realRegistryMtimeAfter, findings, failures, screenshots: shots.length ? citeScreenshots(EVIDENCE_DIR, shots) : [] }, null, 2)
      );
    } catch (err) {
      console.warn(`${LOG}: could not write report.json: ${err.message}`);
    }
    if (runDir) await safeRmSync(runDir, LOG);
    console.log(`${LOG}: ${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILURE(S)`} (${findings.length} checks passed); evidence in ${EVIDENCE_DIR}`);
    if (failures.length > 0) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`${LOG}: unhandled error:`, err?.stack ?? err);
  process.exitCode = 1;
});
