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
| `repositories.list()` | `Repository[]` | Issue #528, gate round 3 fix: every entry's `remote` carries the `{ kind: 'unknown' }` placeholder -- the real value arrives separately via `repositories.remotes()`, which the renderer calls right after and merges in once it resolves. |
| `repositories.add(path)` | `Repository` | `not-a-repo`, `no-commits`, `duplicate` |
| `repositories.remove(id)` | `void` | `has-sessions` |
| `repositories.rename(id, name)` | `Repository` | Issue #480: display-name-only edit, mirroring `sessions.rename`'s rule -- never touches `path`, `defaultBranch`, or anything a Session points at; two repositories may share a display name (the header tooltip and details card show the path to tell them apart). The server trims, then validates (not empty after trimming is NOT required -- see below), a maximum of 60 Unicode code points, and no control/bidi/format characters (`\p{Cc}`, `\p{Cf}`, U+2028/U+202...
| `repositories.remotes()` | `Record<string, RepositoryRemote>` keyed by repository id, where `RepositoryRemote` is `{ kind: 'none' } \| { kind: 'has'; host: string } \| { kind: 'unknown' }` | Issue #528: the Session list's group-header icon's remote-vs-local-only state, computed fresh (never persisted to `registry.json`) by a bounded pool of `git config --local --includes --list -z` spawns (one per repository, 3s per-call timeout, concurrency capped at 8, an overall deadline so a hung repository cannot delay every other one indefinitely). A repository whose own check does not settle before that deadline is left OUT of the returned record entirely -- absence means "not resolved this round", never "confirmed unknown" -- so the caller MUST leave its own existing value (if any) untouched for an absent id, never overwrite it. Called once at startup (after `repositories.list()`, which itself never waits on this) and again on window focus/visibility, throttled client-side to once per 5s. |
| `repositories.branches(id)` | `BranchEntry[]`, where `BranchEntry` is `{ name: string; kind: 'default' \| 'branch' \| 'session'; sessionName?: string; archived?: boolean }`: the default branch first (when it still exists), then other branches in git order, then branches owned by a Session of this repository sorted by display name, with that Session's live `name` as `sessionName` and `archived: true` when it is archived. `name` is the value `sessions.create` takes as `baseBranch`. | `git-failed` |
| `repositories.pickFolder()` | `string \| null` | Opens a native folder-picker dialog on the main window (`properties: ['openDirectory']`); `null` when the user cancels. Added to support the renderer's Browse button. |
| `repositories.userName(id)` | `string` | T072, FR-045: `git config user.name` in the repository's own checkout, falling back to the Windows account name when git has none configured; cached per repository id for the process lifetime. Used by the answered-question row's avatar/name. Error `not-found`. |

Removal is refused with `has-sessions` while the Repository still owns any Session, active or archived, no matter whether its agent is currently running (FR-059, Clarifications 2026-10-06), replacing the earlier `session-running` code: the refusal condition changed from "a Session is currently running" to "any Session still exists", and `session-running` had exactly one caller (this method) to update. `RegistryStore.removeRepository` refuses for the same reason as a backstop, so the renderer's own pre-check -- which `RemoveRepositoryDialog` already uses to decide which of its two states to show -- is never the only thing stopping an orphaned Session record.

### Sessions (FR-002 to FR-006, FR-013, FR-028, FR-029, FR-035)

