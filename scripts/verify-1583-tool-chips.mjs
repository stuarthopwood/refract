#!/usr/bin/env node
// Live CDP check for #1583 (tool row targets as inline-code chips) against the fake `omp` shim
// and the `tool-chips-1583` tape. Proves chip fill/shape, muted chip text, wrapped-target
// alignment, and icon/prose left-edge alignment; screenshots in several themes.
// Usage: CARGO_TARGET_DIR=<shared target dir> node scripts/verify-1583-tool-chips.mjs

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget, switchTheme, gitHead, computeDirty, sha256OfFile } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1583';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
// Default evidence dir lives under the OS temp dir, never a repo or user-profile path.
const SHOTS_DIR = process.env.REFRACT_1583_SHOTS_DIR || path.join(tmpdir(), 'verify-1583-shots');
const FRAMES = readFileSync(path.join(__dirname, 'fixtures/omp-frames/tool-chips-1583.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const callArgs = (id) => FRAMES.find((f) => f.type === 'tool_execution_start' && f.toolCallId === id).args;
// Exact command of fixture tool call c2; chips must reproduce it byte for byte (spaces before flags included).
const C2_COMMAND = callArgs('c2').command;
// Mirrors middleTruncate(text, ATTRIBUTION_PREFIX_MAX_CHARS = 40) in ToolRow.tsx: the group row's failing-command chip.
const middleTruncate = (text, max) => {
  if (text.length <= max) return text;
  const tail = Math.ceil((max - 1) * 0.6);
  return `${text.slice(0, max - 1 - tail)}\u2026${text.slice(-tail)}`;
};
// Chip texts the tape must produce, in transcript order: solo read, solo bash c2, solo grep, and the c4+c5 group's failing command (c5).
const EXPECTED_CHIPS = [
  ['read c1 path', (t) => t.endsWith(path.basename(callArgs('c1').path))],
  ['bash c2 command', (t) => t === C2_COMMAND],
  ['grep c3 "pattern" path', (t) => t === `"${callArgs('c3').pattern}" ${callArgs('c3').path}`],
  ['group failing command c5 (middle-truncated to 40)', (t) => t === middleTruncate(callArgs('c5').command, 40)]
];
// Computed colours that paint nothing: 'transparent', rgba(..., 0), or any `/ 0` alpha form.
const isClear = (v) => !v || v === 'transparent' || /,\s*0(\.0+)?\s*\)$/.test(v) || /\/\s*0(\.0+)?%?\s*\)$/.test(v);
const THEMES = [
  ['dark', 'Dark'],
  ['obsidian', 'Obsidian'],
  ['dark-high-contrast', 'Dark (high contrast)']
];

