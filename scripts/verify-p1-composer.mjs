#!/usr/bin/env node
// Live CDP check for Lane C (issues #744, #1082, #724) on a scratch Refract instance. Pattern from
// `verify-1122-selected-style.mjs` (private exe copy + sha256, own REFRACT_DATA_DIR and CDP port,
// Job-Object launcher, real computed styles, CDP Accessibility tree for accessible names).
//
// Real `omp`, not the fake one: no `scripts/fixtures/omp-frames` tape reports `contextUsage` (the
// #1082 chip never renders without it) or lists a queued image-only follow-up as `[Image]` (the
// #744 queue chip), and the prototyping rule forbids new fixtures. AGENTS.md allows a real `omp`
// for a flow the fixtures do not cover. Prompts are short; the one long-ish turn exists only so
// an image-only follow-up genuinely queues. The scratch instance reaches the real `omp` through
// the existing PATH shim (`verify-tauri-omp-shim.rs`) and a pass-through script written at run
// time that adds `--no-tools --no-extensions --no-skills --no-rules --model haiku`: without it the
// real profile's own agent rules start tool calls that wait on approval, and no turn runs plainly.
//
// Checks (each fails when its target is missing):
// - #724: the story-only marker `[data-composer-branch]` exists, sits after the Reasoning picker,
//   shows the worktree's real branch, has the accessible name "Branch: <name>. Open Git changes
//   panel", opens the Git changes panel; a `git switch -c` made outside a turn shows within 2 s
//   (HEAD watch); a 60-character name truncates in a narrow window without wrapping or pushing
//   the Reasoning picker; a detached HEAD reads "Detached at <sha>".
// - #744: an image-only draft enables Send and sends on Enter; the bubble reads "Image attached";
//   while working an image-only follow-up queues with the chip "Image (<filename>)"; a second is
//   refused with a visible toast and the draft image stays.
// - #1082: the figures carry an OKLCH `color-mix`, meet 4.5:1 live, the 2px bar is `aria-hidden`
//   and filled in the same colour, the Settings > Chat switch hides and restores it; the
//   renderer's blend at every 10% step matches `scripts/context-usage-contrast.mjs` and passes
//   4.5:1 in Dark, Obsidian and Dark (high contrast), with screenshots of the strip and chip.
//
// Usage: REFRACT_P1_EXE=<prebuilt debug exe> REFRACT_P1_SCRATCH=<scratch root outside the repo>
//        node scripts/verify-p1-composer.mjs
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, computeDirty, buildLauncher, makeScratchRepo, citeScreenshots, sha256OfFile, assertExeUnchanged, switchTheme, getAccessibleNameAndRole, axText } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { settleForScreenshot } from './verify-700-todo-pin-helpers.mjs';
import { measuredContrastRatio, parseComputedColorToEntry } from './contrast-math.mjs';
import { contextUsageLinear } from './context-usage-contrast.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-p1-composer';
const EXE_SOURCE = process.env.REFRACT_P1_EXE;
const SCRATCH = process.env.REFRACT_P1_SCRATCH;
if (!EXE_SOURCE || !SCRATCH) throw new Error(`${LOG}: set REFRACT_P1_EXE and REFRACT_P1_SCRATCH`);
const SHOTS_DIR = path.join(SCRATCH, 'shots');
const LONG_BRANCH = 'feature/lane-c-live-check-a-sixty-character-branch-name-xyz';
const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' }
];
const BRANCH = `document.querySelector('[data-composer-branch]')`;
const REASONING = `Array.from(document.querySelectorAll('[data-composer-row] button')).find((b) => /reasoning/i.test(b.getAttribute('aria-label') ?? ''))`;
const SEND = `document.querySelector('[aria-label="Send message"]')`;
const FIGURES = `document.querySelector('[data-context-usage-figures]')`;
const BAR = `document.querySelector('[data-context-usage-bar]')`;

function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) {
    let c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** A 32x32 solid red PNG (the same image the #744 OMP probe used). */
function redPngBase64() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(32, 0);
  ihdr.writeUInt32BE(32, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((32 * 3 + 1) * 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) raw[y * 97 + 1 + x * 3] = 255;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]).toString('base64');
}

