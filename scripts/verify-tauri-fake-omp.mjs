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
// (simulates OMP crashing/exiting unexpectedly); `{"__stderr__": "text"}` writes `text` to this
// process's own real stderr (not an OMP wire frame) and continues (issue #556: the only way a
// tape can make `build_start_failure`'s stderr tail non-empty for a fixture that deliberately
// never emits `ready` at all). `REFRACT_FAKE_OMP_READY_DELAY_MS` (env var, Session-shaped
// processes only -- same `--no-session` guard as `REFRACT_FAKE_OMP_SCENARIO` below, so the
// readiness probe is never slowed by a delay meant for a Session's own start) pauses this process
// BEFORE its very first frame (normally `ready`) goes out at all, without needing a dedicated
// fixture -- a live check that needs a genuinely slow start (issue #672: real `waiting`/`prompt`/
// `extended` `startProgress.kind` timing, past `READY_PROMPT_AFTER_MS`) sets this once per launch
// instead of adding a new `.jsonl` tape (AGENTS.md: no new fixtures) whose only difference from an
// existing one would be a hand-picked delay number.
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

import { readFileSync, writeFileSync } from 'node:fs';
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

  // Issue #1069: one-shot CLI commands this fake never answered before -- `omp config get/set
  // <key> --json` and `omp models --kind <kind> --json` (`ipc::model_roles`'s own `run_omp`/
  // `run_json_with`, a plain spawn-wait-collect-stdout call with `stdin: null`, never part of
  // the `--mode rpc-ui` wire tape below). `REFRACT_FAKE_OMP_CONFIG_STORE` (a scratch JSON file a
  // live check seeds/reads) backs `config get/set`, read-merge-write across separate process
  // spawns the same way OMP's own global `config.yml` persists; `REFRACT_FAKE_OMP_MODEL_CATALOG`
  // (a path to a fixture JSON, `{ [kind]: ModelCatalogEntry[] }`) backs `models --kind <kind>`,
  // read-only. Neither env var set answers emptily (`value: null` / `[]`) rather than falling
  // through to the tape logic below, which would otherwise misinterpret the call as an RPC
  // session: `stdin: null` on a one-shot call closes this process's readline loop immediately,
  // so the old fallthrough exited 0 having written whatever leading tape frames came before the
  // first `__wait__` -- never valid JSON for the caller to parse.
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
    // Issue #1069 gate round 2 (#1114, N1 regression evidence): `REFRACT_FAKE_OMP_CONFIG_SET_DELAY_MS`
    // (opt-in, unset by default -- every other scenario/script is unaffected) delays only the
    // REPLY to a `set` call, never `get`, so a live check can create a real window where a
    // Select's own model save is still in flight when a radio pick is made against it.
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
    // Issue #1069 gate round 2 (#1114, Medium #6 evidence): `REFRACT_FAKE_OMP_MODEL_CATALOG_FAIL_KIND`
    // (opt-in, unset by default) simulates a real `omp models --kind <kind> --json` failure for
    // ONE named kind -- a non-zero exit with no JSON on stdout, exactly what `run_json_with`
    // (`model_roles.rs`) already treats as an `OmpConfigError`, surfaced to the renderer as
    // `catalogErrors[kind]`.
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
      // `__stderr__`: writes `text` to this process's own real stderr (not an OMP wire frame)
      // and continues -- the one way a tape can make `OmpProcess`'s own `stderr_tail`
      // non-empty, for a fixture whose whole point is a start failure with no `ready` frame
      // ever emitted (issue #556 live check): `build_start_failure`'s stderr tail only has
      // something to show if the child process actually wrote to stderr itself.
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

  // `REFRACT_FAKE_OMP_READY_DELAY_MS`: see the file-header comment above. Applied before the
  // very first `advance()` (not inside the tape itself), so every existing fixture's own frame
  // sequence is untouched -- this only shifts WHEN that sequence starts emitting.
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
  rl.on('close', () => process.exit(0));
}

main();
