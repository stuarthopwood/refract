# Data model: Core session workspace

Terms follow [CONTEXT.md](../../CONTEXT.md). Two kinds of data exist: what Refract stores (small JSON files) and what OMP already stores (Conversations). Refract never copies Conversation content.

## Stored by Refract

All files live in Electron's `userData` directory (`app.getPath('userData')`) and are written atomically: write `<name>.json.tmp`, flush, then rename over `<name>.json`. A file that fails to parse is renamed `<name>.json.corrupt-<timestamp>` and Refract starts with an empty one, so a bad file never blocks launch.

### `registry.json`

```ts
interface Registry {
  version: 1;
  repositories: Repository[];
  sessions: Session[];
}

interface Repository {
  id: string;              // uuid
  path: string;            // absolute path of the main checkout
  name: string;            // folder name, shown as the list group title
  defaultBranch: string;   // read from git when added; one-click creation's Base branch and the picker's preselection
  addedAt: string;         // ISO 8601
}

interface Session {
  id: string;                  // uuid
  repositoryId: string;
  name: string;                // display label; renamable; never affects branch or folder
  branch: string;              // generated, e.g. "swift-otter"; the Base branch picker lists it under the Session's name
  baseBranch: string;          // branch it was created from
  worktreePath: string;        // absolute; also the agent's cwd
  sessionDir: string | null;   // OMP's session directory for that cwd; null until first learned (see below)
  currentConversation: string | null; // absolute path of the current Conversation's file; null before the first message
  lastMessageCount: number | null;    // messageCount at the last settle; reattach requires messageCount >= this
  lastModel?: { provider: string; id: string; name?: string }; // T062: last known model from get_state; absent = unknown
  lastThinkingLevel?: string;  // T062: last known thinking level/reasoning effort from get_state; absent = unknown
  createdAt: string;
  lastActivityAt: string;
  archivedAt: string | null;   // non-null = archived
}
```

Rules:

- `worktreePath` is unique across all Sessions. `branch` is unique within a Repository.
- `name` (the display label shown in the list, chat header, branch picker, and notifications) is entirely independent of `branch` and `worktreePath`: renaming a Session (`sessions.rename`) only ever writes `name`, never touches the git branch or the worktree folder on disk, and takes effect immediately everywhere the name is shown (no restart, no re-list beyond the normal `session:list-changed` refresh).
- `sessionDir` is learned once: after the first agent process for a Session reports `get_state`, take `dirname(sessionFile)`. Refract does not compute OMP's directory-name encoding itself. Until the first message is sent, no file exists (OMP creates it lazily), so `sessionDir` is set when the first `sessionFile` is observed on a settled turn.
- `lastModel`/`lastThinkingLevel` (T062, docs/spike/FINDINGS.md item 30): written by `SessionAgent.syncFromState` from `get_state`'s own `model`/`thinkingLevel` fields at session start and after every settle, the same points `sessionDir`/`lastMessageCount` are written from. Persisted (registry-backed) last-known state, not only live-runtime state: unlike a `SessionRuntime` field, they are never cleared when the agent stops, so they remain the last values actually observed across a Stop and across an app restart. Absent means unknown (never started, or `get_state` has never reported a model for this Session yet), not "no model" -- existing registry rows with no such keys are read the same way, so no migration is needed. `name` inside `lastModel` is the display name OMP's `Model.name` reports, distinct from `id`; it is optional because not every response is guaranteed to carry it.
- Deleting a Session removes its entry and its worktree; the `sessionDir` files are deleted only when the user confirmed Delete.
- Removing a Repository from Refract removes the Repository and its Session entries, and never touches disk. It is refused while any of its Sessions has a running agent.

### `settings.json`

```ts
interface Settings {
  version: 1;
  approvalMode: 'ask' | 'edit-freely' | 'auto';   // default 'ask'
}
```

Mapping to OMP's `--approval-mode`: `ask` = `always-ask`, `edit-freely` = `write`, `auto` = `yolo`.

### `processes.json`

```ts
interface ProcessRecord { pid: number; startTime: string; sessionId: string }
```

One record per running `omp` root process, written when it starts and removed when it exits. `startTime` is the process creation time as read from Windows. At app start, every record whose pid is still running with the same creation time and an `omp` image name is stopped (`taskkill /T /F`); every other record is discarded. This is the fallback for a run where job-object assignment failed (see research.md decision 4).

## Derived from OMP (not stored by Refract)

### Conversation

Read by scanning `Session.sessionDir` for `*.jsonl` files:

| Field | Source |
|---|---|
| `file` | absolute path |
| `id` | the UUID suffix of the file name |
| `createdAt` | ISO timestamp prefix of the file name (no file open needed) |
| `title` | `title` field of the first line of the file, may be empty |
| `preview` | first user message, read from the first 8 KB of the file, truncated to 120 characters |
| `isCurrent` | `file === Session.currentConversation` |

A Conversation's history is loaded by attaching an agent to it and calling `get_messages`, not by parsing the file, so its format stays OMP's business. Files with zero user messages are not listed.

## Held in memory

### SessionRuntime (one per Session with a live or recently live agent)

