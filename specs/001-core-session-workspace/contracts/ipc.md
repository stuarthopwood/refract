# Contract: renderer to main (typed IPC)

The renderer never touches processes, the file system, or git (constitution V). It calls the `window.refract` API that the preload exposes with `contextBridge`. Types live in one shared file, `src/shared/ipc.ts`, imported by main, preload, and renderer. There are two shapes: **requests** (renderer calls, main answers, via `ipcRenderer.invoke`) and **events** (main pushes, renderer subscribes). The preload passes only the named channels below and validates nothing else through.

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

`omp` is ok only when `omp --version` matches `18.4.x` or `18.5.x`. `ompSignedIn` is ok when `get_state`'s current `model` (provider + id) also appears in `get_available_models` (`docs/spike/signed-in-probe.mjs`, FINDINGS item 15, 2026-09-30): that checks the default model can actually run, not merely that some credential is authenticated. `get_login_providers` is used only to build the failure hint, never as the primary check. On failure, `hint` is `"Run omp, complete /login, then Re-check."`, optionally followed by `" Not signed in: <provider ids>."` when `get_login_providers` names unauthenticated providers.

### Repositories (FR-001)

| Method | Returns | Errors |
|---|---|---|
| `repositories.list()` | `Repository[]` | |
| `repositories.add(path)` | `Repository` | `not-a-repo`, `no-commits`, `duplicate` |
| `repositories.remove(id)` | `void` | `session-running` |
| `repositories.branches(id)` | `BranchEntry[]`, where `BranchEntry` is `{ name: string; kind: 'default' \| 'branch' \| 'session'; sessionName?: string; archived?: boolean }`: the default branch first (when it still exists), then other branches in git order, then branches owned by a Session of this repository sorted by display name, with that Session's live `name` as `sessionName` and `archived: true` when it is archived. `name` is the value `sessions.create` takes as `baseBranch`. | `git-failed` |
| `repositories.pickFolder()` | `string \| null` | Opens a native folder-picker dialog on the main window (`properties: ['openDirectory']`); `null` when the user cancels. Added to support the renderer's Browse button. |
| `repositories.userName(id)` | `string` | T072, FR-045: `git config user.name` in the repository's own checkout, falling back to the Windows account name when git has none configured; cached per repository id for the process lifetime. Used by the answered-question row's avatar/name. Error `not-found`. |

### Sessions (FR-002 to FR-006, FR-013, FR-028, FR-029, FR-035)

| Method | Returns | Notes |
|---|---|---|
| `sessions.list()` | `SessionSummary[]` | Non-archived and archived; carries `status`, `stopReason?` (detects a missing worktree at list time, T043), `unread`, `pendingMode`, `lastModel?`, `lastThinkingLevel?` (T062: the Session's last known provider/model/thinking level, straight through from the registry's `Session`; absent until `get_state` has reported one at least once). |
| `sessions.create({ repositoryId, baseBranch })` | `Session` | Generates the name, runs `git worktree add -b <name> <path> <baseBranch>`. Never leaves a half-created Session: on any failure the worktree and branch it created are removed. Errors: `worktree-failed`, `base-missing`, `path-too-long`. The generated `name` is independent of `branch`/`worktreePath` from creation onward (data-model.md): nothing else is derived from it. |
| `sessions.rename(id, name)` | `void` | Label only -- writes `Session.name`, never `branch` or `worktreePath`, and emits `session:list-changed` so every surface showing the name (list, chat header, branch picker, details card, delete confirmation, the next notification) picks it up immediately. |
| `sessions.open(id)` | `SessionSnapshot` | Starts and reattaches the agent if it is not running (or returns the stopped reason). `SessionSnapshot = { runtime: SessionRuntimeView; conversations: ConversationInfo[] }`. Also emits `session:list-changed` once a start actually ran (T062): `agent.start()` writes `lastModel`/`lastThinkingLevel` (among other fields) to the registry before this resolves, so the renderer's cached `sessions.list()` row is stale otherwise. |
| `sessions.archive(id)` / `sessions.restore(id)` | `void` | Stops the agent first if it runs. |
| `sessions.deleteCheck(id)` | `{ uncommittedFiles: number; unpushedCommits: number; hasUpstream: boolean }` | Feeds the confirmation text. |
| `sessions.delete(id, { confirmed: true })` | `void` | Removes worktree, branch (only if unmerged work was confirmed), the Session entry, and Conversation files. Refused without `confirmed: true`. |
| `sessions.recreateWorktree(id)` | `void` | Only when the branch still exists; runs `git worktree add <path> <branch>` (no `-b`, attaches the existing branch). Error `branch-missing`. |
| `sessions.recover(id)` | `SessionSnapshot` | Restart and reattach after `agent-exited`. |
| `sessions.stopAgent(sessionId)` | `void` | Stops the process, leaves the Session listed as `stopped`/`not-started`, keeps its Conversation; reopening reattaches it (FR-038). |
| `sessions.setVisible(sessionId \| null)` | `void` | Selects which Session's `transcript:patch` events are forwarded (FR-026); `sessions.open` calls this too. Also clears that Session's `unread` and flushes a full transcript snapshot (`transcript:patch` `reset`). `null` when no Session is shown. |
| `sessions.diffStat(id)` | `{ files: number; additions: number; deletions: number; partial: boolean } \| null` | Read-only (T068, FR-039, FR-044): `git diff-index --no-ext-diff --no-textconv --numstat <merge-base of HEAD and baseBranch>` (plumbing -- never refreshes/writes the index, unlike porcelain `git diff`) for tracked edits plus `git ls-files -z --others --exclude-standard` (NUL-delimited, so non-ASCII/special-character and leading/trailing-space paths survive intact) for new untracked files (read in main to count their lines as additions); capped at 200 files and 1 MiB per file (`partial: true` past either cap; a binary file counts as one file with 0 lines), 3 s overall timeout. `null` when the worktree is missing, the Base branch no longer exists, or git fails. |
| `sessions.revealWorktree(id)` | `void` | Opens the Session's worktree in Windows Explorer (`shell.openPath`) after an `fs.stat` check confirming it is still a directory; looks the worktree up by Session id in the registry, never a path from the renderer (constitution V). Error `worktree-missing` when the folder is gone (or no longer a directory); `worktree-failed` when `shell.openPath` itself fails -- this reuses the `GitErrorCode` of the same name from `sessions.create`'s `git worktree add`/`remove` failures (a distinct, unrelated failure mode sharing the string only because both ultimately surface through `IpcErrorCode`). |

