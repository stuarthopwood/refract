#!/usr/bin/env node
// Live CDP check for issue #513 (user chat bubbles show their attached images): a reopened
// Conversation (the `get_messages_page` history path, same two-launch pattern as
// verify-555-user-message-time.mjs) whose user messages carry real OMP `image` content parts
// (`{ type: 'image', mimeType, data }`, data = bare base64 or `blob:sha256:<hash>`).
// Fixture: scripts/fixtures/omp-frames/user-bubble-images-513-reopen.jsonl; the image payloads
// are generated here and handed over through `$env:REFRACT_FAKE_OMP_IMG_*` sentinels.
// The blob case seeds ONE uniquely-named file in the real ~/.omp/agent/blobs and removes it
// (and the folder only if this run created it) in `finally`.

import { mkdtempSync, mkdirSync, writeFileSync, createWriteStream, existsSync, unlinkSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, launchViaJobObject } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { makePng } from './verify-513-png.mjs';
import { probeBubble, viewerProbe, GROUP_SEL } from './verify-513-probes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_513_SHOTS_DIR || path.join(os.tmpdir(), 'refract-513-user-bubble-images-shots', new Date().toISOString().replace(/[:.]/g, '-'));
const BLOBS_DIR = path.join(os.homedir(), '.omp', 'agent', 'blobs');

const NARROW = { width: 760, height: 900 };
const WIDE = { width: 1700, height: 1000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_ENV_B64_CHARS = 20_000;

/** Tiles load lazily near the viewport: scroll the Nth group into view, then wait until none is loading and `imgs` images exist. */
async function revealGroup(cdp, groupIndex, imgs) {
  await cdp.evaluate(`document.querySelectorAll('${GROUP_SEL}')[${groupIndex}]?.scrollIntoView({ block: 'center' })`);
  await cdp.waitFor(`(() => { const g = document.querySelectorAll('${GROUP_SEL}')[${groupIndex}]; return !!g && g.querySelectorAll('button[aria-label*=", loading"]').length === 0 && g.querySelectorAll('img').length >= ${imgs}; })()`, { timeoutMs: 30_000, label: `group ${groupIndex} tiles loaded` });
}

function launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, pathPrepend, extraEnv = {}, logFile }) {
  const webview2DataDir = path.join(path.dirname(exePath), 'webview2-data');
  mkdirSync(webview2DataDir, { recursive: true });
  const pidFile = path.join(path.dirname(exePath), `target-${port}.pid`);
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
    REFRACT_DATA_DIR: dataDir,
    REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
    ...extraEnv,
    PATH: `${pathPrepend};${process.env.PATH}`,
  };
  return launchViaJobObject(launcherExe, pidFile, exePath, [], { cwd: path.dirname(exePath), env }).then(({ child, targetPid }) => {
    if (logFile) {
      const stream = createWriteStream(logFile);
      child.stdout.pipe(stream, { end: false });
      child.stderr.pipe(stream, { end: false });
    }
    return { child, targetPid };
  });
}

async function setViewport(cdp, { width, height }) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
}

