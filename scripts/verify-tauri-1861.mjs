#!/usr/bin/env node
// Live CDP check for #1861 (agent Conversation handoff: list, start, switch). The scratch debug exe runs against the
// recorded-frame fake `omp` in serve mode (`conversations-1861` tape), which answers start/switch/refuse any number of
// times and writes real-looking Conversation files. Each scenario drives the Host tools over the real wire: it appends
// a `host_tool_call` frame and reads the recorded `host_tool_result`.
//
// Usage: CARGO_TARGET_DIR=<shared target dir> node scripts/verify-tauri-1861.mjs [--group list-switch|handoff] [--scenario <name>] [--build]
// Groups live in `verify-tauri-1861-<group>.mjs` and are registered in GROUPS below. Evidence lands in
// REFRACT_1861_SCRATCH/evidence (default C:/Users/shopwood/AppData/Local/Temp/scratch/driver-1861/evidence).

import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, computeDirty, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget, sha256OfFile } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';
import { latestSessionIdAndName, waitForSessionStatus } from './verify-tauri-560-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRATCH = process.env.REFRACT_1861_SCRATCH || 'C:/Users/shopwood/AppData/Local/Temp/scratch/driver-1861';
const EVIDENCE_DIR = path.join(SCRATCH, 'evidence');

// A group module default-exports `{ scenarios: [{ name, title, run(ctx, rec) }] }`; add new groups here.
const GROUPS = {
  'list-switch': () => import('./verify-tauri-1861-list-switch.mjs'),
  handoff: () => import('./verify-tauri-1861-handoff.mjs')
};

