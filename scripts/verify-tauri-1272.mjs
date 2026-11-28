#!/usr/bin/env node
// Live CDP check for epic #1272's UI fixes (#1774, #1756, #2240, #2296, #2299, #2300); tape scripts/fixtures/omp-frames/subagents-1272.jsonl.
// One Session, two turns: two background Stages, then one text-split Stage (a failed agent, long title) plus one more. Scenarios a-e are named below.
// Env: REFRACT_1272_SCRATCH_DIR, REFRACT_1272_SHOTS_DIR, REFRACT_1272_EXE (default: <CARGO_TARGET_DIR>/debug/refract-tauri.exe, never rebuilt here).

import { mkdtempSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, safeRmSync, sha256OfFile } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';
import { settleForScreenshot } from './verify-700-todo-pin-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRATCH = process.env.REFRACT_1272_SCRATCH_DIR || 'C:/Users/shopwood/AppData/Local/Temp/scratch/live-1272-ui';
const SHOTS_DIR = process.env.REFRACT_1272_SHOTS_DIR || path.join(SCRATCH, `shots-${Date.now()}`);
const EXE_SRC = process.env.REFRACT_1272_EXE || path.join(process.env.CARGO_TARGET_DIR || 'C:/Users/shopwood/.cargo-target/refract', 'debug', 'refract-tauri.exe');
const RAIL = `document.querySelector('[data-rail-button="subagents"]')`;
const PILL = `Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('Open subagents panel ('))`;
// The smallest ancestor of the composer that also holds the transcript's progressbar: the chat pane, without the Session sidebar.
const PANE = `(() => { let el = document.querySelector('[aria-label="Message"]'); while (el && !el.querySelector('[role="progressbar"]')) el = el.parentElement; return el; })()`;
const CARDS = `Array.from((${PANE}).querySelectorAll('button[aria-label^="Subagents, "]'))`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const findings = [];
  const failures = [];
  const dirs = {};
  const scenarios = [];
  let current = null;
  const scenario = (name) => {
    current = { name, ok: true };
    scenarios.push(current);
  };
  const check = (name, ok, detail) => {
    if (!ok && current) current.ok = false;
    findings.push(`${ok ? 'PASS' : 'FAIL'} [${current?.name}] ${name}: ${detail}`);
    if (!ok) failures.push(`#1272: [${current?.name}] ${name}: ${detail}`);
  };
  let child, cdp, gitHeadSha = null;
  try {
    mkdirSync(SHOTS_DIR, { recursive: true });
    mkdirSync(SCRATCH, { recursive: true });
    if (!existsSync(EXE_SRC)) throw new Error(`debug exe not found at ${EXE_SRC}`);
    gitHeadSha = gitHead(REPO_ROOT);
    for (const n of ['shim', 'data', 'import', 'exe', 'launcher']) dirs[n] = mkdtempSync(path.join(SCRATCH, `${n}-`));
    dirs.repo = makeScratchRepo(mkdtempSync(path.join(SCRATCH, 'repo-')), 'verify-1272');
    const shoot = async (name) => {
      await settleForScreenshot(cdp);
      await cdp.screenshot(path.join(SHOTS_DIR, name));
    };
    const exeDest = path.join(dirs.exe, 'refract-tauri.exe');
    copyFileSync(EXE_SRC, exeDest);
    findings.push(`exe: ${EXE_SRC} sha256 ${sha256OfFile(exeDest)}; head ${gitHeadSha}`);

    const port = await getFreePort();
    buildOmpShim(dirs.shim);
    const launcherExe = buildLauncher(dirs.launcher);
    const launched = await launchBuiltExeWithEnv(launcherExe, exeDest, {
      port,
      dataDir: dirs.data,
      importSourceDir: dirs.import,
      pathPrepend: dirs.shim,
      logFile: path.join(dirs.exe, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'subagents-1272',
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(dirs.exe, 'fake-omp-invocations.log')
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the launched process');
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 90_000, label: 'Readiness green' });
    await addRepository(cdp, dirs.repo);
    await createSessionViaQuickCreate(cdp, path.basename(dirs.repo));

    const runTurn = async (text, marker) => {
      await cdp.typeIntoByLabel('Message', text);
      await cdp.clickByLabel('Send message');
      await cdp.waitFor(`document.body.innerText.includes(${JSON.stringify(marker)})`, { timeoutMs: 30_000, label: `turn "${marker}" settled` });
      await sleep(800);
    };
    const paneText = () => cdp.evaluate(`(${PANE}).innerText.replace(/\\s+/g, ' ')`);
    const cardTexts = () => cdp.evaluate(`${CARDS}.map((b) => b.getAttribute('aria-label'))`);
    const stageLabels = () =>
      cdp.evaluate(`Array.from((${PANE}).querySelectorAll('[role="progressbar"][aria-describedby]')).map((bar) => {
        const list = document.getElementById(bar.getAttribute('aria-describedby'));
        return list ? Array.from(list.querySelectorAll('li')).map((li) => li.textContent) : null;
      })`);
    const pillLabel = () => cdp.evaluate(`(${PILL})?.getAttribute('aria-label') ?? null`);
    const closePanel = async () => {
      if ((await cdp.evaluate(`(${RAIL}).getAttribute('aria-pressed')`)) === 'true') await cdp.click(RAIL);
      await cdp.waitFor(`(${RAIL}).getAttribute('aria-pressed') === 'false'`, { timeoutMs: 15_000, label: 'panel closed' });
    };

    // (a) two background agents, running: the card is in the transcript, nothing waits above the composer.
    scenario('a: background agents make a Subagents card, no waiting row above the composer');
    await runTurn('Run the background agents (epic #1272 live check).', 'Turn one done');
    await cdp.waitFor(`${CARDS}.length >= 1 && !!(${PILL})`, { timeoutMs: 30_000, label: 'Subagents card and pill mounted' });
    const a = { cards: await cardTexts(), pane: await paneText(), pill: await pillLabel() };
    findings.push(`a: ${JSON.stringify({ cards: a.cards, pill: a.pill })}`);
    check('the transcript shows a running Subagents card', a.cards.length === 1 && /2 agents, 2 running/.test(a.cards[0]), JSON.stringify(a.cards));
    check('no "Waiting for N subagents" row in the chat pane', !/Waiting for \d+ subagents?/i.test(a.pane), a.pane.match(/Waiting for[^.]{0,40}/i)?.[0] ?? 'none');
    check('no background-agents banner in the chat pane', !/\d+ background (agents?|tasks?)/i.test(a.pane), a.pane.match(/\d+ background[^.]{0,40}/i)?.[0] ?? 'none');
    await shoot('1272-a-card-no-waiting-row.png');

    // (b) the second turn's text-split Stage: numbers run on without a gap or repeat; card, panel and pill agree.
    scenario('b: Stage numbers 1..N with matching card, panel and pill counts');
    await runTurn('Review the pipeline (epic #1272 live check).', 'Turn two done');
    await cdp.waitFor(`${CARDS}.length >= 2`, { timeoutMs: 30_000, label: 'second Subagents card' });
    const labels = (await stageLabels()).flat();
    const numbers = labels.map((l) => Number(/^Stage (\d+)/.exec(l ?? '')?.[1] ?? NaN));
    findings.push(`b: labels ${JSON.stringify(labels)}`);
    check('Stage numbers run 1..N in order, no gap or repeat', numbers.length >= 3 && numbers.every((n, i) => n === i + 1), JSON.stringify(numbers));
    const cards = await cardTexts();
    const sum = (re) => cards.reduce((n, label) => n + Number(re.exec(label)?.[1] ?? 0), 0);
    const cardStages = sum(/(\d+) stages?/);
    const cardAgents = sum(/(\d+) agents?/);
    const cardRunning = sum(/(\d+) running/);
    const pill = await pillLabel();
    findings.push(`b: cards ${JSON.stringify(cards)} pill ${pill}`);
    check('card stage count equals the numbered Stages', cardStages === numbers.length, `${cardStages} vs ${numbers.length}`);
    check('pill running count equals the cards running count', new RegExp(`\\(${cardRunning} running\\)`).test(pill ?? ''), `${pill} vs ${cardRunning}`);
    await cdp.click(RAIL);
    await cdp.waitFor(`document.querySelectorAll('[data-agents-group]').length >= 1`, { timeoutMs: 15_000, label: 'Agents panel open' });
    await sleep(500);
    const panel = await cdp.evaluate(`(() => {
      const group = document.querySelector('[data-agents-group]');
      const rows = Array.from(group.querySelectorAll('li'));
      const finished = rows.map((li) => /(\\d+) finished/.exec(li.innerText)?.[1]).filter(Boolean).map(Number).reduce((n, v) => n + v, 0);
      const agentRows = rows.filter((li) => li.querySelector('button')).length;
      return { text: group.innerText.replace(/\\s+/g, ' ').trim(), running: Number(/(\\d+) running/.exec(group.querySelector('h3')?.innerText ?? '')?.[1] ?? 0), agentRows, finished };
    })()`);
    findings.push(`b: panel ${JSON.stringify(panel)}`);
    check('panel running count equals the pill and the cards', panel.running === cardRunning, `${panel.running} vs ${cardRunning}`);
    check('panel agent rows plus its finished fold equal the cards agents count', panel.agentRows + panel.finished === cardAgents, `${panel.agentRows}+${panel.finished} vs ${cardAgents}`);
    await shoot('1272-b-numbers-and-counts.png');
    await closePanel();

    // (c) a card's Show button opens the panel with that agent selected.
    scenario('c: Show opens the Agents panel with that agent selected');
    // The first card is scrolled out of the pane by turn two, and a CDP click on an off-screen button misses.
    await cdp.evaluate(`document.querySelector('[aria-label="Show BgTwo in Subagents panel"]')?.scrollIntoView({ block: 'center' })`);
    await sleep(300);
    await cdp.click(`document.querySelector('[aria-label="Show BgTwo in Subagents panel"]')`);
    await cdp.waitFor(`(${RAIL}).getAttribute('aria-pressed') === 'true'`, { timeoutMs: 15_000, label: 'panel opened by Show' });
    await sleep(800);
    const c = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-agents-group] button[aria-current="true"]')).map((b) => b.innerText.replace(/\\s+/g, ' ').trim())`);
    findings.push(`c: selected ${JSON.stringify(c)}`);
    check('exactly BgTwo is selected', c.length === 1 && /BgTwo/.test(c[0]), JSON.stringify(c));
    await shoot('1272-c-show-selects-agent.png');
    await closePanel();

    // (d) the failed agent's Stage is open, the long title is whole, the strip lists "Stage N · ...".
    scenario('d: failed Stage open, long title whole, progress strip description');
    const d = await cdp.evaluate(`(() => {
      const pane = ${PANE};
      const failed = Array.from(pane.querySelectorAll('[role="group"][data-status="failed"]'));
      const toggles = failed.map((g) => g.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded'));
      const text = failed.map((g) => g.innerText.replace(/\\s+/g, ' ').trim());
      const bars = Array.from(pane.querySelectorAll('[role="progressbar"]')).map((bar) => {
        const list = document.getElementById(bar.getAttribute('aria-describedby') ?? '');
        return { described: !!list, items: list ? Array.from(list.querySelectorAll('li')).map((li) => li.textContent) : [] };
      });
      return { toggles, text, bars };
    })()`);
    findings.push(`d: ${JSON.stringify(d)}`);
    check('one Stage has a failed agent and it is expanded', d.toggles.length >= 1 && d.toggles.every((t) => t === 'true'), JSON.stringify(d.toggles));
    check('the failed agent is visible in the open Stage', d.text.some((t) => /RevBWithAVeryLong/.test(t)), JSON.stringify(d.text).slice(0, 300));
    const titled = d.text.find((t) => /Audit the entire reviewer pipeline/.test(t)) ?? '';
    check('the long Stage title is not cut at 60 characters', /cleanup jobs in all regions/.test(titled) && !/\u2026/.test(titled.slice(0, 200)), titled.slice(0, 240));
    check('every progress strip is described by a "Stage N · ..." list', d.bars.length >= 2 && d.bars.every((b) => b.described && b.items.length > 0 && b.items.every((i) => /^Stage \d+ · /.test(i))), JSON.stringify(d.bars));
    await shoot('1272-d-failed-stage-open.png');

    // (e) the open panel's tree has no bordered nesting and does not scroll sideways with the long agent name.
    scenario("e: the Agents panel's tree has no nested borders and no horizontal overflow");
    await cdp.click(RAIL);
    await cdp.waitFor(`(${RAIL}).getAttribute('aria-pressed') === 'true' && document.querySelectorAll('[data-agents-group] li').length > 0`, { timeoutMs: 15_000, label: 'panel open with rows' });
    await sleep(800);
    // Every shadcn Button carries "border border-transparent"; only a border that paints a colour separates nesting levels.
    const e = await cdp.evaluate(`(() => {
      const group = document.querySelector('[data-agents-group]');
      const withBorderClass = [group, ...group.querySelectorAll('*')].filter((el) => el.classList.contains('border'));
      const painted = (el) => { const s = getComputedStyle(el); return parseFloat(s.borderTopWidth) > 0 && !/^(transparent|rgba\\(\\d+, \\d+, \\d+, 0\\))$/.test(s.borderTopColor); };
      const bordered = withBorderClass.filter(painted).map((el) => el.tagName + '.' + String(el.className).slice(0, 80));
      const transparentBorderClassCount = withBorderClass.length - bordered.length;
      const overflow = [];
      for (let el = group; el && el !== document.body; el = el.parentElement) {
        if (el.scrollWidth > el.clientWidth) overflow.push({ tag: el.tagName, cls: String(el.className).slice(0, 80), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
      }
      return { bordered, transparentBorderClassCount, overflow, hasLongName: group.innerText.includes('RevBWithAVeryLong') };
    })()`);
    findings.push(`e: ${JSON.stringify(e)}`);
    check('the long agent name is in the tree', e.hasLongName, String(e.hasLongName));
    check('no element in the tree paints a `border` (transparent Button borders aside)', e.bordered.length === 0, JSON.stringify(e.bordered));
    check('no horizontal overflow from the group up to the body', e.overflow.length === 0, JSON.stringify(e.overflow));
    await shoot('1272-e-tree-no-borders-no-overflow.png');

    const passed = scenarios.filter((s) => s.ok).length;
    findings.push(`scenarios: ${passed}/${scenarios.length}`);
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, shotsDir: SHOTS_DIR, scenarios, findings, failures, exitCode: failures.length ? 1 : 0 }, null, 2));
    console.log(JSON.stringify({ scenarios, findings, failures, shotsDir: SHOTS_DIR }, null, 2));
    process.exitCode = failures.length ? 1 : 0;
  } catch (err) {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, scenarios, findings, failures, error: String(err?.stack ?? err), exitCode: 1 }, null, 2));
      if (cdp) await cdp.screenshot(path.join(SHOTS_DIR, '1272-error.png')).catch(() => {});
    } catch {}
    console.error('verify-1272: FAILED:', err?.stack ?? err);
    console.error(JSON.stringify({ scenarios, findings, failures }, null, 2));
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    try {
      for (const f of ['app.log', 'fake-omp-invocations.log']) {
        if (dirs.exe && existsSync(path.join(dirs.exe, f))) copyFileSync(path.join(dirs.exe, f), path.join(SHOTS_DIR, f));
      }
    } catch {}
    for (const d of Object.values(dirs)) await safeRmSync(d);
  }
}

main();