/** Dispatches a real `paste` event carrying `name` as an image `File` on the composer textarea. */
async function pasteImage(cdp, name, base64) {
  await cdp.click(`document.querySelector('[aria-label="Message"]')`);
  await cdp.evaluate(`(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], ${JSON.stringify(name)}, { type: 'image/png' }));
    document.querySelector('[aria-label="Message"]').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  })()`);
}

const pendingImageCount = (cdp) => cdp.evaluate(`document.querySelectorAll('img[src^="data:image/png"]').length - document.querySelectorAll('[aria-label="Transcript"] img[src^="data:image/png"]').length`);

async function shot(cdp, shots, name, clipFinder) {
  await settleForScreenshot(cdp);
  const out = path.join(SHOTS_DIR, name);
  if (clipFinder) {
    const clip = await cdp.evaluate(`(() => { const el = ${clipFinder}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: r.width + 16, height: r.height + 16, scale: 1 }; })()`);
    if (!clip) throw new Error(`screenshot ${name}: clip target missing`);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip });
    writeFileSync(out, Buffer.from(data, 'base64'));
  } else {
    await cdp.screenshot(out);
  }
  shots.push(name);
}

async function closeTooltips(cdp) {
  // Radix hover tooltips need two pointer moves away to close.
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 300 });
  await sleep(150);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 6, y: 310 });
  await sleep(400);
}

async function waitIdle(cdp, label, timeoutMs = 180_000) {
  await cdp.waitFor(`!document.querySelector('[aria-label="Stop"]') && !!${SEND}`, { timeoutMs, label });
}

