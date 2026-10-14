// Golden contract-replay test (issue #795 part 3, R12b stretch): the TS-side counterpart to
// `src-tauri/tests/contract_replay.rs`, replaying the SAME `session` scenario tape
// (`scripts/fixtures/omp-frames/session.jsonl`) through the real Electron-build IPC handlers
// (`ipc/repositories.ts`/`ipc/sessions.ts`/`ipc/chat.ts`'s own `register*` functions) and a real
// `SessionManager`/`SessionAgent`/`OmpProcess`, with no Electron app/BrowserWindow launched at
// all: `electron` is mocked down to the one export these handler files actually call at runtime
// (`ipcMain.handle`, used here only to CAPTURE each handler function into a plain map -- the
// handlers are then invoked directly, exactly like a real `ipcMain.invoke` round trip would).
//
// Unlike the Rust build, `OmpProcessOptions`/`SessionManager`'s constructor already expose a
// public `ompPath` override seam (ported straight through from `OmpProcess` to `SessionAgent` to
// `SessionManager`) -- so this spawns the fake-omp shim directly via that seam, no PATH-prepending
// native shim needed. `SessionManager.onEvent` is also a plain, Electron-independent
// `EventEmitter`-style subscription (`forwardEvent`'s window-send step is a SEPARATE, later step
// this test never calls), so this captures genuine `ManagerEvent`s (the real
// `TranscriptOp`/status/request event payloads), not reconstructed snapshots the way the Rust
// test has to (no live-window workaround needed on this side at all).
//
// See scripts/fixtures/contract-replay/README.md for the normalization rules (shared in spirit
// with the Rust trace; the two are not byte-identical -- see this file's own differences note at
// the bottom).

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, vi } from 'vitest';
import type { Result } from '../../shared/ipc';
import { IPC_REQUESTS } from '../../shared/ipc';
import type { Repository, Session, PendingRequest } from '../../shared/model';
import type { ManagerEvent } from '../SessionManager';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

type Handler = (...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();

// `vi.mock` factory calls are hoisted above every import in this file by vitest's own transform
// (the standard convention), so the static imports below -- including `./repositories`/
// `./sessions`/`./chat`, which import `electron` themselves at module load time -- see this mock
// already installed.
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    },
  },
  shell: { openPath: vi.fn() },
}));

import { registerRepositories } from './repositories';
import { registerSessions } from './sessions';
import { registerChat } from './chat';
import { SessionManager } from '../SessionManager';
import { RegistryStore } from '../store/registry';
import { SettingsStore } from '../store/settings';

const PROMPT_MESSAGE = "Create note.txt with the text 'hi', then tell me the token xyzzy9.";

function runGit(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/** Mirrors `src-tauri/tests/contract_replay.rs`'s own `make_scratch_repo`: one commit on `main`. */
function makeScratchRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'refract-ts-contract-replay-repo-'));
  runGit(dir, ['init', '--initial-branch=main', '-q']);
  runGit(dir, ['config', 'user.email', 'contract-replay@example.invalid']);
  runGit(dir, ['config', 'user.name', 'contract-replay']);
  writeFileSync(path.join(dir, 'README.md'), 'seed\n');
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-q', '-m', 'seed']);
  return dir;
}

/** Compiles `scripts/verify-tauri-omp-shim.rs` the same bare, non-Cargo way the Rust test's own
 * `build_omp_shim` does -- reused verbatim here too, since `OmpProcessOptions.ompPath` (unlike
 * the Rust build) can point straight at it, with no PATH-prepending needed. */
function buildOmpShim(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const src = path.join(REPO_ROOT, 'scripts', 'verify-tauri-omp-shim.rs');
  if (!existsSync(src)) throw new Error(`contract_replay: expected shim source at ${src}`);
  const out = path.join(dir, 'omp.exe');
  execFileSync('rustc', ['--edition', '2021', '-O', src, '-o', out], { stdio: 'pipe' });
  return out;
}

/** Narrows a `Result<T>` envelope, the one controlled place this file ever reads `.value` off a
 * handler's return -- every call site below gets a plain, already-narrowed `T`, never an inline
 * cast-and-access. */