### Clipboard

| Method | Returns | Notes |
|---|---|---|
| `clipboard.writeText(text)` | `void` | Fallback for the session details card's Copy path button (T069): writes through main's own `electron.clipboard` when the sandboxed renderer's `navigator.clipboard.writeText` is refused. Error `clipboard-failed`. |

### Conversations (FR-013, FR-014)

| Method | Returns |
|---|---|
| `conversations.list(sessionId)` | `ConversationInfo[]` (`file`, `createdAt`, `title`, `preview`, `isCurrent`) |
| `conversations.startNew(sessionId)` | `SessionSnapshot` (Session must be idle or stopped without a live process; error `not-idle`) |
| `conversations.open(sessionId, file)` | `SessionSnapshot` (Session must be idle or stopped without a live process; error `not-idle`, or `reattach-failed`) |

For a `stopped` Session, both start a fresh reattach against the chosen Conversation (issue #69); the returned snapshot is that attempt's result, which may itself still be `stopped` (with its own notice, e.g. a missing worktree or a failed reattach) rather than `idle` -- this is not reported as an IPC error. `not-idle` instead means the Session was not actually `stopped`: a start was already in flight, or a live process exists (including one left over from a start that raced this call) -- the chosen Conversation was never attempted in that case.

### Chat (FR-007 to FR-012, FR-017 to FR-019, FR-032, FR-033)

| Method | Returns | Notes |
|---|---|---|
| `chat.send(sessionId, text)` | `{ queued: boolean }` | `queued: true` when the Session was working. Text starting `/` is validated against the Session's command list (T093: OMP's raw list filtered to `src/shared/slash-commands.ts`'s fixed supported set, plus Refract's built native commands); a name not on that list, or a Refract-native command that isn't built yet, gives `unknown-command` (FR-033); a listed command given a subcommand or argument text never verified for it gives `unsupported-arguments` instead (issue #129) -- FR-033's "unknown" is reserved for a command hidden entirely under FR-032, not a listed one given bad arguments. |
| `chat.stop(sessionId)` | `void` | |
| `chat.removeQueued(sessionId, text)` | `{ removed: boolean }` | |
| `chat.sendNow(sessionId, text)` | `{ steered: boolean }` | |
| `chat.answer(sessionId, requestId, answer)` | `void` | `answer = { approve: boolean } | { value: string } | { confirmed: boolean } | { cancelled: true }`. |
| `chat.commands(sessionId)` | `SlashCommand[]` | Latest filtered list (T093); also pushed as an event. Includes `/new`, the one native command Refract has actually built; `/plan`, `/fork`, `/settings`, `/pause`, `/plan-review`, `/btw`, and `/resume` stay unlisted until built (FR-032). |
| `chat.predictWord(sessionId, text, cursor)` | `string \| null` | Ghost-text composer completion (T103, FR-058; rpc.md "Word prediction"). `text` is the whole draft, `cursor` a UTF-16 offset. Proxies to `predict_word` ONLY on an already-running live `OmpProcess` -- never starts one -- resolving `null` whenever there is no live process, the server's own gating yields nothing, or the RPC call fails or times out; never rejects, so a `predict_word` failure is never a chat error. |
| `chat.predictWordFeedback(sessionId, text, cursor, suggestion, accepted)` | `void` | Companion to `chat.predictWord`: send once per shown suggestion, `accepted: true` when Tab took it, `false` when Esc or an edit dismissed it. Same silent-degradation contract -- a no-op with no live process, never rejects. |

