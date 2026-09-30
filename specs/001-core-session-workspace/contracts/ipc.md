# Contract: renderer to main (typed IPC)

The renderer never touches processes, the file system, or git (constitution V). It calls the `window.pinion` API that the preload exposes with `contextBridge`. Types live in one shared file, `src/shared/ipc.ts`, imported by main, preload, and renderer. There are two shapes: **requests** (renderer calls, main answers, via `ipcRenderer.invoke`) and **events** (main pushes, renderer subscribes). The preload passes only the named channels below and validates nothing else through.

Every request returns `Result<T>`:

```ts
type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
```

Errors are shown to the user; codes are stable so the renderer can branch on them.

## Requests

### Readiness (FR-036)

| Method | Returns |
|---|---|
| `readiness.check()` | `{ git: Check; omp: Check; ompSignedIn: Check }`, `Check = { ok: boolean; found?: string; hint?: string }` |

`omp` is ok only when `omp --version` is exactly `18.4.4`. `ompSignedIn` is ok when a probe process started with the user's default profile reaches `ready` and `get_login_providers` returns at least one entry with `authenticated: true` (`docs/spike/signed-in-probe.mjs`, FINDINGS item 14, 2026-09-30). `get_state.model` being present is NOT diagnostic: a process with zero credentials still resolves and reports a `model`. `get_available_models` returning a non-empty list is a corroborating signal only (it already filters to authenticated, non-disabled providers), never the primary check, because it is additionally scoped by the `enabledModels` config pattern and can read `0` for reasons other than sign-in. On failure, `hint` is: "Sign in to OMP: run `omp` once and complete `/login`, then relaunch Pinion."

### Repositories (FR-001)

| Method | Returns | Errors |
|---|---|---|
| `repositories.list()` | `Repository[]` | |
| `repositories.add(path)` | `Repository` | `not-a-repo`, `no-commits`, `duplicate` |
| `repositories.remove(id)` | `void` | `session-running` |
| `repositories.branches(id)` | `{ branches: string[]; default: string }` | `git-failed` |
| `repositories.pickFolder()` | `string \| null` | Opens a native folder-picker dialog on the main window (`properties: ['openDirectory']`); `null` when the user cancels. Added to support the renderer's Browse button. |

### Sessions (FR-002 to FR-006, FR-013, FR-028, FR-029, FR-035)

| Method | Returns | Notes |
|---|---|---|
| `sessions.list()` | `SessionSummary[]` | Non-archived and archived; carries `status`, `stopReason?` (detects a missing worktree at list time, T043), `unread`, `pendingMode`. |
| `sessions.create({ repositoryId, baseBranch })` | `Session` | Generates the name, runs `git worktree add -b <name> <path> <baseBranch>`. Never leaves a half-created Session: on any failure the worktree and branch it created are removed. Errors: `worktree-failed`, `base-missing`, `path-too-long`. |
| `sessions.rename(id, name)` | `void` | Label only. |
| `sessions.open(id)` | `SessionSnapshot` | Starts and reattaches the agent if it is not running (or returns the stopped reason). `SessionSnapshot = { runtime: SessionRuntimeView; conversations: ConversationInfo[] }`. |
| `sessions.archive(id)` / `sessions.restore(id)` | `void` | Stops the agent first if it runs. |
| `sessions.deleteCheck(id)` | `{ uncommittedFiles: number; unpushedCommits: number; hasUpstream: boolean }` | Feeds the confirmation text. |
| `sessions.delete(id, { confirmed: true })` | `void` | Removes worktree, branch (only if unmerged work was confirmed), the Session entry, and Conversation files. Refused without `confirmed: true`. |
| `sessions.recreateWorktree(id)` | `void` | Only when the branch still exists; runs `git worktree add <path> <branch>` (no `-b`, attaches the existing branch). Error `branch-missing`. |
| `sessions.recover(id)` | `SessionSnapshot` | Restart and reattach after `agent-exited`. |
| `sessions.stopAgent(sessionId)` | `void` | Stops the process, leaves the Session listed as `stopped`/`not-started`, keeps its Conversation; reopening reattaches it (FR-038). |
| `sessions.setVisible(sessionId \| null)` | `void` | Selects which Session's `transcript:patch` events are forwarded (FR-026); `sessions.open` calls this too. Also clears that Session's `unread` and flushes a full transcript snapshot (`transcript:patch` `reset`). `null` when no Session is shown. |

