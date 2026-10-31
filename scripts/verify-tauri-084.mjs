#!/usr/bin/env node
// Live CDP check for spec 084 (#1474, #458 slice 6): Mermaid, Shiki and scrollbar colours follow theme tokens, on a built Tauri debug exe with fake `omp`.
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_084_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-084.mjs

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { addRepository } from './verify-tauri-session-list-helpers.mjs';
import { makeFakeGithubRepo } from './verify-1121-pr-polish-fake-gh.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-084';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_084_SHOTS_DIR || path.join(tmpdir(), 'refract-084-shots');
const FIELD = `document.querySelector('[aria-label="Message"]')`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CUSTOM = { 'mermaid-node-fill': '#c2185b', 'mermaid-node-fg': '#ffffff', 'syntax-keyword': '#ff6600', 'code-block-fg': '#00e5ff', 'scrollbar-thumb': '#00c853' };
const rgb = (hex) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
const radio = (name) => `Array.from(document.querySelectorAll('[role="radio"]')).find((el) => el.textContent.trim().startsWith(${JSON.stringify(name)}))`;
const DIAGRAM = `Array.from(document.querySelectorAll('img')).find((i) => (i.getAttribute('alt') || i.getAttribute('aria-label') || '').toLowerCase().includes('diagram'))`;
const CODE_WRAP = `Array.from(document.querySelectorAll('.not-prose')).find((b) => b.textContent.includes('const greeting'))`;

