// Fixtures and fake CLIs for scripts/verify-tauri-1331.mjs (Usage view, slice 1): a synthetic OMP
// sessions folder with known sums, and a fake `omp` / `gh` pair whose every call is logged.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CWD = 'C:\\Work\\verify1331proj';

export function entry(value) {
  return `${JSON.stringify(value)}\n`;
}

export function assistantLine(id, usage, cost, toolCallId) {
  const content = [{ type: 'text', text: 'ok' }];
  if (toolCallId) content.push({ type: 'toolCall', id: toolCallId, name: 'bash', arguments: {} });
  return entry({
    type: 'message',
    id,
    timestamp: '2026-10-01T10:00:03.000Z',
    message: {
      role: 'assistant',
      content,
      timestamp: Date.parse('2026-10-01T10:00:03.000Z'),
      model: 'claude-sonnet',
      provider: 'github-copilot',
      usage: {
        input: usage[0],
        output: usage[1],
        cacheRead: usage[2],
        cacheWrite: 0,
        totalTokens: usage[0] + usage[1] + usage[2],
        cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost }
      }
    }
  });
}

export function toolResult(id, callId, isError) {
  return entry({
    type: 'message',
    id,
    timestamp: '2026-10-01T10:00:04.000Z',
    message: { role: 'toolResult', toolCallId: callId, isError, content: [{ type: 'text', text: 'out' }] }
  });
}

/** Known sums before the cut line completes: 3 calls, 355 tokens, USD 0.09, 2 tool calls. */
export const EXPECT_BEFORE = { calls: 3, totalTokens: 355, spendUsd: 0.09, toolCalls: 2 };
/** The cut line completes as one call of 5 tokens at USD 0.01. */
export const CUT_LINE_USAGE = [4, 1, 0];
export const CUT_LINE_COST = 0.01;
export const EXPECT_AFTER_CUT = { calls: 4, totalTokens: 360, spendUsd: 0.1, toolCalls: 2 };
/** One further appended call of 6 tokens at USD 0.02. */
export const APPENDED_USAGE = [3, 3, 0];
export const APPENDED_COST = 0.02;
export const EXPECT_AFTER_APPEND = { calls: 5, totalTokens: 366, spendUsd: 0.12, toolCalls: 2 };

/** Writes the fixture and returns the main file path. The last line is cut mid-JSON. */
export function writeSessionsFixture(sessionsDir) {
  const folder = path.join(sessionsDir, '--C--Work-verify1331proj--');
  mkdirSync(path.join(folder, 'main'), { recursive: true });
  const header =
    entry({ type: 'session', id: 's1', timestamp: '2026-10-01T10:00:00.000Z', cwd: CWD }) +
    entry({ type: 'model_change', id: 'm1', timestamp: '2026-10-01T10:00:01.000Z', model: 'github-copilot/claude-sonnet' }) +
    entry({ type: 'thinking_level_change', id: 't1', timestamp: '2026-10-01T10:00:02.000Z', thinkingLevel: 'high' });
  const shout = entry({
    type: 'message',
    id: 'u1',
    timestamp: '2026-10-01T10:00:05.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'WHY IS THIS STILL BROKEN!!!' }] }
  });
  const cut = assistantLine('a3', CUT_LINE_USAGE, CUT_LINE_COST).trimEnd();
  const mainFile = path.join(folder, '--C--Work-verify1331proj--_s1.jsonl');
  writeFileSync(
    mainFile,
    header +
      assistantLine('a1', [10, 5, 100], 0.03, 'tc1') +
      toolResult('r1', 'tc1', false) +
      assistantLine('a2', [20, 10, 200], 0.05, 'tc2') +
      toolResult('r2', 'tc2', true) +
      shout +
      cut.slice(0, Math.floor(cut.length / 2))
  );
  const subHeader = entry({ type: 'session', id: 's2', timestamp: '2026-10-01T10:00:06.000Z', cwd: CWD });
  writeFileSync(path.join(folder, 'main', '0-Sub.jsonl'), subHeader + assistantLine('b1', [7, 3, 0], 0.01));
  return mainFile;
}

/** The text that completes the cut line, given the file's current content. */
export function cutLineRemainder() {
  const cut = assistantLine('a3', CUT_LINE_USAGE, CUT_LINE_COST);
  return cut.slice(Math.floor(cut.trimEnd().length / 2));
}

const OMP_LOGIC = (logPath) => `
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const a = process.argv.slice(2);
if (a[0] === 'usage' && a.includes('--json')) {
  const reset = Date.now() + 10 * 86400000;
  process.stdout.write(JSON.stringify({ reports: [
    { provider: 'github-copilot', metadata: { quotaResetDate: new Date(reset).toISOString() }, limits: [
      { label: 'Premium requests', window: { resetsAt: reset }, amount: { used: 500000, limit: 2000000, unit: 'credits' } } ] },
    { provider: 'openai-codex', limits: [
      { label: 'Weekly', window: { resetsAt: reset }, amount: { used: 12, limit: 100, unit: 'percent' } } ] } ] }));
  process.exit(0);
}
if (a.includes('--version')) { process.stdout.write('omp/18.10.1\\n'); process.exit(0); }
// Everything else (readiness RPC, sessions) is the shared recorded-frame fake omp.
const r = require('node:child_process').spawnSync('node', [${JSON.stringify(path.join(__dirname, 'verify-tauri-fake-omp.mjs'))}, ...a], { stdio: 'inherit' });
process.exit(r.status ?? 1);
`;

const GH_LOGIC = (logPath) => `
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(a) + '\\n');
if (a[0] === 'auth' && a[1] === 'status') {
  process.stdout.write(JSON.stringify({ hosts: { 'github.com': [{ host: 'github.com', login: 'octocat', active: true, state: 'success' }] } }));
  process.exit(0);
}
if (a[0] === 'auth' && a[1] === 'token') { process.stdout.write('fake-token-1331\\n'); process.exit(0); }
process.stderr.write('fake gh 1331: unsupported ' + JSON.stringify(a) + '\\n');
process.exit(1);
`;

/** Builds `omp.exe` and `gh.exe` into shimDir, each logging argv to its own call log. */
export function buildFakeClis(shimDir) {
  mkdirSync(shimDir, { recursive: true });
  const logs = { omp: path.join(shimDir, 'omp-calls.log'), gh: path.join(shimDir, 'gh-calls.log') };
  writeFileSync(logs.omp, '');
  writeFileSync(logs.gh, '');
  writeFileSync(path.join(shimDir, 'omp-logic.cjs'), OMP_LOGIC(logs.omp));
  writeFileSync(path.join(shimDir, 'gh-logic.cjs'), GH_LOGIC(logs.gh));
  for (const name of ['omp', 'gh']) {
    const r = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-1331-shim.rs'), '-o', path.join(shimDir, `${name}.exe`)], {
      encoding: 'utf8',
      windowsHide: true
    });
    if (r.status !== 0) throw new Error(`rustc failed for ${name}.exe: ${r.stderr}`);
  }
  return logs;
}
