#!/usr/bin/env node
// Live check for issue #926 ("attach any file type, inlining text files up to 256 KB and sending
// other files as a path"). Drives a REAL built Tauri debug exe over CDP against a FAKE `omp`
// (`verify-tauri-fake-omp.mjs`, `session` scenario) so no model cost/network is needed.
//
// IMPORTANT LIMITATION (stated per the lane's own gate checklist, "never claim a test that did
// not happen"): CDP cannot drive a native Win32 Open-File dialog (`attachments.pickFiles`'s own
// `blocking_pick_files()`), and this harness has no working synthetic-OS-drag-drop story for
// Tauri's native `onDragDropEvent` either (unlike the dead Electron-era `getPathForFile` DOM
// `drop` path other `verify-*.mjs` scripts in this repo still reference). Per this story's own
// brief ("if the native dialog can't be driven, use the drop/IPC path and say so"), this script
// instead calls the exposed `window.refract.attachments.readFile`/`readImageFile` IPC methods
// DIRECTLY -- the real Rust round trip the picker/drop path would otherwise call for it -- to
// prove the classification logic (inline vs path, the 256 KB cap, the NUL/UTF-8 binary check),
// and drives a real `window.refract.chat.send(...)` carrying a hand-built `[[refract-attachments]]`
// marker (the exact text `anyFileAttachments.ts`'s `buildFileAttachmentText` would have produced)
// to prove the full send -> `transcript.rs` marker-parse -> sent-bubble-chip pipeline end to end.
// The Attach button's own native picker, native OS drag-drop, and a PENDING (not-yet-sent) chip's
// keyboard Remove are therefore NOT exercised here -- they stay code-reviewed only and belong on
// the verification backlog issue (#650) until a future harness can drive them.
//
// Usage (after a `pnpm tauri build --debug --no-bundle` on this head, shared target dir set):
//   CARGO_TARGET_DIR=<shared target dir> CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0 \
//     node scripts/verify-926-attach-any-file.mjs

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CdpSession, waitForCdpTarget, getFreePort, stopLauncher, sleep, createReportLogger } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  citeScreenshots,
  buildAndCopyExeFresh,
  launchBuiltExe,
  safeRmSync,
  requireSharedCargoTarget
} from './verify-tauri-scratch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);

const SHOTS_DIR = process.env.REFRACT_926_SHOTS_DIR || path.join(tmpdir(), 'refract-926-attach-any-file-shots', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(SHOTS_DIR, { recursive: true });
const report = [];
const log = createReportLogger(path.join(SHOTS_DIR, 'report.log'));

// #926 grill decision 3: the fixed inline cap and the binary sniff window -- matches
// `file_attachments.rs`'s own `MAX_INLINE_FILE_BYTES`/`BINARY_SNIFF_PREFIX_BYTES`.
const MAX_INLINE_FILE_BYTES = 256 * 1024;

const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'dark-high-contrast', name: 'Dark high contrast' }
];

/** Builds the exact `[[refract-attachments]]` marker text `anyFileAttachments.ts`'s own
 * `buildFileAttachmentText` produces for one inline file -- so `chat.send` below exercises the
 * REAL `transcript.rs` parser against text in the documented shape, without needing to drive the
 * composer UI to build it. */
