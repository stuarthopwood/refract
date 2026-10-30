#!/usr/bin/env node
// Live CDP check: the Conversation history list shows a Conversation whose first user message
// starts after the old fixed 8 KB preview-scan window (the long-prelude file); it must list both
// seeded Conversations, not just the control one.
//
// Seeds two hand-built `.jsonl` Conversation files in the fake-omp session dir before launch;
// the `user-message-time` tape scripts startup, so no chat prompt is sent. A file name needs a
// 25-character `YYYY-MM-DDTHH-mm-ss-mmmZ_` prefix (`conversations.rs` `parse_file_name`).
//
// Not proven here (see `notExercised`): the 64 KiB hard cap listing an empty preview, no-user-
// message files being skipped, image-only first messages, and cheap listing of multi-MB files.

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
  clearKnownOutputFiles
} from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR =
  process.env.REFRACT_862_SHOTS_DIR ||
  path.join(tmpdir(), `refract-862-conversation-history-shots-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const SHOT_NAMES = ['01-conversation-history-open.png', 'report.json', 'app.log', 'fake-omp-invocations.log'];

const NORMAL_TITLE = 'Normal conversation (#862 check)';
const NORMAL_PREVIEW = "Short first message, well inside the old 8 KB window.";
const LONG_TITLE = 'Long-prelude conversation (#862 check)';
// Under PREVIEW_MAX_LENGTH (120 chars) so the preview text matches exactly, not truncated.
const LONG_PREVIEW = 'ISSUE862-LONG-PREVIEW-CHECK: real first user message, found past the old 8 KB window.';
const OLD_FIXED_WINDOW_BYTES = 8 * 1024; // conversations.rs `PREVIEW_SCAN_BYTES` on origin/main
const NEW_HARD_CAP_BYTES = 64 * 1024; // conversations.rs `PREVIEW_SCAN_HARD_CAP_BYTES`, this fix

/** File name shape: `<timestamp with ':'/'.' replaced by '-'>_<id>.jsonl`, 25-char prefix. */
function conversationFileName(isoTimestamp, id) {
  const prefix = isoTimestamp.replace(/[:.]/g, '-');
  if (prefix.length !== 24) throw new Error(`conversationFileName: expected a 24-char dash-replaced prefix, got ${prefix.length} ("${prefix}")`);
  return `${prefix}_${id}.jsonl`;
}

function writeConversationFile(dir, isoTimestamp, id, lines) {
  const filePath = path.join(dir, conversationFileName(isoTimestamp, id));
  writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return filePath;
}

async function main() {
  let shimDir, dataDir, importSourceDir, repoDir, exeDir, launcherDir, conversationFileDir;
  let child;
  let targetPid;
  let cdp;
  const findings = [];
  const failures = [];
  const notExercised = [
    'A Conversation whose 64 KiB hard cap (PREVIEW_SCAN_HARD_CAP_BYTES, enforced via ' +
      'AsyncReadExt::take, conversations.rs) is hit before a user message is found is still ' +
      'listed (title, empty preview) rather than hidden -- proven by reading the take()-limited ' +
      'handle and the cap_hit fallback, not by seeding a third fixture file past the cap here.',
    'A Conversation that reaches real end-of-file within the cap with genuinely no user message ' +
      'anywhere is skipped, unchanged from the existing rule -- proven by reading that unchanged ' +
      'code path, not by seeding a fixture file with zero user messages here.',
    'A genuinely multi-megabyte Conversation file staying cheap to list is proven by reading ' +
      'read_conversation_file\'s own early-break-on-match and its take()-enforced hard cap, not ' +
      'by this script constructing a multi-MB fixture on disk.',
    'A Conversation whose first role:\'user\' message is image-only (or otherwise has an empty ' +
      'or missing content field) is still listed with an empty preview rather than hidden -- ' +
      'proven by reading read_conversation_file\'s own role:"user" match arm (conversations.rs): ' +
      'any such message sets preview immediately, via content.map(extract_user_text)' +
      '.unwrap_or_default(), never gated on non-empty text, not by seeding a third fixture ' +
      'file with an image-only or textless first message here.'
  ];
  let exeHash = null;
  let gitHeadSha = null;
  let dirty = 'unknown';
  let BUILD_OUTPUT_DIR = null;
  try {
    clearKnownOutputFiles(SHOTS_DIR, 'refract-862-conversation-history-shots', SHOT_NAMES);
    mkdirSync(SHOTS_DIR, { recursive: true });
    BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
    dirty = dirtyLines === null ? 'unknown' : dirtyLines.length ? dirtyLines : false;

    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-862-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-862-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-862-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-862-repo-')), 'verify-862-conversation-history');
    const repoName = path.basename(repoDir);
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-862-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-862-launcher-'));
    conversationFileDir = mkdtempSync(path.join(tmpdir(), 'refract-862-conv-'));
    const port = await getFreePort();

    console.log(`verify-862: git HEAD ${gitHeadSha}${dirtyLines && dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
    console.log(`verify-862: shots dir ${SHOTS_DIR}`);
    console.log(`verify-862: conversation dir ${conversationFileDir}`);

    // --- Seed the two real Conversation files `conversations.list` will scan on disk. ---
    const normalFile = writeConversationFile(conversationFileDir, '2026-10-18T09:00:00.000Z', 'sess862a', [
      { type: 'title', title: NORMAL_TITLE },
      { type: 'session', version: 3, id: 'sess862-a', timestamp: '2026-10-18T09:00:00.000Z', cwd: repoDir },
      {
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: '2026-10-18T09:00:01.000Z',
        message: { role: 'user', content: NORMAL_PREVIEW }
      }
    ]);

    const fillerText = 'x'.repeat(8700); // matches issue #862's own observed ~8.6 KB memory_recall entry
    const preludeLines = [
      { type: 'title', title: LONG_TITLE },
      { type: 'session', version: 3, id: 'sess862-b', timestamp: '2026-10-18T09:05:00.000Z', cwd: repoDir },
      { type: 'model_change', id: 'mc1', parentId: null, timestamp: '2026-10-18T09:05:00.100Z', model: 'example-provider/example-model-1', role: 'default' },
      { type: 'thinking_level_change', id: 'tl1', parentId: 'mc1', timestamp: '2026-10-18T09:05:00.200Z', thinkingLevel: 'medium' },
      { type: 'service_tier_change', id: 'st1', parentId: 'tl1', timestamp: '2026-10-18T09:05:00.300Z', serviceTier: null },
      { type: 'custom', id: 'cr1', parentId: 'st1', timestamp: '2026-10-18T09:05:00.400Z', customType: 'memory_recall', data: { text: fillerText } },
      {
        type: 'custom_message',
        id: 'cp1',
        parentId: 'cr1',
        timestamp: '2026-10-18T09:05:00.500Z',
        customType: 'eager-todo-prelude',
        content: 'Todo prelude filler, matching issue #862\'s own observed ~804 B entry.',
        display: true
      },
      {
        type: 'custom_message',
        id: 'cp2',
        parentId: 'cp1',
        timestamp: '2026-10-18T09:05:00.600Z',
        customType: 'eager-task-prelude',
        content: 'Task prelude filler, matching issue #862\'s own observed ~850 B entry.',
        display: true
      }
    ];
    const prefixBytes = Buffer.byteLength(preludeLines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
    console.log(`verify-862: long-prelude file's own prefix (before the first user message) is ${prefixBytes} bytes`);
    if (prefixBytes <= OLD_FIXED_WINDOW_BYTES) {
      throw new Error(
        `verify-862: fixture does not reproduce the bug -- prefix is only ${prefixBytes} bytes, not past the old fixed ${OLD_FIXED_WINDOW_BYTES}-byte window`
      );
    }
    const userMessageLine = { type: 'message', id: 'm2', parentId: 'cp2', timestamp: '2026-10-18T09:05:01.500Z', message: { role: 'user', content: LONG_PREVIEW } };
    const totalFileBytes = prefixBytes + Buffer.byteLength(JSON.stringify(userMessageLine) + '\n', 'utf8');
    if (totalFileBytes >= NEW_HARD_CAP_BYTES) {
      throw new Error(
        `verify-862: fixture overshoots the fix's own hard cap -- the prelude plus the real user message line is ${totalFileBytes} bytes, at or past the new ${NEW_HARD_CAP_BYTES}-byte cap, so the fix would also miss it`
      );
    }
    const longFile = writeConversationFile(conversationFileDir, '2026-10-18T09:05:01.000Z', 'sess862b', [...preludeLines, userMessageLine]);
    findings.push(
      `Seeded two real Conversation files in ${conversationFileDir}: "${path.basename(normalFile)}" (first user message near the top) and ` +
        `"${path.basename(longFile)}" (first user message ${prefixBytes} bytes in, past the old ${OLD_FIXED_WINDOW_BYTES}-byte window, ` +
        `under the new ${NEW_HARD_CAP_BYTES}-byte hard cap).`
    );

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-862' });
    const exePath = built.dest;
    exeHash = built.hash;
    console.log(`verify-862: built exe copied to ${exePath}`);

    const launched = await launchBuiltExeWithEnv(launcherExe, exePath, {
      port,
      dataDir,
      importSourceDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'user-message-time',
        // Pointing `sessionFile` at the "normal" file makes the scanned session dir hold both seeded files.
        REFRACT_FAKE_OMP_CONVERSATION_FILE: normalFile,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(exeDir, 'fake-omp-invocations.log')
      }
    });
    child = launched.child;
    targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-862: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green' }
    );

    // Fails if the fake-omp shim was shadowed or crashed; `exeDir` is fresh per run, so the log
    // cannot be a leftover.
    const debugLogPath = path.join(exeDir, 'fake-omp-invocations.log');
    if (!existsSync(debugLogPath)) {
      throw new Error(`verify-862: fake-omp debug log not found at ${debugLogPath} -- the fake omp shim never ran (shim confirmed check).`);
    }
    const debugLogFirstLine = readFileSync(debugLogPath, 'utf8').split('\n')[0] ?? '';
    if (!/^pid=\d+ argv=/.test(debugLogFirstLine)) {
      throw new Error(`verify-862: fake-omp debug log's first line does not match the expected "pid=<pid> argv=..." startup line (shim confirmed check); got: ${JSON.stringify(debugLogFirstLine)}`);
    }
    findings.push(`Fake omp shim confirmed: debug log's first line is its own startup pid line (${debugLogPath}).`);

    await addRepository(cdp, repoDir);
    await createSessionViaQuickCreate(cdp, repoName);
    findings.push('Session created in the scratch repo, agent attached (fake omp, user-message-time.jsonl scenario, no prompt sent).');

    await cdp.clickByLabel('Conversation history');
    await cdp.waitFor(`!!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'Conversation history dialog open' });
    await cdp.waitFor(
      `!((document.querySelector('[role="dialog"]')?.textContent || '').includes('Loading'))`,
      { timeoutMs: 15_000, label: 'Conversation history list finished loading' }
    );
    await cdp.screenshot(path.join(SHOTS_DIR, '01-conversation-history-open.png'));

    const rows = await cdp.evaluate(`
      Array.from(document.querySelectorAll('[role="dialog"] ul li button[data-choice-item]')).map((btn) => ({
        title: btn.children[0] ? (btn.children[0].querySelector('span')?.textContent ?? null) : null,
        preview: btn.children[2] ? btn.children[2].textContent : null
      }))
    `);
    console.log('verify-862: conversation history rows', JSON.stringify(rows));

    // Must fail when the old 8 KB scan window skips the long-prelude file (reads 1, not 2).
    if (rows.length !== 2) {
      failures.push(
        `Conversation history dialog shows ${rows.length} row(s), expected 2 -- the long-prelude Conversation (first user message ${prefixBytes} bytes in, past the old fixed 8 KB window) was hidden instead of listed.`
      );
    } else {
      findings.push('Conversation history dialog shows exactly 2 rows: both the normal and the long-prelude Conversation are listed.');
    }

    const normalRow = rows.find((row) => row.title === NORMAL_TITLE);
    if (!normalRow) {
      failures.push(`No row with title "${NORMAL_TITLE}" found.`);
    } else if (normalRow.preview !== NORMAL_PREVIEW) {
      failures.push(`Normal Conversation row's preview is "${normalRow.preview}", expected "${NORMAL_PREVIEW}".`);
    } else {
      findings.push('Normal Conversation row has the expected title and preview (control case).');
    }

    const longRow = rows.find((row) => row.title === LONG_TITLE);
    if (!longRow) {
      failures.push(`No row with title "${LONG_TITLE}" found -- the long-prelude Conversation was hidden.`);
    } else if (longRow.preview !== LONG_PREVIEW) {
      failures.push(
        `Long-prelude Conversation row's preview is "${longRow.preview}", expected "${LONG_PREVIEW}" -- the bounded scan did not find the real first user message past the prelude.`
      );
    } else {
      findings.push(
        `Long-prelude Conversation row is listed with its real title and the correct preview text, found ${prefixBytes} bytes into the file -- the bounded line-streaming scan (read_conversation_file, PREVIEW_SCAN_HARD_CAP_BYTES) located the first user message past the old fixed 8 KB window.`
      );
    }

    const report = {
      gitHead: gitHeadSha,
      dirty,
      exeSha256: exeHash,
      findings,
      failures,
      notExercised,
      exitCode: failures.length > 0 ? 1 : 0
    };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== verify-862: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-862: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-862: NOT EXERCISED (genuine skips only) ===');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-862: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
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
    console.error('verify-862: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) {
      await stopLauncher(child).catch(() => {});
      if (targetPid != null) {
        const stillRunningExePath = getProcessExecutablePath(targetPid);
        if (stillRunningExePath) {
          console.warn(`verify-862: process ${targetPid} still appears to be running after stopLauncher (exe path: ${stillRunningExePath}) -- cleanup may be incomplete.`);
        } else {
          console.log(`verify-862: confirmed process ${targetPid} exited after stopLauncher.`);
        }
      }
    }
    try {
      if (exeDir && existsSync(path.join(exeDir, 'app.log'))) copyFileSync(path.join(exeDir, 'app.log'), path.join(SHOTS_DIR, 'app.log'));
      if (exeDir && existsSync(path.join(exeDir, 'fake-omp-invocations.log'))) copyFileSync(path.join(exeDir, 'fake-omp-invocations.log'), path.join(SHOTS_DIR, 'fake-omp-invocations.log'));
    } catch (err) {
      console.warn('verify-862: could not preserve logs:', err.message);
    }
    await safeRmSync(shimDir);
    await safeRmSync(dataDir);
    await safeRmSync(importSourceDir);
    await safeRmSync(repoDir);
    await safeRmSync(exeDir);
    await safeRmSync(launcherDir);
    await safeRmSync(conversationFileDir);
  }
}

main().catch((err) => {
  console.error('verify-862: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