```ts
type SessionStatus = 'idle' | 'working' | 'needs-you' | 'stopped';

interface SessionRuntime {
  sessionId: string;
  status: SessionStatus;
  stopReason?: 'agent-exited' | 'worktree-missing' | 'start-failed' | 'not-started';
  stopDetail?: string;                  // exit code, missing path, or setup message
  launchedMode: Settings['approvalMode'];
  pendingMode: Settings['approvalMode'] | null;  // set while a mode change waits for idle
  unread: boolean;
  transcript: TranscriptItem[];         // current Conversation, normalised
  queue: { followUp: string[]; steering: string[] };  // mirrors OMP queue_update
  pending: PendingRequest[];            // approvals and questions waiting for the user
}
```

A Session that has never been opened this run has no `SessionRuntime`. Its list status is `stopped` with `stopReason: 'not-started'`, which the UI shows as idle-and-asleep, not as an error.

### TranscriptItem

```ts
type TranscriptItem =
  | { kind: 'user'; id: string; text: string; at: number }
  | { kind: 'assistant-text'; id: string; text: string; streaming: boolean }
  | { kind: 'thinking'; id: string; text: string; streaming: boolean;   // omitted when the text is empty
      startedAt?: number; endedAt?: number }   // T075: absent when the source carries no usable timing
  | { kind: 'tool'; id: string; toolCallId: string; tool: string; target: string;
      status: 'running' | 'done' | 'error'; startedAt: number; durationMs?: number;
      args: unknown; output?: string; diff?: string; details?: unknown }   // details: raw result.details (T072/T073's `ask` answer)
  | { kind: 'subagent'; id: string; toolCallId: string; name: string; task: string;   // T078: one per batch task() entry
      status: 'running' | 'done' | 'error'; startedAt: number; durationMs?: number; result?: string; jobId?: string }
  | { kind: 'agent-message'; id: string; from: string; to: string; text: string; at: number }   // T079
  | { kind: 'advisory'; id: string; severity: 'nit' | 'concern' | 'blocker';   // T084, FR-051
      advisor?: string; turnsAgo?: number; guidance?: string; text: string }
  | { kind: 'request'; id: string; requestId: string; resolved?: 'approved' | 'denied' | 'answered' | 'cancelled' }
  | { kind: 'notice'; id: string; level: 'info' | 'warning' | 'error'; text: string };
```

Built in the main process from OMP frames (see [contracts/omp-usage.md](contracts/omp-usage.md)); the renderer only renders items. A `tool` item's `details` carries whatever `tool_execution_end`/history's `toolResult.details` sent, read generically by a tool-specific renderer instead of a one-off field per tool: T073's `ask` answer reads `details.selectedOptions`/`details.customInput` from it. A `subagent` item's `jobId` only ever correlates a batch `task()` call's `tool_execution_end` `details.progress[]` with the later `custom`/`async-result` message's `details.jobs[]` (FINDINGS item 22(e)); it is never rendered. `agent-message` renders an IRC-style message between a subagent and the main agent, or between subagents (FR-048); FINDINGS item 22(f) could not confirm OMP's wire shape for this, so the main process reads for it defensively (a `custom` message or an unrecognised top-level frame that looks like one) rather than one exact assumed shape. `advisory` (T084, FR-051) is parsed from a `custom` message's `content` string, which embeds one or more `<advisory severity="..." advisor="..." turnsAgo="..." guidance="...">note text</advisory>` elements (FINDINGS item 22(f): every such message carries `customType: 'advisor'`); an unknown/missing `severity` reads as `'nit'`, and a message that looks like one of these but fails to parse becomes a plain `notice` instead, never a raw-tag-text `advisory`.

### PendingRequest

```ts
type PendingRequest =
  | { kind: 'approval'; requestId: string; tool: string; target: string; details: string[] }
  | { kind: 'question'; requestId: string; title: string; options: string[]; optionDetails?: string[]; allowText: boolean };
```

`requestId` is the `id` of the OMP `extension_ui_request`. Requests do not survive a process restart: on a restart they are dropped and the Session shows a notice.

## State transitions

`SessionStatus` changes only in these ways:

| From | Event | To |
|---|---|---|
| `stopped` | user opens the Session and the agent starts and reattaches | `idle` |
| `stopped` | start fails (missing worktree, setup problem, verification mismatch) | `stopped` (with `stopReason`) |
| `idle` | `prompt` accepted with `agentInvoked: true` (or `agent_start` from a queued message) | `working` |
| `working` | an approval or question arrives | `needs-you` |
| `needs-you` | the request is answered and the turn continues | `working` |
| `working` | `session_settled` | `idle` |
| any live | process exits without Refract asking it to | `stopped` (`agent-exited`) |
| `idle` with `pendingMode` set | restart with the new mode and reattach succeeds | `idle` |

`unread` becomes true when a Session reaches `idle` after `working` while it is not the visible Session or the window is not focused. It clears when the user opens that Session.

## Reattach verification (FR-013, FR-024)

After starting an agent, binding it with `switch_session` to the saved Conversation, and reading `get_state`:

1. `sessionFile` must equal `Session.currentConversation` (case-insensitive path compare).
2. `messageCount` must be `> 0`, and must be `>= Session.lastMessageCount` when that is not null. It may be higher: OMP appends messages (advisor, hooks, background notices) outside the turn and `session_settled` flow Refract counts, so exact equality would fail a healthy Session after a Stop or Recover. A lower count means a truncated or different file and fails.
3. If either fails, the Session becomes `stopped` with a notice saying which check failed. The empty session OMP created is left unused and no message can be sent until the user chooses recover or another Conversation.