function expectOk<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`contract_replay: expected ok:true, got ${JSON.stringify(result)}`);
  return result.value;
}

interface AgentForWait {
  runtimeSnapshot: { status: string; pending: PendingRequest[] };
}

/** Integration-test exception (see this repo's own `ts-no-test-timers` rule): this polls a REAL
 * child process (the fake-omp Node script) advancing on the real system clock, including the
 * fixture's own genuine `{"__delay__": 2000}` pause between streamed deltas -- fake timers only
 * control this process's own JS-level timers, not the real wall-clock time a separate child
 * process's `setTimeout` needs to elapse, so deterministic time control is not possible here.
 * `Promise.withResolvers()` would otherwise be preferred (this repo's own
 * `ts-promise-with-resolvers` rule), but `tsconfig.node.json`'s own `lib` target predates ES2024
 * and this test must not edit shared config -- a plain executor is the documented fallback. */
async function waitForStatus(agent: AgentForWait, target: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = agent.runtimeSnapshot.status;
    if (current === target) return;
    if (Date.now() >= deadline) {
      throw new Error(`contract_replay: timed out after ${timeoutMs}ms waiting for status ${target} (last seen ${current})`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

/** `handleTurnSettled`'s own `status` transition to `idle` can resolve before the trailing
 * coalesced `patch` flush (`PatchCoalescer`'s own 50ms debounce window, `patchCoalescer.ts`)
 * actually fires -- waiting on status alone is therefore not enough to know every event this
 * turn will ever emit has already landed. Waits for that flush's own observable effect (a
 * `patch` event whose ops include the assistant's final, non-streaming reply) instead of
 * guessing a fixed buffer past the idle transition. */
async function waitForFinalAssistantPatch(events: ManagerEvent[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = events.some(
      (event) =>
        event.type === 'patch' &&
        event.payload.ops.some((op) => op.op === 'upsert' && op.item.kind === 'assistant-text' && op.item.streaming === false),
    );
    if (found) return;
    if (Date.now() >= deadline) {
      throw new Error(`contract_replay: timed out after ${timeoutMs}ms waiting for the final assistant patch`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

function isIso8601Timestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
}

/** Epoch-ms bookkeeping fields this crate's own `SessionAgent.ts`/transcript code stamps from the
 * real wall clock, never supplied by the fixture tape itself -- normalized the same way the Rust
 * trace's `startedAt`/`endedAt`/`durationMs` are, plus `turnStartedAt` (spec 004, a field the
 * Rust port does not carry at all: subagents/readout are out of that slice's scope). */
const TIMING_KEYS: ReadonlySet<string> = new Set(['startedAt', 'endedAt', 'durationMs', 'turnStartedAt']);

/** Same spirit as the Rust test's own `normalize`: replaces every run-to-run-nondeterministic
 * value (longest string first, so a longer match is substituted before a shorter one it happens
 * to contain can partially corrupt it). */
function normalize(value: unknown, dynamic: ReadonlyArray<readonly [string, string]>): unknown {
  if (typeof value === 'string') {
    let out = value;
    for (const [needle, placeholder] of dynamic) {
      if (needle.length > 0 && out.includes(needle)) out = out.split(needle).join(placeholder);
    }
    return isIso8601Timestamp(out) ? '<TIMESTAMP>' : out;
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, dynamic));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (TIMING_KEYS.has(key) && inner !== null && inner !== undefined) {
        out[key] = '<TIMESTAMP_MS>';
        continue;
      }
      out[key] = normalize(inner, dynamic);
    }
    return out;
  }
  return value;
}

describe('contract replay (TS)', () => {
  it(
    'replays the session scenario tape against the real IPC handlers and SessionManager',
    async () => {
      const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-ts-contract-replay-shim-'));
      const ompPath = buildOmpShim(shimDir);
      const fakeOmpScript = path.join(REPO_ROOT, 'scripts', 'verify-tauri-fake-omp.mjs');
      if (!existsSync(fakeOmpScript)) throw new Error(`contract_replay: expected fake-omp script at ${fakeOmpScript}`);
      process.env.REFRACT_FAKE_OMP_SCRIPT = fakeOmpScript;
      process.env.REFRACT_FAKE_OMP_NODE = process.execPath;
      process.env.REFRACT_FAKE_OMP_SCENARIO = 'session';

      const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-ts-contract-replay-data-'));
      const registry = await RegistryStore.open(dataDir);
      const settings = await SettingsStore.open(dataDir);
      const manager = new SessionManager(registry, settings, ompPath);

      registerRepositories(manager, () => undefined);
      registerSessions(manager);
      registerChat(manager);

      const events: ManagerEvent[] = [];
      manager.onEvent((event) => events.push(event));

      const repoDir = makeScratchRepo();
      const steps: unknown[] = [];

      const addHandler = handlers.get(IPC_REQUESTS.REPOSITORIES_ADD);
      if (!addHandler) throw new Error(`contract_replay: ${IPC_REQUESTS.REPOSITORIES_ADD} was never registered`);
      const addResponse = (await addHandler({}, repoDir)) as Result<Repository>;
      const repository = expectOk(addResponse);
      steps.push({ kind: 'ipc', channel: IPC_REQUESTS.REPOSITORIES_ADD, args: repoDir, response: addResponse });

      const createHandler = handlers.get(IPC_REQUESTS.SESSIONS_CREATE);
      if (!createHandler) throw new Error(`contract_replay: ${IPC_REQUESTS.SESSIONS_CREATE} was never registered`);
      const createArgs = { repositoryId: repository.id, baseBranch: 'main' };
      const createResponse = (await createHandler({}, createArgs)) as Result<Session>;
      const session = expectOk(createResponse);
      steps.push({ kind: 'ipc', channel: IPC_REQUESTS.SESSIONS_CREATE, args: [createArgs], response: createResponse });

      // Marks the Session visible BEFORE opening it (unlike the Rust test): this is the one
      // extra call needed on this side to get real `patch` (`TranscriptOp`) events forwarded at
      // all (`SessionManager.getOrCreateAgent`'s own `agent.on('patch', ...)` gate) -- the Rust
      // test instead reads a full snapshot via `runtime_view()` directly, sidestepping that gate
      // entirely (see this file's own differences note at the bottom for why the two traces are
      // not expected to match field-for-field here).
      const setVisibleHandler = handlers.get(IPC_REQUESTS.SESSIONS_SET_VISIBLE);
      if (!setVisibleHandler) throw new Error(`contract_replay: ${IPC_REQUESTS.SESSIONS_SET_VISIBLE} was never registered`);
      await setVisibleHandler({}, [session.id]);

      const agent = manager.getOrCreateAgent(session.id);

      const openHandler = handlers.get(IPC_REQUESTS.SESSIONS_OPEN);
      if (!openHandler) throw new Error(`contract_replay: ${IPC_REQUESTS.SESSIONS_OPEN} was never registered`);
      const openResponse = await openHandler({}, session.id, true);
      steps.push({ kind: 'ipc', channel: IPC_REQUESTS.SESSIONS_OPEN, args: [session.id, true], response: openResponse });

      const sendHandler = handlers.get(IPC_REQUESTS.CHAT_SEND);
      if (!sendHandler) throw new Error(`contract_replay: ${IPC_REQUESTS.CHAT_SEND} was never registered`);
      const sendResponse = await sendHandler({}, session.id, PROMPT_MESSAGE, undefined);
      steps.push({ kind: 'ipc', channel: IPC_REQUESTS.CHAT_SEND, args: [session.id, PROMPT_MESSAGE], response: sendResponse });

      await waitForStatus(agent, 'needs-you', 10_000);
      const pendingRequest = agent.runtimeSnapshot.pending[0];
      if (!pendingRequest) throw new Error('contract_replay: expected a pending approval request');
      const requestId = pendingRequest.requestId;

      const answerHandler = handlers.get(IPC_REQUESTS.CHAT_ANSWER);
      if (!answerHandler) throw new Error(`contract_replay: ${IPC_REQUESTS.CHAT_ANSWER} was never registered`);
      const answerArgs = { approve: true };
      const answerResponse = await answerHandler({}, session.id, requestId, answerArgs);
      steps.push({ kind: 'ipc', channel: IPC_REQUESTS.CHAT_ANSWER, args: [session.id, requestId, answerArgs], response: answerResponse });

      await waitForStatus(agent, 'idle', 15_000);
      await waitForFinalAssistantPatch(events, 5_000);

      // The real event stream captured via `SessionManager.onEvent` (not a reconstructed
      // snapshot): every `status`/`patch`/`request`/`requestResolved`/`list-changed` event this
      // run actually emitted, in order.
      steps.push({ kind: 'events', events });

      await agent.shutdown();

      const dynamic: ReadonlyArray<readonly [string, string]> = (
        [
          [session.worktreePath, '<WORKTREE_PATH>'],
          [repository.path, '<REPO_DIR>'],
          [repository.name, '<REPO_NAME>'],
          [session.branch, '<BRANCH_NAME>'],
          [session.id, '<SESSION_ID>'],
          [repository.id, '<REPO_ID>'],
        ] as Array<[string, string]>
      ).sort((a, b) => b[0].length - a[0].length);

      const trace = normalize(steps, dynamic);
      // eslint-disable-next-line no-console
      console.log('contract_replay (TS): normalized trace:\n', JSON.stringify(trace, null, 2));

      const goldenPath = path.join(REPO_ROOT, 'scripts', 'fixtures', 'contract-replay', 'session-scenario.ts-trace.json');
      if (!existsSync(goldenPath)) {
        throw new Error(
          `contract_replay (TS): could not find golden file ${goldenPath}. First run: copy the ` +
            '"normalized trace" block printed above into that file after eyeballing it against ' +
            'scripts/fixtures/omp-frames/session.jsonl, then re-run this test.',
        );
      }
      const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
      expect(trace).toEqual(golden);
    },
    30_000,
  );
});

// Differences from the Rust trace (`session-scenario.rust-trace.json`), both intentional and
// structural, never closed because "it would be nice if they matched byte-for-byte":
//
// - This trace's "events" step is a real `ManagerEvent[]` captured off `SessionManager.onEvent`
//   (status/patch/request/requestResolved/list-changed, in emission order); the Rust trace's
//   "transcript_snapshot" steps are full `runtime_view()` reads at three checkpoints instead,
//   because `events::EventSink` is a documented no-op without a live `AppHandle`/window (see
//   `scripts/fixtures/contract-replay/README.md`'s own explanation) -- there is no real Tauri
//   event for that test to ever observe, so it falls back to the strictly-more-informative full
//   snapshot. Neither shape is a subset of the other.
// - This trace calls `sessions.setVisible` before `sessions.open` (needed to get `patch` events
//   forwarded at all, see the comment above that call); the Rust test never calls the equivalent
//   `sessions.setVisible` channel, so its final `unread` flag differs from what this build would
//   show (unrelated to this stretch test specifically -- a reader comparing the two files should
//   not expect the Session-level fields to agree either).
// - Field names differ in casing/shape only where the TS and Rust wire types themselves already
//   differ (both are hand-verified against `scripts/fixtures/omp-frames/session.jsonl` directly,
//   not against each other).
// - `repositories.add`'s `remote.kind` is `"none"` here vs `"unknown"` in the Rust trace: this
//   build's handler (`ipc/repositories.ts`) computes the real remote eagerly on add (`"none"`
//   is the genuinely-no-`origin`-configured answer for this scratch repo); the Rust handler
//   always returns the `unknown` placeholder on `.add` instead (`repositories.rs`'s own
//   `with_unknown_remote`, real remote computed later by `.remotes`/`.rename`) -- a real,
//   pre-existing behavioral difference between the two builds, not a harness artifact.
// - The `commands` event here lists a native `/btw` entry alongside the engine's own `/tools`
//   (`slash-commands.ts`'s `NATIVE_RESERVED_COMMANDS`, side chat); the Rust port has no side-chat
//   slice yet (`session/agent/mod.rs`'s own header: "side chat (`btw`)... not ported"), so its
//   equivalent command list never would carry it either.