function buildInlineMarkerBlock(name, content) {
  const longestBacktickRun = (content.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
  return `Attached file "${name}" (${Buffer.byteLength(content, 'utf8')} bytes, inlined below):\n${fence}${name}\n${content}\n${fence}`;
}

function buildPathMarkerBlock(name, byteLength, absolutePath) {
  return `Attached file "${name}" (${byteLength} bytes, sent as path, read with your own tools): ${absolutePath}`;
}

async function main() {
  const head = gitHead(REPO_ROOT);
  log(`#926 live check starting at head ${head}`);

  const launcherExe = buildLauncher(SHOTS_DIR);
  const scratch = makeScratchRepo(mktemp('repo'), '926-attach-any-file');

  // Fixture files to attach, written into the scratch repo's own worktree so a RELATIVE,
  // worktree-contained token resolves the same way a real Attach-button pick would.
  const smallTextPath = path.join(scratch.worktreeDir, 'small-note.txt');
  writeFileSync(smallTextPath, 'hello from a small text attachment\n', 'utf8');

  const overCapPath = path.join(scratch.worktreeDir, 'over-cap.txt');
  writeFileSync(overCapPath, 'x'.repeat(MAX_INLINE_FILE_BYTES + 1024), 'utf8');

  const binaryPath = path.join(scratch.worktreeDir, 'binary.bin');
  writeFileSync(binaryPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00]));

  const folderPath = path.join(scratch.worktreeDir, 'a-folder');
  mkdirSync(folderPath, { recursive: true });

  const exeInfo = buildAndCopyExeFresh(SHOTS_DIR, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-926' });
  const port = await getFreePort();
  const launched = await launchBuiltExe(launcherExe, exeInfo.exePath, {
    port,
    dataDir: scratch.dataDir,
    importSourceDir: null,
    logFile: path.join(SHOTS_DIR, 'app.log')
  });

  let cdp;
  try {
    const target = await waitForCdpTarget(launched.port);
    cdp = await CdpSession.connect(target.webSocketDebuggerUrl);

    // Opens the scratch repository and creates a Session backed by the fake `omp` (`session`
    // scenario, REFRACT_FAKE_OMP_SCENARIO unset -> default) -- real UI, no model cost.
    await cdp.clickByText('Add repository');
    await cdp.typeIntoByLabel('Repository path', scratch.repoDir, { inDialog: true });
    await cdp.clickByText('Add', { inDialog: true });
    await cdp.clickByText('New session');
    const sessionId = await cdp.waitFor(
      `document.querySelector('[data-slot="session-row"][aria-current="true"]')?.getAttribute('data-session-id') ?? document.querySelector('[data-slot="session-row"]')?.getAttribute('data-session-id')`,
      { label: 'a Session exists after New session', timeoutMs: 20_000 }
    );

    // --- Rust IPC classification, called directly (the real round trip the Attach picker or a
    // drop would otherwise make) -----------------------------------------------------------
    const smallResult = await cdp.evaluate(`window.refract.attachments.readFile(${JSON.stringify(sessionId)}, ${JSON.stringify(smallTextPath)})`);
    assertEqual(smallResult?.ok, true, 'small text file: readFile ok');
    assertEqual(smallResult.value.kind, 'inline', 'small text file classified inline');

    const overCapResult = await cdp.evaluate(`window.refract.attachments.readFile(${JSON.stringify(sessionId)}, ${JSON.stringify(overCapPath)})`);
    assertEqual(overCapResult?.ok, true, 'over-cap file: readFile ok');
    assertEqual(overCapResult.value.kind, 'path', 'over-256KB file classified as path, never inlined');

    const binaryResult = await cdp.evaluate(`window.refract.attachments.readFile(${JSON.stringify(sessionId)}, ${JSON.stringify(binaryPath)})`);
    assertEqual(binaryResult?.ok, true, 'binary file: readFile ok');
    assertEqual(binaryResult.value.kind, 'path', 'binary file (PK zip magic bytes) classified as path');

    const folderResult = await cdp.evaluate(`window.refract.attachments.readFile(${JSON.stringify(sessionId)}, ${JSON.stringify(folderPath)})`);
    assertEqual(folderResult?.ok, true, 'folder: readFile ok');
    assertEqual(folderResult.value.kind, 'path', 'folder classified as path');
    assertEqual(folderResult.value.isDirectory, true, 'folder isDirectory true');

    const imageAbsPath = path.join(scratch.worktreeDir, 'pixel.png');
    writeFileSync(imageAbsPath, Buffer.from('89504e470d0a1a0a', 'hex')); // PNG magic only; not a decodable image, exercising the error path honestly
    const imageResult = await cdp.evaluate(`window.refract.attachments.readImageFile(${JSON.stringify(sessionId)}, ${JSON.stringify(imageAbsPath)})`);
    report.push({ step: 'readImageFile on a .png-extension path', ok: imageResult?.ok ?? false, note: imageResult?.ok ? 'decoded as image' : (imageResult?.error?.code ?? 'rejected, expected for a non-decodable header-only stub') });

    // --- Full send -> transcript parse -> sent-bubble-chip pipeline, real `chat.send` IPC ----
    const markerText = [
      '[[refract-attachments]]',
      buildInlineMarkerBlock('small-note.txt', smallResult.value.text ?? 'hello from a small text attachment\n'),
      buildPathMarkerBlock('over-cap.txt', overCapResult.value.byteLength, overCapResult.value.path),
      buildPathMarkerBlock('binary.bin', binaryResult.value.byteLength, binaryResult.value.path)
    ].join('\n\n');
    const outgoing = `Here are three files.\n\n${markerText}`;

    await cdp.typeIntoByLabel('Message', 'Here are three files.');
    // Replaces the typed text with the full marker-carrying message (the composer's own
    // `appendFileAttachmentText` glue is renderer-only and not exposed on `window`; this sends
    // the exact text it would have produced instead of re-typing it character by character).
    await cdp.evaluate(
      `(() => { const ta = document.querySelector('[aria-label="Message"]'); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, ${JSON.stringify(outgoing)}); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`
    );
    await cdp.clickByLabel('Send message');

    await cdp.waitFor(
      `(() => { const row = Array.from(document.querySelectorAll('[role="group"][aria-label="Attached files"]')).pop(); return !!row && row.querySelectorAll('[aria-label]').length === 3; })()`,
      { label: 'sent bubble shows exactly 3 file chips, not raw inlined text', timeoutMs: 20_000 }
    );
    const bubbleText = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-slot="message-content"]')).pop()?.textContent ?? ''`);
    assertEqual(bubbleText.includes('[[refract-attachments]]'), false, 'bubble never shows the raw marker');
    assertEqual(bubbleText.includes('hello from a small text attachment'), false, 'bubble never shows the raw inlined text');

    for (const theme of THEMES) {
      await cdp.evaluate(`window.refract.theme.preview(${JSON.stringify(theme.id)})`);
      await cdp.send('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-color-scheme', value: theme.id.startsWith('dark') ? 'dark' : 'light' }] });
      await sleep(300);
      await cdp.screenshot(path.join(SHOTS_DIR, `bubble-${theme.id}.png`));
    }

    report.push({ step: 'bubble chips, 3 themes', ok: true, screenshots: citeScreenshots(SHOTS_DIR, THEMES.map((t) => `bubble-${t.id}.png`)) });
  } finally {
    if (cdp) cdp.close();
    await stopLauncher(launched.launcherProcess).catch(() => {});
  }

  writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ head, exeHash: exeInfo.hash, results: report }, null, 2));
  await safeRmSync(scratch.dataDir, 'verify-926');
  log(`#926 live check done; evidence in ${SHOTS_DIR}`);

  function mktemp(label) {
    return mkdtempSync(path.join(tmpdir(), `refract-${label}-`));
  }

  function assertEqual(actual, expected, label) {
    const ok = actual === expected;
    report.push({ step: label, ok, actual, expected });
    if (!ok) throw new Error(`FAIL: ${label} (actual ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
    log(`PASS: ${label}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
