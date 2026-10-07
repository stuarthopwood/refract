# Contract: how Refract uses OMP — Session readout additions

Extends spec 001's contract (`specs/001-core-session-workspace/contracts/omp-usage.md`). This
spec reads three OMP behaviours that are **unverified on the supported version (18.4.x or 18.5.x)** per
constitution IV; each is resolved by a Phase 1 probe task in `tasks.md`, which updates this file
with the exact field or frame name once run. Nothing below is a field name yet — these are the
questions the probes answer, not an assumed answer.

## Resolved by Phase 1 probes (FINDINGS items 34 to 36, 2026-10-04, omp 18.5.1)

### a. Context window usage (Context window usage chip, FR-003)

**Resolved**: `get_state().contextUsage` is a plain object already present on the response,
`{ tokens: number, contextWindow: number, percent: number }` — `percent` is computed and reported
by OMP itself, never derived by Refract. Confirmed present both before any turn (system-prompt
baseline) and after. `get_session_stats` also exists as a real request and nests the identical
`contextUsage` shape inside a richer per-Session stats object, but is not needed: `get_state` alone
is sufficient and is already read on every settle. `assembleReadout` (T007) reads
`state.contextUsage.tokens`/`.contextWindow`/`.percent` directly (no independent derivation),
retaining the last non-null reading per data-model.md's retention rule; `'not-available'` is used
only if a sync happens and the field is absent (not observed on the supported versions, but the
spec's own escape hatch for a future OMP that omits it). FINDINGS item 34.

### b. Task-list ("todo") progress (Todo progress chip, FR-021)

**Resolved**: `get_state().todoPhases` is `Array<{ name: string, tasks: Array<{ content: string,
status: string }> }>`, matching the spec's own guessed field name exactly. `status` observed values:
`"completed"`, `"in_progress"`, `"pending"` (the `todo` tool's own documented "earliest pending
starts" behaviour can auto-advance a task to `in_progress`, not just leave it `pending`).
`todoProgress.done` is the count of `status === 'completed'` across every phase's `tasks`;
`todoProgress.total` is the flat count of all tasks across every phase; `null` (chip hidden) when
`todoPhases` is absent or empty. The hidden `todo` tool's own `tool_execution_end.result.details`
carries the identical `phases` array as a side effect, confirming agreement, but Refract reads only
`get_state().todoPhases`. FINDINGS item 35.

### c. Per-subagent id, status, timing, and live stream (Subagents chip and panel, FR-007, FR-017 to FR-020)

**Resolved**: the live per-subagent frame is **`tool_execution_update`** (not `tool_call_update` as
FINDINGS C6's original note and this section's own question both guessed), sent for the `task`
tool's own `toolCallId` with no subscription call needed (`set_subagent_subscription` is a real
request but takes a `level` argument this probe did not resolve, and is not required — the update
frames stream by default). Shape: `{ type: 'tool_execution_update', toolCallId, toolName: 'task',
args, partialResult: { content, details: { progress: SubagentProgress[], results, totalDurationMs,
async, projectAgentsDir } } }`. Each `progress[]` entry is keyed by a **stable id that is literally
the subagent's own `name`** (e.g. `"Alpha"`), usable directly as `SubagentSummary.id` and as
`chat.setVisibleSubagent`'s argument (falling back to `${id}:${index}` only if a duplicate name is
ever seen within one batch, not observed in the probe):

```ts
interface SubagentProgress {
  index: number;
  id: string;             // the subagent's own name; stable across every update
  status: 'pending' | 'running' | 'completed' | string; // 'failed'/'cancelled' not observed live
  task: string;            // full composed assignment text
  assignment: string;      // the task's own, shorter assignment text
  recentTools: Array<{ tool: string; args: string; argsKey?: string; intent?: string; isError: boolean; endMs: number }>;
  recentOutput: unknown[];  // never observed non-empty (both probe subagents replied via `yield`); element shape unconfirmed
  toolCount: number;
  durationMs: number;      // 0 while running
  resolvedModel?: string;
  contextTokens?: number;
  contextWindow?: number;
  lastIntent?: string;
  extractedToolData?: Record<string, Array<{ data: unknown; status: string }>>;
}
```