| Method | Returns | Notes |
|---|---|---|
| `sessions.list()` | `SessionSummary[]` | Non-archived and archived; carries `status`, `stopReason?` (detects a missing worktree at list time, T043), `terminatedUnexpectedly?` (issue #510: a `stopped`, non-archived Session's Conversation tail shows the writing process went away mid-turn -- a trailing `session_exit` whose `reason` is not `dispose`, or an unmatched tool call; read fresh per call, cached by `(file, size, mtimeMs)`), `unread`, `pendingMode`, `lastModel?`, `lastThinkingLevel?` (T062: the Session's last known provider/model/thinking level, straight through from the registry's `Session`; absent until `get_state` has reported one at least once). |
| `sessions.create({ repositoryId, baseBranch })` | `Session` | Generates the name, runs `git worktree add -b <name> <path> <baseBranch>`. Never leaves a half-created Session: on any failure the worktree and branch it created are removed. Errors: `worktree-failed`, `base-missing`, `path-too-long`. The generated `name` is independent of `branch`/`worktreePath` from creation onward (data-model.md): nothing else is derived from it. |
| `sessions.rename(id, name)` | `void` | Label only -- writes `Session.name`, never `branch` or `worktreePath`, and emits `session:list-changed` so every surface showing the name (list, chat header, branch picker, details card, delete confirmation, the next notification) picks it up immediately. |
| `sessions.open(id, userAction?)` | `SessionSnapshot` | Starts and reattaches the agent only when `canAutoStart(stopReason, terminatedUnexpectedly)` allows it -- an allow-list (never `undefined`/`not-started`/`worktree-missing` with no mid-turn tail signal) that fails closed for any `stopReason` it does not explicitly recognize -- or returns the stopped reason. `userAction: true` (issue #509) bypasses that check exactly like `recover`/`restore` already do, for the one genuine explicit user request through this path: MessageInput's typed-send to a not-yet-started Session. `SessionSnapshot = { runtime: SessionRuntimeView; conversations: ConversationInfo[] }`. Also emits `session:list-changed` once a start actually ran (T062): `agent.start()` writes `lastModel`/`lastThinkingLevel` (among other fields) to the registry before this resolves, so the renderer's cached `sessions.list()` row is stale otherwise. |
| `sessions.archive(id)` / `sessions.restore(id)` | `void` | Stops the agent first if it runs. |
| `sessions.deleteCheck(id)` | `{ uncommittedFiles: number; unpushedCommits: number; hasUpstream: boolean }` | Feeds the confirmation text. |
| `sessions.delete(id, { confirmed: true })` | `void` | Removes worktree, branch (only if unmerged work was confirmed), the Session entry, and Conversation files. Refused without `confirmed: true`. |
| `sessions.recreateWorktree(id)` | `void` | Only when the branch still exists; runs `git worktree add <path> <branch>` (no `-b`, attaches the existing branch). Error `branch-missing`. |
| `sessions.recover(id)` | `SessionSnapshot` | Restart and reattach after `agent-exited`. |
| `sessions.resume(id)` | `SessionSnapshot` | Issue #509 (PLAN.md row A2g): the one resume path, used by both the session-list row's Resume button and the ChatPane stop banner's Resume button -- restarts the agent (if `canResumeSession` allows it, re-checked here against a fresh tail read rather than trusting the renderer's own `SessionSummary`) and then sends `DEFAULT_RESUME_INSTRUCTION` as a real turn, atomically and server-side-locked per Session id (`resumingIds`): a second concurrent call for the same id (two rapid clicks, or one from each UI entry point) is refused with `invalid-argument` rather than sending the instruction twice. Error `invalid-argument` when the Session is not stopped, not eligible to resume, or already resuming; `prompt-failed` when the restart itself succeeds but the resume instruction's `agent.send` rejects (the snapshot it returns still reflects the now-running agent). |
| `sessions.stopAgent(sessionId)` | `void` | Stops the process, leaves the Session listed as `stopped`/`not-started`, keeps its Conversation; reopening reattaches it (FR-038). A stop request arriving mid-start (`startingProcess` still in flight) still ends here -- `not-started`, never `start-failed` -- regardless of which phase (queued, memory-deferred, or the ready wait itself) the start was in. |
| `sessions.keepWaitingForStart(sessionId)` | `void` | Issue #512 requirement 1: dismisses the ready-wait's `'prompt'` stage (the "Keep waiting"/"Cancel" offer at 60 s) without affecting the wait itself, which was already continuing toward the 180 s ceiling regardless. A no-op (not an error) for a known Session not currently in that stage -- a stale button click racing the wait's own resolution must never surface an error toast. Unknown `sessionId` still `not-found`. |
| `sessions.cancelStart(sessionId)` | `void` | Issue #512 requirement 1: cancels an in-flight start at any phase (queued, memory-deferred, or the ready wait), ending the Session `stopped`/`start-failed` once the process that was starting is confirmed stopped. Same no-op-for-a-not-starting-Session rule as `keepWaitingForStart` above. |
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
| `chat.removeQueued(sessionId, text, queue)` | `{ removed: boolean }` | `queue: 'followUp' \| 'steering'` (issue #540): the chip's own real queue -- OMP's `remove_queued_message` only matches within the exact queue given, so a hard-coded `'followUp'` would always report `removed: false` for a steering chip. |
| `chat.sendNow(sessionId, text)` | `{ promoted: boolean }` | Issue #540: atomic `promote_queued_message` (moves the queued follow-up, attachments included, to the end of the steering queue; no reprocessing, no duplicate), replacing the old hand-made remove-then-steer `{ steered: boolean }`. Offered only for a follow-up chip, since `promote_queued_message` only ever matches a queued follow-up. `promoted: false` means it was no longer pending at dispatch time (e.g. already delivered); the caller still shows a notice rather than doing nothing. |
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

### Model (lane RM, issues #454/#740/#741/#762/#766/#760/#564)

Per-Session model/role/reasoning actions over the live RPC connection (never OMP's persisted
`modelRoles` config, which `settings.*`/`RefractApi.modelRoles` own instead); not part of this
spec's own acceptance criteria (added by lane RM after spec 001 shipped), documented here so the
channel list stays complete. Full reasoning lives in `src/shared/ipc-model.ts`'s own doc comments.

| Method | Returns | Notes |
|---|---|---|
| `model.setModel(sessionId, provider, modelId)` | `{ model: Model }` | The composer's model picker (#454). Session-scoped only (never writes `modelRoles`); pins the Session and clears any tracked role. |
| `model.cycleModel(sessionId)` | `{ model: Model }` | Steps through catalog models (FINDINGS item 54: never `cycleOrder`'s roles); same pinning as `setModel`. |
| `model.applyRole(sessionId, role)` | `{ model: Model; role: string }` | `/role`, Ctrl+R and a role chip click (#766); forwards OMP's native `/switch @<role>`. Un-pins the Session. |
| `model.listRoles(sessionId)` | `{ roles: Array<{ role, model, current }>; currentRole; pinned }` | The Ctrl+R selector's own listing (#766): `cycleOrder` plus `"plan"`. |
| `model.setThinkingLevel(sessionId, level)` | `{ thinkingLevel: string }` | The composer's Reasoning picker (#564). Forwards OMP's `set_thinking_level` RPC; never touches model pinning or the tracked role. `level` is OMP's own `"inherit" \| "off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"`. |

Every call above refuses with `not-idle` while the Session is working (FINDINGS "RM0 probe" item
57: mid-turn `set_model` is not provably safe) and `agent-not-running` for a Session with no live
process. Optional on `RefractApi`: `src/main`/`src/preload` (Electron, frozen) never port this
family -- the Rust build (`src-tauri/`) is the only implementation.

### Window (spec 001 T100, FR-057)

| Method | Returns | Notes |
|---|---|---|
| `window.popupMenu(menuId, x, y)` | `void` | Pops open one of the in-app `AppMenuBar`'s real submenus (`'file' \| 'edit' \| 'view' \| 'window'`) at `x`/`y`, the clicked button's own `getBoundingClientRect()` CSS-pixel coordinates; main multiplies by `webContents.getZoomFactor()` before calling `Menu.popup`. Error `invalid-argument` (bad `menuId`, or non-finite `x`/`y`), `not-found` (no window, or `menuId` has no submenu). |

There is no `window.toggleMaximize`: verified live (tasks.md T100) that double-clicking a `.drag-region` area already maximises/restores the window entirely at the OS level (HTCAPTION) before the double-click ever reaches the renderer's own JS, so a renderer-driven toggle IPC was unreachable dead code and was removed rather than kept.

## Events (main to renderer)

| Event | Payload | Purpose |
|---|---|---|
| `session:status` | `{ sessionId, status, stopReason?, stopDetail?, terminatedUnexpectedly?, startProgress?, unread, launchedMode, pendingMode }` | List badges, the Approval mode pill inside the message box's own bottom row (2026-10-15, issue #564; previously above it). `terminatedUnexpectedly` (issue #510) is set only on a live transition to `stopped`; quality-gate fix (cycle 3): `undefined` on a `stopped` transition (for example a re-emit with no new value, such as `clearUnread`) means the renderer keeps whatever it already showed; a transition to a LIVE status resets it to `false`. `startProgress` (issue #512 requirement 1) mirrors the staged ready-wait live while a `start()`/`restart()` is in flight -- `{ kind: 'queued' }`, `{ kind: 'memory-deferred'; elapsedMs }`, or `{ kind: 'waiting' \| 'prompt' \| 'extended'; elapsedMs }` -- and is absent once it settles, success or failure either way; never a persisted Session state, only a transient overlay on top of `status`/`stopReason`. |
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