A chat error surfaces as `prompt-failed` (a failed prompt, abort, or queue command) or `agent-not-running` (no live process); a chat error is never reported as `reattach-failed` (that code is `conversations.open`-only, see above). `chat.predictWord`/`chat.predictWordFeedback` are a partial exception: they never report `agent-not-running` specifically, since a missing/not-yet-started live `OmpProcess` is itself just a `null`/no-op result, not a failure -- but a malformed argument or an unknown `sessionId` still returns its normal `invalid-argument`/`not-found` code first, before ever reaching the agent, same as every other `chat.*` method.

### Settings (FR-015, FR-020)

| Method | Returns |
|---|---|
| `settings.get()` | `Settings` |
| `settings.setApprovalMode(mode)` | `Settings`. Sets `pendingMode` on every live Session whose mode differs; the restart happens at each Session's next settle. |

### Window (spec 001 T100, FR-057)

| Method | Returns | Notes |
|---|---|---|
| `window.popupMenu(menuId, x, y)` | `void` | Pops open one of the in-app `AppMenuBar`'s real submenus (`'file' \| 'edit' \| 'view' \| 'window'`) at `x`/`y`, the clicked button's own `getBoundingClientRect()` CSS-pixel coordinates; main multiplies by `webContents.getZoomFactor()` before calling `Menu.popup`. Error `invalid-argument` (bad `menuId`, or non-finite `x`/`y`), `not-found` (no window, or `menuId` has no submenu). |

There is no `window.toggleMaximize`: verified live (tasks.md T100) that double-clicking a `.drag-region` area already maximises/restores the window entirely at the OS level (HTCAPTION) before the double-click ever reaches the renderer's own JS, so a renderer-driven toggle IPC was unreachable dead code and was removed rather than kept.

## Events (main to renderer)

| Event | Payload | Purpose |
|---|---|---|
| `session:status` | `{ sessionId, status, stopReason?, stopDetail?, unread, launchedMode, pendingMode }` | List badges, the Approval mode pill above the message box. |
| `session:list-changed` | none | Renderer re-fetches `sessions.list()` (created, renamed, archived, deleted, reordered by activity). |
| `transcript:patch` | `{ sessionId, ops: TranscriptOp[] }` | `TranscriptOp = { op: 'upsert'; item: TranscriptItem } | { op: 'reset'; items: TranscriptItem[] }`. Coalesced to at most one per 50 ms per Session; only sent for the Session the user is viewing, plus a final flush when a Session becomes visible. |
| `queue:update` | `{ sessionId, followUp: string[]; steering: string[] }` | Queue chips. |
| `request:pending` / `request:resolved` | `{ sessionId, request }` / `{ sessionId, requestId }` | Approval and question cards. |
| `commands:update` | `{ sessionId, commands: SlashCommand[] }` | Slash-command menu; already filtered to the T093 supported set. |
| `settings:changed` | `Settings` | Status bar switch. |
| `ui:open-session` | `{ sessionId }` | Emitted when the user clicks a Windows notification. |
| `memory:warning` | `{ low: boolean; freeBytes: number; liveAgents: number }` | Status bar low-memory notice; never stops an agent automatically (FR-037). |

Streaming is off the renderer's critical path: main normalises OMP frames into `TranscriptItem`s (data-model.md) and keeps the full transcript per Session; the renderer receives patches for the visible Session and asks for a full snapshot via `sessions.open` when it switches. A renderer reload therefore loses nothing.

## Windows notifications (FR-027)

Main sends a notification when a Session becomes `needs-you` or finishes (`working` to `idle`) and no Refract window is focused. Clicking it focuses the window and emits `ui:open-session`. Nothing else notifies. Dev mode calls `app.setAppUserModelId(process.execPath)` first, or notifications may not show.