`recentTools[]` is the live, incrementally-growing per-subagent tool-call stream FR-018 needs
(confirmed growing across successive frames as a subagent made more calls); no nested
`message_start`/`message_update`/`message_end` frame was ever scoped to a subagent id — the
fallback hypothesis (nested message frames) is confirmed NOT how OMP exposes this. `subagent:patch`
(T008) is built by diffing `recentTools[]` (and `recentOutput[]`, defensively, if ever non-empty)
into synthetic `TranscriptItem`-shaped rows per subagent id, the same upsert-by-stable-id pattern
`transcript.ts` already uses elsewhere. FINDINGS item 36 (extends C6).

## Verified, reused from spec 001 — not re-probed

- `agent_start` / `session_settled`: already relied on for the whole status machine (spec 001
  data-model.md); this spec reuses them unchanged for `turnStartedAt` (research.md item 8).
- `tool_execution_start` / `tool_execution_end` for the `task` tool: already the basis of spec 001
  task T078's one-collapsed-line-per-subagent chat rendering; this spec's subagent tracking reads
  the same calls, just builds a richer in-memory structure from them (id, status, stream) instead
  of only a chat row.

### d. `get_subagents` on attach/resume (Subagents chip/panel seeding, FR-007, FR-017, issue #489)

**Resolved, then superseded by gate finding 5 (2026-10-07)**: `get_subagents` returns
`{ subagents: SubagentEntry[] }`, scoped to the issuing process's own in-memory registry only.
Confirmed live (`docs/spike/get-subagents-probe.mjs`, 2026-10-07, omp 18.8.0): a process with no
Conversation yet returns `{ subagents: [] }`; the SAME process, mid-batch `task()` call, returns
one entry per genuinely running subagent; a process A hard-killed while its subagent is still
running, then a brand-new process B `switch_session`-attached onto the exact same Conversation
file, returns `{ subagents: [] }` -- **the registry is never replayed from a Conversation's
history onto a fresh process**.

This is exactly why `SessionAgent.ts`'s `reconcileSubagentsOnAttach` no longer calls
`get_subagents` at all: `launch()` always spawns a brand-new `OmpProcess` (never reuses one), so
by the result above its own registry is unconditionally `{ subagents: [] }` at the point reconcile
runs -- there is no live case this process lifecycle can ever observe where asking would
discriminate "genuinely still running" from "gone" differently from simply assuming "gone". Every
`running` candidate reconcile finds (from `runtime.subagents` or a still-`running` transcript
`kind: 'subagent'` row) is therefore resolved straight to Refract's own terminal `exited` state
unconditionally, with no RPC round trip. The `SubagentEntry` shape below is kept for reference
(PLAN.md row C2c's future Agents panel may still need it against a *long-lived* process, a
genuinely different lifecycle) but is currently unused by any Refract code:

```ts
interface SubagentEntry {
  id: string;              // the subagent's own name; same value as SubagentProgress.id above
  index: number;
  agent: string;            // e.g. "sonic"
  agentSource: string;      // e.g. "bundled"
  status: 'running' | 'completed' | string;
  task: string;
  assignment: string;
  sessionFile: string;      // this subagent's own per-subagent Conversation .jsonl path
  lastUpdate: number;       // epoch ms
  parentToolCallId: string; // the owning task() call's own id, not resolvable to Refract's own toolCallId format without it
  progress: SubagentProgress; // identical shape to section (c) above, same object
}
```

