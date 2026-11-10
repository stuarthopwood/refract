#!/usr/bin/env node
// Recorded-frame fake `omp`: stands in for `omp --mode rpc-ui` (same argv, stdin/stdout JSONL) and replays a
// hand-sanitised tape (scripts/fixtures/omp-frames/*.jsonl), so UI flows run with no model cost. It is the
// payload of the `omp.exe` shim (verify-tauri.mjs `buildOmpShim`). Tape format: omp-frames/README.md.
// `REFRACT_FAKE_OMP_READY_DELAY_MS` delays the first frame (Session-shaped processes only) for slow-start checks.
// `--no-session` always selects `readiness`, so a per-launch SCENARIO can't redirect the probe onto a tape it wasn't scripted for.
// Otherwise `REFRACT_FAKE_OMP_SCENARIO` names a fixture under omp-frames/, defaulting to `session`.

// Host tools (#1193): `REFRACT_FAKE_OMP_HOST_TOOL_RECORD` (scratch file) turns on `set_host_tools` acking and appends
// every `set_host_tools`/`host_tool_result` frame as `{pid,frame}` JSONL. `REFRACT_FAKE_OMP_HOST_TOOL_CALLS` (scratch
// file of `host_tool_call` frames, one per line; an optional `__pid` limits a line to that fake process) is polled and each line appended after launch is emitted; the count
// at launch seeds `seen`, so a later Session never replays earlier calls.

import { readFileSync, writeFileSync, appendFileSync as appendFileSyncTop, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'omp-frames');

function parseArgv(argv) {
  const out = { version: false, noSession: argv.includes('--no-session'), mode: null, approvalMode: null };
  for (const a of argv) {
    if (a === '--version') out.version = true;
    else if (a === '--mode') out.mode = argv[argv.indexOf(a) + 1];
    else if (a.startsWith('--approval-mode=')) out.approvalMode = a.slice('--approval-mode='.length);
  }
  return out;
}

function loadScenario(name) {
  const file = path.join(FIXTURES_DIR, `${name}.jsonl`);
  const text = readFileSync(file, 'utf8');
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//'))
    .map((l) => JSON.parse(l));
}

/** Replaces id/message sentinels that appear as a whole string value (never inside a larger string), recursively. */
function substitute(value, vars) {
  if (typeof value === 'string') {
    if (value === '$lastId') return vars.lastId;
    if (value === '$turnId') return vars.turnId;
    if (value === '$lastMessage') return vars.lastMessage;
    if (value === '$conversationFile') return vars.conversationFile;
    if (value === '$histTodayAt') return vars.histTodayAt;
    if (value === '$histYesterdayAt') return vars.histYesterdayAt;
    if (value === '$histThisYearAt') return vars.histThisYearAt;
    if (value === '$histPastYearAt') return vars.histPastYearAt;
    // `$env:NAME` (whole value only, REFRACT_FAKE_OMP_* names): run-time payloads too large to hand-write, e.g. image base64.
    const envMatch = /^\$env:(REFRACT_FAKE_OMP_[A-Z0-9_]+)$/.exec(value);
    if (envMatch) {
      const envValue = process.env[envMatch[1]];
      if (!envValue) process.stderr.write(`fake-omp: warning: ${envMatch[1]} is unset or empty; substituting ''\n`);
      return envValue ?? '';
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, vars);
    return out;
  }
  return value;
}

