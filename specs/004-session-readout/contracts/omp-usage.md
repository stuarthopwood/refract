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
  `'exited'` (not left spinning); `readout.subagentCount` read `{ running: 1, finished: 0,
  exited: 0, failed: 0 }` in the single synchronous `recover()` response itself (the 50 ms
  `READOUT_COALESCE_MS` debounce had not yet fired) but corrected to `{ running: 0, finished: 0,
  exited: 1, failed: 0 }` on the very next read (the current 4-field shape -- corrected here,
  not re-driven live), matching
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

### f. Gate fixes 2 live verification (2026-10-07, omp 18.8.0, scratch CDP instance, issue #489)

Section (e)'s "this surfaced and fixed a real bug: `reconcileSubagentsOnAttach` never called
`scheduleReadoutUpdate()`" claim is **retracted**: both call sites (`launch()`, `openConversation()`)
already `await syncFromState(...)` immediately afterward, which unconditionally calls
`scheduleReadoutUpdate()` itself at its own tail; the explicit call inside reconcile was a true
no-op duplicate (`scheduleReadoutUpdate` is itself a no-op while a timer is already pending) and
has been removed. The stale `{ running: 1, finished: 0, exited: 0, failed: 0 }` (current 4-field
shape) in the synchronous response, correcting
moments later, is simply the 50 ms `READOUT_COALESCE_MS` debounce -- real, reproduced again below,
never a bug reconcile's own call could have fixed either way.

Driven end to end via `window.refract.*` IPC on a scratch Electron instance (isolated
`--user-data-dir`, CDP port 9489, a real signed-in `omp` 18.8.0 agent, the real `omp.exe` pid read
from the scratch instance's own `processes.json`, hard-killed only after confirming its command
line): a real turn, one batch `task()` call, two parallel subagents -- "Fast" (reads a fixed file,
finishes in seconds) and "Slow" (`bash sleep`, still running when killed).

- **Finding 3** (seed finished subagents too): `sessions.recover()` returned BOTH `Fast`
  (`status: 'finished'`, real `durationMs` untouched) and `Slow` (`status: 'exited'`) -- not only
  the one still running at kill time.
- **Finding 2** (turn boundary) -- **SUPERSEDED, gate fixes 3 (2026-10-07)**: this finding and the
  "walk back from the last `subagent` row" rule it validated are reverted. That rule fixed this
  steer case but created a worse one, confirmed live separately: with no `subagent` row of its
  own in a later plain turn, walking back from an EARLIER turn's last `subagent` row could land
  on that earlier turn's own preceding `user` item, re-seeding its already-finished subagents as
  "this turn's" subagents on every later restart/Recover/`openConversation`. The turn boundary is
  back to the plain "last `user` item" rule this finding originally reported as insufficient;
  the steer case it exercised is now an accepted, documented limitation (spec.md Edge Cases,
  gate fixes 3) instead of a fixed one: a steer sent while a subagent is still running moves the
  boundary past that subagent's row, and a later restart/Recover does not restore its pill.
- **Finding 1** (no duplicate on a second reconcile): two consecutive `sessions.recover()` calls
  on the SAME instance, no new turn in between, returned byte-identical `subagents` arrays (`Fast`/
  `Slow`, two entries both times).
- **Finding 6** (notice renders): clicking the real session row, the real Subagents chip, then the
  real `Slow` row in the real `#subagent-panel` rendered "Agent exited / Info: / No live output:
  this subagent had already exited when Refract reattached." -- confirmed via `panel.innerText`
  and a screenshot. This live pass caught two bugs before it worked: (a) `subagentStreams` can
  already hold an EMPTY array for a subagent id the instant the batch `task()` call starts,
  blocking the placeholder-if-missing guard from ever firing (`.has()` fixed to check `.length`);
  (b) a row `transcript.ts`'s own finding-5 fix had already settled to `'exited'` on a fresh
  instance's first `fromHistory` build was then skipped by an over-eager `reconcileSubagentsOnAttach`
  guard instead of still being seeded as a resolved candidate (fixed by accepting an already-`exited`
  transcript row into the candidate set rather than treating it as already handled).