### Conversations (FR-013, FR-014)

| Method | Returns |
|---|---|
| `conversations.list(sessionId)` | `ConversationInfo[]` (`file`, `createdAt`, `title`, `preview`, `isCurrent`) |
| `conversations.startNew(sessionId)` | `SessionSnapshot` (Session must be idle; error `not-idle`) |
| `conversations.open(sessionId, file)` | `SessionSnapshot` (Session must be idle; error `not-idle`, or `reattach-failed`) |

### Chat (FR-007 to FR-012, FR-017 to FR-019, FR-032, FR-033)

| Method | Returns | Notes |
|---|---|---|
| `chat.send(sessionId, text)` | `{ queued: boolean }` | `queued: true` when the Session was working. Text starting `/` is validated against the Session's command list; unknown gives error `unknown-command`. |
| `chat.stop(sessionId)` | `void` | |
| `chat.removeQueued(sessionId, text)` | `{ removed: boolean }` | |
| `chat.sendNow(sessionId, text)` | `{ steered: boolean }` | |
| `chat.answer(sessionId, requestId, answer)` | `void` | `answer = { approve: boolean } | { value: string } | { confirmed: boolean } | { cancelled: true }`. |
| `chat.commands(sessionId)` | `SlashCommand[]` | Latest list; also pushed as an event. |

### Settings (FR-015, FR-020)

| Method | Returns |
|---|---|
| `settings.get()` | `Settings` |
| `settings.setApprovalMode(mode)` | `Settings`. Sets `pendingMode` on every live Session whose mode differs; the restart happens at each Session's next settle. |

## Events (main to renderer)

| Event | Payload | Purpose |
|---|---|---|
| `session:status` | `{ sessionId, status, stopReason?, stopDetail?, unread, pendingMode }` | List badges, chat header chip. |
| `session:list-changed` | none | Renderer re-fetches `sessions.list()` (created, renamed, archived, deleted, reordered by activity). |
| `transcript:patch` | `{ sessionId, ops: TranscriptOp[] }` | `TranscriptOp = { op: 'upsert'; item: TranscriptItem } | { op: 'reset'; items: TranscriptItem[] }`. Coalesced to at most one per 50 ms per Session; only sent for the Session the user is viewing, plus a final flush when a Session becomes visible. |
| `queue:update` | `{ sessionId, followUp: string[]; steering: string[] }` | Queue chips. |
| `request:pending` / `request:resolved` | `{ sessionId, request }` / `{ sessionId, requestId }` | Approval and question cards. |
| `commands:update` | `{ sessionId, commands: SlashCommand[] }` | Slash-command menu. |
| `settings:changed` | `Settings` | Status bar switch. |
| `ui:open-session` | `{ sessionId }` | Emitted when the user clicks a Windows notification. |
| `memory:warning` | `{ low: boolean; freeBytes: number; liveAgents: number }` | Status bar low-memory notice; never stops an agent automatically (FR-037). |

Streaming is off the renderer's critical path: main normalises OMP frames into `TranscriptItem`s (data-model.md) and keeps the full transcript per Session; the renderer receives patches for the visible Session and asks for a full snapshot via `sessions.open` when it switches. A renderer reload therefore loses nothing.

## Windows notifications (FR-027)

Main sends a notification when a Session becomes `needs-you` or finishes (`working` to `idle`) and no Pinion window is focused. Clicking it focuses the window and emits `ui:open-session`. Nothing else notifies. Dev mode calls `app.setAppUserModelId(process.execPath)` first, or notifications may not show.