async function main() {
  const argv = parseArgv(process.argv.slice(2));

  const debugLogPath = process.env.REFRACT_FAKE_OMP_DEBUG_LOG;
  const { appendFileSync } = debugLogPath ? await import('node:fs') : { appendFileSync: null };
  const debugLog = (line) => {
    if (debugLogPath) appendFileSync(debugLogPath, line + '\n');
  };
  debugLog(`pid=${process.pid} argv=${JSON.stringify(process.argv.slice(2))} cwd=${process.cwd()}`);

  if (argv.version) {
    process.stdout.write('omp/18.10.1\n');
    process.exit(0);
  }

  // One-shot CLI calls (`omp config get/set`, `omp models --kind`; #1069) run with `stdin: null`, not the
  // rpc-ui wire. `REFRACT_FAKE_OMP_CONFIG_STORE` (scratch JSON) backs config get/set across spawns;
  // `REFRACT_FAKE_OMP_MODEL_CATALOG` backs `models`. With neither set they answer emptily: falling through
  // to the tape would exit 0 on leading frames, never valid JSON for the caller.
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === 'config' && (rawArgs[1] === 'get' || rawArgs[1] === 'set')) {
    const key = rawArgs[2];
    const storePath = process.env.REFRACT_FAKE_OMP_CONFIG_STORE;
    const readStore = () => {
      if (!storePath) return {};
      try {
        return JSON.parse(readFileSync(storePath, 'utf8'));
      } catch {
        return {};
      }
    };
    if (rawArgs[1] === 'get') {
      const store = readStore();
      const value = Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
      process.stdout.write(`${JSON.stringify({ key, value, type: 'object' })}\n`);
      process.exit(0);
    }
    // `config set <key> --json -- <value>`: the value is the argv entry right after the `--`.
    // Opt-in `REFRACT_FAKE_OMP_CONFIG_SET_DELAY_MS` delays only the reply to `set`, so a check can hold a
    // model save in flight while a radio pick is made (#1114).
    const sepIndex = rawArgs.indexOf('--');
    const valueArg = sepIndex >= 0 ? rawArgs[sepIndex + 1] : undefined;
    const value = valueArg !== undefined ? JSON.parse(valueArg) : null;
    const store = readStore();
    store[key] = value;
    if (storePath) writeFileSync(storePath, JSON.stringify(store));
    const delayMs = Number(process.env.REFRACT_FAKE_OMP_CONFIG_SET_DELAY_MS || 0);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    process.stdout.write(`${JSON.stringify({ key, value })}\n`);
    process.exit(0);
  }
  if (rawArgs[0] === 'models' && rawArgs[1] === '--kind') {
    const kind = rawArgs[2];
    // Opt-in `REFRACT_FAKE_OMP_MODEL_CATALOG_FAIL_KIND` simulates a failing `omp models --kind` for one kind
    // (non-zero exit, no JSON), which `run_json_with` surfaces as `catalogErrors[kind]` (#1114).
    if (process.env.REFRACT_FAKE_OMP_MODEL_CATALOG_FAIL_KIND === kind) {
      process.stderr.write(`verify-tauri-fake-omp: simulated catalog failure for kind "${kind}"\n`);
      process.exit(1);
    }
    const catalogPath = process.env.REFRACT_FAKE_OMP_MODEL_CATALOG;
    let catalogByKind = {};
    if (catalogPath) {
      try {
        catalogByKind = JSON.parse(readFileSync(catalogPath, 'utf8'));
      } catch {
        catalogByKind = {};
      }
    }
    process.stdout.write(`${JSON.stringify(catalogByKind[kind] ?? [])}\n`);
    process.exit(0);
  }

  const scenarioName = argv.noSession ? 'readiness' : (process.env.REFRACT_FAKE_OMP_SCENARIO || 'session');
  const tape = loadScenario(scenarioName);
  debugLog(`pid=${process.pid} scenario=${scenarioName} tapeLength=${tape.length}`);

  // `conversationFile` and the four `hist*At` fields are seeded once from env vars (#555 reattach/reopen).
  // `conversationFile` is a pre-created absolute path so `assert_conversation_file_exists` finds it; the
  // `hist*At` epoch-ms values are computed at run time because the day-aware `formatMessageTime` depends
  // on the real calendar day, which a hardcoded fixture value can't express.
  const parseEnvMs = (name) => {
    const raw = process.env[name];
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const vars = {
    lastId: null,
    turnId: null,
    lastMessage: null,
    conversationFile: process.env.REFRACT_FAKE_OMP_CONVERSATION_FILE || null,
    histTodayAt: parseEnvMs('REFRACT_FAKE_OMP_HIST_TODAY_AT'),
    histYesterdayAt: parseEnvMs('REFRACT_FAKE_OMP_HIST_YESTERDAY_AT'),
    histThisYearAt: parseEnvMs('REFRACT_FAKE_OMP_HIST_THIS_YEAR_AT'),
    histPastYearAt: parseEnvMs('REFRACT_FAKE_OMP_HIST_PAST_YEAR_AT'),
  };
  let cursor = 0;
  // Commands the tape isn't waiting for are logged and dropped, never hung on: this is a fixed-script replay, not a model.
  let waitingFor = null;

  function emit(frame) {
    const line = JSON.stringify(substitute(frame, vars));
    debugLog(`pid=${process.pid} EMIT ${line}`);
    process.stdout.write(line + '\n');
  }

  async function advance() {
    while (cursor < tape.length) {
      const line = tape[cursor];
      if (line && typeof line === 'object' && Array.isArray(line.__wait__)) {
        waitingFor = line.__wait__;
        cursor++;
        return; // pause here until a matching command arrives
      }
      if (line && typeof line === 'object' && line.__exit__) {
        process.exitCode = line.__exit__.code ?? 0;
        process.stdin.pause();
        process.exit(process.exitCode);
      }
      if (line && typeof line === 'object' && typeof line.__delay__ === 'number') {
        cursor++;
        await new Promise((resolve) => setTimeout(resolve, line.__delay__));
        continue;
      }
      // `__stderr__`: writes to this process's real stderr (not a wire frame), the only way a tape can
      // fill `OmpProcess`'s `stderr_tail` for a start-failure fixture that never emits `ready` (#556).
      if (line && typeof line === 'object' && typeof line.__stderr__ === 'string') {
        cursor++;
        process.stderr.write(line.__stderr__ + '\n');
        continue;
      }
      emit(line);
      cursor++;
    }
    waitingFor = null; // tape exhausted
  }

  async function handleCommand(cmd) {
    debugLog(`pid=${process.pid} RECV ${JSON.stringify(cmd)} (waitingFor=${JSON.stringify(waitingFor)})`);
    if (hostToolRecord && (cmd.type === 'set_host_tools' || cmd.type === 'host_tool_result')) {
      appendFileSyncTop(hostToolRecord, `${JSON.stringify({ pid: process.pid, frame: cmd })}\n`);
      if (cmd.type === 'set_host_tools') emit({ id: cmd.id, type: 'response', command: 'set_host_tools', success: true });
      return;
    }
    // The `set_ask_dialog{enabled:true}` probe (#572) is sent once per process, but most tapes never list it
    // in a `__wait__`; unanswered, Refract blocks for its 60s request timeout and stalls later steps. Only
    // intercept when the tape isn't waiting for it, or tapes that script their own reply would never advance.
    if (cmd.type === 'set_ask_dialog' && !waitingFor?.includes('set_ask_dialog')) {
      emit({ id: cmd.id, type: 'response', command: 'set_ask_dialog', success: true, data: { enabled: true } });
      return;
    }
    if (!waitingFor || !waitingFor.includes(cmd.type)) {
      process.stderr.write(`verify-tauri-fake-omp: scenario "${scenarioName}" was not waiting for "${cmd.type}" (waiting for ${JSON.stringify(waitingFor)}); dropped\n`);
      return;
    }
    vars.lastId = cmd.id ?? null;
    if (cmd.type === 'prompt') vars.turnId = cmd.id ?? null;
    if (typeof cmd.message === 'string') vars.lastMessage = cmd.message;
    else if (typeof cmd.question === 'string') vars.lastMessage = cmd.question;
    waitingFor = null;
    await advance();
  }

  // `REFRACT_FAKE_OMP_READY_DELAY_MS`: applied before the first `advance()` so fixture frame sequences are untouched, only shifted in time.
  const readyDelayMs = argv.noSession ? null : parseEnvMs('REFRACT_FAKE_OMP_READY_DELAY_MS');
  if (readyDelayMs && readyDelayMs > 0) {
    debugLog(`pid=${process.pid} ready-delay ${readyDelayMs}ms before the first frame`);
    await new Promise((resolve) => setTimeout(resolve, readyDelayMs));
  }
  // Frames the tape emits before the first __wait__ (typically just `ready`) go out immediately.
  await advance();

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let cmd;
    try {
      cmd = JSON.parse(trimmed);
    } catch (err) {
      process.stderr.write(`verify-tauri-fake-omp: unparsable stdin line, ignored: ${err.message}\n`);
      return;
    }
    void handleCommand(cmd);
  });
  const hostToolRecord = process.env.REFRACT_FAKE_OMP_HOST_TOOL_RECORD;
  const hostToolCalls = process.env.REFRACT_FAKE_OMP_HOST_TOOL_CALLS;
  const callLines = () => (hostToolCalls && existsSync(hostToolCalls) ? readFileSync(hostToolCalls, 'utf8').split('\n').filter((l) => l.trim()) : []);
  if (hostToolCalls && !argv.noSession) {
    let seen = callLines().length;
    setInterval(() => {
      const lines = callLines();
      for (; seen < lines.length; seen++) {
        const { __pid: target, ...frame } = JSON.parse(lines[seen]);
        if (target === undefined || target === process.pid) emit(frame);
      }
    }, 100);
  }
  rl.on('close', () => process.exit(0));
}

main();