const report = [];
function check(ok, label, evidence) {
  report.push({ step: label, ok: ok === true, evidence });
  console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label} ${evidence === undefined ? '' : JSON.stringify(evidence)}`);
}
const shot = async (cdp, name) => {
  await sleep(400);
  await cdp.screenshot(path.join(SHOTS_DIR, name));
};
// Fill: the --md-code-bg probe and the prose chip must really paint, and every tool chip must match both.
function chipFill(c) {
  const proseBg = c.prose ? c.prose.bg : null;
  const ok = c.chips.length >= EXPECTED_CHIPS.length && !isClear(c.fill) && !!proseBg && !isClear(proseBg) && proseBg === c.fill && c.chips.every((x) => !isClear(x.bg) && x.bg === proseBg);
  return [ok, { fill: c.fill, proseBg, chips: c.chips.length, bgs: [...new Set(c.chips.map((x) => x.bg))] }];
}
// Muted: the --tool-row-fg probe must differ from inherited body text (else the probe resolved nothing), every chip
// must use it, and it must differ from the colour of the label text beside the chip.
function chipMuted(c) {
  const ok = c.chips.length >= EXPECTED_CHIPS.length && !isClear(c.muted) && c.muted !== c.body && c.chips.every((x) => x.color === c.muted && x.labelColor !== null && x.color !== x.labelColor);
  return [ok, { muted: c.muted, body: c.body, chips: c.chips.map((x) => ({ color: x.color, labelColor: x.labelColor })) }];
}

// `fill`/`muted` resolve the theme variables through inline styles (a Tailwind class absent from the bundle would
// silently compute transparent/inherited); the checks below still assert they are non-transparent and differ from body text.
const CHIPS = `(() => {
  const probe = (css, prop) => { const el = document.createElement('span'); el.style.cssText = css; document.body.appendChild(el); const v = getComputedStyle(el)[prop]; el.remove(); return v; };
  const style = (el) => { const s = getComputedStyle(el); return { bg: s.backgroundColor, color: s.color, font: s.fontFamily, size: s.fontSize, ratio: (parseFloat(s.fontSize) / parseFloat(getComputedStyle(el.parentElement).fontSize)).toFixed(2), radius: s.borderTopLeftRadius, padL: s.paddingLeft, padR: s.paddingRight }; };
  const labelColor = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { const l = p.querySelector('[data-slot="collapsed-line-label"]'); if (l) return getComputedStyle(l).color; } return null; };
  const chips = Array.from(document.querySelectorAll('[data-slot="tool-target"]')).filter((el) => el.offsetParent !== null);
  const prose = Array.from(document.querySelectorAll('[data-slot="message"] [data-slot="inline-code"]')).pop();
  return {
    fill: probe('background-color: var(--md-code-bg)', 'backgroundColor'),
    muted: probe('color: var(--tool-row-fg)', 'color'),
    body: getComputedStyle(document.body).color,
    chips: chips.map((el) => ({ text: el.textContent, ...style(el), display: getComputedStyle(el).display, labelColor: labelColor(el) })),
    prose: prose ? { text: prose.textContent, ...style(prose) } : null
  };
})()`;
const ICON_VS_PROSE = `(() => {
  const icon = Array.from(document.querySelectorAll('[data-slot="message-scroller-item"] button[aria-expanded] svg')).find((el) => el.getBoundingClientRect().width > 0);
  const para = Array.from(document.querySelectorAll('[data-slot="message"] p')).pop();
  return { iconLeft: icon ? icon.getBoundingClientRect().left : null, proseLeft: para ? para.getBoundingClientRect().left : null };
})()`;
const WRAPPED_ROW = () => `(() => {
  const btn = Array.from(document.querySelectorAll('button[aria-expanded]')).find((b) => b.textContent.includes('vitest'));
  if (!btn) return null;
  const chip = btn.querySelector('[data-slot="tool-target"]');
  const label = btn.querySelector('[data-slot="collapsed-line-label"]');
  const rects = Array.from(chip.getClientRects());
  return { expanded: btn.getAttribute('aria-expanded'), lines: rects.length, labelLeft: label ? label.getBoundingClientRect().left : null, chipLefts: rects.map((r) => Math.round(r.left)), rowRight: Math.round(btn.getBoundingClientRect().right), chipRights: rects.map((r) => Math.round(r.right)) };
})()`;
// Geometry of every visible tool row: icon wrapper, label, each chip line box and meta, for overlap checks.
const ROW_GEOM = `(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
  const hit = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 0.5 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 0.5;
  return Array.from(document.querySelectorAll('button[aria-expanded]')).filter((b) => b.querySelector('[data-slot="tool-target"]') && b.offsetParent !== null).map((btn) => {
    const chip = btn.querySelector('[data-slot="tool-target"]');
    const label = btn.querySelector('[data-slot="collapsed-line-label"]');
    const iconWrap = btn.querySelector('svg') && btn.querySelector('svg').parentElement;
    const meta = btn.lastElementChild && /tabular-nums/.test(btn.lastElementChild.className) ? btn.lastElementChild : null;
    const pieces = [];
    if (iconWrap) pieces.push(['icon', box(iconWrap)]);
    if (label) pieces.push(['label', box(label)]);
    Array.from(chip.getClientRects()).forEach((r, i) => pieces.push(['chip' + i, { l: r.left, t: r.top, r: r.right, b: r.bottom }]));
    if (meta) pieces.push(['meta', box(meta)]);
    const overlaps = [];
    for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++) if (hit(pieces[i][1], pieces[j][1])) overlaps.push(pieces[i][0] + '/' + pieces[j][0]);
    const chipVsLabel = label ? pieces.filter((p) => p[0].startsWith('chip')).some((p) => hit(p[1], box(label))) : false;
    const svg = btn.querySelector('svg');
    return { expanded: btn.getAttribute('aria-expanded'), isVitest: btn.textContent.includes('vitest'), text: chip.textContent, pieces: pieces.length, overlaps, chipVsLabel, iconX: svg ? svg.getBoundingClientRect().left : null };
  });
})()`;
// Focus-ring computed style of the vitest row button plus the extent it paints OUTSIDE its border box
// (an inset outline, offset -2px on a 2px width, paints none) and whether a clipping ancestor cuts that extent.
const RING_CLIP = `(() => {
  const btn = Array.from(document.querySelectorAll('button[aria-expanded]')).find((b) => b.textContent.includes('vitest'));
  if (!btn) return null;
  const s = getComputedStyle(btn);
  const outside = s.outlineStyle !== 'none' ? Math.max(0, (parseFloat(s.outlineWidth) || 0) + (parseFloat(s.outlineOffset) || 0)) : 0;
  const px = (s.boxShadow.match(/(-?[\\d.]+)px/g) || []).map(parseFloat);
  const shadow = s.boxShadow === 'none' || s.boxShadow.includes('inset') ? 0 : Math.max(0, ...px.slice(2, 4));
  const ring = Math.max(outside, shadow);
  const r = btn.getBoundingClientRect();
  const want = { l: r.left - ring, t: r.top - ring, r: r.right + ring, b: r.bottom + ring };
  const clippers = [];
  for (let el = btn.parentElement; el && el !== document.documentElement; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
    const c = el.getBoundingClientRect();
    const cut = { x: cs.overflowX !== 'visible' && (want.l < c.left - 0.5 || want.r > c.right + 0.5), y: cs.overflowY !== 'visible' && (want.t < c.top - 0.5 || want.b > c.bottom + 0.5) };
    if (cut.x || cut.y) clippers.push({ tag: el.tagName, slot: el.getAttribute('data-slot'), cut });
  }
  return { ring, outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, outlineOffset: s.outlineOffset, outlineColor: s.outlineColor, boxShadow: s.boxShadow, clippers, focusVisible: btn.matches(':focus-visible') };
})()`;
// Computed paint of the vitest row (button, three ancestors, chip) and whether the pointer really hovers it.
const HOVER_STATE = `(() => {
  const btn = Array.from(document.querySelectorAll('button[aria-expanded]')).find((b) => b.textContent.includes('vitest'));
  if (!btn) return null;
  const paint = (el) => { const s = getComputedStyle(el); return [s.backgroundColor, s.color, s.boxShadow, s.outlineStyle, s.opacity].join('|'); };
  const els = [btn, btn.parentElement, btn.parentElement && btn.parentElement.parentElement, btn.parentElement && btn.parentElement.parentElement && btn.parentElement.parentElement.parentElement, btn.querySelector('[data-slot="tool-target"]')].filter(Boolean);
  return { hovered: btn.matches(':hover'), paint: els.map(paint), chipBg: getComputedStyle(btn.querySelector('[data-slot="tool-target"]')).backgroundColor };
})()`;
const mouseTo = (cdp, x, y) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
const tab = async (cdp) => {
  for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
};

async function launch(env) {
  const port = await getFreePort();
  const launched = await launchBuiltExe(env.launcherExe, env.exe, {
    port,
    dataDir: env.dataDir,
    pathPrepend: env.shimDir,
    logFile: path.join(SHOTS_DIR, `app-${port}.log`),
    extraEnv: {
      REFRACT_IMPORT_SOURCE_DIR: env.importSourceDir,
      REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
      REFRACT_FAKE_OMP_NODE: process.execPath,
      REFRACT_FAKE_OMP_SCENARIO: 'tool-chips-1583'
    }
  });
  const cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
  if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target not owned by launched pid');
  console.log(`${LOG}: launched exe pid ${launched.targetPid} on port ${port}`);
  return { cdp, child: launched.child };
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1583-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1583-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1583-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1583-chips');
  const worktreesRoot = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1583-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1583-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1583-shim-'));
  const exe = path.join(exeDir, 'refract-tauri.exe');
  let session;
  try {
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    copyFileSync(path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe'), exe);
    session = await launch({ launcherExe, exe, dataDir, shimDir, importSourceDir });
    const { cdp } = session;

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness' });
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.clickByText('Local folder…', { tag: '[role="menuitem"]' });
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add project dialog' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add project', { inDialog: true });
    await cdp.waitFor(`!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`, { timeoutMs: 30_000, label: 'Repo added' });
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, { timeoutMs: 15_000, label: 'New session dialog' });
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 90_000, label: 'dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'composer enabled' });
    await sleep(3000);
    await cdp.click(`document.querySelector('[aria-label="Message"]')`);
    await cdp.send('Input.insertText', { text: 'show the tool rows' });
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`Array.from(document.querySelectorAll('[data-slot="message"]')).some((m) => m.textContent.includes('FINAL-REPLY-1583'))`, { timeoutMs: 60_000, label: 'Final reply' });
    await sleep(1000);

    const c = await cdp.evaluate(CHIPS);
    const chipTexts = c.chips.map((x) => x.text);
    const missingChips = EXPECTED_CHIPS.filter(([, matches]) => !chipTexts.some(matches)).map(([name]) => name);
    check(missingChips.length === 0, 'Tool targets render the expected chip texts (read, bash c2, grep, group failing command)', { missing: missingChips, chipTexts });
    const fill = chipFill(c);
    check(fill[0], 'Every chip has a non-transparent fill equal to the prose inline-code chip fill (--md-code-bg)', fill[1]);
    const muted = chipMuted(c);
    check(muted[0], 'Every chip text is the muted tool-row colour, distinct from the row label text colour', muted[1]);
    const shapeOf = (x) => ({ font: x.font, ratio: x.ratio, radius: x.radius, padL: x.padL, padR: x.padR });
    if (c.prose) {
      const shapeMismatch = c.chips.filter((x) => JSON.stringify(shapeOf(x)) !== JSON.stringify(shapeOf(c.prose)));
      check(shapeMismatch.length === 0, 'Chip font, size, radius and padding match the prose inline-code chip', { prose: shapeOf(c.prose), mismatched: shapeMismatch });
    } else {
      check(false, 'Chip font, size, radius and padding match the prose inline-code chip', 'no prose inline-code element found');
    }
    const align = await cdp.evaluate(ICON_VS_PROSE);
    check(align.iconLeft !== null && align.proseLeft !== null && Math.abs(align.iconLeft - align.proseLeft) <= 1, 'Tool row icon lines up with the prose left edge', align);

    const collapsedGeom = await cdp.evaluate(ROW_GEOM);
    check(collapsedGeom.length >= 3 && collapsedGeom.every((g) => g.overlaps.length === 0), 'Collapsed: no fragment overlap between icon, label, chip and meta', collapsedGeom.map((g) => ({ text: g.text.slice(0, 20), overlaps: g.overlaps })));
    check(collapsedGeom.every((g) => !g.chipVsLabel), 'Collapsed: chip box does not intersect label box', collapsedGeom.map((g) => g.chipVsLabel));
    const c2Row = collapsedGeom.find((g) => g.isVitest);
    check(!!c2Row && c2Row.text === C2_COMMAND, 'Chip textContent equals fixture c2 command exactly (spaces before flags kept)', { want: C2_COMMAND, got: c2Row && c2Row.text });

    await switchTheme(cdp, 'dark', 'Dark');
    await sleep(600);
    await shot(cdp, '10-collapsed-dark.png');

    // Hover: baseline with the pointer away, then really hover the row and require :hover plus a computed paint change.
    await mouseTo(cdp, 1, 1);
    await sleep(400);
    const rowRect = await cdp.evaluate(`(() => { const r = Array.from(document.querySelectorAll('button[aria-expanded]')).find((b) => b.textContent.includes('vitest')).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const idle = await cdp.evaluate(HOVER_STATE);
    await mouseTo(cdp, rowRect.x, rowRect.y);
    await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('button[aria-expanded]')).find((x) => x.textContent.includes('vitest')); return !!b && b.matches(':hover'); })()`, { timeoutMs: 5_000, label: 'row :hover' });
    await sleep(500);
    const hovered = await cdp.evaluate(HOVER_STATE);
    const paintChanged = !!idle && !!hovered && idle.paint.some((p, i) => p !== hovered.paint[i]);
    check(!!idle && !!hovered && idle.hovered === false && hovered.hovered === true && paintChanged && !isClear(hovered.chipBg), 'Hover: pointer over the row sets :hover, changes computed row paint, and the chip keeps a non-transparent fill', { idle, hovered });
    await mouseTo(cdp, 1, 1);
    await cdp.evaluate(`(() => {
      const sel = 'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
      const all = Array.from(document.querySelectorAll(sel)).filter((el) => el.offsetParent !== null);
      const i = all.findIndex((b) => b.matches('button[aria-expanded]') && b.textContent.includes('vitest'));
      if (i > 0) all[i - 1].focus();
      return i;
    })()`);
    await tab(cdp);
    await sleep(300);
    const focusRing = await cdp.evaluate(RING_CLIP);
    const tabFocused = await cdp.evaluate(`!!document.activeElement && document.activeElement.textContent.includes('vitest')`);
    check(tabFocused === true && !!focusRing && focusRing.focusVisible, 'Tab moves keyboard focus onto the vitest tool row', { tabFocused, focusRing });
    const f = focusRing;
    check(!!f && f.outlineStyle === 'solid' && f.outlineWidth === '2px' && f.outlineOffset === '-2px' && !isClear(f.outlineColor) && f.boxShadow === 'none', 'Focus ring is a 2px solid inset outline (offset -2px, visible colour, no box-shadow)', f);
    check(!!f && f.ring === 0 && f.clippers.length === 0, 'Focus ring paints nothing outside the row box and no ancestor clips the row', f);
    await shot(cdp, '12-tab-focus-dark.png');
    await cdp.evaluate(`document.activeElement && document.activeElement.blur()`);

    await cdp.click(`Array.from(document.querySelectorAll('button[aria-expanded]')).find((b) => b.textContent.includes('vitest'))`);
    await sleep(500);
    const wrapped = await cdp.evaluate(WRAPPED_ROW());
    check(wrapped && wrapped.expanded === 'true' && wrapped.lines > 1, 'Expanded long command wraps across several chip lines', wrapped);
    check(wrapped && wrapped.chipLefts.slice(1).every((l) => Math.abs(l - wrapped.labelLeft) <= 2), 'Wrapped lines restart under the label, not in a narrow column', wrapped);
    const expandedGeom = await cdp.evaluate(ROW_GEOM);
    check(expandedGeom.every((g) => g.overlaps.length === 0), 'Expanded/wrap: no fragment overlap between icon, label, chip and meta', expandedGeom.map((g) => ({ text: g.text.slice(0, 20), overlaps: g.overlaps })));
    check(expandedGeom.every((g) => !g.chipVsLabel), 'Expanded/wrap: chip box does not intersect label box', expandedGeom.map((g) => g.chipVsLabel));
    const expRow = expandedGeom.find((g) => g.isVitest);
    const iconShift = c2Row && expRow ? Math.abs(expRow.iconX - c2Row.iconX) : null;
    check(iconShift !== null && iconShift < 1, 'Icon x shift between collapsed and expanded is under 1px', { collapsedX: c2Row && c2Row.iconX, expandedX: expRow && expRow.iconX, shiftPx: iconShift });
    await switchTheme(cdp, 'dark', 'Dark');
    await sleep(600);
    await shot(cdp, '11-expanded-wrap-dark.png');
    await cdp.click(`Array.from(document.querySelectorAll('button[aria-expanded]')).find((b) => b.textContent.includes('vitest'))`);
    await sleep(300);

    for (const [id, name] of THEMES) {
      await switchTheme(cdp, id, name);
      await sleep(600);
      const t = await cdp.evaluate(CHIPS);
      const tf = chipFill(t);
      const tm = chipMuted(t);
      check(tf[0] && tm[0], `${name}: chips keep a non-transparent inline-code fill and a muted colour distinct from the label`, { fill: tf[1], muted: tm[1] });
      await shot(cdp, `20-theme-${id}.png`);
    }
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    console.error(err);
    try { if (session) await session.cdp.screenshot(path.join(SHOTS_DIR, 'crash.png')); } catch {}
    process.exitCode = 1;
  } finally {
    const meta = { gitHead: gitHead(REPO_ROOT), dirty: computeDirty(REPO_ROOT), exeSha256: (() => { try { return sha256OfFile(path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe')); } catch (e) { return `unavailable: ${e}`; } })() };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ ...meta, steps: report }, null, 2));
    if (session) {
      session.cdp.close();
      await stopLauncher(session.child).catch(() => {});
    }
    for (const dir of [dataDir, importSourceDir, repoDirBase, worktreesRoot, exeDir, launcherDir, shimDir]) await safeRmSync(dir, LOG);
  }
  if (report.some((r) => !r.ok)) process.exitCode = 1;
  console.log(`${LOG}: done; evidence in ${SHOTS_DIR}`);
}

main();
