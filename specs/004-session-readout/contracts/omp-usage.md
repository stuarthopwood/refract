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