// Svg source decoded from the diagram image, lower-cased, plus the keyword and plain-text colours inside the code block.
const SNAPSHOT = `(() => {
  const img = ${DIAGRAM};
  const src = img ? decodeURIComponent(img.src.split(',').slice(1).join(',')).toLowerCase() : '';
  const wrap = ${CODE_WRAP};
  const spans = wrap ? Array.from(wrap.querySelectorAll('code span')) : [];
  const kw = spans.find((s) => s.textContent.trim() === 'const');
  const probe = document.createElement('div');
  probe.style.cssText = 'color:var(--scrollbar-thumb);background:var(--scrollbar-thumb)';
  document.body.appendChild(probe);
  const thumb = getComputedStyle(probe).backgroundColor;
  probe.remove();
  const real = document.querySelector('[data-slot="scroll-area-thumb"]');
  return { svg: src, keyword: kw ? getComputedStyle(kw).color : null, codeFg: wrap ? getComputedStyle(wrap.querySelector('code')).color : null, thumb, realThumb: real ? getComputedStyle(real).backgroundColor : null };
})()`;

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const report = [];
  const check = (ok, label, extra) => {
    report.push({ step: label, ok, ...(extra !== undefined ? { extra } : {}) });
    console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` ${JSON.stringify(extra ?? '')}`}`);
  };
  const mk = (n) => mkdtempSync(path.join(tmpdir(), `refract-084-${n}-`));
  const dirs = { data: mk('data'), imp: mk('import'), repo: makeFakeGithubRepo(mk('repo')), exe: mk('exe'), launcher: mk('launcher'), shim: mk('shim') };
  let child;
  let cdp;
  try {
    mkdirSync(path.join(dirs.data, 'themes'));
    writeFileSync(path.join(dirs.data, 'themes', 'per-element.json'), JSON.stringify({ version: 1, name: 'Per Element', base: 'dark', tokens: CUSTOM }));
    buildOmpShim(dirs.shim);
    const launcherExe = buildLauncher(dirs.launcher);
    const exeInfo = buildAndCopyExeFresh(dirs.exe, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exeInfo.dest, {
      port,
      dataDir: dirs.data,
      pathPrepend: dirs.shim,
      logFile: path.join(dirs.exe, 'app.log'),
      extraEnv: {
        REFRACT_IMPORT_SOURCE_DIR: dirs.imp,
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'transcript-menus-065'
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error(`${LOG}: CDP target is not this run's process`);
    const waitFor = (expr, label, timeoutMs = 15_000) => cdp.waitFor(expr, { timeoutMs, label });
    const shot = (name) => cdp.screenshot(path.join(SHOTS_DIR, name));

    await waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, 'Readiness green', 90_000);
    await addRepository(cdp, dirs.repo);
    await waitFor(`!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`, 'Repo added', 30_000);
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, 'New session dialog');
    await cdp.clickByText('Create session', { inDialog: true });
    await waitFor(`!document.querySelector('[role="dialog"]')`, 'Dialog closed');
    await waitFor(`(() => { const el = ${FIELD}; return !!el && !el.disabled; })()`, 'Composer enabled', 60_000);
    await cdp.click(FIELD);
    await cdp.send('Input.insertText', { text: 'hello theme 084' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await waitFor(`!!(${DIAGRAM}) && !!(${CODE_WRAP})`, 'diagram and code block rendered', 60_000);

    const prevSvg = { v: '' };
    const pick = async (name) => {
      await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
      await waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, 'Settings opened');
      await cdp.click(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === 'Appearance')`);
      await waitFor(`!!${radio(name)}`, `${name} listed`);
      await cdp.click(radio(name));
      await waitFor(`${radio(name)}?.getAttribute('aria-checked') === 'true'`, `${name} checked`);
      await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
      await waitFor(`!!(${DIAGRAM}) && !!(${CODE_WRAP})`, `${name}: diagram and code block back`);
      await waitFor(`(() => { const i = ${DIAGRAM}; return !!i && decodeURIComponent(i.src.split(',').slice(1).join(',')).toLowerCase() !== ${JSON.stringify(prevSvg.v)}; })()`, `${name}: diagram re-rendered`, 30_000);
      await sleep(300);
    };

    const snaps = {};
    for (const [name, slug] of [['Dark', 'dark'], ['Obsidian', 'obsidian'], ['Per Element', 'custom']]) {
      await pick(name);
      snaps[slug] = await cdp.evaluate(SNAPSHOT);
      prevSvg.v = snaps[slug].svg;
      await shot(`chat-${slug}.png`);
    }
    const s = snaps;
    check(s.dark.svg.includes('<svg') && s.obsidian.svg.includes('<svg'), 'built-in themes render a Mermaid SVG');
    check(s.dark.svg !== s.obsidian.svg, 'Mermaid SVG differs between Dark and Obsidian', null);
    check(s.dark.thumb !== s.custom.thumb && s.custom.thumb === rgb(CUSTOM['scrollbar-thumb']), 'custom theme recolours --scrollbar-thumb live', { dark: s.dark.thumb, custom: s.custom.thumb });
    check(s.custom.realThumb === null || s.custom.realThumb === rgb(CUSTOM['scrollbar-thumb']), 'a real scroll-area thumb, when mounted, paints the custom colour', s.custom.realThumb);
    check(s.custom.codeFg === rgb(CUSTOM['code-block-fg']), 'custom theme recolours the code block foreground live', { custom: s.custom.codeFg });
    check(s.custom.svg.includes(CUSTOM['mermaid-node-fill']), 'custom theme node fill appears in the rendered Mermaid SVG', { dark: s.dark.svg.includes(CUSTOM['mermaid-node-fill']) });
    check(!s.dark.svg.includes(CUSTOM['mermaid-node-fill']), 'built-in Dark SVG does not contain the custom node fill');
    check(s.custom.keyword === rgb(CUSTOM['syntax-keyword']), 'custom theme recolours the Shiki keyword token live', { custom: s.custom.keyword, dark: s.dark.keyword });
    check(s.dark.keyword !== s.custom.keyword, 'built-in Dark keyword colour differs from the custom one', s.dark.keyword);
  } catch (err) {
    check(false, `run aborted: ${err.message}`, String(err.stack ?? err));
    process.exitCode = 1;
  } finally {
    if (cdp && report.some((r) => r.ok === false)) await cdp.screenshot(path.join(SHOTS_DIR, 'failure.png')).catch(() => {});
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHead(REPO_ROOT), failures: report.filter((r) => r.ok === false).map((r) => r.step), results: report }, null, 2));
    } catch (writeErr) {
      console.error(`${LOG}: failed to write report.json: ${writeErr}`);
    }
    cdp?.close();
    if (child) await stopLauncher(child);
    for (const dir of Object.values(dirs)) await safeRmSync(dir);
    if (report.some((r) => r.ok === false)) process.exitCode = 1;
  }
}

main();
