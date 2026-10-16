#!/usr/bin/env node
// Recorded-frame fake `omp`: a drop-in stand-in for the real `omp --mode rpc-ui` child process
// Refract spawns (issue #795 part 2, R12a). Spawned by the Rust build (`omp::process::OmpProcess`)
// exactly like the real binary -- same argv, same stdin/stdout JSONL wire -- but answers from a
// pre-recorded, hand-sanitised script (scripts/fixtures/omp-frames/*.jsonl) instead of a live
// model, so UI flows can be exercised with no model cost and no network.
//
// This file is never invoked directly by a developer: it is the payload a tiny native shim
// (built by scripts/verify-tauri.mjs's own `buildOmpShim`, named `omp.exe`, placed first on PATH
// for the spawned instance) execs via `node <this file> <args forwarded verbatim>`, inheriting
// the shim's own stdio -- which are the real pipes `OmpProcess::connect` set up, so this
// script's stdout/stdin ARE the wire the Rust backend reads and writes.
//
// Script format: see scripts/fixtures/omp-frames/README.md. In short, a `.jsonl` fixture is a
// strict LINEAR tape: plain lines are frames to emit verbatim (after substituting the
// `$lastId`/`$turnId`/`$lastMessage`/`$conversationFile` sentinels described there); a
// `{"__wait__": [...types]}`
// line pauses the tape until a command of one of those types arrives on stdin, then resumes;
// `{"__delay__": ms}` pauses the tape for `ms` milliseconds before continuing (used to make a
// streamed reply's own incremental `message_update` deltas land as genuinely separate renders,
// not one instantaneous final paint); `{"__exit__": {"code": n}}` exits the process immediately
// (simulates OMP crashing/exiting unexpectedly).
//
// Scenario selection: `--no-session` on argv ALWAYS selects `readiness` (the Rust readiness
// probe's own scratch, non-Session OmpProcess) -- a real app launches that probe and a real
// Session's own `OmpProcess` as two separate child processes sharing this script's whole
// environment, so a per-launch `REFRACT_FAKE_OMP_SCENARIO` override meant for the Session must
// never also redirect the unrelated readiness probe onto a tape it was never scripted against
// (issue #856 live-check gate-fix: this used to let the env var win regardless of `--no-session`,
// hanging the readiness probe on a `session`-shaped tape's own command expectations). Without
// `--no-session`, `REFRACT_FAKE_OMP_SCENARIO` names a fixture (without `.jsonl`) under
// `scripts/fixtures/omp-frames/` for the Session's own `OmpProcess`; unset, that defaults to
// `session` (a real Session's lifecycle: attach, fetch history, one streamed chat turn with a
// tool call and an approval). `scripts/verify-tauri.mjs` itself never sets this env var, so only
// `readiness` and plain `session` are ever driven by `pnpm verify:tauri`; `side-chat`/
// `subagents`/`failure`/`exit` are fixtures for a future lane to drive directly once it ports
// the matching channel.

import { readFileSync } from 'node:fs';
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

/** Replaces the id/message sentinels anywhere they appear as a bare string value (never inside a
 * larger string), recursively, so a fixture's `response`/`prompt_result`/echoed-user-message
 * frames can reference whichever real command this fake process was actually sent. */
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

  const scenarioName = argv.noSession ? 'readiness' : (process.env.REFRACT_FAKE_OMP_SCENARIO || 'session');
  const tape = loadScenario(scenarioName);
  debugLog(`pid=${process.pid} scenario=${scenarioName} tapeLength=${tape.length}`);

  // `conversationFile` and the four `hist*At` fields are all seeded once from env vars below
  // (never updated by a wait, unlike the first three sentinels): real values the caller computes
  // and passes in, needed only by a fixture exercising a real reattach/reopen round trip (issue
  // #555's own live check). `conversationFile` is a literal absolute path the caller pre-creates
  // on disk, so a scripted `get_state`/`switch_session` can report a `sessionFile` that
  // `assert_conversation_file_exists` (launch_support.rs) genuinely finds. The four `hist*At`
  // epoch-ms numbers (parsed from their own env vars, `null` when unset or non-numeric) let a
  // canned `get_messages_page` history response embed timestamps computed AT RUN TIME relative
  // to the real "now" -- the day-aware format rule (`UserMessageRow.tsx`'s `formatMessageTime`)
  // genuinely depends on which calendar day/year the run happens on, which a hardcoded fixture
  // value could never express correctly on every future run.
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
  // Commands whose type the tape is not currently waiting for are logged and dropped (never
  // silently hung forever): a real `omp` would of course handle any command, but this is a
  // fixed-script replay, not a model.
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
      emit(line);
      cursor++;
    }
    waitingFor = null; // tape exhausted
  }

  async function handleCommand(cmd) {
    debugLog(`pid=${process.pid} RECV ${JSON.stringify(cmd)} (waitingFor=${JSON.stringify(waitingFor)})`);
    // Issue #572's `set_ask_dialog{enabled:true}` probe (`launch_support.rs`'s
    // `send_set_ask_dialog`) is sent once per process right after launch. Most fixtures predate
    // that probe and never list it in a `__wait__` entry, so it used to be silently dropped here
    // and Refract blocked for its own full 60s request timeout waiting for a reply that never
    // came, stalling every later tape step (including the ones the tape WAS waiting for) behind
    // that timeout. A11y spot check (gate round 3): five tapes (session.jsonl, ask.jsonl,
    // session-settle-before-start.jsonl, session-two-turns-answered.jsonl, session-two-turns-
    // withheld.jsonl) DO script their own `set_ask_dialog` `__wait__`/response pair -- answering
    // it out-of-band here too meant THEIR OWN scripted reply never got sent (this handler
    // returned first), so their cursor never advanced and `get_messages_page` was dropped the
    // same way. Fixed: only intercept when the tape is NOT currently waiting for it; a tape that
    // IS waiting for it keeps answering it itself, exactly as before.
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
  rl.on('close', () => process.exit(0));
}

main();
