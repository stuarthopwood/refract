#!/usr/bin/env node
// Live CDP check for #1636 (Usage Averages): recent-dated fixtures, real debug exe, fake omp/gh,
// scratch REFRACT_DATA_DIR and own port; never touches %APPDATA%. Averages are hand-computed here
// from the fixture and compared with the IPC summary and the rendered cards, with and without a
// Project filter, for 7d and All.
// Usage: CARGO_TARGET_DIR=<shared target dir> SHOTS_DIR=<evidence dir> node scripts/verify-tauri-1636.mjs

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { buildFakeClis } from './verify-1331-fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1636';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.SHOTS_DIR || path.join(tmpdir(), 'refract-1636-usage');
const DAY = 86_400_000;

const line = (value) => `${JSON.stringify(value)}\n`;
const call = (id, ts, cost) =>
  line({
    type: 'message',
    id,
    timestamp: new Date(ts).toISOString(),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      timestamp: ts,
      model: 'claude-sonnet',
      provider: 'github-copilot',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost } }
    }
  });

/** One file per entry; `at` is milliseconds before now, `cost` USD. Times are pinned to local noon. */
function fixture(now) {
  const noon = (daysAgo) => {
    const d = new Date(now - daysAgo * DAY);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime();
  };
  return [
    { project: 'verify1636alpha', id: 'a1', calls: [[now - 60_000, 0.1], [now - 120_000, 0.1], [noon(3), 0.3]] },
    { project: 'verify1636alpha', id: 'a2', calls: [[noon(20), 0.5]] },
    { project: 'verify1636beta', id: 'b1', calls: [[noon(1), 0.2]] }
  ];
}

function writeFixture(sessionsDir, files) {
  for (const f of files) {
    const cwd = `C:\\Work\\${f.project}`;
    const folder = path.join(sessionsDir, `--C--Work-${f.project}--`);
    mkdirSync(folder, { recursive: true });
    const t0 = new Date(Math.min(...f.calls.map((c) => c[0]))).toISOString();
    const header =
      line({ type: 'session', id: f.id, timestamp: t0, cwd }) +
      line({ type: 'model_change', id: `${f.id}m`, timestamp: t0, model: 'github-copilot/claude-sonnet' }) +
      line({ type: 'thinking_level_change', id: `${f.id}t`, timestamp: t0, thinkingLevel: 'high' });
    writeFileSync(path.join(folder, `--C--Work-${f.project}--_${f.id}.jsonl`), header + f.calls.map(([ts, cost], i) => call(`${f.id}c${i}`, ts, cost)).join(''));
  }
}

const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

function weekdaysLeft(today) {
  const last = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  let n = 0;
  for (let day = today.getDate() + 1; day <= last; day += 1) {
    const dow = new Date(today.getFullYear(), today.getMonth(), day).getDay();
    if (dow !== 0 && dow !== 6) n += 1;
  }
  return n;
}

/** Hand-computed expectations for a range and optional project, straight from the fixture. */
function expected(files, now, range, project) {
  const sel = files.filter((f) => !project || f.project === project);
  const all = sel.flatMap((f) => f.calls.map(([ts, cost]) => ({ ts, cost, file: f.id })));
  const inRange = all.filter((c) => range === 'all' || c.ts >= now - 7 * DAY);
  const today = new Date(now);
  const month = all.filter((c) => new Date(c.ts).getMonth() === today.getMonth() && new Date(c.ts).getFullYear() === today.getFullYear());
  const sum = (xs) => xs.reduce((a, c) => a + c.cost, 0);
  const days = (xs) => new Set(xs.map((c) => dayKey(c.ts))).size;
  const mtdDays = days(month);
  return {
    calls: inRange.length,
    spend: sum(inRange),
    activeDays: days(inRange),
    sessions: new Set(inRange.map((c) => c.file)).size,
    mtd: sum(month),
    mtdDays,
    projected: mtdDays > 0 ? sum(month) + (sum(month) / mtdDays) * weekdaysLeft(today) : null
  };
}

const usd = (v) => `$${v.toFixed(2)}`;
const perCall = (v) => (v < 1 ? `$${v.toFixed(3)}` : usd(v));