async function key(cdp, name, code) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code, windowsVirtualKeyCode: code === 'Escape' ? 27 : code === 'ArrowRight' ? 39 : 37 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: code === 'Escape' ? 27 : code === 'ArrowRight' ? 39 : 37 });
  await sleep(250);
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const findings = [];
  const failures = [];
  const notExercised = [];
  const pass = (msg) => findings.push(msg);
  const fail = (msg) => failures.push(msg);
  const check = (ok, good, bad) => (ok ? pass(good) : fail(bad));

  let shimDir, dataDir, importSourceDir, repoDir, exeDir, conversationFileDir;
  let child1, child2, cdp1, cdp2;
  let blobFile = null;
  let createdBlobsDir = false;
  let exeHash = null;
  let gitHeadSha = null;
  try {
    shimDir = mkdtempSync(path.join(os.tmpdir(), 'refract-513-shim-'));
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'refract-513-data-'));
    importSourceDir = mkdtempSync(path.join(os.tmpdir(), 'refract-513-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(os.tmpdir(), 'refract-513-repo-')), 'verify-513');
    exeDir = mkdtempSync(path.join(os.tmpdir(), 'refract-513-exe-'));
    conversationFileDir = mkdtempSync(path.join(os.tmpdir(), 'refract-513-conv-'));
    const conversationFile = path.join(conversationFileDir, 'conversation.json');
    writeFileSync(conversationFile, '{}');
    gitHeadSha = gitHead(REPO_ROOT);
    console.log(`verify-513: git HEAD ${gitHeadSha}`);
    console.log(`verify-513: shots dir ${SHOTS_DIR}`);

    // Images: distinct colours so six tiles/viewer steps are distinguishable (identical bytes
    // would share one content id). Flat gradients keep each env var far below the Windows limit.
    const wide = makePng(600, 300, [20, 90, 200], [240, 120, 30]);
    const palette = [[200, 40, 40], [40, 160, 60], [40, 70, 200], [220, 170, 20], [150, 50, 180], [30, 170, 170]];
    const six = palette.map((c, i) => makePng(120 + i * 20, 90, c, [255 - c[0], 255 - c[1], 255 - c[2]]));
    const imageOnly = makePng(300, 200, [90, 90, 90], [250, 250, 250]);
    const blobPng = makePng(240, 160, [10, 10, 10], [200, 30, 120]);
    const b64 = (b) => {
      const text = b.toString('base64');
      if (text.length > MAX_ENV_B64_CHARS) throw new Error(`image payload is ${text.length} base64 chars (> ${MAX_ENV_B64_CHARS}); too large for an env var`);
      return text;
    };

    // Blob seeding: unique random name, extensionless (the first path the app tries), never an
    // existing file (wx flag fails if present).
    const blobHash = randomBytes(32).toString('hex');
    if (!existsSync(BLOBS_DIR)) {
      mkdirSync(BLOBS_DIR, { recursive: true });
      createdBlobsDir = true;
    }
    blobFile = path.join(BLOBS_DIR, blobHash);
    writeFileSync(blobFile, blobPng, { flag: 'wx' });
    console.log(`verify-513: seeded blob ${blobFile}`);

    mkdirSync(shimDir, { recursive: true });
    const shimOut = path.join(shimDir, 'omp.exe');
    const shimResult = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-omp-shim.rs'), '-o', shimOut], { encoding: 'utf8', windowsHide: true });
    if (shimResult.status !== 0) throw new Error(`rustc shim failed:\n${shimResult.stderr}`);
    const launcherExe = buildLauncher(shimDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-513' });
    const exePath = built.dest;
    exeHash = built.hash;
    console.log(`verify-513: exe ${exePath} (sha256 ${exeHash.slice(0, 12)}...)`);

    const baseEnv = {
      REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
      REFRACT_FAKE_OMP_NODE: process.execPath,
      REFRACT_FAKE_OMP_CONVERSATION_FILE: conversationFile,
    };

    // ---- Launch 1: create the Session (one real send so it persists its Conversation) ----
    const port1 = await getFreePort();
    const launched1 = await launchBuiltExe(launcherExe, exePath, {
      port: port1, dataDir, importSourceDir, pathPrepend: shimDir, logFile: path.join(SHOTS_DIR, 'app-launch1.log'),
      extraEnv: { ...baseEnv, REFRACT_FAKE_OMP_SCENARIO: 'user-message-time', REFRACT_FAKE_OMP_DEBUG_LOG: path.join(SHOTS_DIR, 'fake-omp-launch1.log') },
    });
    child1 = launched1.child;
    cdp1 = await CdpSession.connect(await waitForCdpTarget(port1, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port1, launched1.targetPid)) throw new Error('CDP target on launch 1 is not owned by the process this run launched');
    await cdp1.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
    await cdp1.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp1.waitFor(`!!document.querySelector('[role="dialog"] input')`, { label: 'Add repository dialog' });
    await cdp1.click(`document.querySelector('[role="dialog"] input')`);
    await cdp1.send('Input.insertText', { text: repoDir });
    await cdp1.clickByText('Add repository', { inDialog: true });
    await cdp1.waitFor(`!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`, { timeoutMs: 30_000, label: 'Repository added' });
    await cdp1.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp1.waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, { label: 'New session dialog' });
    await cdp1.clickByText('Create session', { inDialog: true });
    await cdp1.waitFor(`!document.querySelector('[role="dialog"]')`, { label: 'Dialog closed' });
    await cdp1.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'Composer enabled' });
    await cdp1.typeIntoByLabel('Message', 'Checking issue 513 session creation now.');
    await cdp1.clickByLabel('Send message');
    await cdp1.waitFor(`!!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Approve')`, { timeoutMs: 30_000, label: 'Approval card' });
    await cdp1.clickByText('Approve');
    await cdp1.waitFor(`document.querySelector('[aria-label="Transcript"]')?.textContent.includes('xyzzy9')`, { timeoutMs: 60_000, label: 'Turn settled' });
    cdp1.close();
    cdp1 = undefined;
    await stopLauncher(child1);
    child1 = undefined;

    // ---- Launch 2: reattach, history carries the image parts ----
    const port2 = await getFreePort();
    const launched2 = await launchBuiltExe(launcherExe, exePath, {
      port: port2, dataDir, importSourceDir, pathPrepend: shimDir, logFile: path.join(SHOTS_DIR, 'app-launch2.log'),
      extraEnv: {
        ...baseEnv,
        REFRACT_FAKE_OMP_SCENARIO: 'user-bubble-images-513-reopen',
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(SHOTS_DIR, 'fake-omp-launch2.log'),
        REFRACT_FAKE_OMP_IMG_WIDE: b64(wide),
        REFRACT_FAKE_OMP_IMG_1: b64(six[0]), REFRACT_FAKE_OMP_IMG_2: b64(six[1]), REFRACT_FAKE_OMP_IMG_3: b64(six[2]),
        REFRACT_FAKE_OMP_IMG_4: b64(six[3]), REFRACT_FAKE_OMP_IMG_5: b64(six[4]), REFRACT_FAKE_OMP_IMG_6: b64(six[5]),
        REFRACT_FAKE_OMP_IMG_ONLY: b64(imageOnly),
        REFRACT_FAKE_OMP_IMG_BLOB_REF: `blob:sha256:${blobHash}`,
      },
    });
    child2 = launched2.child;
    cdp2 = await CdpSession.connect(await waitForCdpTarget(port2, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port2, launched2.targetPid)) throw new Error('CDP target on launch 2 is not owned by the process this run launched');
    await cdp2.waitFor(`!!document.querySelector('[data-session-open]')`, { timeoutMs: 60_000, label: 'Session row' });
    await cdp2.click(`document.querySelector('[data-session-open]')`);
    await cdp2.clickByText('Start agent');
    await cdp2.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'Session reattached' });
    await setViewport(cdp2, NARROW);
    await cdp2.waitFor(`document.querySelector('[aria-label="Transcript"]')?.textContent.includes('Blob image message.')`, { timeoutMs: 30_000, label: 'History rendered' });
    // Tiles load lazily (IntersectionObserver, ~200px margin): scroll each group into view, then wait.
    const GROUP_IMGS = [1, 4, 1, 0, 1];
    for (let g = 0; g < GROUP_IMGS.length; g += 1) await revealGroup(cdp2, g, GROUP_IMGS[g]);

    // ---- Narrow ----
    await cdp2.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    await cdp2.evaluate(`document.querySelector('[data-slot="message-scroller-viewport"]')?.scrollTo(0, 0)`);
    await cdp2.waitFor(`(document.querySelector('[data-slot="message-scroller-viewport"]')?.scrollTop ?? 0) === 0`, { timeoutMs: 5000, label: 'scrolled to top' });
    await cdp2.screenshot(path.join(SHOTS_DIR, '01-narrow-top.png'));
    const narrow = {};
    for (const [name, i] of [['single', 0], ['six', 1], ['imageOnly', 2], ['invalid', 3], ['blob', 4]]) narrow[name] = await cdp2.evaluate(probeBubble(i));
    console.log('verify-513: narrow probes', JSON.stringify(narrow));

    // (a) single
    const s = narrow.single;
    check(s.tiles === 1 && s.imgs === 1 && s.imgSrcData, 'single: one tile with an <img> whose src is a data: URL.', `single: expected 1 tile + data: img, got ${JSON.stringify(s)}`);
    check(/^Image attached to your message, PNG, [\d.]+ (B|KB|MB)\. Open larger view$/.test(s.tileLabels[0] ?? ''), `single: tile name "${s.tileLabels[0]}".`, `single: tile name "${s.tileLabels[0]}" does not match "Image attached to your message, TYPE, size. Open larger view".`);
    check(s.tileImgAlts.every((a) => a === ''), 'single: tile <img> has alt="".', `single: tile <img> alt ${JSON.stringify(s.tileImgAlts)}, expected "".`);
    check(s.imgH > 0 && s.imgH <= 320.5, `single: image is ${s.imgH}px tall (<= 320).`, `single: image is ${s.imgH}px tall (> 320).`);
    check(s.imgW <= s.natW && s.imgH <= s.natH, `single: rendered ${s.imgW}x${s.imgH} within natural ${s.natW}x${s.natH} (not upscaled).`, `single: rendered ${s.imgW}x${s.imgH} exceeds natural ${s.natW}x${s.natH}.`);
    check(s.natW === 600 && s.natH === 300, 'single: natural size is the generated 600x300.', `single: natural size ${s.natW}x${s.natH}, expected 600x300.`);
    check(s.hasText && s.text.includes('Single image message.'), 'single: the text part still renders in the bubble.', `single: text missing ("${s.text}").`);
    // (b) six
    const x = narrow.six;
    check(x.tiles === 4 && x.imgs === 4, 'six: exactly 4 tiles with images are shown.', `six: expected 4 tiles, got ${x.tiles}/${x.imgs}.`);
    check(x.imgSrcData, 'six: every tile img src is a data: URL.', 'six: a tile img src is not a data: URL.');
    check(x.overlays.length === 1 && x.overlays[0].text === '+2' && x.overlays[0].tileIndex === 3, `six: a single "+2" overlay on the 4th tile (${JSON.stringify(x.overlays)}).`, `six: overlay wrong ${JSON.stringify(x.overlays)}.`);
    const nCols = x.columns;
    console.log(`verify-513: narrow six grid columns=${nCols} groupWidth=${x.groupWidth}`);
    x.tileLabels.forEach((label, i) => {
      const more = i === 3 ? ', plus 2 more' : '';
      check(new RegExp(`^Image ${i + 1} of 6 attached to your message, PNG, [\\d.]+ (B|KB|MB)${more}\\. Open larger view$`).test(label ?? ''), `six: tile ${i + 1} name "${label}".`, `six: tile ${i + 1} name "${label}" does not match the expected pattern${more ? ' (with ", plus 2 more")' : ''}.`);
    });
    check(x.tileImgAlts.every((a) => a === ''), 'six: every tile <img> has alt="".', `six: tile <img> alts ${JSON.stringify(x.tileImgAlts)}.`);
    check(x.minTileSize >= 24, `six: smallest tile side ${Math.round(x.minTileSize)}px (>= 24).`, `six: smallest tile side ${x.minTileSize}px (< 24).`);
    check(x.tileBorder === '1px', 'six: tiles have a 1px border.', `six: tile border width ${x.tileBorder}, expected 1px.`);
    // (c) image-only
    const o = narrow.imageOnly;
    check(o.tiles === 1 && o.imgs === 1, 'image-only: one image tile renders.', `image-only: expected one tile, got ${JSON.stringify(o)}.`);
    check(!o.hasText && !o.emptyTextBlock, 'image-only: the bubble has no text block at all (no empty paragraph).', `image-only: unexpected text/empty block ${JSON.stringify(o)}.`);
    check(!o.bubbleText.includes('Image attached') && !o.transcriptHasImageAttached, 'image-only: no "Image attached" text anywhere.', 'image-only: "Image attached" text found.');
    // (d) invalid
    const inv = narrow.invalid;
    check(inv.placeholders === 1 && inv.imgs === 0, 'invalid: shows the "Image no longer available" placeholder, no img.', `invalid: expected one placeholder, got ${JSON.stringify(inv)}.`);
    check(inv.hasText, 'invalid: the message text still renders.', 'invalid: message text missing.');
    // (e) blob
    const bl = narrow.blob;
    check(bl.tiles === 1 && bl.imgs === 1 && bl.imgSrcData, 'blob: the blob:sha256 reference resolves to a data: URL image (images.get).', `blob: expected a loaded image, got ${JSON.stringify(bl)}.`);
    check(!narrow.six.docOverflowX && !narrow.six.groupOverflowX, 'narrow: no horizontal overflow (document and group).', `narrow: horizontal overflow ${JSON.stringify({ doc: narrow.six.docOverflowX, group: narrow.six.groupOverflowX })}.`);

    // ---- Viewer (narrow window) ----
    await revealGroup(cdp2, 1, 4);
    await cdp2.screenshot(path.join(SHOTS_DIR, '02-narrow-six-grid.png'));
    // The "+2" tile (4th) opens the viewer at the first hidden image (5th), not at the 4th.
    const tileLabel = await cdp2.evaluate(`document.querySelectorAll('${GROUP_SEL}')[1].querySelectorAll('button')[3].getAttribute('aria-label')`);
    await cdp2.click(`document.querySelectorAll('${GROUP_SEL}')[1].querySelectorAll('button')[3]`);
    await cdp2.waitFor(`!!document.querySelector('[role="dialog"] img[alt="Attached image, full size"]')`, { label: 'Viewer opened with image' });
    const seen = [];
    let v = await cdp2.evaluate(viewerProbe());
    check(v.title === 'Image 5 of 6', `viewer: the +2 tile opened the first hidden image -- title "${v.title}".`, `viewer: title "${v.title}", expected "Image 5 of 6".`);
    check(/PNG, [\d.]+ (B|KB|MB)/.test(v.description ?? ''), `viewer: shows type and size ("${v.description}").`, `viewer: description "${v.description}" lacks type and size.`);
    const height5 = v.dialogHeight;
    await cdp2.screenshot(path.join(SHOTS_DIR, '03-viewer-open.png'));
    // Next button: 5 -> 6, then 6 -> 1 (wrap); the dialog must not change height between images.
    const dialogBtn = (label) => `document.querySelector('[role="dialog"] button[aria-label="${label}"]')`;
    await cdp2.click(dialogBtn('Next image'));
    await cdp2.waitFor(`document.querySelector('[role="dialog"]')?.textContent.includes('Image 6 of 6') && !!document.querySelector('[role="dialog"] img[alt="Attached image, full size"]')`, { timeoutMs: 8000, label: 'Next button -> 6 of 6' });
    pass('viewer: the Next button moves 5 -> 6.');
    await cdp2.click(dialogBtn('Next image'));
    await cdp2.waitFor(`document.querySelector('[role="dialog"]')?.textContent.includes('Image 1 of 6') && !!document.querySelector('[role="dialog"] img[alt="Attached image, full size"]')`, { timeoutMs: 8000, label: 'Next button wraps -> 1 of 6' });
    v = await cdp2.evaluate(viewerProbe());
    check(v.dialogHeight === height5, `viewer: dialog height unchanged between images (${height5}px vs ${v.dialogHeight}px).`, `viewer: dialog height changed from ${height5}px (image 5) to ${v.dialogHeight}px (image 1).`);
    await cdp2.click(dialogBtn('Previous image'));
    await cdp2.waitFor(`document.querySelector('[role="dialog"]')?.textContent.includes('Image 6 of 6')`, { timeoutMs: 8000, label: 'Previous button wraps -> 6 of 6' });
    pass('viewer: the Previous button wraps 1 -> 6.');
    // Keys: Right wraps to 1, then Right through 2..6.
    await key(cdp2, 'ArrowRight', 'ArrowRight');
    await cdp2.waitFor(`document.querySelector('[role="dialog"]')?.textContent.includes('Image 1 of 6') && !!document.querySelector('[role="dialog"] img[alt="Attached image, full size"]')`, { timeoutMs: 8000, label: 'ArrowRight wraps -> 1 of 6' });
    v = await cdp2.evaluate(viewerProbe());
    seen.push(v.src);
    for (let n = 2; n <= 6; n += 1) {
      await key(cdp2, 'ArrowRight', 'ArrowRight');
      await cdp2.waitFor(`document.querySelector('[role="dialog"] img[alt="Attached image, full size"]') && document.querySelector('[role="dialog"]').textContent.includes('Image ${n} of 6')`, { timeoutMs: 8000, label: `ArrowRight -> ${n} of 6` });
      v = await cdp2.evaluate(viewerProbe());
      seen.push(v.src);
      check(v.title === `Image ${n} of 6` && v.srcData, `viewer: ArrowRight reaches "Image ${n} of 6" with a loaded data: image (${v.natW}x${v.natH}).`, `viewer: step ${n} bad ${JSON.stringify({ ...v, src: undefined })}.`);
      if (n === 6) await cdp2.screenshot(path.join(SHOTS_DIR, '04-viewer-sixth.png'));
    }
    check(new Set(seen).size === 6, 'viewer: all 6 images are distinct (the 5th and 6th, hidden behind +2, are reachable).', `viewer: only ${new Set(seen).size} distinct images across 6 steps.`);
    await key(cdp2, 'ArrowRight', 'ArrowRight');
    await cdp2.waitFor(`document.querySelector('[role="dialog"]')?.textContent.includes('Image 1 of 6')`, { timeoutMs: 5000, label: 'wrap to 1' });
    pass('viewer: ArrowRight from 6 wraps to "Image 1 of 6".');
    await key(cdp2, 'Escape', 'Escape');
    await cdp2.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 5000, label: 'Esc closes viewer' });
    pass('viewer: Esc closes the dialog.');
    await cdp2.waitFor(`document.activeElement?.getAttribute('aria-label') === ${JSON.stringify(tileLabel)}`, { timeoutMs: 5000, label: 'focus back on opener tile' });
    pass(`viewer: Esc returned focus to the tile that opened it ("${tileLabel}").`);
    // Close button: open from the 2nd tile, close with the button, focus returns to that tile.
    const tile2Label = await cdp2.evaluate(`document.querySelectorAll('${GROUP_SEL}')[1].querySelectorAll('button')[1].getAttribute('aria-label')`);
    await cdp2.click(`document.querySelectorAll('${GROUP_SEL}')[1].querySelectorAll('button')[1]`);
    await cdp2.waitFor(`document.querySelector('[role="dialog"]')?.textContent.includes('Image 2 of 6')`, { timeoutMs: 5000, label: 'viewer at 2 of 6' });
    pass('viewer: a visible tile opens the viewer at its own index ("Image 2 of 6").');
    await cdp2.click(`document.querySelector('[role="dialog"] [data-slot="dialog-close"]')`);
    await cdp2.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 5000, label: 'Close button closes viewer' });
    await cdp2.waitFor(`document.activeElement?.getAttribute('aria-label') === ${JSON.stringify(tile2Label)}`, { timeoutMs: 5000, label: 'focus back after Close button' });
    pass('viewer: the Close button closes the dialog and focus returns to the opener tile.');

    // ---- Wide ----
    await setViewport(cdp2, WIDE);
    await revealGroup(cdp2, 1, 4);
    const wideSix = await cdp2.evaluate(probeBubble(1));
    const wideSingle = await cdp2.evaluate(probeBubble(0));
    console.log(`verify-513: wide six columns=${wideSix.columns} groupWidth=${wideSix.groupWidth}; narrow columns=${nCols} groupWidth=${x.groupWidth}`);
    check(nCols === 2, `grid: ${nCols} columns at the narrow pane (group ${Math.round(x.groupWidth)}px).`, `grid: ${nCols} columns at narrow (group ${Math.round(x.groupWidth)}px), expected 2.`);
    check(wideSix.columns === 4, `grid: ${wideSix.columns} columns when wide (group ${Math.round(wideSix.groupWidth)}px).`, `grid: ${wideSix.columns} columns when wide (group ${Math.round(wideSix.groupWidth)}px), expected 4.`);
    check(!wideSix.docOverflowX && !wideSix.groupOverflowX, 'wide: no horizontal overflow (document and group).', `wide: horizontal overflow ${JSON.stringify({ doc: wideSix.docOverflowX, group: wideSix.groupOverflowX })}.`);
    check(wideSingle.imgH <= 320.5 && wideSingle.imgW <= wideSingle.natW, `single (wide): ${wideSingle.imgW}x${wideSingle.imgH}, still not upscaled and <= 320 tall.`, `single (wide): ${wideSingle.imgW}x${wideSingle.imgH} violates the cap.`);
    await cdp2.screenshot(path.join(SHOTS_DIR, '05-wide-six-grid.png'));
    await cdp2.evaluate(`document.querySelector('[data-slot="message-scroller-viewport"]')?.scrollTo(0, 0)`);
    await cdp2.waitFor(`(document.querySelector('[data-slot="message-scroller-viewport"]')?.scrollTop ?? 0) === 0`, { timeoutMs: 5000, label: 'scrolled to top (wide)' });
    await cdp2.screenshot(path.join(SHOTS_DIR, '06-wide-top.png'));

    // Narrowest practical window (~320px bubble).
    await setViewport(cdp2, { width: 400, height: 900 });
    await revealGroup(cdp2, 1, 4);
    const tiny = await cdp2.evaluate(probeBubble(1));
    console.log(`verify-513: 400px window: six columns=${tiny.columns} groupWidth=${tiny.groupWidth}`);
    check(!tiny.docOverflowX && !tiny.groupOverflowX, `400px: no horizontal overflow (group ${Math.round(tiny.groupWidth)}px, ${tiny.columns} columns).`, `400px: horizontal overflow ${JSON.stringify({ doc: tiny.docOverflowX, group: tiny.groupOverflowX })}.`);
    await cdp2.screenshot(path.join(SHOTS_DIR, '07-tiny-six-grid.png'));

    const report = { gitHead: gitHeadSha, exeSha256: exeHash, findings, failures, notExercised, exitCode: failures.length ? 1 : 0 };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== verify-513: FAILURES ===');
    if (!failures.length) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-513: findings ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-513: ${failures.length ? 'FAILED' : 'DONE'}.`);
    process.exitCode = failures.length ? 1 : 0;
  } catch (err) {
    console.error('verify-513: FAIL');
    try { await cdp2?.screenshot(path.join(SHOTS_DIR, 'failure.png')); } catch { /* best effort */ }
    console.error(err);
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, exeSha256: exeHash, findings, failures, error: String(err?.stack ?? err), exitCode: 1 }, null, 2));
    } catch { /* best effort */ }
    process.exitCode = 1;
  } finally {
    cdp1?.close();
    cdp2?.close();
    if (child1) await stopLauncher(child1);
    if (child2) await stopLauncher(child2);
    if (blobFile && path.dirname(blobFile) === BLOBS_DIR && /^[0-9a-f]{64}$/.test(path.basename(blobFile)) && existsSync(blobFile)) {
      unlinkSync(blobFile);
      console.log(`verify-513: removed seeded blob ${blobFile}`);
      if (createdBlobsDir) {
        try { rmdirSync(BLOBS_DIR); } catch { /* not empty: leave it */ }
      }
    }
    await safeRmSync(shimDir, 'verify-513');
    await safeRmSync(dataDir, 'verify-513');
    await safeRmSync(importSourceDir, 'verify-513');
    await safeRmSync(conversationFileDir, 'verify-513');
    if (repoDir) await safeRmSync(path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir)), 'verify-513');
    await safeRmSync(repoDir, 'verify-513');
    await safeRmSync(exeDir, 'verify-513');
  }
}

main();