**Not proven (gate finding 9, 2026-10-07)**: `set_subagent_subscription` (`level: 'progress'`) was
sent once, before the task ever started, and left active for the rest of process A's life in the
probe above -- `midFlightSnapshot` was therefore only ever observed WITH a subscription already
active, never without one while a subagent was genuinely running. This confounds, rather than
settles, whether `get_subagents` itself needs a subscription to populate its own registry; an
earlier draft of this section claimed subscription "made no observable difference to
`get_subagents` itself", which overstated what this probe actually isolated, and separately
contradicted section (c)'s own "not required" framing for the *unrelated* streaming
`tool_execution_update` frames. Both claims are retracted pending a probe that takes a
mid-flight `get_subagents` snapshot *before* ever sending `set_subagent_subscription`, then again
after, on the same running subagent. Moot for Refract's own behaviour either way, since
`reconcileSubagentsOnAttach` no longer calls `get_subagents` (above).

### e. Gate fixes live verification (2026-10-07, omp 18.8.0, scratch CDP instance, issue #489)

Both recovery paths driven end to end via `window.refract.*` IPC on a scratch Electron instance
(`--user-data-dir`/CDP port isolated from any live Session; a real signed-in account; a real
scratch git Repository/Session):

- **Same-instance Recover**: started a subagent (`task`, long-running `bash` sleep), confirmed
  `status: 'running'` via `sessions.open`, hard-killed the owning `omp.exe` process tree
  (`taskkill /PID <pid> /T /F`) while it was confirmed running, then called `sessions.recover`
  on the SAME still-running Electron process. Result: exactly ONE `SubagentSummary` (no
  duplicate), `status: 'exited'`; the matching chat-transcript `subagent` row also settled to
  `'exited'` (not left spinning); `readout.subagentCount` read `{ running: 1, finished: 0 }` in
  the single synchronous `recover()` response itself (the 50 ms `READOUT_COALESCE_MS` debounce
  had not yet fired) but corrected to `{ running: 0, finished: 1 }` on the very next read, matching
  what the renderer's `onReadoutUpdate` subscription would show moments later -- this surfaced and
  fixed a real bug: `reconcileSubagentsOnAttach` never called `scheduleReadoutUpdate()`, so the
  cached `readout.subagentCount` stayed at its pre-crash value ("1 running") forever once nothing
  else was left pending to trigger a recompute (fixed, `SessionAgent.ts`).
- **True app restart**: started a second subagent, confirmed running, hard-killed its `omp.exe`
  tree AND the whole scratch Electron process, relaunched Electron fresh with the SAME
  `--user-data-dir` (a brand-new `SessionAgent` instance, `subagentStreams` starting empty), then
  called `sessions.open`/`sessions.recover`. Result: exactly ONE `SubagentSummary`, seeded purely
  from the reattached transcript's own `kind: 'subagent'` row (id `subagent:<toolCallId>:0`, the
  transcript's own scheme, confirming no live summary ever existed in this fresh instance),
  `status: 'exited'`; selecting it via `chat.subagentSnapshot` returned the explanatory placeholder
  notice ("No live output: this subagent had already exited when Refract reattached") instead of
  throwing not-found. Reading the real session `.jsonl` directly: the owning `task` toolCall's own
  `toolResult` message (the orchestrator's immediate "Spawned agent ... Results auto-deliver"
  acknowledgment, written well before the subagent's real work finishes) WAS already persisted
  before the kill; the subsequent `wait` toolCall that would have blocked for the actual subagent
  result was recorded as started but never completed, and the file gained zero new lines after
  the kill. Despite the task call's own toolResult already being on disk, `fromHistory` still
  rebuilt the row as `status: 'running'` on reattach (confirmed live by `reconcileSubagentsOnAttach`
  finding and seeding it) -- the task tool's own near-instant "spawned" acknowledgment is not
  itself a completion signal `applyBatchTaskResult` treats as final.

**Not driven live (time-boxed out of this gate pass)**: the "later clean turn, then a mode-change
restart shows no phantom 'finished'" scenario (spec.md Edge Cases, finding 2(c)) was designed and
code-reviewed (current/last-turn scoping by the last `kind: 'user'` transcript item) but not
exercised against a real scratch instance; say so rather than claim it was.