async function main() {
  const head = gitHead(REPO_ROOT);
  console.log(`${LOG}: git HEAD ${head}`);
  mkdirSync(SHOTS_DIR, { recursive: true });
  const report = [];
  const failures = [];
  const check = (ok, label, extra) => {
    report.push({ step: label, ok, ...(extra ? { extra } : {}) });
    if (!ok) failures.push(label);
    console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label}${ok || extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`);
  };
  const near = (a, b) => Math.abs(a - b) < 1e-6;

  const dirs = ['data', 'sessions', 'import', 'exe', 'launcher', 'shim', 'repo'].map((n) => mkdtempSync(path.join(tmpdir(), `refract-1636-${n}-`)));
  const [dataDir, sessionsDir, importSourceDir, exeDir, launcherDir, shimDir, repoDir] = dirs;
  let child;
  let cdp;
  const ipc = async (method, ...args) => {
    const r = await cdp.evaluate(`window.refract.usage.${method}(${args.map((a) => JSON.stringify(a)).join(', ')})`);
    if (!r || r.ok !== true) throw new Error(`usage.${method} failed: ${JSON.stringify(r)}`);
    return r.value;
  };
  try {
    const now = Date.now();
    const files = fixture(now);
    writeFixture(sessionsDir, files);
    buildFakeClis(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const exeInfo = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exeInfo.dest, {
      port,
      dataDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: { REFRACT_IMPORT_SOURCE_DIR: importSourceDir, REFRACT_OMP_SESSIONS_DIR: sessionsDir, OMP_PROFILE: 'verify1636' }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error(`${LOG}: CDP target is not owned by the process this run launched`);
    await cdp.waitFor(`!!(window.refract && window.refract.usage)`, { timeoutMs: 30_000, label: 'usage api' });
    await ipc('start');
    const total = files.reduce((a, f) => a + f.calls.length, 0);
    for (let i = 0; i < 100; i++) {
      if ((await ipc('summary', { range: 'all' })).calls >= total) break;
      await sleep(300);
    }
    const labels = (await ipc('breakdown', { range: 'all' }, 'project')).map((r) => r.label);
    const alpha = labels.find((l) => l.includes('alpha'));
    check(!!alpha, 'project labels include the alpha fixture project', labels);

    // IPC summary against hand-computed values.
    const scenarios = [
      ['7d', null],
      ['all', null],
      ['7d', 'verify1636alpha'],
      ['all', 'verify1636alpha']
    ];
    for (const [range, project] of scenarios) {
      const e = expected(files, now, range, project);
      const s = await ipc('summary', { range, project: project ? alpha : null }, -new Date().getTimezoneOffset());
      const ok = s.calls === e.calls && near(s.spendUsd, e.spend) && s.activeDays === e.activeDays && s.sessions === e.sessions && near(s.monthToDateUsd, e.mtd) && s.monthActiveDays === e.mtdDays;
      check(ok, `summary ${range}${project ? ' + Project' : ''} matches hand computation`, { s, e });
    }
    const mtd7 = (await ipc('summary', { range: '7d' }, -new Date().getTimezoneOffset())).monthToDateUsd;
    const mtdAll = (await ipc('summary', { range: 'all' }, -new Date().getTimezoneOffset())).monthToDateUsd;
    check(near(mtd7, mtdAll), 'month-to-date ignores the date range', { mtd7, mtdAll });

    // Add a scratch repo so the left nav exists, then open Usage.
    const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repoDir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('commit', '--allow-empty', '-q', '-m', 'init');
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return !!b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'readiness green' });
    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.clickByText('Local folder…', { tag: '[role="menuitem"]' });
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add project dialog' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add project', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 30_000, label: 'repository added' });

    const cards = () => cdp.evaluate(`[...document.querySelectorAll('section[aria-label="Usage"] [role="group"]')].map((g) => g.innerText.replace(/\\s+/g, ' '))`);
    const card = (all, label) => all.find((t) => t.startsWith(label)) ?? '';
    const shots = ['1-averages-7d', '2-averages-all', '3-averages-7d-project', '4-averages-all-project'];
    let first = true;
    for (const [i, [range, project]] of scenarios.entries()) {
      await ipc('setPrefs', { filters: { range, project: project ? alpha : null } });
      await cdp.evaluate(`location.reload()`).catch(() => {});
      await cdp.waitFor(`!!(window.refract && window.refract.usage)`, { timeoutMs: 30_000, label: 'reloaded' });
      await cdp.clickByText('Usage');
      await cdp.waitFor(`[...document.querySelectorAll('section[aria-label="Usage"] [role="group"]')].some((g) => g.innerText.startsWith('Projected month spend'))`, { label: 'Averages render' });
      await sleep(600);
      const e = expected(files, now, range, project);
      const all = await cards();
      const name = `${range}${project ? ' + Project' : ''}`;
      const want = (label, value) => check(card(all, label).includes(value), `${name}: ${label} shows ${value}`, card(all, label));
      want('Avg spend per day', e.activeDays ? usd(e.spend / e.activeDays) : '-');
      want('Avg calls per day', e.activeDays ? String(Math.round(e.calls / e.activeDays)) : '-');
      want('Avg spend per call', e.calls ? perCall(e.spend / e.calls) : '-');
      want('Avg spend per Session', e.sessions ? usd(e.spend / e.sessions) : '-');
      want('Projected month spend', e.projected === null ? '-' : usd(e.projected));
      check(card(all, 'Avg spend per day').includes(`Over ${e.activeDays} active day`), `${name}: per-day caption names the active days`);
      await cdp.evaluate(`document.querySelector('section[aria-label="Usage"] [role="group"]').scrollIntoView()`);
      await cdp.screenshot(path.join(SHOTS_DIR, `${shots[i]}.png`));
      first = false;
    }
    check(!first, 'all four scenarios rendered');
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    failures.push('run crashed');
    console.error(`${LOG}: FAIL run crashed`, err);
  } finally {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, failures, results: report }, null, 2));
    } catch (writeErr) {
      console.error(`${LOG}: failed to write evidence: ${writeErr}`);
    }
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    for (const dir of dirs) await safeRmSync(dir, LOG);
  }
  console.log(`${LOG}: ${failures.length ? `FAILED (${failures.length})` : 'all checks passed'}; evidence in ${SHOTS_DIR}`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(`${LOG}: FAILED`, err);
  process.exit(1);
});