const argValue = (flag) => {
  const at = process.argv.indexOf(flag);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

const SEED_PREFIX_MS = Date.UTC(2026, 0, 1);
/** The second Project's folder name; it must not contain the first Project's name, which the UI helpers match by substring. */
const OTHER_PROJECT = 'other-project-1861';
/** `2026-01-01T00-00-00-000Z` as omp names files: `:` and `.` become `-`. */
const fileStamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-');

function createContext({ cdp, recordFile, callsFile, refusalsFile, promptRefusalsFile, debugLog, repoDir, runDir, shotsDir }) {
  const records = () => readFileSync(recordFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const knownPids = [];
  const memo = {};
  let n = 0;

  const ctx = {
    cdp,
    code: (r) => r.body?.error?.code,
    sleep,
    evidence(name, value) {
      writeFileSync(path.join(EVIDENCE_DIR, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    },
    async shot(name) {
      await cdp.screenshot(path.join(shotsDir, name));
      copyFileSync(path.join(shotsDir, name), path.join(EVIDENCE_DIR, name));
    },
    /** Appends a `host_tool_call` frame for the omp process `pid` and returns its id. */
    post(toolName, args, pid) {
      const id = `hc-${++n}`;
      appendFileSync(callsFile, `${JSON.stringify({ type: 'host_tool_call', id, toolCallId: `t-${n}`, toolName, arguments: args, __pid: pid })}\n`);
      return id;
    },
    async resultFor(id) {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const hit = records().find((r) => r.frame.type === 'host_tool_result' && r.frame.id === id);
        if (hit) return { isError: hit.frame.isError === true, body: JSON.parse(hit.frame.result.content[0].text) };
        await sleep(150);
      }
      throw new Error(`no host_tool_result for ${id} within 30s`);
    },
    /** One tool call from the omp process `pid`: the call frame, then the result it produced. */
    async call(toolName, args, pid) {
      const id = ctx.post(toolName, args, pid);
      return { id, toolName, args, ...(await ctx.resultFor(id)) };
    },
    async newPid() {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const hit = records().find((r) => r.frame.type === 'set_host_tools' && !knownPids.includes(r.pid));
        if (hit) return (knownPids.push(hit.pid), hit.pid);
        await sleep(200);
      }
      throw new Error('no new omp process registered its host tools within 30s');
    },
    row: (id) => cdp.evaluate(`window.refract.sessions.list().then((r) => (r.ok ? r.value.find((s) => s.id === ${JSON.stringify(id)}) ?? null : null))`),
    /** Conversations as the renderer's own IPC reads them: the ground truth the tool result is compared with. */
    async conversationsIpc(id) {
      const r = await cdp.evaluate(`window.refract.conversations.list(${JSON.stringify(id)})`);
      if (!r.ok) throw new Error(`conversations.list failed: ${JSON.stringify(r)}`);
      return r.value;
    },
    /** The Session's transcript rows as the renderer reads them (`sessions.open`). */
    async transcript(id) {
      const r = await cdp.evaluate(`window.refract.sessions.open(${JSON.stringify(id)}).then((r) => (r.ok ? r.value.runtime.transcript : null))`);
      if (!r) throw new Error(`sessions.open failed for ${id}`);
      return r;
    },
    /** Ends a held turn (a prompt containing HOLD) as completed, as if the agent finished. */
    settleTurn(pid) {
      appendFileSync(callsFile, `${JSON.stringify({ __serve_settle__: true, __pid: pid })}\n`);
    },
    /** The next `n` `new_session` commands fail in the fake omp. */
    setRefusals(n) {
      writeFileSync(refusalsFile, String(n));
    },
    /** The first `prompt` after each of the next `n` successful `new_session` commands fails in the fake omp. */
    setPromptRefusals(n) {
      writeFileSync(promptRefusalsFile, String(n));
    },
    /** The text of the whole window, for what the panes show. */
    pageText: () => cdp.evaluate('document.body.innerText'),
    /** Counts the commands the fake omp received, by type, optionally for one pid. */
    recvCount(type, pid) {
      if (!existsSync(debugLog)) return 0;
      return readFileSync(debugLog, 'utf8').split('\n').filter((l) => l.includes(' RECV ') && l.includes(`"type":"${type}"`) && (pid === undefined || l.includes(`pid=${pid} `))).length;
    },
    /** The `message` of every `prompt` command the fake omp `pid` received, in order. */
    promptTexts(pid) {
      if (!existsSync(debugLog)) return [];
      return readFileSync(debugLog, 'utf8').split('\n')
        .filter((l) => l.startsWith(`pid=${pid} RECV {`) && l.includes('"type":"prompt"'))
        .map((l) => JSON.parse(l.slice(l.indexOf('RECV ') + 5, l.lastIndexOf(' (waitingFor='))).message);
    },
    /** A Session of the named Project (default: the scratch Project) with a first message sent, so its Conversation file is listable and Refract knows its directory. */
    async newSession(label, repoName = path.basename(repoDir)) {
      const before = (await cdp.evaluate(`window.refract.sessions.list().then((r) => r.value.map((s) => s.id))`)) ?? [];
      await createSessionViaQuickCreate(cdp, repoName);
      const found = await latestSessionIdAndName(cdp, repoName, before);
      const pid = await ctx.newPid();
      await waitForSessionStatus(cdp, found.id, 'idle');
      const sent = await cdp.evaluate(`window.refract.chat.send(${JSON.stringify(found.id)}, ${JSON.stringify(`First message of ${label}`)})`);
      if (!sent.ok) throw new Error(`chat.send failed: ${JSON.stringify(sent)}`);
      await cdp.waitFor(`window.refract.sessions.list().then((r) => r.ok && r.value.some((s) => s.id === ${JSON.stringify(found.id)} && s.sessionDir && s.currentConversation))`, { timeoutMs: 30_000, label: `${label} has a Conversation` });
      await waitForSessionStatus(cdp, found.id, 'idle');
      const row = await ctx.row(found.id);
      return { id: found.id, name: found.name, pid, sessionDir: row.sessionDir };
    },
    /** Starts a turn that stays open (a `HOLD` prompt), and waits until Refract shows the Session working. */
    async holdTurn(s) {
      const sent = await cdp.evaluate(`window.refract.chat.send(${JSON.stringify(s.id)}, 'HOLD while I work')`);
      if (!sent.ok) throw new Error(`chat.send failed: ${JSON.stringify(sent)}`);
      await waitForSessionStatus(cdp, s.id, 'working', { timeoutMs: 30_000 });
    },
    /** Writes an older Conversation file `<dir>/<stamp>_<id>.jsonl` with a user message, so Refract lists it (a title-only file is hidden). */
    seedConversation(dir, id, ordinal) {
      const file = path.join(dir, `${fileStamp(SEED_PREFIX_MS + ordinal * 60_000)}_${id}.jsonl`);
      const message = { role: 'user', content: [{ type: 'text', text: `Seeded Conversation ${ordinal}` }], timestamp: 0 };
      writeFileSync(file, `${JSON.stringify({ type: 'title', title: `Seed ${ordinal}` })}\n${JSON.stringify({ type: 'message', message })}\n`);
    },
    /** Session A with 25 Conversations in total: its own plus 24 seeded older ones named `seed-01`..`seed-24`. */
    async sessionA() {
      if (memo.a) return memo.a;
      const a = await ctx.newSession('A');
      for (let i = 1; i <= 24; i++) ctx.seedConversation(a.sessionDir, `seed-${String(i).padStart(2, '0')}`, i);
      return (memo.a = a);
    },
    /** A Session of a second Project, added to Refract on first use. */
    async otherProjectSession() {
      if (memo.other) return memo.other;
      const dir = makeScratchRepo(path.join(runDir, 'repo-other', OTHER_PROJECT), OTHER_PROJECT);
      await addRepository(cdp, dir);
      return (memo.other = await ctx.newSession('other Project', OTHER_PROJECT));
    },
    /** A second Session in the same Project, with a Conversation of its own. */
    async sessionB() {
      if (memo.b) return memo.b;
      const b = await ctx.newSession('B');
      const [first] = await ctx.conversationsIpc(b.id);
      return (memo.b = { ...b, conversationId: first.id });
    }
  };
  return ctx;
}

async function main() {
  const groupName = argValue('--group') || 'list-switch';
  const only = argValue('--scenario');
  if (!GROUPS[groupName]) throw new Error(`unknown --group "${groupName}"; known: ${Object.keys(GROUPS).join(', ')}`);
  const { default: group } = await GROUPS[groupName]();
  const selected = group.scenarios.filter((s) => !only || s.name === only);
  if (!selected.length) throw new Error(`no scenario "${only}" in group ${groupName}; known: ${group.scenarios.map((s) => s.name).join(', ')}`);

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  mkdirSync(SCRATCH, { recursive: true });
  const runDir = mkdtempSync(path.join(SCRATCH, 'run-'));
  let child, cdp, exeDir;
  const results = [];
  const gitHeadSha = gitHead(REPO_ROOT);
  const dirty = computeDirty(REPO_ROOT);
  let exeHash = null;
  try {
    const buildDir = requireSharedCargoTarget(REPO_ROOT);
    const mk = (name) => {
      const dir = path.join(runDir, name);
      mkdirSync(dir, { recursive: true });
      return dir;
    };
    const shimDir = mk('shim');
    const dataDir = mk('data');
    const importSourceDir = mk('import');
    const serveRoot = mk('serve');
    const repoDir = makeScratchRepo(path.join(mk('repo'), 'verify-1861'), 'verify-1861');
    exeDir = mk('exe');
    const launcherDir = mk('launcher');
    const recordFile = path.join(exeDir, 'host-tools.jsonl');
    const callsFile = path.join(exeDir, 'host-calls.jsonl');
    const refusalsFile = path.join(exeDir, 'new-session-refusals.txt');
    const promptRefusalsFile = path.join(exeDir, 'prompt-after-new-refusals.txt');
    const debugLog = path.join(exeDir, 'fake-omp-invocations.log');
    writeFileSync(refusalsFile, '0');
    writeFileSync(promptRefusalsFile, '0');
    writeFileSync(recordFile, '');
    writeFileSync(callsFile, '');
    const port = await getFreePort();
    console.log(`verify-1861: group ${groupName}, git HEAD ${gitHeadSha} dirty=${dirty}; evidence ${EVIDENCE_DIR}; CDP port ${port}`);

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    // The default reuses the freshly built shared exe; `--build` rebuilds, for a tree whose src-tauri changed.
    let exePath;
    if (process.argv.includes('--build')) {
      exePath = buildAndCopyExeFresh(exeDir, buildDir, REPO_ROOT, { label: 'verify-1861' }).dest;
    } else {
      exePath = path.join(exeDir, 'refract-tauri.exe');
      copyFileSync(path.join(buildDir, 'refract-tauri.exe'), exePath);
    }
    exeHash = sha256OfFile(exePath);
    const launched = await launchBuiltExeWithEnv(launcherExe, exePath, {
      port,
      dataDir,
      importSourceDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'conversations-1861',
        REFRACT_FAKE_OMP_SERVE_ROOT: serveRoot,
        REFRACT_FAKE_OMP_DEBUG_LOG: debugLog,
        REFRACT_FAKE_OMP_HOST_TOOL_RECORD: recordFile,
        REFRACT_FAKE_OMP_HOST_TOOL_CALLS: callsFile,
        REFRACT_FAKE_OMP_NEW_SESSION_REFUSALS: refusalsFile,
        REFRACT_FAKE_OMP_PROMPT_AFTER_NEW_REFUSALS: promptRefusalsFile
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error(`CDP target on port ${port} is not owned by pid ${launched.targetPid}`);
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness mounted' });
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
    await addRepository(cdp, repoDir);

    const ctx = createContext({ cdp, recordFile, callsFile, refusalsFile, promptRefusalsFile, debugLog, repoDir, runDir, shotsDir: exeDir });
    for (const scenario of selected) {
      const rec = { findings: [], failures: [], check(ok, pass, fail) { (ok ? rec.findings : rec.failures).push(ok ? pass : fail); } };
      try {
        await scenario.run(ctx, rec);
      } catch (err) {
        rec.failures.push(`threw: ${err?.stack ?? err}`);
        await ctx.shot(`zz-${scenario.name}-error.png`).catch(() => {});
      }
      const verdict = rec.failures.length || !rec.findings.length ? 'FAIL' : 'PASS';
      results.push({ name: scenario.name, title: scenario.title, verdict, findings: rec.findings, failures: rec.failures });
      console.log(`\n[${verdict}] ${scenario.name}: ${scenario.title}`);
      for (const f of rec.failures) console.log(`  FAIL ${f}`);
      for (const f of rec.findings) console.log(`  ok   ${f}`);
    }
    const failed = results.some((r) => r.verdict !== 'PASS');
    writeFileSync(path.join(EVIDENCE_DIR, `report-${groupName}.json`), JSON.stringify({ gitHead: gitHeadSha, dirty, exeSha256: exeHash, group: groupName, results }, null, 2));
    console.log(`\nverify-1861: ${failed ? 'FAILED' : 'DONE'}. Evidence: ${EVIDENCE_DIR}`);
    process.exitCode = failed ? 1 : 0;
  } catch (err) {
    console.error('verify-1861: FAILED:', err?.stack ?? err);
    try {
      writeFileSync(path.join(EVIDENCE_DIR, `report-${groupName}.json`), JSON.stringify({ gitHead: gitHeadSha, dirty, exeSha256: exeHash, group: groupName, results, error: String(err?.stack ?? err) }, null, 2));
      if (cdp) await cdp.screenshot(path.join(EVIDENCE_DIR, 'zz-error.png')).catch(() => {});
    } catch {}
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    try {
      for (const name of ['app.log', 'fake-omp-invocations.log', 'host-tools.jsonl', 'host-calls.jsonl']) if (exeDir && existsSync(path.join(exeDir, name))) copyFileSync(path.join(exeDir, name), path.join(EVIDENCE_DIR, name));
    } catch {}
    await safeRmSync(runDir);
  }
}

main();
