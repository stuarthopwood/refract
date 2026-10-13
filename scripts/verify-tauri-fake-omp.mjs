#!/usr/bin/env node
// Recorded-frame fake `omp`: a drop-in stand-in for the real `omp --mode rpc-ui` child process
// Refract spawns (issue #795 part 2, R12a). Spawned by the Rust build (`omp::process::OmpProcess`)
// exactly like the real binary -- same argv, same stdin/stdout JSONL wire -- but answers from a
// pre-recorded, hand-sanitised script (scripts/fixtures/omp-frames/*.jsonl) instead of a live
// model, so UI flows can be exercised with no model cost and no network.
//
// This file is never invoked directly by a developer: it is the payload a tiny native shim
// (built by scripts/verify-tauri-cdp.mjs, named `omp.exe`, placed first on PATH for the spawned
// dev instance) execs via `node <this file> <args forwarded verbatim>`, inheriting the shim's own
// stdio -- which are the real pipes `OmpProcess::connect` set up, so this script's stdout/stdin
// ARE the wire the Rust backend reads and writes.
//
// Script format: see scripts/fixtures/omp-frames/README.md. In short, a `.jsonl` fixture is a
// strict LINEAR tape: plain lines are frames to emit verbatim (after substituting the
// `$lastId`/`$turnId`/`$lastMessage` sentinels described there); a `{"__wait__": [...types]}`
// line pauses the tape until a command of one of those types arrives on stdin, then resumes;
// `{"__exit__": {"code": n}}` exits the process immediately (simulates OMP crashing/exiting
// unexpectedly).
//
// Scenario selection: `REFRACT_FAKE_OMP_SCENARIO` names a fixture (without `.jsonl`) under
// `scripts/fixtures/omp-frames/`. When unset, `--no-session` on argv selects `readiness` (the
// Rust readiness probe's own scratch, non-Session OmpProcess); otherwise `session` (a real
// Session's lifecycle: attach, fetch history, one streamed chat turn with a tool call, an
// approval, and a queue chip).

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

  if (argv.version) {
    process.stdout.write('omp/18.10.1\n');
    process.exit(0);
  }

  const scenarioName = process.env.REFRACT_FAKE_OMP_SCENARIO || (argv.noSession ? 'readiness' : 'session');
  const tape = loadScenario(scenarioName);

  const vars = { lastId: null, turnId: null, lastMessage: null };
  let cursor = 0;
  // Commands whose type the tape is not currently waiting for are logged and dropped (never
  // silently hung forever): a real `omp` would of course handle any command, but this is a
  // fixed-script replay, not a model.
  let waitingFor = null;

  function emit(frame) {
    process.stdout.write(JSON.stringify(substitute(frame, vars)) + '\n');
  }

  function advance() {
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
      emit(line);
      cursor++;
    }
    waitingFor = null; // tape exhausted
  }

  function handleCommand(cmd) {
    if (!waitingFor || !waitingFor.includes(cmd.type)) {
      process.stderr.write(`verify-tauri-fake-omp: scenario "${scenarioName}" was not waiting for "${cmd.type}" (waiting for ${JSON.stringify(waitingFor)}); dropped\n`);
      return;
    }
    vars.lastId = cmd.id ?? null;
    if (cmd.type === 'prompt') vars.turnId = cmd.id ?? null;
    if (typeof cmd.message === 'string') vars.lastMessage = cmd.message;
    else if (typeof cmd.question === 'string') vars.lastMessage = cmd.question;
    waitingFor = null;
    advance();
  }

  // Frames the tape emits before the first __wait__ (typically just `ready`) go out immediately.
  advance();

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
    handleCommand(cmd);
  });
  rl.on('close', () => process.exit(0));
}

main();