- **Finding 8 confirmed, not re-"fixed"**: the chip's `subagentCount` in the synchronous `recover()`
  response itself stayed at the pre-kill value, correcting about a second later (confirmed via the
  real chip's own accessible name, "Open subagents panel (1 finished, 1 exited)") -- the debounce
  disclosed above, nothing more.

**Not re-driven live this pass**: `openConversation()`'s own reconcile call (finding 4) and the
older-turn settling in `fromHistory` in isolation (finding 5, beyond what finding 6's own
interaction above already exercised) were code-reviewed and typechecked, not separately driven
live.

### g. Gate fixes 3 live verification (2026-10-07, omp 18.8.0, scratch CDP instance, issue #489)

Driven end to end via `window.refract.*` IPC on a scratch Electron instance (isolated
`--user-data-dir`, CDP port 9489, a real signed-in `omp` 18.8.0 agent, the real `omp.exe` pid read
from the scratch instance's own `processes.json`, hard-killed only after confirming its command
line and image name). Three separate Sessions, one per scenario; each subagent-spawning turn
first needed its OWN preliminary settled turn (a trivial no-tool reply) so `currentConversation`
persisted to the registry before the crash -- without it `attachAndVerify` never calls
`switch_session` and the next `launch()` silently starts a brand-new empty Conversation instead
of reattaching, which would not exercise either fix.

- **H1 (repeat-Recover row spins forever), finding 1 corrected**: one turn, one batch `task()`
  call, two subagents -- `Fast` (`echo fast-done`) and `Slow` (`sleep 180`). Hard-killed the real
  `omp.exe` while `Slow` was confirmed `running`. **Recover #1** (first real crash): returned
  `Fast` `status:'finished'` and `Slow` `status:'exited'`, both matching chat-transcript rows
  settled (`'done'`/`'exited'`, neither `'running'`). Hard-killed the NEW `omp.exe` `launch()`
  spawned (a second real crash, no new turn/steer in between) and called **Recover #2**: the
  transcript rows for both `Fast` and `Slow` stayed `'done'`/`'exited'` -- no transcript row
  anywhere in the array had `status === 'running'` -- and `subagents` still read exactly `Fast`
  finished / `Slow` exited, never duplicated. Before this fix, `Slow`'s already-settled
  correlation key made the transcript scan `continue` outright, so `fromHistory`'s rebuilt
  `'running'` row for it never reached `transcriptSettling`, and `candidates.size === 0` returned
  before any settling ran -- the chat row would have spun `'running'` forever on this second
  Recover. Confirmed fixed.
- **H2(a) (earlier turn seeded as current turn), finding 2 reverted correctly**: turn 1, one
  subagent `Note` (`echo note-done`), settled to `finished` before turn 2 started. Turn 2, a plain
  no-tool reply ("done"), settled normally. Hard-killed the real `omp.exe`, then **Recover**:
  `subagents` returned `[]` -- `Note` did NOT resurface as "this turn's" subagent, even though it
  is still the transcript's own last `kind:'subagent'` row. With gate fixes 2's "walk back from
  the last `subagent` row" rule still in place, `turnStartIndex` would have walked back from
  `Note`'s row to ITS OWN preceding `user` item (turn 1's), re-seeding `Note` as current; the
  reverted plain "last `user` item" rule anchors on turn 2's `user` item instead, correctly
  scoping `Note` out. Confirmed fixed.
- **H2(b) (crash-mid-subagent, no steer), the main scenario, confirmed still correct**: turn 1
  settled, then turn 2 spawned exactly ONE subagent `Worker` (`sleep 180`). Hard-killed while
  `Worker` was confirmed `running`, then **Recover**: `subagents` returned exactly one entry,
  `Worker`, `status:'exited'`, with NO `durationMs` field at all (medium fix: an `exited` row's
  real end time is never known, so `now - startedAt` would have counted the entire crash-to-
  Recover downtime as "duration" -- confirmed this is no longer emitted). The matching
  chat-transcript row also read `status:'exited'`. The chip's own `subagentCount` in the
  synchronous `recover()` response read the stale pre-kill `{running:1,...}` (the known 50 ms
  `READOUT_COALESCE_MS` debounce, unrelated to this fix), confirming the pill-producing data is
  reachable.

**Not separately re-driven live this pass**: `openConversation()`'s own reconcile path and
`transcript.ts`'s `settleStaleSubagentRows` in isolation were not re-exercised beyond what the
three scenarios above already drove through `reconcileSubagentsOnAttach`; they were unchanged by
this pass's edits (code-reviewed only).

### h. Durable turn marker live verification (2026-10-07, omp 18.8.0, scratch CDP instance, issue #489)