async function checkBranch(cdp, worktree, failures, findings) {
  const marker = await cdp.waitFor(`!!${BRANCH}`, { timeoutMs: 30_000, label: '#724 marker' }).catch(() => false);
  if (!marker) throw new Error(`#724 story marker [data-composer-branch] missing -- the label never rendered (row: ${await cdp.evaluate(`document.querySelector('[data-composer-row]')?.textContent`)})`);
  const expected = git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
  await cdp.waitFor(`${BRANCH}?.textContent.trim() === ${JSON.stringify(expected)}`, { timeoutMs: 15_000, label: '#724 label shows the worktree branch' });
  const after = await cdp.evaluate(`(() => { const r = ${REASONING}; const b = ${BRANCH}; return !!r && !!(r.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); })()`);
  if (!after) failures.push('#724: branch label is not after the Reasoning picker in the composer row.');
  const ax = await getAccessibleNameAndRole(cdp, BRANCH);
  const wantName = `Branch: ${expected}. Open Git changes panel`;
  if (ax.name !== wantName || ax.role !== 'button') failures.push(`#724: accessible name/role ${JSON.stringify(ax)}, expected "${wantName}"/button.`);
  else findings.push(`#724: label "${expected}" after Reasoning; AX name "${ax.name}", role button.`);
  const height = await cdp.evaluate(`${BRANCH}.getBoundingClientRect().height`);
  if (height < 24) failures.push(`#724: label target height ${height}px < 24px.`);

  await cdp.click(BRANCH);
  const opened = await cdp.waitFor(`!!document.querySelector('[data-git-changes-session]')`, { timeoutMs: 15_000, label: '#724 Git changes panel open' }).catch(() => false);
  if (!opened) failures.push('#724: clicking the label did not open the Git changes panel.');
  else findings.push('#724: click opened the Git changes panel ([data-git-changes-session] mounted).');

  const tSwitch = Date.now();
  git(worktree, ['switch', '-q', '-c', LONG_BRANCH]);
  const t0 = Date.now();
  const seen = await cdp.waitFor(`${BRANCH}?.textContent.trim() === ${JSON.stringify(LONG_BRANCH)}`, { timeoutMs: 5_000, intervalMs: 50, label: '#724 label follows git switch' }).catch(() => false);
  const ms = Date.now() - t0;
  if (!seen) failures.push('#724: a git switch made outside a turn never reached the label within 5 s.');
  else if (ms > 1500) failures.push(`#724: label followed the switch ${ms} ms after git returned (> 1500 ms).`);
  else findings.push(`#724: outside-turn \`git switch -c\` (${LONG_BRANCH.length} chars; git itself took ${t0 - tSwitch} ms) shown ${ms} ms after git returned (HEAD watch).`);

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 720, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  const narrow = await cdp.evaluate(`(() => {
    const b = ${BRANCH}; const span = b.querySelector('span'); const r = ${REASONING}; const row = document.querySelector('[data-composer-row]');
    const br = b.getBoundingClientRect(); const rr = r.getBoundingClientRect(); const row_ = row.getBoundingClientRect();
    const model = Array.from(row.querySelectorAll('button')).find((x) => /model/i.test(x.getAttribute('aria-label') ?? ''));
    const ms = model?.querySelector('span:last-child');
    return { truncated: span.scrollWidth > span.clientWidth, labelH: br.height, reasoningInside: rr.right <= row_.right + 0.5 && rr.width > 0, reasoningClipped: r.scrollWidth > r.clientWidth + 1, modelTruncated: ms ? ms.scrollWidth > ms.clientWidth + 1 : null };
  })()`);
  if (!narrow.truncated) failures.push(`#724: 60-char branch did not truncate at 720px (${JSON.stringify(narrow)}).`);
  if (narrow.labelH > 26) failures.push(`#724: label wrapped (height ${narrow.labelH}px).`);
  if (!narrow.reasoningInside || narrow.reasoningClipped) failures.push(`#724: Reasoning picker pushed or clipped (${JSON.stringify(narrow)}).`);
  if (narrow.modelTruncated) failures.push(`#724: model name truncated while the branch could still yield (${JSON.stringify(narrow)}).`);
  findings.push(`#724: narrow strip (720px) ${JSON.stringify(narrow)}.`);
  const fullName = await getAccessibleNameAndRole(cdp, BRANCH);
  if (!fullName.name?.includes(LONG_BRANCH)) failures.push(`#724: truncated label's accessible name lost the full branch (${fullName.name}).`);

  const rect = await cdp.evaluate(`(() => { const r = ${BRANCH}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  const tip = await cdp.waitFor(`Array.from(document.querySelectorAll('[data-slot="tooltip-content"], [role="tooltip"]')).map((el) => el.textContent).find((t) => t.includes(${JSON.stringify(LONG_BRANCH)})) ?? null`, { timeoutMs: 5_000, label: '#724 tooltip shows full name' }).catch(() => null);
  if (!tip) failures.push('#724: hover tooltip did not show the full branch name.');
  else findings.push(`#724: tooltip text "${tip}".`);
  await closeTooltips(cdp);
  return { narrowDone: true };
}

async function checkDetached(cdp, worktree, failures, findings) {
  git(worktree, ['checkout', '-q', '--detach']);
  const sha = git(worktree, ['rev-parse', '--short', 'HEAD']);
  const ok = await cdp.waitFor(`${BRANCH}?.textContent.trim() === ${JSON.stringify(`Detached at ${sha}`)}`, { timeoutMs: 5_000, label: '#724 detached' }).catch(() => false);
  if (!ok) failures.push(`#724: detached HEAD did not read "Detached at ${sha}".`);
  else findings.push(`#724: detached HEAD reads "Detached at ${sha}".`);
  git(worktree, ['switch', '-q', LONG_BRANCH]);
  await cdp.waitFor(`${BRANCH}?.textContent.trim() === ${JSON.stringify(LONG_BRANCH)}`, { timeoutMs: 5_000, label: '#724 back on branch' });
}

async function checkImageOnly(cdp, png, failures, findings) {
  const emptyDisabled = await cdp.evaluate(`${SEND}.getAttribute('aria-disabled')`);
  if (emptyDisabled !== 'true') failures.push(`#744: Send not aria-disabled on an empty draft (${emptyDisabled}).`);
  await pasteImage(cdp, 'red-probe.png', png);
  await cdp.waitFor(`(${SEND}?.getAttribute('aria-disabled')) === 'false'`, { timeoutMs: 10_000, label: '#744 Send enabled with only an image' }).catch(() => failures.push('#744: Send stayed aria-disabled with one pending image and no text.'));
  await cdp.click(`document.querySelector('[aria-label="Message"]')`);
  await cdp.pressEnter();
  const bubble = await cdp.waitFor(`Array.from(document.querySelectorAll('[aria-label="Transcript"] p')).some((p) => p.textContent.trim() === 'Image attached')`, { timeoutMs: 60_000, label: '#744 image-only bubble' }).catch(() => false);
  if (!bubble) failures.push('#744: no "Image attached" user bubble after an image-only Enter (OMP never echoed the message).');
  else findings.push('#744: idle image-only Enter sent; OMP echoed an empty-text user message, bubble reads "Image attached".');
  if ((await pendingImageCount(cdp)) !== 0) failures.push('#744: pending image did not clear after the send.');
  await sleep(2000);
  await waitIdle(cdp, '#744 image-only turn settles');

  await cdp.typeIntoByLabel('Message', 'Write the numbers 1 to 400, one per line, nothing else.');
  await cdp.pressEnter();
  await cdp.waitFor(`!!document.querySelector('[aria-label="Stop"]')`, { timeoutMs: 30_000, label: 'long turn working' });
  await pasteImage(cdp, 'red-probe.png', png);
  await cdp.waitFor(`(${SEND}?.getAttribute('aria-disabled')) === 'false'`, { timeoutMs: 10_000, label: 'image pending while working' });
  await cdp.click(`document.querySelector('[aria-label="Message"]')`);
  await cdp.pressEnter();
  const chip = await cdp.waitFor(`Array.from(document.querySelectorAll('ul[aria-label="Queued messages"] li')).map((li) => li.textContent).find((t) => t.includes('Image (red-probe.png)')) ?? null`, { timeoutMs: 15_000, label: '#744 queue chip label' }).catch(() => null);
  if (!chip) failures.push(`#744: no "Image (red-probe.png)" queue chip (chips: ${JSON.stringify(await cdp.evaluate(`Array.from(document.querySelectorAll('ul[aria-label="Queued messages"] li')).map((li) => li.textContent)`))}).`);
  else {
    const removeAx = await getAccessibleNameAndRole(cdp, `document.querySelector('ul[aria-label="Queued messages"] [data-chip-action="remove"]')`);
    findings.push(`#744: working-session image-only follow-up queued, chip "${chip}", Remove AX name "${removeAx.name}".`);
    if (removeAx.name !== 'Remove queued message: Image (red-probe.png)') failures.push(`#744: Remove accessible name ${JSON.stringify(removeAx.name)}.`);
    await pasteImage(cdp, 'second.png', png);
    await cdp.waitFor(`(${SEND}?.getAttribute('aria-disabled')) === 'false'`, { timeoutMs: 10_000, label: 'second image pending' });
    await cdp.click(`document.querySelector('[aria-label="Message"]')`);
    await cdp.pressEnter();
    const toast = await cdp.waitFor(`Array.from(document.querySelectorAll('[data-sonner-toast]')).map((t) => t.textContent).find((t) => t.includes('Only one image-only message')) ?? null`, { timeoutMs: 5_000, label: '#744 refusal toast' }).catch(() => null);
    if (!toast) failures.push('#744: a second image-only follow-up was not refused with a visible toast.');
    else findings.push(`#744: second image-only follow-up refused: "${toast}".`);
    if ((await pendingImageCount(cdp)) < 1) failures.push('#744: the refused draft lost its image.');
  }
  await waitIdle(cdp, 'long turn and queued follow-up settle', 240_000);
}

const mixFor = (p) => {
  const stops = [0, 30, 70, 100];
  const i = stops.findIndex((s) => s >= p && s > 0);
  const share = ((p - stops[i - 1]) / (stops[i] - stops[i - 1])) * 100;
  return `color-mix(in oklch, var(--context-usage-${stops[i - 1]}), var(--context-usage-${stops[i]}) ${share.toFixed(1)}%)`;
};

async function checkContextUsage(cdp, theme, failures, findings) {
  const figures = await cdp.waitFor(`(() => { const f = ${FIGURES}; return f ? { style: f.getAttribute('style'), color: getComputedStyle(f).color, text: f.textContent } : null; })()`, { timeoutMs: 60_000, label: '#1082 context usage figures' }).catch(() => null);
  if (!figures) {
    failures.push(`${theme.name}: #1082 context usage figures never rendered.`);
    return;
  }
  const bg = await cdp.evaluate(`getComputedStyle(document.body).backgroundColor`);
  const ratio = measuredContrastRatio(figures.color, bg);
  if (!figures.style?.includes('color-mix(in oklch')) failures.push(`${theme.name}: #1082 figures have no OKLCH color-mix style (${figures.style}).`);
  if (!(ratio >= 4.5)) failures.push(`${theme.name}: #1082 figures ${figures.color} on ${bg} = ${ratio?.toFixed(2)}:1 < 4.5.`);
  findings.push(`${theme.name}: #1082 figures "${figures.text}" colour ${figures.color} on ${bg}, ${ratio?.toFixed(2)}:1.`);
  const sr = await axText(cdp, `document.querySelector('[data-context-usage-figures]').parentElement.querySelector('.sr-only')`);
  if (!sr?.startsWith('Context usage')) failures.push(`${theme.name}: #1082 sr-only phrase missing (${sr}).`);
  const bar = await cdp.evaluate(`(() => { const b = ${BAR}; if (!b) return null; const fill = b.firstElementChild; return { hidden: b.getAttribute('aria-hidden'), h: b.getBoundingClientRect().height, w: b.getBoundingClientRect().width, fw: fill.getBoundingClientRect().width, fill: getComputedStyle(fill).backgroundColor, track: getComputedStyle(b).backgroundColor }; })()`);
  if (!bar) failures.push(`${theme.name}: #1082 bar missing with the setting on.`);
  else {
    if (bar.hidden !== 'true' || Math.abs(bar.h - 2) > 0.5) failures.push(`${theme.name}: #1082 bar not 2px aria-hidden (${JSON.stringify(bar)}).`);
    if (bar.fill !== figures.color) failures.push(`${theme.name}: #1082 bar fill ${bar.fill} differs from figures ${figures.color}.`);
    findings.push(`${theme.name}: #1082 bar ${JSON.stringify(bar)}.`);
  }
  const probes = await cdp.evaluate(`(() => { const out = []; for (const css of ${JSON.stringify(Array.from({ length: 11 }, (_, i) => mixFor(i * 10)))}) { const s = document.createElement('span'); s.style.color = css; document.body.appendChild(s); out.push(getComputedStyle(s).color); s.remove(); } const read = (n) => { const s = document.createElement('span'); s.style.color = 'var(' + n + ')'; document.body.appendChild(s); const c = getComputedStyle(s).color; s.remove(); return c; }; return { colours: out, stops: ['--context-usage-0', '--context-usage-30', '--context-usage-70', '--context-usage-100'].map(read) }; })()`);
  const toLch = (raw) => {
    const e = parseComputedColorToEntry(raw);
    return e;
  };
  const stopEntries = probes.stops.map(toLch);
  if (stopEntries.some((e) => !e)) {
    failures.push(`${theme.name}: #1082 token stops unreadable ${JSON.stringify(probes.stops)}.`);
    return;
  }
  const oklch = (linear) => {
    const [r, g, b] = linear;
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    const C = Math.hypot(A, B);
    return { L, C, H: C < 1e-4 ? null : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
  };
  const stops = { 0: oklch(stopEntries[0].linear), 30: oklch(stopEntries[1].linear), 70: oklch(stopEntries[2].linear), 100: oklch(stopEntries[3].linear) };
  let worst = Infinity;
  let maxDiff = 0;
  probes.colours.forEach((raw, i) => {
    const live = parseComputedColorToEntry(raw);
    const r = measuredContrastRatio(raw, bg);
    worst = Math.min(worst, r ?? 0);
    if (!(r >= 4.5)) failures.push(`${theme.name}: #1082 live blend @${i * 10}% ${raw} = ${r?.toFixed(2)}:1 < 4.5.`);
    const gate = contextUsageLinear(stops, i * 10);
    if (live) maxDiff = Math.max(maxDiff, ...gate.map((v, k) => Math.abs(Math.min(1, Math.max(0, live.linear[k])) - v)));
  });
  if (maxDiff > 0.03) failures.push(`${theme.name}: #1082 renderer blend differs from the contrast gate's math by ${maxDiff.toFixed(3)} (linear sRGB).`);
  findings.push(`${theme.name}: #1082 live blend 0-100% every 10%: worst ${worst.toFixed(2)}:1, max deviation from gate math ${maxDiff.toFixed(4)}.`);
}

async function checkBarSetting(cdp, failures, findings) {
  const toggle = async (want) => {
    await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
    await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings open' });
    await cdp.click(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === 'Chat')`);
    await cdp.waitFor(`!!document.getElementById('show-context-usage-bar')`, { timeoutMs: 10_000, label: 'Show context usage bar switch' });
    const ax = await getAccessibleNameAndRole(cdp, `document.getElementById('show-context-usage-bar')`);
    const state = await cdp.evaluate(`document.getElementById('show-context-usage-bar').getAttribute('aria-checked')`);
    if (state !== String(!want)) failures.push(`#1082: switch state ${state} before toggling to ${want}.`);
    await cdp.click(`document.getElementById('show-context-usage-bar')`);
    await cdp.waitFor(`document.getElementById('show-context-usage-bar').getAttribute('aria-checked') === ${JSON.stringify(String(want))}`, { timeoutMs: 10_000, label: 'switch toggled' });
    await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
    await cdp.waitFor(`!!${FIGURES}`, { timeoutMs: 15_000, label: 'back in chat with figures' });
    return ax;
  };
  const ax = await toggle(false);
  if (ax.name !== 'Show context usage bar' || ax.role !== 'switch') failures.push(`#1082: switch AX ${JSON.stringify(ax)}.`);
  if (await cdp.evaluate(`!!${BAR}`)) failures.push('#1082: bar still shown with the setting off.');
  await toggle(true);
  if (!(await cdp.evaluate(`!!${BAR}`))) failures.push('#1082: bar did not return with the setting back on.');
  findings.push(`#1082: Settings > Chat "${ax.name}" (${ax.role}) hides the bar when off and restores it when on (default on).`);
}

async function main() {
  const findings = [];
  const failures = [];
  const notExercised = [];
  const shots = [];
  mkdirSync(SHOTS_DIR, { recursive: true });
  const head = gitHead(REPO_ROOT);
  const dirty = computeDirty(REPO_ROOT);
  console.log(`${LOG}: git HEAD ${head}${dirty === true ? ' (DIRTY)' : ''}`);
  const stamp = Date.now();
  const dir = (name) => {
    const p = path.join(SCRATCH, `${name}-${stamp}`);
    mkdirSync(p, { recursive: true });
    return p;
  };
  const dataDir = dir('data');
  const importDir = dir('import');
  const repoDir = makeScratchRepo(path.join(dir('repo'), 'lanec-scratch'), LOG);
  writeFileSync(path.join(repoDir, 'README.md'), '# Lane C scratch repo\n');
  git(repoDir, ['add', 'README.md']);
  git(repoDir, ['-c', `user.name=${LOG}`, '-c', `user.email=${LOG}@example.invalid`, 'commit', '-q', '-m', 'seed']);
  const exeDir = dir('exe');
  const exePath = path.join(exeDir, 'refract-tauri.exe');
  copyFileSync(EXE_SOURCE, exePath);
  const exeHash = sha256OfFile(exePath);
  console.log(`${LOG}: exe sha256 ${exeHash}`);
  const png = redPngBase64();
  const realOmp = spawnSync('where.exe', ['omp'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).find((l) => l.toLowerCase().endsWith('.exe'));
  if (!realOmp) throw new Error(`${LOG}: real omp.exe not found on PATH`);
  const shimDir = dir('shim');
  buildOmpShim(shimDir);
  const passthrough = path.join(shimDir, 'omp-passthrough.mjs');
  writeFileSync(passthrough, [
    "import { spawn } from 'node:child_process';",
    "const args = process.argv.slice(2);",
    "const extra = ['--no-tools', '--no-extensions', '--no-skills', '--no-rules', '--no-title', '--model', 'haiku', '--thinking', 'off'];",
    `const child = spawn(${JSON.stringify(realOmp)}, args.includes('--mode') ? [...args, ...extra] : args, { stdio: 'inherit', windowsHide: true });`,
    "child.on('exit', (code) => process.exit(code ?? 1));"
  ].join('\n'));
  findings.push(`Real omp ${realOmp} via the PATH shim, extra flags: --no-tools --no-extensions --no-skills --no-rules --no-title --model haiku --thinking off.`);
  let child;
  let cdp;
  try {
    const launcherExe = buildLauncher(dir('launcher'));
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, logFile: path.join(exeDir, 'app.log'), pathPrepend: shimDir, extraEnv: { REFRACT_IMPORT_SOURCE_DIR: importDir, REFRACT_FAKE_OMP_SCRIPT: passthrough, REFRACT_FAKE_OMP_NODE: process.execPath } });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error(`${LOG}: CDP port ${port} not owned by pid ${launched.targetPid}`);
    assertExeUnchanged(exePath, exeHash, 'post-launch', LOG);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });

    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 90_000, label: 'Readiness green (real omp)' });
    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add repository', { inDialog: true });
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, { timeoutMs: 15_000, label: 'Create session enabled' });
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 120_000, label: 'Session composer enabled (real omp attached)' });
    const worktree = git(repoDir, ['worktree', 'list', '--porcelain']).split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).find((p) => path.resolve(p) !== path.resolve(repoDir));
    if (!worktree) throw new Error('Session worktree not found');
    findings.push(`Session created on real omp; worktree ${worktree}.`);

    await checkBranch(cdp, worktree, failures, findings);
    await shot(cdp, shots, 'p1-narrow-strip-long-branch.png', `document.querySelector('[data-composer-row]')`);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(400);
    await checkDetached(cdp, worktree, failures, findings);

    await checkImageOnly(cdp, png, failures, findings);
    await checkBarSetting(cdp, failures, findings);

    for (const theme of THEMES) {
      try {
        await switchTheme(cdp, theme.id, theme.name);
        await closeTooltips(cdp);
        await checkContextUsage(cdp, theme, failures, findings);
        await shot(cdp, shots, `${theme.id}-composer-strip.png`, `document.querySelector('[data-composer-row]').parentElement.parentElement`);
        await shot(cdp, shots, `${theme.id}-context-usage-chip.png`, `${FIGURES}.closest('[data-slot="readout-chip"]')`);
      } catch (err) {
        failures.push(`${theme.name}: ${err.message}`);
      }
    }
    assertExeUnchanged(exePath, exeHash, 'end of run', LOG);
    notExercised.push('#1082 90%+ "high" state live: the session never reaches 90% context usage; the colour at 90% and 100% is measured through the live renderer blend probes above, and the word/icon markup is unchanged from FR-003.');
    notExercised.push('#1082 forced-colors mode: WebView2 CDP has no working forced-colors emulation (same limitation as verify-1122); colour is inline style, which the browser overrides in forced colors, and the bar carries `forced-colors:hidden`.');
    notExercised.push('#744 Send now / Remove on the image-only chip: the RPC text ("" for "[Image]") was probed against real OMP 18.12.5 directly (promote and remove both succeeded), not clicked in this run.');
  } catch (err) {
    failures.push(`run aborted: ${err.message}`);
    try {
      await cdp.screenshot(path.join(SHOTS_DIR, 'abort.png'));
      const dump = await cdp.evaluate(`({ draft: document.querySelector('[aria-label="Message"]')?.value, transcriptTail: (document.querySelector('[aria-label="Transcript"]')?.textContent ?? '').slice(-600), toasts: Array.from(document.querySelectorAll('[data-sonner-toast]')).map((t) => t.textContent) })`);
      findings.push(`abort dump: ${JSON.stringify(dump)}`);
    } catch { /* page gone */ }
  } finally {
    try { cdp?.close(); } catch { /* already closed */ }
    if (child) await stopLauncher(child);
  }
  const report = { gitHead: head, dirty, exeSha256: exeHash, screenshots: shots.length ? citeScreenshots(SHOTS_DIR, shots) : [], findings, failures, notExercised };
  writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n=== FAILURES ===\n${failures.length ? failures.map((f) => `- ${f}`).join('\n') : '(none)'}`);
  console.log(`\n=== FINDINGS ===\n${findings.map((f) => `- ${f}`).join('\n')}`);
  console.log(`\n=== NOT EXERCISED ===\n${notExercised.map((n) => `- ${n}`).join('\n')}`);
  console.log(`\n${LOG}: ${failures.length ? 'FAILED' : 'DONE'} (shots and report.json in ${SHOTS_DIR})`);
  process.exitCode = failures.length ? 1 : 0;
}

main();
