# Data model: Session readout

Extends spec 001's data model (`specs/001-core-session-workspace/data-model.md`); this file only
lists what this spec adds or changes. Terms follow [CONTEXT.md](../../CONTEXT.md).

## Stored by Refract

### `settings.json` — extended

```ts
export type ReadoutKind =
  | 'changes'
  | 'context-usage'
  | 'turn-time'
  | 'current-time'
  | 'pull-request'
  | 'subagents'
  | 'todo-progress';

interface Settings {
  version: 1;
  approvalMode: 'ask' | 'edit-freely' | 'auto';      // unchanged (spec 001)
  sessionReadout: Record<ReadoutKind, boolean>;        // new (FR-012 to FR-014)
}
```

**Defaults (FR-013)**: every kind `true` except `'current-time'`, which defaults `false`:

```ts
const DEFAULT_SESSION_READOUT: Record<ReadoutKind, boolean> = {
  changes: true,
  'context-usage': true,
  'turn-time': true,
  'current-time': false,
  'pull-request': true,
  subagents: true,
  'todo-progress': true,
};
```

**Migration**: an existing `settings.json` written before this spec has no `sessionReadout` key.
`SettingsStore.open` (spec 001 `src/main/store/settings.ts`) must merge `DEFAULT_SESSION_READOUT`
under any existing settings object that parses but lacks the key, the same way a totally missing
or corrupt file already falls back to a full default (spec 001 data-model.md "write atomically;
on a parse failure... start with an empty one"). This is a field-level merge, not a new
file-corruption path.

**New request**: `settings.setReadoutVisibility(kind, visible)` replaces one entry and persists
the whole `Settings` row the same way `setApprovalMode` already does (spec 001
`src/main/store/settings.ts`), including that function's race-safety note: it returns the value
*this* call wrote, never a possibly-superseded shared read (see contracts/ipc.md).

## Held in memory

### `SessionRuntime` — extended

```ts
interface SessionRuntime {
  // ...unchanged fields from spec 001...
  turnStartedAt: number | null;        // epoch ms; set on agent_start, cleared on session_settled/stop
  readout: SessionReadout;             // last assembled bundle; never persisted
  subagents: SubagentSummary[];        // current turn's subagents; cleared when a new turn starts
}
```

`turnStartedAt` is the only new raw signal; everything else under `readout` is derived from
signals spec 001 already tracks (`transcript`, `queue`, `status`) plus the three newly-read OMP
fields this spec's probes resolve, plus the `diffStat` and `gh` lookups below.

### `SessionReadout` (new)

The bundle pushed by `readout:update` and included once in `sessions.open`'s `SessionSnapshot`
(contracts/ipc.md). Current time is deliberately absent: it is a pure client clock the renderer
computes itself (FR-005), never a value main pushes.

```ts
interface SessionReadout {
  changes: DiffStat | 'not-available' | null;   // DiffStat is spec 001 sessions.diffStat's return shape; null = not yet read
  contextUsage: ContextUsage | 'not-available' | null; // null = agent does not report it at all (hidden, not shown)
  turnTime: { startedAt: number } | null;        // null = no turn running (chip hidden); renderer computes elapsed
  pullRequest: { number: number; url: string } | null; // null = none, no remote, lookup failed, or GitHub unavailable
  subagentCount: { running: number; finished: number; exited: number; failed: number } | null; // null = turn has started none (chip hidden); gate fixes 2 finding 7: finished/exited/failed kept separate, never folded together
  todoProgress: { done: number; total: number } | null; // null = agent has no task list (chip hidden)
}

interface ContextUsage {
  usedTokens: number;
  windowTokens: number;
  percent: number;     // 0-100, derived, not independently reported
}
```

`DiffStat` is not redefined here: it is exactly spec 001 task T068's `sessions.diffStat(id)`
return type (`{ files, additions, deletions, partial } | null`), reused as-is; this spec's
`'not-available'` literal on `changes` maps to the `null` that call already returns when the Base
branch or worktree is missing (spec 001 FR-039/`contracts/ipc.md`), relabelled for this spec's own
FR-002 wording ("Not available" rather than a silently absent chip).

**Retention rule (FR-008, edge cases)**: `changes`, `pullRequest`, and `contextUsage` keep their
last non-null reading when the agent is not running or a lookup momentarily fails, rather than
reverting to `null`; `turnTime` is always `null` outside a running turn. `subagentCount` persists
after its turn settles (a developer still asking "what did it delegate to" afterward) and, since
issue #489, can also be non-`null` immediately on attach/resume with no turn running at all, when
the reattached transcript still shows a seeded `exited` subagent from before this process
existed; both are cleared only by the *next* turn starting (`agent_start`), never by settling or
attaching alone.

### `SubagentSummary` (new)

One row in the Subagents panel (FR-017) and the source the Subagents chip's count is computed
from.

```ts
interface SubagentSummary {
  id: string;                               // `${toolCallId}:${name-or-fallback}` (remediation round, see tasks.md) -- globally unique, not just stable within one turn
  toolCallId: string;                       // the owning task() call's own id; scopes correlation across 2+ parallel task calls in one turn
  specIndex: number;                        // this spec's position in the owning call's own tasks[] (gate fix, 2026-10-07): the correlation key reconcileSubagentsOnAttach uses against the chat transcript's own subagent row, since the two sides' id schemes never match
  nameOrTask: string;                       // the subagent's name, or its task text when unnamed
  status: 'running' | 'finished' | 'failed' | 'exited'; // 'exited': issue #489, seeded on attach/resume, process confirmed gone, nothing known about its own work
  startedAt: number;
  durationMs?: number;                      // present once status is finished, failed, or exited, and startedAt was genuinely known (gate fix, 2026-10-07: never fabricated from a history row with no wall clock)
}
```

Each `SubagentSummary`'s live stream (FR-018, "what it is saying and which tools it is running")
is not stored on the summary itself: it is a `TranscriptItem[]` per subagent id, built the same
way the main transcript is (spec 001 `src/main/omp/transcript.ts`), requested on demand via
`chat.subagentSnapshot` and then patched via `subagent:patch` (contracts/ipc.md) — mirroring
`sessions.open` + `transcript:patch` rather than storing every subagent's full stream for every
Session all the time.

## Renderer-only state

### `view-store.ts` (new)

Not persisted; resets to `'chat'` on reload. One store shared with spec 003 (`'pull-requests'`
view) and spec 008 (`'settings'` entry point it drives, plus `'manage-sessions'`), unified shape
agreed across the three parallel planning sessions per research.md decision 6. This spec's task
builds the whole shape; it implements only the `'chat'`/`'settings'` behaviour and leaves
`openPullRequests`/`openManageSessions` as typed stubs that just set `view` (and `repositoryId`
for the former).

```ts
type MainView = 'chat' | 'pull-requests' | 'settings' | 'manage-sessions';
type SettingsSectionId = 'session-readout'; // spec 007 adds 'appearance' later, not built here

interface ViewState {
  view: MainView;
  repositoryId: string | null;                        // spec 003's field; unused by this spec's own views
  settingsSection: SettingsSectionId | null;
  openChat(repositoryId?: string): void;
  openPullRequests(repositoryId: string): void;         // typed stub: sets view + repositoryId only
  openSettings(section?: SettingsSectionId): void;
  openManageSessions(): void;                           // typed stub: sets view only
}
```

## State transitions this spec adds

| From | Event | To |
|---|---|---|
| `turnStartedAt: null` | `agent_start` | `turnStartedAt: <now>` |
| `turnStartedAt: <t>` | `session_settled`, or the Session stops | `turnStartedAt: null` |
| `subagents: []` | a `task` tool call starts (research.md item 9's probe shape) | one `SubagentSummary` per started subagent, `status: 'running'` |
| a `SubagentSummary` | its tool call ends (success) | `status: 'finished'`, `durationMs` set |
| a `SubagentSummary` | its tool call ends (error) | `status: 'failed'`, `durationMs` set |
| `subagents: [...]` | a new turn starts (`agent_start`) | cleared to `[]` (FR-007: count is "the current turn's") |
| a `SubagentSummary` at `status: 'running'` carried over from before a crash, or a `kind: 'subagent'` transcript row still `status: 'running'` with no such summary yet (fresh instance) -- the two collapsed to ONE candidate by `toolCallId`+`specIndex` if both represent the same instance, and scoped to the current/last turn only | an attach/resume (`launch()`, issue #489) | `status: 'exited'` unconditionally, `durationMs` set only if a genuine `startedAt` was ever known (gate fixes, 2026-10-07: no `get_subagents` RPC call -- a freshly launched process's own registry is confirmed-live always empty here, so it can never discriminate "still running" from "gone"); the matching chat-transcript `subagent` row is settled to `status: 'exited'` too |
| `view: 'chat' \| 'pull-requests' \| 'manage-sessions'` | `openSettings(section?)` | `view: 'settings'`, `settingsSection` set |
| `view: 'settings'` | `openChat(repositoryId?)`, or any left-nav/Session action that returns to chat | `view: 'chat'` (and `repositoryId` set when provided) |