Replaces transcript position with `Session.currentTurnSubagents` (registry-backed). Driven end
to end via `window.refract.*` IPC on a scratch Electron instance (isolated absolute
`--user-data-dir` under the OS temp dir, CDP port 9489, a real signed-in `omp` 18.8.0 agent
confirmed via `readiness.check().ompSignedIn.ok`); every kill targeted the exact `omp.exe` pid
read from the scratch instance's own `processes.json`, confirmed via `Win32_Process`
`ParentProcessId`/`CommandLine` against the scratch Electron main pid before every `taskkill`.
The user's live pinion instance (a separate `omp.exe` parent pid, `%APPDATA%\pinion`) was
confirmed untouched throughout, including in the final process listing.

- **(a) Steer mid-subagent, same-instance Recover AND a full app restart**: session
  `bold-osprey`, one subagent `Worker` (`sleep 240`). Confirmed `running`
  (`currentTurnSubagents: ["toolu_01LCnwwttW8TYPA9Wu51ovdV:0"]`), then queued + `sendNow`
  steered a message in (`{queued:true}` then `{steered:true}`) -- the resulting transcript order
  was `[...,subagent(running),tool:wait,user(STEER),assistant-text("OK")]`, i.e. the steer's own
  `user` item landed AFTER the subagent row, the exact #489 trigger. `currentTurnSubagents`
  stayed `["toolu_...:0"]` through the steer (no `agent_start` fired). Hard-killed the real
  `omp.exe`, called `sessions.recover()`: transcript showed exactly ONE `subagent` row,
  `status:'exited'`, chat row settled, steer's `user` item still positioned after it. Then killed
  the WHOLE scratch Electron tree and relaunched with the identical `--user-data-dir`: the
  registry's `currentTurnSubagents` survived the restart unchanged, and reopening the Session
  again produced the identical result -- one `subagent` row, `status:'exited'`, chat row settled.
- **(b) Turn 1 with a subagent, turn 2 plain, kill+Recover -- no earlier-turn agents**: session
  `mellow-heron`. Turn 1's subagent `Worker` finished normally before a turn 2 plain reply was
  sent (confirmed via `sessions.list()`: `currentTurnSubagents: []` after turn 2, since
  `agent_start` cleared turn 1's key). Hard-killed the real `omp.exe`, called
  `sessions.recover()`: the captured `onSubagentsUpdate` event read `subagents: []` -- `Worker`
  did NOT resurface as "this turn's" subagent, and its transcript row stayed `status:'done'`,
  untouched.
- **(c) Crash mid-subagent, no steer**: session `brisk-raven`, one subagent `Worker`
  (`sleep 240`), confirmed `running`. Hard-killed the real `omp.exe`, called
  `sessions.recover()`: transcript showed one `subagent` row `status:'exited'`; the captured
  `onSubagentsUpdate` event read one entry `status:'exited'`; the captured `onReadoutUpdate`
  event read `subagentCount:{running:0,finished:0,exited:1,failed:0}` -- chip, array, and
  transcript row all agree.
- **(d) Two consecutive Recovers, no new turn in between**: same `brisk-raven` session.
  Hard-killed the NEW `omp.exe` `recover()` had just spawned (a second real crash, no new turn),
  called `sessions.recover()` again: the transcript still read exactly ONE `subagent` row,
  `status:'exited'` (zero rows at `status:'running'`), and no new `onSubagentsUpdate` event fired
  (the already-settled key correctly skipped re-seeding and the early-return path took no action).
- **(e) A registry written by the previous build loads fine**: with the scratch app stopped,
  `currentTurnSubagents` was deleted from `mellow-heron`'s own `registry.json` entry by hand
  (simulating a pre-this-change row), then the whole scratch Electron tree was restarted against
  the SAME `--user-data-dir`: `sessions.list()` returned `{ok:true, count:5}`, including the
  edited row, with no error and no crash.
- **(f) Parallel batch, one finished before the kill -- both seeded**: session `gallant-walrus`,
  one batch `task()` call, two subagents -- `Fast` (`echo fast-done`) and `Slow` (`sleep 240`).
  Confirmed before the kill: `Fast` `status:'done'`, `Slow` `status:'running'` (one
  `currentTurnSubagents` write covering both keys from the single batch). Hard-killed the real
  `omp.exe`, called `sessions.recover()`: transcript read `Fast` `status:'done'` (unchanged, its
  real recorded status) and `Slow` `status:'exited'` -- both seeded, neither dropped.

**Not separately re-driven live this pass**: `openConversation()`'s own reconcile path and
`switchRecovery.ts`'s `recoverFromFailedSwitch` path were updated to read the same persisted set
(code-reviewed, typechecked) but not independently exercised through a live failed-switch or
Conversation-change scenario this round.
