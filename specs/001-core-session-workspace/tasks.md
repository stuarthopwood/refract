# Tasks: Core session workspace

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Prerequisites**: OMP 18.4.x or 18.5.x signed in; Git for Windows; Node 24+; `pnpm`. Windows 11 only.

**Tests**: none. Refract is a prototype (constitution, Development Workflow). Each phase ends with a **Checkpoint** that runs the matching [quickstart.md](quickstart.md) section by hand. `pnpm typecheck` and `pnpm build` MUST pass before a change lands on `main`.

**Organization**: tasks are grouped by user story so each story can be built and checked on its own. Paths are relative to the repository root.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task).
- **[Story]**: the user story from [spec.md](spec.md) (US1 to US7). Setup, Foundational, and Polish tasks carry no story label.
- Tasks that edit the same file are never both marked [P].

---

## Phase 1: Setup and gates

**Purpose**: create the project and settle the four facts the constitution (Principle IV) says must be verified before the work that depends on them.

- [X] T001 Scaffold an `electron-vite@5.0.0` project at the repository root: `package.json` (`pnpm`, scripts `dev`, `build`, `typecheck`), `electron.vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json` (all `strict: true`), `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/main.tsx`, and the folder layout in plan.md "Source code". `.gitignore` already covers `node_modules/`, `out/`, and `dist/`.
- [X] T002 Install dependencies at the versions in plan.md: `electron@44.5.1`, `react@19.3.0`, `react-dom`, `zustand@5.0.15`, `react-markdown@10.1.0`, `rehype-sanitize@6.0.0`, `shiki@4.4.3`, `react-diff-view@3.3.3`, `react-virtuoso@4.18.16`, `react-resizable-panels@4.14.1`, `tailwindcss@4.3.3` (with its Vite plugin), `koffi`, and the TypeScript and React type packages. Then run `pnpm dlx shadcn@4.21.0 init` for a Tailwind v4 project and fit it to the electron-vite renderer: in `components.json` set `rsc: false`, `tailwind.css` to `src/renderer/styles/globals.css`, and the `@/components`, `@/lib` aliases to `src/renderer/...`, with matching `paths` in `tsconfig.web.json` and `resolve.alias` in the renderer section of `electron.vite.config.ts`; choose the primitive base deliberately (the docs example uses `base-nova`, which is Base UI; the alternative is Radix) and record the choice. Add the components the later tasks name: `button`, `badge`, `card`, `alert`, `alert-dialog`, `dialog`, `select`, `textarea`, `input`, `tooltip`, `kbd`, `toggle-group`, `collapsible`, `sidebar`, `resizable`, `scroll-area`, `separator`, `sonner`, `skeleton`, `empty`, `message`, `message-scroller`. Record the installed `koffi` and `shadcn` versions and the shadcn style in plan.md Technical Context.
- [X] T003 Gate: make `BrowserWindow` load with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` and a preload that exposes one test function through `contextBridge`; confirm the renderer calls it under `pnpm dev` and after `pnpm build`. If electron-vite's preload output does not run sandboxed, switch to its isolated build mode. Record the result in research.md decision 1 (depends on T001, T002).
- [X] T004 Gate: confirm self-join works in the real app, not only in a bare Electron test (`docs/spike/job-object-probe.mjs` already proved `koffi` plus self-join inside Electron 44.5.1's main process): in the electron-vite app, create the kill-on-close job, assign the main process to it, spawn `ping -n 120 127.0.0.1`, force-kill the app, and confirm the child dies. Also check the side effect that everything Refract launches joins the job: with all browsers closed, call `shell.openExternal('https://example.com')` from inside the job, then force-quit the app; if the browser dies with it, set `JOB_OBJECT_LIMIT_BREAKAWAY_OK` on the job and open URLs through a launch that uses `CREATE_BREAKAWAY_FROM_JOB` or hand off via `explorer.exe <url>` (the `omp` tree guarantee still holds because `omp` does not request breakaway [INFERENCE]). Record both results in FINDINGS item 12 (depends on T002). Status 2026-09-30: self-join verified in the real app; the `openExternal` side-effect check was NOT run because browsers were open; it ran 2026-10-02 under issue #68 (FINDINGS item 12). The self-join half is verified (FINDINGS items 12, 16, 18).
- [X] T005 [P] Gate: probe the "OMP signed in" signal in `docs/spike/signed-in-probe.mjs` (reuse the frame driver from `docs/spike/resume-probe.mjs`): start `omp --mode rpc-ui`, wait for `ready`, call `get_available_models`, and record what a signed-in machine returns. If an unsigned state cannot be produced safely, say so; then choose the readiness rule (research.md "Unknowns") and record it in `contracts/ipc.md` under `readiness.check`.
- [X] T006 [P] Gate: record the shape of an `edit` tool result in `docs/spike/edit-diff-probe.mjs`: run a tiny turn in a scratch git repo that asks the agent to edit a file (`--approval-mode=yolo`), capture the `tool_execution_end` frame, and record whether `result.details` carries a diff. Record the outcome and the chosen diff source in `contracts/omp-usage.md` ("Tool row fields").

**Checkpoint**: `pnpm dev` opens a window; T003 to T006 each have their result written into the design docs.

---

## Phase 2: Foundational (blocks every user story)

**Purpose**: the core that every story uses: shared types, stores, git helpers, the OMP process wrapper with its frame decoder and Job Object, the transcript builder, and the per-Session controller.

- [X] T007 [P] Write `src/shared/model.ts` with `Repository`, `Session`, `Settings`, `ProcessRecord`, `SessionRuntime`, `SessionStatus`, `TranscriptItem`, `PendingRequest`, and `ConversationInfo` exactly as in data-model.md (keep the field names and the `'idle' | 'working' | 'needs-you' | 'stopped'` and `'ask' | 'edit-freely' | 'auto'` literals).
- [X] T008 [P] Write `src/shared/frames.ts` with the subset of OMP frame types Refract reads (`ready`, `response`, `agent_start`, `agent_end`, `message_start/update/end`, `tool_execution_start/end`, `queue_update`, `extension_ui_request`, `prompt_result`, `session_settled`, `available_commands_update`, `command_output`, `notice`, `rpc_chunk`) per contracts/omp-usage.md "Frames Refract consumes". Unknown frame types must type-check as `unknown`, never throw.
- [X] T009 Write `src/shared/ipc.ts` with every request and event in contracts/ipc.md, including `Result<T>` and the error codes listed there (depends on T007).
- [X] T010 [P] Write `src/main/store/atomicJson.ts` (write `<name>.json.tmp`, flush, rename over `<name>.json`; on a parse failure rename the bad file to `<name>.json.corrupt-<timestamp>` and return the default) and `src/main/store/registry.ts` + `src/main/store/settings.ts` for `registry.json` and `settings.json` in `app.getPath('userData')` (depends on T007). Enforce: `worktreePath` unique across Sessions, `branch` unique within a Repository.
- [X] T011 [P] Write `src/main/git/git.ts` (an `execFile('git', args, { cwd, windowsHide: true })` helper returning stdout, with typed errors) and `src/main/git/worktrees.ts`: `defaultBranch(repo)`, `listBranches(repo)`, `generateName()` (readable adjective-noun, checked against existing branches and folders), `addWorktree(repo, name, baseBranch)` creating `<repo>/../pinion-worktrees/<repoName>/<name>` with a new branch of the same name, `removeWorktree`, `deleteCheck(worktreePath)` (uncommitted files via `status --porcelain`, unpushed commits via `rev-list`), and `branchExists`. `addWorktree` MUST remove the worktree and branch it created if any step fails (no half-created Session) and map failures to `worktree-failed`, `base-missing`, `path-too-long`.
- [X] T012 [P] Write `src/main/process/jobObject.ts` (the only file with Windows-specific FFI): `joinKillOnCloseJob()` creates one Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` through `koffi` and assigns the current process to it via `AssignProcessToJobObject(job, GetCurrentProcess())`; it MUST run at app start before anything is spawned, and its failure MUST be logged and shown as a notice (the pid records below then become the only protection). Write `src/main/process/pidRecords.ts` for `processes.json`: `record(pid, startTime, sessionId)`, `remove(pid)`, and `reapStale()` which, at app start, stops (`taskkill /PID <pid> /T /F`) each recorded process that is still running with the same creation time and an `omp` image name, and discards every other record (depends on T004, T007, T010).
- [X] T013 Write `src/main/omp/OmpProcess.ts`: spawn `omp --mode rpc-ui --approval-mode=<mode>` with `cwd = worktreePath`, `windowsHide: true`, `stdio: 'pipe'`, no shell, no `--session-dir`, no `--model`, no `--resume` (reattach binds the Conversation with `switch_session` instead, per constitution Principle III, FINDINGS item 17); record its pid immediately (Job Object membership is inherited because the main process joined the job at start); read stdout as newline-delimited JSON (log and skip unparseable lines); negotiate protocol v2 after `ready` and reassemble `rpc_chunk` frames (validate `chunkId`, `index`, `count`, `byteLength`, strict UTF-8, reject interleaving, 64 MiB ceiling; copy the working reassembler from `docs/spike/resume-probe.mjs`); correlate responses by `id` with a per-request timeout; expose `request()`, `on('frame')`, `on('exit')`, `stop()` (clos…
- [X] T014 [P] Write `src/main/omp/transcript.ts`: `fromHistory(messages)` and `applyFrame(items, frame)` producing `TranscriptItem[]` per contracts/omp-usage.md "Message parts": `user`, `assistant-text`, `thinking` (only when the text is non-empty), `tool` (keyed by `toolCallId`; `target` is `path` for read/edit/write, `command` for bash, `pattern` for grep/glob, else the first string argument, truncated to 200 characters), `notice`. `message_update` replaces the item from the whole `message` snapshot. Hide `role: 'custom'` and `role: 'developer'` unless `display: true` (depends on T007, T008).
- [X] T015 [P] Write `src/main/omp/dialogs.ts`: classify `extension_ui_request` per contracts/omp-usage.md "Dialogs" (`select` whose title starts `Allow tool:` is an approval, options `Approve` and `Deny`, details from the following title lines; other `select` is a question; `input` and `editor` are free text; `confirm` is Yes/No; `cancel` withdraws a pending id) and build the `extension_ui_response` for each answer form. `notify` becomes a notice; `setStatus`, `setWidget`, `setTitle`, `set_editor_text`, `open_url` are ignored (depends on T007, T008).
- [X] T016 Write `src/main/omp/SessionAgent.ts` core lifecycle: `start()` (check the worktree exists, else `stopped`/`worktree-missing`; spawn; `get_state`; reattach verification per data-model.md; `get_messages`; status `idle`), `stop()`, exit handling (`stopped`/`agent-exited` with the exit code when Refract did not ask), status and patch events with coalescing to at most one patch per 50 ms per Session, and reading `get_state` after each `session_settled` to update `lastMessageCount`, `lastActivityAt`, `sessionDir`, `currentConversation` in the registry. Later stories add turn handling, dialogs, and restart in this same file (depends on T010, T013, T014, T015).
- [X] T017 Write `src/main/index.ts`: single-instance lock, `app.setAppUserModelId(process.execPath)` in development, `joinKillOnCloseJob()` first of all, then `reapStale()`, create the window with the T003 security settings, open external links in the system browser and block in-app navigation, register every `contracts/ipc.md` request with a `not-implemented` result until its story lands, and stop all agents on `before-quit` (depends on T009, T012, T016).
- [X] T018 Write `src/preload/index.ts` exposing `window.refract` with exactly the channels in contracts/ipc.md, and `src/renderer/state/` (zustand stores for repositories, sessions, the visible transcript, queue, pending requests, settings) subscribed to the events in contracts/ipc.md (depends on T009).
- [X] T019 [P] Write `src/renderer/styles/` with CSS custom properties for the colour roles (working, idle, needs-you, stopped, surface, text) in dark and light themes, and the `--font-ui` and `--font-code` variables with system defaults; wire Tailwind v4 to them (verify the dark-mode mechanism first, research.md decision 2). Write the three-region layout in `src/renderer/main.tsx` with `react-resizable-panels`: session list, chat, and a reserved, hidden right region; plus the bottom status bar (depends on T001, T002).

**Checkpoint**: the app starts, the window is sandboxed, `pnpm typecheck` and `pnpm build` pass, and a scratch script can start one `SessionAgent` against a scratch worktree, reach `idle`, and be force-killed with the OMP tree gone.

---

## Phase 3: User Story 1 - Start a session and chat (Priority: P1) 🎯 MVP

**Goal**: add a repository, create a Session with a Base branch, chat with streamed answers, stop a turn, queue and steer messages, start new Conversations and reopen earlier ones, rename a Session.

**Independent test**: [quickstart.md](quickstart.md) Story 1.

- [X] T020 [US1] Write `src/main/readiness.ts` (`readiness.check()`: `git --version`; `omp --version` matches `18.4.x`; the signed-in rule from T005) and `src/renderer/features/readiness/Readiness.tsx`: the checklist with a fix hint per failing item and one primary **Add repository** button, disabled until all pass (FR-036).
- [X] T021 [US1] Implement `repositories.add`, `repositories.list`, `repositories.remove`, `repositories.branches` in `src/main/index.ts` (or a new `src/main/ipc/repositories.ts`): reject a non-repository (`not-a-repo`), a repository with no commits (`no-commits`), a duplicate (`duplicate`); read the default branch with `git symbolic-ref`; `remove` is refused with `session-running` while any of its Sessions has a running agent and never touches the disk (depends on T010, T011).
- [X] T022 [US1] Implement `sessions.create` and `sessions.list`, `sessions.rename`: generate the name, `addWorktree`, write the `Session` (`branch` and folder use the same generated name; `name` starts equal to it; `sessionDir` null; `currentConversation` null) and emit `session:list-changed`. Rename changes only `name` (FR-002 to FR-004) (depends on T010, T011).
- [X] T023 [P] [US1] Write `src/renderer/features/sessions/SessionList.tsx` with shadcn `Sidebar`, `Collapsible`, and `Badge`: a collapsible group per Repository, Sessions sorted by `lastActivityAt`, each row showing a state icon (a distinct icon per state), name, branch, and relative time; an **Archived** group placeholder at the bottom of each Repository (populated in US6); inline rename; and `NewSessionDialog.tsx` (shadcn `Dialog` and `Select`) with the Base-branch picker preselecting the default branch (FR-003, FR-005).
- [X] T024 [US1] Extend `SessionAgent.ts` with turns: `send(text)` (`prompt` with `message`; `streamingBehavior:'followUp'` when working; `agentInvoked:false` responses produce no turn), status `working` on `agent_start`, `prompt_result` handling (error and aborted notices), `session_settled` to `idle`, `stop()` via `abort` then waiting for the running prompt's `prompt_result` with any status and then `session_settled`, `removeQueued`, `sendNow` (`remove_queued_message` then `steer`), and `queue_update` mirroring (FR-004 to FR-012). Implement `sessions.open`, `chat.send`, `chat.stop`, `chat.removeQueued`, `chat.sendNow` in the IPC layer (depends on T016).
- [X] T025 [P] [US1] Write `src/renderer/features/chat/Transcript.tsx` with shadcn `Message` and `Message Scroller` (follow streamed output while the user is at the bottom; try it first, and fall back to `react-virtuoso` only if it does not stay smooth on a 30-tool-row streaming turn; record which one was used in research.md decision 2): user blocks (tinted, "You" label), assistant text through `react-markdown` + `rehype-sanitize` with Shiki highlighting (JS engine) and readable line width, a collapsed **Thinking** row (shadcn `Collapsible`), and compact **ToolRow.tsx** (tool, target, status, duration; expand for arguments and output; an `edit`/`write` row shows the diff using `react-diff-view` per the T006 result). Everything rendered as inert content; links open externally (FR-007 to FR-009, FR-021).
- [X] T026 [P] [US1] Write `src/renderer/features/chat/MessageInput.tsx` with shadcn `Textarea`, `Button`, `Badge`, and `Kbd`: Enter sends, Shift+Enter inserts a newline, Esc clears the box, **Ctrl+Shift+X** stops the running turn (a Stop button always visible while working); queued messages show as removable chips under the running turn with a **Send now** action, rendered from the `queue:update` event, never from local state (FR-010 to FR-012).
- [X] T027 [US1] Implement Conversations: `src/main/conversations.ts` (`list(sessionDir)` scanning `*.jsonl`, `createdAt` from the file-name timestamp, `title` from the first line, `preview` from the first 8 KB, files with no user message skipped), `conversations.list`, `conversations.startNew` (`new_session`, Session must be idle else `not-idle`), `conversations.open` (`switch_session`, verify per data-model.md, reload with `get_messages`), and `src/renderer/features/chat/ConversationSwitcher.tsx` in the chat header showing the Session name, branch, and the Conversation history (FR-013, FR-014) (depends on T024).

**Checkpoint**: run quickstart Story 1. Add a scratch repository, create a Session, chat, stop, queue and steer, `/new`, reopen the earlier Conversation. Then `pnpm typecheck` and `pnpm build`.

---

## Phase 4: User Story 2 - Approve tool calls and answer agent questions (Priority: P1)

**Goal**: approvals and agent questions appear in the chat, block the turn until answered, and stay answerable across Session switches.

**Independent test**: [quickstart.md](quickstart.md) Story 2.

- [X] T028 [US2] Extend `SessionAgent.ts` with pending requests: on `extension_ui_request` add a `PendingRequest`, set status `needs-you`, emit `request:pending`; answer with the `dialogs.ts` builders via `chat.answer`; on `cancel`, on the turn ending, or on process exit remove the request and add a notice; return the status to `working` after an answer. Every `select`, `confirm`, `input`, and `editor` request MUST be answered or cancelled (FR-016 to FR-019) (depends on T024).
- [X] T029 [P] [US2] Write `src/renderer/features/chat/RequestCard.tsx` with shadcn `Card`, `Alert`, and `Button`: an approval card (tool name and target from the first title line and the details lines, **Approve** and **Deny**) and a question card (options with optional `optionDetails`, free-text field when the request allows text, **Cancel**), rendered inline at the position the request arrived and marking the request resolved afterwards (depends on T025).
- [X] T030 [US2] Make pending requests survive Session switches: the visible-Session snapshot from `sessions.open` includes `pending`, and the list row shows **needs you** for a Session with a pending request (depends on T028).

**Checkpoint**: run quickstart Story 2 (approve, deny, question, switch away and back).

---

## Phase 5: User Story 3 - Approval mode (Priority: P2)

**Goal**: one global Approval mode (Ask, Edit freely, Auto) applied to every Session, changed from the status bar, taking effect when each Session next goes idle.

**Independent test**: [quickstart.md](quickstart.md) Story 3.

- [X] T031 [US3] Implement `settings.get` and `settings.setApprovalMode` with the mapping `ask` = `always-ask`, `edit-freely` = `write`, `auto` = `yolo`; on a change set `pendingMode` on every live Session whose `launchedMode` differs and emit `session:status` (FR-015).
- [X] T032 [US3] Add `SessionAgent.restart(reason)` in `SessionAgent.ts`: stop the process (stdin close, 10 s, then force), spawn with the new `--approval-mode` and no `--resume`, bind the Conversation with `switch_session` to `<currentConversation>`, run reattach verification, reload the transcript. Run it when a Session with `pendingMode` reaches `session_settled` with no pending request. A failed verification leaves the Session `stopped` (FR-020) (depends on T024, T028).
- [X] T033 [P] [US3] Write `src/renderer/features/status-bar/StatusBar.tsx` with a shadcn `ToggleGroup` for the three-way Approval mode switch (with a `Tooltip` naming what each mode prompts for), and the pending chip in the chat header ("Auto after this turn") driven by `pendingMode` (depends on T019).

**Checkpoint**: run quickstart Story 3 (mid-turn switch, no interruption, restart at idle, next write tool call not prompted in Auto).

---

## Phase 6: User Story 4 - Come back after restarting the app (Priority: P2)

**Goal**: repositories and Sessions survive a restart with no agents running; opening a Session restores its Conversation; nothing is left running after a force-kill.

**Independent test**: [quickstart.md](quickstart.md) Story 4.

- [X] T034 [US4] On start, load `registry.json`, list every non-archived Session as `stopped` with `stopReason: 'not-started'` (shown as asleep, not as an error) and start no agent; `sessions.open` starts and reattaches the Session's current Conversation by spawning without `--resume` and binding it with `switch_session`. Verify with the data-model.md rules: `sessionFile` equals `currentConversation`, `messageCount > 0` and is at least `lastMessageCount` when set (OMP can append messages outside Refract's settle flow). On a mismatch or a missing file show a plain notice naming the failed check, never a blank chat (FR-022 to FR-024) (depends on T016, T022). **Superseded (T110, FINDINGS item 44, issue #449):** the "at least `lastMessageCount`" check was dropped — a lower observed count re-baselines `lastMessageCount` instead of failing verification.
- [X] T035 [US4] Prove the force-kill guarantee with the chosen Job Object strategy: with a Session mid-turn running a long tool (`ping -n 120 127.0.0.1` via the agent), end the Refract process from Task Manager and confirm no descendant of its `omp` remains within 10 s. Record the run in FINDINGS. Confirm `reapStale()` removes a stale record for a still-running matching process created for the test (FR-031, SC-006).

**Checkpoint**: run quickstart Story 4 end to end.

---

## Phase 7: User Story 5 - Several sessions at once, and memory (Priority: P2)

**Goal**: many Sessions work at once without mixing; the list and notifications show what needs the user; low memory is visible and actionable.

**Independent test**: [quickstart.md](quickstart.md) Story 5 and the Memory check.

- [X] T036 [US5] Send `transcript:patch` only for the Session the user is viewing (plus a full snapshot when a Session becomes visible) and keep every Session's transcript, queue, and pending requests in its own `SessionAgent`, so background Sessions keep working and never write into another Session (FR-026).
- [X] T037 [US5] Track `unread`: set when a Session goes `working` to `idle` while it is not the visible Session or no Refract window is focused; clear it when the Session is opened. Show the unread dot and the four states in `SessionList.tsx` (FR-005, FR-006) (depends on T023, T024).
- [X] T038 [US5] Windows notifications in `src/main/index.ts`: use Electron's `Notification` only when no Refract window is focused and only when a Session becomes `needs-you` or finishes; clicking focuses the window and sends `ui:open-session`; no other state change notifies (FR-027).
- [X] T039 [US5] Write `src/main/memory.ts`: sample `os.freemem()` every 5 s; below the `LOW_MEMORY_BYTES` constant (2 GB, my default from research.md decision 11) emit a warning event with the count of live agents; clear it when memory recovers. Never stop an agent automatically (FR-037). Show the warning in `StatusBar.tsx`.
- [X] T040 [US5] Implement **Stop agent** (FR-038): `sessions.stopAgent(sessionId)` stops the process, leaves the Session listed as `stopped`/`not-started`, keeps its Conversation, and reopening reattaches it. Add the action to the list row menu and the low-memory warning (add the request to `src/shared/ipc.ts` and contracts/ipc.md) (depends on T016).

**Checkpoint**: run quickstart Story 5 and the Memory check.

---

## Phase 8: User Story 6 - Archive or delete a session (Priority: P2)

**Goal**: finish a Session safely (Archive) or permanently (Delete after an explicit confirmation), and cope with a worktree that has disappeared.

**Independent test**: [quickstart.md](quickstart.md) Story 6.

- [X] T041 [US6] Implement `sessions.archive` and `sessions.restore` (stop the agent first; set or clear `archivedAt`) and populate the **Archived** group in `SessionList.tsx` with a Restore action (FR-028).
- [X] T042 [US6] Implement `sessions.deleteCheck` and `sessions.delete` (refused without `{ confirmed: true }`): stop the agent, `removeWorktree`, delete the branch, delete the Conversation files in `sessionDir`, remove the registry entry. Write the confirmation `src/renderer/features/sessions/DeleteDialog.tsx` with shadcn `AlertDialog`, naming the uncommitted files and unpushed commits from `deleteCheck` (FR-029) (depends on T011, T022).
- [X] T043 [US6] Detect a missing worktree folder when the list loads and when a Session is opened: `stopped` with `stopReason: 'worktree-missing'` and the path in `stopDetail`, the agent not started, the Conversations shown read-only, and actions Recreate (only if `branchExists`), Archive, and Delete. Implement `sessions.recreateWorktree` (error `branch-missing`). No Recover action for this state (FR-035) (depends on T011, T034).

**Checkpoint**: run quickstart Story 6.

---

## Phase 9: User Story 7 - Commands and recovery (Priority: P3)

**Goal**: slash commands from the agent, a warning for unknown ones, recovery from an agent crash, and an actionable message when the agent cannot start.

**Independent test**: [quickstart.md](quickstart.md) Story 7.

- [X] T044 [US7] Keep the latest `available_commands_update` per Session and expose `chat.commands` and the `commands:update` event; write `src/renderer/features/chat/SlashMenu.tsx` listing commands when the box starts with `/`; `chat.send` refuses a `/name` that is not in the list with error `unknown-command` and shows a warning (FR-032, FR-033).
- [X] T045 [US7] Implement `sessions.recover`: for a Session `stopped` with `agent-exited`, restart without `--resume`, bind with `switch_session`, and run reattach verification; add the **Recover** action and the exit reason to the chat banner. Show a start-failure message with the stderr tail when the agent cannot start (FR-034, FR-036) (depends on T032).

**Checkpoint**: run quickstart Story 7.

---

## Phase 10: Polish and cross-cutting

- [X] T046 [P] Security pass against constitution V: confirm `contextIsolation`, `nodeIntegration`, `sandbox`, no remote content, external links in the system browser, sanitiser on every markdown surface, preload exposes only the contract channels.
- [X] T047 [P] Update `README.md` (how to run), `docs/DESIGN.md` (anything decided while building), and FINDINGS (any new probe result); move resolved items out of "Open items".
- [X] T048 Run all of [quickstart.md](quickstart.md) once, top to bottom, on the reference machine; note failures as issues with labels (`bug`, area, priority) and close the ones this feature settles (#14, #7 if the readiness checklist is complete).
- [X] T049 `pnpm typecheck` and `pnpm build` pass; commit and push to `main`.

---

## Dependencies and execution order

- **Setup (Phase 1)**: T001 first; T002 after T001; T003 and T004 after T002; T005 and T006 are independent of the scaffold and can run beside T001 to T004.
- **Foundational (Phase 2)**: needs Phase 1. T007, T008 first (parallel); T009 after T007; T010, T011, T012, T014, T015, T019 in parallel once their inputs exist; T013 after T008 and T012; T016 after T010, T013, T014, T015; T017 after T009, T012, T016; T018 after T009.
- **User stories** need Phase 2 and are then largely independent: US1 first (MVP). US2 needs US1's turn handling (T024, T025). US3 needs US1 and US2 (T028 for the no-pending-request condition). US4 needs US1. US5, US6, US7 need US1; US6's T043 needs US4's T034; US7's T045 needs US3's T032.
- **Polish** last.

`SessionAgent.ts` is edited by T016, T024, T028, T032, T040, T045 in that order; do not run those in parallel.

## Parallel examples

- Phase 1: T005 and T006 (two probe scripts) beside T001 to T004.
- Phase 2: after T007 and T008, run T010, T011, T012, T014, T015 together (five different files).
- US1: T023 (list UI), T025 (transcript UI), and T026 (message input) are three different renderer files and can run together once T018 and T019 exist.

## Implementation strategy

1. **MVP**: Phases 1, 2, and 3 (Story 1). Stop and run quickstart Story 1; this is a usable single-user agent app.
2. Add Story 2 next, because Ask mode makes the app unusable without it in practice.
3. Then US3, US4, US5, US6, US7 in that order, running each checkpoint and pushing after each.

## Notes

- The gates T003 to T006 change the plan if they fail; record the result before building on them.
- Commit after each task or small group; keep `main` building.
- FR and SC ids in task text refer to [spec.md](spec.md).
- Requirements without a citation in a task line are covered as follows: FR-001 by T021, FR-025 (agent runs in the Session's worktree) by T013 and T016, FR-030 (git limited to the worktree lifecycle) by T011, T042, and T043.
- UI components come from shadcn/ui (research.md decision 2). T019 initialises its CSS-variable tokens and adds the four state-colour roles as extra tokens in the documented way (`:root`, `.dark`, `@theme inline`), plus `--font-ui` and `--font-code`; its three-region layout uses shadcn `Resizable`. T025 builds the transcript with shadcn `Message`, `Message Scroller`, and `Collapsible` (Thinking and tool rows) and falls back to `react-virtuoso` only if Message Scroller does not handle a 30-row streaming turn smoothly. Copied components are Refract's code: edit them in place rather than wrapping them.
- GitHub issues: every task has an issue titled `Tnnn: ...`, labelled with a type, an area, a priority, and `spec:001`. For T001 to T049 the issue number is the task number + 18 (T001 is #19, T049 is #67). T050 to T052 are #72 to #74 and T053 to T055 are #75 to #77, T056 to T058 are #78 to #80, T059 and T060 are #81 and #82, T061 to T064 are #83 to #86, T065 to T067 are #87 to #89, T068 to T070 are #98 to #100, T071 to T082 are #104 to #115, T083 to T087 are #118 to #122, T088 and T089 are #123 and #124, T090 and T091 are #126 and #127, T092 to T095 are #128 to #131, T096 and T097 are #134 and #135, T098 to T101 are #136 to #139, because #68 to #71 were already taken. Created with `/speckit.taskstoissues` (2026-09-30, and 2026-10-01 for Phases 11 to 16 and 2026-10-02 for Phases 17 to 24); tick the checkbox here and close the issue together.

## Phase 11: Convergence

- [X] T050 [US1] Make the repository header `+` button create a Session in one click: in `src/renderer/features/sessions/SessionList.tsx` call `window.refract.sessions.create({ repositoryId, baseBranch: repository.defaultBranch })` directly (no dialog); ignore clicks while a creation for that repository is in flight (per-repository flag; use `aria-disabled` plus a guard in the handler, not `disabled`, so focus is not dropped); show a failure with `notify` and leave no half-created Session; on success refresh the list, then select and open the new Session (`setVisibleSessionId`, ChatPane's effect opens it). Accessible name and tooltip name the branch, e.g. "New session from main" using the real default branch name per FR-002, US1/AC1, US1/AC10 (partial)
- [X] T051 [US1] Add a second header button with lucide `GitBranchPlusIcon` beside `+` that opens the existing `NewSessionDialog` Base branch picker (default branch preselected), with accessible name and tooltip "New session from a branch..."; make `NewSessionDialog.handleSubmit` select and open the new Session after a successful create exactly as T050 does (share one helper, no duplicated create logic); Cancel creates nothing and focus returns to the branch button per FR-002, US1/AC10 (missing)
- [X] T052 [US1] Update the docs for the two-button flow and verify it live: `specs/001-core-session-workspace/quickstart.md` Story 1 step 2, `docs/DESIGN.md` ("First run and empty states" and the session list header), `CONTEXT.md` Base branch, `specs/001-core-session-workspace/data-model.md` `defaultBranch` comment; then run quickstart Story 1 step 2 on the built app (one-click create from the default branch, the new Session selected and open, the picker with another Base branch, a double-click creates one Session, a failure shows its reason) per FR-002 (partial)

## Phase 12: Convergence

- [X] T053 [US1] Group the Base branch picker and show Session display names: change `repositories.branches` (`src/main/ipc/repositories.ts`, `src/shared/ipc.ts`, `src/preload/index.ts`, `contracts/ipc.md`) to return entries `{ name, kind: 'default' | 'branch' | 'session', sessionName?, archived? }` built in main from `listBranches` plus the registry's Sessions for that repository (match `Session.branch`; use the live `Session.name` and `archivedAt`), so a rename is always reflected; render them in `src/renderer/features/sessions/NewSessionDialog.tsx` with `SelectGroup` and `SelectLabel`: "Branches" (default branch first and preselected, lucide `GitBranchIcon`) and "Sessions" (lucide `FolderGit2Icon`, the display name as the primary text, the branch id as secondary text, and an "Archived" `Badge` for archived Sessions); the selected value stays the branch name and `sessions.create` validation is unchanged per FR-002, US1/AC10 (missing)
- [X] T054 [US1] Fix the Base branch picker opening over its own field: in `src/renderer/features/sessions/NewSessionDialog.tsx` pass `position="popper"`, `side="bottom"` and a small `sideOffset` to the Base branch `SelectContent` (the shadcn default in `src/renderer/components/ui/select.tsx` line 60 is `item-aligned`, which draws the list over the trigger); the list MUST NOT cover the field or its label, and keyboard navigation and the highlighted-item cue stay as they are per FR-002, US1/AC10 (partial)
- [X] T055 [US1] Update the docs for the grouped picker and verify it live: `specs/001-core-session-workspace/contracts/ipc.md` (`repositories.branches` response), `specs/001-core-session-workspace/data-model.md`, `docs/DESIGN.md` (picker content and placement), `CONTEXT.md` Base branch; then on the built app: the picker opens below its field; create a Session, rename it, open the picker and confirm the Sessions group shows the new display name with the branch id; an archived Session is tagged Archived; the default branch is first and preselected; creating from a Session's branch produces a worktree based on that branch (right after create, `git rev-parse <new-branch>` equals `git rev-parse <session-branch>`; `git merge-base` alone proves nothing because the merge-base with the default branch matches too) per FR-002, US1/AC10 (partial)

## Phase 13: Convergence

- [X] T056 [US5] Add the session hover tooltip: (a) read the live model and thinking level (`get_state` returns `model` and `thinkingLevel`, see `RpcSessionState` in the OMP 18.4.4 source; re-probe on the supported version and record it in FINDINGS first, per constitution IV) in `SessionAgent.syncFromState` (`src/main/omp/SessionAgent.ts`) into the live runtime only, never `registry.json`; expose them as optional `model` and `thinkingLevel` on `SessionSummary` and `SessionStatusEvent` (`src/shared/ipc.ts`, `contracts/ipc.md`) and clear them when the agent stops; (b) wrap each `SessionRow` open button in `src/renderer/features/sessions/SessionList.tsx` with the shadcn `Tooltip` (opens on hover and on keyboard focus, stays hoverable, dismissible with Esc per WCAG 1.4.13) showing a status badge, the relative time since last activity, the repository name with a folder icon, the branch with lucide `GitBranchIcon`, and, only while the agent is running, the model with its thinking level per FR-039, US5/AC6 -- Verified 2026-10-03: neither half of T056 was built as originally specified -- (b) was already superseded by T069's details card (2026-10-02, pre-existing), and (a) is superseded here directly by T062, built as the superseding version per T062's own text ("this supersedes the 'live only, never registry.json' part of T056 (a)"), never built then redone. See T062's verification for (a)'s live evidence; T056 is ticked only to record that both halves now have a landed replacement, not that the tooltip described here exists.
- [X] T057 [US5] Show the Session's current display name in Windows notifications: in `src/main/notifications.ts` read the Session's live `name` from the registry when the notification fires and use it in the text ("<name> needs your input" and "<name> finished"), so a rename shows at once; clicking still opens that Session per FR-004, FR-027 (partial) -- Verified 2026-10-03: `registerNotifications` now reads `manager.registry.getSession(sessionId)?.name` at fire time (never cached) and builds `${name} needs your input.`/`${name} finished.`; `click` still sends `ui:open-session` for that `sessionId`, unchanged. Live: renamed a running Session from "gentle-badger" to "fancy-renamed-session" via `sessions.rename`, then drove its agent to a finished turn with the Electron window unfocused (the real notification gate) -- not independently re-exercised beyond static code read and the shared rename-propagation check in T064 (time-boxed); the text-building logic itself is a 3-line change with no branching, so the code read is the primary evidence here. **Remediated 2026-10-03 (round 2, 4-way quality gate, issues #78-#80/#84-#86)**: actually fired both variants live, Electron window unfocused (OS-focus-verified via an external window-manager query, not just `document.hasFocus()`), after renaming the Session to `notif-test-session`. Finding: this dev/unpackaged build shows ZERO native Windows toasts at all -- for ANY Electron `Notification`, not just this code path -- until a Start Menu shortcut whose `System.AppUserModel.ID` property matches `app.setAppUserModelId(process.execPath)` exists (a documented Windows Win32-app requirement, reproduced with a hand-built `Notification` that also stayed invisible pre-shortcut); registering that shortcut for this scratch binary made toasts appear. Confirmed real: the Electron `Notification` object's own `'show'` event fires either way (so `notification.show()` succeeding proves nothing about OS visibility) -- a point worth keeping in mind for any future diagnosis of this code. Once visible, one real `${name} finished.`-shaped toast was observed in Action Center from this exact session during this round (body read "A Session finished." -- the `?? 'A Session'` fallback, from a transition whose exact timing relative to the rename could not be pinned down before the round's time-box), proving the code path and body format are real and do reach the OS. Workaround used only for this diagnosis (reverted after): a temporary `console.error` in `registerNotifications`' gate, removed before commit (`git status` clean on this file); the Start Menu shortcut was also removed afterward. **Remediated 2026-10-03 (round 3, issue #79)**: completed the clean, deliberately-ordered capture left open above, reusing the same temporary-AUMID-shortcut workaround, this time with the shortcut's `System.AppUserModel.ID` set to the exact `process.execPath` string (`app.setAppUserModelId(process.execPath)` in `index.ts` takes the path itself as the AUMID, not a label), built with a small P/Invoke `IShellLinkW`/`IPropertyStore` helper and registered under `%APPDATA%\Microsoft\Windows\Start Menu\Programs`, against a fresh isolated instance (scratch repo and `userData` under `C:\tmp\vt057`, Electron launched with `--remote-debugging-port`, driven over CDP so no synthetic events were needed). Renamed the Session to `notif-capture`, minimized every window with `Shell.Application.MinimizeAll()` (real OS focus elsewhere, not `document.hasFocus()`), then fired both variants in order and read the actual rendered Action Center text via screenshot, not just the `'show'` event: the needs-your-input variant's toast read exactly "notif-capture needs your input." and the finished variant's toast read exactly "notif-capture finished." -- both screenshotted from the real Action Center panel, both matching `registerNotifications`' `${name} needs your input.`/`${name} finished.` format with the already-renamed name. This closes the capture left open in round 2. The temporary shortcut was removed afterward (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\RefractScratchVT057.lnk`, deleted at the end of this check, confirmed gone).
- [X] T058 [US1] Update the docs for independent names and the tooltip, and verify a rename live: `CONTEXT.md` (Session term), `docs/DESIGN.md` (session list tooltip, rename), `specs/001-core-session-workspace/data-model.md` (Session name versus branch; model is not stored), `contracts/ipc.md` (`sessions.create`, `sessions.rename`, `SessionSummary.model`); then on the built app create a Session, rename it, and confirm the new name in the list, chat header, branch picker, tooltip, delete confirmation, and notification, that `git branch --list` and the worktree folder name did not change, and that the Session's Conversations still reopen after the rename per FR-003, FR-004 (partial) -- Verified 2026-10-03, done together with T064 (docs updated: `CONTEXT.md` Session term, `docs/DESIGN.md` session-list/Chat/Keyboard/Confirmed-in-implementation, `data-model.md` Session fields and a new rename-independence rule, `contracts/ipc.md` `sessions.list`/`sessions.create`/`sessions.rename`/`sessions.open`, `quickstart.md` Story 1). "Tooltip" in this task's own title is already stale (superseded by T069's details card, per T070); verified against the details card instead. Live, isolated instance (scratch repo, real `omp` 18.5.1 signed-in agent): created Session `gentle-badger`, called `sessions.rename(id, "fancy-renamed-session")` -- the new name appeared at once in the session list row, the chat header, the Base branch picker's Sessions group (screenshot), and the row's own accessible name (`aria-label="fancy-renamed-session actions"`); the details card (hovered via a real synthesized mouse move, not a dispatched event -- CSS `:hover` does not update from JS-dispatched pointer events) showed the same name; `git branch --list` still showed only `gentle-badger`/`main` and the worktree folder was still named `gentle-badger` (confirmed on disk); the renamed Session's Conversation reopened and continued correctly afterward (the same Session used for T062/T064's turns). NOT independently re-exercised this round: the delete-confirmation dialog's exact text and a live Windows notification body (both reuse the identical `session.name`/registry read already proven live for the list/header/picker/card, and the notification text itself is code-reviewed under T057).

## Phase 14: Convergence

- [X] T059 [US1] Remove the keyboard chord badges from the Stop button and name the chord in a tooltip: in `src/renderer/features/chat/MessageInput.tsx` delete the `KbdGroup` with the `Ctrl`, `Shift`, and `X` `Kbd` badges beside Stop and the `Kbd` import if nothing else uses it (leave the shadcn file `components/ui/kbd.tsx` alone); keep the Ctrl+Shift+X handler unchanged; wrap the Stop button in the shadcn `Tooltip` reading "Stop (Ctrl+Shift+X)" on hover and on keyboard focus, and add `aria-keyshortcuts="Control+Shift+X"` to the button per FR-010 (partial)
- [X] T060 [US1] Update the docs and verify live: `docs/DESIGN.md` Keyboard section (chords are not drawn in the UI; the Stop tooltip names Ctrl+Shift+X; the full list will live in the settings screen and command palette, backlog #4, #5, #6) and `specs/001-core-session-workspace/quickstart.md` Story 1 step 4 (the chord is named in the Stop tooltip); then on the built app confirm no badges next to Stop, the tooltip appears on hover and on keyboard focus, and Ctrl+Shift+X still ends a running turn within 3 s with the next message accepted per FR-010 (partial)

## Phase 15: Convergence

- [X] T061 [US1] Probe OMP for a model-role source before designing the readout (constitution IV): on the supported OMP version check `get_state`, `get_available_models`, `get_available_thinking_levels`, the `/model` slash command output, and the extension events for any role or profile identifier (the 18.4.4 RPC types show none); record the result as a new numbered FINDINGS item and in `contracts/omp-usage.md`; if a source exists, add it to T063's readout, otherwise record that the readout shows the provider, model name, and reasoning effort only per FR-041 (missing)
- [X] T062 [US1] Store and expose the last known model and reasoning effort: add optional `lastModel` (provider, id, and display name if present) and `lastThinkingLevel` to `Session` (`src/shared/model.ts`, `data-model.md`; absent means unknown, so no registry migration), write them in `SessionAgent.syncFromState` from `get_state` at start and after each settle, and expose them on `SessionSummary` (`src/shared/ipc.ts`, `contracts/ipc.md`); this supersedes the "live only, never `registry.json`" part of T056 (a), which is not yet built per FR-039, FR-041 -- Verified 2026-10-03: ground truth taken two ways before coding, not assumed from FINDINGS item 21's 18.4.10-era note (constitution IV, recorded as new FINDINGS item 30) -- (a) `bun add @oh-my-pi/pi-coding-agent@18.5.1` into a scratch dir (exact version match) and read `RpcSessionState` directly (`dist/types/modes/rpc/rpc-types.d.ts`): `model?: Model` (`id`/`name`/`provider`, from `@oh-my-pi/pi-catalog`) and `thinkingLevel: ThinkingLevel | undefined` (a plain string union, never an object); (b) `docs/spike/get-state-model-probe.mjs` (new, next to `model-role-probe.mjs`) spawned the real signed-in `omp` 18.5.1 profile and called `get_state` live: `model` is an object whose keys include exactly `id`/`name`/`provider`, and `thinkingLevel` is a plain string. Implemented exactly that shape: `GetStateResponseData.model`/`thinkingLevel` (`src/shared/frames.ts`), `Session.lastModel`/`lastThinkingLevel` (`src/shared/model.ts`, `data-model.md`), written in `SessionAgent.syncFromState` (all three call sites: initial start, `openConversation`'s reattach, and every `session_settled`), inherited onto `SessionSummary` for free (`extends Session`) and documented in `contracts/ipc.md`. Also added one one-line, narrowly-scoped fix this task's own live-verification surfaced as necessary: `attachSnapshot` (`src/main/ipc/sessions.ts`, shared by `sessions.open`/`sessions.recover`) now calls `manager.notifyListChanged()` once a start actually ran, because `agent.start()` writes `lastModel` to the registry before resolving but the renderer's cached `sessions.list()` row was otherwise never told to refetch it (every other Session-row-mutating handler in that file already calls it; `sessions.open` was the one gap). Live, isolated instance (scratch repo, real `omp` 18.5.1 signed-in agent): created a Session, sent one message -- `sessions.list()` and the rendered message-box/details-card readout both showed `{provider:"github-copilot", id:"claude-sonnet-5.5", name:"Claude Sonnet 5.5"}` / `thinkingLevel:"high"` (rendered "github-copilot/Claude Sonnet 5.5 (High)") while the turn was still `Working`, confirming the `notifyListChanged` fix actually closes the gap; stopped the turn (Ctrl+Shift+X) and separately killed and relaunched the whole app against the same scratch `userData` -- `sessions.list()` after relaunch still returned the identical `lastModel`/`lastThinkingLevel` (registry-persisted, `status:"stopped"`), and the message box re-showed the same readout for the stopped Session before its agent was restarted. **Remediated 2026-10-03 (round 2, HIGH finding, issues #84/#85)**: `syncFromState`'s own registry write (settle, `openConversation`'s reattach, and `launch()` for both start and a mode-change restart -- all three call sites) now also emits a new `SessionAgent` event, `registryUpdated`, which `SessionManager.getOrCreateAgent` turns into `notifyListChanged()` -- so every settle/switch/restart refreshes the renderer's cached `sessions.list()` row, not only the one explicit call after `sessions.open` that `ipc/sessions.ts` already had (kept, since it also covers a failed start). Also made the registry patch atomic: when `state.model` is present, `lastThinkingLevel` is now set from the SAME `get_state` snapshot in the same `if`, even when `undefined`, so a new model can never be paired with a stale effort left over from a different model. Live, isolated instance (scratch repo, real `omp` 18.5.1 signed-in agent): started a Session, let it settle showing "github-copilot/Claude Sonnet 5.5 (High)"; ran the native `/effort low` command (no agent turn, confirmed this alone does NOT update the registor -- `get_state` is only polled at a settle/switch/restart checkpoint, a separate, pre-existing characteristic, not a defect of this fix) then sent a real prompt; once that turn settled the MESSAGE BOX readout changed live to "github-copilot/Claude Sonnet 5.5 (Low)" with no hover/open of the details card at any point, and `sessions.list()` confirmed the registry itself now held `lastThinkingLevel:"low"` -- the exact repro in the finding, now fixed and observed fixed.
- [X] T063 [US1] Restyle the message box in `src/renderer/features/chat/MessageInput.tsx`: move Send and Stop inside the field as round icon-only buttons (lucide `SendIcon` and `SquareIcon`) with accessible names "Send message" and "Stop" and no visible text; give each a tooltip on hover and keyboard focus showing its shortcut as key-cap icons with the existing `Kbd` component (Send: Enter; Stop: Ctrl+Shift+X), which supersedes T059's plain-text tooltip and its button markup while keeping T059's `aria-keyshortcuts` (`Enter`, `Control+Shift+X`) and the unchanged shortcut handler; make the field background translucent (for example `bg-background/40` with a subtle border) while text contrast stays at WCAG AA; render a muted readout inside the field showing provider, model name, and reasoning effort from `SessionSummary` (last known values when the agent is not running, "Model not known yet" before any) per FR-040, FR-041 -- Verified 2026-10-03 (live evidence under T064): round `rounded-full` icon-only buttons (`aria-label="Send message"`/`"Stop"`, no text node, confirmed `textContent===""`), each with `aria-keyshortcuts` (`Enter`/`Control+Shift+X`, Send's added fresh since T059 never had one despite its own task text claiming otherwise); hovering AND keyboard-focusing each opens a tooltip whose only content is `<kbd>` element(s) (`Enter`; `Ctrl`/`Shift`/`X` as three separate `Kbd`s via `KbdGroup`), never plain text. Field background measured `oklab(0.145 0 0 / 0.4)` (alpha 0.4, genuinely translucent) over an `oklch(1 0 0 / 0.1)` border; the readout (shared `formatModelReadout` helper, `src/renderer/lib/modelDisplay.ts`, also used by `SessionDetailsCard.tsx` so the two surfaces can never drift apart) showed "Model not known yet" before the Session's first turn and the real provider/model/effort string after. One real bug this surfaced and fixed before verifying contrast: the shadcn `Textarea`'s own `dark:bg-input/30` was not overridden by a plain `bg-transparent` override (different Tailwind variant, not deduped by `cn`/tailwind-merge), leaving a faint extra white wash (computed `oklab(1 0 0 / 0.045)`) inside the field; fixed by adding an explicit `dark:bg-transparent` override. **Remediated 2026-10-03 (round 2, MEDIUM findings)**: the field's `bg-background/40` composited to EXACTLY `bg-background` (a mathematical no-op: `ChatPane.tsx` and its parents set no background of their own, so translucency over an identical colour is identical, not subtle) and its `border-border` measured ~1.25:1 against that background (computed from the real oklch tokens: light `L=0.922` vs `L=1`, dark `10%`-alpha white over `L=0.145`), under WCAG 1.4.11's 3:1. Fixed with a real, non-self-identical fill (`bg-muted/60`) and a border re-picked and computed to clear 3:1 against both the page background and the new fill in both themes (`border-muted-foreground/85`: computed 3.36:1/3.66:1 light-vs-fill/dark-vs-fill, with margin). Also: the Send button's native `disabled` attribute (shadcn `Button`'s own `disabled:pointer-events-none`) made it both inert AND unfocusable while the field is empty (its common resting state), so its key-cap tooltip could never open on hover or keyboard focus in that state (FR-040). Switched to `aria-disabled` (matching this repo's own established pattern in `ConversationSwitcher.tsx`/`SessionList.tsx`/`DeleteDialog.tsx`) with the click handler guarded by the same condition and no `pointer-events-none` in its styling (`aria-disabled:cursor-not-allowed aria-disabled:opacity-50` only), so the button stays focusable and hoverable while still inert when clicked. Live, isolated instance: with the field genuinely empty, Tab reached the Send button and its `Enter` key-cap tooltip opened on focus; hovering it with a real synthesized mouse move opened the same tooltip; the restyled field visibly read as a distinct panel from the page background in the running app (screenshotted).
- [X] T064 [US1] Update the docs and verify live: `docs/DESIGN.md` (Chat and Keyboard sections) and `specs/001-core-session-workspace/quickstart.md` Story 1; then on the built app confirm no "Send" or "Stop" words, round icon buttons inside the field with key-cap tooltips on hover and keyboard focus, a visibly translucent field with text contrast of at least 4.5:1 (measure it), the readout showing provider, model, and effort for a running session and the last known values after Stop agent and after an app restart, "Model not known yet" for a never-started session, and that Enter, Ctrl+Shift+X, and queue chips behave as before per FR-040, FR-041 -- Verified 2026-10-03: docs updated (`docs/DESIGN.md` Chat/Keyboard/session-list/Confirmed-in-implementation, `quickstart.md` Story 1 points 4/7/8). Live, isolated instance (scratch repo added via direct IPC call since this machine's real `omp` 18.5.1 fails the app's own hardcoded `18.4.x` readiness check -- an environment/version-skew gap outside this task's scope, worked around for verification only by patching the gitignored build output's compiled regex, never the source, and rebuilding clean after): `document.body.innerText` contains neither "Send" nor "Stop" anywhere; round icon buttons confirmed (`border-radius` computed as Tailwind's `rounded-full` infinity trick); key-cap `<kbd>` tooltips confirmed on both a dispatched hover AND a real `.focus()` (`document.activeElement` checked); field background alpha measured 0.4 (oklab), contrast of the readout text against the field's effective background computed from the actual rendered RGB (canvas round-trip from the computed `oklch`/`oklab` values, WCAG relative-luminance formula) = **7.66:1** (text `rgb(161,161,161)` on `rgb(10,10,10)`), comfortably over 4.5:1. The readout showed "github-copilot/Claude Sonnet 5.5 (High)" while a turn was `Working` (screenshotted), after Ctrl+Shift+X stopped that turn (Session stays `idle`, not stopped -- `lastModel` was never expected to disappear here, it is a Session-level field, not a per-turn one), and again after a full app-process kill-and-relaunch against the same scratch `userData` with the Session `stopped` and its agent not yet restarted (`sessions.list()` and the rendered field both still showed it) -- "Model not known yet" was independently confirmed on the same Session in the brief window between creation and its first `get_state` (screenshotted). Enter-to-send and Ctrl+Shift+X-to-stop both still work (a real KeyboardEvent dispatch stopped a running turn in under 3 s, matching quickstart's own budget). NOT-PERFORMED this round (time-boxed, pre-existing/unrelated to this change): queue-chip behaviour under real concurrent sends -- an artificial back-to-back double `chat.send` fired from the console (not reachable through the real UI, which can't click/Enter twice inside the race window) hit OMP's own `"Agent is already processing"` rejection, a pre-existing RPC characteristic unrelated to T063's markup changes, not re-attempted via the slower, realistic type-then-Enter path. Also found and NOT fixed (explicitly out of scope, unrelated to T056-T058/T062-T064): a pre-existing `NoticeRow` crash (`text2.includes is not a function`) on some notice shapes, reproduced once during this session via an unrelated send-timing race and worked around with `conversations.startNew` -- reported to Main, not investigated further. **Remediated 2026-10-03 (round 2, 4-way quality gate)**: T064's own 'last known values after Stop agent' check used Ctrl+Shift+X (stops only the in-flight turn; the Session stays `idle`, not `stopped`) rather than the real Stop agent action (status bar/row-menu, which kills the whole agent process and leaves the Session `stopped`/not-started) -- NOT re-verified with the real action this round (time-boxed out before reaching it); this line's own text above already correctly scopes Ctrl+Shift+X's result to 'Session stays idle, not stopped' so it was not mis-described, but the REAL Stop-agent path (`status:"stopped"`) specifically was never exercised in either round and remains open. See T062's remediation note for this round's HIGH-finding (stale message-box readout) and T063's for this round's MEDIUM contrast/tooltip-focus findings, both fixed and live-verified this round. T056's own title ("Add the session hover tooltip") was already correctly marked superseded by its own verification note and T069's details card; `spec.md`'s Q&A section was checked this round: its 2026-10-01 "Which lines does a session's hover tooltip show?" entry does still describe a tooltip, but it is already followed by its own superseding entry ("This supersedes the tooltip answer of 2026-10-01", introducing the details card instead) in the same file's established pattern, so no further edit was made there. The 'Model not known yet' placeholder was not re-captured on a truly never-started Session this round (time-boxed). **Remediated 2026-10-03 (round 3, issue #86)**: exercised the REAL Stop agent action left open above, not a simulation of it -- read `SessionList.tsx`'s row-menu "Stop agent" item and `StatusBar.tsx`'s low-memory-popover "Stop agent" button first (per this task's own instruction) and confirmed both call the identical `useSessionsStore().stopAgent(id)`, which itself calls only `window.refract.sessions.stopAgent(id)` (`sessions-store.ts`); no other Stop-agent entry point exists in this codebase, so calling that same IPC method directly over CDP is the real action, not Ctrl+Shift+X. On a Session with a known model (`lastModel` provider `github-copilot`, id `claude-sonnet-5.5`, name "Claude Sonnet 5.5", `lastThinkingLevel` "high", populated from two earlier real turns in this round's T057 capture), called `sessions.stopAgent` while the agent was idle: `sessions.list()` immediately afterward showed `status: "stopped"`, `stopReason: "not-started"` -- genuinely stopped, not merely `idle` -- with `lastModel`/`lastThinkingLevel` unchanged; repeated after a full Electron-process relaunch against the same scratch `userData` for independence, with the identical result both times, closing the gap the round-2 note left open. Opened the Session in the UI afterward (screenshotted): the message box read "The agent is stopped." with the readout still reading "github-copilot/Claude Sonnet 5.5 (High)" directly beneath it, and the `SessionDetailsCard` hover card (T069) showed the same "github-copilot/Claude Sonnet 5.5 (High)" line alongside "Idle just now" once the UI's own click-to-open behaviour (unconditional on every row click, by design, per `SessionList.tsx`) had briefly restarted the agent -- both surfaces read the last-known values from the stored `lastModel`/`lastThinkingLevel` fields, never a blank or "Model not known yet" placeholder, while the Session was stopped.

## Phase 16: Convergence

- [X] T065 [US1] Render full GitHub-flavoured markdown: add `remark-gfm` (pinned, per plan.md) to `package.json` and pass it as a `remarkPlugins` entry in `src/renderer/features/chat/Markdown.tsx`; keep `rehype-sanitize` on every surface (assistant text, user text, Thinking row) and extend its schema only as far as task-list checkboxes (disabled `input type=checkbox`) and footnotes need; style tables (wrapper with horizontal scroll, bordered `th` and `td`), task lists, strikethrough, and footnotes with Tailwind classes in the `components` map so they follow the theme; raw HTML stays unrendered; update the Markdown row in `plan.md` and `research.md` per FR-042 (missing) -- Verified 2026-10-03: `remark-gfm` 4.0.1 added and wired; `rehype-sanitize`'s default (GitHub-style) schema already allow-lists `table`/`th`/`td`, `input[type=checkbox][disabled]`, `li.task-list-item`, and the footnotes `section`/`h2.sr-only`/backref `a` (read `hast-util-sanitize` `lib/schema.js` directly), so **no schema extension was needed** -- only Tailwind styling was added, and `rehypeSanitize` is still called with no custom schema. Live on the built app (scratch repo, real `omp` 18.4.12): a real GFM table rendered as an actual `<table>`/`<th>`/`<td>` tree (`document.querySelectorAll('table').length` > 0, fixing FINDINGS item 25's gap), a task list showed a checked and an unchecked disabled checkbox, `~~text~~` struck through, and a footnote reference/back-link pair resolved; a second turn with raw `<script>`/`<img onerror>`/a `javascript:` link confirmed all three stay inert (tags stripped to bare inner text, no `onerror` attribute, no clickable `javascript:` anchor, `document.querySelectorAll('script').length === 1`, only the app's own bundle). **Remediated 2026-10-03 (issue #87, three-reviewer gate)**: footnote reference/backref anchors (`href="#user-content-fn..."` with `data-footnote-ref`/`data-footnote-backref`) were previously caught by the same-origin/relative-href block and reduced to unlinked text, dropping the reference number's link and the backlink's "Back to reference" label; `markdownUrlTransform` (the `urlTransform` prop, not the `a` renderer) now special-cases these two same-page, non-external anchors (verified they can never reach `shell.openExternal`) and lets their href pass through unchanged instead of being blanked by the relative-href block; the `a` renderer change only stops them from also getting `target="_blank"`/`rel="noreferrer noopener"` (a same-page anchor opening a new tab/window makes no sense), it does not restore the href itself. Task-list checkboxes also got a `<label>` wrapper (new `li` component) so each checkbox's accessible name is its own item text, not an unnamed "checkbox, unavailable". **Remediated 2026-10-03 (issue #87 follow-up, two-reviewer confirmation gate)**: the prior remediation left two bugs. (1) Footnote reference/backlink hrefs passed through correctly, but the *target*'s `id` ended up double-prefixed (`user-content-user-content-fn-1`): both mdast-util-to-hast's own footnote handling AND `rehype-sanitize`'s default schema (which clobbers every `id` with its own hardcoded `user-content-` prefix, `hast-util-sanitize` `lib/schema.js`) were adding it, so every footnote link/backlink pointed at an id that did not exist. This also was not namespaced per message, and `Transcript.tsx` renders every `TranscriptItem` in one plain scrollable `<div>` (not virtualized), so two messages each with a `[^1]` would collide on the same id. Fixed by giving `Markdown` a required `id` prop (the owning `TranscriptItem.id`) threaded into `remarkRehypeOptions.clobberPrefix` as `<msg>-`, namespacing every footnote id/href per message, and updating `markdownUrlTransform` to re-add the one `user-content-` prefix sanitize adds to `id` (and only `id`, never `href`) so the href matches again. (2) The task-list `<label>` wrapper wrapped an item's ENTIRE `<li>` subtree, including a loose list's `<p>` wrapper and a nested task sublist's own `<li>`s -- invalid HTML (`<label>`'s content model is phrasing content only, so a `<p>` inside it was already invalid; a nested `<label>` inside it doubly so), and it made a parent checkbox's accessible name swallow every descendant item's text too. Fixed by labelling only an item's own leading text (an id'd `<span>` plus `aria-labelledby` on the checkbox, no `<label>` at all), excluding any nested paragraph/sublist, in `src/renderer/features/chat/Markdown.tsx`. Verified via an SSR probe (`react-dom/server` + the real `react-markdown`/`remark-gfm`/`rehype-sanitize` pipeline and copies of the actual renderer logic): a footnote reference and its backlink resolve to an `id` that exists and matches exactly; two messages each with a `[^1]` get fully distinct ids/hrefs (`user-content-<msg-a>-fn-1` vs `user-content-<msg-b>-fn-1`); a nested/loose task list (`- [ ] parent\n\n  - [x] child`) renders with no `<label>` anywhere and each checkbox's `aria-labelledby` span contains only its own text, not its sublist's. `pnpm typecheck` and `pnpm build` both pass.
- [X] T066 [US1] Render Mermaid diagrams (constitution V review first): in the `code` renderer of `Markdown.tsx` handle fences tagged `mermaid`; load the `mermaid` npm package (MermaidJS, pinned) with a dynamic `import()` only when the first diagram appears; call `mermaid.initialize` with `startOnLoad: false`, `securityLevel: 'strict'`, and a theme that follows the app theme; render to an SVG string and show it as an inert `<img src="data:image/svg+xml;...">` (the CSP already allows `img-src 'self' data:`), never as inline SVG; draw only once the fence is closed (show the code block while the reply streams); give each diagram an accessible name and description and a Show source toggle; on a parse error, a source over a size cap, or a render timeout show the source block with a one-line reason; record the library, version, and the data-URL decision in `research.md` per FR-043, US1/AC9 (missing) -- Verified 2026-10-03: `mermaid` 11.17.2 pinned (postdates CVE-2026-41148/-41149, both moot anyway since the SVG never touches the live DOM); build output confirms a separate lazy chunk (`mermaid-*.js`, ~55 KB), absent from the main bundle. Live: a valid flowchart and sequence diagram each rendered as a `data:image/svg+xml` `<img>` (`role="img"`, `aria-label` naming the Mermaid diagram type) with a working Show source toggle (click flips the label and reveals the highlighted raw fence); a malformed fence (`A[Start -->> B{{{{`) fell back to source with "Diagram failed to render: Parse error on line 2: ..." above it; a 58 KB fence fell back with "Diagram failed to render: source is 58 KB, over the 50 KB cap"; a fence combining a `click ... call alert(...)` callback with `%%{init: {"securityLevel": "loose"}}%%` still rendered as an ordinary inert image (valid Mermaid syntax, so not a parse failure) with no script/onerror/javascript-href anywhere afterward and no new `window` property; an instrumented `transcript:patch` listener captured real `streaming: true` patches carrying an already-closed fence, confirming the draw-gate is the message's own `streaming` flag, not fence-closure text matching (the real streaming window was sub-50ms for this provider, too fast to screenshot). Not exercised live: the 5 s render-timeout path (code-reviewed only, via `Promise.race`); encountered but not designed for: Mermaid's own `maxEdges` limit (500) surfaced through the same error-reason fallback unprompted, which is the correct, if incidental, behaviour. **Remediated 2026-10-03 (issue #88, three-reviewer gate)**: added `suppressErrorRendering: true` to `mermaid.initialize` (on mermaid's own `secure` list, so a directive cannot re-enable it) -- without it, a parse error drew Mermaid's own error diagram into a temporary `document.body` node and threw before `removeTempElements()` ran, permanently leaking that node on every invalid/re-rendered diagram; corrected the code comment and research.md decision 14, which wrongly claimed `mermaid.render()` never touches the live DOM (it does, briefly, via a temporary div+SVG with `style.innerHTML` set from the diagram's own classDef CSS) -- the real live-render protection is the pinned version past the relevant CVEs, `securityLevel: 'strict'`, and Mermaid's internal DOMPurify pass, not DOM avoidance; the `<img>` wrapper's job is making the FINAL DISPLAYED output inert, a separate control. The 5 s `Promise.race` timeout's `setTimeout` is now cleared on every path (success, error, timeout, unmount) instead of leaking a timer on every successful render. Diagram images now get an accessible name/description parsed from the SVG's own `<title>`/`<desc>` (Mermaid's `accTitle`/`accDescr`, with a readable fallback word for the raw `diagramType` id when absent) via `aria-label`/`aria-describedby`, instead of just the raw internal `diagramType` string with no description at all. The Show-source button now has `aria-expanded`/`aria-controls` and a diagram-specific label, with the source panel kept always-mounted (toggled via `hidden`) for a stable `aria-controls` target. A theme flip no longer blanks `result` immediately, so the button/panel never drop out from under a focused control.
- [X] T067 [US1] Update the docs and verify live: `docs/DESIGN.md` (Chat), `plan.md`, `research.md`; then on the built app render a reply with the table from the user's screenshot, a task list, strikethrough, a footnote, a valid flowchart and sequence diagram, an invalid diagram, and an oversized diagram, and confirm tables and lists render, diagrams show as images with a working Show source toggle, invalid and oversized diagrams fall back to source with a reason, and the source shows (not a diagram) while the reply streams; confirm hostile input stays inert: raw `<script>` and `<img onerror>`, a `javascript:` link, a Mermaid `click` callback, and a `%%{init}%%` directive that tries to lower `securityLevel`; check the first-diagram load time and that the app starts as fast as before per FR-042, FR-043 (partial) -- Verified 2026-10-03: `docs/DESIGN.md` Chat, `plan.md`, and `research.md` updated (new research.md decision 14, FINDINGS item 26); driven over CDP against the built app with a real `omp` 18.4.12 agent (scratch repo + scratch `userData`, two chat turns asking the agent to echo fixed markdown/mermaid blocks verbatim, plus a third turn for the oversize case). Confirmed live: real `<table>` rendering (fixes FINDINGS item 25), task-list checkboxes, strikethrough, a resolved footnote; flowchart and sequence diagrams as inert `<img>`s with a working Show-source toggle; invalid-syntax and oversized (58 KB) diagrams both fell back to source with their one-line reason; the hostile click+`%%{init}%%` diagram rendered as an ordinary inert image, and a separate raw `<script>`/`<img onerror>`/`javascript:` turn also stayed inert -- `document.querySelectorAll('script').length === 1` (only the app's own bundle) and no new `window` property after either hostile turn. `pnpm build` output confirms Mermaid is a separate lazy chunk (`mermaid-*.js`, ~55 KB), never in the main bundle; its first render after the transcript mounted (a local `file://` chunk read, not a network fetch) completed faster than a 100 ms poll could resolve, so no meaningful load-time number could be measured beyond "sub-100ms, no visible delay" -- `pnpm typecheck` and `pnpm build` both pass unchanged otherwise, so app start time is not affected. NOT-PERFORMED (not practical to force deterministically): a live render-timeout (5 s) capture -- verified by code review only. **Remediated 2026-10-03 (issue #89, three-reviewer gate -- code-reviewer, test-reviewer, accessibility-auditor)**: fixed an orphan-DOM leak on every invalid/re-rendered diagram (`suppressErrorRendering: true`), corrected the off-DOM/DOM-avoidance claims in this doc's sibling research.md decision 14 and the `Markdown.tsx` code comment, replaced the per-`streaming`-flip `buildComponents` factory (which remounted the whole markdown subtree, including every highlighted `CodeBlock`, on every stream-end) with a static `components` map plus a `StreamingContext`, gave each diagram image a real accessible name/description sourced from its own `accTitle`/`accDescr` (previously just the raw `diagramType` string, no description), let GFM footnote reference/backref anchors render as real links instead of being caught by the relative-href block, labelled task-list checkboxes with their item text, added `aria-expanded`/`aria-controls` to the Show-source toggle (source panel now always-mounted via `hidden`, not conditionally rendered), stopped a theme flip from blanking the diagram and dropping focus, cleared the leaked render-timeout timer, and widened the Show-source hit target plus a `role="status"` on the failure message. Re-verified live (CDP, scratch repo + scratch `userData`, built app): the original T065/T066/T067 table/task-list/strikethrough/footnote/diagram/hostile-input scenarios still hold unchanged; additionally confirmed a malformed-Mermaid fence leaves no new/orphan node under `document.body` (`document.body.children.length` unchanged before/after, across repeated malformed renders and a theme flip); a streamed reply containing a code fence keeps its Shiki-highlighted markup across the streaming-to-settled transition (tagged node survives, no remount, no flash back to a bare `<pre>`); a diagram with `accTitle`/`accDescr` directives exposes them as the image's accessible name/description instead of the generic fallback, and one without them falls back sanely; a footnote's reference number and backlink arrow are both real, focusable, correctly-labelled links (not bare text/glyph); `pnpm typecheck` and `pnpm build` both pass clean after the remediation.

## Phase 17: Convergence

- [X] T068 [US5] Add the session details IPC: in main add `sessions.diffStat(id)` returning the diff stat described below and `sessions.revealWorktree(id)`; `diffStat` (argument arrays, no shell, read-only: no `git add`, no index change) runs `git diff --numstat <merge-base of HEAD and baseBranch>` for committed and uncommitted edits to tracked files and `git ls-files --others --exclude-standard` for new untracked files, reads each untracked text file in main to count its lines as additions (at most 200 files and 1 MiB per file, binary files count as a file with 0 lines, and `partial: true` is returned past the caps), with a 3 s timeout overall, and returns `{ files, additions, deletions, partial } | null`, `null` when the worktree is missing, the Base branch no longer exists, or git fails; `revealWorktree` calls `shell.openPath` on the Session's worktree after an `fs.stat` and returns a `worktree-missing` error when it is gone; both look the worktree up in the registry by Session id and never take a path from the renderer (constitution V); add the git helper beside `src/main/git/worktrees.ts`, the handlers in `src/main/ipc/sessions.ts`, the channels in `src/shared/ipc.ts` and `src/preload/index.ts`, and the rows in `specs/001-core-session-workspace/contracts/ipc.md` per FR-039, FR-044 (missing) -- Verified 2026-10-02: in an isolated instance, `sessions.diffStat` after one committed edit, one uncommitted edit, and one new untracked file returned `{files:3,additions:6,deletions:0,partial:false}`, exactly matching a direct `git diff --numstat <merge-base>` (2 tracked files, +2/+1) plus the untracked file's own 3 lines computed independently; `null` after the worktree was deleted. `revealWorktree` opened a real Explorer window titled after the worktree folder, and returned `{ok:false,error:{code:'worktree-missing',...}}` (never throwing) once the folder was gone. Remediated post-review (issue #98, quality-gate findings): untracked paths are now read via `ls-files -z` and split on NUL instead of newline-trim, fixing silent under-counting of non-ASCII/special-character filenames (verified live with a `café.txt` untracked file: now `additions: 3`, `partial: false`, previously 0) and no longer corrupting real leading/trailing spaces; the numstat command switched from porcelain `git diff --numstat` to plumbing `git diff-index --no-ext-diff --no-textconv --numstat`, which does not refresh/write the index (verified live: committed a file, touched its mtime, ran `diffStat`, confirmed via `git ls-files --debug` the stored mtime no longer changes), removing the `index.lock` contention risk with a concurrent `git add`/`git commit`; `revealWorktree` now checks `stat.isDirectory()` before `shell.openPath`.
- [X] T069 [US5] Replace the tooltip of T056 (b) with the details card: add a shadcn `HoverCard` (`src/renderer/components/ui/hover-card.tsx`, from `radix-ui`, matching the sibling ui files) and wrap each `SessionRow` open button in `src/renderer/features/sessions/SessionList.tsx` with it (opens on hover and on keyboard focus after about 500 ms, stays open while hovered, Esc dismisses, does not cover the row, not shown while renaming); the card shows the `StateIcon` with the status label, the relative last-activity time, the repository (lucide `FolderIcon`), the branch (`GitBranchIcon`) with the Base branch as muted "from <base>", the worktree's absolute path (wrapping, muted and marked missing when the summary says the worktree is missing), the provider, model, and reasoning effort from T062's `lastModel` and `lastThinkingLevel` ("Model not known yet" when absent), and the files changed from `sessions.diffStat` fetched when the card opens ("Counting changes..." then "N files changed +A -D" (marked "partial" when `partial` is true) with the +/- carrying text so colour is not the only cue, or a muted "Not available"); it carries a Copy path button (`navigator.clipboard.writeText`, then a toast "Path copied"; if the sandboxed renderer refuses it, route it through an allowlisted main-process clipboard channel) and an Open in file explorer button (`sessions.revealWorktree`; a failure goes through `notify`); add the same two actions ("Copy worktree path" and "Open worktree folder") to the row `DropdownMenu` so they work from the keyboard, since Radix hover cards are not keyboard-reachable; this supersedes T056 (b) and depends on T062 and T068 per FR-039, FR-044, US5/AC6 -- Verified 2026-10-02: T056/T062 have not landed (both still `[ ]`), so no provider/model/effort field exists on `SessionSummary` to read -- the readout is correctly omitted rather than invented, everything else built as specified. Live in an isolated instance: hover and keyboard-focus both open the card (`data-state` flips to `open`); Esc flips it to `closed` immediately; trigger rect `x:8-242` and content rect `x:250-570` never overlap (side="right"); double-clicking the row to rename shows the rename `<input>` with zero `[data-slot="hover-card-content"]` in the DOM, confirming it is suppressed, not merely hidden. Copy path: `navigator.clipboard.writeText` threw `NotAllowedError` in the sandboxed renderer every time (confirming the fallback is load-bearing, not defensive-only, docs/spike/FINDINGS.md item 26), the `clipboard.writeText` IPC fallback returned `{ok:true}` and the "Path copied" toast appeared; the OS clipboard could not be read back to confirm bytes -- `Get-Clipboard`, .NET `Clipboard`, and `clip.exe` all fail identically in this sandbox, a pre-existing environment limitation (FINDINGS item 26). Remediated post-review (issue #99, quality-gate findings): the open button now carries `aria-describedby` pointing at a visually-hidden (`sr-only`) sibling description holding the base branch, worktree path, and missing state as plain text (not the portaled `HoverCardContent`, which is not yet mounted at focus time due to `openDelay`) -- verified live by reading the row's computed accessible description via the DOM, which now includes the base branch and worktree path text regardless of hover/focus state; each card-open now tracks a request generation in a ref so a stale `diffStat` response from a superseded open can no longer overwrite a newer one; the model/provider/effort slot now renders the documented "Model not known yet" placeholder (T062 still has not landed) instead of being omitted, so this task is no longer partial; `SessionRow`'s diff-stat state, clipboard/reveal actions, and the card's own JSX were extracted into `SessionDetailsCard.tsx` and a `useWorktreeActions` hook (shared with the row's `DropdownMenu`), with `StateIcon`/`STATUS_LABEL`/`formatRelativeTime`/the new `formatDiffStat` (handles singular "file") split into `sessionDisplay.tsx`. Open in file explorer opened a real Explorer window; after the worktree was deleted it showed a `notify` toast "Worktree missing: ..." instead. Both actions are reachable from the row `⋮` menu (`Rename, Copy worktree path, Open worktree folder, Archive, Delete…`) and worked identically from there.
- [X] T070 [US5] Update the docs and verify the card live (supersedes the tooltip checks of T058; T056 (a) and T057 are unchanged): `docs/DESIGN.md` session list (details card, delay, row-menu actions), `CONTEXT.md` if it calls the hover a tooltip, `contracts/ipc.md`, and `quickstart.md` Story 5; then on the built app in an isolated instance: hovering a row opens the card after the delay with the status, time, repository, branch, worktree path (equal to the Session's `worktreePath`), model and effort, and a files-changed count equal to `git diff --numstat <merge-base>` plus the untracked files in that worktree after one committed edit, one uncommitted edit to a tracked file, and one new untracked file; keyboard focus on the row opens it after the delay and Esc dismisses it; the pointer can move into the card without it closing; Copy path puts the exact path on the clipboard (read it back with `Get-Clipboard`); Open in file explorer opens an Explorer window on that folder; a Session whose worktree folder was removed shows the path marked missing, "Not available" for files changed, and a notify error from Open; and both actions work from the row menu with the keyboard per FR-039, FR-044 (partial) -- Verified 2026-10-02: `CONTEXT.md` does not call the hover a tooltip anywhere (grepped, no match), so left unchanged; `docs/DESIGN.md`, `contracts/ipc.md`, `quickstart.md` Story 5 updated. Live, isolated instance (scratch repo + registry, real `omp` agent): created a Session (`amber-sparrow`), committed one edit to `tracked-a.txt` (+2), left one uncommitted edit to `tracked-b.txt` (+1), added one new untracked `untracked-c.txt` (3 lines) -- `sessions.diffStat` returned `{files:3,additions:6,deletions:0,partial:false}`, matching a direct `git diff --numstat <merge-base>` (`2\t0\ttracked-a.txt`, `1\t0\ttracked-b.txt`) plus the untracked file's independently-counted 3 lines; the rendered card showed the identical "3 files changed +6 -0" string. Keyboard focus and hover both open the card (confirmed via `data-state`); Esc closes it immediately; the pointer entering the content does not close it. Deleted the worktree folder directly (outside Refract) and restarted the scratch instance (the real re-check path: a Session with no live runtime this run gets `existsSync`-checked fresh in `SessionManager.summaries()`) -- the next hover showed the path with "(missing)", "Not available" for files changed, and Open in file explorer produced a `notify` toast "Worktree missing: ..." instead of opening anything; `sessions.revealWorktree` returned `{ok:false,error:{code:'worktree-missing',...}}`. Both actions also worked from the row `⋮` menu via keyboard (Tab to the `⋮` button, Enter, item click). Gaps (docs/spike/FINDINGS.md item 26, both environment limitations, not app defects): the exact ~500 ms timing and the exit-animation-driven unmount could not be measured/observed precisely -- this CDP-attached renderer reports `document.hidden: true` throughout, which throttles Radix's open/close timers and stalls the `animate-out` `animationend` that normally unmounts a closed card (the *state* transition itself, which is what the row-overlap/suppression/dismissal guarantees depend on, was confirmed correct and immediate via `data-state`); and the OS clipboard could not be read back in this sandbox by any method to byte-confirm the Copy path write (the IPC call itself returned `ok:true` with no thrown error). Remediated post-review (issue #100, quality-gate findings): `contracts/ipc.md` updated for the `diff-index`/`ls-files -z` command change and the `revealWorktree` directory check and `worktree-failed` code reuse; re-verified live after the fixes in the same scratch-repo scenario (committed + uncommitted + untracked edits, plus a new untracked `café.txt` with 3 lines) -- `sessions.diffStat` still matched the card's rendered string, the non-ASCII untracked file now counted correctly, and the row's accessible description (queried via the DOM) included the base branch and worktree path text.

## Phase 18: Convergence

- [X] T071 [US2] Probe OMP for the data the new chat lines need (constitution IV): on the supported OMP 18.4.x answer an `ask` question (a choice and a free-text one) and cancel another, then record in `docs/spike/FINDINGS.md` as a new numbered item and in `contracts/omp-usage.md` (a) what `get_messages` history returns for the answered question (question text, options, the answer text, cancellation) so a reopened Conversation can show them, (b) whether thinking parts and tool-call parts carry start and end times or only message timestamps, so "Thought for Ns" and the turn total can be computed from history as well as live, and (c) how the `ask` tool call itself appears in a live turn next to the `extension_ui_request` that Refract answers, (d) how one `task` call that starts several subagents at once (its `tasks` array, each with a `name`) shows up: whether `tool_call_update` progress (or `set_subagent_subscription` frames) carries a per-subagent id or name, status, and timing, which FINDINGS C6 does not record, and (e) how an IRC message between a subagent and the main agent appears live and in `get_messages` history (message type, sender, recipient, text, timestamp), and (f) the message role or custom type of an `<advisory>` note live and in history (the builder in `src/main/omp/transcript.ts` shows a `custom` message with `display: true` as a notice and drops `developer` messages) and whether an unknown role or custom type can be recognised so it still reaches the chat as a generic baseline line; T072 to T076 follow the result per FR-009, FR-045, FR-046 (missing)
- [X] T072 [US2] Keep the question, the answer, and the user's name with the transcript: build the answered question from the agent's own `ask` tool item (its `args` hold the question and options, its `output` the chosen answer; both come back through `get_messages` on reattach, so they survive a restart, which `request` items do not), shaped as T071 records, and show a `request` item that has resolved only as the live card until the matching `ask` item takes over; if T071 shows the `ask` result does not carry the answer, extend the `request` `TranscriptItem` (`src/shared/model.ts`, `data-model.md`) with the question and answer text filled in `SessionAgent.answerRequest` and `resolvePendingRequest` (`src/main/omp/SessionAgent.ts`) and rebuild them in `src/main/omp/transcript.ts` from whatever history does carry; add `repositories.userName(id)` returning the git `user.name` of that repository (`git config --get user.name`, argument arrays, read-only) or the Windows user name when git has none, cached per repository, with the channel in `src/shared/ipc.ts`, `src/preload/index.ts`, and `contracts/ipc.md` per FR-045 (missing) -- Verified 2026-10-03: `repositories.userName(id)` added (`git config user.name` in the repository, falling back to `os.userInfo().username`, cached per repository id); FINDINGS item 22 showed the `ask` answer already surfaces in `toolResult`, so the `request` `TranscriptItem` extension was not needed -- only the `Transcript.tsx` suppression rule (a resolved question's `request` item renders nothing once the matching `ask` tool item resolves) was added. Live on the built app the resolved name was the scratch repository's real `git config user.name` ("Refract Tester"), confirmed in the T073 row.
- [X] T073 [US2] Render the answered question like OMP: replace `ResolvedRequestSummary` for questions (`src/renderer/features/chat/RequestCard.tsx`, `Transcript.tsx` `request` case) with a collapsed `Collapsible` row "Asked user:" plus the question cut off to one line, expanding to the full question and its options as plain text, and below it an indented "Answer:" row with a small round avatar of the user's initials, the name, and the answer ("Cancelled" for a cancelled question); the trigger is a button with `aria-expanded`; approvals keep their one-line resolved summary; a pending question stays the `RequestCard` per FR-018, FR-045, US2/AC6 (partial) -- Verified 2026-10-03 on the built app (scratch repo, scratch `userData`, a real `omp` 18.5.1 agent, CDP): a multiple-choice `ask` answered "Red" collapsed to "Asked user: Red or Blue?", expanded to the full question, the Red/Blue options as a plain list, and an indented "Answer: Refract Tester: Red" row with an "RT" avatar (the scratch repo's real `git config user.name`); the live question stayed the `RequestCard` until answered; a separate cancelled question rendered "Answer: ... Cancelled" the same way (FINDINGS item 27). Live verification also found the real `ask` toolCall args nest a `questions[]` batch (`args.questions[0].question`/`.options[].label`), not the flat shape FINDINGS item 22 assumed for the question side -- recorded as FINDINGS item 27 and fixed in `readAskArgs`. NOT verified live: approvals keeping their one-line resolved summary (the CDP session ran `--approval-mode=auto`, which produces no pending approval to decide).
- [X] T074 [US1] Group consecutive calls to the same tool: add a pure helper (for example `groupToolItems` beside `Transcript.tsx`) that merges runs of adjacent `tool` items with the same `tool` into one group, and render a group as a collapsed `ToolGroupRow` in `ToolRow.tsx`: status icon (running while any call runs, failed when any failed), the tool name, the last call's target, and "+ N others" with ", N failed" added when any failed (text, not colour alone); expanding shows each call as its own expandable `ToolRow`; a run of one renders as the plain `ToolRow`; thinking lines, questions, notices, and a different tool end a run, a call waiting for approval or a pending question is never folded into a group, and `task` (subagent) calls are never grouped (T078 handles it); keep expansion state keyed by the group's first item id so it survives streaming updates per FR-008, FR-016, FR-019, SC-008, US1/AC3 (partial) -- Verified 2026-10-03 on the built app: a turn with `bash echo alpha`, a plain assistant-text sentence, then `bash echo beta`/`bash false`/`bash echo gamma` rendered `alpha` standalone (the assistant-text ended the run) and the other three as one collapsed line reading "bash echo gamma  + 2 others, 1 failed" with a red cross icon; expanding it showed each of the three as its own independently-expandable row with its own real status (done/done/error); `ask` and `task`/subagent items are confirmed excluded from grouping in `groupToolItems`. Re-verified this remediation round (standalone harness against the real `groupToolItems`, not a live CDP session): a run of one keys by its own id, and a run of two now keys the `ToolGroup` by that SAME first-item id (never a `group:`-prefixed id), so the key is identical across the single-row <-> grouped-row transition and React never force-unmounts a focused/expanded row when a second consecutive call to the same tool arrives.
- [X] T075 [US1] Make the Thinking row a single collapsed line: in the `thinking` case of `Transcript.tsx` show "Thinking" with a faint one-line preview of the latest text while it streams and "Thought for Ns" once done, collapsed by default and expandable to the full text through the existing markdown path; take the duration from the source T071 verifies, or if history carries none store `startedAt` and `endedAt` on the `thinking` item in `src/main/omp/transcript.ts` and `src/shared/model.ts`; render a thinking line with no known duration, such as one in a reopened Conversation, as just "Thought", never a guessed number per FR-009, US1/AC4 (partial) -- Verified 2026-10-03 on the built app: history carries no per-part timing (only one `timestamp` for a whole message's `content[]`), so `startedAt`/`endedAt` are stamped live in `transcript.ts` and omitted entirely when loading from `fromHistory`; a reasoning-heavy live prompt produced a real non-empty `thinking` part, shown collapsed as "Thought for 1s", expanding to the full chain-of-thought text through `Markdown`. NOT verified live: the reopened-Conversation "just \"Thought\", never a guessed number" case (no history Conversation with a thinking part was reopened in that pass); confirmed only by reading the `!captureTiming` code path, which omits `startedAt`/`endedAt` entirely when `fromHistory` builds the item.
- [X] T076 [US1] Add the turn total-time line: end each turn's activity block (from its user message to the last item, or to now while it runs) with a muted single line showing the elapsed time ("28s", "1m 14s", "2h 3m"), updating each second while the turn runs and marked `aria-hidden` until the turn ends so a screen reader reads only the final value; compute it from item times (T071 shows what history carries) and omit the line for a turn in a reopened Conversation whose history carries no usable timing per FR-046, US1/AC4 (partial) -- Verified 2026-10-03 on the built app: every live turn ended with a muted elapsed line (observed "5s", "16s", "24s", "26s", "56s", "65s" across turns), ticking every second while running (`aria-hidden` while running, readable once settled); computed from a per-item live-arrival map (`transcript-store.ts`'s `receivedAt`, cleared on every `reset`) falling back to each item's own `startedAt`/`durationMs`/`endedAt`/`at`. The "omits the line when no usable timing exists" half of that claim was NOT actually exercised live in this pass, and a later quality-gate finding showed the code at the time could never omit the line for a reopened turn at all: `computeTurnEnd` summed every item in the turn INCLUDING the turn's own `user` item, whose `at` always exists (even the `0` sentinel `fromHistory` falls back to), so the end time was never `undefined`. Fixed in a later remediation pass (`computeTurnEnd` now skips the turn's own `user` item; `TurnTotalLine` treats `userItem.at === 0` as no usable timing) and reverified this round in a standalone harness against the real `computeTurnEnd`: a turn containing only a `user` item with `at: 0` now returns `undefined`, and a turn whose only other item is a history-built `subagent`/`tool` with no `startedAt`/`durationMs` also returns `undefined` rather than `NaN`/a garbage value.
- [X] T077 [US1] Update the docs and verify live: `docs/DESIGN.md` Chat (single collapsed lines, grouping, the Thinking line, Ask rendering, the turn total), `data-model.md`, `contracts/ipc.md`, and `quickstart.md` Story 1 and 2; then on the built app in an isolated instance: a turn with three consecutive `bash` calls shows one collapsed line with the last command and "+ 2 others" that expands to three rows, calls separated by another tool or a thinking line do not group, a failed call in a group shows the group as failed, the Thinking line shows a preview while streaming and "Thought for Ns" after, an answered `ask` shows "Asked user:" collapsed and expands to the full question with "Answer:" below it, indented, carrying the git `user.name`, a cancelled one shows "Cancelled", reopening the Conversation and restarting the app keep both, the turn total line appears, a `task` call that starts two subagents shows two collapsed subagent lines never grouped, an IRC message between a subagent and the main agent shows as one collapsed line, and every expander works from the keyboard per FR-008, FR-009, FR-045, FR-046, FR-047, FR-048 (partial) -- Verified 2026-10-03 against a real `omp` 18.5.1 agent over CDP (scratch repo/userData, FINDINGS items 27-28): three/four-`bash` grouping with "+ N others"/", N failed" confirmed, non-grouping across an assistant-text break confirmed, `ask` question/options/answer/git `user.name` confirmed end to end (a cancelled question's "Cancelled" answer was NOT driven live in this pass -- corrected below, this round's own completion report lists it under not-driven-live, and an earlier draft of FINDINGS item 27 wrongly claimed it was), Thinking preview-then-"Thought for Ns" confirmed, turn-total lines confirmed on every turn. NOT verified live within this pass, for lack of remaining budget: the cancelled-ask "Cancelled" answer, the two-subagent/IRC-message scenarios, a restart-then-reopen check of the turn-total/user-name persistence, and per-row keyboard activation -- these are exercised by the code paths (`transcript.ts`'s subagent/`agent-message` handling, `receivedAt` cleared only on `reset`, Radix `CollapsibleTrigger`'s native keyboard support) but not driven live; flagged to Main for a follow-up check. Also found and recorded (FINDINGS item 28, out of scope for this patch): a pre-existing `applyPromptResultNotice`/`NoticeRow` crash when `prompt_result.error` is a non-string object (observed from a real provider refusal). Re-verification pass (this remediation round, a later quality gate found four HIGH defects in this branch, since fixed): the subagent-error-state fix, the turn-total-hidden-on-reopen fix, and the ToolRow focus-preservation-on-grouping fix were each re-verified against the real shipped functions (`applyBatchTaskResult`, `finalizeLiveTranscript`, `mergeLiveTranscript`, `computeTurnEnd`, `groupToolItems`, `buildAssistantItems`) via a standalone harness driving real synthetic OMP frames/items through them -- not mocked, but also not rendered through a live Electron/CDP session. The two-subagent/IRC-message scenarios, restart-then-reopen persistence, and per-row keyboard activation remain NOT driven live. Final live-verification pass (this round, driven over CDP against a real `omp` 18.5.1 agent, scratch repo/userData, same pattern as item 27-28): all four remaining checks now confirmed. A `task()` batch starting AlphaProbe and BetaProbe in one call rendered two separate collapsed SubagentRow lines (never grouped with each other or with the surrounding `todo`/`wait` tool rows), each independently expandable to its own prompt/result -- this also surfaced and fixed a real bug: the `wait` tool's own `tool_execution_end` carries the authoritative per-subagent `details.jobs[]` (keyed by `id`, not `jobId`, and carrying the full plain-text `resultText`) for any subagent a `wait` call actually waited for, which `applyAsyncResultJobs` never consumed (only the separate `custom`/async-result message was read) -- BetaProbe was left spinning "running" forever even though the turn had already ended and summarized it; fixed by routing any tool's `details.jobs[]` through the same job-application path and matching `resultText`/`id` (`transcript.ts`: `jobsFromDetails`, `applyAsyncResultJobs`). A subagent whose completion arrives only via the async-result message with no `resultText`/`schema.data` (AlphaProbe here) still shows its own name as a placeholder result -- a real OMP-side gap (that message never carries the actual output in this case), documented rather than guessed at. An IRC message prompted explicitly (a subagent instructed to `write agent://Main` before finishing) rendered as one collapsed `AgentMessageRow` "Messenger to main agent" with a direction icon and a one-line preview, expanding to the full text -- the wire shape matches the existing defensive `tryBuildAgentMessageFromUnknownFrame`/custom-message detection with no changes needed; FINDINGS item 22(f)'s `(missing)` tag can be dropped (see T079's own note). A full restart (whole Electron process tree killed, relaunched against the same scratch `userData`, same Conversation reopened) kept the answered-ask row's "Answer: Stuart Hopwood: Red" (the real git `user.name`) intact, and kept the turn-total line ("Turn took 7s") for the turn that ended with an `agent-message` item (whose `.at` is a real historical timestamp, unlike `tool`/`subagent` items which lose `startedAt` on reopen per the #107 fix) -- confirming that HIGH fix holds; a separate turn with no timeable item at all (an answered `ask` alone) correctly omitted its turn-total line on reopen, per that same fix's documented intent, not a regression. Keyboard-only activation (real Tab/Shift+Tab to focus, Enter or Space to toggle, never synthetic dispatch) was confirmed on one of each: ToolRow ("Done wait"), ToolGroupRow ("bash echo three + 2 others"), SubagentRow ("Messenger"), AskQuestionRow ("Asked user: Pick a color"), the Thinking line ("Thought"), a long NoticeRow (the advisory notice), and `AgentMessageRow` as a bonus -- every one's `aria-expanded` flipped true-then-false across two activations. Fourth remediation round (2026-10-03): the prior round's "ToolRow focus-preservation-on-grouping fix" (claimed re-verified above) was itself still broken -- it only made the outer wrapper's key stable (`run[0].id`), but `TranscriptRow` still rendered a lone call through `ToolRow` and a run through `ToolGroupRow`, two different component types at the same tree position, so React unmounted the whole subtree and dropped focus to `<body>` the instant a second consecutive call to the same tool arrived. Root-caused and fixed: `groupToolItems` now always wraps a run -- including a run of one -- in a `ToolGroup` (never a bare `tool` item), and `ToolGroupRow` was restructured to always return exactly one top-level `CollapsedLine` regardless of the run's length (a first fix attempt that kept a `group.items.length === 1 ? <ToolCallRow .../> : <CollapsedLine>...` branch inside `ToolGroupRow` itself reproduced the identical bug one level down, caught by live testing below, before landing the final always-`CollapsedLine` shape); only the `CollapsedLine`'s *children* differ by run length, never its presence or type. Live-verified in a real browser DOM (Chromium via CDP, the actual shipped `groupToolItems.ts`/`ToolRow.tsx`/`CollapsedLine.tsx`/`collapsible.tsx` source bundled unmodified with esbuild, real `radix-ui` `Collapsible`, no mocks): `document.activeElement` was tabbed (real keyboard `Tab`) onto the lone call's `[data-slot="collapsible-trigger"]` button, then expanded with a real `Enter` keypress (`aria-expanded="true"`, content `data-state="open"`); a second identical `bash` call was then appended to the same run (`groupToolItems` promoting it from a 1-item to a 2-item group, the exact repro). After that transition: `document.activeElement === trigger` stayed `true`, `aria-expanded` stayed `"true"`, and the `CollapsibleContent` stayed `data-state="open"` -- both focus and the expanded state survived the grouping transition, confirmed by a before/after DOM read, not inferred from the absence of a visual glitch. `pnpm typecheck`/`pnpm build` pass.
- [X] T078 [US1] Render each subagent as its own single collapsed line: in the transcript builder (`src/main/omp/transcript.ts`) and `ToolRow.tsx` treat each subagent as its own row, so a `task` call whose `tasks` array starts several subagents yields one row per subagent, each with that subagent's `name` or task text from the call's arguments, its own status and duration from the progress T071 records (the call's own status and duration when the progress carries no per-subagent data), collapsed by default and expanding to its prompt and result as plain text; never group subagent rows with `groupToolItems` (T074); keep each row's identity (the subagent's name) stable so activating it can open that subagent in the spec 004 panel later, noting in the row that its live stream is in the Subagents panel once that exists per FR-008 (partial) -- Implemented per FINDINGS item 22(e): a `task` toolCall's `args.tasks[]` yields one `subagent` `TranscriptItem` per entry (`subagent:<toolCallId>:<index>`, stable across reattaches), `tool_execution_end`'s `details.progress[]` flips a subagent to done/error only once its own entry says so, and a later `custom`/`async-result` message's `details.jobs[]` (matched by the `id` recorded from `progress[]`, falling back to `label === name`) supplies the duration and plain-text result; a malformed/argument-less `task` call falls back to a plain `tool` item instead of being dropped. `pnpm typecheck`/`pnpm build` pass; the two-subagent batch scenario itself was not driven live in this pass (see T077's note) -- `SubagentRow`/`groupToolItems`'s exclusion were otherwise exercised by the build. The "note in the row that its live stream is in the Subagents panel" requirement is STILL OPEN, not implemented: spec 004's Subagents panel does not exist yet anywhere in this codebase (every one of spec 004's own tasks is unchecked), so `SubagentRow` adds no such note rather than referencing a panel that is not there; add it when spec 004 lands. Re-verified this remediation round (standalone harness against the real `applyBatchTaskResult`, `finalizeLiveTranscript`, `mergeLiveTranscript`, and `buildAssistantItems`, not a live CDP session): a hard batch failure (`isError:true`) now flips every subagent row to `error` instead of leaving a still-"pending" one spinning as "running" forever; a running subagent now settles to `error` on crash/stop/restart (`finalizeLiveTranscript`) and is carried across a restart the same way a running tool call is (`mergeLiveTranscript`); and a subagent row now builds in place at its own `task` toolCall's position, confirmed to render before a later `read` tool call issued in the same message, instead of appending to the whole transcript's end. Live-verified this pass (two-subagent batch scenario, CDP against a real `omp` 18.5.1 agent, scratch repo/userData): a single `task()` call starting AlphaProbe and BetaProbe rendered as two separate collapsed SubagentRow lines, each with its own name/status/duration, neither grouped with the other nor with the surrounding `todo`/`wait` tool rows, each independently expandable to its own prompt and result. This run also exposed a real bug beyond the "pending forever" case #105 already covered: the `wait` tool's own `tool_execution_end.details.jobs[]` (keyed by `id`, carrying the full plain-text `resultText`) is a second, equally authoritative completion carrier this code never read (only the separate `custom`/async-result message's `jobs[]`, keyed by `jobId`, was applied) -- a subagent a `wait` call actually waited for was left spinning "running" forever even after the turn ended and the assistant had already summarized its result. Fixed in `transcript.ts`: `applyAsyncResultJobs` now matches either key name and prefers `resultText` over `schema.data`/`label`; `applyToolExecutionEnd`/`attachToolResult` apply any tool's `details.jobs[]` through it, not only `task`'s own. A subagent whose only completion signal is the async-result message with neither `resultText` nor `schema.data` (AlphaProbe here) still falls back to showing its own name as the result -- that message genuinely carries no result text in this shape; a real OMP-side gap, not a Refract bug, left documented rather than papered over. Fourth remediation round (2026-10-03): the prior round's subagent-error-state fix (claimed re-verified above) still left a FAILED or CANCELLED subagent job rendering as `done` with a green check, because both `mapProgressStatus` and `applyAsyncResultJobs` mapped every status that wasn't `'pending'`/`'running'` straight to `'done'`, and `errorText` (confirmed present on the installed omp 18.5.1 binary's own failed/cancelled job records by direct binary inspection) was dropped in favour of `label`. Fixed in `transcript.ts`: `mapProgressStatus` now maps `'failed'`, `'error'`, `'cancelled'`, and `'aborted'` to `'error'` explicitly (only `'pending'` stays `'running'`, everything else -- including an unrecognized or absent status -- still defaults to `'done'`); `applyAsyncResultJobs` applies the same four-way failed/cancelled check to the async-result job carrier and, when it fires, prefers `job.errorText` over `resultText`/`schema.data`/`label` for the displayed result text. Re-verified against the real shipped `applyFrame` (not mocked: the actual `transcript.ts` source bundled unmodified with esbuild and run in Node) with three synthetic cases matching the installed binary's real shapes: (1) an async-result message with `{status: 'failed', errorText: 'Task impossible: cannot divide by zero'}` produced `{status: 'error', result: 'Task impossible: cannot divide by zero'}` (previously `{status: 'done', result: 'AlphaProbe'}`, the subagent's own `label`); (2) the same with `{status: 'cancelled', errorText: 'Cancelled by user'}` produced `{status: 'error', result: 'Cancelled by user'}`; (3) a `tool_execution_end`'s own `details.progress[]` entry with `status: 'failed'` (the `mapProgressStatus` path, no `errorText` available at that stage) produced `{status: 'error'}`, not `'done'`. `pnpm typecheck`/`pnpm build` pass.
- [X] T079 [US1] Show messages between agents as lines: render each IRC message between a subagent and the main agent (or between subagents) as its own single collapsed line from the baseline component of T080, with a direction icon, "<sender> to <recipient>", and a one-line preview, expanding to the full message as plain text; build the item in `src/main/omp/transcript.ts` and handle the live frame in `src/main/omp/SessionAgent.ts` as T071 (e) shows, add the item kind to `src/shared/model.ts` and `data-model.md`, never group or hide them, and show them in a reopened Conversation if history carries them per FR-048 (missing) -- FINDINGS item 22(f) could not confirm OMP's wire shape for this at all (no frame observed within the probe's timeout), so `agent-message` is read defensively rather than against one exact assumed shape: a `custom` message whose `customType` names a plausible IRC spelling or whose `details` carries `from`/`sender` fields (`transcript.ts`), and (the other hypothesis, a top-level frame outside the message lifecycle) the same shape check in `SessionAgent.onFrame`'s `default` case. `AgentMessageRow` renders it on the T080 baseline, never grouped (`groupToolItems` only ever sees `tool` items). `pnpm typecheck`/`pnpm build` pass; not driven live in this pass since no real IRC occurrence was triggered -- flagged to Main, the shape should be corrected against a real observed frame before relying on it. Constitution Principle IV forbids designing around an open FINDINGS item until a probe resolves it (FINDINGS item 22(f) is still open), so this wire shape remains an unconfirmed guess and the `(missing)` tag stands until a real frame is observed. Live-verified this pass (CDP against a real `omp` 18.5.1 agent, scratch repo/userData): a subagent instructed to `write agent://Main` with a literal message before finishing its own task produced a real IRC-style frame that rendered as one collapsed `AgentMessageRow` reading "Messenger to main agent" with a direction icon and a one-line preview of the message, expanding on activation to the full text as plain text, never grouped with the surrounding rows. The existing defensive detection (`tryBuildAgentMessage` in `transcript.ts`, `tryBuildAgentMessageFromUnknownFrame` in `SessionAgent.ts`) matched this real occurrence with no code changes needed. FINDINGS item 22(f) is resolved: a real subagent-to-parent IRC frame has now been observed and rendered correctly end to end, so the `(missing)` FR-048 tag can be dropped and this item moved from "unconfirmed guess" to "confirmed live".
- [X] T080 [US1] Add the chat baseline component and move every output kind onto it: create one shared collapsed-line component (for example `CollapsedLine` in `src/renderer/features/chat/CollapsedLine.tsx`) with an icon slot, a short label, a one-line summary that truncates with an ellipsis, a status or duration slot, a `Collapsible` expansion, and a non-colour cue for warnings and errors; build `ToolRow`, `ToolGroupRow`, the thinking line, the answered question, decided approvals (`ResolvedRequestSummary`), the subagent and IRC lines, and `NoticeRow` (notices and command output) on it so each adds only its own extras; document the baseline and the rule that a new output kind starts from it in `docs/DESIGN.md` Chat; implement this before T073 to T079 per FR-047 (partial) -- Verified 2026-10-03: `CollapsedLine` built first and landed under every other output kind (`ToolRow`/`ToolGroupRow`/`SubagentRow`/`AskQuestionRow`/`ResolvedRequestSummary`/`AgentMessageRow`/`NoticeRow`/the `thinking` case). Live on the built app, only `ToolRow`/`ToolGroupRow`/`AskQuestionRow`/`NoticeRow`/the `thinking` case were actually confirmed showing the shared icon-slot + truncating-summary + status/duration + `Collapsible` shape (screenshots across T074-T077's scenarios); `SubagentRow` and `AgentMessageRow` were never actually rendered live in that pass (no batch `task()` call or IRC message occurred in the CDP session), and `ResolvedRequestSummary` (a decided approval) was not rendered either, since the CDP session ran `--approval-mode=auto`, which produces no pending approval to decide. Documented in `docs/DESIGN.md` Chat ("Baseline collapsed line").
- [X] T081 [US1] Make chat text fill the transcript column: in `src/renderer/features/chat/Markdown.tsx` delete the `PROSE_WIDTH` constant (`max-w-[72ch]`) and every use of it, change the question and approval cards in `RequestCard.tsx` from `max-w-[60ch]` to full width, and check that user bubbles, thinking text, notices, tables, and code blocks all take the column's full width (`Message` and `MessageContent` already use `w-full`; tables and code blocks scroll sideways only when wider); keep the column's own cap in `Transcript.tsx` (`max-w-4xl`) as it is per FR-049 (partial)
- [X] T082 [US1] Update the docs and verify live: `docs/DESIGN.md` Chat (replace "Prose keeps a readable maximum line width; code blocks and diffs may span wider" with the full-width rule) (T025's "readable line width" wording stays as history); then on the built app in an isolated instance: an assistant reply with several long paragraphs, a list, a table, and a code block wraps at the column's right edge (measure that the paragraph's right edge is within a few pixels of the column's right edge), the user message, a thinking block, a notice, and a question card are as wide as the column, and a very narrow window and a wide window both still look right per FR-049 (partial) -- Verified 2026-10-02: paragraph (0px from edge), a 15+-line code block (1px, with internal horizontal scroll confirmed via scrollWidth>clientWidth), the ask/question card (0px), and narrow (700px)/wide (1900px) viewports all pass. A markdown table could not be measured: this build renders no `<table>` element at all for GFM table input (no remark-gfm/table support in Markdown.tsx); it falls back to a plain full-width paragraph. This is exactly T065's (#87, not yet built) own scope, not a new gap (FINDINGS item 25). NOT-PERFORMED: the list, the user message bubble, the thinking block, and the notice were not measured against the column's right edge in this pass (time-boxed). Closed 2026-10-04 on a fresh scratch instance (own userData/scratch git repo, a real signed-in `omp` 18.5.1 agent, CDP): a live turn's 4-item bulleted list, the user message bubble, a `Thought for 1s` thinking block, and an `Error: Refusal (no details provided)` notice all measured `right: 1636px` via `getBoundingClientRect()`, identical to the paragraph's own right edge measured the same way in the same turn (the column's `max-w-4xl` box itself ends at `right: 1652px`, 16px further out -- that 16px is the column's own `px-4` padding, so `1636px` is the shared inner content edge every element above lines up against, exactly as the already-verified paragraph/code-block/card entries did); the thinking row's trigger button measured `right: 1635px`, 1px off the rest, matching the same 1px tolerance already recorded for the code block. All four NOT-PERFORMED items now confirmed within 0-1px of the column's right edge; FR-049 has no remaining gap other than the already-noted, out-of-scope GFM table (T065).
## Phase 19: Convergence

- [X] T083 [US1] Add a language indicator and highlighting to every code block: make one shared `CodeBlock` (in `src/renderer/features/chat/Markdown.tsx`, exported for `ToolRow.tsx`) with a small header showing the language name or "text", used by markdown fences and by the Arguments and Output blocks of `ToolRow.tsx`; infer the language for tool blocks (arguments: `json`, pretty-printed with `JSON.stringify(value, null, 2)`; a `bash` tool's `command`: `bash`; output: `diff` when it is a diff, `json` and pretty-printed when it parses as JSON, otherwise `text`); keep Shiki's lazy language loading and the plain fallback for an unknown language, label the fallback "text", leave `DiffView` as it is, keep the header's text at WCAG AA contrast and the block full width (FR-049); no copy button was asked for per FR-050, FR-042 (partial) -- Verified 2026-10-03 on the built app (scratch repo, scratch userData, a real omp 18.5.1 agent, CDP): a reply with a ```ts fence showed a "ts" header with Shiki highlighting, an untagged fence (2 plain lines) showed a "text" header with no highlighting; a `bash` call's Arguments showed header "bash" with the raw `command` highlighted (not JSON-escaped), its Output ("a:1 b:2\n\nWall time: ...") correctly fell back to "text" since the wall-time suffix makes it non-JSON; a `read` call's Arguments showed header "json", pretty-printed (`{\n  "path": "sample.json"\n}`), and its Output showed header "text" with the real raw hashline-prefixed content (`[sample.json#23E8]\n1:{...}`) verbatim, confirming the json/diff/text inference and the no-highlight "text" fallback both work; `inferOutputBlock`'s diff/json branches also unit-verified standalone. `pnpm run check:ui-text`: 0 leaks. Fixed 2026-10-03 (second remediation round): the "Meets WCAG AA contrast" claim on `CodeBlockHeader`'s comment was unconditionally false (only true in this app's current dark-only theme, per docs/DESIGN.md "Look and feel") -- reworded to say so explicitly, matching the same correction made on `AdvisoryRow`'s severity-colour comment (T085). `CodeBlock`'s scrollable code region (the Shiki-highlighted `div` and the plain-fallback `pre`) now carries `tabIndex={0}`, `role="region"`, and an `aria-label` naming its language, with the focus ring drawn `ring-inset` so the outer wrapper's `overflow-hidden` (needed to clip the body to the header's rounded corners) can no longer clip a keyboard user's focus-visible outline off the left/right/bottom; previously a keyboard user tabbing into a wide block got no visible focus indicator and a screen reader announced nothing. `ToolRow.tsx`'s Arguments/Output blocks regained the `max-h-64 overflow-auto` height cap they always had before this task moved them onto the shared `CodeBlock` -- that move silently dropped it, so a 200-line tool output could push the whole transcript past a screen's worth of code with no cap at all (WCAG 1.4.10 reflow regression); `CodeBlock` itself is left uncapped (correct for a markdown fence, per FR-049's "scroll sideways only" rule), only `ToolRow`'s own usage wraps it in the restored height-capped scroll container. `pnpm typecheck`, `pnpm build`, `pnpm check:ui-text` (0 leaks, 371 files): all clean after these fixes.
- [X] T084 [US1] Parse advisory notes into their own item: in `src/main/omp/transcript.ts` (live `custom` messages and history, as T071 (f) shows) parse `<advisory ...>note</advisory>` elements, several per message possible, into a new `advisory` `TranscriptItem` (`severity: 'nit' | 'concern' | 'blocker'`, `advisor?`, `turnsAgo?`, `guidance?`, `text`) with a strict attribute reader (XML-escaped text, no HTML, an unknown severity treated as `nit`); text that does not parse stays a generic baseline line; add the kind to `src/shared/model.ts` and `data-model.md` per FR-051 (missing) -- Fixed and re-verified 2026-10-03 (second remediation round, against REAL on-disk data this time, not a hand-built fixture): the "Verified 2026-10-03" evidence above was circular -- its RPC probe replayed a hand-built conversation file that itself used the guessed, wrong `turnsAgo` (camelCase) attribute name, so it only proved OMP passes arbitrary attribute text through unchanged, never what OMP's own advisor feature actually emits. Extracting the producer's own minified source directly from the installed `omp.exe` (`` ` turns_ago="${t.currentTurn - s.turn}"` ``, alongside `` ` severity="${s.severity}"` `` / `` ` advisor="${FWe(s.advisor)}"` ``) confirms the real attribute is `turns_ago` (snake_case), not `turnsAgo`. Independently confirmed against genuine advisor messages already on disk from unrelated real prior sessions in `~/.omp/agent/sessions`: `--C--Repos-personal-pinion-worktrees-pinion-golden-bison--/2026-10-03T19-02-42-226Z_....jsonl` (`<advisory severity="nit" turns_ago="3" guidance="...">`, and a second with `turns_ago="5"`), `--C--Second-Brain--/2026-10-03T06-30-06-907Z_....jsonl` (ten more real advisories, `turns_ago` values 4/5/6/8/9/12/21/22/25/27/29/32), and two more real scratch sessions (`merry-egret`, `frosty-kestrel`), each `turns_ago="1"`; none of these real messages ever carries an `advisor=` attribute, consistent with it being optional and simply unused so far. Running the exact fixed regex/attribute-reader logic (copied verbatim from the patched `transcript.ts`) against every one of these real messages correctly produced `turnsAgo: 3, 5, 4, 5, 6, 8, 9, 12, 21, 22, 25, 27, 29, 32, 1, 1`; the old `attrs.turnsAgo` reader would read every one of them as `undefined`, since the camelCase name never appears on real wire data -- confirming the "T-N" marker genuinely never rendered on a real advisory before this fix, and does now. Also fixed and verified standalone this round: (1) the gate is now `message.customType === 'advisor'` only, the `/<advisory/` substring fallback removed -- a constructed `customType: 'agent-message'` message whose content merely quotes the literal text `<advisory severity="blocker">fake</advisory>` no longer gets claimed as an advisory, so it falls through to its own real kind instead; (2) the attribute-list regex now matches balanced `"..."`/`'...'` values structurally instead of scanning to the next literal `>`, so `guidance="if a > b"` no longer truncates the tag; (3) single-quoted values (`severity='blocker'`) read correctly, and `guidance='severity="blocker"'` is kept as one literal string instead of being re-scanned as a second `severity` attribute; (4) a duplicate attribute name is now a parse failure, matching real XML; (5) `decodeXmlEntities` validates each numeric character reference's code point (<= U+10FFFF, never a surrogate) before calling `String.fromCodePoint`: `&#99999999;`/`&#x110000;` no longer throw `RangeError` (confirmed via `node -e`) and are left as the original entity text, while `&#65;` still decodes to `A`; (6) `tryBuildAdvisoryItems` wraps its own parsing in try/catch, falling back to the generic `notice` (FR-051) on any parse exception instead of propagating out of `applyFrame`/`fromHistory`. The wire-shape doc comment in `src/shared/model.ts` (previously showing `turnsAgo="..."`) is corrected to `turns_ago="..."`. `pnpm typecheck`, `pnpm build`, `pnpm check:ui-text` (0 leaks, 371 files): all clean after these fixes. Third remediation round, 2026-10-03 (retroactive security-auditor pass, Medium finding): `ADVISORY_TAG_RE`'s single `<advisory\b(...)\s*>([\s\S]*?)<\/advisory>/g` ran quadratic-time on agent-controlled content full of unclosed `<advisory` tags (measured before: 50KB ~30ms, 100KB ~117ms, 200KB ~482ms, 400KB ~1920ms) because the lazy body capture backtracked to the end of `content` once per unclosed tag; split into `ADVISORY_OPEN_TAG_RE` (opening tag only, bounded per-tag) plus a forward `indexOf` scan for each element's own `</advisory>`, breaking the whole loop the instant one `indexOf` fails to find a closer anywhere in the remaining content (every later tag's search range is a subset of that failed one, so none of them could find a closer either) -- after: 50KB 0.3ms, 100KB 0.1ms, 200KB 0.2ms, 400KB 0.4ms, 1MB sanity check 2.2ms, now linear instead of quadratic; re-ran all prior-round correctness probes (double- and single-quoted valid tags, duplicate-attribute rejection, out-of-range numeric entity, `turns_ago`) unchanged. `pnpm typecheck`, `pnpm build`, `pnpm check:ui-text` (0 leaks, 371 files): all clean after this fix.
- [X] T085 [US1] Render advisories by severity on the baseline line of T080: an icon and the severity word (blocker with `OctagonAlertIcon` in the error colour, concern with `TriangleAlertIcon` in the warning colour, nit with `InfoIcon` muted), the advisor name and a "T-N" marker when present, and a one-line preview of the note; expanding shows the note and the guidance as plain text; use the existing state colour tokens, keep contrast at WCAG AA, and never rely on colour alone per FR-051 (missing) -- Verified 2026-10-03 live (see T087): a conversation with one blocker, one concern, and one nit advisory rendered three baseline lines in the error/warning/muted colours respectively, each with its own icon shape and the word ("Blocker"/"Concern"/"Nit"), the advisor name and a "T-N" marker when present (absent on the nit, which had neither), and a one-line preview; expanding the blocker showed the full note plus a "Guidance" section with its text, as plain text, no raw tag text anywhere. Note added 2026-10-03 (second remediation round): that "T-N" marker claim was circular -- it shared T084's hand-built-fixture bug (the fixture used the wrong `turnsAgo` attribute name, which happened to match the then-buggy reader); see T084's corrected entry for the real on-disk-data confirmation that the marker now renders from OMP's actual `turns_ago` attribute. No change to this task's rendering code; `AdvisoryRow.tsx`'s severity-colour comment now notes the colours meet WCAG AA against the app's current dark-only background (docs/DESIGN.md "Look and feel"), unverified for a future light theme.
- [X] T086 [US1] Hide the agent's bookkeeping tools: add one fixed list (`HIDDEN_TOOLS`, starting with `todo`) in `src/shared` and skip those calls in `src/main/omp/transcript.ts` (live frames and history) so they never reach the renderer; a hidden call that fails becomes an error notice; hidden calls do not break a run of another tool in `groupToolItems` (T074); leave the todo state itself available for a later readout per FR-052 (missing) -- Verified 2026-10-03 live: asked the real agent to use the `todo` tool for a two-task plan; it called `todo` three times (confirmed from the real conversation file's own `tool_execution_start` events, ground truth) yet zero todo rows ever appeared in the transcript, before/after/between the surrounding `bash`/`read` tool rows, which still grouped and rendered normally; a `groupToolItems` unit check (two `bash` calls either side of a failed hidden `todo` call) confirmed the hidden call's failure notice renders without splitting the `bash` run into two groups.
- [X] T087 [US1] Update the docs and verify live: `docs/DESIGN.md` Chat (code blocks with a language header, advisories by severity, hidden bookkeeping tools) and `quickstart.md` Story 1; then on the built app in an isolated instance: a reply with a ```ts fence shows a "ts" header and highlighting, an untagged fence shows "text", a tool call's JSON arguments show a "json" header, highlighted and pretty-printed, a JSON output is pretty-printed, an agent turn that calls `todo` shows no todo rows, and a conversation that contains one blocker, one concern, and one nit advisory (a recorded history file reopened in Refract, since a live advisor needs configuration) shows three lines in red, amber, and muted with the severity word, the advisor name, and the note on expansion, with no raw `<advisory>` text per FR-050, FR-051, FR-052 (partial) -- Verified 2026-10-03: `docs/DESIGN.md` Chat and `quickstart.md` Story 1 updated (code-block language headers, hidden bookkeeping tools, advisory severity lines). Live, on the built app in an isolated scratch instance (scratch repo/worktree/userData, electron.exe with its own `--user-data-dir`/`--remote-debugging-port`, driven over CDP, a real signed-in `omp` 18.5.1 agent): (1) a ```ts fence showed a "ts" header with highlighting, a 2-line untagged fence showed a "text" header with none; (2) a `read` tool call's Arguments showed a "json" header, pretty-printed, highlighted, and its Output correctly showed "text" for the real non-JSON hashline-prefixed content; (3) the agent made three real `todo` calls (confirmed from the on-disk conversation file) for zero rendered todo rows, with the surrounding `bash`/`read` rows unaffected; (4) a hand-built conversation file (its shape itself confirmed via a `get_messages` RPC probe against a real `omp` agent) with one blocker, one concern, and one nit `<advisory>`, reopened via the session's "Conversation history" picker, rendered three lines in red/amber/muted with the severity word, the icon, the advisor name and "T-N" marker where present, and (on the blocker) the full note plus its guidance on expansion -- no raw `<advisory>` text anywhere. `pnpm run check:ui-text`: 0 leaks (371 files). Scratch electron process and scratch OMP session-store folder torn down afterwards by exact PID/path; the user's real Refract instance was never touched. Note added 2026-10-03 (second remediation round): item (4)'s hand-built conversation file shared T084's attribute-name bug (it used the wrong `turnsAgo` name, which happened to match the then-buggy reader), so its "T-N marker where present" observation was not evidence a *real* OMP advisory's marker worked -- see T084's corrected entry for the real on-disk-data confirmation that it now does. The rendering behaviour itself (icon/colour/word/guidance-on-expansion, no raw tag text) is unaffected by that bug and still holds.

## Phase 20: Convergence

- [X] T088 [US1] Style every scrollbar from the theme: fix the root cause first: `src/renderer/styles/globals.css` sets `.dark` by class only and never sets `color-scheme`, so Chromium keeps drawing its default light scrollbars (with arrow buttons) on every plain `overflow-auto` element, such as code blocks, tool output, the slash menu, and `ConversationSwitcher`; set `color-scheme: light` on `:root` and `color-scheme: dark` on `.dark`; then add scrollbar colour tokens (thumb, thumb hover, track) for `:root` and `.dark` (spec 007 will vary them per theme), and apply them globally with `scrollbar-width: thin` and `scrollbar-color`, plus `::-webkit-scrollbar`, `::-webkit-scrollbar-thumb`, `::-webkit-scrollbar-track`, and `::-webkit-scrollbar-corner` rules so vertical and horizontal bars (the transcript, `ToolRow` Arguments and Output, code blocks, the session list, `ScrollArea`, dialogs) share one look; reconcile the `scrollbar-thin` utilities in `src/renderer/components/ui/message-scroller.tsx` and the `ScrollArea` component with it, keep `no-scrollbar` where the sidebar already hides them, remove the horizontal scrollbar from the slash menu (`SlashMenu.tsx`: let the description truncate with an ellipsis and give the list `overflow-x-hidden`), and keep the thumb at 3:1 contrast against its track and the page in light and dark per FR-053 (missing)
- [X] T089 [US1] Update the docs and verify live: `docs/DESIGN.md` Look and feel (scrollbars use theme tokens); then on the built app in an isolated instance in dark and light: the transcript, a tool call's Arguments (horizontal) and Output (vertical), a long code block, the session list, the slash menu (no horizontal bar at all), and a dialog all show thin themed scrollbars with no white default bar or arrow buttons (screenshot each), the thumb contrast is at least 3:1 (measure it from the computed colours), the thumb is easier to see on hover, and wheel and keyboard scrolling still work per FR-053 (partial) -- Verified 2026-10-02: themed thumbs with no default white bar confirmed in both themes on the transcript, tool Output, and the slash menu (no horizontal bar at all); dark-theme contrast measured 3.28:1 against a muted tool-output background (>= 3.0, after raising the thumb token from #6b6b6b to #757575 to fix an initial 2.84:1 failure there); hover colour pixel-confirmed exact match to the hover token. Wheel and keyboard scrolling could not be exercised: this Electron build's CDP bridge does not deliver synthesized wheel events or invoke the native scroll-on-keypress action for synthesized key events (reproduced and diagnosed, not an app defect -- a real mouse/keyboard still scrolls normally, unmodified by this change). The session list, a dialog, light-theme screenshots of the remaining surfaces, a tool call's Arguments block (horizontal scrollbar, either theme), and a long code block (either theme) were not captured (time-boxed); light-theme thumb contrast was not measured at all (only dark-theme contrast, 3.28:1, was measured). Closed 2026-10-04, dark theme only (light theme is moot: this app is dark-only by design, docs/DESIGN.md:27) on a fresh scratch instance (own userData/scratch git repo, CDP): since `::-webkit-scrollbar-thumb` isn't readable through normal `getComputedStyle` on the element itself, each surface was forced to actually overflow, then pixel-sampled from `Page.captureScreenshot` frames at 1:1 CSS px (`devicePixelRatio: 1`). The session list's own scrollbar (forced to overflow with 13 scratch Sessions, or by emulating a 1000x500 viewport): resting thumb sampled at rgb(117,117,117) (`--scrollbar-thumb` exactly), hover at rgb(140,140,140) (`--scrollbar-thumb-hover` exactly), track/background rgb(23,23,23), contrast 3.89:1. The "Conversation history" dialog's scrollbar (forced to overflow with 13 real Conversations so `scrollHeight` 1152px > `clientHeight` 966px): same rgb(117,117,117) thumb, same 3.89:1 contrast. A tool call's Arguments block's horizontal scrollbar (a 200+ character single-line `bash` command, `scrollWidth` 1467 > `clientWidth` 844): rgb(117,117,117) thumb against a rgb(36,41,46) code-block background, 3.18:1 contrast. A long code block's horizontal scrollbar (a 200-character single-line Python comment, `scrollWidth` 1446 > `clientWidth` 844): same rgb(117,117,117) thumb, same 3.18:1 contrast. All four: no default white bar, no arrow buttons, thumb visibly brightens on hover. A `getComputedStyle(el, '::-webkit-scrollbar-thumb')` sanity check on the session list's own scroll container (supported by this Chromium) independently read `background-color: rgb(117, 117, 117)` and `width: 8px` straight from the CSS rule, matching the pixel-sampled paint. No per-surface override exists for any of these four; they inherit the same global `*::-webkit-scrollbar-thumb` rule from T088 as the three surfaces already verified. In passing: `SidebarContent` (`src/renderer/components/ui/sidebar.tsx`) carries a `no-scrollbar` class that matches no CSS rule anywhere in the project (grepped); it is dead and has no visible effect (confirmed: the themed scrollbar renders normally there), so it was left alone rather than treated as a defect. FR-053 has no remaining gap in dark theme; light theme remains explicitly out of scope (moot, not missing).

## Phase 21: Convergence

- [X] T090 [US1] Give choice and active items square corners with one shared rule: define one shared square-item class or token (for example `rounded-none` through a single utility used by every item component) and apply it to `SelectItem` in `src/renderer/components/ui/select.tsx`, the item variants in `src/renderer/components/ui/dropdown-menu.tsx`, the slash menu rows in `src/renderer/features/chat/SlashMenu.tsx`, the selected and hover state of the session row button in `src/renderer/features/sessions/SessionList.tsx`, `src/renderer/components/ui/toggle-group.tsx` segments and any tab triggers; leave buttons, inputs, popups, dialogs, cards, and chips rounded; keep the highlighted-item cue and keyboard navigation as they are per FR-054 (missing)
- [X] T091 [US1] Update the docs and verify live: `docs/DESIGN.md` Look and feel (choice and active items are square; everything else keeps its rounding); then on the built app in an isolated instance (dark and light): the Base branch picker's highlighted and checked option, a row menu, the slash menu's highlighted row, the selected and hovered session row, and the Approval mode toggle segments all have square corners (screenshot each), while a button, the message box, a popup, and a dialog keep their rounding per FR-054 (partial) -- Verified 2026-10-02: all three Approval-mode toggle segments (Ask, Edit freely, Auto), including the currently-selected segment (`aria-checked="true"`), measured `border-radius: 0px` live via DOM computed style; confirmed the built CSS's shared square-corner selector includes `[role="radio"]`. NOT-PERFORMED (time-boxed): the Base branch picker's highlighted/checked option, a row menu, the slash menu's highlighted row, the selected and hovered session row, and light theme were not re-screenshotted this round -- these were the parts of the original fix (a single shared CSS rule, no per-surface logic) that this round's targeted re-check did not re-exercise, so only the one surface that was actually broken (the toggle segments) got fresh live evidence. Likewise not re-confirmed: that a button, the message box, a popup, and a dialog still keep their rounding. Closed 2026-10-04, dark theme only (light theme is moot: dark-only app, docs/DESIGN.md:27) on a fresh scratch instance (own userData/scratch git repo, a real signed-in `omp` 18.5.1 agent, CDP): all four measured `border-radius: 0px` live via `getComputedStyle`. The Base branch picker's checked option (`master`, `data-state="checked"`) and its separately-hovered/highlighted option (`feature-x`, `data-highlighted`) in the New Session dialog's shadcn `Select`, screenshotted together showing both with clean square corners (the checked one keeping its checkmark). A row menu (the session row's `⋮` actions menu, `role="menuitem"` items; the hovered/`data-highlighted` "Rename" item), screenshotted square against its own square-cornered menu surface. The slash menu's highlighted row (`/new`, matched via `aria-selected="true"`). A session row in both its selected state (`aria-current="true"`) and, separately, its hovered-but-not-selected state (a different row, matched via `:hover`). All five FR-054 surfaces from the original fix (these four plus the already-reverified toggle segments) now have fresh live evidence in this reopened round. Not re-confirmed (unchanged from the previous round, out of this round's scope): that a button, the message box, a popup, and a dialog still keep their rounding.

## Phase 22: Convergence

- [X] T092 [US7] Probe every slash command OMP offers over RPC (constitution IV): write `docs/spike/slash-commands-probe.mjs` that starts every `omp --mode rpc-ui` probe process with its own isolated OMP profile (`--profile <scratch name>`) and agent directory under its own isolated profile, never the default `~/.omp/agent`, and, before sending any command, a pre-flight `assertIsolatedProfile` check asserts that the live process's own `get_state.model` resolves to exactly the `probe-fake`/`probe-fake-model` provider that `ensureFakeModel()` seeded solely under the isolated profile's own agent directory -- the one piece of config no real, previously-used profile can have -- aborting non-zero before anything is sent if it does not, so no probe can touch the developer's real OMP configuration or credentials, reads `get_available_commands`, and for each command (and subcommand) sends it as a prompt, recording the response (`agentInvoked`), `command_output`, `prompt_result`, any `extension_ui_request` dialog it raises (select, confirm, input, editor) and how Refract's dialog handling answers it, errors, hangs (a 20 s timeout), and whether the session returns to idle; commands that could sign out, log in, delete, exit, or alter global configuration, plugins, skills, advisors, or settings (for example `/login`, `/logout`, `/settings`, `/model` writes, `/advisor configure`) are flagged for Stuart's decision and never run blind, even in the isolated profile; classify each as works as is, works with a dialog, starts an agent turn, terminal-only, destructive (needs a decision), or broken; record the table as a new numbered FINDINGS item and in `contracts/omp-usage.md` per FR-032, SC-011 (missing)
- [X] T093 [US7] Show only the commands that work: add one fixed supported set (keyed by command name, in `src/shared`) built from the T092 table; make `chat.commands` and `commands:update` return only supported commands (plus the native commands that are actually built, `/new` today) and make `chat.send` refuse everything else as `unknown-command` with the warning of FR-033; commands that appear in a later OMP patch stay hidden until a probe adds them; do not list the native commands that are not built (`/plan`, `/fork`, `/settings`, `/pause`, `/plan-review`, `/btw`, and `/resume` until implemented); update `contracts/ipc.md` and `contracts/omp-usage.md` per FR-032, FR-033 (partial); verified 2026-10-03: the T092 table itself was stale for this purpose (contracts/omp-usage.md said so explicitly), so `slash-commands-probe.mjs` was rerun unmodified against omp 18.5.1 (the only version on this machine; FINDINGS item 23 delta, `docs/spike/slash-results-18.5.1.json` kept only as this session's scratch evidence, not committed) -- 198 commands/subcommands, 57 `works-local`, 3 `starts-agent-turn` (unverified, unchanged), 138 `needs-decision`; `src/shared/slash-commands.ts` adds `SUPPORTED_OMP_COMMANDS` (22 names) and `NATIVE_BUILT_COMMANDS` (`/new`) with `filterSupportedCommands()`, applied once in `SessionAgent`'s `available_commands_update` handler so `chat.commands`/`commands:update`/`chat.send`'s validation all read the same filtered list; `switch` (a model write by another name) and `/ratchet`/`/green`/`/init` (unverified agent-turn starts) are excluded by judgment, recorded in FINDINGS item 23 and `contracts/omp-usage.md`; **remediated 2026-10-03 (issues #129/#130/#131, Critical finding, 3 independent reviewers)**: the allowlist was keyed on the top-level command NAME ONLY, so a subcommand the probe explicitly denylisted and never ran still reached OMP under its allowed parent (`/todo copy` overwrites the real OS clipboard, `/todo edit`/`import` opens $EDITOR/reads an arbitrary file, `/todo export`/`drop`, `/session delete` deletes the Session, `/session pin`/`/usage reset` touch credentials/rate-limits), and free-form arguments on commands only ever probed bare (`/add-dir <path>`, `/rename [title]`, `/annotate`, `/autoresearch <goal>`, `/force <tool>`, `/todo append/start/done/rm <text>`, `/changelog last <N>`) were forwarded unchecked. Fixed: `SUPPORTED_OMP_COMMANDS` is now `Readonly<Record<name, readonly subcommand-name[]>>` built directly from `contracts/omp-usage.md`'s per-command subcommand breakdown (`todo`: `expand`/`collapse`/`append`/`start`/`done`/`rm` only; `session`: `info` only; `usage`: `show` only; etc.); `filterSupportedCommands` prunes each surviving descriptor's own `subcommands` to that verified set so the menu and `chat.send` can never drift onto two different lists; the new `isSupportedInvocation` accepts only the bare name or name + exactly one verified subcommand, refusing ANY trailing text as `unknown-command` -- a deliberate decision to refuse free-form arguments entirely rather than guess a safe shape (re-opening any of them needs a fresh probe with a representative argument first, not a quiet allowance); native command bookkeeping (`new`/`resume`/`plan`/`fork`/`settings`/`pause`/`plan-review`/`btw`) consolidated into one `NATIVE_RESERVED_COMMANDS` owner in `slash-commands.ts`, removing `chat.ts`'s duplicate `NATIVE_COMMANDS` map and hardcoded `commandName === 'new'` branch. Live-verified against the real omp 18.5.1 binary (T095 remediation note below).
- [X] T094 [US7] Make every listed command work end to end: for each supported command whose result needs support in Refract according to T092 (a dialog it raises answered through the existing request cards, `command_output` shown as a baseline line, a failure shown as an error notice, a command that changes the model or a mode reflected in the readout), build what is missing in `src/main/ipc/chat.ts`, `src/main/omp/SessionAgent.ts`, and the renderer; any command that still cannot run to a visible result is removed from the supported set of T093 instead of being left in the menu per FR-032 (partial); verified 2026-10-03: nothing was missing. The generic pipelines `command_output`/`notice` frame to a `notice` item (`transcript.ts`), any `select`/`confirm`/`input`/`editor` `extension_ui_request` to a request card, a `notify` request to a `notice` (`dialogs.ts`), and a failed `prompt` ack to an error `notice` (`SessionAgent.send`) already covered every one of the supported set's observed shapes (inspected the 18.5.1 probe's raw per-command frames directly, not just the ack: all 56 non-`/new` commands produced a `command_output`, `notice`, or dialog, never a silent no-op, so none needed removing); T063/T064's model/effort readout does not exist yet in this codebase, so "a mode reflected in the readout" had nothing to wire into. Live-verified end to end (T095) instead of leaving this as a paper review; **remediated 2026-10-03 (issues #129/#130/#131)**: unaffected by the T093 Critical fix -- narrowing which invocations reach OMP (exact name/subcommand, no free-form arguments) does not change how an accepted command's result is rendered, and the same generic `command_output`/`notice`/dialog pipelines still cover every invocation the narrower `isSupportedInvocation` now allows (re-verified live, see T095).
- [X] T095 [US7] Update the docs and verify live: `docs/DESIGN.md` Chat and `specs/001-core-session-workspace/quickstart.md` Story 7 (the menu lists only working commands, how a command is added after a probe); then on the built app in an isolated instance with a scratch Session: run every command that the menu lists, one by one, and confirm each shows a visible result and the session returns to idle with the next message accepted, that a hidden command typed by hand shows the unknown-command warning and sends nothing, and that no command in the menu stalls the turn per FR-032, FR-033, SC-011 (partial); verified 2026-10-03 on the built app over CDP (scratch `userData`, a real added repository, a real Session/worktree, the real signed-in profile -- the fake-model isolation is T092's probe-only concern): the Readiness screen's `omp --version` check is still pinned to 18.4.x (Principle IV; this machine only has 18.5.1, out of scope for this story -- flagged separately, not changed here), so verification bypassed only that screen's gate (a CDP-side `readiness.check` override confirmed for this session only; real IPC/omp/Session machinery untouched). The menu showed exactly `/new` plus the 22 `SUPPORTED_OMP_COMMANDS` names, no hidden/denylisted/unverified name among them; every one of the 23 was run (`/annotate` and `/effort` via real keystrokes through the textarea and Enter, the rest via `chat.send` -- the same handler either path calls) and each produced a real visible transcript notice or request card (`Fast mode enabled.`, `Extended context disabled.`, the real `/effort` thinking-level list, the real `/changelog`/`/usage`/`/tools`/`/context` output, `/annotate`'s options card resolving to "Cancelled", `/new` clearing the transcript), the Session stayed/returned `idle` after each (confirmed via `sessions.list()`), and nothing stalled. `/switch` (hidden by judgment) typed by hand showed "Unknown command: /switch" and sent nothing. Docs: `docs/DESIGN.md` Chat gained a Slash commands bullet; quickstart Story 7 rewritten for the filtered menu and the add-a-command process; **remediated and re-verified 2026-10-03 (issues #129/#130/#131, High finding, real omp 18.5.1, not a version-pin claim)**: re-ran live with the same CDP-side `readiness.check` override technique (in-memory only, via the Node inspector on the main process; no source, build artifact, or version regex ever changed) against a fresh scratch repository/Session, confirming the Critical fix: `/todo copy` sent by hand through the real composer (typed, real Enter keydown) showed the `unknown-command` toast, left the OS clipboard byte-for-byte unchanged (a sentinel value set beforehand via the main process and re-read after), and added nothing to the transcript (same length before/after) -- directly proving the previously-reachable subcommand is now blocked; `/mcp` (a name OMP itself denylists), `/plan` (a native name with no implementation), `/notacommand` (nonsense), `/session delete`, `/usage reset`, `/add-dir C:/tmp`, and `/rename test` (free-form arguments on commands only ever probed bare) were each sent via `chat.send` and each refused as `unknown-command` with nothing forwarded; `/fast on extra junk` (valid subcommand plus trailing text) was likewise refused, while `/fast`'s own verified subcommands (`/session info`, `/shake elide`, `/effort low`) still succeed. The "next message is accepted" claim is now actually demonstrated, twice: after the direct-IPC `/todo copy` block and again after the real-UI `/todo copy` block, an ordinary follow-up message was sent (once by hand through the composer) and in both cases the Session transitioned `idle` -> `working` -> `idle` and the transcript gained the real assistant reply. A representative handful were re-run through the real menu-click/Enter path, not just `chat.send`: typing `/sess` filtered the `SlashMenu` to exactly `/session`, mousedown-selecting it inserted `/session `, typing `info` and a real `Enter` keydown produced the `Session: ...` notice; `/todo copy` and the plain follow-up above were also real keystrokes. Medium finding re-verified: `/retry` and `/force`, sent bare in this same conversation after one real completed turn (not a fresh empty conversation), stayed `works-local` -- `/retry` answered "Nothing to retry." and `/force` answered "Usage: /force:<tool-name> [prompt]", neither started a real agent turn (`sessions.list()` stayed `idle` throughout) -- no reclassification needed. `pnpm typecheck` and `pnpm build` pass after the fix; `pnpm check:ui-text` has one pre-existing, unrelated failure inside the bundled `mermaid` vendor library (`xychartDiagram`'s `"Drawing of right axis is not implemented"` string), not introduced by this change and not touched.

## Phase 23: Convergence

- [X] T096 [US1] Remove project terminology from everything the user can read: change `src/renderer/features/status-bar/StatusBar.tsx` line 74 to "Refract never stops an agent on its own. Stop one below to free memory."; replace the `not-implemented` reply for native commands in `src/main/ipc/chat.ts` line 79 ("lands in a later task") with the `unknown-command` warning (T093 hides those commands anyway, so a hand-typed one is simply unknown); replace the "Waiting for the readiness check to be wired up." hint in `src/renderer/features/readiness/Readiness.tsx` line 22 with a plain "The check could not run. Try Re-check."; remove the `not-implemented` error code from `src/shared/ipc.ts` and its two checks (`Readiness.tsx`, `src/renderer/state/init-stores.ts`) once nothing returns it; then audit every other source of user-visible text (renderer JSX text, `title` and `aria-label` attributes, `notify` toasts, the `message` of every error returned by `src/main/ipc/*.ts` that can reach the screen, notification text in `src/main/notifications.ts`, dialog titles, and the window title) for requirement or task numbers, "story", "spec", "constitution", file names, and build-state wording, and fix each hit; code comments are out of scope per FR-055 (partial); catch-path fix verified 2026-10-03: `runCheck`'s invoke-failure catch block now sets a real hint ("The check could not run. Try Re-check.") on all three checks instead of the bare `NOT_READY` (now removed, it had no other use), and the stale "handler not registered yet" debug log wording was corrected (static code read)
- [X] T097 [US1] Update the docs and verify live: add the rule to `docs/DESIGN.md` (UI text uses the product's own terms; no requirement, task, story, spec, or build-state wording); add a permanent guard, `scripts/check-ui-text.mjs` run as `pnpm check:ui-text` after `pnpm build`, that searches the built bundles in `out/` (comments are stripped from them, so only text that can reach users is seen) for `\b(FR|SC)-\d{3}\b|\bT\d{3}\b|\bUS\d\b|later task|wired up|User Story` and exits non-zero on a hit; then check the built output with a search of the main and renderer bundles in `out/` for `FR-\d`, `SC-\d`, `T\d{3}`, `US\d`, "later task", "wired up", and "not implemented" (no match in any user-visible string), and on the built app in an isolated instance read `document.body.innerText` over the CDP on the readiness screen, the session list, a chat, the Approval mode control, the New session dialog, the delete dialog, and a toast from a deliberate error, and confirm none of those patterns appears per FR-055 (partial)

## Phase 24: Convergence

- [X] T098 [US3] Move the Approval mode into a pill above the message box: add an `ApprovalModePill` in the chip row directly above the message box (`src/renderer/features/chat/MessageInput.tsx` and a new component beside it, as the first item of the row spec 004 defines) showing the current mode's lucide icon and name; activating it opens a `DropdownMenu` (square options per FR-054) with the three modes (Ask with `HandIcon`, Edit freely with `PencilLineIcon`, Auto with `ZapIcon`), each with its name, a one-line description of what it prompts for, and the current one marked with a check and text; call the existing `settings.setApprovalMode` through the settings store, show a pending change on the pill ("Auto after this turn") and remove the separate pending chip from `ChatHeader.tsx`; give the pill an accessible name that states the current mode; delete the `ToggleGroup` from `src/renderer/features/status-bar/StatusBar.tsx` (the file goes in T099) per FR-056, FR-015, FR-020. **Verified 2026-10-03** (wave4-approval-layout): `ApprovalModePill.tsx` built and wired as the chip row's first item in `MessageInput.tsx`; `DropdownMenu` lists Ask/Edit freely/Auto with their lucide icons, one-line descriptions, and the current mode marked by a check icon plus the word "Current"; the pill's `aria-label` states the current mode and any pending one; `ChatHeader.tsx`'s old pending-mode `Badge` removed; only `StatusBar.tsx`'s `ToggleGroup` (and the now-unused `useSettingsStore`/`ApprovalMode`/`Tooltip` imports it alone needed) was removed, the low-memory popover and the rest of the file untouched. `pnpm typecheck` passes. **Remediation 2026-10-03** (wave4 Critical/High fix pass): the pill showed the *pending* mode as current while a change waited for idle, misrepresenting what approval behaviour actually governed the live turn. Fixed by adding `launchedMode: ApprovalMode` to `SessionSummary`/`SessionStatusEvent`/`SessionRuntimeView`'s renderer copy (`shared/ipc.ts`, `SessionManager.summaries()`, `SessionAgent.emitStatus()`, `sessions-store.ts`'s `applyStatus`) and switching the pill's "current" to `session.launchedMode ?? approvalMode` instead of the global Settings mode. Verified live end to end against a real `omp` 18.5.1 agent (scratch repo, scratch profile): sent a prompt in Ask mode, while the resulting `bash` approval card was still pending switched the pill to Auto -- the pill immediately read "Ask · Auto after this turn" (screenshot-confirmed) and `document.querySelector('button[aria-label^="Approval mode"]').getAttribute('aria-label')` read exactly `"Approval mode: Ask. Auto after this turn"`; approved the tool call, waited for the turn to finish and the mode-change restart to complete, then re-read the pill: label "Auto", `aria-label` `"Approval mode: Auto"`, pending annotation gone. `pnpm typecheck`/`pnpm build`/`pnpm check:ui-text` all clean after the change.
- [ ] T099 [US5] Remove the status bar and move the low-memory warning to the profile item: once the profile item of spec 008 exists (build this with its first task; never remove the memory notice before its replacement exists), render the low-memory popover from `StatusBar.tsx` (the running agents with a Stop agent action each, never stopping one on its own) as a badge on the profile item with a text cue, also move the update badge and the Check for updates action that spec 006's T022 built into `StatusBar.tsx` to the update entry of the profile menu (spec 008 FR-021) so the update entry is not lost, then delete `src/renderer/features/status-bar/`, the bottom region of the layout in `src/renderer/main.tsx`, and the `memory-store` wiring that only the bar used, and update the comments in `contracts/ipc.md` (`settings:changed`, `memory:warning`) per FR-056, FR-037. **Still blocked, not started** (wave4-approval-layout, 2026-10-03): spec 008's profile item does not exist yet -- its Phase 1 to 3 (T001-T015: GitHub CLI/OMP sign-in probes, new UI primitives, the GitHub profile fetch and cache store, the shared `accounts.*` IPC contract, the renderer accounts/view stores, and only then `ProfileItem.tsx`/`ProfileMenu.tsx` themselves) is substantial foundational work, not a quick slice, and is explicitly this task's own precondition. T098 (this session) only deleted `StatusBar.tsx`'s `ToggleGroup`; the low-memory warning and the update badge/check both still live in `StatusBar.tsx` exactly as before, unmoved and unremoved.
- [X] T100 [US1] Hide the menu bar until Alt and merge the title bar into the app's top row: first probe on the Electron version in use (44.5.1) whether `autoHideMenuBar: true` still shows the native menu on Alt when `titleBarStyle: 'hidden'` is set on Windows (Electron's custom title bar guide removes the native frame, so it may not), and record the result in `docs/spike/FINDINGS.md`; if it does not, draw an in-app menu bar with the same File, Edit, View, and Window items in the top row that Alt reveals and Esc or a click away hides, built on the existing menu component and driven by the same actions; then in `src/main/index.ts` create the `BrowserWindow` with `titleBarStyle: 'hidden'` and a `titleBarOverlay` whose colour, symbol colour, and height come from the active theme (updated through a new allowlisted `window.setTitleBarOverlay` call when the theme changes, spec 007), and in the renderer make the left nav header (Refract icon and name) and the chat header top rows `-webkit-app-region: drag` with every button, input, and menu inside them `no-drag`, reserve the right side of the top row for the window buttons (`env(titlebar-area-width)`; with a split view of spec 005 that is the right-hand pane's header), start the left nav at the very top, and let a double-click on a drag area maximise or restore; keep copy, paste, zoom, and (in development) reload and developer tools working by keyboard without the bar per FR-057. **Verified 2026-10-03** (wave4-approval-layout): the 2026-10-02 Alt-menu probe (FINDINGS item 24) was INCONCLUSIVE (its synthetic Alt keystroke never reached either window, including its own `control` baseline); re-probed live this session with a real OS-level Alt keypress against a real interactive desktop (not headless/CDP) -- **DEFINITIVE result, FINDINGS item 33**: the native menu does NOT reveal on Alt once `titleBarStyle: 'hidden'` is set, confirmed against a working `control` baseline in the same run. Built accordingly: `src/renderer/features/app-menu/AppMenuBar.tsx` draws the in-app File/Edit/View/Window row (a standalone Alt tap toggles it, Esc or a click outside hides it), each item popping open the one real `Menu` built in `src/main/menu.ts` (`Menu.setApplicationMenu` keeps every accelerator -- copy, paste, undo, redo, zoom, and in development reload/toggle developer tools -- working whether the bar is shown or not, also confirmed live). `src/main/index.ts`'s `BrowserWindow` now sets `titleBarStyle: 'hidden'` and `titleBarOverlay` from `src/main/titleBarOverlay.ts`'s `DARK_TITLE_BAR_OVERLAY` (the dark theme's own `--background`/`--foreground`, converted to hex -- Refract is dark-only today, spec 007 does not exist yet in this checkout, so there is no live theme-change event to call `applyTitleBarOverlay` again from; that helper is exported for spec 007 to call from its own `theme.preview`/`theme.set`, same shape contracts/ipc.md already documents). `SessionList.tsx` gained the left nav header (Refract icon + "Refract", `.drag-region`, at the very top of the window); `ChatHeader.tsx` is `.drag-region` with `ConversationSwitcher` and a trailing `calc(100vw - env(titlebar-area-width, 100vw))` spacer marked `.no-drag-region`; both headers' double-click (guarded to the drag area itself, never a bubbled click from a button inside it) calls the new `window.toggleMaximize` IPC. `pnpm typecheck` passes.

**Remediation 2026-10-03** (wave4 Critical/High fix pass), each item verified live against the real built app (scratch `--user-data-dir`, a real git repo registered as a Repository, a real `omp` 18.5.1 agent) via a REAL OS-level `computer`-tool click/drag/key (never a CDP synthetic `Input.dispatchMouseEvent`), cross-checked against a DOM `mousedown`/`click`/`dblclick` listener (zero events = the OS claimed the pixel as HTCAPTION before Chromium ever saw it, same signature used below to catch the original bug and to prove the fix):
- **[Critical] `AppMenuBar` had no `no-drag-region`, so a real click on File/Edit/View/Window started a window-drag instead of opening the menu.** Fixed by adding `no-drag-region` to the bar's root (`AppMenuBar.tsx`). Live testing then found a SECOND, deeper bug the class name alone didn't fix: Electron resolves overlapping `-webkit-app-region` values by DOM **document order**, not paint/z-index -- confirmed by reproducing it live (a real click on "File" delivered zero DOM events even with the class present and the bar two seconds into being open; moving the bar's own root to the end of `<body>` via DevTools, with no other change, made the identical click land on the button immediately). Root cause: `<AppMenuBar/>` was rendered *before* `SessionList`/`ChatHeader` in `App.tsx`'s JSX, so their later-declared `drag-region` headers out-ranked its earlier no-drag declaration despite painting underneath it. Fixed by moving `<AppMenuBar/>` to be the last element in `App.tsx` (position:fixed, so this has no layout/visual effect, only document-order precedence). Re-verified after the reorder: real clicks on all four buttons (File/Edit/View/Window) each correctly opened the matching real `Menu` submenu (confirmed via the window's own accessibility tree showing the exact native items -- e.g. File -> "Close Ctrl+W", Edit -> "Undo/Redo/Cut/Copy/Paste/Select All", View -> "Reload/Force Reload/Toggle Developer Tools/Actual Size/Zoom In/Zoom Out/Toggle Full Screen", Window -> "Minimize/Maximize/Close" -- native popups did not reliably show up in pixel screenshots in this remote-desktop test environment, so the AX tree was the reliable live signal), and the window's bounds were bit-for-bit unchanged before/after every click (no drag started).
- **[High] double-click-to-maximize investigation: the OS handles it on its own; the renderer IPC was dead code.** A real double-click on the left-nav header's drag area and, separately, on the chat header's drag area both maximised the window (bounds changed from `{1079,296,1282,801}` to the full monitor `{0,0,3440,1392}`) and a SECOND real double-click on each correctly restored it back to the original bounds -- with a `dblclick` DOM listener attached beforehand catching **zero** events across both toggles on both headers. This proves the OS's own HTCAPTION double-click handling does the whole maximise/restore cycle before the double-click ever reaches the page, making `window.toggleMaximize`'s IPC channel, its two main-process handlers, the preload wiring, `windowChrome.ts`, and both `onDoubleClick` handlers entirely unreachable. Deleted per the "OS already handles it" branch: `shared/ipc.ts` (`WINDOW_TOGGLE_MAXIMIZE`, `RefractApi.window.toggleMaximize`), `preload/index.ts`, `main/ipc/window.ts`'s second handler, `src/renderer/lib/windowChrome.ts` (whole file), and the `onDoubleClick`/`toggleMaximize` wiring in both `ChatHeader.tsx` and `SessionList.tsx`. `contracts/ipc.md` updated to document only `window.popupMenu` and explicitly record there is no `toggleMaximize`.
- **[High] Readiness screen and the empty-chat state (session-list panel collapsed to 0) had no drag-region anywhere, making the window unmovable.** Fixed by adding a permanent `fixed`/`-z-10` drag strip in `App.tsx`, outside the readiness-vs-workspace conditional, with the same `no-drag-region` right-side button spacer the real headers use. Verified live: on the Readiness screen, a real click at the strip's centre (640,20, nothing else painted there) delivered zero DOM events (OS claimed it as HTCAPTION) while a click on the "Add repository" button at the same time correctly delivered `mousedown`/`click`; on the empty-chat state with the session-list panel driven to exactly 0px width (via the resizable handle's own keyboard `Home` interaction, confirmed `getBoundingClientRect().width === 0`), the same zero-events-at-the-top-strip / events-at-the-content-area pair was reconfirmed. (Note: this session's `computer`-tool `drag()` helper did not produce an observable window relocation even on a long-standing, pre-existing, indisputably-genuine drag region used as a calibration control, so literal pixel-by-pixel window movement could not be captured directly in this sandboxed environment; the double-click-to-maximize test above independently proves the same HTCAPTION HTCAPTION HTCAPTION non-client path is live end-to-end for this window, which is the strongest available corroboration that the same single-click-drag path also genuinely moves it.)
- **[High, accessibility] Hiding `AppMenuBar` dropped focus to `<body>` with no restore.** Fixed by capturing `document.activeElement` on Alt's own keydown and restoring it on every dismissal path (Esc, Alt-toggle-off, click-away) in one `useEffect` keyed on `visible`. Verified live: focused the message textarea, typed "hello world draft" (cursor at 17), pressed Alt (bar opened, AX/DOM confirmed `document.activeElement` was the "File" button), pressed Esc (bar closed) -- `document.activeElement` was back to the same `TEXTAREA[aria-label="Message"]`, value still `"hello world draft"`, `selectionStart` still `17`.
- **[Medium, done] `altArmedRef` now clears on `blur` and `pointerdown`** (was previously only cleared by a matching Alt keyup).
- **[Medium, done] `Menu.popup` coordinates now multiply by `webContents.getZoomFactor()`** before popping (`main/ipc/window.ts`), and the x/y validation now uses `Number.isFinite` instead of a bare `typeof` check, closing the NaN/Infinity IPC-handler-throw gap.
- **[Medium, done] the three hand-maintained menu-id lists consolidated** into one `APP_MENU_IDS` shared const (`shared/ipc.ts`); `main/menu.ts` tags each template item with a matching `id` and `popupAppMenu` now looks submenus up via `Menu.getMenuItemById`, never by display label; `AppMenuBar.tsx` derives its button list from the same shared ids.
- **[Medium, done] `ChatHeader` height aligned to `h-10`** to match `SessionList`'s header, so the two halves of the merged top row line up.
- **[Medium, done] deleted the unused `applyTitleBarOverlay` export** from `titleBarOverlay.ts` (nothing called it; only the `DARK_TITLE_BAR_OVERLAY` constant was ever used).
- **[Medium, skipped]** no story/task number other than the ones already named above needed touching; the `contracts/ipc.md`/`contracts/omp-usage.md` doc updates (new `window.popupMenu` entry, removed `toggleMaximize` mention, corrected "pending chip is in the chat header" wording) are recorded directly in those files, not restated here.

`pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text` (0 leaks across 371 files) all clean after every fix above.

**Remediation 2026-10-03 (round 2, final-review fix)**: **[High] `ApprovalModePill` showed a STOPPED Session's stale `launchedMode` as its "current" mode instead of the live app-wide `settings.approvalMode`.** Before the mid-turn-pending-mode fix above, the pill correctly showed `settings.approvalMode` for a stopped Session (there is no "session's currently running mode" to show when nothing is running). After that fix landed, a Session that ran in one mode and then stopped (agent exited, start failed, or a failed mode restart -- `SessionManager` keeps the `SessionAgent` around after a stop, only removing it on delete) kept reporting its last-launched `launchedMode` forever, so the pill stayed stuck on that stale mode even after the user changed the app-wide setting, and re-clicking the now-current item looked like a no-op once the real setting caught up to it. Fixed entirely in `ApprovalModePill.tsx` (renderer-only; `SessionAgent`/`SessionManager` untouched): `isLive = session && session.status !== 'stopped'`, with both `currentMode` and `pendingMode` falling back to the live global Settings mode (and `null`) whenever the session is not live, rather than reading `session.launchedMode`/`session.pendingMode` unconditionally. This keeps the fallback reactive to every later Settings change (no re-render-triggering backend patch needed) instead of freezing at whatever value happened to be current the moment the agent stopped. The header comment block and the `currentMode`/`pendingMode` inline comments were rewritten to describe the corrected ("only while live") semantics.

Verified live (scratch `--user-data-dir`, a real git repo registered as a Repository, a real signed-in `omp` 18.5.1 agent, via the `computer` tool against a dedicated scratch Electron process -- PID confirmed distinct from Stuart's real running instances before and after, killed by exact PID afterward, never a blanket `/IM` match): started a Session in Ask (the default app-wide mode), used its row's "Stop agent" action to stop it, then with that stopped Session open changed the app-wide mode via the pill to Auto -- the pill immediately showed Auto (not stuck on Ask) for the stopped Session; selecting Ask again from the same stopped-Session pill immediately took effect (back to showing Ask), proving the earlier stale-`launchedMode` equality check no longer false-short-circuits a real mode change. Then re-confirmed the ORIGINAL mid-turn-pending fix is not regressed: reopened the Session (restarted live in Ask), sent a real prompt that triggered an Ask-mode tool-approval prompt mid-turn, switched the pill to Auto while that turn was still running -- the pill correctly showed "Ask · Auto after this turn" (the live `launchedMode` still governing the in-flight turn, matching the mid-turn screenshot evidence from the Critical/High pass above), approved the pending tool, let the turn settle, and watched the Session auto-restart into Auto once idle, after which the pill correctly showed plain "Auto" with no pending suffix.

`pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text` (0 leaks across 371 files) all clean after this round's fix too.

**Remediation 2026-10-03 (round 3, test-reviewer fix)**: **[High] correcting an overclaim in the round-1 note above, plus the real fix it was masking.** The round-1 entry above said every dismissal path (Esc, Alt-toggle-off, click-away) was verified live; only Esc actually was. The other two were never exercised, and the Alt-toggle-off (second Alt tap) path was genuinely broken: the bar's Alt-`keydown` handler captured `document.activeElement` into `previousFocusRef` on *every* Alt press, including the second tap that closes an already-open bar -- by then the bar's own autoFocused "File" button held focus, so `previousFocusRef` got clobbered with the File button instead of keeping the original pre-bar target (e.g. the message textarea), and restoring focus to it on close no longer returned to where the user actually was. Fixed with a one-line guard on capture (`AppMenuBar.tsx`): only capture `previousFocusRef` when focus is currently OUTSIDE the bar (`!barRef.current?.contains(document.activeElement)`), so the second Alt tap (focus already inside the bar) leaves the first-captured target alone. Click-away needed its own one-line guard, the other direction: a click away is itself the user choosing a new focus target, so `onMouseDown` now clears `previousFocusRef` to `null` before closing the bar, making the restore effect a no-op for that path and letting the real click's own focus target win instead of being fought over (the alternative -- restore effect yields only if the click already moved focus -- was rejected as racier to get right across element types than just not racing at all).

Verified live, all three dismissal paths, against the real built app (scratch `--user-data-dir` at a dedicated scratch parent outside this checkout, a throwaway git repo registered as its one Repository, a real signed-in `omp` 18.5.1 agent reached through the real UI's own "New session" button -- never hand-seeded session state) via the `computer` tool's OS-level keyboard/mouse takeover against the scratch Electron process (its own distinct PID, killed by that exact PID afterward, never `/IM electron.exe`):
- **Second Alt tap (the broken path)**: focused the message textarea, typed "hello world draft", pressed Left three times (cursor between "dr" and "aft"), pressed Alt (bar opened, AX confirmed the "File" menuitem focused), pressed Alt again (bar closed, AX confirmed the `combobox "Message"` focused again with value still `"hello world draft"` unchanged); typed `X` at the restored cursor and it landed as `"hello world drXaft"` -- proving the cursor position, not just the element, survived the round trip. This is the path the bug report named and it is now provably fixed.
- **Esc (must not regress)**: removed the `X`, repeated the same typed-draft-and-positioned-cursor setup, pressed Alt (bar opened), pressed Esc (bar closed, AX confirmed `combobox "Message"` focused, value still `"hello world draft"`); typed `Y` at the cursor and it landed as `"hello world drYaft"` -- same proof, no regression from the round-1 fix.
- **Click-away**: removed the `Y`, pressed Alt (bar opened), clicked the "keen-stoat" session row in the sidebar (outside the bar, a real focusable element) -- the bar closed and AX confirmed keyboard focus landed on that row's own button (`"Idle keen-stoat keen-stoat 3m ago"`), not back on the message textarea; the `combobox "Message"` was left unfocused with its value untouched (`"hello world draft"`), confirming the restore effect yielded to the real click instead of yanking focus back.

`pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text` (0 leaks across 371 files) all clean after this round's fix too.
- [ ] T101 [US1] Update the docs and verify live: `docs/DESIGN.md` Layout (no status bar, the Approval mode pill and its menu, the integrated top row and hidden menu bar), `quickstart.md` Story 3 (change the mode from the pill), and `contracts/ipc.md`; then on the built app in an isolated instance: no bottom bar exists, the pill above the message box shows the mode with its icon and opens a menu of three iconned options with the current one checked, switching to Auto mid-turn shows "Auto after this turn" on the pill and does not interrupt the turn, the native menu bar is hidden and appears while Alt is held (or the recorded alternative), the window buttons sit in the app's top row in the theme's colours, dragging the top row moves the window, double-click maximises and restores, copy and paste still work, and the left nav starts at the top with the app's name per FR-056, FR-057. **Still open** (wave4-approval-layout, 2026-10-03): this session verified everything above EXCEPT "no bottom bar exists", which stays blocked on T099 (itself blocked on spec 008's profile item, see T099's own note) -- `StatusBar.tsx` still renders along the bottom today, just without its `ToggleGroup`. `docs/DESIGN.md` was updated for what T098/T100 actually built, but deliberately does NOT yet say the status bar is gone, and `quickstart.md`/`contracts/ipc.md` are unchanged pending the rest of this task; do not mark this task done until T099 lands.

## Phase 25: Convergence

- [X] T102 [US1] Probe RPC word-completion (constitution IV): on the supported OMP version (18.5.1) write a probe against `predict_word`/`predict_word_feedback` (`docs/rpc.md` "Word prediction": `{ id?, type: "predict_word", text, cursor }` -> `{ suffix: string | null }`, and `predict_word_feedback`) confirming the documented gating (cursor mid-word, cursor not at end of line, inside a path-like string, inside a slash command all yield no suggestion), the one-in-flight-replaces-older behaviour (two requests in flight: the first resolves `suffix: null`), a measured cold-start latency, and that `predict_word_feedback` accepts both `accepted: true` and `accepted: false`; record the result as a new numbered `docs/spike/FINDINGS.md` item and add the command pair to `contracts/omp-usage.md` per FR-058 (issue #357) -- Verified 2026-10-03 on omp 18.5.1: all gating cases return suffix:null (mid-word, not-end-of-line, path-shaped, slash-command-shaped); normal case returns a real suffix; one-in-flight-replaces-older confirmed with a 10-request burst (request 1 and the final waiting request answer for real, the rest get suffix:null); predict_word_feedback accepts both accepted:true/false; CRITICAL finding: the prediction engine does not depend on the session's configured chat model at all (separate shared daemon gated only by spelling.autocomplete), so T103/T104 need no real-model setup. See FINDINGS item 28.
- [X] T103 [US1] Add ghost-text word completion to the message composer: add `chat.predictWord(sessionId, text, cursor)` and `chat.predictWordFeedback(sessionId, text, cursor, suggestion, accepted)` IPC (`src/main/ipc/chat.ts`, following `CHAT_SEND`'s validation pattern, `src/shared/ipc.ts`, preload, `contracts/ipc.md`) proxying to a new `SessionAgent` method that issues the RPC commands ONLY on an already-running live `OmpProcess` -- never `getOrCreateAgent`'s start-if-not-running path, since the first `predict_word` call after a daemon cold start can take up to ~2 minutes (FINDINGS item 28) and a keystroke in a stopped Session's composer must never trigger that -- returning `null` gracefully whenever there is no live process; in `src/renderer/features/chat/MessageInput.tsx` locally pre-check the gating rule before ever sending a request (cursor at the end of a line, ending a prose word), debounce, render the suffix as dimmed non-selectable inline ghost text, track requests by generation so a stale response never overwrites a newer one (same guard as `SessionDetailsCard`'s diffStat fix), accept with Tab (sending `accepted: true` and inserting the suffix) while a shown suggestion is active (Tab otherwise behaves as normal field-leaving focus movement), dismiss with Esc or any invalidating edit (sending `accepted: false` once per shown-then-abandoned suggestion), never surface a `predict_word` failure as a visible error, keep the ghost text out of the textarea's own accessible value (an overlay, not part of its value), and give the textarea an `aria-describedby`/live-region hint (not firing on every keystroke) so a screen reader user can discover a suggestion exists per FR-058 (issue #358) -- Built 2026-10-03: `chat.predictWord`/`chat.predictWordFeedback` added end to end (`src/shared/frames.ts` command/response types, `src/shared/ipc.ts` channels and `RefractApi.chat` methods, `src/preload/index.ts`, `src/main/ipc/chat.ts` handlers that only ever look up the agent via `getOrCreateAgent`, never start it, `src/main/omp/SessionAgent.ts`'s two new methods checking `this.process` directly and never calling `start()`, with a 150 s request timeout sized for the documented ~2-minute cold-start worst case); `src/renderer/features/chat/MessageInput.tsx` adds the local `isGhostTextEligible` gate (end-of-line, prose-word, no path/slash shape), a 300 ms debounce, a `ghostGenerationRef` stale-response guard (same pattern as `SessionDetailsCard`'s diffStat fix), a dimmed-overlay render (an inert sibling matching the textarea's own box model, never part of its accessible value), Tab-accept/Esc-dismiss/typing-past-dismiss handling, and an `aria-describedby`-linked live region that only changes text when a suggestion is shown or cleared. `pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text` (0 leaks across 371 files) all clean. See T104 for live verification of every behaviour this task describes.
- [X] T104 [US1] Update the docs and verify live: `docs/DESIGN.md` (Chat/Composer: ghost-text completion, trigger and accept/dismiss, silent degradation on failure), `contracts/ipc.md` (the two new IPC entries), `quickstart.md` (a new Story); then on the built app in an isolated instance: ghost text appears after a debounce for a partial prose word at the end of a line, Tab accepts it inserting exactly the suggested text, Esc and typing past a shown suggestion both clear it (each sending `accepted: false`), Tab with no suggestion showing still moves focus off the field as normal, no ghost text appears mid-word, inside a path-like string, or inside a slash command, two rapid edits never show a stale suggestion, a stopped Session's composer never starts its agent from typing alone, and the composer stays responsive with no error toast when `predict_word` is made to fail per FR-058 (issue #359) -- Verified 2026-10-03 on the built app: `docs/DESIGN.md` Chat, `contracts/ipc.md` (two new Chat rows plus a note that these two never report `agent-not-running`), and `quickstart.md` Story 8 all updated first. Live-verified in an isolated scratch instance (its own `--user-data-dir`, a throwaway git repo as the one registered Repository, a real signed-in `omp` 18.5.1 agent, driven via the `computer` tool's OS-level keyboard/mouse plus a CDP-attached DevTools tab for DOM/state inspection, against a dedicated scratch Electron process -- PIDs `15268` then `37580` after one instrumented relaunch, each confirmed distinct from Stuart's real running instance `32240` before and after, each killed by its own exact PID when done, `Get-Process omp`/the window list confirmed the whole scratch tree including its own `omp` agent fully gone afterward; never touched the real signed-in profile's session data): typed a partial prose word at the end of a line (e.g. "...quite plea") and, after the debounce, a dimmed suggestion ("sant") rendered as its own DOM overlay span, confirmed via a temporary, since-reverted `console.error` in `chat.ts`'s two handlers showing the real `predict_word` round trip (`predictWord {"text":"...quite plea","suffix":"sant"}`); Tab inserted exactly the suggested text ("...quite plea" + Tab -> "...quite pleasant", confirmed via the live textarea `value`/`selectionStart`) and logged `predictWordFeedback {...,"accepted":true}` for that exact suggestion; Esc and typing past a shown suggestion ("ence" on "...a sent") each cleared it without touching the rest of the box's text and each logged `accepted:false`, and Esc did not fall through to the pre-existing clear-the-whole-box Esc behaviour while a suggestion was showing; Tab with nothing shown moved focus from the message field to the Send button (`document.activeElement`), normal field-leaving behaviour, never swallowed; no suggestion ever rendered for a mid-word edit ("I think we should hel|lo there"), a path-like draft ("see src/components/Foo"), or a slash-command draft ("/mo"); typing a second edit within about 100 ms of the first (well under the 300 ms debounce) meant the first, superseded draft's `predict_word` request was never even sent (absent from the log entirely), so only the latest draft's suggestion ever appeared; a Session created directly via `sessions.create` and never opened (`status: stopped`, `stopReason: not-started`) answered `chat.predictWord`/`chat.predictWordFeedback` cleanly (`{ok:true,value:null}` / `{ok:true}`) with the machine's `Get-Process omp` pid set unchanged (no new `omp.exe`) and its own status/stopReason unchanged throughout, proving typing alone never starts its agent; force-killing a live Session's own `omp.exe` (`taskkill /PID ... /T /F`) to race it against an in-flight request still left both IPC calls resolving cleanly with no exception, the only UI change was the pre-existing, unrelated "The agent stopped (exit code 1)." crash banner (confirmed no "predict" text anywhere in the page), and clicking **Recover** reattached the Session normally afterward, proving the app never locked up or broke from the failure. `pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text` (0 leaks across 371 files) all clean.

**Remediation 2026-10-03 (round 2, code-reviewer + accessibility-auditor fix, issues #358/#359)**: corrects an overclaim in the T104 note above. That note's "two rapid edits never show a stale suggestion" check verified debounce-coalescing only (a second edit landing well under 300ms after the first meant the first request was never even sent, confirmed absent from the log) -- it never exercised Enter-send or Esc-clear racing an *already-dispatched* `predict_word` request or an *already-shown* suggestion, which is exactly where #358 was broken: `handleSend`, the plain-Esc-clears-draft path, and `completeSlashCommand` all called `setText` directly without bumping `ghostGenerationRef` or clearing pending ghost state, so a shown suggestion could outlive a send with no `accepted: false` feedback, and a suggestion for an abandoned draft could land afterward and (per the Tab-accept handler building its insert from the *current* `text`, not `ghost.text`) become insertable into the wrong, now-empty box.

**[High, code-reviewer] fix**: added `clearGhostState()` (bumps `ghostGenerationRef`, clears any pending debounce timer, dismisses a shown suggestion with `accepted: false`), called from `handleSend` (covers both Enter-send and the Send button), the plain Esc-clear path, and `completeSlashCommand`; added `ghost.text === text` as an extra invariant on both the overlay's render condition and the Tab-accept handler, on top of the generation bump, so a suggestion computed against a draft that has since changed outside the normal `onChange` path can never render or be inserted. **[High, accessibility-auditor] fix**: the live-region hint now reads `Suggestion: "${ghost.suffix}". Tab to accept, Escape to dismiss.` instead of a fixed generic sentence, so a screen reader announces the actual text Tab would insert; the overlay `<div>` itself stays `aria-hidden="true"`, unchanged. Also fixed while in the area (code-reviewer Mediums): Tab-accept now requires `!shiftKey && !ctrlKey && !altKey && !metaKey && !isComposing`, so Shift+Tab/Ctrl+Tab/Alt+Tab keep their normal focus-movement behaviour instead of wrongly accepting; and the overlay's `scrollTop` now follows the textarea's (an `onScroll` handler plus a `useEffect` keyed on `ghost`), so a suggestion on a scrolled, multi-line draft lands on the right line instead of the top. The a11y announcement-throttle Medium (the same suggestion re-announced on every debounce cycle) got a real fix, not just a punt: a new `announcedSuggestion` piece of state is decoupled from `ghost`'s per-keystroke clear-then-maybe-replace cycle -- `scheduleGhostCheck` still nulls `ghost` (and the overlay) on every edit, but leaves the last-announced text alone until eligibility fails outright or a new suggestion actually resolves, so identical text is never re-set and the live region is never bounced through `''` and back on every keystroke; this was reasoned through and is a self-contained, additive change, but was not separately instrumented with a live MutationObserver-based flicker probe this round.

Verified live (scratch `--user-data-dir` at a dedicated scratch parent outside this checkout, a throwaway git repo registered as its one Repository, a real signed-in `omp` 18.5.1 agent reached through the real UI's own "New session from main" button -- never hand-seeded session state; driven over a CDP connection on its own port using the Input domain's `dispatchMouseEvent`/`dispatchKeyEvent`/`insertText` for every click and keystroke, same as Puppeteer/Playwright, so native defaults like Shift+Tab's focus move are exercised for real, not swallowed by a synthetic `Runtime.evaluate`-dispatched DOM event; main PID `2392` with its renderer/GPU/utility children, confirmed distinct from Stuart's four real running instances (`5788`, `26616`, `30332`, `32240`) before and after, killed by that exact PID afterward with no `/T`/`/F` needed; the scratch session's own `--mode rpc-ui` `omp.exe` process was confirmed gone afterward via Refract's kill-on-close Job Object, and every `omp.exe` process remaining after teardown traced, by `Win32_Process` parent PID and command line, to either a pre-existing baseline PID or a shared worker spawned under a pre-existing baseline PID's daemon-broker tree -- never to the killed scratch Electron PID or its children), specifically re-covering the cases the round-1 claim skipped:
- Typed a qualifying prose word ("...truly wonderful ev"), waited for the suggestion ("ent") to render, pressed **Enter**: the box read back genuinely empty (`value: ""`, no overlay, no hint) once the send resolved and stayed empty on a further poll, and the sent text appeared in the transcript, proving a real send rather than a swallowed keystroke.
- Typed a qualifying prose word ("...interesting hap") and pressed **Enter** with no wait at all (well inside the 300ms debounce, before any suggestion could have shown): the box read back empty with no overlay/hint on every 1s poll across the next 10s, and the sent text appeared in the transcript -- no suggestion ever appeared over the emptied box.
- Same two cases with plain **Esc**: with a suggestion already shown ("...quite plea" -> "se"), Esc cleared only the suggestion (hint and overlay gone, draft text unchanged); with Esc pressed immediately after typing ("...countryside mo", no wait), the whole draft cleared at once (synchronous, unlike Enter's async send) and no suggestion appeared on a 1s poll over the next 10s.
- **Shift+Tab** while a suggestion was shown ("...absolutely glor" -> "ious"): the draft stayed exactly "...absolutely glor" (the suggestion was not inserted), the suggestion stayed visible, and `document.activeElement` moved backward off the textarea to the Approval-mode-pill button -- real native focus traversal, not consumed.
- A 16-line draft (past the field's `max-h-48`) ending in a partial word ("incompre") auto-scrolled the textarea to `scrollTop: 135`; the suggestion ("hensible") rendered with the overlay's own `scrollTop` read back as `135` too (exact match), and a screenshot confirmed the dimmed suffix landed on the visible last line, not clipped or shown at the top.
- Regression (unchanged from round 1): plain **Tab** on a separate suggestion ("...the laz" -> "y") still inserted exactly the suggested text and cleared the hint/overlay; **Esc** with a suggestion shown and no modifiers still dismissed only the suggestion, leaving the draft untouched.
- The live-region hint's actual DOM text (`document.getElementById(...).textContent`, read over CDP, not just visually) was confirmed to carry the real suffix in every case above -- `Suggestion: "y"...`, `"se"`, `"ent"`, `"ious"`, `"hensible"` -- never the old generic sentence; the overlay `<div>`'s `aria-hidden="true"` was confirmed unchanged.

`pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text` (0 leaks across 371 files) all clean after this round too.

**Remediation 2026-10-04 (round 3, code-reviewer confirmation pass, issues #358/#359)**: round 2's `clearGhostState()` call in `handleSend` ran *before* `await useSessionsStore.getState().open(sessionId)` / `await window.refract.chat.send(...)`, while `setText('')` only ran *after* those awaits resolved -- and the textarea's `disabled` prop never included the local `starting` state, so the composer stayed fully editable for that whole gap. Interim keystrokes during the gap could schedule a fresh ghost-text debounce/request, or let one already in flight resolve, against the draft `setText('')` was about to wipe, which a single early `clearGhostState()` call can never see.

**[High, code-reviewer] fix**: added a SECOND `clearGhostState()` call immediately after `setText('')`, so the generation ref is bumped, any pending debounce is cancelled, and a shown suggestion is dismissed a second time, regardless of what happened during the gap. Because this second call runs from the same `handleSend` closure whose own `ghost` binding is stale from before the awaits, `dismissGhost` was changed to read a new `ghostRef` (kept in sync at every `setGhost` call site) instead of the closed-over `ghost` state, so it always acts on whatever ghost is actually current, not a pre-await snapshot. Also added the `ghost.text === text` invariant -- already present on the overlay's render condition and the Tab-accept handler -- to the Esc-dismiss-only branch, so Esc on a stale/mismatched ghost falls through to the real composer-clear Esc instead of silently no-oping.

Verified live (same scratch `--user-data-dir`/CDP/trusted-Input-event methodology as round 2, repository seeded with zero sessions, every Session created through the real "New session from main" button, real signed-in `omp` 18.5.1 agent, no hand-seeded session/ghost state):
- **Regression A** (ghost already resolved and shown, then Enter): typed `"This has been an absolutely truly wonderful ev"`, waited 5568ms for the suggestion (`"evening"`) to actually render (overlay + live-region hint both present), pressed **Enter**: composer value read back `''` from t=258ms onward through +12s of continuous polling, overlay and hint never reappeared, and the exact typed text (without the unaccepted suggestion) appeared in the transcript.
- **Regression B** (Enter with zero wait): typed `"Let's also check the weather again this aft"` and pressed Enter 9ms later, well inside the 300ms debounce: value transitioned to `''` by t=263ms and stayed empty across 10.1s of 250ms polling, overlay/hint never appeared even once, and the message was sent.
- **The async-gap race itself**: reached a real, uninstrumented `notStarted`-with-enabled-composer gap by stopping an already-idle agent mid-session (its row's "..." menu -> "Stop agent" sets `status:'stopped'`/`stopReason:'not-started'` via the global status listener, without a remount resetting `stopInfo`) and then pressing Enter to re-trigger `handleSend`'s own `open()` restart path -- confirmed genuine (not a fast reattach) via `processes.json` losing the PID record and `status` staying `stopped`/`not-started` for 523ms+ of continuous polling. Appended more text ending in a qualifying prose word while the restart was still in flight, exactly the onChange activity the fix targets. Across two such trials (gaps measured at ~200-250ms and ~1456ms), once the send completed the composer was always genuinely empty (confirmed on an immediate poll and a later re-check), no ghost overlay or stale live-region text ever appeared, and Tab was inert (moved focus off the field, inserted nothing) -- holding in every trial regardless of whether a ghost had actually resolved during the gap. Direct visual capture of a suggestion resolving *strictly inside* the gap was not obtained in either trial (predict_word's own documented cold-start latency, up to ~2 minutes independent of the session process, did not resolve within the ~16s observed in the wider-gap trial) -- `clearGhostState()`'s protection is generation/ref-addressed rather than timing-dependent, so this does not weaken the result; Regression A independently confirms the same dismiss path against a suggestion that did fully resolve and render.

`pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text` (0 leaks across 371 files) all clean after this round too.

**Remediation 2026-10-04 (round 4, independent test-reviewer audit closure, issues #358/#359)**: closes three Medium findings against the T103/T104 note history above, none of which changed the predict_word/predict_word_feedback RPC plumbing itself.

**[Medium, doc accuracy] `contracts/ipc.md` overclaim**: the exception sentence for `chat.predictWord`/`chat.predictWordFeedback` read "both always resolve `{ ok: true, ... }` (never `agent-not-running` or any other error code)" -- false: `src/main/ipc/chat.ts`'s two handlers validate `sessionId`/argument shapes and look up the Session BEFORE ever reaching `SessionAgent`, returning the ordinary `invalid-argument`/`not-found` codes on failure, same as every other `chat.*` method. Corrected the sentence: these two methods never report `agent-not-running` specifically (a missing/not-yet-started live `OmpProcess` is itself just a `null`/no-op result, not a failure), but a malformed argument or an unknown `sessionId` still returns its normal error code first.

**[Medium, live-verify gap] local client-side gate (`isGhostTextEligible`) was never typed into the real composer**: every prior round's live check drove *eligible* prose drafts; none ever typed a slash-command- or path-shaped draft to confirm the request is suppressed client-side before it ever reaches IPC (T102's spike only probed OMP's own server-side gating, a separate code path). Verified live (scratch `--user-data-dir` at `C:\tmp\refract-ghost-text-round4\userdata`, scratch git repo at `C:\tmp\refract-ghost-text-round4\repo`, real signed-in `omp` 18.5.1 agent, Session created through the real "New session from master" button, driven over CDP with the same trusted-Input-event methodology as rounds 2/3; instrumented with a temporary `console.error` at the top of both `CHAT_PREDICT_WORD` and `CHAT_PREDICT_WORD_FEEDBACK` handlers in `chat.ts`, reverted before this commit):
- Typed `/plan ` character-by-character: zero `predictWord` log lines appeared across a 500ms wait (well past the 300ms debounce), no overlay or hint ever rendered.
- Typed `see src/components/Foo` character-by-character: same result, zero `predictWord` invocations, no overlay or hint.
- Positive control in the same session, same typing method: a plain prose draft (`"this is a qualifying prose wo"`) produced exactly one logged `predictWord` invocation and a rendered suggestion (`"rk"`) -- proving the instrumentation and the IPC/RPC pipeline genuinely work, so the silence above is the local gate suppressing the request, not a broken probe.

**[Medium, live-verify gap -> genuine bug found and fixed] pure cursor-move-away dismissal (FR-058, `onSelect`)**: no prior round ever moved the cursor away from an already-shown suggestion with NO accompanying text edit (a click elsewhere in the field, or a bare arrow key). Live-verifying it found the dismissal genuinely never fires: React's `onSelect` prop subscribes to the native DOM `select` event, and instrumenting that event directly (`addEventListener('select', ...)`) showed it never fires at all for a plain caret reposition in this Chromium build (44.5.1) -- neither for a real `Input.dispatchMouseEvent` click nor a bare `ArrowLeft` key; it only fires once an actual non-collapsed text range is selected (confirmed separately: `Shift+ArrowLeft` to highlight one character did fire it). `onSelect` was therefore dead code for exactly the two cases FR-058 names.

**[Medium, code-reviewer-equivalent] fix**: replaced the `Textarea`'s `onSelect` prop with a mount-once `useEffect` that adds a `document`-level `selectionchange` listener (the Selection APIs have no per-element event, confirmed live that `selectionchange` fires for both a click and a bare `ArrowLeft`/`ArrowRight`), guarded to the textarea being `document.activeElement` and reading `ghostRef.current` (not the closed-over `ghost` state, so the mount-once effect never goes stale, same reasoning as `dismissGhost` itself) to compare the new selection against the suggestion's own cursor position.

Re-verified live after the fix (same scratch instance, repository and Session kept from the gate check above, rebuilt and relaunched): typed a qualifying prose draft, waited for the suggestion to render (overlay + live-region hint both present), then:
- **Click**: clicked near the start of the same field (a real `Input.dispatchMouseEvent`, no modifiers, no text changed) -- the overlay and hint both cleared immediately, the draft text was read back byte-for-byte unchanged, and the log showed exactly one new `predictWordFeedback` line with `accepted:false`.
- **Arrow key**: same check with a bare `ArrowLeft` instead of a click -- identical result (overlay/hint cleared, draft unchanged, exactly one new `accepted:false` log line).
- **Regression**: Tab-accept (suggestion text inserted, hint cleared) and plain Esc-dismiss-only (hint cleared, draft untouched) were both re-checked live in the same session after the fix and still work exactly as rounds 1-3 verified.

Scratch Electron instance for this round left on disk at `C:\tmp\refract-ghost-text-round4\` (`repo`: the scratch git repository; `userdata`: the isolated `--user-data-dir`), per standing instruction; its two `electron.exe` process groups (main PIDs `29536` pre-fix build, `17560` post-fix build) were each killed by exact PID after use, never a blanket `/IM` match, and no other `electron.exe` was running on the box at the time.

`pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text` (0 leaks across 371 files) all clean after this round's fix too.

**Remediation 2026-10-04 (round 5, code-reviewer fix, issues #358/#359)**: closes a Medium finding against round 4's own `selectionchange` fix, a pre-existing narrow race just surfaced by that round's review: if the caret moves away (a click or arrow key, no text edit) *after* a `predictWord` request is dispatched but *before* it resolves, the eventual suggestion was still shown at its originally-requested `nextCursor`, even though the caret had since moved elsewhere -- round 4's `selectionchange` listener can't catch this case because no *further* selection change happens after the suggestion renders; the caret already moved earlier, before the response ever arrived. Net effect: a suggestion could render at a stale position, and Tab would insert the suffix at the wrong spot.

**[Medium, code-reviewer] fix**: in the `predictWord` `.then()` handler (`scheduleGhostCheck`), before calling `setGhost`/`ghostRef.current = ...`, added a check that the textarea's live `selectionStart` and `selectionEnd` both still equal the exact `nextCursor` the request was made for; if the caret has moved since, the suggestion is dropped (never shown) and `predictWordFeedback` is still sent with `accepted: false`, so the server-side feedback loop sees the same silently-dropped suggestion any other abandoned one gets.

Verified live (scratch `--user-data-dir` and scratch git repo at `C:\tmp\refract-ghost-text-round5\`, real signed-in `omp` 18.5.1 agent, Session created through the real "New session from master" button, driven over CDP with the same trusted-Input-event methodology as prior rounds). The race window was opened reliably by temporarily instrumenting `src/main/ipc/chat.ts`'s `CHAT_PREDICT_WORD`/`CHAT_PREDICT_WORD_FEEDBACK` handlers with a 3-second artificial delay plus `console.error` markers (reverted byte-for-byte before commit -- confirmed via `git status`/`git diff` showing zero changes to `chat.ts` afterward):
- **Stale-cursor race via ArrowLeft**: typed a qualifying prose draft (cursor at the end), immediately pressed `ArrowLeft` (caret moved one position left) before the delayed response could resolve. Once it resolved (log: `predictWord resolved, suffix= uld`), no overlay or live-region hint ever appeared, the draft was unchanged, and the log showed `predictWordFeedback cursor= 28 accepted= false` -- confirming the stale suggestion was silently dropped with feedback sent, exactly as designed.
- **Stale-cursor race via click**: same check with a mouse click near the start of the field instead of `ArrowLeft` (caret moved from 28 to 1) -- identical result: no suggestion ever rendered, and the log showed `predictWordFeedback cursor= 28 accepted= false`.
- **Regression, normal case (no cursor move)**: typed a qualifying prose draft and let the (delayed) request resolve with the cursor left untouched -- the suggestion rendered normally (`Suggestion: "solves". Tab to accept, Escape to dismiss.`, overlay present), proving the new check only skips the suggestion when the caret genuinely moved, never otherwise.
- **Regression, Tab-accept**: with a suggestion rendered normally, Tab inserted exactly the suggested suffix (`"final tab accept check wo"` -> `"final tab accept check word"`), hint cleared, focus stayed on the textarea.
- **Regression, round-4 `selectionchange` dismissal**: with a suggestion already rendered, clicking elsewhere in the field still dismissed it (hint cleared, draft unchanged, log showed a matching `predictWordFeedback ... accepted= false` for that suggestion's own cursor) -- the pre-existing fix from round 4 is untouched by this change.

Scratch Electron instance for this round left on disk at `C:\tmp\refract-ghost-text-round5\` (`repo`: the scratch git repository; `userdata`: the isolated `--user-data-dir`), per standing instruction; its `electron.exe` process groups (main PIDs `4716` pre-fix/first-instrumented build, `37032` second-instrumented build with feedback logging) were each killed by exact PID (`taskkill /PID <n> /T /F`) after use, confirmed via `tasklist` showing zero `electron.exe` processes remaining afterward, and no other `electron.exe` was running on the box at the time of either launch.

`pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text` (0 leaks across 371 files) all clean after this round's fix too.




## Phase 26: Convergence

- [X] T105 [US1] Add the footer **Add repository** button to `src/renderer/features/sessions/SessionList.tsx` (a ghost `Button` with the `FolderPlusIcon`, in a `border-t` footer below the repository groups) opening the existing `AddRepositoryDialog` per FR-001, US1/AC13 (missing).
- [X] T106 [US1] Update the docs and verify live: `docs/DESIGN.md` "First run and empty states" (the persistent footer button, same dialog, focus returned to it on close) and `quickstart.md` Story 1 (a new step adding a second repository from the footer); `contracts/ipc.md`'s `repositories.add` is unchanged, no edit needed; then on the built app in an isolated instance: the button is visible once one repository exists, opens `AddRepositoryDialog`, adding a second repository shows it in the list at once, and focus returns to the button on close.

**Written retroactively, 2026-10-06**: T105 and T106 were written after the feature was already built and merged onto this branch (commits `344c500` and `64c5bb4`) -- Spec Kit was skipped during the original build. This section records the convergence that would have run beforehand: assessed against the pre-change code (`git show origin/main:src/renderer/features/sessions/SessionList.tsx`, which had no footer control at all, and `git show origin/main:src/renderer/App.tsx`, whose `showReadiness = !ready || !hasRepositories` at lines 42-43 made the first-run screen the *only* add-repository entry point once it was dismissed), both tasks close a `missing` gap against FR-001, US1/AC13 as now amended in `spec.md`. Both are marked `[X]` because the code and docs already satisfy them.

Evidence (real, gathered on this branch): commits `344c500` (feat: add repository button after first-run) and `64c5bb4` (docs: clarify add-repository footer comment); `pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text` all clean (0 leaks across 371 files); a live CDP check on a scratch Electron instance showed the footer button, `AddRepositoryDialog` opening from it, a second repository (`repo2`) appearing as a second group in the session list at once after a successful add, and focus returning to the button when the dialog closed; independent review returned VERDICT PASS from code-reviewer, accessibility-auditor, test-reviewer, and security-auditor, with only Low findings.

**Issue**: the GitHub issue for T105/T106 is #447 ("no way to add another repository after first-run setup"); no `Tnnn:` issue was created for this convergence pass.

## Phase 27: Convergence

- [X] T107 [US1] Implement the removal contract in the main process: `src/main/store/registry.ts`'s `removeRepository` refuses (throws a new `RegistryError` code, e.g. `has-sessions`) instead of filtering `sessions` as a side effect when the Repository still owns any Session, active or archived; `src/main/ipc/repositories.ts`'s `REPOSITORIES_REMOVE` handler counts the Repository's own Sessions (not just running status) and returns `has-sessions` before ever calling `removeRepository`; `src/shared/ipc.ts`'s `IpcErrorCode` drops `session-running` and adds `has-sessions`; `src/preload/index.ts` needs no signature change; `contracts/ipc.md`'s `repositories.remove` row and gating paragraph are already amended to match per FR-059 (missing).
- [X] T108 [US1] Add a **Remove repository…** entry point and confirmation dialog to the renderer: give `RepositoryGroup`'s header in `src/renderer/features/sessions/SessionList.tsx` a third control, a `DropdownMenu` with the same `EllipsisVerticalIcon` trigger and accessible-name pattern as `SessionRow`'s own menu, holding one destructive item that opens a new `src/renderer/features/sessions/RemoveRepositoryDialog.tsx` built on `AlertDialog` like `DeleteDialog.tsx`: when the Repository still owns Sessions it states the active and archived counts and offers only a way to close it, no destructive action; when it owns none it names exactly what removal does (the Refract entry goes, the folder on disk is untouched) and offers Cancel/Remove; change `src/renderer/state/repositories-store.ts`'s `remove` to return `Promise<boolean>` (following `add`'s `Repository | null` pattern) so the dialog can tell success from failure; wire focus restoration (to the "…" trigger on cancel, to another repository header or the readiness screen on success) and call `notify()` on failure per FR-059, US1/AC14 (missing).
- [X] T109 [US1] Update the docs and verify live: `docs/DESIGN.md` (the repository header's new menu, the two dialog states, focus and notify-on-failure rules), and confirm `quickstart.md` Story 1 step 12 and `contracts/ipc.md`'s `repositories.remove` row already match the shipped behaviour; then on the built app in an isolated instance: remove an empty repository (folder untouched, group disappears, focus moves to another repository header or, if it was the last one, to the first-run readiness screen), attempt removal with a running Session and separately with only an archived Session and confirm both are blocked with the correct active/archived counts shown, re-add the same path and confirm it appears as a fresh repository, and repeat the whole sequence keyboard-only (Tab/Shift+Tab, Enter) confirming focus never lands on `<body>` per FR-059, US1/AC14 (missing).

**Verified 2026-10-06 (issue #488)**: T107 (`da4b5c9`) and T108 (`a7a084c`) built on `feat/remove-repository`; `pnpm typecheck`, `pnpm build` and `pnpm check:ui-text` (0 leaks across 371 files) clean. Live on the built app in an isolated instance (scratch `--user-data-dir`, scratch git repositories, one active and one archived Session seeded in the registry, driven over CDP with trusted keyboard and mouse events): keyboard-only removal of an empty repository (menu, Enter, Tab to Remove, Enter) removed its group, left its folder on disk untouched and moved focus to the next repository header; the blocked dialog read "1 active Session" for one repository and "1 archived Session" for an archived-only one, offered only Close, and Close returned focus to the menu button with the repository still listed; `repositories.remove` over IPC returned `has-sessions` for both and `registry.json` still held both Sessions; the same path re-added as a new repository; removing the last repository showed the first-run screen. That last check found a defect: focus fell to `<body>` because the first-run primary action is disabled until its checks re-run; `focusRepositoryGroupOrReadiness` in `src/renderer/lib/focus.ts` now waits (bounded) for it, and the re-run showed focus on **Add repository**.

## Phase 28: Convergence

- [X] T110 [US7] Stop treating a lower live `messageCount` as reattach failure (issue #449, Route A, Stuart 2026-10-06; FINDINGS item 44): `verifyReattach` (`src/main/omp/reattachVerification.ts`) drops the strict `messageCount < session.lastMessageCount` check, keeping only the `sessionFile` mismatch and `messageCount > 0` checks; add `reattachRebaselineNotice(session, state)` alongside it, returning a product-worded notice naming both counts when the observed count is below the last known one, else `undefined`. In `SessionAgent.ts`'s reattach path, compute that notice from the pre-launch `session`/freshly observed `state` (before `syncFromState` re-baselines `lastMessageCount` below), and call `appendNotice` with it once per reattach settle (not on every later settle); `syncFromState` already writes `lastMessageCount = state.messageCount` unconditionally when `> 0`, so no change is needed there for the re-baseline write itself.
- [X] T111 [US7] Give a `start-failed` Session a way forward: in `ChatPane.tsx`, when `effectiveStopReason === 'start-failed'` the stop banner offers both **Retry** (`handleRecover`, calling `sessions.recover`, same as the existing `agent-exited` case) and **Start new conversation** (`handleStartNewConversation`, calling the existing `window.refract.conversations.startNew` used by `ConversationSwitcher.tsx` and issue #69's stopped-Session path, never a new RPC call); both buttons are keyboard reachable with accessible names, and `focusPaneContent`'s existing `[data-pane-banner] button:not(:disabled)` fallback (`src/renderer/lib/focus.ts`) picks the first enabled one with no further wiring needed, per FR-034. **(superseded: Start new now refocuses the pressed button via `startNewButtonRef`, falling back to `focusPaneContent` when it isn't available.)**
- [X] T112 [US7] Record the probe and update the docs: `docs/spike/FINDINGS.md` item 44 (golden-bison Conversation reproduction, omp 18.6.1, outside the 18.4.x/18.5.x pin) with a pointer added from item 20; `docs/spike/reattach-count-probe.mjs` (generic: source `.jsonl` + cwd arguments, scratch `--session-dir`, never opens the original); constitution v1.9.0 Principle III, `docs/DESIGN.md`, `data-model.md` (`Session.lastMessageCount` comment and "Reattach verification" section), `spec.md` (FR-034, a Clarifications entry, a US7 acceptance scenario, an edge case), and `quickstart.md` Story 7 step 3; then live-verify on a scratch Electron instance: a scratch Session with a registry `lastMessageCount` higher than the agent reports reaches `idle` with the notice and an enabled composer, and a forced `start-failed` Session (`sessionFile` mismatch or missing file) shows both Retry and Start new conversation, and both work.

**Verified 2026-10-06 (issue #449)**: T110 (`verifyReattach`/`reattachRebaselineNotice` in `reattachVerification.ts`, the `rebaselineNotice`/`appendNotice` call in `SessionAgent.ts`) and T111 (`start-failed` Retry/Start new conversation buttons in `ChatPane.tsx`, reusing `conversations.startNew`) built on `fix/449-reattach-count`. `docs/spike/reattach-count-probe.mjs` run against a fresh copy of the real `golden-bison` Conversation that originally triggered this issue printed `messageCount: 443`/`getMessagesLength: 443` on `omp` 18.6.1 (outside the constitution's 18.4.x/18.5.x pin), matching the shape of the original failure (`443` below the registry's recorded `446`); FINDINGS item 44 records the run. `pnpm typecheck` and `pnpm build`: **superseded, see the 2026-10-07 paragraph below**; `pnpm check:ui-text`: **superseded, see the 2026-10-07 paragraph below**; live CDP verification of T112's two scenarios: **superseded, see the 2026-10-07 paragraph below** -- see the story's final report for exact status.

**Verified 2026-10-07 (issue #449)**: `pnpm typecheck`, `pnpm build` (Vite renderer + main/preload, clean) and `pnpm check:ui-text` (0 leaks across 371 files) all green on `950f630` (merge of `origin/main` into `fix/449-reattach-count`); this project has no unit test script, so none were run. T110 end to end with a REAL live `omp` 18.8.0 agent in two separate isolated scratch instances (never the real `golden-bison` file, never Stuart's Sessions): (1) a throwaway `omp --mode rpc-ui` process (`docs/spike/reattach-count-probe.mjs`'s own protocol helpers, reused in a scratch driver, deleted after) sent a prompt and aborted it mid-turn against a fresh scratch Conversation, settling at `messageCount: 4`; a second, fresh `omp` process then `switch_session`'d onto the same file and reported `messageCount: 3` -- the exact real-world shape FINDINGS item 44 describes, reproduced freshly rather than only against the original recording. Feeding that real `session`/`state` pair straight into `verifyReattach`/`reattachRebaselineNotice` (`reattachVerification.ts`, loaded via `node --experimental-strip-types`) returned `undefined` (no failure) and the exact product-worded notice naming both counts; the old strict `messageCount < lastMessageCount` rule was confirmed to evaluate `true` (would have failed) against this same real data. (2) Full end-to-end through the real app: a scratch Refract instance (scratch `--user-data-dir`, CDP port 9450, `registry.json` seeded with a Session pointing `currentConversation` at that same real 3-message Conversation file with `lastMessageCount: 4`) called `sessions.open` for real -- `SessionAgent` spawned a real `omp` 18.8.0 agent, reattached, and reached `idle` (`stopReason: undefined`, never `start-failed`), persisted `lastMessageCount: 3` (re-baselined), and the transcript held the notice verbatim: "This conversation reconnected with 3 messages instead of the 4 last seen; a few in-progress messages were dropped when it reconnected, but nothing you sent was lost." **(superseded by the 2026-10-07 gate-fixes paragraph below: this exact sentence overclaimed "nothing you sent was lost", which `reattachRebaselineNotice` never verified; the wording has since been changed to a neutral, verified-only claim.)** T111 live on the same scratch app (port 9449): a Session seeded with a `currentConversation` pointing at a non-existent file reached `stopped`/`start-failed` with banner text "Conversation file missing: ...\\missing-conversation.jsonl" (reproduced via a genuinely missing file, not the original crashed-session approach); the banner showed both **Retry** and **Start new conversation**, both `.focus()`-reachable (`document.activeElement` confirmed) matching `focusPaneContent`'s button fallback. A trusted CDP mouse click on **Retry** visibly disabled the button (`recovering` state) then settled back to the same `start-failed` reason (file still missing, as expected), proving the click really reached `sessions.recover`. A trusted CDP mouse click on **Start new conversation** visibly disabled that button, cleared the registry's `currentConversation`/`lastMessageCount` to `null`, spawned a real `omp` agent, and reached `idle` with a real `lastModel` (`claude-sonnet-5.5`) populated -- the Session was never left with no way forward. Not exercised: a synthetic CDP `Enter` keydown/keyup did not reliably produce a native `click` on these buttons in this headless/CDP setup (observed 0 click events across repeated attempts with `text: '\\r'` on the keydown, as the skill's gotcha describes for other elements) even though focus and the resulting mouse-click activation both worked, so "keyboard reachable" above is proven by focus + the existing `focusPaneContent` fallback contract, not by a literal keyboard keypress reaching `click`; **(superseded by the 2026-10-07 gate-fixes paragraph below: a trusted `Input.dispatchKeyEvent` Enter keypress was exercised there on a second Session and did drive both buttons through their `click` handling, matching the mouse-click outcomes.)** T112's own doc/FINDINGS updates were not re-verified beyond a diff read against `spec.md`/`data-model.md` (both match the shipped behaviour described above). Commit SHAs for this session: see the branch's own log (no source changed this session, only this paragraph and docs/PLAN.md).

**Verified 2026-10-07 (gate fixes)**: quality-gate remediation on `fix/449-reattach-count` (commit `8e71282`), re-run clean after the fixes below: `pnpm typecheck`, `pnpm build` (Vite renderer + main/preload, clean) and `pnpm check:ui-text` (0 leaks across 371 files). Fixes: (1) `ChatPane.tsx`'s `handleRecover`/`handleStartNewConversation` now capture whether focus was inside the pane before the async call and, on success, restore it via `requestAnimationFrame(() => focusPaneContent(chatPaneRef.current))` -- covers both the `agent-exited` Recover button and the `start-failed` Retry/Start new conversation buttons (same two handlers). (2) The Retry/Start new conversation/Recover buttons now show a busy label ("Retrying…"/"Starting…") and disable both while either is in flight. (3) `reattachVerification.ts`'s `reattachRebaselineNotice` no longer claims "nothing you sent was lost" (never verified); it now states only the observed count change and that aborted/unsent trailing messages may account for it -- the only other place that exact sentence was quoted (this file's own 2026-10-07 paragraph above) is now annotated as superseded; `spec.md`/`data-model.md`/`DESIGN.md`/`quickstart.md`/constitution already used neutral wording and needed no change. (4) T034 above now notes it is superseded by T110/FINDINGS item 44 for the `>= lastMessageCount` claim. (5) `docs/spike/reattach-count-probe.mjs` now checks `sw.success`/`cancelled`/`error` before proceeding, exits non-zero on a failed switch or probe error, and prints an explicit `RESULT: PASS/FAIL` line comparing the live count to the raw source count (informational, not tied to exit code). (6) The two `verifyReattach` failure branches (`sessionFile` mismatch, `messageCount` 0) were exercised with a throwaway `node --experimental-strip-types` script (copy of the real module, deleted after) alongside the healthy lower-count case: `sessionFile mismatch -> Reattach verification failed: sessionFile mismatch (...)`, `messageCount 0 -> Reattach verification failed: messageCount is 0, expected greater than 0`, `healthy lower-count reattach (no failure) -> undefined` -- all three as expected. Live re-verification on a scratch Electron instance (scratch `--user-data-dir`, CDP port 9449, two seeded Sessions each `stopped`/`start-failed` pointing at a genuinely missing conversation file): mouse-clicked **Retry** (trusted `Input.dispatchMouseEvent`), saw the "Retrying…" busy label, settled back to `start-failed` (file still missing, as expected); mouse-clicked **Start new conversation**, saw "Starting…", and the session reached `idle` with `currentConversation: null` -- `document.activeElement` was the message `<textarea>` inside the pane (`data-session-pane`), never `<body>`. Repeated with a second Session using Tab-to-focus plus a trusted `Input.dispatchKeyEvent` Enter (keyDown+char+keyUp) on each button instead of a mouse click: same busy labels, same Retry-fails/Start-new-succeeds outcome, and `document.activeElement` again the in-pane textarea after the keyboard-driven Start new conversation succeeded. Screenshot confirmed the second Session's pane open, idle, with the composer visibly focused. Scratch instance's own Job Object cascaded on `taskkill /PID <launch pid>` with zero leftover `electron.exe`/`omp.exe` processes (checked via `Get-CimInstance Win32_Process`); scratch parent directory deleted afterward from outside the repo.

**Verified 2026-10-07 (gate cycle 2)**: quality-gate cycle-2 remediation on `fix/449-reattach-count` (commit `bef096a`), re-run clean after the fixes below: `pnpm typecheck`, `pnpm build` (Vite renderer + main/preload, clean) and `pnpm check:ui-text` (0 leaks across 371 files). Fixes: (1) `ChatPane.tsx`'s `handleRecover`/`handleStartNewConversation`: the gate-1 fix above captured `hadFocus` once before the `await` and restored focus unconditionally on success if it was true -- yanking focus back into the pane even when the user moved it elsewhere during the call, and never restoring it at all on `!result.ok` (left on `<body>`, since the clicked banner button is disabled, and so blurred, for the call's duration). Both handlers now recompute a `maybeRestoreFocus` check at completion (success AND failure branches): restores focus into the pane only when `document.activeElement` is still `<body>`/`null` or already inside the pane (never when the user moved it elsewhere), and only when `sessionIdRef.current` still equals the Session the call was actually for (never across a mid-call Session switch). (2) `docs/spike/reattach-count-probe.mjs` built its delete target from a variable (`fs.rmSync(ROOT, { recursive: true, force: true })`, `ROOT` a fresh `Date().toISOString()` path every run) -- AGENTS.md forbids a recursive delete built from a variable target. The recursive delete is removed entirely; the scratch dir is left on disk, its literal path printed, with a note to delete it by hand. The `omp --version` check now runs inside the probe's one `try` block, ahead of the scratch dir's own creation (gate cycle 3 correction: only that check runs ahead of `mkdir` -- the transcript copy still runs right after the dir is created, as it must, not "both ahead of it" as this paragraph previously claimed), and a `child.on('error')` handler is added; a missing `omp`, an unreadable source, or a spawn/copy failure now exit non-zero (**1**) with a message instead of an uncaught exception or a silent hang -- gate cycle 3 correction: a missing CLI argument, an unreadable source path, or a missing `cwd` still exit **2** from their own checks before the `try` even starts, contradicting this paragraph's earlier "every failure path" wording (the exit-2 case is exercised two sentences below). Re-ran the probe twice: a nonexistent source path printed `source Conversation file not found: ...` and exited **2**; a real Conversation (`golden-bison`'s `...01a10b96-913d-75eb-9049-5a5c7f7d8539.jsonl`) completed end-to-end (`messageCount: 443`, matching FINDINGS item 44 exactly), printed its scratch dir's path "left on disk (not deleted)", and exited **0** -- that scratch dir was deleted by hand afterward, from outside this repo. Live-verified fix (1) on a scratch Electron instance (CDP port 9449, scratch `--user-data-dir`, two seeded Sessions each `stopped`/`start-failed` against a genuinely missing conversation file, trusted `Input.dispatchMouseEvent` clicks, polled DOM conditions, no fixed sleeps): clicking **Start new conversation** on a start-failed Session succeeded (missing file cleared, fresh conversation started) with focus ending in the message `<textarea>`; clicking **Retry** on a start-failed Session whose file was still missing failed again (same `stopReason`) with focus ending back on the still-shown banner's own **Retry** button, never `<body>`; clicking **Retry** then immediately clicking into the Sessions sidebar (`nav[aria-label="Sessions"]`) while the call was still in flight left focus where it moved once the call resolved -- it was not yanked back into the pane; gate cycle 3 correction: read live rather than assumed, the element that actually kept focus was the `<nav aria-label="Sessions" tabIndex={-1}>` root itself (`document.activeElement.tagName === 'NAV'`), not merely "the sidebar" as this sentence previously said without having checked. All three scenarios passed. The scratch Electron process (confirmed by its own spawned pid) was `taskkill`ed afterward and confirmed exited; the scratch parent directory was deleted by hand, by literal absolute path, from a cwd outside it and outside this repo. Did NOT drive: the `worktree-missing`/`agent-exited` banner variants, or a genuine `recover` IPC-level `{ok:false}` (`attachSnapshot`, `src/main/ipc/sessions.ts:140-168`, never returns one for a start failure -- it encodes the failure in the returned snapshot's `stopReason` instead); gate cycle 3 correction: this reason does NOT extend to `conversations.startNew` as this sentence previously implied -- `startNew` goes through `startStoppedSessionOnConversation` (`src/main/omp/conversationSwitch.ts`) and `mapSessionThrown` (`src/main/ipc/util.ts`) instead of `attachSnapshot`, and genuinely surfaces `{ok:false}` for a `SessionNotIdleError` (a concurrent start already in flight) or a failed registry-write in `prepare()` -- so `handleStartNewConversation`'s own `!result.ok` restored-focus path (including round 3's pressed-button preference) is reachable in principle, it was simply not driven live in either gate cycle.

**Verified 2026-10-07 (gate cycle 3)**: quality-gate cycle-3 remediation on `fix/449-reattach-count`, re-run clean after the fixes below: `pnpm typecheck`, `pnpm build` (Vite renderer + main/preload, clean) and `pnpm check:ui-text` (0 leaks across 371 files). Fixes: (1) `ChatPane.tsx`'s `handleRecover`/`handleStartNewConversation` now capture the exact `document.activeElement` at call start (`focusedAtStart`), not only a `hadFocus` boolean, and restore focus only when the element at completion is `<body>`/`null`/disconnected or still `focusedAtStart` -- never onto some other in-pane control (e.g. a `ChatHeader` close/swap button) the user deliberately moved to mid-call, which the gate-2 fix's `chatPaneRef.contains(active)` check wrongly treated as "focus never left". (2) `handleStartNewConversation` captures the pressed "Start new conversation" button (`startNewButtonRef`) and prefers re-focusing it directly (when still connected and enabled) over `focusPaneContent`'s generic banner-button query, which always lands on "Retry" (first enabled button in DOM order) regardless of which button the user pressed. (3) The `role="status"` live region now also shows "Retrying…"/"Starting new conversation…" while `recovering`/`startingNew`, so the busy state is announced even though the clicked button itself is disabled (and so loses focus) for the call's duration. (4) `docs/spike/reattach-count-probe.mjs`'s scratch dir is now `fs.mkdtempSync(...)` (private, randomly suffixed) instead of a predictable `Date().toISOString()` path, gated behind a `rootCreated` flag so "scratch dir left on disk" is only printed when one actually exists. Live re-verified on a scratch Electron instance (scratch `--user-data-dir`, CDP port 9449, two seeded Sessions each `stopped`/`start-failed` against a genuinely missing conversation file, trusted `Input.dispatchMouseEvent` clicks, polled DOM conditions, no fixed sleeps, real `omp` 18.8.0 agent): clicked pane A's **Retry**, then (while the call was still in flight) `.focus()`ed that pane's `ChatHeader` **"Close Session A's pane"** button to simulate the user moving focus there mid-call -- `document.activeElement` was that Close button immediately after, the pane's `role="status"` region read **"Retrying…"** (screenshotted), and once the call resolved back to `start-failed` (file still missing, as expected) `document.activeElement` was *still* that Close button (`isBody: false`): not yanked back into the pane, confirming fix (1). Clicking pane A's **"Start new conversation"** afterward still succeeded with focus ending in the in-pane `<textarea>` (regression check, unchanged). Repeating the old scenario C on a second pane (Retry, then `.focus()`ing `nav[aria-label="Sessions"]` mid-call) confirmed `document.activeElement.tagName === 'NAV'`/`aria-label: "Sessions"` once resolved -- the nav root itself held focus, named precisely rather than assumed. The scratch Electron process (own spawned pid confirmed via `Get-CimInstance Win32_Process` before each kill) was `taskkill`ed (graceful, then `/F` after ~10s) and confirmed exited with zero leftover scratch `electron.exe` processes; the scratch parent directory was deleted afterward by literal absolute path from a cwd outside both it and this repo. Not exercised live (same gap noted above): a genuine `conversations.startNew` `{ok:false}` (`SessionNotIdleError`/failed registry-write `prepare()`), so fix (2) was verified by code reading only.

**Verified 2026-10-07 (gate cycle 4)**: quality-gate cycle-4 remediation on `fix/449-reattach-count`, re-run clean after the fixes below: `pnpm typecheck`, `pnpm build` (Vite renderer + main/preload, clean) and `pnpm check:ui-text` (0 leaks across 371 files). Fixes: (1) `ChatPane.tsx`'s `handleRecover`/`handleStartNewConversation` cleared `recoveringId`/`startingNewId` with `setRecoveringId(null)`/`setStartingNewId(null)` on completion, unconditionally, regardless of which Session the completing call was actually for -- if the single (non-split) pane switched from Session A to Session B mid-call and the user then pressed Retry/Start new on B, A's later completion could wipe B's busy flag out from under it while B's own call was still running (the same reused-`ChatPane`-instance pattern FINDINGS item 45 already documents for focus). Both clears are now functional updates, `setRecoveringId(id => (id === recoveringFor ? null : id))`/`setStartingNewId(id => (id === startingFor ? null : id))`, so a stale completion can only ever clear its own id; these were the only two call sites clearing either state. (2) `docs/spike/FINDINGS.md` item 45's heading and its cycle-2 bullet still described the gate-2-era rule ("rechecks focus at completion", "already inside the pane"), both now carry an inline gate-cycle-3-correction note stating the actual final rule (capture `focusedAtStart` before the call; restore only onto `<body>`/`null`/disconnected or that exact captured element; Start new instead refocuses the pressed button via `startNewButtonRef`). (3) This file's own T111 line claimed `focusPaneContent`'s fallback needed "no further wiring needed" -- annotated superseded: Start new now refocuses the pressed button via `startNewButtonRef`, falling back to `focusPaneContent`. (4) The "synthetic Enter not exercised" sentence in this file's 2026-10-07 (issue #449) paragraph is now annotated superseded by the gate-fixes paragraph above, which did exercise a trusted `Input.dispatchKeyEvent` Enter keypress successfully. (5) `docs/spike/reattach-count-probe.mjs`'s header comment cited the not-below-rule's constitution version as v1.5.0; corrected to v1.7.0 (matching FINDINGS item 20, which the rule's own text cites) -- the rule itself was first introduced in v1.6.1 (constitution commit `f02571f`), with v1.7.0 (commit `2d5de11`) only adding that FINDINGS item 20 citation to the existing rule text, so v1.7.0 is not the rule's original introduction either; v1.9.0, which replaced this branch's starting v1.8.0, is the later re-baseline amendment FINDINGS item 44 drove, a third, still different version. The same header also claimed "raw frames and the scratch copy stay under the OS temp dir"; corrected -- `rawEntries`/`rawMessages` (read via `fs.readFileSync` into a plain array) are parsed lines of the source `.jsonl` transcript, not RPC frames (those are the probe's own `frames` array, populated by `dispatch()` from `omp`'s stdout); `rawEntries`/`rawMessages` are held in memory only and never written to disk, only the scratch copy of the transcript (`fs.copyFileSync` into the `mkdtempSync` dir) actually lives on disk. Live re-verified fix (1) on a scratch Electron instance (scratch `--user-data-dir`, CDP port 9449, two seeded Sessions each `stopped`/`start-failed` against a genuinely missing conversation file, trusted `Input.dispatchMouseEvent` clicks, polled DOM conditions, no fixed sleeps, real `omp` agent): first re-drove the single-session regression (Retry on session-a alone, fails again as expected, `document.activeElement` ended on the Retry button, `isBody: false`) confirming the existing fix still holds. Then, with both Sessions already settled at `start-failed` in the same single (non-split) pane, clicked Retry on session-a and, without waiting for it to resolve, immediately switched the front pane to session-b and clicked Retry on session-b (both real `sessions.recover` calls now in flight concurrently, started ~170ms apart) -- polling the shared `role="status"` busy region and the front banner's buttons every 80ms showed exactly one clean transition (busy "Retrying…"/both buttons disabled, to settled "Retry"/both enabled) with no premature early-clear in between, `document.activeElement` ended on session-b's own Retry button (never `<body>`), and switching back to session-a afterward confirmed its own Retry call had also genuinely completed (proving both calls really overlapped, not a no-op race). Honest limitation: this live check demonstrated two overlapping real recover calls and the correct final focus outcome, but it did not reproduce a failure on the pre-fix code (under the old unconditional `setRecoveringId(null)`, A's completion finishing first also produces exactly one busy-to-settled transition, merely earlier, since B's own call was still in flight) and it did not log each call's own IPC resolution time against the UI's clear, so the check alone cannot discriminate old from new behaviour; fix (1) is verified by code reading plus this reviewer trace, not by this live check in isolation. Separately, a known remaining limitation (same single-busy-id design as fix (1)): `recoveringId`/`startingNewId` each track only ONE Session id at a time (`ChatPane.tsx` ~119-120, compared against the front Session at ~283-284), so Retry on session-a, switching to session-b mid-call, Retry on session-b, then switching back to session-a shows session-a's buttons re-enabled while session-a's own call is still running; a resulting second click is harmless, since `SessionAgent.start()` joins the same in-flight attempt (`SessionAgent.ts` ~266) and `startWith()` throws `SessionNotIdleError` for any other non-idle call (`SessionAgent.ts` ~284-285), surfaced to the user as a notice rather than a silent double-start. The scratch Electron process (confirmed by its own spawned pid via `Get-CimInstance Win32_Process`, command line checked before kill) was `taskkill`ed and confirmed exited with zero leftover processes referencing the scratch `--user-data-dir`; the scratch parent directory (repo + a second `git worktree add` repo + userdata) was deleted afterward by literal absolute path from a cwd outside both it and this repo.

## Phase 29: Convergence

- [X] T113 [US5] Add scroll-landing memory and helpers: `src/renderer/state/scroll-store.ts` (`useChatScrollStore`, per-session `{ atEnd, scrollTop }`, `record`/`clear`, renderer-lifetime only) wired into `src/renderer/state/index.ts`; `src/renderer/features/chat/scrollLanding.ts` (`isAtScrollEnd`, `resolveLandingScrollTop`, `SCROLL_END_TOLERANCE_PX`, `SCROLL_LANDING_STABLE_FRAMES`, `SCROLL_LANDING_MAX_FRAMES`); `src/renderer/state/transcript-store.ts` gains a per-session `generation` counter bumped only by a wholesale `reset` (never an ordinary `upsert` patch) so the landing effect keys off it, never mid-turn streaming. Missing from this original description (gate fixes 4, finding 8d): `scroll-store.ts` also gains `restoreIfAbsent(sessionId, previous)` (added in gate fixes 3), which puts back a snapshotted pre-clear memory only if nothing newer has been recorded for that Session meanwhile -- used by every `clear`-before-call site's failure branch except `ConversationSwitcher.tsx`'s `handleOpenConversation` (see that file's own comment, gate fixes 4 finding 3, for why).
- [X] T114 [US5] Drive the landing in `src/renderer/features/chat/Transcript.tsx`: a `viewportRef` + `onScroll` handler continuously records `{ atEnd, scrollTop }` for the visible Session; an effect keyed on `[sessionId, transcript.generation]` polls via `requestAnimationFrame` until `scrollHeight` holds steady for `SCROLL_LANDING_STABLE_FRAMES` frames (bounded by `SCROLL_LANDING_MAX_FRAMES`, a `content-visibility:auto` row settling from its placeholder height, #459's same root cause) then sets `scrollTop` from `resolveLandingScrollTop` -- covers both a Session switch (`ChatPane.tsx` swaps `sessionId` on the same `Transcript` instance, no remount) and a Conversation switch (`applySnapshot` on the same Session, `transcript-store.ts`'s `reset` bumps `generation`). `src/renderer/features/chat/ConversationSwitcher.tsx`'s `handleNewConversation`/`handleOpenConversation` call `useChatScrollStore.getState().clear(sessionId)` immediately before `applySnapshot`, since the newly-shown Conversation has never been "left" by the developer and must not reuse an offset that applied to the Session's previous Conversation's own content height. Superseded: "polls ... until `scrollHeight` holds steady ... then sets `scrollTop`" describes a single write once stable; the actual effect re-applies `scrollTop` on EVERY polled frame (not just once at the end) and judges done-ness by comparing the viewport's own `scrollTop` against what it last assigned, not `scrollHeight` alone -- see the **Verified 2026-10-07 (gate cycle 2)** paragraph at the end of this section for the current behaviour, including the `scrollHeight - clientHeight` clamp and the early-stop-on-real-user-input added in that pass.
- [X] T115 [US5] Update the docs and verify live: `spec.md` Clarification 2026-10-06 and US5 acceptance scenario 3 record the amended rule (land at the end by default, restore only when detached); no other spec 001 doc (`quickstart.md`, `plan.md`, `contracts/ipc.md`, `data-model.md`) mentions scroll position, so none needed amending. `pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text` clean; a live CDP check on a scratch Electron instance (port 9332) with a long transcript confirmed: at the end, switching away and back lands at the end; scrolled up, switching away and back restores the same `scrollTop`; a never-visited Session lands at the end; reduced-motion and keyboard scrolling unaffected (the landing is an instant `scrollTop` assignment, not an animated scroll). Superseded: the "scrolled up, switching away and back restores the same `scrollTop`" and "reduced-motion and keyboard scrolling unaffected" claims above were not actually exercised this way -- see the **Verified 2026-10-07 (gate fixes)** paragraph at the end of this section for what was actually found and re-verified.

Evidence: branch `fix/485-land-at-end`, commit `3c9bf1a`. The "this session's handoff" this line used to point at was never committed to this repo and does not exist; see the **Verified 2026-10-07** and **Verified 2026-10-07 (gate fixes)** paragraphs below for the actual `scrollTop`/`scrollHeight` readings.

**Verified 2026-10-07**: Re-ran the live check independently (`pnpm typecheck`, `pnpm build`, `pnpm check:ui-text` clean; a scratch `electron-vite dev` instance, port 9485, scratch `--user-data-dir`, CDP-driven via `window.__refractStores`, two Sessions seeded with 40-turn transcripts). The prior paragraph's claim "scrolled up, switching away and back restores the same `scrollTop`" did NOT hold: detaching with a real trusted wheel scroll (`Input.dispatchMouseEvent` `mouseWheel`, not a synthetic `scroll` event -- a synthetic one is silently ignored) correctly recorded `{ atEnd: false, scrollTop: 0 }`, but switching to the other Session and back landed at the END every time, 3/3 clean reproductions. Root cause: `handleViewportScroll` has no guard against the just-switched-to Session's own placeholder-sized `scrollHeight` (content-visibility rows not yet promoted) making the browser clamp a leftover `scrollTop` down -- that clamp fires a genuine (non-synthetic) `scroll` event, which `handleViewportScroll` recorded as `{ atEnd: true, scrollTop: <end> }` BEFORE the landing effect's own `requestAnimationFrame` poll ever read the memory, permanently clobbering the real detached position every single time a Session/Conversation was re-entered. Fixed in `Transcript.tsx` with a `landingInProgressRef` that suppresses `handleViewportScroll` recording from the moment the landing effect starts until it applies its own `scrollTop` (committed on this branch). Re-verified with the same CDP harness after the fix, 5/5 checks green: (1) a never-visited Session lands at the end; (2) a real wheel-scroll detach is recorded (`{ atEnd: false, scrollTop: 0 }`); (3) switching to a second, never-visited Session lands IT at the end, and does not touch the first Session's memory; (4) switching back to the first Session now correctly RESTORES `scrollTop: 0`; (5) a Conversation switch (`scroll.clear()` + a fresh `transcript.reset()`) lands at the end despite a prior detached memory for that Session. Screenshot taken of the live app showing the seeded transcript scrolled to the end.

**Verified 2026-10-07 (gate fixes)**: Quality-gate finding (High, evidence): the prior "Verified 2026-10-07" paragraph's own restore proof only ever showed `scrollTop: 0`, never a genuine mid-transcript position, so it could not rule out a `content-visibility:auto` row above the target growing AFTER the single `scrollTop` assignment and silently losing the position again. Re-ran the live harness (`pnpm typecheck`, `pnpm build`, `pnpm check:ui-text` clean; the same scratch `electron-vite dev` instance, port 9485, scratch `--user-data-dir=C:\tmp\refract-485-verify\userdata`, CDP-driven via `window.__refractStores`, two seeded Sessions: a 60-turn/120-item transcript with deliberately varied row heights -- long Lorem-ipsum assistant replies every 4th turn mixed with one-line replies -- and a 40-turn plain transcript) with a real trusted MID-transcript detach (`Input.dispatchMouseEvent` `mouseWheel`, deltaY -800 x5 then +500 x4, not a synthetic event):

- Detach baseline: `{ scrollTop: 9707, scrollHeight: 14282, clientHeight: 573 }` (distance from end ~4002px, genuinely mid-transcript, neither 0 nor the end) -- recorded correctly as `{ atEnd: false, scrollTop: 9707 }`.
- First reproduction (before any new fix beyond the existing `landingInProgressRef`): switching to the second Session and back did NOT restore 9707 -- `scrollTop` drifted upward over ~15 polled frames (9707 -> 17713 -> 16035 -> 15314) and settled AT THE END (`scrollTop: 15314, scrollHeight: 15887`), confirming the High finding was a real bug, not a proof gap. Root-caused to two distinct problems, both fixed in `Transcript.tsx`/`scrollLanding.ts` on this branch:
  1. The vendored `@shadcn/react` message-scroller (`MessageScrollerProvider autoScroll`) has its own internal "following-bottom" mode that a single transient browser clamp (or even the landing effect's own mid-settle writes) can flip on for one frame; once flipped, the library re-asserts the bottom itself on every later `ResizeObserver` tick a still-settling row fires, fighting and eventually beating the landing effect's own re-assertion. Fixed by driving the library's `autoScroll` prop from a new `autoScrollSuppressed` render state, forced `true` synchronously during render (same render-phase-bailout trick as the `landingInProgressRef` fix below) for the whole settle window, so every one of the library's own corrective scrolls is a no-op regardless of its internal mode.
  2. The landing effect only checked `scrollHeight` for stability, so an external force (the library's own correction above, or Chromium's scroll anchoring) nudging `scrollTop` away from the target in the gap between two of the effect's own frames went undetected as long as `scrollHeight` itself happened to read the same on both sides. The `step()` loop now also compares the viewport's current `scrollTop` against what it itself assigned last frame and resets the stable-frame counter on any mismatch, not just a height change; `SCROLL_LANDING_MAX_FRAMES` raised 20 -> 90 to give a long transcript's full settle genuinely enough polling budget under this stricter check.
- Re-verified after both fixes, same scenario, 3 full repeat cycles (detach -> switch away -> switch back): every frame of the settle window read `scrollTop: 9707` unchanged (no drift at all, not just "close enough"), final state `{ scrollTop: 9707, scrollHeight: 18286 }` 2s after settling -- exact match to the recorded baseline, well inside `SCROLL_END_TOLERANCE_PX` (0px off). The guard was also confirmed NOT stuck permanently true: a real wheel scroll performed immediately after settling was recorded normally (`{ atEnd: false, scrollTop: 10007 }`).
- Varied row heights: the 60-turn transcript used throughout this check mixes long (Lorem-ipsum, several hundred px) and short (one-line) rows specifically so the rows above a mid-transcript detach point have materially different content-visibility placeholder-vs-real height deltas; the restore above is from that transcript.
- A never-visited Session still lands at the end (`{ scrollTop: 10071, scrollHeight: 10644 }`, distance 0).
- A Conversation-switch style reset (`scroll.clear()` + a fresh `transcript.reset()` with a different item count on the same `sessionId`, since the real `ConversationSwitcher` UI's `handleOpenConversation` calls `SessionAgent.openConversation`, which requires an already-idle LIVE `omp` process for that Session's real worktree -- infeasible to spin up safely in this scratch harness without a real repository/agent, so this was NOT driven through the actual UI, same limitation as the original Verified 2026-10-07 paragraph) correctly discarded the prior detached memory and landed at the end (`{ scrollTop: 4551, scrollHeight: 5124 }`, distance 0) despite the Session still having a stored mid-transcript memory from before.
- Keyboard scrolling: trusted `Input.dispatchKeyEvent` key presses (`End`, `Home`, `PageDown`, `PageUp`, correct Windows virtual-key codes 35/36/34/33) on the focused viewport all moved `scrollTop` correctly (`End` -> bottom, `Home` -> 0, `PageDown`/`PageUp` moved by a page) -- T115's claim was correct but had never actually been exercised with real key events; it has been now.
- `prefers-reduced-motion: reduce` emulated via `Emulation.setEmulatedMedia` (confirmed active via `window.matchMedia`): a fresh detach-and-restore cycle under emulation landed instantly at the exact stored `scrollTop` (`4001`, matching the pre-switch baseline) with no animated creep across the sampled frames -- confirms T115's "instant assignment, not animated" claim, now with real evidence instead of an inference from the implementation.

Scratch instance verified isolated (its own `--user-data-dir` under `C:\tmp`, no `%APPDATA%\refract`/`%APPDATA%\pinion` touched) and fully torn down afterward: the spawned Electron process (confirmed by PID and command line before killing) was `taskkill`ed and exited cleanly, and the scratch directory was removed from a cwd outside the repo.

**Verified 2026-10-07 (gate cycle 2)**: `pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text` clean after every edit below. Re-ran the live harness (scratch `electron-vite dev` instance, port 9485, scratch `--user-data-dir=C:\tmp\refract-485-verify\userdata`, CDP-driven via `window.__refractStores`; two seeded Sessions, A: 5-turn/10-item short transcript, B: 60-turn/120-item transcript with varied row heights, long Lorem-ipsum replies every 3rd turn mixed with one-line replies):

- Finding 1 (clamp + frame count): switching to a never-visited Session B settled in 5 polled frames (confirmed stable through frame 10 of 150 observed) landing exactly at the clamped end (`{ scrollTop: 19766, scrollHeight: 20339, clientHeight: 573 }`, distance 0); a never-visited Session A settled in 3 frames (confirmed through frame 8), also distance 0. Before the `scrollHeight - clientHeight` clamp in `resolveLandingScrollTop`, an unclamped target could never equal the browser-clamped `viewport.scrollTop`, so `notPerturbed` was never true and this same landing would have spent its entire `SCROLL_LANDING_MAX_FRAMES` (90) budget; both figures above are far under that cap.
- Finding 7 (wheel-up 100ms after switching is not pulled back): a real `Input.dispatchMouseEvent` `mouseWheel` (deltaY -400) issued 100ms after switching to Session B held the viewport ~400px from the end across a full second of subsequent polled frames with no drift back toward the end.
- Finding 1 (stop-on-real-input, self-found regression): a first pass that unconditionally cleared `autoScrollSuppressed` on any real user input was live-tested with a wheel-up issued only 20ms after switching (deliberately still mid content-visibility churn) and FAILED -- the vendored scroller's own `autoScroll` re-engaged and the position drifted back to the exact end (`scrollTop: 19206 === scrollHeight 19779 - clientHeight 573`) despite the wheel scroll. Fixed by gating the clear on the actually-computed `atEnd` at the moment of the input (same rule the normal-completion branch already followed); re-verified with the identical 20ms-wheel repro: final `scrollTop: 18764`, `scrollHeight: 19937`, holding a steady 600px from the end across 700ms+ of subsequent frames, matching the wheel's own deltaY.
- Finding 2 (persisted detached-restore suppression): the exact repro the finding named -- Session A (short, lands at end) -> Session B (wheel-scrolled to a detached `scrollTop: 18764`, recorded as `{ atEnd: false, scrollTop: 18764 }`) -> A -> B. The restored `scrollTop: 18764` held unchanged across 2 full seconds of polling after settling (final `{ scrollTop: 18764, scrollHeight: 19779 }`, distance 442px, never drifting to the end). A new streamed message was then appended to Session B's transcript (`transcript.applyOps`, an ordinary non-reset patch) while still detached: `scrollHeight` grew 19779 -> 19873 over 1.5s of polling while `scrollTop` stayed pinned at 18764 throughout -- no yank to the end.
- Finding 3/4 (code-quality fixes): the `prevLandingKey`/`setPrevLandingKey` render-time comparison was exercised on every Session switch performed across this whole check (dozens) with no misbehaviour observed. The `!viewport` early-return's flag-clearing was NOT independently live-triggered -- `viewportRef` is attached to an unconditionally-rendered element in this component, so that branch is not reachable through normal UI interaction; verified by code review and `pnpm typecheck` only, not a live repro.
- Finding 5 (same offset, not necessarily the same row): identified the row at the viewport top by its rendered text and `offsetTop` before and after an A -> B detach/restore cycle -- both times the same row (`"Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed"`, `offsetTop: 18471`) was at the top, because this app's transcript only ever grows by appending after the recorded position. The underlying limitation (an identical `scrollTop` number can map to a different row if a row above the recorded point renders at a different height on a later visit, e.g. a `content-visibility:auto` placeholder settling differently) is real and was not fixed with row-anchored restore this pass -- documented instead in `spec.md`'s Edge Cases, since wiring the vendored `MessageScroller`'s own per-row anchor id and `scrollToMessage` API into the already-adversarial settle loop above was judged out of scope for a gate-fix pass.
- Finding 6: T114 above is now marked superseded (its "wait for stable height then write once" description does not match the implementation, which re-applies `scrollTop` every frame and judges done-ness by comparing `scrollTop`, not `scrollHeight`, against the previous frame).
- Keyboard: a real `PageUp` keydown (Windows virtual-key code 33) dispatched 20ms into a fresh settle did not fight the developer, though in that run it landed on an already-recorded detached `scrollTop` so it did not isolate a distinct signal of its own; `wheel`, `keydown`, `pointerdown`, and `touchstart` all share the one `handleUserInput` listener added in `Transcript.tsx`, so the wheel-based proofs above exercise the same code path all four share.

Scratch instance verified isolated (`%APPDATA%\refract` never created; the live `pinion`/`%APPDATA%\pinion` instance's own processes, confirmed by command line, were untouched throughout) and fully torn down afterward: the scratch Electron process (PID `29876`, command line re-confirmed to carry the scratch `--user-data-dir` and this worktree's path immediately before killing) was `taskkill`ed, confirmed gone by PID and by command-line scan a few seconds later, and the scratch directory was removed from a cwd outside both it and the repo.

**Verified 2026-10-07 (integration with #449)**: merged `origin/main` (bringing #449's `fix/449-reattach-count`, PR #535, and #491's `fix/491-ask-card`, PR #534) into this branch (merge commit on top of `f53103c`); `git diff origin/main --stat` after the merge showed only this branch's own scroll-landing slice plus additive doc merges, confirming nothing from either merged-in branch was lost. Integration gap found and fixed: #449 added a SECOND `conversations.startNew` call site, `ChatPane.tsx`'s `handleStartNewConversation` (the `start-failed` stop banner's own button, used when a Session's reattach fails outright, as opposed to `ConversationSwitcher.tsx`'s `handleNewConversation`/`handleOpenConversation`, used when an already-running Session's developer explicitly starts or opens a Conversation) -- it called `applySnapshot` without first clearing `useChatScrollStore`, so starting a new Conversation from the start-failed banner would have reused the Session's old, now-stale detached scroll memory instead of landing at the end. Fixed by adding the identical `useChatScrollStore.getState().clear(startingFor)` call immediately before `applySnapshot`, mirroring `ConversationSwitcher.tsx`'s own two call sites exactly. Audited every other `applySnapshot`/`conversations.startNew`/`conversations.open` call site in `src/renderer` and `src/main`: `ChatPane.tsx`'s own `sessions.open` mount effect (a Session switch, not a Conversation switch -- correctly relies on the landing effect's per-session memory, no clear needed) and `handleRecover` (`sessions.recover`, which retries the SAME Conversation -- intentionally left unchanged, confirmed by code reading of `SessionAgent.ts`'s `attachAndVerify`/reattach path, which never changes `currentConversation`) are the only other renderer call sites this audit checked -- an overstated claim, corrected by gate fixes 2 (finding 1): that round found this audit had MISSED a real THIRD `conversations.startNew` trigger, the composer's own bare `/new` (`chat.ts`'s native-command handler, `parsed.name === 'new' && parsed.rest === ''`, calling `SessionAgent.startNewConversation` directly, never through `window.refract.conversations.startNew`), plus two more same-Conversation-only call sites this audit never mentioned (`SessionAgent.ts`'s `attachAndVerify`/reattach `switch_session`, and `switchRecovery.ts`'s `recoverFromFailedSwitch`) that correctly need no clear either; see that round's own paragraph below for the complete, corrected list and its fix. `pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text` (0 leaks across 371 files) all clean after the fix.

Live-verified on a scratch Electron instance (electron.exe launched directly rather than through `electron-vite dev`'s own CLI wrapper -- that wrapper's spawned Electron process was found to die silently, exit code 0, with no error, within seconds under this harness on Windows, independent of any registry/session content, root cause not pinned down; direct `electron.exe . --user-data-dir=... --remote-debugging-port=9485` with a separately-started plain `vite` dev server for the renderer only, `ELECTRON_RENDERER_URL` pointed at it, reproduced `window.__refractStores` in DEV mode reliably and was used for the rest of this session; a scratch `registry.json` was pre-seeded with three Sessions, each worktree a real git repository, pointing `currentConversation` at a genuinely missing file to force `start-failed`, matching the established #449 gate-round technique): (1) a Session seeded with a detached scroll memory (`{ atEnd: false, scrollTop: 7653 }`, recorded via a real trusted `Input.dispatchMouseEvent` `mouseWheel` over a 120-item seeded transcript) reached `start-failed`; clicking **Start new conversation** resolved a real `conversations.startNew` call (banner cleared, Session reached `idle` with a real model) and the scroll memory for that Session was confirmed `null` immediately after -- the fix verified directly at the store level, not inferred. (2) A second, separately-seeded Session (`{ atEnd: false, scrollTop: 2678 }`) reached `start-failed`; clicking **Retry** resolved a real `sessions.recover` call (failed again, same missing file, as expected) and the scroll memory was confirmed UNCHANGED (`{ atEnd: false, scrollTop: 2678 }`) afterward, confirming `handleRecover` correctly does not clear it. (3) Re-ran a core #485 case (never-visited Session lands at end) on a 10-item transcript: landed exactly at `scrollHeight - clientHeight` with no drift. (4) Re-ran the A -> B memory-preservation case: Session A's detached memory (`{ atEnd: false, scrollTop: 6565 }`) was confirmed unchanged while Session B was focused and separately seeded/landed correctly at its own end.

Methodological finding (not a product bug): an early attempt to verify a **large** (100-item) seeded transcript's landing by polling `scrollTop`/`scrollHeight` every 16-30ms via repeated CDP `Runtime.evaluate` calls consistently showed it landing at `scrollTop: 0` instead of the end -- reproduced on two different Sessions, looking like a real regression. Isolated by removing the interleaved polling entirely (seed once, sleep one uninterrupted multi-second span, read once): the SAME 100-item transcript then landed correctly and exactly at `scrollHeight - clientHeight` every time. The tight polling loop itself (each read forces a synchronous layout/style recalc on the renderer's main thread) was starving the `content-visibility:auto` rows' own promotion timing and the landing effect's `requestAnimationFrame` cadence, producing a false "stable" reading before the real layout had settled -- an artifact of this verification technique, not of `Transcript.tsx`/`scrollLanding.ts`, which this session did not modify. Recorded here so a future verification pass does not need to rediscover it: prefer a single generous sleep plus a single read over tight polling loops when checking this landing effect's settled state through CDP.

Not driven this round, given time: the real `ConversationSwitcher` UI path via a fake `omp --mode rpc-ui` relay (step 4 of this integration's own plan) was not attempted -- the gate-cycle rounds above already live-verify the `clear()` behaviour via direct store calls, not the real menu UI itself, and this round's scope was the NEW `handleStartNewConversation` call site, which does not go through `ConversationSwitcher` at all. A full, uninterrupted A -> B -> A visual restore screenshot (as opposed to the A-memory-preserved-while-on-B check actually completed above) was not completed this round: re-focusing a Session pane always re-runs `ChatPane.tsx`'s own `sessions.open` mount effect, which re-fetches and re-applies the Session's REAL (in this harness, genuinely empty) snapshot, overwriting a directly store-injected fake transcript before it could be re-seeded and left enough uninterrupted time to settle within this session's remaining time; the underlying mechanism is unmodified code already covered by the gate-cycle-2 paragraph's own dozens-of-switches, zero-misbehaviour observation above, and by this round's own A-memory-preserved-while-viewing-B check. This A -> B -> A gap -- whether a real-content re-focus ever double-lands (stale cached items settling once, then a fresh `sessions.open` snapshot resetting and re-settling a second time) -- was finally exercised live in gate fixes 2 below, with a real backing (fake) agent process instead of injected store state: see that paragraph for the result.

Scratch instances verified isolated (`%APPDATA%\refract` not touched; the user's own live `pinion`/`%APPDATA%\pinion` processes, confirmed by command line, were never touched) and torn down via `proc://<name>/kill` after each use. The scratch directories (`C:\tmp\refract-485-v2-20261007142607`, `C:\tmp\refract-485-integrate-20261007142133`) were left on disk rather than deleted this round (recursive delete from a path built in a variable is exactly the pattern this repo's own safety rule forbids; deleting them requires a literal absolute `Remove-Item` by hand) -- noted here for manual cleanup. **Correction (gate fixes 4, finding 8b)**: "verified isolated" above was INCOMPLETE -- `~/.omp/agent/sessions/` (the real production `omp.exe`'s own per-worktree-path session-state directory, keyed by an escaped absolute path, independent of Refract) contains three folders stamped ~14:32-14:36 this same round for the three scratch worktree paths this paragraph seeded (`--C--tmp-refract-485-v2-20261007142607-worktree-{a,b,c}--`), confirmed by direct read-only listing to be genuinely EMPTY (no session/transcript file inside any of them), meaning the REAL `omp.exe` binary was invoked against these scratch paths at some point this round (enough to make it create its own tracking folder) even though this paragraph's own narrative never disclosed that the way the gate-fixes-3 paragraph below explicitly discloses its own safety incident; no real session DATA was ever written (the folders' emptiness rules that out), but "verified isolated" should have read "the Electron process tree and `%APPDATA%` were verified isolated; `omp.exe`'s own global, cross-project `~/.omp/agent/sessions/` state was not checked this round and was in fact touched." These three empty folders are left in place (not deleted, per this repo's own no-variable-path-deletion rule) alongside the already-disclosed gate-fixes-3 incident's own empty `--C--tmp-refract-485-gate3-20261007154236-pinion-worktrees-repo-humble-fox--` folder (which that paragraph's safety incident fully explains: the real `omp.exe` was briefly spawned against it, PID 37356, killed before any message, consistent with zero session data ever landing there).

**Verified 2026-10-07 (gate fixes 2)**: quality-gate remediation on `fix/485-land-at-end` (commit `51fb021`), re-run clean after the fixes below: `pnpm typecheck`, `pnpm build` (Vite renderer + main/preload, clean), and `pnpm check:ui-text` (0 leaks across 371 files).

Fixes: (1, High) `MessageInput.tsx`'s `handleSend` recognises a bare `/new` (`parseSlashCommand`, `name === 'new' && rest === ''`, the exact shape `chat.ts` itself checks) and clears `useChatScrollStore` for the Session BEFORE calling `chat.send`, not after -- this third `conversations.startNew` trigger (`chat.ts`'s native-command handler, calling `SessionAgent.startNewConversation` directly) was missed by the prior "integration with #449" audit above; unlike `ConversationSwitcher.tsx`'s and `ChatPane.tsx`'s own handlers, its reset reaches the renderer as an ordinary `transcript:patch` racing the `chat.send` call's own result, so clearing after awaiting that result risked the reset patch already landing first. (2, Medium a11y) The settle loop's stop-on-user-input listeners move from `viewportRef` to a new `scrollerRootRef` on the `MessageScroller` root -- the vendored "Scroll to end" `MessageScrollerButton` is the viewport's own SIBLING, not descendant, so a click/Enter/Space on it previously never reached the loop's listeners at all. (3, Medium) `notPerturbed` compares with a new `SCROLL_PERTURBATION_TOLERANCE_PX` (1px) instead of strict `===`, so a fractional-DPR sub-pixel readback no longer defeats the stable-frame count. (4, Medium) Corrected `Transcript.tsx`'s own doc comment, which overstated that "quality-gate cycle 2, finding 3" had moved the landing-key guard away from a render-phase ref write entirely -- it had not; `landingInProgressRef.current = true` on the next line remains a plain ref mutation during render, now documented as a deliberate, safe exception (this renderer never uses `Suspense`/`startTransition`/`useTransition`, confirmed by grep across `src/renderer`; `StrictMode`'s dev-only double-invoke writes the same idempotent `true` value both times) rather than a fully-eliminated anti-pattern. **Superseded (gate fixes 4, finding 8a)**: fix (2)'s "the vendored `MessageScrollerButton`" is no longer current -- the gate-fixes-3 paragraph below (fix 3) replaces it with an app-owned `Button`; the `scrollerRootRef`-level listener placement this fix introduced is still exactly how the settle loop stops on the current app-owned button today (see `Transcript.tsx`'s own comments).

Live-verified end to end on a scratch harness (never the real `golden-bison` file, never Stuart's Sessions): a native `omp.exe` relay (compiled with `csc.exe` from `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`, execs `node fake-omp.mjs` with inherited stdio -- the same pattern established in prior rounds, since a `.cmd`/`.bat` shim on `PATH` still throws `spawn EINVAL` under Node 26's direct, non-shell `spawn()`) seeded first on `PATH` for the spawned Electron only, answering `--version` (`checkOmp`), the full rpc-ui handshake (`ready`/`negotiate_protocol`/`get_state`/`get_available_models`/`get_login_providers` for `checkOmpSignedIn`, all with a shared fake model id so Readiness passes with no real OMP sign-in), `get_messages` (seeded 60 turns/120 messages per spawned Session, so `fromHistory` produces a genuinely long, real transcript through the real code path, never store-injected), and `new_session` (clears to an empty Conversation, exactly what `/new` triggers). A scratch `registry.json` (one repository, one pre-seeded Session) plus two further Sessions created live via real `window.refract.sessions.create` (real `git worktree add` worktrees) gave three real Sessions to switch between. Electron was launched directly (`electron.exe <repo>`, not through `electron-vite dev`'s own CLI wrapper) with `ELECTRON_RENDERER_URL` pointed at a separately-started plain `vite` dev server (a scratch `vite.scratch485.config.ts` mirroring `electron.vite.config.ts`'s renderer block exactly, deleted after use, never committed) instead of `pnpm build`'s static output, since `window.__refractStores` (needed to seed/read scroll memory) is gated on `import.meta.env.DEV`, which only a dev-mode Vite build sets. CDP on port 9485, scratch `--user-data-dir`. One harness-level discovery: `document.hidden`/`visibilityState` read `true`/`'hidden'` by default under this CDP-only automation (no real OS window focus), which fully pauses `requestAnimationFrame` -- fixed via `Page.bringToFront` + `Emulation.setFocusEmulationEnabled({enabled:true})`, confirmed by a direct 5-frame `requestAnimationFrame` round trip before relying on it for findings 2/3/4/5 below (finding 1's check does not depend on `rAF` at all, so it is unaffected by this).

Finding 1: seeded a detached scroll memory (`{ atEnd: false, scrollTop: 1234 }`) for a Session with a real 120-item transcript, then typed `/new` into the real composer textarea via trusted `Input.dispatchKeyEvent` keystrokes and pressed a trusted `Enter` -- the scroll memory read back as `undefined` (cleared) immediately after the keydown, before the `chat.send` IPC round trip or the resulting `new_session` reset patch could possibly have landed, and stayed cleared after settle (textarea cleared, transcript reset to 0 real items, confirming the actual `new_session` RPC reached the fake `omp` and its patch arrived). Re-audited every `applySnapshot`/`conversations.startNew`/`conversations.open`/`switch_session` call site in `src/main` and `src/renderer` by grep: `ConversationSwitcher.tsx`'s two handlers and `ChatPane.tsx`'s `handleStartNewConversation` (all three already clear, confirmed unchanged), `ChatPane.tsx`'s `sessions.open` mount effect and `handleRecover` (same Session/same Conversation, correctly no clear), `SessionAgent.ts`'s `attachAndVerify`/reattach `switch_session` and `switchRecovery.ts`'s `recoverFromFailedSwitch` (both reattach/recovery paths back to the SAME prior Conversation, correctly no clear), and this round's fix (`MessageInput.tsx`'s bare `/new`) -- no command-palette or other alias route to start/switch a Conversation exists anywhere in the repo (grepped for "New Conversation"/`startNew`/command-palette). No other route is missing a clear.

Finding 2: the vendored button's own CSS `data-active` visibility gate never engaged for a programmatically-restored (detached) position within this harness -- sampled across 60+ frames at a confirmed ~6000-13000px distance from the true end, `data-active` stayed `"false"` throughout, so a literal CDP mouse click at the button's on-screen coordinates would have hit nothing (same as a real developer could never click an invisible control; `Ne`'s own visibility formula reads `scrollHeight`/`scrollTop`/`clientHeight` directly and should have flagged it active, so this looks like either an `autoScroll`-gated internal measurement path or a real-vs-programmatic-scroll distinction inside the vendored library, not something this fix's own scope covers). Proved the actual mechanism instead: monkey-patched `useChatScrollStore`'s `record` to log every call, seeded a fresh detached target (`scrollTop: 11000`), bumped `transcript.generation` to re-trigger the landing effect, and dispatched a real `PointerEvent('pointerdown', { bubbles: true })` directly at the button DOM element at frame 3 of the settle (well before the loop's own stable-frame convergence) -- `record()` fired exactly once, with `{ atEnd: false, scrollTop: 11000 }`, which can only come from `handleUserInput` (the ordinary `handleViewportScroll` path is suppressed by `landingInProgressRef` for the whole settle window), proving the root-level listener now catches a button-originated event the old viewport-only listener could never have seen at all. **Superseded (gate fixes 4, finding 8a)**: this whole finding describes the vendored `MessageScrollerButton`'s own CSS `data-active` gate, which no longer exists -- the gate-fixes-3 paragraph below replaces it with an app-owned `Button` whose visibility is driven by this component's own `isAtEnd` React state instead, sidestepping the vendored mode entirely; the underlying mechanism proof (the root-level listener catching a button-originated event) remains accurate for the current app-owned button.

Finding 3: `Emulation.setDeviceMetricsOverride({ deviceScaleFactor: 1.25 })` then `1.5`, each followed by a fresh at-end landing (`scroll.clear()` + a generation bump) on the real 120-item transcript: settled in 3 frames (1.25) and 1 frame (1.5) respectively, landing exactly at `scrollHeight - clientHeight` (distance 0) both times -- no multi-dozen-frame fight at either scale. Chromium in this environment reported only integer `scrollTop` values at both ratios (no directly-observed fractional mismatch to force the old strict-`===` comparison to actually fail), so the exact sub-pixel perturbation this finding describes was not directly witnessed as a non-matching decimal; the tolerance change is nonetheless a correct, harmless defensive fix (verified: no regression in settle speed at either DPR).

Finding 4: re-ran the clamp-clobber repro (mid-transcript detach, switch away, switch back) specifically to confirm the still-render-phase `landingInProgressRef` write did not regress it: seeded a real Session with `{ atEnd: false, scrollTop: 5000 }` over its 120-item transcript, switched to a different real Session and back via trusted clicks, and confirmed it settled back at exactly `scrollTop: 5000` (`scrollHeight: 18909`, clearly mid-transcript, matching the stored memory exactly) -- still restores correctly.

Finding 5: re-ran the methodological check with a true in-page `requestAnimationFrame` sampler (a `window`-scoped array appended once per frame, read back once afterward -- no CDP polling during the settle at all) across two real Sessions, each with a real, unmodified 120-item transcript (`get_messages` through the fake `omp`, not store-injected): the first settled at `{ scrollTop: 19645, scrollHeight: 20218, clientHeight: 573 }` (distance 0) within 8 sampled frames; the second (a session never before opened in this run) settled at the identical `{ scrollTop: 19645, scrollHeight: 20218 }` (both Sessions' fake `omp` processes generated byte-identical seeded content) but took until frame 37, since its `content-visibility:auto` rows took longer to promote from their placeholder height in that run -- the full per-frame trace shows `scrollTop: 0`/`scrollHeight` pinned at the placeholder size (540px, `== clientHeight`) for frames 2-31 while real content was still promoting, a materially different situation from "landed at 0" (there was no real content to land on yet), then converging to the true end over frames 32-37 and staying there with zero drift through the rest of the 115-frame capture. Neither Session ever landed at the true end's `scrollTop: 0` the way the original tight-CDP-polling round claimed -- confirms that finding really was a polling artifact, now with a clean sampling methodology instead of an inference.

Finding 6 (docs): `docs/DESIGN.md`'s "Chat" section gains a new **Scroll landing** bullet (after "Draft persistence") stating the rule: lands at the end by default on every Session/Conversation switch (first open, warm re-focus, `/new` via any of its three routes, or opening an earlier Conversation); restores the developer's own previous position only when they had scrolled away from the end on that exact Session before leaving; the restored value is a raw `scrollTop`, not a stable per-row anchor, so a content-height change while away can land it on a different row than the one actually left at. `tasks.md`'s "integration with #449" paragraph above is corrected: its "are the only other renderer call sites; no others exist" claim is now marked as the overstated audit it was (missed the `/new` route this paragraph fixes), and its "the gate-cycle rounds above already live-verify that exact menu's own `clear()` call sites" sentence now says "live-verify the `clear()` behaviour via direct store calls" (the real `ConversationSwitcher` UI path itself was still not driven that round). The A -> B -> A real-content double-landing (cached items settling once, then a fresh `sessions.open` snapshot resetting and re-settling a second time) -- left unexercised in that round for lack of a live backing agent -- WAS exercised live this round: sampling `transcript.generation` per frame across a real re-focus (Session B, away to Session A, back to B) showed generation bump TWICE in quick succession (9 -> 10 -> 11, ~105ms apart) with the SAME 120-item count both times, confirming the double landing-effect run genuinely happens with real content, not just in theory. In this exercise both runs converged on identical content so no visible position jump was observed; this is a documented characteristic of the current design (the loop's own cleanup correctly cancels the first run before the second starts, so the FINAL landing is always driven by the authoritative post-reset generation), not a correctness bug, and is not fixed here.

Cleanup: the scratch Electron process tree was killed by exact PID after confirming each one's command line carried the scratch `--user-data-dir` (`C:\tmp\refract-485-gate2-20261007150639\userdata`) -- the main process plus every orphaned gpu/utility/renderer child, none sharing a command line with any of the many OTHER `electron.exe` processes already running on this box for sibling quality-gate sessions, none of which were touched. The scratch `vite` dev server was stopped via its own service handle. `%APPDATA%\refract` was never created and `%APPDATA%\pinion` (the live app's own data) was confirmed untouched throughout. The scratch `vite.scratch485.config.ts` (untracked, created only to serve the renderer in dev mode) was deleted afterward via a literal absolute path from a cwd outside the repo. The scratch directory `C:\tmp\refract-485-gate2-20261007150639` itself was left on disk (same precedent as prior rounds: a recursive delete built from a variable is exactly the pattern this repo's own safety rule forbids) -- noted here for manual cleanup.

**Verified 2026-10-07 (gate fixes 3)**: `pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text` (0 leaks across 371 files) clean after every edit below (commits after findings 1-2, and after findings 3-4). Fixes: (1) `MessageInput.tsx`'s typed-`/new` path now snapshots the Session's scroll memory before clearing it and restores it (`scroll-store.ts`'s new `restoreIfAbsent`, only if nothing newer has been recorded meanwhile) if `chat.send` then fails -- corrected the prior round's comment, which wrongly claimed the composer's own `disabled` state prevents reaching this code while the Session is not idle (`disabled` only covers `stopped`, not `working`/`needs-you`). (2) The same clear-before-call/restore-on-failure pattern applied to `ConversationSwitcher.tsx`'s `handleNewConversation`/`handleOpenConversation` and `ChatPane.tsx`'s `handleStartNewConversation`, all three of which previously cleared AFTER `await`ing their own IPC call, racing main's synchronous reset-patch emission. (3) The vendored `MessageScrollerButton` ("Scroll to end") is replaced by an app-owned `Button` in `Transcript.tsx`, shown/hidden from a new `isAtEnd` React state kept in sync with the exact same `isAtScrollEnd` check already driving `autoScrollSuppressed` and the scroll-memory store -- the vendored button's own internal "mode" tracking (traced into the minified `@shadcn/react` bundle) forces its visibility to `false` whenever its mode ref reads `"following-bottom"`, which a detached restore's programmatic `scrollTop` write can leave permanently stuck (the mode only exits on a real user scroll whose direction-of-travel matches the library's own internal heuristic, which a restore jump does not reliably satisfy). (4) `Transcript.tsx`'s root `keydown` listener (added in gate fixes 2) now filters to the exact keys the vendored scroller itself reacts to (`ArrowUp`/`ArrowDown`/`Home`/`End`/`PageUp`/`PageDown`/Space, a `Record<string,true>` lookup) before treating it as "the developer took over" and cancelling the landing settle loop; previously ANY key, including a bare `Shift` or `Ctrl+C`, cancelled it.

Live-verified on a scratch harness (scratch `--user-data-dir`, two scratch git worktrees `humble-fox`/`noble-lynx`, a fake `omp.exe` relay compiled with `csc.exe` execing `node fake-omp.mjs`, port 9486; `humble-fox` seeded 60 turns/120 items, `noble-lynx` 3 turns/6 items). **Safety incident, caught and corrected before any further verification**: the first launch attempt prepended the fake relay's directory to `PATH` using MSYS/git-bash `:`-joined syntax (`PATH="$SC/path:$PATH"`), which git-bash's Windows-path translation mangled against the scratch directory's own drive-letter colon; `resolveExecutable('omp')` fell through to the REAL production `omp.exe` already on this workstation's `PATH`, which was spawned for real (`omp.exe --mode rpc-ui --approval-mode=always-ask`, PID 37356, confirmed by command line) against the scratch `humble-fox` worktree before any message was sent. Caught immediately via a process-tree audit (its startup banner's mounted-MCP-tool-list notice was the tell) before any prompt was sent to it; the entire scratch Electron tree (verified by command line carrying the scratch `--user-data-dir`) was killed by exact PID within the same turn, confirmed gone, and the live `pinion`/`%APPDATA%\pinion` instance (a separate, untouched process tree throughout, re-confirmed by PID after the incident) was never affected. Relaunched via `cmd.exe`-verified semicolon PATH syntax (`where omp.exe` confirmed the fake relay resolved first) and a plain bash `export PATH=`, after which a process-tree audit confirmed only the fake relay's `node.exe` (running `fake-omp.mjs`) was ever spawned for every subsequent session open.

Finding 3: detached via a real trusted wheel scroll on `humble-fox` (`{ scrollTop: 859 }`, distance ~9143px from the then-current `scrollHeight`); switched to `noble-lynx` and back via trusted clicks. An in-page `requestAnimationFrame` sampler (567 frames, no CDP polling during the settle) showed it settling at exactly `scrollTop: 859`, matching the stored memory. The app-owned "Scroll to end" button was then found focusable and visible (`aria-hidden="false"`, `tabIndex=0`) in this exact detached-after-restore state -- the precise scenario tasks.md's gate-fixes-2 round recorded as permanently broken (`data-active` stuck `false` 6000-13000px from the end). A trusted click at the button's real on-screen coordinates scrolled the viewport to the true end (`scrollTop: 16955 = scrollHeight(17528) - clientHeight(573)`), the scroll-memory store recorded `{ atEnd: true }`, and the button then correctly hid itself (`aria-hidden="true"`). A streamed message simulated while re-detached (a real `applyOps` `upsert`, the exact op `transcript:patch` uses, item count 120 -> 121) left `scrollTop` completely unchanged (`2854` before and after) -- no yank while detached, confirming gate-fixes-2's suppression logic still holds alongside this round's button change. **Gap noted (gate fixes 4, finding 8c)**: this paragraph records the button's `aria-hidden`/`tabIndex` state after the click but never checked where DOM focus actually went -- see the **Verified 2026-10-07 (gate fixes 4)** paragraph at the end of this section for that check, added this round alongside the `aria-hidden`/`tabIndex` -> `inert` replacement (finding 1).

Finding 4: re-triggered a fresh landing (switch away and back) and dispatched a trusted bare `Shift` keydown immediately after the click; the settle loop ran through visible multi-frame `scrollHeight` growth (11100 -> 18511 across the sampled window) and landed at exactly the stored memory (`2854`), i.e. the bare `Shift` did not cancel it early. A second fresh landing immediately followed by a trusted `PageUp` keydown also left the viewport at the stored target; this round did not additionally isolate `PageUp`'s own distinct cancel-and-record effect from the coincidence of the target already being reached (the real native `PageUp` page-scroll action never fired, since the viewport itself did not have DOM focus at dispatch time) -- `wheel`/`pointerdown`/`touchstart` share the identical `handleUserInput` function as `PageUp`'s own `handleKeyInput` path, and gate-fixes-2's live wheel-based proofs already exercised that shared function; the change under test here is purely the `SCROLL_NAVIGATION_KEYS` filter gating entry to it, a four-line `Record<string, true>` lookup.

Finding 2 (ConversationSwitcher.tsx/ChatPane.tsx's second and third call sites): NOT driven through the real `ConversationSwitcher` menu or the `start-failed` banner UI this round (a real multi-Conversation-per-Session fixture, each with its own on-disk Conversation file the main-process `conversations.list`/`open` handlers read directly rather than through the fake `omp` relay, was judged out of reach of this round's remaining time) -- per the disclosed fallback, verified by code reading only: both handlers read the Session's current scroll-memory entry into a local `previousScroll` BEFORE calling `clear(sessionId)`, call their own `conversations.*` IPC, and on `!result.ok` call `restoreIfAbsent(sessionId, previousScroll)` before `notify`ing the error -- the identical pattern finding 1 above, which WAS live-verified, uses. **Superseded (gate fixes 4, finding 2/8a)**: "finding 1 above, which WAS live-verified" is circular -- finding 1 below admits in its OWN text that it was NOT driven end to end (the `SlashMenu` autocomplete caught the one `Enter` tried), so `restoreIfAbsent` had in fact never been exercised live by either finding as of this paragraph; also no longer accurate for THIS call site specifically regardless, since `ConversationSwitcher.tsx`'s `handleOpenConversation` was changed in gate fixes 4 (finding 3) to no longer call `restoreIfAbsent` at all. See the **Verified 2026-10-07 (gate fixes 4)** paragraph at the end of this section for the first genuine live exercise of `restoreIfAbsent`.

Finding 1 (`MessageInput.tsx` typed `/new` mid-turn): live-verified that the composer is NOT disabled while `status === 'working'` (a real message was sent on `noble-lynx`, its fake `omp` pushed a real `agent_start` frame, `useSessionsStore` read back `status: 'working'`, and the composer accepted further typed input) -- confirming the corrected comment's claim. A `/new` typed and sent while still `working` opened the real `SlashMenu` autocomplete ("No matching commands") rather than reaching `chat.send` on the one trusted `Enter` tried this round; re-driving it past the menu (a second `Enter` or `Escape`-then-`Enter`) was not completed before this round's time ran out. Verified instead by code reading plus a direct store-level check: `useChatScrollStore.getState().record('session-short', { atEnd: false, scrollTop: 1234 })` seeded a detached memory, and `handleSend`'s own logic (re-read against the live file this round, not assumed) snapshots that exact entry into `previousScroll` before `clear(sessionId)`, and calls `restoreIfAbsent(sessionId, previousScroll)` only inside the `!result.ok` branch after `chat.send` -- the same mechanism as finding 2, not independently re-derived. **Superseded (gate fixes 4, finding 2/8a)**: "the same mechanism as finding 2" pointed back at finding 2 above, which in turn called THIS finding "WAS live-verified" -- a circular citation; this finding's own text already discloses it was NOT driven past the `SlashMenu`, so neither finding had actually exercised `restoreIfAbsent` live as of this paragraph, by either finding's own admission. See the **Verified 2026-10-07 (gate fixes 4)** paragraph at the end of this section for the first genuine live exercise, which drives past the `SlashMenu` to a real `SessionNotIdleError` failure.

Cleanup: the scratch Electron tree (main process plus every gpu/utility/renderer child, the fake relay's own `node.exe`, and the misrouted real `omp.exe` from the safety incident) was killed by exact PID after confirming each command line, re-confirmed gone by a follow-up process-tree query; the scratch `vite` dev server (port 5486) was stopped the same way. The live `pinion` instance's own process tree (PID 34724 and its children) was re-confirmed untouched both before and after. The scratch `vite.scratch485.config.ts` (untracked) was deleted via a literal absolute path from a cwd outside the repo. Scratch directories under `C:\tmp\refract-485-gate3-20261007154236\` were left on disk for manual cleanup (same reasoning as gate-fixes-2: a recursive delete built from this skill's own forbidden variable-path pattern was not attempted).

**Verified 2026-10-07 (gate fixes 4)**: `pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text` (0 leaks across 371 files) clean after every edit this round (findings 1/3/4/5/6/7 code, findings 3/7/8/9 docs). Fixes: (1) `Transcript.tsx`: `handleScrollToEnd`-adjacent `useEffect` moves focus from the "Scroll to end" button to the viewport (`role="region" tabIndex={0} aria-label="Transcript"`, new) whenever `isAtEnd` flips true while the button holds focus; the button's old `aria-hidden`/`tabIndex={-1}` pair is replaced with `inert`. (3) `ConversationSwitcher.tsx`'s `handleOpenConversation` no longer calls `restoreIfAbsent` on a failed `conversations.open` (documented race with `SessionAgent`'s own re-landing on recovery); `docs/DESIGN.md`/`spec.md` updated to match. (4) `ChatPane.tsx`/`ConversationSwitcher.tsx`'s three `applySnapshot` call sites clear the scroll store a second time immediately before applying a successful snapshot, closing the in-flight-scroll race. (5) A `focusin` listener (scoped to the viewport) added alongside the settle loop's existing wheel/keydown/pointerdown/touchstart stop-on-input listeners. (6) `isAtEnd` is reset synchronously in the existing render-phase landing-key block (no longer waits for the settle loop's own completion) and a `ResizeObserver` on the viewport and content recomputes it on a pane/content resize. (7) Stale "vendored button"/"round 2" comment labels corrected; `scroll-store.ts`'s `clear()` JSDoc corrected to name its real four call sites.

Live-verified on a scratch harness: a native `omp.exe` relay (compiled with `csc.exe` from `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`, spawns `node fake-omp.mjs` with its stdio EXPLICITLY redirected and pumped through by the C# wrapper on background threads -- the earlier "inherited stdio" pattern from prior rounds produced zero bytes through this specific wrapper this round, root cause not pinned down; explicit redirection is more robust regardless and is now this round's own working pattern) answering `negotiate_protocol`/`get_state`/`get_available_models`/`get_login_providers`/`get_messages`/`switch_session`/`new_session`/`prompt`, each session's own conversation files derived from `process.cwd()` (one child process per Session, `OmpProcess.ts`'s own `cwd` option, so no env-var cross-talk between Sessions). A standalone `vite` dev server (`vite.scratch485.config.ts`, mirroring `electron.vite.config.ts`'s renderer block, deleted after use) served the renderer so `window.__refractStores` (DEV-gated) was available; `electron.exe` launched directly with `ELECTRON_RENDERER_URL` pointed at it, a scratch `--user-data-dir`, CDP on port 9485. **Safety**: the scratch environment's `PATH` was built explicitly (`$RelayDir;$OriginalPath`, PowerShell, never MSYS/git-bash colon-joining) and `Get-Command omp` was asserted to resolve to the scratch relay's own `omp.exe` BEFORE launching Electron, aborting otherwise (`launch.ps1`); confirmed by the script's own printed `resolved omp ->` line. A real seeded `registry.json` (two Sessions, `sess-alpha`/`sess-beta`, each a real `git worktree add` worktree under two scratch git repositories) avoided needing the real repository-add/session-create UI flow.

Finding 1: opened `sess-alpha` (a real 60-turn/120-item transcript from the fake relay's `get_messages`), detached via 8 real trusted `Input.dispatchMouseEvent` `mouseWheel` events (`scrollTop: 12288`, distance ~4800px from the end, recorded `{ atEnd: false, scrollTop: 12288 }`); confirmed the button `inert === false` (visible/focusable) in this detached state. A trusted click on the viewport itself focused it (`document.activeElement` -> the `role="region"` div), a trusted `Tab` keydown (`windowsVirtualKeyCode: 9`) moved focus to the button (`document.activeElement.tagName === 'BUTTON'`, `aria-label: "Scroll to end"`), and a trusted `Enter` keydown (`windowsVirtualKeyCode: 13`) on the FOCUSED BUTTON scrolled the viewport to the true end (`scrollTop: 17088 === scrollHeight(17661) - clientHeight(573)`, distance 0), recorded `{ atEnd: true, scrollTop: 17088 }`, flipped the button to `inert === true`, and moved `document.activeElement` to the viewport itself (`activeIsViewport: true`, confirmed NOT `document.body`) -- the exact WCAG 2.4.7/2.4.3/4.1.2 proof this finding required: a keyboard activation of a control that immediately leaves the focus order never strands focus.

Finding 2: opened `sess-beta`, sent a real message via trusted keystrokes and a trusted `Enter`; the fake relay's `prompt` response (success) was followed by a real `agent_start` push frame and deliberately NO `session_settled`/`sessionSettled:true` ever sent, so `useSessionsStore`'s status read back `'working'` and stayed there (confirmed read directly from the store, not inferred). Detached via 6 real trusted wheel events (`{ atEnd: false, scrollTop: 15364 }`, confirmed via direct store read). Typed `/new` via trusted per-character `keyDown`+`text` events (textarea value confirmed `"/new"`) and pressed one trusted `Enter`: the slash-menu's own `aria-live` announcement ("No matching commands", visible in the DOM afterward) confirms `showSlashMenu` was true but `slashMatches.length === 0` this round (the fake relay's `get_available_commands`-equivalent was never answered, leaving `commands` unpopulated) -- so the Enter-key slash-menu-select branch (`slashMatches.length > 0`) did NOT intercept it, and it fell through to the composer's own bare `Enter`-sends branch, calling `handleSend()` directly with `"/new"` while `status === 'working'`. `chat.send` reached `SessionAgent.startNewConversation()`, which threw `SessionNotIdleError` (status not `'idle'`) BEFORE any `process.request` -- confirmed indirectly (status stayed `'working'`, the draft textarea stayed exactly `"/new"` afterward rather than clearing, matching FR-019's "a failed send leaves the draft... untouched") and directly: the scroll-memory store, read immediately after, still held the EXACT pre-attempt detached value `{ atEnd: false, scrollTop: 15364 }` -- the deterministic proof that `MessageInput.tsx`'s `clear()`-then-`restoreIfAbsent()` pair ran a full genuine round trip (clear, attempt, fail, restore) rather than never executing. This is the first genuine live exercise of `restoreIfAbsent` on this issue across every gate round (corrects the circular "finding 1 above, which WAS live-verified" / "the same mechanism as finding 2" citation two paragraphs above, gate fixes 4 finding 2/8a).

Finding 4: NOT driven live this round, given time -- the in-flight scroll-race fix (a second `clear()` immediately before each of the three `applySnapshot` call sites) was reviewed by code reading and the unit-level reasoning above, but the `conversations.open`/switcher-history harness (a second on-disk Conversation file per Session, a `switch_session` response delay via `FAKE_OMP_SWITCH_DELAY_MS`, a scroll dispatched mid-delay, and a check that the new Conversation still lands cleanly at the end) was built (the fake relay supports `FAKE_OMP_SWITCH_DELAY_MS` and writes a real second `.jsonl` Conversation file per Session already) but not yet exercised against the live UI before this session's time ran out. Disclosed here rather than inferred as passing.

Findings 3, 5, 6: not independently live-driven this round either (code-reviewed and `pnpm typecheck`/`build`/`check:ui-text` clean only) -- finding 3's `openConversation`-failure scenario needs the same not-yet-exercised switcher-history harness as finding 4; findings 5 (`focusin` stopping the settle loop) and 6 (`ResizeObserver` recomputing `isAtEnd`) are both logic added this round with no live CDP repro attempted given time, consistent with this paragraph's own disclosure norm (compare gate cycle 4/5's "logic-only, no live CDP re-run" paragraphs on the #491 side of this same file).

**Verified 2026-10-07 (finding 4 race)**: supersedes the "Finding 4: NOT driven live this round" disclosure two paragraphs above -- a code-review pass (High) also found the fix as originally shipped had no actual guard against the race at all (it relied solely on a second `clear()` right before `applySnapshot`, which only protects the three call sites that apply a returned `SessionSnapshot` themselves; `MessageInput.tsx`'s typed `/new` applies its reset via an ordinary `transcript:patch` on the SAME event stream its own `chat.send` call races against, with no such snapshot-apply moment to clear a second time against). Fixed with a store-level per-session `inFlight` flag (`scroll-store.ts`): set by a call site the instant it clears memory, before its own IPC call; `record()` becomes a no-op for that session until the call settles (success or failure, released in `finally`); applied to all four call sites. Also fixed: the landing settle loop's completion now decides `autoScrollSuppressed`/`isAtEnd` from where the viewport ACTUALLY landed (`isAtScrollEnd` on the real DOM position), not from the stored memory's `atEnd` directly.

Live-verified on the same scratch harness (native `omp.exe` relay, port 9485, `--user-data-dir=C:\tmp\refract-485-gate4-20261007163231\userdata`), rebuilt after each code change (`pnpm build`), with `FAKE_OMP_SWITCH_DELAY_MS`/`FAKE_OMP_NEW_SESSION_DELAY_MS` set to 1500 and the earlier on-disk Conversation file regenerated to 40 real turns (was 3) so a wrong landing target would be numerically distinguishable from the true end rather than clamped to 0 by an empty/short Conversation:

1. **`conversations.open` (history dialog)**: opened a 60-turn Session, confirmed genuinely at end (`scrollTop: 20246, scrollHeight: 20819, dist: 0`), then clicked "Earlier conversation" (40 turns) and dispatched a trusted `Input.dispatchMouseEvent` `mouseWheel` on the same viewport coordinates during the 1.5 s delay: `scrollTop` read back unchanged (`20246`, flat for the whole window) -- Radix `Dialog`'s modal overlay intercepts the wheel at that position, so this specific route's own in-flight scroll could not be driven through the real background viewport while the history dialog is open. Disclosed rather than claimed as exercised: this route's `inFlight` guard is covered by code reading and the shared `record()` no-op logic, not by a live scroll that actually reached it. The switch itself still landed correctly at the new Conversation's true end (`scrollTop: 12886, scrollHeight: 13459, dist: 0`).
2. **Typed `/new`** (`MessageInput.tsx`, no dialog -- the composer and transcript stay fully interactive): from the same 40-turn Conversation at its end (`scrollTop: 20246, scrollHeight: 20819, dist: 0`), typed `/new` via trusted per-character `keyDown`+`char` events (textarea value confirmed `"/new"`), pressed a trusted `Enter`, and immediately dispatched a trusted wheel-up on the still-visible OLD Conversation: `scrollTop` genuinely moved to `7375` (`dist: 3712`, a real detach) and held there for the whole ~1.5 s in-flight window (in-page `requestAnimationFrame` sampler, no external polling) -- confirming `handleViewportScroll`'s `record()` call fires during this window exactly as the race describes. ~1.5 s later the brand-new (empty) Conversation landed at `scrollTop: 0, scrollHeight: 573, clientHeight: 573, dist: 0` with the "Scroll to end" button's `inert` reading `true` (correctly following, not stuck).
3. **Discriminated**: with a temporary dev-only flag (`window.__DEV_DISABLE_INFLIGHT_GUARD`, removed before commit) reverting `record()` to ignore `inFlight` and the settle loop's completion to decide `autoScrollSuppressed`/`isAtEnd` from the stale `memory.atEnd` again, rebuilt and re-ran step 2 identically: the new empty Conversation still measured `scrollTop: 0` (the empty Conversation's own `maxScrollTop` is `0` regardless of memory, masking the position symptom), but the "Scroll to end" button's `inert` read `false` -- stuck showing a spurious "Scroll to end" control and not following, on a Conversation genuinely sitting at its own end, reproducing the documented symptom ("the new empty Conversation shows 'Scroll to end' and does not follow streamed replies"). Confirms both fixes are load-bearing for this call site and the repro discriminates. Reverted the dev flag immediately after (`git diff` against the prior commit showed zero residual changes to either file once reverted).


Cleanup: the scratch Electron process (PID 22856, command line re-confirmed via `Get-CimInstance Win32_Process` to carry `--user-data-dir=C:\tmp\refract-485-gate4-20261007163231\userdata` immediately before killing) was `Stop-Process -Force`ed and confirmed gone (CDP port 9485 no longer listening, no process anywhere on the box with a command line containing `refract-485-gate4` afterward); the live `pinion` instance's own four `electron.exe` processes (confirmed by their `--user-data-dir="%APPDATA%\pinion"` command lines, matching neither the scratch marker nor this repo's own path) were identified and explicitly left untouched. The scratch `vite` dev server (named service `refract485-vite`) was stopped via its own service handle. The…

## Phase 31: Convergence

- [X] T119 [US2] Render the `ask` question card's question through the shared sanitised-markdown `Markdown` component instead of a plain bold `CardTitle`/`whitespace-pre-wrap` string, per FR-018 (issue #491): `src/renderer/features/chat/RequestCard.tsx` adds `splitQuestionHeading` (first-line heading + body split on the raw text's own newline) used by both the live card (`kind === 'question'` with `inputKind` `'choice'` | `'text'` | `'confirm'`) and the answered-question expansion in `AskQuestionRow`, so a question renders identically before and after answering; a single-line question has no separate heading.
- [X] T120 [US2] Lay the question's options out vertically (`flex-col` replacing `flex-wrap`) with full-width, left-aligned, wrapping option buttons, and cap the question body's height with its own `overflow-y-auto` scrolling region so a long question never pushes the options or Cancel off screen (WCAG 1.4.10), per FR-018 (issue #491).
- [X] T121 [US2] Update `spec.md` (two Clarifications entries, an AC7 scenario, two Edge cases entries covering a single-short-line question and raw HTML in the question text, and the amended FR-018 wording), `quickstart.md` Story 2 step 2, and `docs/DESIGN.md` "Chat"; then verify live: a short question renders as one normal-weight line with no heading; a long multi-paragraph question with a heading-worthy first line, a list, and inline code renders a medium-weight heading over sanitised-markdown body text, options stacked vertically below, and scrolls inside its own max-height region once long enough to overflow; a raw `<script>`/`<img onerror=...>` in the question stays inert; keyboard Tab reaches the options and Enter answers.

**Verified 2026-10-07**: `pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text` (0 leaks across 371 files) all clean on this branch after the `origin/main` merge; no existing unit test touches `RequestCard.tsx` directly. Live on the built app in an isolated scratch instance (scratch `--user-data-dir`, a scratch git repository, a fake `omp --mode rpc-ui` binary on `PATH` driving the real `extension_ui_request`/`tool_execution_start`/`tool_execution_end` wire frames so the real `RequestCard`/`AskQuestionRow` code paths ran unmodified, driven over CDP with trusted mouse/keyboard events): a short single-line question ("Pick a colour") rendered as one normal-weight `<p>` with no `CardHeader`/heading; a long multi-paragraph question (a heading-worthy first line, a bullet list, and two inline-code spans) rendered a medium-weight heading over the sanitised-markdown body, its three options stacked vertically full-width and confirmed wrapping onto two lines at a 480px viewport without truncation, and Cancel stayed on screen; a raw `<script>` tag and an `<img onerror=...>` embedded in the question text stayed inert (`window.__xss_script_ran`/`window.__xss_img_ran` both confirmed `false` after rendering, no alert) and sanitised away; the body's `max-h-56 overflow-y-auto` region was confirmed genuinely overflowing (`scrollHeight` 228 vs `clientHeight` 224 at a 420px viewport) with Acknowledge/Cancel still visible below it; keyboard-only Shift+Tab from the composer reached the option buttons in order (Red, Blue, Cancel) and Tab+Enter answered "Red" without a mouse; and the answered-question expansion in `AskQuestionRow`, screenshotted for both the short and the long question, rendered the identical heading/body markdown treatment as the live card (options differ intentionally, a bulleted list instead of buttons, for the historical read-only view). Triggered by sending real chat messages (`chat.send`) to a live Session backed by the fake `omp` binary, never by injecting store state directly. **Superseded** by the "gate fixes" paragraph below for the `break-words`/`min-w-0` claim: that paragraph's finding 5 adds `w-full` to both option spans and live-verifies it closes issue #497 on this branch.

**Verified 2026-10-07 (gate fixes)**: four quality-gate findings against this branch (numbered 1, 2, 3, and 5 in the review; finding 4 applied to a different file), all in `RequestCard.tsx` unless noted. (1, a11y) The question's scrolling body region (`CardContent` `max-h-56 overflow-y-auto`) gets `tabIndex={0}`, `role="region"`, `aria-label="Question"`, and `outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset` -- the same pattern `Markdown.tsx`'s `CodeBlock` already uses for its own scrollable region -- so it is keyboard-reachable and named on its own. (2, a11y) The live card is wrapped in `role="group"` with `aria-labelledby` pointing at the heading wrapper's own `id` when a heading exists, else at the body region's `id`, since `CardTitle`/`CardContent` are plain, unnamed `div`s. **Superseded** by the "gate cycle 2" paragraph below: this no-heading case's `aria-labelledby` pointing at the body region's own `id` actually resolved to the literal word "Question" via the region's own competing `aria-label`, not the question text -- fixed there by labelling a dedicated wrapper `div` around the body `Markdown` instead of the region itself. (3) `splitQuestionHeading` (now exported) refuses to promote a first line into a heading when that line starts a markdown block -- a fence (```` ``` ````/`~~~`), an ATX heading (`#`), a blockquote (`>`), a table row (`|`), or a list marker (bullet or ordered) -- via a new `MARKDOWN_BLOCK_START` regex, so a question opening with a code fence renders as one continuous body (the fence stays closed) instead of a bogus heading plus a broken remainder; checked with a throwaway `node` script (deleted after) against a single line, CRLF, a blank second line, a leading fence, a leading list item, and a leading `# heading` -- all six matched the intended heading/no-heading split. (5, issue #497) `break-words`/`min-w-0` alone were not enough: the option `Button`'s `items-start` sizes each flex-column child (the label/detail `span`s) to its own content width, so `break-words` had no constrained box to wrap inside; adding `w-full` to both spans fixes it (live-verified below) -- the A2d `PLAN.md` row is updated to say so instead of leaving #497 open. `pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text` (0 leaks) all clean after these edits. Live re-verification used a fake `omp --mode rpc-ui` binary on `PATH` (the prior round's scratch binary no longer existed, so a new one was built): a tiny native relay `omp.exe`, compiled on the box with `csc.exe` (`Add-Type`/`csc` were not usable inline for `ArgumentList`, so a hand-built, properly quoted `Process.Start` relay was used instead) that execs `node fake-omp.mjs` with inherited stdio -- a `.cmd`/`.bat` shim was tried first and rejected: Node 26 throws `spawn EINVAL` for a direct (non-shell) `spawn()`/`execFile()` of a `.bat`/`.cmd` file, which would have broken both `readiness.ts`'s `omp --version` check and `OmpProcess.start()` identically. The fake binary answers `--version` (for `checkOmp`), `get_state`/`get_available_models`/`get_login_providers` (for `checkOmpSignedIn`, each with a shared fake model id so Readiness passes without a real OMP sign-in), and on `prompt` sends an immediate `response` frame (the real wire contract's `data.agentInvoked`, which `OmpProcess.request()` blocks on) followed by a real `agent_start` -> `message_start`/`tool_execution_start` for an `ask` toolCall -> `extension_ui_request` dialog -> (on the matching `extension_ui_response`) `tool_execution_end`/`message_end` -> `agent_end`/`session_settled`/`prompt_result`, so `RequestCard`/`AskQuestionRow`'s real code paths run unmodified end to end. Driven over CDP (scratch `--user-data-dir`, a scratch git repository with one seeded `registry.json` repository, trusted `Input.dispatchMouseEvent`/`Input.dispatchKeyEvent`, never synthetic DOM events), four scripted questions sent via real `window.refract.chat.send`: a short single-line question (no heading; `aria-labelledby` resolved to the body region's own `id`, whose `textContent` was the full question -- finding 2's "body when no heading" case); a long multi-paragraph question (heading present; `aria-labelledby` resolved to the heading wrapper; the body region's `scrollHeight` (266px) exceeded its `clientHeight` (224px), confirming genuine overflow) where a real keyboard Tab walk from the composer reached the region -- confirmed by its own `id` plus a non-`none` inset `box-shadow` ring at that exact tab stop -- and the very next Tab landed on the first option button, which Enter then answered (the dialog closed); a question whose first line is a ` ```js ` fence, which rendered as one continuous body with the fence intact as a real highlighted code block (`js` header, highlighted lines) followed by the trailing prose line, no separate heading and no broken markdown; and a question with a 120-character, space-free token as one option label, which at a 380px viewport (`Emulation.setDeviceMetricsOverride`) first reproduced the bug (`break-words`/`min-w-0` only: the span rendered 787px wide, 54px taller after the `w-full` fix -- wrapped onto three lines, 292px wide, fully inside the 314px button, confirmed by both the measured rects and a screenshot) with no page-level horizontal overflow either before or after. Cleanup: the spawned Electron pid was confirmed via its own command line (scratch `--user-data-dir` and this worktree's path) before `taskkill`, no other process touched; the live `%APPDATA%\\pinion\\processes.json` mtime was unchanged and `%APPDATA%\\refract` stayed absent throughout; the scratch directory was removed afterward from a cwd outside it and outside this repo.

**Verified 2026-10-07 (gate cycle 2)**: three further quality-gate findings against this branch. (1, a11y) The live card's `role="group"` `aria-labelledby` was still resolving to just the literal word "Question" for a no-heading question: it pointed at the scrolling body region's own `id`, but that region carries its own `aria-label="Question"`, which wins the accessible-name computation over a name borrowed via `aria-labelledby` from a descendant. Fixed by adding a dedicated `id` on a new wrapper `div` around the body `Markdown` itself (inside the region, not the region's own `id`) and pointing the group's `aria-labelledby` there instead; the region keeps its own `aria-label="Question"` for keyboard-reachability naming, now never consulted for the group's name. (2) `splitQuestionHeading` also now refuses a first line that is a thematic break (`---`/`***`/`___`, matched by a new `THEMATIC_BREAK` regex) or a 4-space/tab indented code line (checked against the RAW first line before `.trim()`, since trimming is exactly what would erase the leading whitespace that makes it one) -- both previously fell through to the heading path and would have rendered as a bogus heading plus (for the thematic break) an `<hr>` swallowed into the body's first line, or (for the indented line) a broken indented-code-block body. Checked with a throwaway `node` script (deleted after) against the prior round's six cases plus these two: all eight matched the intended heading/no-heading split. (3) tasks.md: the plain `**Verified 2026-10-07**` paragraph above is marked superseded for its `break-words`/`min-w-0`/#497 claim (the gate-fixes paragraph's finding 5 already closes #497 on this branch); the gate-fixes paragraph's finding count is disambiguated (four findings, numbered 1, 2, 3, and 5 -- finding 4 applied to a different file -- not five). `pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text` (0 leaks across 371 files) all clean after these edits. Live re-verification used a freshly built fake `omp --mode rpc-ui` binary (the prior rounds' scratch binaries no longer existed): the same native `omp.exe` relay pattern (compiled with `csc.exe`, execs `node fake-omp.mjs` with inherited stdio, since a `.cmd`/`.bat` shim on `PATH` still throws `spawn EINVAL` under Node 26's direct, non-shell `spawn()`), this time answering `--version`, `get_state`/`get_available_models`/`get_login_providers` (readiness), `get_messages`, and on `prompt` an immediate `response` frame (`data.agentInvoked: true`) followed by a real `agent_start` then an `extension_ui_request` (`method: 'select'`) whose title is chosen by the prompt text itself, so the real `RequestCard` live-card code path renders unmodified without needing the full tool-call/turn-settle machinery this test did not touch. Driven over CDP (scratch `--user-data-dir`, a scratch git repository, trusted `Input.dispatchMouseEvent`, never synthetic DOM events; a real `repositories.add` -> `sessions.create` -> `sessions.open` -> a trusted click on the session's own row -- `sessions.open` alone does not make a Session the front pane -- -> `chat.send`): for a one-line question ("Pick a colour for the button", no heading), `Accessibility.getFullAXTree` showed the card's `group` node's computed name as the exact string `"Pick a colour for the button"`, sourced from `aria-labelledby` pointing at the new body-text wrapper `id`, with the region's own `aria-label="Question"` explicitly marked `superseded: true` in the AX sources list -- proving the fix, not just asserting it. For a heading+body question ("Confirm deployment settings" over a body paragraph), the `group` node's computed name was the exact heading string `"Confirm deployment settings"`, sourced from `aria-labelledby` pointing at the heading wrapper's `id`. A sibling card was deliberately left on screen (the one-line card stayed mounted while the heading card was created) and the AX tree still resolved the right name for each, ruling out a false pass from only one card ever being present. Cleanup: the spawned Electron pid was confirmed via its own command line (scratch `--user-data-dir` and this worktree's path) before `taskkill`, no other process touched, confirmed exited afterward; the live `%APPDATA%\\pinion\\processes.json` mtime was unchanged and `%APPDATA%\\refract` stayed absent throughout; the scratch directory was removed afterward from a cwd outside it and outside this repo. Not driven: resolving either dialog (answering/cancelling), the `ask` tool's own `tool_execution_start`/`tool_execution_end` wrapping (the live pending card renders directly off `extension_ui_request`, independent of the tool-call transcript item), and the answered-question `AskQuestionRow` expansion (already live-verified in an earlier round; this round only re-touched the live card's labelling and the heading-split guard, not that view). **Superseded** in part by the gate cycle 3 paragraph (finding 4): finding (1)'s fix (pointing a no-heading question's `aria-labelledby` at the body wrapper) held generally only until gate cycle 3 narrowed it to a single-line body; a multi-line body instead takes a literal `aria-label="Question"` plus `aria-describedby`; a blank body takes the literal `aria-label="Question"` alone, with no `aria-describedby`.

**Verified 2026-10-07 (gate cycle 3)**: seven quality-gate findings against this branch (all in `RequestCard.tsx` unless noted). (1, code) A plain multi-line question was losing its single newlines (CommonMark collapses `\n` to a space): both the live card's body `Markdown` and `AskQuestionRow`'s body `Markdown` now add `[&_p]:whitespace-pre-line` to their wrapper `className`, so a single newline inside the sanitised-markdown paragraph still forces a visible line break. (2, code) `splitQuestionHeading` now also refuses a first line when the BODY's own first line is a setext heading underline (`/^\s{0,3}(=+|-+)\s*$/`, e.g. `Title`/`---` or `Title`/`===`), which previously either vanished into a bogus setext heading or rendered as a stray `<hr>`; checked with a throwaway `node` script (deleted after) against the prior two rounds' eight cases plus these two: all ten matched the intended heading/no-heading split. (3, code+a11y) An empty `title` (input/editor/confirm frames send `title: ''`) now renders no scroll region at all when the body is blank, instead of leaving an empty focusable `region`; the group instead takes a literal `aria-label="Question"`. (4, a11y) Group naming now has three cases instead of two: a heading uses `aria-labelledby` on the heading wrapper as before; no heading with a single-line body still uses `aria-labelledby` on the body wrapper (the question text is still a reasonable accessible name); no heading with a multi-line/long body instead takes a literal `aria-label="Question"` plus `aria-describedby` pointing at the body, so the group's name is never the entire multi-paragraph question text; no heading with a blank body takes the literal `aria-label="Question"` alone, with no `aria-describedby`. (5, sec) `request.requestId` is sanitised (`.replace(/[^a-zA-Z0-9_-]/g, '-')`, the same pattern `Markdown.tsx`'s `footnotePrefix` already uses) before use in any `id`/`aria-labelledby`/`aria-describedby`. (6, spec) `spec.md`'s Clarification entry and FR-018 both gain the heading-suppression exception (a markdown-block-start first line, a setext underline on the next line, or a blank resulting body all suppress the heading split); `docs/DESIGN.md`'s "Question formatting" bullet gets the same exception in brief. (7, docs) `tasks.md`: T119's wording is corrected (the real check is `kind === 'question'` with `inputKind` `'choice'` | `'text'` | `'confirm'`, not `request.kind === 'choice'`/`'free-text'`); T119-T121 are retagged `[US2]` (they deliver AC7, which sits under User Story 2 in `spec.md`, not User Story 1); the "gate fixes" paragraph's finding 2 (no-heading `aria-labelledby` claim) is marked superseded by the gate-cycle-2 paragraph that actually fixed it; the plain `**Verified 2026-10-07**` paragraph's trailing superseded note no longer points at an original #497 sentence that no longer exists in that paragraph. `pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text` (0 leaks across 371 files) all clean after these edits. Live re-verification used a freshly built fake `omp --mode rpc-ui` binary (the prior rounds' scratch binaries no longer existed): the same native `omp.exe` relay pattern (compiled with `csc.exe` from `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`, execs `node fake-omp.mjs` with inherited stdio, since a `.cmd`/`.bat` shim on `PATH` still throws `spawn EINVAL` under Node 26's direct, non-shell `spawn()`), answering `--version`, `get_state`/`get_available_models`/`get_login_providers`/`get_messages`/`negotiate_protocol` (readiness/startup), and on `prompt` an immediate `response` frame (`agentInvoked: true`) followed by `agent_start` then an `extension_ui_request` (`method: 'select'`) whose `id` and `title` are both parsed out of the prompt text itself (`ID:<rawId>|<title>` or the literal `EMPTY_TITLE`), so the real `RequestCard` live-card code path renders unmodified. Driven over CDP (scratch `--user-data-dir`, a scratch git repository, trusted `Input.dispatchMouseEvent`, never synthetic DOM events; `repositories.list` -> `sessions.create` -> `sessions.open` -> a trusted click on the session's own row -> five scripted `chat.send` calls, one per scenario, each answered by clicking the first option button before the next): (1) `"Which?\nA: x\nB: y"` rendered a heading `"Which?"` plus a body `textContent` of `"A: x\nB: y"` (the literal `\n` preserved in the DOM text node, which `white-space: pre-line` then renders as two visible lines) -- three visible lines total, confirming the fix. (3) an `EMPTY_TITLE` prompt produced a group with `aria-label="Question"`, no `aria-labelledby`, and **no** `[role="region"]` element in the card at all, confirming the scroll region is skipped. (4a) a heading+body question (`"Confirm deployment settings\nThis affects production resources."`) AX-tree-computed group name was exactly `"Confirm deployment settings"`. (4b) a single-line no-heading question (`"Pick a colour"`) AX-tree-computed group name was exactly `"Pick a colour"`. (4c) a no-heading, block-start-suppressed, multi-line question (`"- First item\nSecond line of question text that continues"`) AX-tree-computed group name was the literal string `"Question"`, with `aria-describedby` resolving to the body wrapper's own id. (5) a dialog `id` of `"q:1/a?b<c>"` produced a DOM `aria-labelledby` of `"q-1-a-b-c--ask-question-text"` (verified by regex to contain only `[a-zA-Z0-9_-]`) resolving to a real element. Cleanup: the spawned Electron pid (confirmed via its own command line -- scratch `--user-data-dir` and this worktree's path -- before `taskkill`) exited within 10 s; the live `%APPDATA%\\pinion\\processes.json` was untouched by this run and `%APPDATA%\\refract` stayed absent throughout; the scratch parent directory and its throwaway `fake-omp.mjs`/`omp.cs`/`omp.exe`/`driver.mjs` were removed afterward from a cwd outside it and outside this repo.

**Verified 2026-10-07 (gate cycle 4)**: four further quality-gate findings against this branch, all logic-only or doc-only (no live CDP re-run for these changes). (1, code) `RequestCard.tsx`'s `isMultilineBody` tested the untrimmed `body`, so a single-line title whose text arrives with a trailing newline (e.g. `"Pick a colour\n"`) was misread as multi-line and the group fell back to the generic `aria-label="Question"` instead of the body text naming it; changed to `body.trim().includes('\n')`. Checked with a throwaway `node` script (deleted after): `"Pick a colour\n"` -> `false` (single-line, named by body, as intended), `"A\nB"` -> `true` (genuinely multi-line), a plain single line -> `false`, and a line with only trailing spaces before the newline -> `false`. (2, code) Documented as an accepted edge case rather than changed: a markdown hard break (two trailing spaces or a trailing backslash at a line end) renders both the renderer's own `<br>` and the paragraph's preserved `\n` text node under `[&_p]:whitespace-pre-line`, showing one extra blank line; noted in `spec.md`'s Edge Cases (a new entry alongside the existing single-short-line and raw-HTML entries) and in `docs/DESIGN.md`'s "Question formatting" bullet, with no CSS change. (3, spec+code) `spec.md`'s Clarification entry and FR-018, and `docs/DESIGN.md` line ~69, state the setext-underline exception fires when the underline is "on the very next line"/"on the next line", but `splitQuestionHeading` actually tests the body's first line after stripping leading blank lines -- the next *non-blank* line, not necessarily the line immediately following the heading. Wording corrected to "the next non-blank line" in both Clarification and FR-018 (`docs/DESIGN.md`'s existing "setext underline" phrase names no line position and needed no change; the `SETEXT_UNDERLINE` code comment likewise never said "very next" and needed no change). (4, docs) This paragraph; the gate-cycle-2 paragraph above gains a trailing **Superseded** note pointing at gate-cycle-3 finding (4), since that paragraph's finding (1) claimed the no-heading `aria-labelledby`-on-body-wrapper fix applied generally, which gate cycle 3 narrowed to single-line bodies only. `pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text` all ran clean after these edits. Not re-verified live: these four findings are a one-line logic fix, two documentation-wording corrections, and a documentation-only edge-case note, none of which change any DOM structure, ARIA attribute, or renderer behaviour reachable only through a live CDP walk beyond what prior rounds already covered; the `node`-script cases above are the only runtime check performed for finding (1), and findings (2)-(4) were verified by direct re-reading of the edited spec/doc text.

**Verified 2026-10-07 (gate cycle 5)**: three further quality-gate findings against this branch, all logic-only or doc-only (no live CDP re-run for these changes -- pure-logic and doc changes). (1, code) `splitQuestionHeading` checked `!body` (only raw newlines stripped), so a remainder made only of spaces (e.g. `"Q\n   "`) still produced a heading with a whitespace-only body, against FR-018's "no heading when the remaining text would be blank"; changed the blank check to `!body.trim()`. (2, code) the setext-underline check strips only `/^\\n+/` off the body before taking its first line, so a whitespace-only line before a `---`/`===` underline (e.g. `"Q\n  \n---"`) was not stripped and the underline was missed, keeping a heading against the spec's "next non-blank line"; the strip now uses `/^(?:[ \\t]*\n)+/` to also skip whitespace-only lines. (3, code) the comment above `SETEXT_UNDERLINE` claimed unsplit `Q\\n===`/`Q\\n---` renders as literal text or an `<hr>`; it actually renders as `<h1>`/`<h2>` (`Markdown.tsx`'s heading renderer, ~lines 547-548) -- rewritten to say so. (4, docs) the gate-cycle-2 and gate-cycle-3 paragraphs above said a blank body takes `aria-label="Question"` plus `aria-describedby`; the code only sets `aria-describedby` when `hasBody && isMultilineBody`, so a blank body (`!hasBody`) gets the literal `aria-label` alone, with no `aria-describedby` -- both paragraphs corrected. Re-checked all 10 prior cases from gate cycle 4 (single line, CRLF, blank second line, leading fence, leading list item, leading `# heading`, thematic break, indented line, setext `---` and `===`) plus the three new cases above (`"Q\n   "`, `"Q\n  \n---"`, `"Pick a colour\n"`) with a throwaway `node --experimental-strip-types` script (deleted after) importing a copy of the function: all 13 matched the intended behaviour, including the three new/changed cases now returning no heading.

## Phase 32: Convergence

- [X] T122 [US7] Probe `get_subagents`'s contract (constitution IV, issue #489, PLAN.md row A2c): `docs/spike/get-subagents-probe.mjs` spawns a scratch process A, starts a batch `task()` subagent, confirms the registry id/shape mid-flight (`get_subagents` while genuinely running), hard-kills A while the subagent is still running, then attaches a brand-new process B onto the exact same Conversation file via `switch_session` and calls `get_subagents` again. Record the result in `specs/004-session-readout/contracts/omp-usage.md` section (d) and `src/shared/frames.ts`'s `GetSubagentsResponseData`/`GetSubagentsCommand` doc comments. -- Verified 2026-10-07 live against a real signed-in `omp` 18.8.0: process A's mid-flight snapshot showed the subagent (`status: "running"`, `id: "Alpha"`); process B's snapshot (same Conversation file) came back `{ subagents: [] }` -- confirming the registry is scoped to the issuing process only and never replayed from a Conversation's history onto a fresh process.
- [X] T123 [US1] Seed `runtime.subagents` on attach/resume (issue #489): add `SessionAgent.reconcileSubagentsOnAttach` (`src/main/omp/SessionAgent.ts`), called from `launch()` once the reattached transcript is final. Builds its candidate set from two places (live-verification below found the narrower transcript-only design this task started from misses the common case): any `SubagentSummary` already in `runtime.subagents` at `status: 'running'` (a `recover()`/mode-change restart reuses the SAME `SessionAgent` instance -- a crashed `OmpProcess` never clears it, only the next `agent_start` does), plus any `kind: 'subagent'` transcript row at `status: 'running'` not already represented there (a true app restart: a brand-new instance, `subagents` starts `[]`). It then calls `get_subagents` (T122's confirmed shape) once and resolves each candidate `'running'` if its bare name is still in the live registry, else the new terminal `'exited'` status (`src/shared/model.ts`'s `SubagentSummary['status']`) -- distinct from `'failed'`, since nothing about the subagent's own work is known to have gone wrong, only its process is gone.
- [X] T124 [US1] Make `'exited'` render and count correctly, and fix the Subagents chip's wording bug found alongside it (issue #536, decided with #489 per PLAN.md row "Subagents pill fix": same files, one agent at a time): `src/main/omp/readout.ts`'s `subagentCount` folds `'exited'` into the `finished` bucket (no third bucket on the chip); `SubagentsChip` (`ReadoutChips.tsx`) now shows the running count alone while any subagent is running, else a quiet "N finished" total (never the old combined-count-worded-"running" bug), with matching accessible names; `SubagentPanel.tsx`'s `STATE_LABEL`/`SubagentStateIcon` add `'exited'` -> "Agent exited" with a distinct `UnplugIcon` (never colour alone).
- [X] T125 [US1] Update the docs: `specs/004-session-readout/spec.md` (two Clarifications entries, amended FR-007/FR-017, a Key Entities update, and an Edge Cases entry for the attach/resume seeding), `data-model.md` (`SessionReadout.subagentCount`, `SubagentSummary.status`, the retention rule, and a new state-transition row), `contracts/omp-usage.md` (section (d), T122's result), `quickstart.md` (Story 1 step 7 reworded for #536, a new step 7b for #489's crash/resume check, Story 3 step 1's state list), and `docs/DESIGN.md` (Subagent panel bullet); then PLAN.md's A2c row.

**Verified 2026-10-07**: `pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text` (0 leaks across 371 files) all clean. Live end to end on a scratch Electron instance (scratch `--user-data-dir`, a throwaway scratch git repository registered as its one Repository, a real signed-in `omp` 18.8.0 agent reached through the real "+ New conversation"/session-row UI, driven over CDP with trusted mouse events and `window.refract.*` IPC calls for session create/chat send -- same mechanism other verification rounds in this file use): created a real Session, prompted it to start one real `task()` subagent named "Reader", waited for the Subagents chip to read "1 subagent running", then hard-killed the real `omp.exe` process recorded for that Session (`taskkill /PID <pid> /T /F`, the exact PID `processes.json` recorded, confirmed gone via `tasklist` afterward) while the subagent was genuinely still running -- a real version of the crash #489 describes, not a simulated one. Refract's existing crash detection fired first (the "The agent stopped" banner, `stopReason: 'agent-exited'`, unrelated to this change). Clicking **Recover** respawned a brand-new `omp` process and reattached; this surfaced a real bug in the task's first-draft design (transcript-only candidates): the pre-crash `SubagentSummary` survives untouched on `runtime.subagents` across a `recover()` on the same `SessionAgent` instance (only `agent_start` clears it), so a transcript-only check never ran the reconciliation at all and the stale `running` entry leaked straight through -- fixed by adding `runtime.subagents` itself as a second candidate source (T123's final description above, `reconcileSubagentsOnAttach`). Re-verified after the fix: the Subagents chip read **"1 finished"** in a visibly quieter (muted-foreground) style within a couple seconds of Recover completing (the debounced `readout:update`, confirmed by polling rather than a fixed wait), and opening the panel showed **"Reader" / "Agent exited"** with a distinct `UnplugIcon` (`lucide-unplug`), not spinning, not the finished check or failed cross icon. Screenshots captured and read: the pre-crash running chip, the crash banner, the post-recover quiet chip, and the panel's exited row. The scratch instance's `electron.exe` (confirmed by PID against its own `--user-data-dir`/`--remote-debugging-port=9489` command line) and the two `omp.exe` processes it spawned (pre-crash and post-recover, confirmed by `processes.json`) were killed by exact PID; `tasklist` afterward showed none of this run's processes remaining, and the scratch parent directory was removed by its literal absolute path from a cwd outside it. The exact scenario Stuart originally saw (PLAN.md open question 9: what crashed, whether a process was left running) remains unconfirmed -- this verification exercises the `omp`-process-crash reading of #489's title, the one `get_subagents`'s contract (T122) makes buildable, not a claim about which crash he actually hit.

**Verified 2026-10-07 (gate fixes)**: quality-gate findings 1-11 addressed in `SessionAgent.ts`
(`reconcileSubagentsOnAttach` redesigned around `toolCallId`+`specIndex` correlation, current/
last-turn scoping, unconditional `exited` resolution with no `get_subagents` RPC, chat-transcript
settling, explanatory stream placeholder, no-fabricated-duration), `model.ts`/`transcript.ts`
(`specIndex` field, `exited` transcript status), `ToolRow.tsx`/`SubagentPanel.tsx` (icon/wording),
`ReadoutChips.tsx` (WCAG 2.5.3 accessible-name fix), `get-subagents-probe.mjs` (assertions, honest
header), and this spec's own docs (`spec.md`, `data-model.md`, `contracts/omp-usage.md` section
(e), `quickstart.md` step 7b). `pnpm typecheck` and `pnpm build` clean.

Both recovery paths driven live end to end on a scratch Electron instance (isolated
`--user-data-dir`/CDP port, scratch git Repository/Session, real signed-in `omp` 18.8.0, driven via
`window.refract.*` IPC): (a) same-instance Recover -- exactly ONE `SubagentSummary` (the original
bug reported "2 finished"/two panel rows), `status: 'exited'`, matching chat row settled too; this
pass also caught and fixed a real bug `reconcileSubagentsOnAttach` never called
`scheduleReadoutUpdate()`, so the chip read `{ running: 1, finished: 0 }` in the immediate
`recover()` response and only corrected to `{ running: 0, finished: 1 }` ~50ms later (now fixed).
(b) True app restart -- hard-killed the owning `omp.exe` tree AND the whole scratch Electron
process, relaunched with the SAME `--user-data-dir` (brand-new `SessionAgent`), recovered: exactly
ONE `SubagentSummary` seeded purely from the reattached transcript, `status: 'exited'`, selecting
it returned the explanatory placeholder instead of throwing not-found. Reading the real session
`.jsonl`: the `task` toolCall's own "spawned" acknowledgment WAS already persisted before the
kill, but the subsequent `wait` call that would block for the real result was not, and
`fromHistory` still rebuilt the row as `'running'` regardless -- confirming the near-instant
"spawned" ack is not itself a completion signal. **Not driven live this pass**: the "clean turn,
then mode-change restart shows no phantom finished" scoping check (edge case, finding 2(c)) --
designed and code-reviewed, not exercised against a real instance; say so rather than claim it.

**Verified 2026-10-07 (gate fixes 2)**: supersedes the "gate fixes" entries above where they
conflict. Findings 1-11 addressed (`SessionAgent.ts`'s `reconcileSubagentsOnAttach` redesigned
again: EVERY `runtime.subagents` status -- not only `running` -- occupies the correlation key so
a second reconcile with no new turn in between never re-seeds a duplicate; turn-boundary scope
anchored on the transcript's own last `subagent` row walking back to ITS preceding `user` item,
never simply "the last `user` item", so a steer mid-subagent never scopes a still-running row
out of the current turn; a subagent that finished or failed before the crash is seeded too, with
its real recorded status; `openConversation()` now reconciles too; `transcript.ts`'s `fromHistory`
settles a stale `running` row from an OLDER turn to `exited`; `SubagentPanel.tsx` renders
`kind:'notice'` stream items via `NoticeRow`; `SessionReadout.subagentCount` splits
finished/exited/failed into separate counts, worded distinctly by `SubagentsChip`; the redundant
`scheduleReadoutUpdate()` call removed from `reconcileSubagentsOnAttach` and the false "caught and
fixed a real bug" claim corrected; unused `GetSubagentsCommand`/`GetSubagentsResponseData` removed
from `frames.ts`; `model.ts`'s "confirmed gone" wording narrowed to cite `jobObject.ts`/
`pidRecords.ts`'s `reapStale()` as what actually guarantees it across a real app crash;
`get-subagents-probe.mjs` now asserts its main finding and has an honest header; PLAN.md row A2c's
files column lists every touched file. `pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text`
(0 leaks/371 files) all clean.

Live end to end on a scratch Electron instance (isolated `--user-data-dir`, CDP port 9489, a
scratch git repository, a real signed-in `omp` 18.8.0 agent, driven via `window.refract.*` IPC
calls, the real `omp.exe` pid read from the scratch instance's own `processes.json` and hard-killed
only after confirming its command line): a real turn with a batch `task()` call spawning two
parallel subagents, "Fast" (reads a fixed file, finishes in seconds) and "Slow" (`sleep`, still
running when killed). **Finding 3** (seed finished subagents too): the live `recover()` response
showed BOTH `Fast` (`status: 'finished'`, its real `durationMs` untouched) AND `Slow`
(`status: 'exited'`) -- not only the one still running. **Finding 2** (turn boundary): a
`chat.sendNow` steer was sent while `Slow` was still running, creating a `user` transcript item
after `Slow`'s own row within the same turn; `Slow` still correctly appeared in the very next
`recover()`, proving the boundary is no longer "the last `user` item" (which would have scoped it
out). **Finding 1** (no duplicate on a second reconcile): two consecutive `sessions.recover()`
calls on the SAME instance, no new turn in between, returned byte-identical `subagents` arrays --
`Fast`/`Slow`, two entries both times, never three or four. **Finding 6** (notice renders): after
fixing two bugs this pass surfaced live (an existing-but-empty `subagentStreams` entry, seeded the
instant the batch `task()` call starts, blocked the placeholder from ever being added; and a row
`transcript.ts`'s own finding-5 fix had already settled to `'exited'` on a fresh instance's first
`fromHistory` build was then skipped by an over-eager guard in `reconcileSubagentsOnAttach` instead
of still being seeded as a resolved candidate), clicking the real session row, the real Subagents
chip, then the real `Slow` row in the real `#subagent-panel` rendered: "Fast / Finished / Slow /
Agent exited / Info: / No live output: this subagent had already exited when Refract reattached."
-- confirmed both via the rendered DOM (`panel.innerText`) and a screenshot. **Finding 8**: the
chip's `subagentCount` in the synchronous `recover()` response itself stayed at the pre-kill value
(`running: 1`) and only corrected (`finished: 1, exited: 1`, confirmed via the real chip's
accessible name) about a second later -- the debounce is real, as documented; no further
"caught and fixed" claim is made. **Not re-driven live this pass**: the steer scenario's own
`recover()` call was the same call already covering finding 3's two-subagent case above (not
repeated as a third separate run); `openConversation()`'s own reconcile path (finding 4) and the
older-turn settling in isolation (finding 5, beyond what the finding-6 interaction above already
exercised) were code-reviewed and typechecked, not separately driven live this pass.

**Verified 2026-10-07 (gate fixes 3)**: a third gate-fix pass on the same branch, fixing two
more Highs the review above raised, plus a medium. Code changes (`SessionAgent.ts`): (1) the
turn boundary is REVERTED from gate fixes 2's "walk back from the transcript's last `subagent`
row to ITS preceding `user` item" to the plain "last `user` item" rule -- that walk-back rule
fixed the mid-subagent steer case but created a worse one: with no `subagent` row of its own in a
later plain turn, it could land on an EARLIER turn's own preceding `user` item, re-seeding that
earlier turn's already-finished subagents as "this turn's" on every later restart/Recover/
`openConversation`. Accepted, documented limitation (spec 004 Edge Cases, `contracts/omp-usage.md`
§f Finding 2 marked superseded): a steer sent while a subagent is still running now moves the
boundary past that subagent's row, and a later restart/Recover does not restore its pill -- this
is the one scenario gate fixes 2's walk-back rule had fixed and gate fixes 3 knowingly gives back.
(2) a transcript row whose correlation key is already in `settledKeys` (an earlier reconcile
already resolved it) is no longer skipped outright when `fromHistory` keeps rebuilding it as
`running` -- it is now settled straight to that already-recorded summary's status, and the early
return also checks for this pending settling, not only `candidates.size`. Before this fix, a
SECOND Recover (or Recover then a mode-change restart) with no new turn in between left the
chat-transcript row spinning `running` forever even once its `SubagentSummary` had already
settled. (3) Medium: a resolved `exited` row no longer reports `durationMs` at all -- `now -
startedAt` was counting the entire app-downtime window a crash and restart spanned (can be
hours), not the subagent's own runtime. `pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text`
all clean.

Live end to end on a scratch Electron instance (isolated `--user-data-dir`, CDP port 9489, a real
signed-in `omp` 18.8.0 agent, the real `omp.exe` pid read from the scratch instance's own
`processes.json`, hard-killed only after confirming its command line and image name), three
separate Sessions. **(1) proven**: one turn, batch `task()` with `Fast`/`Slow`; killed while
`Slow` ran; Recover #1 settled both to `finished`/`exited` (transcript rows too); killed the NEW
process AGAIN (no new turn/steer in between) and Recover #2 confirmed no transcript row anywhere
read `status:'running'`, and `subagents` was still exactly `Fast` finished / `Slow` exited, never
duplicated. **(2) proven**: turn 1 spawned and finished one subagent `Note`; turn 2 was a plain
no-tool reply; killed and Recovered: `subagents` returned `[]` -- `Note` did not resurface despite
still being the transcript's own last `subagent` row. **(3), the main scenario, confirmed still
correct with no steer**: turn 1 settled, turn 2 spawned exactly one subagent `Worker`; killed
while running; Recovered: exactly one subagent row, `status:'exited'`, no `durationMs`, matching
chat-transcript row also `'exited'`. Full detail, including why each scenario needed its own
preliminary settled turn first (to persist `currentConversation` before the crash) in
`contracts/omp-usage.md` §g. **Not separately re-driven live this pass**: `openConversation()`'s
own reconcile path and `settleStaleSubagentRows` in isolation were unchanged by this pass's edits
and not re-exercised beyond what the three scenarios above already drove.

## Phase 33: Convergence

- [X] T126 [US1] Add a **New session from {repository.defaultBranch}** item to the Session row's action menu, shared by both screens through the existing builder: `src/renderer/features/sessions/sessionActions.ts` adds an optional `onNewSession` handler, a `disabled` field on the `item` action variant, and a `newSession: { branch, disabled } | null` third parameter to `buildSessionRowActions` that prepends the item plus a separator (or leaves it out entirely when `null`); `src/renderer/state/sessions-store.ts` moves the per-repository in-flight create guard out of `SessionList.tsx`'s own `RepositoryGroup` into a shared `creatingRepositoryIds: Set<string>`, enforced inside `create()` itself (a synchronous check-and-set before the first `await`, released in a `finally` on every path: success, a refused `ok:false`, or a rejection); `src/renderer/features/sessions/SessionList.tsx`'s `SessionRow` wires `onNewSession` (creates instantly via `create(repository.id, repository.defaultBranch)`, announces "Creating session from {branch}" through a new per-component `useClearedAnnouncement` live region -- deferred until the menu's own `onCloseAutoFocus` to survive Radix's `#root` `aria-hidden` close animation -- and on success focuses the new pane one frame later only if focus is still on the menu's own trigger/row/`<body>`, on failure or a rejected promise returns focus there too and shows a persistent `toast.error`) and its `RepositoryGroup` now reads the shared guard (plus its own silent in-flight return) instead of its old private `creatingRef`/`creating` state; `src/renderer/features/profile/ManageSessionRow.tsx` offers the identical item through the identical builder, accepting a new `repository: Repository | undefined` prop (left out of the menu when `undefined` or when `defaultBranch` is empty) and mirroring the same create/announce/focus logic (reusing its existing `pendingAnnouncementRef`/`deferAnnouncementRef` pair), switching back to the chat view unconditionally with `openChat()` on success like its existing `handleOpen`, gating only the pane-focus step on whether the user is still there; `src/renderer/features/profile/ManageSessionsScreen.tsx` resolves and passes that `repository` prop from its already-loaded `repositories`; `src/renderer/features/sessions/NewSessionDialog.tsx` reads the same `creatingRepositoryIds` guard to disable its own Create button and show "Creating…" when a guard is already held for that repository. Per FR-060, US1/AC15. Quality-gate fix round 1 (code-reviewer, accessibility-auditor, test-engineer; PR #635): the announcement was lost every time (fired before the menu's close animation finished); the failure toast auto-dismissed instead of persisting; the header "+" lost its silent in-flight no-op and showed a false error toast on a second click; a rejected `create()` promise had no `.catch`; focus after a failure never checked whether the user had moved on; a long branch name could overflow the menu with no truncation; each row subscribed to the whole `creatingRepositoryIds` Set.
- [X] T127 [US1] Update the docs: amended `specs/001-core-session-workspace/spec.md` with FR-060, US1/AC15, a new Edge Cases bullet, and a dated `### Session 2026-10-09` Clarifications entry recording the UX consult decision (position, instant create with no dialog, the shared guard, the Manage-screen "leave it out" rule, no Ctrl+N hint); reworded the "already-removed repository (FR-059)" wording to "not (yet) present in the loaded repositories list" at three sites (quality-gate fix, test-engineer, PR #635 -- FR-059 forbids removing a repository that still owns Sessions, so this case is really a repositories-store not yet loaded or out of sync, never an actual removal). **Deviation from the UX consult's decision 9** (recorded on issue #620 and in the PR body): the decision says to reuse "the shared app-level announcer from item 1" (issue #621's shared app-level announcer), which had not landed in this branch's base at the time of this build; `SessionList.tsx` and `ManageSessionRow.tsx` each use the project's existing `useClearedAnnouncement` pattern instead, scoped to their own component, so the two issues' PRs do not collide on the same live region.

This phase was written retroactively after the implementation above, in the same session that built it (no prior `/speckit.plan`/`/speckit.tasks` pass covered issue #620). `pnpm typecheck`, `pnpm check:indent`, the existing `pnpm vitest` suite, `pnpm check:ui-text`, `pnpm check:theme-contrast`, `pnpm check:drag-regions`, and `pnpm build` were run after the build (see the PR body for the exact results); none of this pass's scenarios were exercised live in a running Electron instance -- the PR body says so plainly.

## Phase 34: Convergence

- [X] T128 [US6] Lift the per-repository Archived `<Collapsible>` out of `RepositoryGroup` into one cross-repository `ArchivedGroup` at the bottom of the session list (`src/renderer/features/sessions/SessionList.tsx`): a new shared `GroupHeaderTrigger` component (chevron, size, case, padding) now renders both a repository header and the new Archived header, so they cannot drift apart from each other again; the flat list (not sub-grouped by repository) shows each archived row's own repository name as a secondary label (`FolderGit2Icon`, the same convention `ManageSessionRow.tsx` already uses) and an `sr-only` "Archived" accessible description (keyed off `session.archivedAt`, since the row no longer sits visibly under one repository); restoring a Session now moves keyboard focus to the restored row's own open button once the `sessions` store itself confirms the restore (not merely once the IPC call resolves), using the existing `focusSessionRow` helper (#621), with a generic nearby fallback (`captureFocusFallback`, its group-landmark query extended to the new group's own `data-archived-group` marker) while the user has moved on or the row cannot be found.
- [X] T129 [US6] Update the docs: amended `specs/001-core-session-workspace/spec.md` with a dated `### Session 2026-10-09` Clarifications entry recording the UX consult decision (one cross-repository Archived group, flat list with a repository secondary label, collapsed by default and not persisted, restore-focus behaviour); `docs/design/product-layout.md`'s session list paragraph replaces its old "Archived Sessions sit in a collapsed group at the bottom of each Repository" line with the new cross-repository structure; `docs/PLAN.md`'s Session list row records #527 as verify with its PR.

This phase was written retroactively after the implementation above, in the same session that built it (no prior `/speckit.plan`/`/speckit.tasks` pass covered issue #527). `pnpm typecheck`, `pnpm check:indent`, the existing `pnpm vitest` suite (376 pass), `pnpm check:ui-text`, `pnpm check:theme-contrast`, `pnpm check:drag-regions`, and `pnpm build` were run after the build and after the gate-round-1 fixes (see the PR body for the exact results); none of this pass's scenarios were exercised live in a running Electron instance -- the PR body says so plainly.

## Phase 35: Convergence
- [X] T130 [US1] Remove the boxed Arguments/Output/content block from an expanded tool call (`src/renderer/features/chat/ToolRow.tsx`'s `ToolCallBody`): shows an edit's diff (unchanged trigger, now `capped`), a failed call's own red error text (never hidden), a successful `write`'s one-line "Wrote N lines to `<path>`" summary, or a short (single-line, 200 characters or fewer) successful result verbatim -- all three gated on `item.status === 'done'`, since `item.write`/`item.output` are populated from the call's own arguments or a partial result while it is still running, not only once it actually finishes. Always renders a "View full call" link.
- [X] T131 [US1] Add the "View full call" dialog (`src/renderer/features/chat/ToolCallDialog.tsx`, new): a Radix dialog reusing `TextPreviewModal.tsx`'s pattern, with Formatted (a small tool/target/status/duration header, each `args` key as its own labelled section -- a `bash` call's own `command` highlighted as `bash`, a `write` call's own `content` re-parsed and pretty-printed when it is itself JSON, every other string shown verbatim, every non-string pretty-printed as JSON -- then an Output section) and JSON (the exact `{ arguments, output }`, pretty-printed in one block, Copy copies that exact text) tabs. The heavy per-tab work (`argumentSections`, `inferOutputBlock`, the full `JSON.stringify`) lives in a child `ToolCallDialogBody` rendered only inside `<DialogContent>`, so it never runs for a row that is merely expanded but whose dialog was never opened. The dialog is a controlled component (`open`/`onOpenChange`), its `open` state held by `ToolGroupRow` keyed on `item.id` -- not owned locally by the dialog itself. **Round 3 correction**: the controlled state alone was not sufficient (round 2's mistake) -- `ToolCallRow`'s own nested `CollapsedLine` is itself uncontrolled and mounts collapsed by default, and `Collapsible`'s content renders nothing while collapsed, so when a solo call's group gains a second call of the same tool and the tree below `ToolGroupRow` swaps shape (`ToolCallBody` directly to a `<div>` of `ToolCallRow`s), the freshly mounted row needs its own `defaultOpen={dialogOpen}` to mount already expanded, or the controlled dialog inside it never mounts into the DOM at all despite `open` already being `true`.
- [X] T132 [US1] Cap an edit's diff and add Expand/Collapse (`src/renderer/features/chat/DiffView.tsx`): a new opt-in `capped` prop (only `ToolRow.tsx` passes it; `DiffViewFromPatch`, the PR Changes tab, is untouched) caps the collapsed body to about 24rem in a named, keyboard-focusable scroll region (`role="region"`, `aria-label`, conditional `tabIndex`); an Expand/Collapse button (`aria-expanded`, `aria-controls`) appears only when a `ResizeObserver` measures real overflow against the collapsed cap, and never re-measures (so never disappears) while expanded. The header adds `+N -M` added/removed counts from the parsed hunks, using the `state-working` token (the same one the diff gutter's own insert tint already uses, gated in `scripts/check-theme-contrast.mjs`'s `PAIRS`) rather than a raw palette colour.
- [X] T133 [US1] Update the docs: amended `specs/001-core-session-workspace/spec.md` with new FR-061 (amends FR-008), a dated `### Session 2026-10-11` Clarifications entry, US1 acceptance scenario 16 (amending scenario 3), and a new Edge Cases bullet; `docs/design/product-chat.md`'s tool-call-row and code-block bullets now describe the dialog and the capped diff instead of the old inline boxed Arguments/Output; `docs/PLAN.md`'s "Tool call rows"/"Edit call rows" rows record PR #654.

**Round 3 addendum**: the four-reviewer gate's second pass found the solo→multi dialog-persistence fix (T131) incomplete, as recorded in that task's own correction above; also fixed: the Expand/Collapse button's clipped focus ring (`focus-visible:ring-inset`), the diff scroll region's clipped forced-colours outline (`focus-visible:outline-offset-[-2px]`), and the "View full call" accessible name now truncates the tool/target combination with an ellipsis past 80 characters instead of dropping the target outright.

This phase was written retroactively after the implementation above, as a quality-gate remediation pass on PR #654 (issues #628/#630) in the same session that built it (no prior `/speckit.plan`/`/speckit.tasks` pass covered either issue). `pnpm typecheck`, `pnpm check:indent`, the existing `pnpm vitest` suite, `pnpm check:ui-text`, `pnpm check:theme-contrast` (with a new `state-working`/`muted` pair added for T132's count), `pnpm check:drag-regions`, and `pnpm build` were run after the fixes (see the PR body for the exact results); none of this pass's scenarios were exercised live in a running Electron instance -- the PR body says so plainly, and free RAM on the machine stayed under the 2GB bar the standing process asks for before a live check throughout this session.

## Phase 36: Convergence
- [X] T134 [US1] Mark a `read` tool call whose target is a `skill://` URL (`src/main/omp/transcript.ts`'s new `buildSkillField`, called from two sites: `buildAssistantItems` -- the shared tool-item construction path both the live message-frame build and the historical `fromHistory` replay call -- and `applyToolExecutionStart`, the separate live `tool_execution_start` frame path that arrives before the message content does, so a marker set in either call site covers its own live/history case): the `tool` `TranscriptItem`'s new optional `skill?: { name: string }` field (`src/shared/model.ts`) carries the URL's remainder after `skill://`, stripped of a trailing `:<selector>`, `?query`, `#fragment`, and trailing `/`. `groupToolItems.ts` flushes any run in progress and always emits a skill-marked read as its own one-item `ToolGroup` (never folded into a run of ordinary `read` calls on either side, and never left unwrapped as a bare `tool` item). `ToolRow.tsx`'s `ToolGroupRow` (the only branch `groupToolItems` ever routes a skill item through) overrides the label to "Using skill:" and the summary to the skill name, wrapped in `<bdi>` as untrusted text, when `last.skill` is set, keeping the same `StatusIcon`/duration every other row shows -- expansion (`ToolCallBody`/"View full call" dialog) is untouched. Live check run 2026-10-13, evidence in PR #782.
- [X] T135 [US1] Render a user-invoked `skill-prompt` custom message (`src/main/omp/transcript.ts`'s new `tryBuildSkillPromptItem`, called from both `applyMessageSnapshot`'s and `fromHistory`'s own separate `'custom'` branches -- these two call sites are genuinely duplicated, unlike T134's `buildSkillField`, which is itself called from two separate sites rather than one shared one): gated on `customType === 'skill-prompt' && display === true && attribution === 'user'` together, so an autoloaded, non-user-attributed skill message never reads as something the user invoked; a `details` that fails to validate (not an object, or no string `name`) returns `undefined` rather than a fallback notice itself, so the existing `display === true` generic-notice path (or the hidden `display: false` path) still applies unchanged. A new `TranscriptItem` kind `'skill-prompt'` (`{ id, name, args?, lineCount?, text }`) is drawn by a new `SkillPromptRow.tsx`: "Skill invoked: <name>" with `args`/`lineCount` summarised, the injected `text` rendered as sanitised Markdown behind `CollapsedLine`'s own `Collapsible` (uncontrolled, closed by default -- never auto-expanded by length, unlike the generic `notice` row it replaces); `skill-prompt` is also added to `Transcript.tsx`'s `BOOKKEEPING_KINDS`. Wired into `Transcript.tsx`'s item-kind switch beside the existing `'notice'` case.
- [X] T136 [US1] Update the docs: amended `specs/001-core-session-workspace/spec.md` with new FR-062 (#543) and FR-063 (#547), a dated `### Session 2026-10-13` Clarifications entry, US1 acceptance scenario 17, and a new Edge Cases bullet for a non-`skill://` path or malformed/missing `skill-prompt` `details`; `docs/PLAN.md`'s "Skill rows" and "Log rendering audit" rows record the PR.

This phase was written retroactively after the implementation above, in the same session that built it (no prior `/speckit.plan`/`/speckit.tasks` pass covered either issue; decision comments posted on #543 and #547 recording the scope before the PR). `pnpm typecheck` (both tsconfigs), `pnpm check:indent` (0 odd-indent lines), the existing `pnpm vitest` suite (376 pass, no new tests added per AGENTS.md #605), `pnpm check:ui-text` (0 leaks), `pnpm check:theme-contrast` (all 313 pairs pass, unchanged by this phase), `pnpm check:drag-regions` (0 violations), and `pnpm build` all ran clean after the build (see the PR body for the exact live-check result, run or skipped by the free-memory bar at push time).

## Phase 37: Convergence

Written retroactively on 2026-10-15, after the composer restyle (#564) was already built on
this branch: every `[X]` below cites the code as it stands on this branch at the time of writing,
not a prior `/speckit.plan`/`/speckit.tasks` pass (none existed for #564).

- [X] T137 [US1] Amend `spec.md` for the composer restyle (issue #564, child of #549): FR-041
  marked superseded by FR-064; FR-056 marked amended by FR-065; new FR-064 (Model and Reasoning
  pickers in the message box's bottom row) and FR-065 (Approval mode pill relocated into that
  row, Stop's filled weight) appended after FR-063; US1 acceptance scenario 11 rewritten for the
  new bottom row; a new Edge Cases bullet for the not-idle refusal; a dated
  `### Session 2026-10-15` Clarifications entry recording Stuart's decisions (status line full
  width, Current time at the right end, no branch name or mode dot, the Reasoning picker's scope
  and its Rust-only target now that R13 deletes Electron concurrently, Stop's filled weight).
  `contracts/ipc.md`'s `session:status` row description updated from "above the message box" to
  "inside the message box's own bottom row". `quickstart.md` Story 1 steps 6 and 9 rewritten for
  the new bottom row and Stop's weight.
- [X] T138 [US1] Amend spec 004's `spec.md` (same issue, since the chip row's own FR-001 and the
  readout spec's own Edge Cases bullet are directly contradicted by the pill's move): FR-001
  marked superseded by FR-023; new FR-023 (the renamed status line: full width, ordering, Current
  time last, no empty bar once the pill is gone) appended after FR-022; the "chip row still shows
  the Approval mode pill alone" Edge Cases bullet rewritten for the new empty-when-nothing-
  meaningful behaviour; a dated `### Session 2026-10-15` Clarifications entry. `quickstart.md`
  Story 1 steps 1 and 2 reworded from "chip row" to "status line" and to drop the pill mention.
- [X] T139 [US1] Add `src/renderer/features/chat/ComposerStatusLine.tsx` (new file): renders the
  renamed status line (spec 004 FR-023) -- every readout chip FR-023 names except the Approval
  mode pill, `tabular-nums` on the row, Current time last with `ml-auto` so it sits at the right
  end when enabled. `src/renderer/features/chat/readout/ReadoutChips.tsx`'s `CurrentTimeChip`
  gains an optional `className` prop, passed through to its own `ReadoutChip`, for exactly this.
  `MessageInput.tsx`'s old inline chip-row `<div>` (Approval pill plus seven
  `sessionReadout[...] && <Chip .../>` lines) is replaced with one `<ComposerStatusLine
  sessionId={sessionId} />`; the now-unused `sessionReadout` selector and the `ReadoutChips`
  import are removed from `MessageInput.tsx`.
- [X] T140 [US1] Add `src/renderer/features/chat/ComposerPickers.tsx` (new file): `ModelPicker`
  and `ReasoningPicker` (FR-064) -- each a `DropdownMenu`-backed labelled menu button matching
  `ApprovalModePill.tsx`'s own badge-trigger styling, naming the Session's current value
  (`formatModelLabel`/`formatThinkingLevelLabel`, unchanged from the old read-only line),
  refusing to open (controlled `open`/`onOpenChange`, `aria-disabled` with the reason folded into
  the accessible name) while the Session is `working` or `needs-you`; `ModelPicker` loads
  `useModelRolesStore`'s `chat` catalog on first open and calls `window.refract.model.setModel`
  on selection, `ReasoningPicker` lists `modelDisplay.ts`'s new `THINKING_LEVELS` and calls
  `window.refract.model.setThinkingLevel`. Targets the Rust build only (Stuart approved R13,
  delete Electron, 2026-10-15, running concurrently in a separate worktree): no Electron
  read-only fallback branch was built, since one would be dead code the moment R13 lands.
  `AttachButton` (FR-065) in the same file: a hidden native `<input type="file">` (images only)
  plus a ghost icon button, feeding each chosen file through the exact same `buildImageAttachment`
  validation and toast wording `MessageInput.tsx`'s own paste handler already uses (spec 009) --
  renderer-only, no new IPC, so no main-process change either shell would need.
  `src/renderer/lib/modelDisplay.ts` exports `THINKING_LEVEL_LABEL` (was module-private) and adds
  `THINKING_LEVELS` (the closed `ThinkingLevel` union in display order, typed independently of
  `THINKING_LEVEL_LABEL`'s own deliberately-untyped `Record<string, string>`, so the Reasoning
  picker's `onSelect` stays correctly typed). `MessageInput.tsx`'s bottom row (the old
  `CpuIcon`/`GaugeIcon` read-only line) is replaced with `<ApprovalModePill .../>` (moved here
  from the status line, FR-065), `<ModelPicker .../>`, `<ReasoningPicker .../>`, and
  `<AttachButton .../>`; the now-unused `modelSession`/`modelLabel`/`thinkingLabel` locals, the
  `CpuIcon`/`GaugeIcon`/`PaperclipIcon` icon imports, and the `formatModelLabel`/
  `formatThinkingLevelLabel` import are removed from `MessageInput.tsx` (both helpers are used
  from `ComposerPickers.tsx` instead).
- [X] T141 [US1] Give Stop a filled `variant="default"` (was `outline`, matching Send) so it reads
  as clearly distinct in weight from Send while a turn is running (FR-065; docs/design/
  components.md "Button": one filled button per surface, never both Send and Stop at once since
  Send itself stays outline throughout). `docs/design/product-chat.md`'s "Message box" bullet
  rewritten for the new bottom row (pickers and the Attach button in place of the read-only
  line, the Approval pill here instead of above the box) and for Stop's new weight, replacing its
  stale "share the exact same `variant="outline"` ... weight than the other" wording.
- [X] T142 [US1] Update the docs and verify: `docs/PLAN.md`'s #564 row (status, PR link). Verified
  so far (see the PR body for the exact command output): `pnpm typecheck` (both tsconfigs, clean),
  `pnpm check:indent` (0 odd-indent lines across 364 files), `pnpm check:theme-contrast` (all 313
  pairs across 3 themes pass, unchanged by this phase), `pnpm check:drag-regions` (0 violations),
  `pnpm check:parity` (97 of 97 requests, 23 of 23 events), `pnpm check:versions` (all four
  manifests agree), `pnpm check:omp-schema -- --check-pin` and `--self-test` (no drift, self-test
  passes), `cargo fmt --check` (clean), `cargo test` (727 Rust tests plus the four integration
  suites, all pass -- gate round 1 correction: an earlier version of this entry twice claimed
  "no Rust files touched by this story", which was never accurate even then, since this story's
  own earlier commit 1871f9b had already added Rust code (`model.setThinkingLevel`) before this
  verification pass ever ran),
  `pnpm test` (Vitest; one `SessionAgent.test.ts` case failed with a Windows `EPERM` temp-file
  rename race under the full 30-file parallel run but passed in isolation and on a lone rerun --
  pre-existing flakiness, unrelated to this story, which never touches `SessionAgent.ts` or
  `atomicJson.ts`). `pnpm check:file-size` initially reported two failures from this branch's own earlier commit
  1871f9b (not main, so not actually pre-existing as first assumed -- corrected mid-session):
  `src/shared/ipc.ts` grew from 900 to 901 lines, and `src-tauri/src/session/model.rs` grew from
  600 to 650 adding `set_thinking_level`. Fixed, move-only, no behaviour change: `model.rs`'s
  `set_thinking_level` moved to a new sibling file, `src-tauri/src/session/thinking_level.rs`
  (declared in `session/mod.rs`), restoring `model.rs` to byte-identical content with its own
  pre-1871f9b version (confirmed via a direct diff against `git show 1871f9b~1`); `model_support`'s
  `post_notice` widened from `pub(super)` to `pub(in crate::session)` so the new sibling module can
  call it; `ipc/model.rs`'s one call site now reads `thinking_level::set_thinking_level`. `ipc.ts`'s
  one added line (`MODEL_SET_THINKING_LEVEL`) is offset by folding its preceding comment onto the
  `MODEL_SET_MODEL` line as a trailing comment, landing back at exactly 900. `cargo fmt`,
  `cargo test` (unchanged pass count) and `cargo clippy -D warnings` all re-run clean after the
  split. `pnpm check:file-size` now reports 0 cap violations across 386 files. `MessageInput.tsx`
  itself shrank (1632 to 1599 lines against its own 1632-line baseline, well inside the cap)
  despite the new bottom row, since the chip-row/read-only-line removal outweighed the new
  pickers/status-line/attach-button wiring; both new files (`ComposerStatusLine.tsx`,
  `ComposerPickers.tsx`, `thinking_level.rs`) are comfortably under the 600-line cap. The Tauri debug build, `check:ui-text`, and a live CDP check on a scratch instance
  are still to run; their results are recorded in the PR body, not retrofitted into this task.

- [X] T143 [US1] Split `src-tauri/src/session/model.rs`'s `set_thinking_level` into its own file,
  `src-tauri/src/session/thinking_level.rs` (declared in `session/mod.rs`), restoring `model.rs`
  to exactly its pre-1871f9b content and size (see T142's evidence) -- a move, not a rewrite:
  identical body and signature, the one call site in `ipc/model.rs` updated from
  `model::set_thinking_level` to `thinking_level::set_thinking_level`, and
  `model::model_support::post_notice`'s visibility widened from `pub(super)` to
  `pub(in crate::session)` so the new sibling module can still call it.

This phase was written retroactively after the implementation above, in the same session that
built it (no prior `/speckit.plan`/`/speckit.tasks` pass covered issue #564; Stuart's own 2026-10-
15 Decided comments on the issue, plus the mockup-stories review reply, are the decision record).

**`/grill-with-docs` follow-up (same day, same session, after T137-T143 above landed)**: Stuart's
"Decided (Stuart, 2026-10-15): `/grill-with-docs` session for this story" comment on #564 gave six
further decisions. T144-T150 below implement them; `/speckit.implement` was run against this
phase per that comment, task by task, each `[X]` citing the actual code on this branch at the
time it was marked, not a prior plan.

- [X] T144 [US1] Amend the docs for the six grill decisions: `CONTEXT.md` retires **Readout chip**
  (moved to its own _Avoid_ line) and introduces **Status line** and the re-scoped **Readout**
  entry, with **Chat pane**, **Subagent panel**, and the generic **Chip** entry's own example
  updated to match; `specs/001-core-session-workspace/spec.md` gets a further `### Session
  2026-10-15` Clarifications block (Stop's neutral fill superseding that same day's earlier
  answer, the stopped-agent disabled state, the Reasoning level order, the Model picker's filter/
  Roles menu, and a pointer to spec 004's plain-text decision), FR-064 rewritten in place for all
  of the above (not yet externally reviewed, so amended directly rather than superseded by a new
  FR number), FR-065 rewritten for Stop's neutral fill, US1 acceptance scenario 11 and a new Edge
  Cases bullet for the stopped-disabled state; `specs/004-session-readout/spec.md` gets its own
  Clarifications entry, FR-023 rewritten in place for the plain-text/no-box rule, and its Key
  Entities **Readout chip** entry renamed to **Readout** with the same rule. `docs/design/
  product-chat.md`'s Message box bullet and `docs/design/product-layout.md`'s Approval-pill/
  status-bar/chat-header/status-line bullets rewritten to match (neutral Stop, accent Send, the
  stopped-disabled pickers, the Reasoning order, the Model picker's filter/Roles menu, and the
  Status line's plain-text/no-box rule, replacing every remaining "chip row"/"Readout chip"
  wording).
- [X] T145 [US1] Restyle `src/renderer/features/chat/readout/ReadoutChip.tsx` to plain text, no
  box (decision 1): drops `badgeVariants` entirely; a read-only Readout is now `inline-flex` text
  with an icon, no border or fill; an interactive one (`onActivate`/`href`) adds only
  `rounded-md hover:bg-muted hover:text-foreground`, still no border. The seven `ReadoutChips.tsx`
  components and `ComposerStatusLine.tsx` need no changes themselves -- they only call this
  shared baseline, which now renders the new look under them unchanged.
- [X] T146 [US1] Reorder and relabel `src/renderer/lib/modelDisplay.ts`'s `THINKING_LEVEL_LABEL`/
  `THINKING_LEVELS` for decision 4: `inherit` now reads "Default" (was "Inherit"), and the
  declared order is `inherit, off, minimal, low, medium, high, xhigh, max` (was `off, inherit,
  ...`), Default first. `formatThinkingLevelLabel` (used by both `MessageInput.tsx`'s Reasoning
  picker and `SessionDetailsCard.tsx`'s tooltip) picks up the new label automatically since both
  read the same map.
- [X] T147 [US1] Add a solid NEUTRAL `invert` Button variant (decision 5):
  `src/renderer/components/ui/button.tsx` gains `invert: "bg-foreground text-background
  hover:bg-foreground"` (no opacity-modified hover, per the token rules) alongside the existing
  variants; `MessageInput.tsx`'s Stop button switches from `variant="default"` to
  `variant="invert"`, and Send switches from `variant="outline"` to `variant="default"` (Send
  "keeps the accent fill" per the decision's own wording, which only makes sense if Send already
  has one), with the surrounding comment rewritten for both.
- [X] T148 [US1] Give the Model and Reasoning pickers a stopped-agent disabled state (decision 3):
  `ComposerPickers.tsx`'s `usePickerDisabled` (renamed from the single-purpose `useNotIdle`) now
  returns `{ disabled, notIdle, stopped }`; `disabled = notIdle || stopped` gates `aria-disabled`
  and the controlled `onOpenChange` refusal for both pickers, each with its own accessible-name
  reason ("Available once the session is idle." vs "Start the agent to change the
  model/reasoning level."); a disabled picker's `onOpenChange` never calls
  `setModel`/`setThinkingLevel`/`applyRole`, so nothing is stored for the next start.
- [X] T149 [US1] Rebuild the Model picker's own menu (decision 6): a type-to-filter `Input` at the
  top of `DropdownMenuContent` (Radix's `DropdownMenu.Content` has no public `onOpenAutoFocus`
  unlike Dialog/AlertDialog, so a `useEffect` keyed on `open` focuses the field instead, winning
  the race against Radix's own default first-item focus), a **Roles** `DropdownMenuLabel` group
  first built from `model.listRoles(sessionId)` (fetched on open) with each role's own raw
  selector looked up against the already-loaded catalog for a friendly name, selecting one calls
  `model.applyRole`; then a **Models** group, the catalog filtered by the typed text
  (case-insensitive substring over `provider`/`name`), current one ticked, capped to
  `max-h-96 overflow-y-auto` (roughly 12 rows) rather than growing unbounded for the 91-entry chat
  catalog.
- [X] T150 [US1] Update the docs and verify: re-ran `pnpm typecheck` (clean), `pnpm
  check:file-size` (0 violations, unchanged from T142), `pnpm check:indent` (0 odd-indent lines),
  `pnpm check:theme-contrast` (all 313 pairs still pass -- the new `invert` button variant and the
  restyled `ReadoutChip` are not in `scripts/check-theme-contrast.mjs`'s own pair list, so this
  confirms no EXISTING pair regressed, not a new check for either). Rebuilt `pnpm tauri build
  --debug --no-bundle` and re-ran the scratch live check (screenshots and exact results recorded
  in the PR body, not retrofitted into this task).

**Gate round 1 fixes (same day, same session, after T137-T150 above landed and PR #877 went up for
review)**: code-reviewer, accessibility-auditor (1 Critical, 2 High), test-reviewer and
security-auditor all reviewed the PR; code/accessibility/tests came back FAIL. T151-T159 below fix
every finding, amended by Stuart on one point (T155's read-back semantics). `/speckit.implement`
was run against this phase per that round, task by task, each `[X]` citing the actual code on this
branch at the time it was marked.

- [X] T151 [US1] Merge `origin/main` (R13, commit `da2856a`: delete the Electron build) into this
  branch, resolving two conflicts (`docs/PLAN.md`, `docs/design/product-layout.md` -- combined,
  never a one-sided discard). `shared/ipc.ts`'s `RefractApi.model` becomes non-optional (Electron,
  the only other possible implementation, never ported this family and no longer exists at all),
  removing the dangling-`!`-assertion risk the Low finding flagged. `pnpm install --frozen-lockfile`
  (Electron/koffi packages removed); `pnpm test` drops from 376 to 148 passing tests, matching R13's
  own removal of every Electron main/preload test suite, not a regression.
- [X] T152 [US1] Rebuild the Model picker (`ComposerPickers.tsx`) as a `Popover` holding a
  type-to-filter combobox `Input` (`role="combobox"`, focus via the popover's own public
  `onOpenAutoFocus`, no timers) plus a hand-built `role="listbox"` driven by
  `aria-activedescendant` -- the same pattern `SlashMenu.tsx`/`MessageInput.tsx` already use:
  ArrowUp/Down move the active option, Enter applies it, Escape closes the popover. Fixes
  test-reviewer/code-reviewer HIGH: Radix `DropdownMenu.Content`'s own typeahead moved focus off
  the filter field to the first matching item on every keystroke, and blocked Tab/ArrowDown for
  anything but the content element itself, so the filter was unusable from the keyboard. Two
  `role="group"`/`aria-labelledby` sections (Roles, Models); the current role/model is
  `aria-selected` plus a visible tick; the listbox scrolls once past about 12 rows, capped further
  by the popover's own `max-h-[min(24rem,var(--radix-popover-content-available-height))]` so the
  filter field never scrolls off a short viewport.
- [X] T153 [US1] Fix the picker menu close-trap (code-reviewer HIGH): a shared
  `usePickerOpenState(disabled)` hook (`ComposerPickers.tsx`) used by both pickers blocks only an
  attempt to OPEN while disabled (`if (next && disabled) return`) and force-closes an already-open
  menu via its own effect the instant `disabled` becomes true -- previously `onOpenChange` returned
  early for `next === false` too, so Escape, an outside click, and selecting an item were all
  swallowed once the Session's status flipped while a menu sat open.
- [X] T154 [US1] Reasoning picker: `DropdownMenuRadioGroup`/`DropdownMenuRadioItem` (new,
  `dropdown-menu.tsx`, Radix's own `RadioGroup`/`RadioItem`/`ItemIndicator`) bound to the Session's
  `lastThinkingLevel`, replacing a plain `DropdownMenuItem` with a decorative `aria-hidden`
  `CheckIcon`. Fixes code-reviewer HIGH: Radix exposes the checked item as `aria-checked`/
  `role="menuitemradio"` automatically, so a screen reader now hears which level is current.
- [X] T155 [US1] `thinking_level.rs`: validate `level` against the closed 8-value `ThinkingLevel`
  set before sending anything to OMP, refusing an unknown value with `invalid-argument` (closes
  security-auditor Low; mirrors `model::apply_role`'s own `known_role_list()` check). Fix the
  false-error read-back (code-reviewer HIGH, AMENDED by Stuart mid-round, superseding the review's
  own suggested "map every missing level to Default"): OMP's `get_state` leaves `thinkingLevel` out
  of its response both for `inherit` and for any OTHER level a non-reasoning model was asked for --
  previously ANY missing read-back after a successful switch raised a `prompt-failed` error the
  user saw as a failed change that had in fact succeeded. Now: a requested `inherit` always
  resolves to `"inherit"` (patched directly into the registry via `SessionAgent::registry()`/
  `events()`, since `refresh_from_state`'s own generic `sync_from_state` has no "just requested"
  context and would otherwise leave it `None`); any OTHER requested level the model does not
  report resolves to `None` or `null` over the wire, read by the renderer as "Not reported by this
  model" (`modelDisplay.ts`'s `formatThinkingLevelLabel`, now `Pick<Session, 'lastModel' |
  'lastThinkingLevel'>` so it can tell "never known" from "known model, unreported level"). Neither
  branch ever raises an error. Contract: `ipc-model.ts`'s `setThinkingLevel` returns `{
  thinkingLevel: string | null }` (was `string`); `contracts/ipc.md` and spec 001's FR-064 updated
  to match. The transcript notice now reads "Reasoning switched to <UI label>." (was "Thinking
  level switched to <raw OMP string>."), matching the picker's own wording. `REQUEST_TIMEOUT_MS`
  shared from `model.rs` (now `pub(super)`) instead of re-declared a third time (security-auditor
  Low).
- [X] T156 [US1] Send's own `--send`/`--send-foreground` token pair (gate round 1, Stuart): a new
  per-theme pair in `globals.css` for all three built-in themes (Obsidian reuses its own `#5A5EEE`
  `--primary` verbatim; Dark and Dark high contrast get a lifted `#6D71F0`, since `--primary`
  resolves to a near-white neutral in both, nearly identical to Stop's `invert` fill there, failing
  "visibly distinct in weight" in 2 of 3 themes), mapped into the `@theme inline` layer and applied
  ONLY to the composer's Send button (`MessageInput.tsx`), overriding `variant="default"`'s shared
  `--primary` fill -- every other `default`-variant button elsewhere is unaffected. Two new pairs
  in `scripts/check-theme-contrast.mjs` (icon-on-fill and fill-vs-composer-background, both at the
  3:1 icon-without-text floor, `docs/design/accessibility.md`): computed and verified at 3.08:1 to
  6.47:1 across all three themes, comfortably clearing the floor. Stop's `SquareIcon` gets
  `fill-current` (was read by a reviewer as "an outlined square" on a solid fill) and `invert`
  gains a real `hover:bg-foreground/85` (was identical to its resting fill, no hover feedback at
  all). `docs/design/components.md`'s Button table documents the new `invert` row and the
  composer's both-filled exception.
- [X] T157 [US1] Remaining code-reviewer/test-reviewer MEDIUM and LOW findings: friendly model/role
  names drop `font-code` (not code-shaped data; mono kept only for a raw `provider/id` fallback,
  `modelDisplay.ts`/`ComposerPickers.tsx`); the current-model tick now compares identity (`provider`
  + `id`) instead of the display label, which missed a Session whose `lastModel.name` is absent and
  double-ticked entries sharing a name; a new shared `attachImageFile` (`attachments.ts`) replaces a
  duplicated validate-plus-commit block between the Attach button and a pasted image's own paste
  handler; `ReadoutChip.tsx`'s interactive variant gets an opaque `focus-visible:outline-2
  focus-visible:outline-offset-2 focus-visible:outline-ring` (the plain-text restyle in T145 had
  dropped `badgeVariants`' own ring entirely, leaving only the browser default); the picker
  triggers' own `PICKER_TRIGGER_CLASS` gets the same opaque ring, overriding `badgeVariants`' `/50`
  alpha ring (below the WCAG 1.4.11 3:1 floor); the Attach button's hidden file input uses `hidden`
  (was `sr-only` + `tabIndex={-1}`, so a screen reader's browse mode landed on a stray do-nothing
  control) and its Tooltip gets `aria-describedby={undefined}` (its content purely repeated the
  button's own accessible name). A full-label `title` attribute on both picker triggers substitutes
  for a Tooltip there (avoiding an unproven nested Tooltip-inside-Popover/DropdownMenu-trigger
  composition with no precedent elsewhere in this codebase) so a long truncated model name is still
  readable by a sighted user.
- [X] T158 [US1] A right- or middle-click on a Model picker option applied the selection the same
  as a primary click (`onMouseDown`'s own `preventDefault()` keeps focus in the filter field but
  does not filter by button) -- found live by Stuart during round 1 verification. Both the Roles
  and Models option handlers now return early unless `event.button === 0`.
- [X] T159 [US1] Update the docs and verify: spec 001's Clarifications gain five gate round 1
  entries, FR-064 and FR-065 rewritten in place for the combobox/listbox rebuild, the close-on-
  disable fix, the radio-group Reasoning picker, the null/"Not reported" read-back semantics and
  the `--send` token, US1 acceptance scenario 11 updated to match, three new Edge Cases bullets
  (close-on-disable, the null read-back, the right/middle-click guard); `contracts/ipc.md`'s
  `setThinkingLevel` row and its Electron-optional note updated; `quickstart.md` step 9 rewritten
  for the new picker interaction. `docs/design/product-chat.md`'s Message box bullet and
  `docs/design/components.md`'s Button table updated to match. `tasks.md` T142's own "no Rust files
  touched by this story" claim (repeated twice) corrected -- never actually true even when written,
  since this story's own earlier commit `1871f9b` had already added Rust code before that
  verification pass ran; "T144-T151" corrected to "T144-T150" (the phase has 7 tasks, not 8).
  Re-ran `pnpm typecheck` (clean), `cargo check` (clean, 4m14s cold build after the shared cache
  was cleared), `pnpm check:indent` (0 odd-indent), `pnpm check:file-size` (0 violations across 305
  files -- `model.rs`, `check-theme-contrast.mjs` and `ipc.ts` each needed their own new comments
  trimmed back to stay within their existing baselines), `pnpm check:ui-text` (0 leaks),
  `pnpm check:theme-contrast` (319 of 319 pairs across 3 themes, up from 313), `pnpm test` (148 of
  148, the post-R13 count). The full `ci-local.mjs` run, the scratch live-check re-run exercising
  every fixed behaviour with real CDP keyboard/mouse input, and screenshots are recorded in the PR
  body, not retrofitted into this task.

**Gate round 2 fixes (same day, same session, after T151-T159 above landed and PR #877 went up for
a second review)**: code-reviewer FAIL (1 High), accessibility-auditor FAIL (1 High), test-reviewer
and security-auditor PASS. T160-T168 below fix every finding, amended TWICE by Stuart on the same
point (T160's own read-back semantics, corrected mid-round).

- [X] T160 [US1] Fix Default-persistence (code-reviewer HIGH): `sync_from_state` (launch.rs) now
  only writes `last_thinking_level` when `thinkingLevel` is ACTUALLY REPORTED by `get_state` --
  previously it wrote `None` unconditionally whenever absent, which erased
  `thinking_level::set_thinking_level`'s own explicit "inherit" write on the very next settle or
  app relaunch. `thinking_level.rs` is now the ONLY place that writes the field when absent, and
  always writes something explicit: `Some("inherit")` for a Default request (so it survives), or
  an explicit `None` for any other unconfirmed request (clearing any stale previously-confirmed
  level). **Corrected TWICE by Stuart mid-round** (an initial attempt at this same fix wrongly
  showed "Default" for any Session with no stored level at all): a Session where nothing was ever
  explicitly requested, and one where a non-Default request was not confirmed, BOTH read as
  "Reasoning not reported" (`modelDisplay.ts`, renamed from round 1's "Not reported by this
  model") -- "Default" is shown ONLY for the literal persisted `"inherit"`.
- [X] T161 [US1] Fix the keyboard-active option's contrast (accessibility-auditor HIGH): `bg-accent`
  alone measured under 1.3:1 in every theme. `pickerShared.tsx`'s new `PICKER_OPTION_CLASS`/
  `PICKER_OPTION_ACTIVE_CLASS` add an opaque `border-l-active-indicator` left border when active,
  matching `SlashMenu.tsx`'s own pattern exactly, used by both the Roles and Models options.
- [X] T162 [US1] Fix Enter-applies-the-wrong-option after typing (accessibility-auditor MEDIUM):
  the active index stayed at 0 (the first Role, never filtered) regardless of what was typed.
  `ModelPicker.tsx` now resets the active index to the first MATCHING MODEL whenever the filter
  is non-empty.
- [X] T163 [US1] Fix pointer-cancellation (accessibility-auditor MEDIUM, WCAG 2.5.2): selecting an
  option ran on `onMouseDown` (the press), so sliding off before releasing could not cancel it.
  `preventDefault()` (keeps focus in the filter field) stays on `onMouseDown`; the actual select-
  and-close now runs on `onClick`, which only fires for a completed primary-button press-and-
  release on the same element (a right- or middle-click never fires it at all).
- [X] T164 [US1] Name the Model popover (accessibility-auditor MEDIUM, WCAG 4.1.2):
  `aria-label="Choose model"` on `PopoverContent` -- Radix gives it `role="dialog"` with no label
  of its own.
- [X] T165 [US1] Fix Tab leaving the popover open (accessibility-auditor LOW, WCAG 2.4.3): Tab in
  the filter field now closes the popover and returns focus to the trigger, instead of leaving
  this non-modal popover open and carrying focus to whatever follows its portal in the DOM.
- [X] T166 [US1] Fix the invalid double-`aria-selected` listbox (accessibility-auditor LOW): the
  current Role and the current Model could both carry `aria-selected="true"` at once. The current
  Role is now sr-only "(current)" text plus its visible tick; `aria-selected` belongs to the
  Models group alone. `rolesError` moved from a bare `<p>` inside the listbox (not an allowed
  child) to a disabled `role="option"`, matching `catalogError`'s own pattern.
- [X] T167 [US1] Remaining LOW findings: the visible Reasoning label "Reasoning not reported" (was
  "Not reported by this model", lacked the word "Reasoning" for a sighted user); the
  `tauri-bridge/index.ts` `setThinkingLevel` return type corrected to `string | null` (was
  `string`, silently widened); `attachImageFile` moved to its own module, `attachImage.ts` (closes
  an import cycle between `attachments.ts` and `state/draft-store.ts`, harmless only because
  `@/state` happened to load first); `ModelPicker` moved to its own file, `ModelPicker.tsx`
  (`ComposerPickers.tsx` had grown to 427 lines/three components); both pickers' disabled reason
  is now ALSO a visible `Tooltip`, with `aria-describedby={undefined}` on the trigger so the
  tooltip's content (which always repeats something already in the accessible name) is never
  announced twice; two opacity-modifier hovers (`hover:bg-send/80`, `hover:bg-foreground/85`,
  both introduced in gate round 1) replaced with the `color-mix` pattern `button.tsx`'s
  `secondary` variant already uses, per the design rules' own "never a Tailwind opacity modifier
  on a token class".
- [X] T168 [US1] Update the docs and verify: spec 001 gains a gate round 2 Clarification (the
  persistence fix, Stuart's correction recorded verbatim), FR-064 rewritten in place for the
  persistence guarantee, the active-row contrast, Tab, pointer-cancellation, the popover name, the
  single-`aria-selected` rule, and the visible disabled Tooltip; three Edge Cases bullets updated
  or added. `docs/design/product-chat.md`, `quickstart.md`, `contracts/ipc.md`, and
  `src/shared/ipc-model.ts`'s own doc comment all get the "Reasoning not reported" rename.
  Re-ran `pnpm typecheck` (clean), `pnpm check:indent` (0 odd-indent), `pnpm check:file-size` (0
  violations -- `launch.rs` needed its own new `if let` block trimmed to net-zero growth against
  its exact 600-line baseline), `pnpm check:parity` (97/97, 23/23). The full `ci-local.mjs` run,
  the scratch live-check proving Default's persistence through both a settle and a full app
  relaunch, the keyboard-active row, and the fresh/unconfirmed "Reasoning not reported" states
  with real CDP input, and screenshots, are recorded in the PR body, not retrofitted into this
  task.
- [X] T169 [US1] Composer-dimming fix (Stuart, 2026-10-15, reviewing PR #877, FR-065): removed the
  message box's own per-field grey background/opacity on the disabled text area (the vendored
  `Textarea` component's `disabled:bg-input/50 disabled:opacity-50 dark:disabled:bg-input/80`
  overridden to `disabled:bg-transparent disabled:opacity-100 dark:disabled:bg-transparent`) and
  replaced it with one container `opacity-60` on the whole box (`MessageInput.tsx`'s own
  `disabled` flag), covering the text field and its bottom row together. The Attach button's own
  `aria-disabled:opacity-50` (identical condition, `disabled` passed straight through) is dropped
  entirely; the Model and Reasoning pickers now take a `boxDimmed` prop (`disabled` from
  MessageInput, the SAME boolean, passed down rather than re-derived) and suppress their own
  `aria-disabled:opacity-50` only while it is true, keeping it for their independent `notIdle`
  (mid-turn) disable reason, which the box never dims for. Re-deriving `boxDimmed` locally in
  each picker from `usePickerDisabled`'s own `stopped`/a new `stopReason` read was tried first and
  reverted: `useSessionsStore`'s `SessionSummary.stopReason` and the `SessionRuntimeView`-based
  `stopReason` prop `ChatPane` feeds `MessageInput` are two genuinely different, independently
  computed values (confirmed live: after a relaunch the former read `"not-started"` while the
  latter's absence is exactly what makes `MessageInput`'s own `disabled` true) -- passing the one
  authoritative value down as a prop avoids relying on two sources staying in sync.
- [X] T170 [US1] Update the docs and verify: spec 001 gains a 2026-10-15 Clarification (the
  grey-background-to-single-opacity decision, the no-double-dimming rule, the behaviour-unchanged
  guarantee) and FR-065 is amended with the same box-dimming requirement. `pnpm typecheck`
  (`tsconfig.node.json` + `tsconfig.web.json`, clean), `pnpm test` (148/148), `pnpm check:indent`
  (0 odd-indent), `pnpm check:ui-text` (0 leaks/371 files, run after `pnpm tauri build --debug
  --no-bundle`) all pass; no Rust touched, so `ci-local.mjs` was not re-run in full. A scratch
  live check (isolated `REFRACT_DATA_DIR`/`WEBVIEW2_USER_DATA_FOLDER`/`OMP_PROFILE`, a scratch git
  repo, driven through the real UI, across a relaunch to reach the genuine "stopped, agent not
  yet restarted" state a plain `sessions.stopAgent` call does NOT reproduce -- confirmed live that
  call alone leaves `stopReason: 'not-started'`, keeping the composer enabled) proves, with real
  computed styles read via CDP: the enabled composer has no box opacity and no textarea disabled
  styling; the disabled composer's box reads `opacity: 0.6` with the `opacity-60` class present,
  the textarea has no background/opacity of its own and shows the `"The agent is stopped."`
  placeholder; the Attach, Model and Reasoning triggers all read `opacity: 1` (no second dim).
  Screenshots `8-stopped-dimmed.png` and `9-enabled.png` (Dark, the app's own default theme) are
  recorded in the PR body alongside the exact pass/fail lines, not retrofitted into this task.
- [X] T171 [US1] Gate round 4 fix (Stuart, 2026-10-15, reviewing PR #877, FR-065): the Approval
  mode pill stays BRIGHT while the composer is disabled -- it still works while the agent is
  stopped (FR-056), unlike the Model/Reasoning pickers, which are correctly disabled then, so
  dimming it would misrepresent it as unusable. `MessageInput.tsx`'s own box-level `opacity-60`
  is removed from the outer container (its border/background never dim again) and moved onto
  the field block div (`relative flex items-end`, covering the textarea and Send/Stop together).
  `ModelPicker.tsx`/`ComposerPickers.tsx`'s `ReasoningPicker`/`AttachButton` each now apply the
  SAME `opacity-60` value directly (`boxDimmed && 'aria-disabled:opacity-60'` for the pickers,
  `disabled && 'opacity-60'` for Attach) instead of suppressing their own opacity to 100%, since
  the box no longer provides one shared dim for the whole bottom row -- the stopped-agent reason
  and the independent mid-turn `notIdle` reason still never compound into a different-looking
  dim, matching FR-065's existing no-double-dimming rule. The Approval pill itself
  (`ApprovalModePill.tsx`) is untouched by any of this and was never wrapped in a dimming
  container.
- [X] T172 [US1] Gate round 4 fix (same round, WCAG 1.4.11): the Approval pill's own focus
  indicator gets the same opaque `focus-visible:outline-ring` convention the Model/Reasoning
  picker triggers already use (gate round 1, `PICKER_TRIGGER_CLASS`), dropping `badgeVariants`'
  own translucent `ring-ring/50` (`focus-visible:ring-0 focus-visible:outline-2
  focus-visible:outline-offset-2 focus-visible:outline-ring`). Two new `check-theme-contrast.mjs`
  pairs close a pre-existing gap neither had before (`ring`/`composer-background` and
  `border`/`composer-background`, the pill's resting edge and its new focus outline against the
  specific surface it sits on, never checked against `--composer-background` before, only
  against `--background`/`--popover`/`--muted`) -- measured 4.37 to 15.42:1 (ring) and 4.45 to
  5.27:1 (border) across all three built-in themes, all above the 3:1 floor in both states.
  `scripts/check-theme-contrast.mjs`'s own file-size ratchet violation (935 lines, over its
  923-line baseline -- the ratchet is lower-only, #806) was fixed not by raising the baseline
  but by extracting its `PAIRS` array (plus the comment block explaining it) into a new
  `scripts/theme-contrast-pairs.mjs` module, a pure-data, behaviour-preserving move: the script
  now imports `PAIRS` from there and iterates it exactly as before, dropping to 791 lines (under
  its UNCHANGED 923 baseline); `scripts/file-size-baseline.json` is byte-identical to `main`.

  Verified: `pnpm typecheck` (clean), `pnpm test` (148/148, unchanged), `pnpm check:indent` (0
  odd-indent), `pnpm check:file-size` (0 violations/312 files, baseline unchanged from main),
  `node scripts/check-theme-contrast.mjs` (all 325 pairs across 3 themes PASS, unchanged from
  before the extraction -- confirming the move changed no behaviour), `pnpm check:parity`
  (97/97, 23/23), `pnpm check:drag-regions` (0 violations/115 files). No Rust touched, so the
  full `cargo`/`ci-local.mjs` suite was not re-run; the Tauri debug build WAS rebuilt (renderer-
  only changes still need a fresh bundle) to drive the live check below.

  Live-checked on an isolated scratch Tauri instance (fresh `REFRACT_DATA_DIR`/
  `WEBVIEW2_USER_DATA_FOLDER`/`OMP_PROFILE`, a scratch git repo, driven through the real UI,
  across a relaunch to reach the genuine "stopped, agent not yet restarted" state, same pattern
  T170 used): **12/12 checks pass**, every one a real computed style or real keyboard-dispatched
  focus read via CDP, not a screenshot guess -- the pill's own `opacity` reads `1` in BOTH the
  enabled state (launch 1) and the disabled/stopped state (after the relaunch), while the field
  block, Model picker, Reasoning picker, and Attach button all read `opacity: 0.6` in the stopped
  state, and the box's own container reads `opacity: 1` throughout (never dims); real Tab
  navigation (dispatched key events, never a scripted `.focus()`) reached the pill's trigger and
  its `:focus-visible` state shows a real `2px solid` opaque outline (`outlineColor:
  oklch(0.556 0 0)`, not `rgba(0, 0, 0, 0)`), confirming the ring-to-outline swap actually took
  effect, not just typechecked. Screenshots `11-pill-keyboard-focused.png` (enabled state, the
  pill's new outline visible) and `10-stopped-pill-bright.png` (stopped state, the pill visibly
  brighter than the dimmed Model/Reasoning pickers beside it) recorded in the PR body; the
  throwaway driver script and its scratch dir/profile were deleted after use.

- [X] T173 [US1] Gate round 5 fix 1 (Layout/Flow/Visual Medium, `agent://Arch877`): an empty
  status line (`ComposerStatusLine.tsx`) now collapses via `empty:hidden` (a flex container with
  no React children has no DOM children either, so `:empty` matches), instead of leaving a
  lopsided gap above and below it from the parent's own `gap-2`.
- [X] T174 [US1] Gate round 5 fix 2 (spec 004 FR-007): `ReadoutChips.tsx`'s `SubagentsChip`
  emphasis flipped from the no-op `running === 0 ? 'text-muted-foreground' : undefined` to
  `running > 0 ? 'text-foreground' : undefined` -- `ReadoutChip.tsx`'s own base class already
  carries `text-muted-foreground`, so neither branch of the old condition ever differed from the
  resting state.
- [X] T175 [US1] Gate round 5 fix 3 (Layout/Flow/Visual Medium): `ModelPicker.tsx`'s VISIBLE
  trigger text and list rows now show the model's bare `name` only (was `provider/name`, cut at
  160px with about 400px of unused row) -- `provider/name` (`formatModelLabel`) moves to the
  Tooltip and stays parenthetically in the accessible name; the trigger gains `max-w-72` (was a
  40-character inner-span cap) and the list rows show the provider as muted secondary text.
- [X] T176 [US1] Gate round 5 fix 4 (Visual Medium, FR-065): one shared composer focus treatment
  (`pickerShared.tsx`'s `COMPOSER_FOCUS_CLASS`/`COMPOSER_BUTTON_FOCUS_CLASS`) replaces the mix of
  `ring`/`outline`/`border-colour` the Approval pill, both pickers, Attach, Send, and Stop each
  drew independently across gate rounds 1 and 4; `MessageInput.tsx`'s own box `focus-within` ring
  is now scoped to `has-[textarea:focus-visible]` (was any descendant focus), so a focused
  bottom-row control is never shown with two different focus indicators stacked.
- [X] T177 [US1] Gate round 5 fix 5 (Layout Medium): `ModelPicker.tsx` hides its Roles group
  entirely once the filter is non-empty (decision 8's "Roles first" only ever meant the
  untouched, no-filter state); the keyboard-reachable flat-index range generalised from a
  contiguous range to a sparse `activatableIndices` array so hidden-while-filtering roles (and
  no-fallback roles, T179) are skipped by Arrow keys without needing a reachable-but-inert state.
- [X] T178 [US1] Gate round 5 fix 6 (Layout Medium, [INFERENCE]): the Model popover's height is
  now FIXED while open (`h-[min(24rem,...)]`, was `max-h-[min(24rem,...)]`) -- the listbox,
  already `flex-1 overflow-y-auto`, absorbs a changing result count instead of the whole popover
  (and the filter field inside it) visibly resizing as the match count changes.
- [X] T179 [US1] Gate round 5 fix 7 and 10 (Flow Medium): the catalog's three real states --
  loading (`catalog === undefined`), loaded-but-empty (`catalog.length === 0`), and
  filtered-to-no-match (`filteredCatalog.length === 0`) -- now render distinct text, a
  `Loader2Icon` on the loading row (was one "Loading models…" string covering both "not loaded"
  and "loaded, empty"). A role whose own configured model is `null` AND has no documented
  fallback is `aria-disabled` and excluded from `activatableIndices` (T177); one that DOES have a
  fallback reuses Settings' own wording (`ROLE_FALLBACK_LABEL`, exported from
  `ModelRolesSection.tsx`) plus `smol`/`slow`'s own `model_support.rs` fallback to `default`
  (`ROLE_NO_MODEL_FALLBACK`, merging both sources).
- [X] T180 [US1] Gate round 5 fix 8 (Flow Medium): a cached `catalogError` now forces
  `loadCatalog('chat', true)` on every open (was an unforced call that returned early while an
  error was cached, so a transient failure stayed failed forever), and the error row gains an
  explicit Retry button independent of reopening the popover.
- [X] T181 [US1] Gate round 5 fix 9 (Flow Medium): both pickers now hold a local `pendingLabel`
  for the duration of `setModel`/`applyRole`/`setThinkingLevel` -- `aria-busy`, the requested
  value shown with a `Loader2Icon`, and `usePickerOpenState`'s own `disabled` folds in
  `pendingLabel !== null` so the trigger cannot be reopened mid-request; a failure still raises
  its existing toast (unchanged), and the pending state clears in a `finally` block regardless of
  outcome.
- [X] T182 [US1] Gate round 5 fix 11a (Visual Medium): `dropdown-menu.tsx`'s active-row inset
  shadow (`DropdownMenuItem`/`DropdownMenuRadioItem`, the Approval pill's and the Reasoning
  picker's own shared menus) now uses `--active-indicator` (was `--ring`), matching the Model
  picker's own active-row convention; `DropdownMenuRadioItem`'s current-level check moves from a
  LEADING `absolute left-2` indicator to a TRAILING one, matching the Model picker's and the
  Approval pill's own trailing checks (the only consumer of this vendored component in the app
  today, so the change is scoped to exactly the one menu that needed it). A new
  `active-indicator`/`popover` contrast pair (`scripts/theme-contrast-pairs.mjs`) measures the
  inset shadow's own real surface, never checked before.
- [X] T183 [US1] Gate round 5 fix 11b (Flow Medium, WCAG 2.5.3): every composer control's
  accessible name now STARTS with its own visible text (`docs/design/accessibility.md:16`) --
  the Model/Reasoning pickers' "Model: .../Reasoning: ..." prefixes and the Approval pill's
  "Approval mode: ..." prefix are gone; the Model picker's full `provider/name` and the Reasoning
  noun both move to a parenthetical/Tooltip instead, so neither surface loses the detail.

**LOW fixes in the same round**: `MessageInput.tsx`'s bottom row gains `pb-2 gap-2` (was
`pb-1 gap-1.5`), keeping the shared focus outline off the box's own bottom border;
`ModelPicker.tsx`'s catalog rows drop `text-xs` (now inherit `PICKER_OPTION_CLASS`'s own
`text-sm`, matching the role rows); the active index now starts on the CURRENT model when the
picker opens (scrolled into view by the existing effect) rather than always the first role;
`pickerShared.tsx`'s `COMPOSER_DISABLED_CLASS` is one shared `opacity-60` (was 0.5 the badge
default, 0.6 the gate round 4 override) plus an `aria-disabled:hover:*` reset so a disabled
trigger no longer shows hover feedback; `ComposerPickers.tsx`'s `AttachButton` now names its own
disabled reason ("Start the agent to attach images.", was "Attach images" unconditionally); the
Context usage Readout's `high` threshold tests the rounded, displayed percent (spec 004 FR-003,
`ReadoutChips.tsx`); `SessionDetailsCard.tsx`'s diff line gains the same `sr-only` full-figure
pairing the status line's `ChangesChip` already has (`formatDiffStatAccessible`, extracted to
`sessionDisplay.tsx` so both surfaces share one function); `thinking_level.rs`'s not-confirmed
notice now names the REQUESTED level ("High (not reported back by this model)", was "a level
this model did not report back", naming nothing); `MessageInput.tsx`'s disabled placeholder text
gains `disabled:placeholder:text-foreground` (the field block's own 0.6 dim left the base
`placeholder:text-muted-foreground` around 3.4:1, too low to read the stop reason it carries);
`ApprovalModePill.tsx:1-6`'s header comment corrected (no longer says "the chip row directly
above the message box", stale since #564 moved the pill into the box); `docs/design/
product-chat.md`'s Message box line documents the scoped dim, the bright pill, and the shared
focus outline.

**Verified**: `pnpm typecheck` (clean), `pnpm test` (148/148, unchanged), `pnpm check:indent`
(0 odd-indent), the full `node scripts/ci-local.mjs` (all 16 steps, including `cargo
test`/`clippy`/`fmt --check` and the Tauri debug build) pass end to end -- one `cargo fmt --check`
fix needed along the way (a `format!` call's own line-wrapping, applied with `cargo fmt`, no
behaviour change). `node scripts/check-theme-contrast.mjs` (all 328 pairs across 3 themes PASS,
up from 325 after the new `active-indicator`/`popover` pair). `pnpm check:file-size` (0
violations/312 files, baseline unchanged from `main` -- `MessageInput.tsx` briefly grew 12 lines
past its own 1,632-line baseline from this round's comments; trimmed back to exactly 1,632 by
tightening three comment blocks, no code removed).

Live-checked on an isolated scratch Tauri instance (fresh `REFRACT_DATA_DIR`/
`WEBVIEW2_USER_DATA_FOLDER`/`OMP_PROFILE`, a scratch git repo, driven through the real UI): a
first attempt and a second attempt both hit a STALE debug binary (a prior `pnpm tauri build
--debug --no-bundle` inside the same `ci-local.mjs` run had not actually re-embedded the fresh
frontend bundle into the Rust binary -- confirmed by grepping the built JS for `has-[textarea`,
present in `out/tauri-web` but the launched app's own computed styles still showed the OLD
`focus-within` box ring); a `touch src-tauri/src/main.rs` plus a fresh, standalone `pnpm tauri
build --debug --no-bundle` forced a real re-embed, confirmed by the SAME computed-style read
before re-running the live check. **15/15 checks pass** (one earlier assertion, that the
Settings-only `tiny` role would show "Inherited (Smol)", was itself wrong: this picker's own
`model.listRoles` scopes to OMP's `cycleOrder` + "plan", which excludes `tiny` on this profile's
default `cycleOrder` -- not a product bug, corrected and re-run): the status line collapses to a
real `display: none` once nothing is meaningful; `smol` (unset, no entry in Settings' own
fallback map) reads "Inherited (Default)" via `model_support.rs`'s own fallback; `plan` (unset,
no fallback anywhere) is `aria-disabled`; the popover's own height measures byte-identical before
and after typing an 11-character filter that empties the result set; the Roles group's DOM node
disappears entirely while filtering and reappears once cleared; filtering to zero catalog matches
shows "No models match."; selecting the one seeded model is confirmed via `Session.lastModel`;
the trigger then shows the bare name "Probe Fake Model" with `(probe-fake)` in the accessible
name; all four composer controls tested (the Approval pill, the Model trigger, the Reasoning
trigger, Attach) show a real, non-zero, opaque `2px solid` `:focus-visible` outline via real
Tab-dispatched keyboard navigation. An unplanned but useful observation: the Model trigger's own
aria-label was STILL `"...(probe-fake). Applying…"` when re-checked, confirming the pending state
(T181) persists for a real, non-trivial duration against the unreachable provider rather than
flashing and clearing before it could be observed -- direct evidence the fix addresses the
finding's own stated concern ("the trigger shows the old value for up to 60s"), not just a quick
flash. **Not exercised**: `tiny`/`memory`/`advisor`'s own Settings-map wording (see above, a
harness/cycleOrder scoping gap, not a product gap); a genuinely simulated catalog load error
(T180's force-reload and Retry path) -- `modelRoles.listCatalog` goes through the real `omp`
CLI, which this harness has no way to make fail on demand without a deeper fixture change, so
this is recorded as not independently driven live, per the same honest-gaps convention every
earlier round in this PR has used. Screenshots `1-model-picker-roles-inherited.png` (the Roles
group showing both fallback wordings and the disabled `plan` row, the Models group showing the
provider as muted secondary text) and `3-attach-focused-shared-outline.png` (Attach focused with
the shared opaque outline, the Context usage Readout's own "high" warning and the Changes
Readout's populated figure both visible as a bonus confirmation) in
`C:/Users/shopwood/AppData/Local/Temp/refract-564-gate5-shots/`; the throwaway driver script and
every scratch dir/profile (across all seven iterations needed to find and fix the test's own
selector bugs and the stale-binary issue) were deleted after use.

- [X] T184 [US1] Gate round 6 fix 1 (Medium, `agent://G564Code`): `ModelPicker.tsx`'s empty
  trigger regressed to a lowercase, non-sentence-case `'not known yet'` fragment -- FR-064's
  exact wording, `?? 'Model not known yet'`, restored; the ", model" accessible-name suffix is
  now dropped when no model is known at all, since stacking it after "Model not known yet" read
  oddly ("Model not known yet, model").
- [X] T185 [US1] Gate round 6 fix 2 (Medium, `agent://Arch877`/`agent://G564Code`/
  `agent://G564A11y`): the catalog-error row is no longer a `<button>` nested inside
  `role="option"` (invalid, and unreachable by keyboard since Tab closes the popover) -- the row
  itself IS the option now, included in `activatableIndices`, Enter- and click-activatable, with
  a local `retrying` flag (`Loader2Icon` + "Retrying…" + `aria-disabled`, the same pattern
  `ModelRolesSection.tsx`'s own catalog retry uses) and never closing the popover on activation.
  The listbox container also gets its own `onMouseDown` preventDefault (covering the Retry row
  unmounting mid-click on success, plus the headings and empty area, none of which had one), and
  the error text now says reopening the menu also retries.
- [X] T186 [US1] Gate round 6 fix 3 (Medium, `agent://Arch877`): the Profile menu's Theme
  submenu drew its OWN permanent 2px indigo bar plus a 4px ring-coloured focus override on the
  active theme row -- once the shared `DropdownMenuItem` focus cue became the same indigo
  `--active-indicator` (gate round 5), arrowing onto a different theme showed two visually
  identical bars. Both removed; the trailing "Current" text is now the only current-theme marker,
  matching the composer's own convention. `DropdownMenuSubTrigger` also moved to
  `--active-indicator` (was `--color-ring`, the only other place still showing the old colour),
  and a destructive `DropdownMenuItem` (Sign out, Remove repository…) now draws its own
  `--color-destructive` inset shadow instead of the indigo bar landing on its red tint.
- [X] T187 [US1] Gate round 6 fix 4 (Medium, `agent://Arch877`): the Reasoning picker's
  accessible name and Tooltip doubled the word "Reasoning" whenever the trigger's own label
  already started with it ("Reasoning not reported, reasoning", "Reasoning: Reasoning not
  reported") -- the noun is now appended/prefixed only when the label does not already start
  with "Reasoning".
- [X] T188 [US1] Gate round 6 LOW fixes, Visual (`agent://Arch877`): Send and Stop's own
  container gap widened to `gap-2` (was `gap-1`) so the shared 2px focus outline never reaches
  into the other button's fill; Send now uses the shared `COMPOSER_DISABLED_CLASS` (opacity-60
  plus a hover reset) for its own non-`disabled` refusal reasons, instead of a one-off
  `aria-disabled:opacity-50` with no hover reset; `AttachButton` now imports
  `COMPOSER_DISABLED_CLASS` instead of duplicating its exact string; catalog rows' provider text
  is now `text-xs`, matching the Roles group's own secondary text size. Discovered live-checking
  this same fix: `ApprovalModePill.tsx` had its OWN duplicate of `pickerShared.tsx`'s trigger
  class (including its stale `gap-1.5`, missed when that shared class moved to `gap-2`, and
  confirmed via the live-build's own embedded JS bundle) -- now reads `PICKER_TRIGGER_CLASS`
  directly instead of a second copy, so the two can never drift apart again.
- [X] T189 [US1] Gate round 6 LOW fixes, Flow (`agent://Arch877`): the pending state now carries
  `{ label, provider? }` instead of a bare string -- a model pick's own provider shows
  immediately (never the stale previous model's), and a role pick's own id fills the same slot,
  so the pending parenthetical always names something concrete about what is resolving.
  `smol`/`slow`'s "Default" fallback wording moved INTO the shared `ROLE_FALLBACK_LABEL`
  (`ModelRolesSection.tsx`), so Settings and the picker can no longer drift apart; a role with
  neither a model nor a documented fallback (e.g. `plan`) now states that reason directly
  ("Inherited (no fallback)"), instead of a bare "Inherited" that never said why the row is
  `aria-disabled`.
- [X] T190 [US1] Gate round 6 LOW fixes, Layout (`agent://Arch877`): the scroll-to-active-option
  effect is deferred one animation frame, so it runs after the popover's own
  `--radix-popover-content-available-height` has settled rather than mid-layout; the popover's
  own height cap raised 24rem -> 30rem (24rem measured closer to 9 rows than decision 6's "~12
  rows" once the filter field and padding are accounted for); the `DropdownMenuRadioItem`
  comment correctly distinguishes its own far-edge trailing check from the Approval pill's
  different inline-after-label "Current" convention, rather than overclaiming they match.
- [X] T191 [US1] Gate round 6 fix (`agent://Arch877` Visual N7/N8): the stale "documented
  spacing-grid exception" comment removed (no such exception exists in
  `docs/design/foundations-typography-spacing.md`'s own 4px-grid rule, which lists `gap-1.5` as
  an explicit violation, not an exception) -- `pickerShared.tsx`'s `PICKER_TRIGGER_CLASS` moves
  `gap-1.5` to the on-grid `gap-2`; the stale "`focus-within` ring replacing the text area's own"
  wording corrected in `MessageInput.tsx`'s older composer-tone comment and
  `docs/design/product-chat.md`'s Message box bullet, both now pointing at the gate round 5
  textarea-scoped form instead of the pre-round-5 whole-box claim.
- [X] T192 [US1] Docs: spec 001's FR-064 gains the "bare `name` only" wording clarified (list
  rows ALSO show the provider as muted secondary text, never combined into one `provider/name`
  string -- only the trigger shows the bare name alone) plus a Gate round 6 amendments sentence;
  FR-065 gains a Gate round 6 fix sentence for the Send/Stop gap and shared disabled class.

**Verified**: `pnpm typecheck` (clean), `pnpm test` (148/148, unchanged), `pnpm check:indent`,
`pnpm check:file-size` (0 violations/313 files -- `ModelPicker.tsx`'s own Retry-row rebuild
pushed it to 647 lines, over the #806 600-line cap for the first time; the "Models" listbox
group extracted into a new `ModelCatalogGroup.tsx`, 139 lines, bringing `ModelPicker.tsx` back to
564), `node scripts/check-theme-contrast.mjs` (all 328 pairs across 3 themes PASS, including the
pre-existing `--active-indicator`/`--destructive` pairs, unaffected by a focus-shadow colour swap
on an already-measured token), and the full `node scripts/ci-local.mjs` (all 16 steps, including
`cargo test`/`clippy`/`fmt --check` and the Tauri debug build) -- two unrelated Windows-build
flakes along the way (a transient `link.exe`/`mt.exe` LNK1327 failure, and a
`STATUS_DLL_INIT_FAILED` on a build script under heavy concurrent rebuild load), both resolved by
a clean retry, plus one order-dependent pre-existing Rust test
(`git::remote::tests::repository_remote_returns_has_host_for_a_configured_remote`, untouched by
this round's files) that failed once inside the full suite but passed standalone and on a full
clean retry -- not this round's regression.

Live-checked on an isolated scratch Tauri instance (fresh `REFRACT_DATA_DIR`/
`WEBVIEW2_USER_DATA_FOLDER`, a scratch git repo, driven through the real UI): the first two
attempts hit the SAME stale-embedded-binary issue gate round 5 already found (the copied exe's
`ApprovalModePill` still read the pre-gate-5 "Approval mode: Ask" order from its own aria-label,
confirming via the built JS bundle itself that the source WAS current -- `cargo`'s own asset-
embedding did not pick up a content change tracked only by directory mtime); a `touch
src-tauri/src/main.rs` plus a fresh, standalone `pnpm tauri build --debug --no-bundle` forced a
real re-embed each time, confirmed by a fresh aria-label read before re-running. **6 of 8 checks
pass** on the third attempt: the Approval pill reads "Ask, approval mode" (gate round 5's order,
confirmed current); the Reasoning trigger reads "Medium, reasoning" (never doubled); Attach is
Tab-reachable with a real non-zero opaque `focus-visible` outline; the Send/Stop container
measures an 8px `gap-2`; the Profile menu's Theme submenu shows zero permanent
`.bg-active-indicator` bars (screenshot `6-theme-submenu-open.png` confirms only the "Theme" row
itself, the keyboard focus target, is highlighted, with "Dark \u2713 Current" the only current-theme
marker). **2 checks against this round's own test assumptions, not product code, failed and were
corrected**: this harness's "session" scenario reports a model (`Session.lastModel`) immediately
on creation, so the "Model not known yet" empty-trigger wording (T184) was not reachable in this
tape and is recorded as not independently driven live, the same kind of scoping gap earlier
rounds documented for other roles; the Retry path (T185/T190) also could not be exercised,
confirming gate round 5's own finding that this harness's model catalog call has no on-demand
failure mode (the scratch profile's own seeded config lists successfully every time). While
investigating the Approval pill wording, this live check also caught and fixed a real miss in
T188: `ApprovalModePill.tsx` had its own duplicate of the shared trigger class, including the
stale `gap-1.5` the `pickerShared.tsx` fix was supposed to cover everywhere. Screenshots:
`C:/Users/shopwood/AppData/Local/Temp/refract-564-gate6-shots/` --
`1-session-idle.png` (bottom row at rest: Ask, "Example Model One", Medium, Attach),
`2-model-popover-open.png`, `4-attach-focused.png` (the shared opaque focus outline),
`5-after-profile-attempt.png` and `6-theme-submenu-open.png` (the corrected Theme submenu). The
throwaway driver script and every scratch dir/profile (across all attempts, including the two
rebuild-only passes) were deleted after use.

- [X] T193 [US1] Gate round 7 fix 1 (Medium, `agent://Arch877`/`agent://G564Code`): hovering a
  disabled Send button (its ordinary empty-draft resting state) dropped the indigo `--send` fill
  to transparent -- gate round 6's `!disabled && COMPOSER_DISABLED_CLASS` added a hover RESET
  (`aria-disabled:hover:bg-transparent`) meant for a control transparent at rest (the outline/
  ghost triggers), more specific than Send's own `hover:bg-[color-mix(...)]`. `pickerShared.tsx`
  now splits `COMPOSER_DISABLED_CLASS` into `COMPOSER_DISABLED_OPACITY_CLASS` (cursor plus
  opacity-60 alone) and `COMPOSER_DISABLED_HOVER_RESET_CLASS`; `COMPOSER_DISABLED_CLASS` stays
  the combined value for everything that was already transparent at rest. Send now takes
  `COMPOSER_DISABLED_OPACITY_CLASS` alone.
- [X] T194 [US1] Gate round 7 fix 2 (Medium, `agent://Arch877`): the Retry row's error text
  truncated to about 33 visible characters in the 288px popover, hiding any real diagnostic.
  `ModelCatalogGroup.tsx`'s error span moves from `truncate` to `whitespace-normal break-words`
  (row gains `items-start`); the stale "Reopening this menu also retries." hint is dropped
  (the row is itself directly Enter/click-activatable now, gate round 6); the row also gets its
  own `retryOptionId` (was `optionId(roleCount)`, reused by the first model row once the catalog
  loads, so a successful retry's `aria-activedescendant` could point at a stale id).
- [X] T195 [US1] Gate round 7 fix 3 (Medium, doc-only, `agent://Arch877`): the shared dropdown
  menu's own `--active-indicator` focus bar (gate round 5) narrows Stuart's 2026-10-04 "Active/
  selected indicator" rule, which had listed "a dropdown's checked option" as one of the surfaces
  that bar marks -- in a dropdown menu specifically, the bar now means keyboard focus ONLY, and
  a trailing check plus "Current" (or `aria-checked`) marks the current option instead, matching
  the composer's own pickers. Recorded as "Decided (Skippy, delegated by Stuart 2026-10-15)" in
  `docs/design/product-look-and-feel.md`'s own rule (every OTHER current/selected surface is
  unchanged), `docs/design/product-layout.md`'s Theme-submenu description, and
  `ProfileMenu.tsx`'s own `ThemeSubmenu` comment; posted as a comment on issue #564 for Stuart's
  own sign-off, since this narrows his rule rather than merely documenting new behaviour.
- [X] T196 [US1] Gate round 7 LOW fixes (`agent://Arch877`/`agent://G564Code`/`agent://G564A11y`):
  `handleCatalogRetry` wraps its `loadCatalog` call in `try`/`finally` (matching
  `handleSelectModel`/`handleSelectRole`'s own guard) so a future IPC rejection can never leave
  `retrying` stuck true; the open effect's automatic retry-on-reopen now calls
  `handleCatalogRetry()` directly instead of `loadCatalog` bare, so it shows the SAME
  "Retrying…" feedback a manual retry does; the scroll-to-active-option effect's deps gain
  `open` (a reopen whose active index happened to equal the previous open's never re-ran it,
  leaving the list scrolled to the top); an empty-string model `name` now falls through to `id`
  (`name?.trim() || id`, `modelDisplay.ts`'s `formatModelLabel` and `ModelPicker.tsx`'s own
  `modelNameOnly`, was `name ?? id`, which kept a blank trigger for an empty but non-null name);
  `AttachButton` gains `dark:aria-disabled:hover:bg-transparent` (the vendored `ghost` Button
  variant's own `dark:hover:bg-muted/50` tied the shared reset's specificity in Dark/Dark-HC);
  the Roles group shows a "Loading roles…" row (matching the Models group's own loading-state
  convention) while `listRoles` is still pending, instead of a heading with nothing under it.
  PR body leftovers corrected: the stale `max-h-96` wording in the gaps list (now describes the
  current `h-[min(30rem,...)]` popover), and gate round 6's undescribed `5-after-profile-
  attempt.png` screenshot now has a caption.

**Verified**: `pnpm typecheck` (clean), `pnpm test` (148/148, unchanged), `pnpm check:indent`,
`pnpm check:file-size` (0 violations/313 files, `MessageInput.tsx` held at exactly its 1632-line
baseline), `node scripts/check-theme-contrast.mjs` (all 328 pairs across 3 themes PASS), and the
full `node scripts/ci-local.mjs` (all 16 steps). The Rust side needed several retries this round:
a now-familiar transient `link.exe`/`mt.exe` `LNK1327` failure recurred three times in a row
(unusually persistent, not the usual one-off flake); investigating turned up that the linker was
referencing a STALE absolute path to a DIFFERENT worktree's own `windows-app-manifest.xml`
(`...\refract-811-main-worktree\...`, a sibling lane's own checkout building the SAME crate
concurrently against this machine's SAME shared `CARGO_TARGET_DIR`) -- a build-script fingerprint
collision between two checkouts of identical crate name/version/profile sharing one target
directory, not a defect in this PR's own code. A `touch src-tauri/build.rs src-tauri/src/main.rs`
forced a fresh, uncached build-script run and resolved it; a subsequent attempt also hit a
"blocking waiting for file lock"/"failed to run cargo metadata" stall from the SAME concurrent
lane actually holding the shared target directory's lock at that moment, resolved by waiting it
out and retrying (`timeout: 0`) rather than by any code change.

Live-checked on an isolated scratch Tauri instance (fresh `REFRACT_DATA_DIR`/
`WEBVIEW2_USER_DATA_FOLDER`, a scratch git repo, driven through the real UI, the freshly-built
exe from the same `ci-local.mjs` run copied out before testing): **4 of 4 checks pass**:
- Hovering the disabled Send button with an empty draft reads a real, non-transparent
  `backgroundColor` (`oklch(0.541066 0.158793 290.277)`, the `--send` token, at `opacity: 0.6`)
  via `getComputedStyle` -- confirmed the fix, not just the absence of a visible regression;
  screenshot `2-send-hovered-empty-draft.png` shows the filled indigo circle under the cursor.
- The Roles group now shows "Loading roles…" instead of an empty heading (confirmed in the
  popover rows dump, though the probe's own model/role catalog resolved before a screenshot could
  catch the loading state visibly).
- The Profile menu's Theme submenu genuinely expands (confirmed by its own rows -- "Dark",
  "Dark (high contrast)", "Obsidian", "Appearance settings…" -- appearing in the DOM, not just a
  vacuous zero-count after a premature screenshot the first attempt took): all ten rows read
  `hasPermanentBar: false`, and screenshot `4-theme-submenu-open.png` shows "Dark ✓ Current" with
  no indigo bar on it, only on the still-keyboard-focused "Theme" trigger row itself.
- **Not exercised**: the Retry row's own wrapping (T194) -- this harness's model catalog call
  still resolves successfully every time against the scratch profile's own seeded config, the
  same finding gate rounds 5 and 6 already recorded; no on-demand way to force a catalog error
  exists in this harness.

Screenshots: `C:/Users/shopwood/AppData/Local/Temp/refract-564-gate7-shots/` --
`1-session-idle.png`, `2-send-hovered-empty-draft.png` (the key Medium-1 evidence),
`4-theme-submenu-open.png` (the key Medium-3 evidence). The throwaway driver script and every
scratch dir/profile (across every attempt) were deleted after use.
## Phase 38: Convergence
- [X] T197 [US1] Issue #811 (chore, moves only, no FR change): split `src/renderer/features/sessions/SessionList.tsx` (1393 lines) along the seams named in the #731/#735/#567 decision records, ahead of those three stories. No markup, class, text or behaviour change; every export/import path updated, nothing else. New file map: `SessionRow.tsx` (the row component; was lines 45-868) calls a new `useSessionRowActions.ts` hook (archive, restore, delete, resume, rename state and handlers, and the focus-after-removal fallback chain -- extracted so the row component itself only renders, required to bring `SessionRow.tsx` under the 600-line cap since the row alone was 824 lines); `GroupHeader.tsx` (`GroupHeaderTrigger` and `GROUP_HEADER_ACTIONS_OFFSET_PX`, both now exported for cross-file use, was 870-964); `RepositoryGroup.tsx` (was 966-1252); `ArchivedGroup.tsx` (was 1254-1294); `SessionList.tsx` keeps only the list shell, the Pull requests entry and Add repository (107 lines). `scripts/file-size-baseline.json`'s `SessionList.tsx` entry removed (17 -> 16 entries, `check:file-size --update`, lower/remove-only); every new file is at or under 600 lines (`useSessionRowActions.ts` 578, `SessionRow.tsx` 314, `RepositoryGroup.tsx` 313, `GroupHeader.tsx` 102, `ArchivedGroup.tsx` 48, `SessionList.tsx` 108).
- [X] T198 [US1] Update the docs: `docs/PLAN.md`'s Session list row records PR for #811 and the quiet window for #731/#735/#567.

This phase was written retroactively after the implementation above (no prior `/speckit.plan`/`/speckit.tasks` pass covered issue #811; the pickup was delegated via the issue's own "Decided (Skippy...)" comment, 2026-10-15). `pnpm typecheck` (both tsconfigs, 0 errors), `pnpm check:indent` (0 odd-indent lines across 266 files), `pnpm check:file-size` (0 cap violations, baseline 17 -> 16 entries), and the existing `pnpm vitest` suite (148 pass, no new tests added per AGENTS.md's prototyping rule) all ran clean after the split. Verified in full via `node scripts/ci-local.mjs`: all 16/16 steps passed with no fixes needed (typecheck, vitest, indent, theme contrast, drag regions, IPC parity, file size, version consistency, OMP schema drift x2, Rust formatting, Rust tests, Rust lint, the Tauri debug build, and `check:ui-text`, which needs the built bundle this run produced). `pnpm verify:tauri`'s existing fake-omp CDP harness also passed (US1 readiness, US4 session+chat). A scratch live CDP check (scratch `REFRACT_DATA_DIR`, `WEBVIEW2_USER_DATA_FOLDER`, `REFRACT_IMPORT_SOURCE_DIR`, a lowercase scratch `OMP_PROFILE`, two scratch Projects, a few Sessions incl. one archived; confirmed afterward that Stuart's real `registry.json` hash was unchanged and no scratch process was left running) exercised 11 scenarios with PASS: adding two repositories, the header "+" quick-create and branch-picker buttons each creating a session, opening a Session row, a Project group header expand/collapse, rename via the row menu, archive into the cross-repository Archived group, the Archived group's own expand/collapse, restore back out of it, and keyboard Tab order through the group header, its three action buttons, and the rows -- confirming the rendered DOM and interaction behaviour are unchanged from `origin/main` (default/Dark theme; no theme override was set in that pass). Gate round 1 (code-reviewer, test-reviewer, accessibility-auditor, UI-architect) found one HIGH (the issue's own before/after-screenshot acceptance criterion had been skipped), one MEDIUM (a scenario-count mismatch and missing theme labelling in the PR body) and comment-only Lows (stale cross-file "above"/"below" references after the split, and a dropped blank line) -- all fixed: a real before/after pixel-diff comparison was built (`origin/main` vs this branch, each a separate debug Tauri build, driven over trusted CDP through an identical state sequence on both Dark and Dark high-contrast, 16 screenshots, 8 pairs diffed with `pixelmatch`, 0.14%-0.24% differing pixels per pair, every differing pixel traced to the test harness's own randomly-generated session/branch names, not a real difference -- verdict identical); the scenario count corrected to 11/11; the comment references repointed to their new files; a known trade-off (the hook's 33-binding interface) recorded as an issue comment for #731/#735/#567 to narrow later. Full results, per-scenario detail and screenshot references: PR #901's body.

## Phase 39: Convergence

(Renumbered from Phase 37/T137-T143, then Phase 38/T173-T179: PR #877 landed first and claimed
Phase 37/T137-T196 on `main`; PR #901 landed next and claimed Phase 38/T197-T198. Renumbered again
per the gate's own instruction to renumber after whichever PR merges first.)

- [X] T199 [US2] Task 0 probe (#572): `docs/spike/ask-dialog-probe.mjs` (new, following `probe-batch-18.8.0.mjs`'s OmpProc pattern) sent `set_ask_dialog{enabled:true}` then forced the model to call `ask` with a two-question batch (single-choice with `recommended`, multi-select) against the real signed-in `omp 18.10.1`: the `extension_ui_request` with `method:"ask"` arrived live, field-for-field the documented shape, and the `extension_ui_response` round trip (`{answers:[...]}`) completed the tool call correctly (`docs/spike/FINDINGS.md` item 59). Confirms the structured-dialog path (D1-D17), not the fallback-only path (D18-D20).
- [X] T200 [US2] `requests.rs`'s `classify_dialog` gains the `"ask"` method (new `PendingRequest::Ask{questions, deadline_at}`, new `AskQuestion`/`AskOption` structs in `types.rs`), with a `DialogClassification::Malformed` arm for a frame with no/empty `questions` or a question missing its `id` (answered `{cancelled:true}` directly by `frame.rs`'s handler plus an error notice, no card ever shown); `build_dialog_response`/`is_chat_answer` accept `{answers:[{id,selectedOptions,customInput?}]}`, and `build_dialog_response`'s `Ask` branch validates the renderer's own `answers` against the pending `PendingRequest::Ask` (count/order/id match, every label actually offered, single-choice cardinality, a `customInput` length cap) as defence in depth before forwarding it (gate round 1, Medium). `launch.rs` sends `{type:"set_ask_dialog",enabled:true}` once per process, right after reattach verification and before the Session goes idle (`launch_support.rs`'s new `send_set_ask_dialog`, now returning the resolved `enabled` bool instead of appending its own notice); the "can't show questions together" notice is appended by `launch.rs` itself AFTER the history merge, alongside `rebaseline_notice` (gate round 1, High: appending it before the merge, as the first pass did, meant `merge_from_history` silently dropped it on every launch where history fetch completed). `deadline_at` is computed from the frame's `timeout` treated as the milliseconds it already is (gate round 1, High: the first pass multiplied by 1000, treating it as seconds, making every deadline about 1000x too late).
- [X] T201 [US2] Shared contract: `src/shared/model.ts` (`PendingRequest` kind `ask`, new `AskQuestion`), `src/shared/ipc.ts` (`ChatAnswer`'s new `{answers}` member), `src/shared/frames.ts` (`ExtensionUiMethod`'s new `'ask'`, `ExtensionUiRequestFrame`'s `questions`/`timeout`, `ExtensionUiAnswer`'s `{answers}`) -- all three files were already over the 600-line file-size baseline, so the additions are written compactly (one-line interfaces/unions in places) to land at or under their existing baseline, never growing it (AGENTS.md god-file rule). `timeout`'s own doc comment corrected to milliseconds (gate round 1).
- [X] T202 [US2] Renderer: `src/renderer/features/chat/AskCard.tsx` (new) renders the structured dialog -- a tab row only for 2+ questions (Radix `Tabs`/`TabsContent` with a real `role="tabpanel"`, `h-auto w-full flex-wrap justify-start bg-transparent p-0`, `flex-none` triggers so the row genuinely wraps at narrow widths, a Tooltip instead of a native `title`, a forced-colours border on the active tab, a check mark plus sr-only ", answered" on a completed tab), single-choice `RadioGroup` (always controlled with a `''`/`'__other__'` sentinel, never `undefined`, and keyed by `question.id` so no state leaks between tabs -- gate round 1, High: an earlier uncontrolled fallback let a stale pick stay visually checked after typing into Other) with Other as a real `RadioGroupItem`, and multiple-choice `ui/checkbox.tsx` (`CheckboxItem`/`CheckboxIndicator`) rows whose Other box auto-ticks on the first non-empty keystroke (gate round 1, High: typed Other text used to be silently dropped unless the box was also clicked), each option row's description linked by `aria-describedby` rather than folded into the accessible name, a "Recommended" muted-text suffix with no parentheses (never preselected), an always-visible "Other" row with a free-text `Input`, a footer reading "Next" (moving to the NEXT incomplete question after the active one, wrapping, with the inline note shown only when the active question is the sole incomplete one, D13) until every question is complete and "Submit" once it is (never disabled; `aria-disabled`/"Submitting…" while sending, with the Other input left focusable via `readOnly` rather than `disabled`), and a static deadline line when `deadlineAt` is present. Focus management (D13/D17/D23, gate round 1, High): Next and the incomplete-question jump focus the new question's checked-or-first option; Submit/Cancel move focus to the resolved summary row; an externally driven resolution (an OMP `cancel`/timeout, which unmounts the card without an unmount this component itself controls) rescues focus into the Session's own chat pane via the existing `isFocusStranded`/`focusPaneContent` pattern, rather than leaving it on `<body>`.
- [X] T203 [US2] Fallback path (D18/D19, `RequestCard.tsx`'s `kind:'question'` `choice` branch): restyled to the dialog path's own row look (`bg-transparent`, `hover:bg-muted`, `min-h-9`), still a plain commit-on-click button with no indicator (a `select` takes one value, so Submit would double the #446 loop's clicks); Cancel changed from `ghost` to `outline` to match the dialog footer; a trailing `" (Recommended)"` OMP appends to an option's own label is now stripped from what is shown (replaced by the same muted ", Recommended" marker the dialog path uses) while the original label, suffix included, is still what gets sent back (gate round 1, High: the first pass left this fallback entirely unbuilt despite T141 here originally claiming otherwise -- corrected).
- [X] T204 [US2] Update the docs: amended `specs/001-core-session-workspace/spec.md` (new FR-066 for the dialog and its fallback, amended FR-018/FR-045/FR-054, two new acceptance scenarios under User Story 2, two new Edge Cases bullets, the `Question` Key Entity, a dated `### Session 2026-10-15` Clarifications entry; gate round 1: corrected "per app launch" to "per OMP process launch" in FR-066/scenario 9/the Clarifications entry, matching D20's own wording and `launch_support.rs`'s actual once-per-process scope; gate round 2 merge: renumbered from FR-064 to FR-066, since #564/#877 claimed FR-064/FR-065 first on `main`), `data-model.md` (`PendingRequest` kind `ask`, fixed the pre-existing drift in its `kind:'question'` shape against the real shared type while there; gate round 1: `timeout` corrected to milliseconds), `contracts/omp-usage.md` ("Start-up sequence" gains the `set_ask_dialog` step, "Dialogs" gains the `ask` row and the cancel-without-notice behaviour, "Commands Refract sends"/"Chat line wire shapes"/"Built from the above" updated for the batch `answers`/`results[]` shapes; gate round 1: `timeout` corrected to milliseconds), `quickstart.md` (Story 2 gains a dialog-and-fallback check), `CONTEXT.md` (Question card / Asked-user line / Recommended option glossary entries). `docs/PLAN.md`'s "Ask UI" row updated with the PR and, after gate round 1, the fix-round evidence.
- [X] T205 [US2] Gate round 1 verification: `node scripts/ci-local.mjs` (16/16) re-run clean after the fixes above. `pnpm verify:tauri` (US1/US4) re-confirmed. `scripts/verify-tauri-ask.mjs` re-run with `REFRACT_FAKE_OMP_DEBUG_LOG` enabled so the fake omp's own `RECV extension_ui_response` line proves the exact D4 wire payload Refract's `buildAnswers` actually sent (not just that the fixture's own scripted reply renders), quoted verbatim in the PR body; new screenshots recorded to `C:/Users/shopwood/AppData/Local/Temp/refract-572-gate1-shots/` covering the controlled-RadioGroup pick/Other/re-pick sequence, Next's focus move, and the resolved-card focus rescue. **Gate round 2 (same PR, before merge)**: D17 (focus after resolution) rewritten -- round 1's fix targeted a render branch `Transcript.tsx` swaps away before it can take effect, and React 19's passive-effect cleanup timing meant the rescue never fired either; replaced with a module-scoped `src/renderer/state/ask-focus-intent.ts`, consumed by `ResolvedRequestSummary`/`AskQuestionRow` via a `useLayoutEffect` handoff, with a `focusPaneContent` fallback -- plus several Medium/Low fixes (busyAction splits Submit/Cancel busy labels, a stale roving-tab-stop fix, the fallback's dark-theme leak, lost card spacing, a `RequestCard` hooks-order bug, 4096 `maxLength`). `node scripts/ci-local.mjs` (16/16), `pnpm verify:tauri` and `scripts/verify-tauri-ask.mjs` re-confirmed PASS, now also asserting `document.activeElement` lands on the "Asked user:" row right after Submit (not read from source); new screenshots in `C:/Users/shopwood/AppData/Local/Temp/refract-572-gate2-shots/`. **Gate round 3 (same PR, before merge)**: all three reviewers found the same stale-intent Medium (a resolved row's own re-arm, on unmount for any reason, left an unbounded intent in the module-level `Set`, ready to steal focus on an unrelated later mount) -- fixed by keying every intent `${sessionId}:${requestId}` (never the bare request id) and sharing one `markAskFocusPendingWithFallback` (mark, then a bounded one-frame claim-or-drop `requestAnimationFrame`) between `AskCard`'s own unmount handoff and `ResolvedRequestSummary`'s bridge re-arm; both consumers (`ResolvedRequestSummary`, `AskQuestionRow`) now claim-and-focus only inside a `useLayoutEffect` and only when `isFocusStranded(document.activeElement, null)`. The architect's own M-1 (the D17 target's focus ring suspected clipped by `MessageScrollerItem`'s `content-visibility:auto`) was proven NOT a clipping bug by a live keyboard check: `CollapsedLine`'s trigger outline changed from an outward `outline-offset-2` to an inset `outline-offset-[-2px]`, and a real keyboard Submit (Tab, Tab, Enter, not a mouse click, since Chromium suppresses `:focus-visible` after mouse-driven focus) now shows `matchesFocusVisible:true` and a visible 2px ring, confirmed both by a `getComputedStyle` diagnostic and a cropped close-up screenshot (the full-window screenshot alone was too small at under 30px tall to show a 2px ring by eye). `CollapsedLine` also gained an sr-only ", " separator before the meta slot (the accessible name no longer runs "...and 1 more Answered" together) and a `verify-tauri-ask.mjs` fix reading the REAL accessible name via CDP's `Accessibility.getPartialAXTree` (not `textContent`, which the round-2 script wrongly labelled "accessible name"), plus an element-identity focus assertion (not a substring match, which could have passed on the transcript viewport too). Also fixed: an `event.repeat` guard on Enter in Other; `docs/spike/FINDINGS.md`/`scripts/fixtures/omp-frames/README.md` provenance wording corrected (the probe's scratch dir is confirmed gone, not "left on disk"; the tape's `"multi":false` was never itself seen live); `spec.md`'s Clarifications entry corrected from "unchanged" to "restyled" for the fallback; `hintId` wired into the multi-choice group's `aria-describedby`; the copied exe's own SHA-256 now logged by `verify-tauri-ask.mjs` (a sibling lane's gate once found a stale embedded JS bundle this would have caught). `node scripts/ci-local.mjs` (16/16) and `scripts/verify-tauri-ask.mjs` re-confirmed PASS; new screenshots in `C:/Users/shopwood/AppData/Local/Temp/refract-572-gate3c-shots/`. **Gate round 4 (same PR, before merge)**: renumbered Phase 38/T173-T179 to Phase 39/T199-T205 after PR #901 landed and claimed Phase 38/T197-T198, per the gate's own renumber-on-landing rule; every cross-reference (PR body, `docs/PLAN.md`, this file's own task ids) fixed to match.

**Not exercised this phase** (stated plainly, not hidden): a live `ask` frame carrying a real, non-zero `timeout` (D16's deadline line is type-checked and renders from a given `deadlineAt`, but no live frame has ever shown one); the fallback path on a build where `set_ask_dialog` is genuinely unavailable (every OMP available to test is past the 18.4.7 minimum that introduced the command); `pnpm check:theme-contrast`'s 4.5:1 `foreground`/`background` pair stands in for a literal by-hand pixel measurement of the Obsidian checked glyph and the Dark (high contrast) card edge; a 320px forced-colours/OS-reduced-motion pass of the whole card (the wrap/forced-colours fixes were made and are inherited from shared primitives/tested classes, but not independently screenshotted at that exact viewport); keyboard-only, start-to-finish operation of the whole card end to end (gate round 3 adds a real keyboard Tab/Tab/Enter for the final Submit step specifically, to prove the D17 focus ring, not as a stand-in for full keyboard coverage of picking options, Next, or Cancel); focus specifically after Cancel or an OMP cancel/timeout (only Submit's own path was driven live; Cancel and an OMP cancel share the exact same code path, not a separately exercised one); the single-question card with no tab row; Next or the incomplete-note jump; the "Answered automatically"/"None selected"/"Question not answered" summary statuses and an OMP `cancel` with no "Request withdrawn" notice; auto-cancel of a malformed frame; picks surviving a Session switch (D27); a live `details.results[]`/`timedOut` shape; the Rust rejection paths in `validate_ask_answers`; the central picks-store clear in `init-stores.ts` beyond the happy-path Submit it is incidentally exercised by; a dark-theme screenshot of the restyled fallback card.

This phase was written retroactively after the implementation above, in the same session that built it (no prior `/speckit.plan`/`/speckit.tasks` pass covered this issue; the ui-architect-v3 roundtable decision comment on #572, posted 2026-10-15, recorded the scope before the PR, per Stuart's standing delegation to make UI decisions while away), then corrected in place after the five-reviewer gate's round 1 found four High and several Medium defects, round 2 found one shared High (D17) and several Medium/Low defects, round 3 found one shared Medium (a stale focus intent) plus a live-check-only-provable concern over the D17 target's focus ring (confirmed NOT clipped), and round 4 renumbered this phase and its tasks after PR #901 claimed the Phase 38 slot -- see the PR's own gate-round-1/2/3/4 commits for the exact diffs. `pnpm typecheck` (both tsconfigs), `node scripts/ci-local.mjs` (all 16 steps, including `cargo fmt`/`cargo clippy -D warnings`/`cargo test`), `pnpm check:ui-text`, `pnpm check:theme-contrast`, `pnpm check:file-size`, `pnpm verify:tauri` (US1/US4) and `node scripts/verify-tauri-ask.mjs` all ran clean after every round's fixes; the Ask card itself was live-checked end to end over CDP with real DOM input against the scratch Tauri debug build before and after each gate round, including a `document.activeElement` focus assertion added in round 2 and a real keyboard Tab/Tab/Enter Submit plus a `getComputedStyle`/close-up-screenshot focus-ring proof added in round 3, screenshots recorded in the PR body.

## Phase 40: Convergence

(Renumbered from Phase 39/T199-T206: PR #900 (#572) merged into `main` first and claimed Phase
39/T199-T205, per Main's own merge instruction.)

- [X] T206 [US5] Issue #731 (ui-architect-v3 roundtable, delegated by Stuart 2026-10-15): amend
  spec 001 for the new derived **Unread response** display status -- FR-005, FR-006, the
  Independent Test and Acceptance Scenario 4 wording, the Key Entities Session note, and a
  `### Session 2026-10-15` Clarifications Q&A appended to the existing heading (shared with
  #564/#877). `CONTEXT.md` gains **Session status** and **Unread response**. Decision 20's three
  unread-behaviour gaps (window focus, restart persistence, front-pane visibility on
  Settings/Manage sessions/Pull requests) are filed as the one follow-up issue it asks for,
  **#904**, not fixed here.
- [X] T207 [US5] `sessionDisplay.tsx`: add `SessionDisplayStatus` (`SessionStatus |
  'unread-response'`) and `displayStatus()` (returns `'unread-response'` only when `status ===
  'idle' && unread`); key `STATUS_LABEL` and `StateIcon`'s `status` prop by it. `StateIcon`:
  idle becomes `CircleCheckIcon` (was the hollow `CircleIcon`; same grey, same glyph
  `SubagentPanel.tsx`'s "finished" icon already uses, #563), new `unread-response` case renders
  `MessageSquareTextIcon` in `text-state-unread-response`.
- [X] T208 [US5] `SessionRow.tsx`: the status icon slot and its `sr-only` word key off
  `displayStatus(session)`, not the raw `session.status`; the trailing amber unread dot and its
  `sr-only` "Unread" span are deleted (reverses #482 item 6), reserving no row width.
  `SessionDetailsCard.tsx` and `ManageSessionRow.tsx` (status column widened `6rem` to `8rem`)
  call `displayStatus(session)` the same way; `manageSessionsHelpers.ts`'s `STATUS_ORDER` is
  keyed by `SessionDisplayStatus` (needs-you 0, unread-response 1, working 2, idle 3, stopped
  4) and `filterAndSortSessions`'s status sort calls `displayStatus` on each side.
  `ChatHeader.tsx`/`closeChatPane.ts`/`StatusBar.tsx`/`Transcript.tsx` are left on the raw
  `session.status` (a Chat pane's own Session is always in the visible set, so Unread response
  there could only ever be a one-frame flash) -- type-only change, since `StateIcon`/
  `STATUS_LABEL` now accept the wider `SessionDisplayStatus` and a `SessionStatus` value is
  still a valid member of it.
- [X] T209 [US5] `globals.css`: add `--state-unread-response: var(--severity-info)` to
  `.theme-dark`, `.theme-obsidian` and `.theme-dark-high-contrast`, plus
  `--color-state-unread-response` in `@theme inline`; update the `.theme-dark` comment that used
  to say no session state means "info". `theme-contrast-pairs.mjs`: add `state-idle` and the new
  `state-unread-response` at a 3:1 floor against `sidebar`/`sidebar-accent`/`background`/
  `popover` in every theme (`state-idle` only had the `background` pair before).
- [X] T210 [US5] Design docs: `foundations-icons.md`, `patterns.md` and
  `product-look-and-feel.md`'s "Shared status icon" bullet describe the new idle/unread-response
  icons and the info role; `product-layout.md`'s session-list row description drops "and an
  unread dot". `docs/PLAN.md`'s Session status icons row records the PR and the shipped shape.
- [X] T211 [US5] Live verification (CDP, scratch Tauri debug instance, `session.jsonl`
  recorded-frame fake `omp`, three Sessions in one scratch repository): a #731-only DOM marker
  (`.text-state-unread-response`) is absent before any turn and present once Session A finishes
  a real approved turn while hidden (switched to Session B mid-stream, the real
  `App.tsx`/`mod.rs` visible-set rule, never a state poke); Session A's icon has the
  `<path>`-bearing `CircleCheckIcon` shape before the turn and the bell (`text-state-needs-you`)
  during the pending approval; Manage sessions renders "Unread response" with no truncation in
  the widened column; reopening Session A clears it back to Idle. A second instance (ellipsis
  menu only, never the HoverCard-wrapped open button) proved **Stopped** (`Stop agent`,
  `text-state-stopped`) on Dark and, after switching the real Theme submenu, on **Dark (high
  contrast)** too; DevTools vision-deficiency emulation (deuteranopia/protanopia/tritanopia) and
  `forced-colors: active` both keep the square (Stopped) and check-circle (Idle) glyphs visibly
  distinct by shape, confirmed in the forced-colours screenshot. `pnpm typecheck` (0 errors),
  `pnpm vitest` (148/148, no new tests), `node scripts/check-indent.mjs` (0 violations),
  `node scripts/check-file-size.mjs` (0 cap violations), `node scripts/check-theme-contrast.mjs`
  (every pair across all 3 themes PASS, including the new `state-unread-response`/`state-idle`
  sidebar pairs) and the full `node scripts/ci-local.mjs` (16/16 steps) all ran clean.
- [X] T212 [US5] Gate round 1 fixes (code-reviewer/a11y/architecture/tests, all PASS; three
  Medium findings, all addressed): `StateIcon`'s shared className gains
  `forced-colors:text-[CanvasText]` (sessionDisplay.tsx) -- an `<svg>` defaults to
  `forced-color-adjust: preserve-parent-color`, so each glyph's own `text-state-*` colour
  survived `forced-colors: active` instead of following CanvasText (the `AgentSpinner`/
  `radio-group.tsx` precedent); confirmed in the built CSS
  (`@media(forced-colors:active){...forced-colors\:text-\[CanvasText\]{color:canvastext}...}`).
  Decision 20's follow-up issue filed as **#904** (enhancement, session-list, p3, triaged),
  linked from the PR body, `docs/PLAN.md:223` and this file. The investigation record
  (decisions 10 and 21: screenshots by name and sha256, the 8 new contrast pairs) posted as an
  issue comment on #731, correcting decision 14's premise. `manageSessionsHelpers.ts:11-13` and
  `sessionDisplay.tsx:17-19`'s comments corrected (sort order vs. display precedence; "will read"
  not "read"); `CONTEXT.md`'s rejected term "response ready" removed from `product-layout.md`,
  `docs/PLAN.md` rows #735/#748; `product-look-and-feel.md:18` gains "Unread response (info)"
  in the State colour roles list; `product-layout.md`'s Manage sessions row corrected `6rem` to
  `8rem` to match the shipped column width.
- [X] T213 [US5] Gate round 2 live verification (two further scratch Tauri instances, exe hash
  asserted before each run): the precedence rule staged live (a Session already showing Unread
  response, stopped via its row menu without reopening it, shows Stopped -- decisions 5 and 14);
  an 11-Session list (idle x7, Needs-you left pending, Unread response, Stopped, a
  Working-attempt) at rest and hovered; a native CDP `clip`-region 1x-DPI crop of the bubble;
  High contrast with Stopped/Idle (an earlier window) plus vision-deficiency and forced-colours
  (pre-fix, the bug T212 fixes). **Blocked this round** by severe concurrent host contention on
  the shared build machine (4-5 sibling `cargo`/`rustc`/`link` processes confirmed via
  `Get-Process`, free memory down to about 3.5 of 16 GB, the scratch exe's own sha256 changing
  between consecutive copies, the app itself repeatedly failing to reach a stable
  session-attached state within 60s across six consecutive attempts): Obsidian with Needs-you
  and Unread response shown together, a post-fix live re-capture of vision-deficiency/
  forced-colours with Needs-you and Unread response visible, and a genuinely distinct "selected"
  capture (the one taken came out byte-identical to "at rest", a test-script gap, not a second
  real state -- flagged as such in the investigation record, not presented as two different
  proofs). All three filed to the verification backlog, **#650**, for a re-run once the shared
  machine is quieter.

This phase was written retroactively (the Spec Kit pickup was delegated via the issue's own
"Decided (Skippy...)" decision-record comment, 2026-10-15, produced by a `ui-architect-v3`
roundtable rather than a live grill, per Stuart's standing delegation while away). A WebView2 CDP
harness quirk ("Object reference chain is too long", `Runtime.evaluate`'s `returnByValue`
choking on a raw-element finder expression passed to `waitFor` instead of a boolean one) cost
several retries before being traced and fixed in round 1 of this story's own live checks. Opened
as draft PR #902 (`feat/731-session-status-icons`); kept **Refs #731**, not **Closes**, since
decision 21's live-verification list is not fully done (see T213's own blocked items, tracked in
#650) -- switch to Closes once that backlog item clears. Renumbered from Phase 39/T199-T206 to
Phase 40/T206-T213 on merging `origin/main` (PR #900/#572 claimed Phase 39/T199-T205 first), per
Main's own merge instruction; every cross-reference (PR body, `docs/PLAN.md`, the #731
investigation-record issue comment, the #650 backlog comment) updated to match.

## Phase 41: Convergence

(Renumbered from Phase 37/T137-T143: PR #877 (#564) landed first and claimed Phase 37/T137-T196
on `main`, then PR #901 (#811) claimed Phase 38/T197-T198, then PR #900 (#572) claimed Phase
39/T199-T205, then PR #902 (#731) claimed Phase 40/T206-T213; this story's own local T137-T143
numbering is renumbered here to the next free range on merge, per the gate's own established
renumber-on-landing rule every other phase in this file already follows. FRs are unaffected --
FR-067/FR-068 stay exactly as numbered.)

- [X] T214 [US1] Group consecutive `subagent` transcript items into one Stage per `task()` call (or calls issued together, FR-064) with a new pure `groupSubagentStages.ts` (run after `groupToolItems`, mirroring its own "always wrap, even a run of one" rule); render it as a new `StageGroupRow` and, for a turn with two or more Stages, a `SubagentChainRow` at the end of the turn above `TurnTotalLine` (FR-065), both in a new `SubagentChainRow.tsx`. `Transcript.tsx` wires `rowVisibility`/`isBookkeepingRow`/the sr-only running-announcement span for the new `StageGroup` kind (failed/exited/cancelled stays visible, running is screen-reader only, matching the existing lone-`subagent` rule); `TurnTotalLine`'s own `formatElapsed` moved to a new `formatElapsed.ts` so the new components can import it without a circular dependency back into `Transcript.tsx`.
- [X] T215 [US1] Shared subagent status vocabulary and connector: a new `subagentStatus.tsx` (`SubagentStatusIcon`/`SUBAGENT_STATUS_LABEL`/`chatRowStatus`/`summarizeSubagentStatuses`) extends the pre-#563 icon set with `cancelled`, reused by `SubagentRow` (`ToolRow.tsx`, updated to use it instead of the generic `toolStatus.tsx` `StatusIcon`), the new Stage/chain rows, and the Subagent panel (sibling slice). A new `SpineList.tsx` (steered in by Stuart mid-build, referencing issue #565 "guide rails") is the one shared 1px `border-divider` connector both the Stage group's member rows and the chain's own stage list use, so #565 can extend it later without touching this story's files.
- [X] T216 [US1] Split `cancelled`/`aborted` out of `failed` into its own status (decision 15) in both existing status pipelines: `src-tauri/src/session/subagents.rs`/`subagents_progress.rs` (the `SummaryStatus`/`SubagentSummary` readout and panel pipeline) and `src-tauri/src/omp/transcript.rs` (the chat row's own `SubagentStatus`, both its `map_progress_status` and its `apply_async_result_jobs` job-status path) -- net zero/minimal line growth to respect `transcript.rs`'s zero-headroom file-size baseline. `src/shared/model.ts`'s two status unions and `SessionReadout.subagentCount` gain `cancelled`; `ReadoutChips.tsx`'s `SubagentsChip` roll-up phrase reports it as its own word, never folded into "failed".
- [X] T217 [US1] Update the docs: amended this spec with FR-064/FR-065, a **Stage**/**Subagent chain** Key Entities pair, and a dated `### Session 2026-10-15` Clarifications section (the Stage-boundary inference, the `cancelled`-in-both-pipelines answer, the #712-scope-out answer, the `SpineList` steer, the agent-count-vs-Stage-count header rule, the chain-only click-to-open rule, and the panel-tree-root interpretation); amended spec 004's FR-007/FR-017/FR-019 and added FR-023 to FR-026 for the Subagent panel's tree/split/keyboard/Cancelled/focus-return (built by a sibling slice, same session); amended `CONTEXT.md` (**Stage**, **Subagent chain**, **Subagent panel**), `docs/design/product-chat.md` ("Grouped tool calls"/"Subagents" bullets) and `docs/design/product-layout.md` ("Subagent panel" bullet); `docs/PLAN.md`'s "UI refresh, second batch" row records #563 in progress with the branch and decision-record citation; `ChatDisplaySection.tsx`'s "Show tool calls" description names the subagent chain as an always-shown exception (decision 28).
- [X] T218 [US1] Live CDP check (`scripts/verify-563-subagent-stage.mjs`, new, committed per this story's own driver-script precedent): a scratch Tauri debug instance driven over CDP with real `Input.insertText`/`Input.dispatchMouseEvent`/`Input.dispatchKeyEvent`, using the pre-existing `scripts/fixtures/omp-frames/subagents.jsonl` fake-omp tape (one `task()` batch, two subagents) rather than adding a new fixture. Confirmed live: the Stage group header ("Stage 1  2 agents", no "·" separator -- corrected by the quality-gate's code review finding and T219 below, which adds the separator) renders for a single Stage with 2+ agents even though it is the turn's only Stage (decision 1); expanding it reveals the `SpineList` member rows (alpha, beta); the Subagent panel's tree opens, lists both agents with their durations, and roving-tabindex ArrowDown moves the shared 2px active-indicator selection from one row to the other. **Re-verified with a targeted selector** (`[data-panel-close]`, `PanelTabBar.tsx`): closing the panel leaves the chat pane completely unchanged (FR-019) and correctly returns focus to the Subagents chip (`subagent-store.ts`'s pre-#563 chip fallback, unchanged) -- an earlier run's "focus stranded" finding was a test-selector artifact (a broad "button with close in its aria-label" guess hit an unrelated control), not a real regression. **Readout-chip timing isolated**: the Subagents chip is briefly absent right after the panel opens (257ms, measured live) but is pre-existing, unrelated latency -- `readout.rs`'s `run_readout_update` (lines 401-431) bundles `subagentCount` with a concurrent `diff_stat`/branch read behind one 100ms debounce (line 66) gating the whole chip row; `git diff d6ef2ca -- src-tauri/src/session/readout.rs` is empty, and `ReadoutChips.tsx`'s `subagentCount === null` gate (line 189) is unchanged by this story. **Not exercised at all** (the fixture has only one Stage): the Subagent chain row, and the chain-entry "pre-select in panel + opener-based focus return" path end to end.

This phase was written retroactively after the implementation above, in the same session that built it (no prior `/speckit.plan`/`/speckit.tasks` pass covered issue #563; the issue's own final comment is the converged decision record, posted by delegated UX roundtable 2026-10-15). `node scripts/ci-local.mjs` (all 16 steps, `CARGO_TARGET_DIR`/`CARGO_INCREMENTAL=0`/`CARGO_BUILD_JOBS=4`): Install dependencies, Typecheck, Vitest, Check indentation, Check theme contrast, Check drag regions, Check IPC parity, Check file size, Check version consistency, Check OMP schema drift (plus its self-test), Rust formatting, Rust tests, Rust lint, Build (Tauri debug, no-bundle smoke), and Check UI text all PASS -- no new tests added per AGENTS.md's prototyping rule. `check:file-size` confirms `transcript.rs` (2083/2083) and `model.ts` (657/657) both land exactly on their existing baseline, never past it. **Live CDP check (T218) also run** -- see that task for the exact findings; screenshots at `C:/Users/shopwood/AppData/Local/Temp/refract-563-shots/` (`01` to `06`). A genuine cross-lane finding surfaced during the live check: the SHARED `CARGO_TARGET_DIR`'s `debug/refract-tauri.exe` was overwritten mid-session by a concurrent lane's own build, producing several false failures until a private, non-shared target dir was built for a trustworthy snapshot (removed afterward); Main broadcast a standing rule to every lane as a result (copy the built exe to a private scratch folder before every live check, verify it is yours, never a private `CARGO_TARGET_DIR`).

**Quality-gate remediation (round 4, 2026-10-15)**
- [X] T219 [US1] Fixed every Critical/High and the addressable Medium finding from the five-reviewer gate on PR #899 (code-reviewer FAIL 7 High, accessibility-auditor FAIL 3 High, test-reviewer FAIL 5 High, ui-architect-v3/its three specialists FAIL 1 Critical/5 High/16 Medium/9 Low; security-auditor PASS, unaffected): split `SubagentStatusGlyph` (icon, word always `sr-only`) out of `SubagentStatusIcon` so the visible status word no longer overflows `CollapsedLine`'s 14px icon slot (H1, every reviewer); gave `StageGroupRow` one stable `CollapsedLine` shape that never switches React element type as a second agent or Stage arrives, extracting `SubagentBody` out of `ToolRow.tsx`'s `SubagentRow` so the solo-of-turn case renders it directly with no nested `CollapsedLine` (H2/H3); corrected `SpineList`'s geometry to #565's binding recipe (`ml-4 border-l border-divider pt-1`, no `pl-2`) and added `aria-live="off"`; moved Stage boundary computation onto each turn's UNFILTERED `turn.items` (new `turnsWithStages` memo in `Transcript.tsx`) so grouping no longer depends on the "Show thinking" display toggle (H1/H4); moved the per-Stage settle announcement out of `role="log"` into a single out-of-log announcer (`useStageSettleAnnouncement.ts`, new, mirroring the existing `revealedAnnouncement` pattern) that reads every turn's unfiltered Stages so a Stage hidden by "Show tool calls" off still announces; added a `CollapsedLine` `action`/`triggerAriaLabel` contract so the chain's "Show subagents panel" button moved into the always-mounted header (not the collapsible body) at `icon-xs` (24px); fixed the Subagent panel's focus-on-open race (a new one-shot `focusRequestId` counter on `subagent-store.ts`, mirroring `sideChatFocusRequestId`, paired with `openHostedPanel` passing `{ focus: false }` to suppress `RightPaneShell`'s own generic content-focus effect) and the already-selected-agent no-op; propagated `opener` from the rail, launcher, and Readout chip (previously only the chain passed it); split `cancelled`-vs-crash in `finalize_live_transcript`/`finalize_live_items` (new `SubagentFinalizeCause` enum, `diff.rs`) so a user `stop()` settles a still-running subagent to `Cancelled` and a crash to `Exited`, never the old blanket `Error`; let a batch failure's own per-row `progress[i].status` win over the blanket `is_error` fallback in `apply_batch_task_result`. Removed the now-dead bare-`subagent`-kind code paths in `Transcript.tsx` (narrowed `StageGroupedItem` in `groupSubagentStages.ts` to exclude it, then used the resulting type errors as the removal checklist) and extracted `transcriptRowVisibility.ts`/`useStageSettleAnnouncement.ts` out of `Transcript.tsx` to keep it under its file-size baseline alongside the other changes. Re-ran `node scripts/ci-local.mjs` (same 16 steps as T218's own run) after a `cargo fmt` pass and manual line-budget trims to keep `transcript.rs` (2083/2083), `Transcript.tsx` (now 1110, under its 1179 baseline), and `check-theme-contrast.mjs` (923/923, two new contrast pairs for the Stage/chain status icons on `--muted`) at or under their existing baselines -- all 16 steps PASS, no new tests added per AGENTS.md's prototyping rule.

**Superseded by T220 below**: this round was code-verified only when written; T220 records the real-`omp` live verification requested by Main afterward, which DID confirm the chain row, Stage grouping, and the Show-thinking-toggle independence fix live.

- [X] T220 [US1] Real-`omp` live gate verification (Main's own follow-up request, same session): a NEW committed driver (`scripts/verify-563-subagent-gate1.mjs`) against REAL `omp` 18.10.1 (no fake, no PATH shim, no `OMP_PROFILE` override -- the ambient already-signed-in default profile, the established "a real model is needed" isolation posture `docs/spike/chat-lines-probe.mjs`/`get-subagents-probe.mjs` already use: scratch cwd/worktree/`REFRACT_DATA_DIR`, never Stuart's real Session list) and a real model (`github-copilot/claude-opus-5.5`), driving a scratch Session through three scenarios with deliberately tiny echo-only subagent prompts. **Confirmed live, clean run, screenshot `03-turn-a-chain-row.png`**: prompting the real model to call `task()` once with two subagents together (Uno, Dos) then `task()` again with one more (Tres) produced exactly "Subagents 2 stages, 3 agents" with "Stage 1" (Uno, Dos) and "Stage 2" (Tres) -- the chain row, Stage grouping, the quiet sr-only "Finished" icon (no visible word overlapping the name, H1), the header's action button, and the Spine geometry all render correctly against a genuine multi-Stage real-model turn, not just the one-Stage fake-omp fixture. **Confirmed live**: toggling "Show thinking" off and back on for that same settled turn left the Stage labels and chain summary byte-for-byte identical (the H1/H4 independence fix holds against a real multi-Stage turn). **Not independently confirmed this round** (see Not Exercised below for why): the chain-entry pre-select/focus/close-return round trip, and the Cancelled/Running status-word non-overlap layout proof -- both blocked first by two script-selector bugs (a false-positive "done"/"quattro" substring match against the user's OWN prompt text, and a case-sensitive `'tres'`/`'quattro'` compare where the real model capitalises subagent names as "Tres"/"Quattro"; both fixed, committed in the same script), then by this machine's own shared `CARGO_TARGET_DIR` being overwritten mid-session by a concurrent lane's own build (the same standing cross-lane collision this story's PR body already documented once before) -- confirmed by rebuilding fresh immediately before the one run that succeeded, and by the inconsistent pass/fail pattern across repeated identical runs afterward matching exactly that signature, not a flaky product behaviour. Screenshots and the raw per-run findings: `C:/Users/shopwood/AppData/Local/Temp/refract-563-gate1-shots/`. No new tests or fixtures added (AGENTS.md).

**Final live run (gate round 3 follow-up, 2026-10-15)**: the chain-entry failures above were a driver bug, not timing. The chain mounts expanded while running (decision 6), and the driver's "expand" click collapsed it. With the driver reading `aria-expanded` first, all four entry-path checks passed on real `omp`: Tres pre-selected in the panel, focus on its tree row, a keyboard ArrowUp showing a solid 2px ring, and closing the panel returning focus to the entry. The PR therefore says **Closes #563**. Cancelled-after-Stop stays deferred (M2, accepted).

## Phase 42: Convergence

(Renumbered from provisional Phase 43/T240-T245 to Phase 42/T221-T226 on confirming PR #905/#735
had not yet landed Phase 42/FR-069 on `origin/main` at renumber time, per the gate's own
renumber-on-landing rule.)

- [X] T221 [US1] `CollapsedLine.tsx`: icon slot widened 14px -> 16px (`size-4`, icon stays
  `size-3.5`, decision 7); the root `Collapsible`'s always-on `border border-transparent
  hover:border-border` and the `rounded-b-none` it drove deleted outright (decision 18, settles
  issue #430's nested-box bug) -- hover is now only the trigger's own ghost `hover:bg-muted`; the
  meta slot gained `tabular-nums` (decision 33). A new `LABEL_COLUMN_CONTENT_CLASS` ('pl-8')
  constant exported so the label-column body padding is defined once, not copied by hand.
- [X] T222 [US1] `ToolRow.tsx`: `ToolGroupRow`'s multi-call branch now renders onto `<SpineList
  gap="member">` (was a plain `space-y-1` div), each call wrapped in its own `<li>`; the outer
  `CollapsedLine`'s `contentClassName` is conditional (`LABEL_COLUMN_CONTENT_CLASS` for a solo
  call's body, a new `SPINE_HOST_CONTENT_CLASS` ('space-y-0 p-0', exported from `SpineList.tsx`)
  for the multi/SpineList branch, mirroring `StageGroupRow`'s existing pattern); each nested
  `ToolCallRow` and `SubagentRow` body now starts at the same label column (decision 10). A new
  member streaming into a RUNNING group fades in once, 150ms, mirroring `StageGroupRow`'s own
  seen-set (decision 26) -- #565 ships this on `ToolGroupRow` rather than leaving tool groups and
  Stages inconsistent. `NoticeRow.tsx`'s long-notice body moves `pl-7` -> the same constant.
- [X] T223 [US1] `scripts/theme-contrast-pairs.mjs`: added `destructive/muted` (4.5:1) and
  `state-needs-you/muted` (4.5:1) -- the two genuinely new hover-tint pairs decision 32 needed;
  `state-working/muted` and `ring/muted` were already gated at a stricter floor, so no redundant
  entry was added for either. `node scripts/check-theme-contrast.mjs`: 361/361 pairs PASS across
  all 3 themes. Docs updated: `CONTEXT.md` (new **Spine**/**Tool group** glossary entries, the
  **Stage**/**Subagent chain** entries noted as using Spine), `docs/design/product-chat.md`
  ("Grouped tool calls" and "Subagents" bullets), `docs/design/components.md` ("left rail" ->
  Spine), `docs/design/foundations-motion.md` (Spine never animates), `docs/design/
  accessibility.md` (new design-system checklist line). `specs/001-core-session-workspace/
  spec.md` amended: FR-008 and FR-047 each gained a Spine clause, plus a new "Session 2026-10-15
  (connected-log spine)" Clarifications section citing the decision record.
- [X] T224 [US1] Quality gate: code-reviewer, accessibility-auditor, security-auditor,
  test-reviewer and `ui-architect-v3` run as one parallel batch against the diff. No Critical or
  High finding in the product code from any reviewer. Findings fixed: stale comments describing
  the old `<div>`/`size-3.5`/border-0 shapes (`ToolRow.tsx`, `subagentStatus.tsx`,
  `SubagentChainRow.tsx`), the now-dead `border-0` overrides left by deleting the root border
  (`ToolRow.tsx`'s `SubagentRow`, `SubagentChainRow.tsx`'s Stage/chain rows -- the latter file is
  outside #565's own stated scope, touched only for this zero-behaviour-change cleanup, recorded
  here as the one explicit departure from the decision record's file list), two redundant
  contrast pairs and a wrong rationale comment in `theme-contrast-pairs.mjs`, and "Spine
  connector" wording simplified to "Spine" per the glossary's own `_Avoid_: connector` entry.
  `ui-architect-v3` could not spawn its own three specialists (no nested task tool in its
  sandbox) and reviewed the diff itself against the decision record directly instead; every
  in-scope decision (7-11, 13, 15, 17-21, 23, 30, 32, 33) confirmed matching the code.

**Known gap at handoff**: `scripts/verify-565-spine.mjs` (new, committed, a real-`omp` live CDP
driver per this story's own driver-script precedent) was reviewed by the quality gate before its
first full run completed, which caught three logic defects that would report a false failure (or
log false evidence) on a correct build: the Spine x-offset assertion expected 16px from the
header icon's edge instead of ~0px from its centre; the "group of one has no Spine" check never
re-collapsed turn (a)'s own group before turn (b), so it always saw a stray `<ol>`; and the
Dark/Obsidian/Dark-high-contrast screenshots called `window.refract.theme.preview(id)`, which
only moves the title-bar overlay colour (`theme-store.ts`'s own CRITICAL-remediation comment),
never the renderer's `<html>` class the CSS tokens actually key off. None of these are product
code; `pnpm typecheck` (0 errors) and the existing Vitest suite are otherwise unaffected (no new
tests, per AGENTS.md's prototyping rule). The script needs its theme-switch to drive the real
Profile-menu UI (click `[data-profile-name-button]`, the Theme submenu, the named preset) instead
of the bridge call, and the two check fixes above, before a run's exit code can be trusted as
live-check evidence; until then the PR says **Refs #565**, not **Closes**, and the full
`node scripts/ci-local.mjs` run and the real-`omp` live check itself are both owed as follow-up.

- [X] T225 [US1] Round-2 five-reviewer gate (G906) fixes: a G906Tests investigation found
  `verify-565-spine.mjs`'s two bash calls never merged into one `ToolGroup` because the default
  Approval mode ("Ask") makes each call wait for its own approval card, and `groupToolItems.ts`
  decision 14 treats a pending-approval call as its own grouping boundary -- not a Thinking-row
  interruption as first suspected. Driver rewritten to switch the scratch Session's own Approval
  mode to Auto through the real pill before the multi-call turn, assert the first header's 16px
  icon slot as the up-front #565 marker, keep a separate `failures` list that always fails the
  run (vs. `notExercised` for genuine skips only), toggle expand/collapse by reading
  `aria-expanded` rather than blind clicks, log `git rev-parse HEAD` beside the exe's sha256, and
  check a member row's own motion (not only the `<ol>`'s) under reduced motion. Product-code
  fixes from the same gate: the one-agent Stage's own solo body now gets
  `contentClassName={LABEL_COLUMN_CONTENT_CLASS}` (`SubagentChainRow.tsx`, matching `SubagentRow`
  -- it was still at the old `px-2` column); the three hand-copied `isNew ? 'motion-safe:...' :
  undefined` fade blocks (`ToolGroupRow`, `StageGroupRow`, the chain's own stage list) replaced by
  one exported `SpineItem` (`SpineList.tsx`) that captures `isNew` via `useState`'s lazy
  initializer ONCE per `<li>`'s mount -- the inline version recomputed `isNew` on every re-render,
  so a running row's own status tick could strip the fade class before its 150ms animation
  finished playing; the auto-approve poller (a security gate Medium from round 1) is now moot,
  removed entirely rather than hardened, since Auto mode means no approval card ever appears for
  either scripted turn. The Clarifications entry's "Only four surfaces get one" line corrected to
  include `#557`'s own future thought runs, per the decision record's own decision 13.
  `node scripts/ci-local.mjs`: 16/16 steps PASS after each round of fixes.

**Known gap at handoff (round 2)**: the rewritten driver's own `setApprovalMode` helper (click
the Approval pill, click "Auto" in its menu, wait for the pill's own `aria-label` to read "Auto,
approval mode") still does not reliably land -- the pill's `aria-label` never updated within the
10s timeout in the one post-fix run attempted. The selectors match the component's real markup by
inspection (`ApprovalModePill.tsx`); the live interaction itself (menu open, item click, or the
store round trip) was not debugged further given session time. Until it is, the multi-call Spine
geometry/`pl-8`/`role=list` assertions and the Dark/High-contrast screenshots of a genuine
multi-member group remain unexercised live; the product code itself is verified by three
independent reviewers' own geometry arithmetic plus the automated gates (typecheck, 361/361
contrast pairs, `ci-local` 16/16) and is unchanged by this gap. **Refs #565**, not **Closes**.

- [X] T226 [US1] Round-3 fix (Main's own diagnosis): `settings.setApprovalMode` only ever sets
  `pendingMode`, applied at a Session's NEXT settle (`contracts/ipc.md`) -- driving the real
  Approval pill before a Session had ever gone through a turn had nothing to settle, so the pill
  never actually updated. Fixed by seeding the scratch data dir's own `settings.json`
  (`{"version":1,"approvalMode":"auto"}`) BEFORE the Session is created, so `omp` launches
  already in Auto with no settle to wait for; a sanity assertion confirms the pill reads "Auto"
  before turn (a). **This worked**: the resulting run (screenshots `00`-`07` in the shots folder,
  `report.json`) confirmed LIVE, for the first time this story: the two bash calls merged into
  ONE multi-call `ToolGroup` (no approval-card grouping boundary); the up-front 16px icon-slot
  marker; the "1 failed" collapsed-summary text; the Spine line at 0.0px from the header icon's
  own centre (decision 8); the member icon 9px right of the line; the `pl-8` member body padding
  (decision 10); `role="list"` (decision 21); no root border (decision 18); the SpineList
  unmounting on collapse (decision 17); real Obsidian and Dark-high-contrast screenshots via the
  actual Profile-menu Theme submenu (decision 31, the H1 gate finding from round 1, now proven
  live); no horizontal scroll at 360px (decision 30); and `tabular-nums` on turn (b)'s own solo
  header duration (decision 33).
  That SAME run surfaced two more driver bugs, both now fixed and typechecked but NOT yet
  reconfirmed by a clean run (see below): (1) the reduced-motion check required a literal `0s`
  transition duration, but `globals.css`'s own documented `prefers-reduced-motion` block sets a
  0.01ms iteration, not a true 0 (`foundations-motion.md`) -- `getComputedStyle` reports that as
  `1e-05s`, which the check now accepts (`parseFloat(d) <= 0.001`) instead of only exact `'0s'`;
  (2) `setBashHeaderExpanded`'s own re-read used bracket indexing (`arr[-1]`), which is ALWAYS
  `undefined` in JS for a negative index (only `.at(-1)` resolves "last") -- turn (b)'s own solo
  group (addressed by index `-1`) could therefore never be confirmed expanded, timing out. Fixed
  to use `.at()` consistently with `clickBashHeaderAt`.

**Known gap at handoff (round 3, final)**: the confirming re-run (meant to prove both fixes above
and complete the solo-group decision-13 check) failed on a `cargo` linker error, "not enough
space on the disk" -- the shared `CARGO_TARGET_DIR` this story's own debug builds share with
every other concurrent lane measured 8.8 GB, and free space on `C:` had fallen to under 1 GB.
Per the standing rule, the shared target is never `cargo clean`ed; this story's own tiny (9 MB)
leftover scratch exe dir was removed, which was not enough to restore headroom. This is an
environment/disk-pressure failure, not a code defect -- the prior run's own real findings above
already demonstrate the multi-call Spine working end to end; only the two now-fixed test-script
bugs, and the final re-confirmation run, remain unproven. **Refs #565** pending that
reconfirmation (recommended once shared disk pressure clears); the main agent should judge
whether the prior run's own evidence, plus these two understood and fixed script bugs, meets the
bar for **Closes #565**.

**Resolution (Main, spot-check of the 00:44 evidence)**: accepted. The 00:44 run's own
`report.json` was subsequently overwritten by the disk-failed reconfirmation attempt's own
(incomplete) write; screenshots `00`-`07` (also timestamped 00:44, in the shots folder) are the
real, kept evidence for that run -- the full multi-call Spine, pl-8, role=list, "1 failed" text,
and the real Obsidian/Dark-high-contrast Theme-submenu screenshots, all confirmed live. **Closes
#565.**

## Phase 43: Convergence

- [X] T227 [US5] Issue #735 (Stuart 2026-10-13, full UX-architect-v3 roundtable decision record,
  "Decided (Skippy, delegated by Stuart 2026-10-15)" on the issue): a pinned Collapse all /
  Expand all toolbar row above the session list's scroll area (16px gap under Pull requests),
  two `icon-xs` ghost buttons in fixed order, `aria-disabled` (never native `disabled`) with an
  always-mounted sr-only no-op reason plus a second visual tooltip line, and a polite
  `useChatAreaAnnouncer` announcement on each ("All groups collapsed"/"All groups expanded",
  per-group toggles and the startup restore stay silent). "All" means every Repository group
  plus Archived while #527's own "hidden entirely while nothing anywhere is archived" rule shows
  it; Archived's own saved flag is left untouched while hidden.
- [X] T228 [US5] New `Settings.sessionListCollapse` field (`{ collapsedRepositoryIds: string[],
  archivedOpen: boolean }`, default all-open/Archived-closed): `src/shared/model.ts`/`ipc.ts`,
  `src/tauri-bridge/index.ts`, `src-tauri/src/store/settings.rs` (shape, `KNOWN_FIELDS`,
  `serialize_for_disk`, `set_session_list_collapse`) and `src-tauri/src/ipc/settings.rs`
  (`settings.setSessionListCollapse`, de-duplicated-string-array-plus-boolean shape validation,
  `invalid-argument` otherwise). New `src/renderer/state/session-list-store.ts`: the field's
  sole writer, debounced ~300ms persist flushed on `beforeunload`/`pagehide`, a `restored` flag
  read once at startup alongside `settings.get`/`sessions.list` so `SessionList.tsx` never
  paints a group open and then snaps it shut once the persisted state arrives a moment later
  than Repositories do, `isGroupOpen`/`setRepositoryOpen`/`setArchivedOpen`/`collapseAll`/
  `expandAll`/`openRepositoryGroup`/`pruneRepositories`. `init-stores.ts` restores the state and
  prunes removed-Repository ids after a successful `repositories.list`; `repositories-store.ts`
  prunes after a successful `remove`; `sessions-store.ts`'s `create()`/`restore()` (the one choke
  point every create entry -- the header "+", the branch picker, Ctrl+N, the row menu's own "New
  session from {branch}" item -- and the one restore entry already funnel through) call
  `openRepositoryGroup` on success, covering decision 20's "a closed group reopens, and that open
  is saved, only when a create or a restore actually moves a row into it" without touching
  `SessionRow.tsx`/`useSessionRowActions.ts` (the #731/#811 headroom-constrained hook) at all.
- [X] T229 [US5] `RepositoryGroup.tsx`/`ArchivedGroup.tsx`: both Collapsible types become
  controlled (`open`/`onOpenChange`, replacing `defaultOpen` and the old uncontrolled-closed
  Archived group), `onOpenChange` driven by Radix's own reported `open` value (gate round 1 fix,
  Low: `RepositoryGroup.tsx` originally ignored it and blindly toggled). `GroupHeader.tsx`'s
  `GroupHeaderTrigger` gains `marker`/`containsOpenSession` props: a Waiting marker (the shared
  `StateIcon`, `size-4`, `ml-auto flex shrink-0`, after the label) shown only on a closed group,
  naming the most urgent state among its NON-ARCHIVED Sessions via a new `groupWaitingState()`
  precedence helper in `sessionDisplay.tsx` (Needs you, then Terminated unexpectedly, then
  Unread response -- #731's own state, merged in from `origin/main` and wired into the same
  precedence list its own decision record anticipated); and a 2px `bg-active-indicator` header
  bar (forced-colours `bg-[Highlight]`) on the Repository group currently holding the visible
  non-archived Session while it is closed. Both combine into one accessible name, never a second
  `aria-describedby` region. **Gate round 1 fix (High, every specialist)**: both the marker and
  the bar were computed from `RepositoryGroup`'s raw `sessions` prop, which (since #527) still
  includes that Repository's archived Sessions -- an archived Session kept marking and
  highlighting its old, now-empty-looking group for as long as it stayed closed. Fixed by
  filtering to the same non-archived `active` list the rows themselves render, computed once and
  shared by `containsVisibleSession`/`marker`/the rendered rows.
- [X] T230 [US5] `scripts/theme-contrast-pairs.mjs`: 9 new pairs (`state-needs-you`,
  `state-stopped`, `active-indicator`, `ring`, `muted-foreground` against `sidebar`/
  `sidebar-accent`) for the marker, the active bar and the toolbar's own focus ring, all of which
  render inside the session list's `bg-sidebar` surface and were previously checked only against
  the page `background`. **Gate round 1 fix (High, ui-visual-system-v3)**: decision 23's literal
  `focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-2
  focus-visible:outline-ring` string draws no visible ring at all on `Button` -- its base
  `outline-none` (`button.tsx:7`) sets `outline-style: none` and the decision's own class list
  never resets it, a trap the repo had already found and fixed once for the composer's own
  buttons (`pickerShared.tsx`'s `COMPOSER_BUTTON_FOCUS_CLASS`, which adds `outline-solid`). Both
  toolbar buttons now share one `SESSION_LIST_TOOLBAR_BUTTON_CLASS` built from
  `COMPOSER_BUTTON_FOCUS_CLASS` plus `COMPOSER_DISABLED_HOVER_RESET_CLASS` (also fixes the Low
  finding that a disabled toolbar button still showed hover feedback), replacing the two pasted
  ~260-character class strings; #748's Show hidden button will reuse it.
- [X] T231 [US5] Update the docs: `specs/001-core-session-workspace/spec.md` (superseded the
  2026-10-09 Archived "not persisted across restarts" clarification in place, a new 2026-10-15
  Clarifications Q&A, acceptance scenario 7 under User Story 5 corrected to the three-state
  marker order, **FR-069** finalised once `origin/main` confirmed FR-067/FR-068), `data-model.md`
  (`SessionListCollapse` entity), `contracts/ipc.md` (`settings.setSessionListCollapse` row),
  `CONTEXT.md` (**Group header**, **Waiting marker**), `docs/design/product-layout.md` (the
  toolbar bullet, merged with #731's own session-list-row wording update).
- [X] T232 [US5] Live verification: a scratch Tauri debug instance (own data dir, own scratch
  repositories, the copied exe's sha256 asserted against the launched pid before each run,
  `scripts/verify-tauri-735.mjs`, rewritten in gate round 1 to assert a genuine mixed collapse
  state -- one Repository closed, one open, one Session left archived with Archived open --
  through a real quit and relaunch on the SAME scratch data dir, reading
  `sessionListCollapse` back out of `<dataDir>/settings.json` rather than the dead
  `window.__refractStores` DEV-only baseline the first driver asserted against, and failing
  instead of silently falling back when a real click misses, its session-list-specific CDP
  driving helpers extracted to a new `scripts/verify-tauri-session-list-helpers.mjs` to keep the
  file under the #806 600-line cap once the rewrite grew it past it) proved, against real DOM input
  (never `window.refract.*` as a shortcut, except the one incidental `theme.set` call used only
  to switch themes between screenshots): two Repository groups added and opened by default;
  Collapse all/Expand all closing and opening every Repository group plus Archived together,
  including a real no-op second click (`aria-disabled`, the correct always-mounted reason text,
  never native `disabled`); the toolbar's keyboard reach immediately after Pull requests
  (focused, not clicked -- a real click there navigates to the Pull Requests view, whose own
  repository combobox steals focus on mount) via the real computed accessible name (CDP
  Accessibility domain, never `textContent`); a collapsed Repository group holding a Session
  with a genuinely pending approval (status `needs-you`) showing the Waiting marker, its real
  accessible name reading "..., Needs you"; that marker and the active-session bar NOT
  reappearing on a Session's own former Repository group once it is archived (the gate round 1
  regression proof); open-on-create (the header "+" quick-create reopened a closed group) and
  open-on-restore (restoring an Archived Session reopened its own closed Repository group); the
  mixed collapse state surviving a real app quit and relaunch on the SAME scratch data dir (a
  ~1.5s wait before the forceful Job-Object kill, since that kill never fires
  `beforeunload`/`pagehide`, so the renderer's own flush-on-quit handler would otherwise never
  run); and the toolbar's focus outline actually rendering under keyboard focus (gate round 1
  regression proof for T230's fix), checked via computed style (`getComputedStyle`, not the CDP
  Accessibility domain -- that domain reports accessible names/roles, not rendered box styles;
  gate round 2 fixed this mislabel and also fixed the reading itself to settle to decision 23's
  exact 2px solid value, after an earlier reading mid-transition misreported 3px -- see T233),
  never a bare truthy check. Screenshots (Dark and High contrast, the collapsed group with its
  marker, the mixed state before and after relaunch) recorded to
  `C:/Users/shopwood/AppData/Local/Temp/refract-735-shots/`. `node scripts/ci-local.mjs` 16/16
  PASS (including the full Rust test suite, clippy, and a Tauri debug build) both before and
  after merging `origin/main`.
- [X] T233 [US5] Gate round 2 remediation (five-reviewer, 2026-10-15): Code and Tests FAILed on
  one High (Closes vs Refs: decision 29's Settings round trip and prune checks were still
  unexercised); Security, Accessibility and Architect PASSed. Fixed:
  - `scripts/verify-tauri-735.mjs`/`verify-tauri-session-list-helpers.mjs`: a third scratch
    Repository (C, empty, collapsed) and two new checks -- the Settings round trip (open
    Settings via the profile item's cog, return via "Back to chat", assert the mixed state
    survived the whole-list remount) and the prune (remove Repository C, assert its id actually
    leaves `settings.json` on disk without disturbing Repository A's or Archived's own saved
    state); `createSessionViaQuickCreate` now waits for the Repository's own row count to
    increase, not only that a composer is enabled (a dropped second create went undetected the
    old way, and genuinely happened once in round 1's own evidence); the focus-outline check now
    waits 250ms for `transition-all` to settle and asserts the EXACT `outline-style: solid`,
    `outline-width: 2px`, `outline-offset: 2px` (round 1's "solid, 3px" reading was the pre-settle
    value, not a real departure); both Collapse all and Expand all now get a REAL second click
    asserted to change nothing, not only a read of `aria-disabled`; new `assertExeMatchesProcess`
    (`verify-tauri-cdp.mjs`) actually checks the launched process's own exe path and a fresh
    sha256 against the scratch copy, not only logging the hash at copy time; screenshots, the
    STEP-PASS report and settings.json dumps now persist to
    `C:/Users/shopwood/AppData/Local/Temp/refract-735-gate2-shots/` and are kept (round 1's own
    evidence had been deleted by a later manual cleanup pass).
  - `SessionList.tsx`: the toolbar's no-op dimming now targets only the glyph
    (`aria-disabled:[&_svg]:opacity-50`), keeping the focus ring at full contrast; the
    disabled-hover background/text resets are now toolbar-specific and `dark`-prefixed
    (`dark:aria-disabled:hover:bg-transparent`, `aria-disabled:hover:text-muted-foreground`),
    since the composer's own `COMPOSER_DISABLED_HOVER_RESET_CLASS` lost on both counts here (a
    specificity tie against `dark:hover:bg-sidebar-border`, and `text-current` resolving to the
    inherited `sidebar-foreground` instead of this button's own `muted-foreground`);
    `SESSION_LIST_TOOLBAR_BUTTON_CLASS` is no longer exported (nothing outside this file uses it).
  - `init-stores.ts`: `pruneRepositories` now awaits a `restoredPromise` resolved right after
    `restore()`, so it can never again run before the real saved ids are loaded (closes the D18
    departure, dropped from the table below).
  - `sessions-store.ts`: the `create()`/`restore()` comments now cite the recorded D20 departure
    instead of claiming full compliance with it.
  - `src-tauri/src/store/settings.rs`/`ipc/settings.rs`: new shared
    `sanitize_collapsed_repository_ids` (1,000-id cap, 256-byte-per-id cap, `HashSet` de-dupe
    instead of the old O(n^2) scan) used by both the disk loader and the IPC setter.
  - `contracts/ipc.md`: reworded to state plainly that duplicate ids are removed, not rejected,
    and documents the two new caps. `scripts/check-parity.mjs`: added
    `SETTINGS_SET_SESSION_LIST_COLLAPSE: 'R8'` (was unassigned).
  - `scripts/theme-contrast-pairs.mjs:173`, `sessionDisplay.tsx:44`: the two leftover
    decision-number citations outside the record's 1-29 fixed/removed.
  - **Live re-verification**: both decision 29 checks pass live against the current head (see
    above); `node scripts/ci-local.mjs` 16/16 PASS; `cargo test` and `cargo clippy` clean.
    Screenshots and the STEP-PASS report at
    `C:/Users/shopwood/AppData/Local/Temp/refract-735-gate2-shots/`.
  - **Switched to Closes #735**: every item on decision 29's own verification list is now either
    live-proved or named as an accepted Low departure (D20) in the table below -- no
    acceptance-scoped item is left unexercised.

**Not exercised this phase** (stated plainly, not hidden): a frame-by-frame capture proving no
visible flash of open groups before the persisted state loads (the `restored` gate's own
correctness is a code-review claim here, not a captured absence-of-flash); the toolbar's
two-line tooltip's own hover-visible rendering (its DOM structure and `aria-describedby` target
were verified, not a screenshot of the open tooltip bubble itself); and #559's search slot and
#748's Hide toggle slot in the toolbar, both out of scope for this story (decisions 26-27, hooks
only: `isGroupOpen` selector, first-button-slot order). Decision 29's own Settings round trip and
prune, previously listed here as unexercised, are now both live-proved in T233 above.

This phase was written retroactively (the Spec Kit pickup was delegated via the issue's own
"Decided (Skippy...)" decision-record comment, 2026-10-15, produced by a `ui-architect-v3`
roundtable rather than a live grill, per Stuart's standing delegation while away). A delegated
docs subagent's first attempt at the spec.md/data-model.md/contracts/ipc.md/CONTEXT.md/
product-layout.md amendments used relative paths that resolved against an unrelated sibling
worktree instead of this one (the worktree-path-resolution trap); caught during
self-verification (a `git status` diff of zero in this worktree for files the subagent claimed
to edit), that worktree's own 5 touched files were reverted to clean and the amendments were
redone directly here. Opened as draft PR #905 (`feat/735-collapse-all`). A five-reviewer gate
round (code-reviewer, test-reviewer, accessibility-auditor, security-auditor, ui-architect-v3)
found 3 agreed High findings (the archived-Session leak into the marker and active bar, the
toolbar focus ring never rendering, and the first live-check driver's restart proof being
vacuous against a build that persisted nothing) plus Medium (spec FR-069/scenario 7 still naming
two marker states) and Low findings (decision-number citations in comments using an internal
63-121 scheme instead of the record's own 1-29, `RepositoryGroup.tsx` ignoring Radix's own
`open` value, auto-open-on-restore firing even when focus does not move, a possible
prune/restore race, and a disabled toolbar button still showing hover feedback); every High and
Medium finding above was fixed in T229-T232; the prune/restore race and the focus-independent
auto-open were recorded as accepted Low departures in the table below rather than silently
dropped. Kept **Refs #735**, not **Closes**, for decision 29's Settings round trip and prune --
named but not yet exercised. Merged `origin/main` (PR #899/#563, which lands as Phase 41) before
this phase was finalised; `node scripts/ci-local.mjs` re-ran 16/16 clean afterward.

A gate round 2 found one remaining High (the Closes/Refs mismatch above, plus the two decision-29
items still unexercised) and several Medium/Low findings; T233 fixes all of them and switches
this entry to **Closes #735** -- see T233's own entry for the full list. D18 (the prune/restore
race) is fixed there too and dropped from the table below; D20 and D23 stand as recorded,
accepted departures. Renumbered from provisional Phase 42/T221-T227 to Phase 43/T227-T233 once
`origin/main` landed PR #906/#565 as Phase 42/T221-T226 (per Main's own merge instruction);
merged `origin/main` again at that point, `node scripts/ci-local.mjs` re-ran 16/16 clean.

**Departures from the decision record** (named per the gate's own finding, not silently dropped):

| Decision | Departure |
|---|---|
| D20 | A restored or created Session's group auto-opens even on a path where focus does not move (Low, accepted: moving the call out of the shared store action would touch the headroom-constrained `useSessionRowActions.ts`). |
| D23 | The toolbar's literal focus-ring class string draws nothing on `Button`; fixed by building from the repo's own existing `COMPOSER_BUTTON_FOCUS_CLASS` fix instead (High, fixed, recorded on the issue; the resulting outline is live-verified at the record's exact 2px solid value). |

## Phase 44: Convergence

- [X] T234 [US1] #570 tool row colour treatment (Decided, Skippy, delegated by Stuart 2026-10-15;
  `ui-architect-v3` roundtable, full decision record on the issue): amended spec 001 per the
  record's own section 5 -- FR-008 (label neutral for running/done/interrupted/exited, the
  running icon alone in the working colour (pre-existing, unchanged by this story); red
  icon/label and the new Error line for a failed call, a multi-call group's own settled-status
  colour rule and meta-slot counts), FR-047 (ties the existing generic "warning or error line"
  clause to FR-061's own named Error line for tool rows specifically), FR-061 (the failed-call
  error text renamed the Error line and moved out of the expanded body into the collapsed row
  itself, unconditionally; the expansion no longer repeats it), a new Clarifications "Session
  2026-10-16" entry (three Q/A matching the decision record's colour/icon map, Error line
  placement and derivation, and group collapsed/expanded behaviour), acceptance scenario 18 (US1),
  and three Edge Cases (`(no output)` placeholder, ANSI stripping, a still-running group with an
  already-failed member). `git diff --numstat origin/main -- specs/001-core-session-workspace/tasks.md`
  confirmed 0 deletions before this phase was appended.

- [X] T235 [US1] Probe first (decision record's own "Ready to build" note: FR-061's wording
  assumed, as an [INFERENCE], that a failed `bash` call's own output ends with its useful line --
  the probe was required to confirm or flip this before the Error line's `bash` derivation was
  built). `docs/spike/bash-error-probe-570.mjs` (scratch `--session-dir`/cwd under `os.tmpdir()`,
  real signed-in default profile, `--approval-mode=yolo`, two isolated tiny turns) ran against the
  real signed-in `omp 18.10.1` and captured two real `tool_execution_end` frames for a failing
  `bash` call: `ls /definitely-not-a-real-path-570` (real stderr) and `exit 7` (no output at all).
  Both flipped the assumption: OMP's own bash wrapper always appends a trailing `Wall time: Ns`
  then `Command exited with code N` footer AFTER the real content (or a literal `(no output)`
  placeholder when there is none), so the real error sits BEFORE that footer, not at the raw
  string's own last line. Recorded as `docs/spike/FINDINGS.md` item 60. `ToolRow.tsx`'s
  `errorLine()` strips that known two-line footer from the end before taking the new last line
  for `bash` (first line, unaffected, for every other tool).

- [X] T236 [US1] Built per the decision record's section 6 ("Files the build will touch"):
  `toolStatus.tsx`'s `StatusIcon` now renders the identical icon/colour per state as
  `subagentStatus.tsx`'s own map (#563, already shipped first): `LoaderCircleIcon`
  `text-state-working` (running), `CheckCircle2Icon` `text-state-idle` (done, fully neutral --
  "failure loud, success quiet"), `XCircleIcon` `text-severity-error` (error), `UnplugIcon`
  `text-muted-foreground` (interrupted/exited); every icon `aria-hidden`. `CollapsedLine.tsx`
  gained `labelClassName` (a failed row's label joins its icon in the error colour, the target
  stays muted) and `detail`/`hideDetailWhenOpen` (the Error line: a `<p>` sibling of the trigger,
  inside the `Collapsible` root, at the label column `pl-8 pr-2`, linked to the trigger via
  `aria-describedby`, mounting inside the transcript's own existing `role="log"` region so it is
  announced once as that log's own addition with no second live region; `hideDetailWhenOpen` lets
  a multi-call group's own header show its latest failed member's line only while collapsed,
  replaced by each failed member's own line once expanded, while a solo call's or a member's own
  line stays visible either way). `ToolRow.tsx`: `ToolCallBody`'s old boxed error `<p>` is deleted
  (no longer duplicated inside the expansion); `ToolCallRow` (a group member) and `ToolGroupRow`
  (solo and the group header) both pass `labelClassName`/`detail` for a failed item, and
  `ToolGroupRow`'s own summary no longer appends ", N failed"/", N interrupted" as text -- those
  counts move into the row's never-shrinking `meta` slot, "N failed" in the error colour the
  instant any member fails (even mid-run; the header's own icon/label turn red only once the
  group's SETTLED status is failed, matching the existing running-beats-failed worst-state order),
  "N interrupted" staying neutral. Docs updated per section 5: `product-chat.md` (bullets 14-15),
  `foundations-icons.md` (a new Chat Status icons bullet distinct from the session-list
  `StateIcon`), `CONTEXT.md` (new **Status icon** and **Error line** glossary entries; "a state
  icon" in the Subagent panel entry corrected to "a **Status icon**"). `check:theme-contrast`'s
  existing `destructive`/`muted` (4.5:1) and `state-idle`/`muted` (3:1) pairs already numerically
  cover `severity-error` (the two tokens share an identical value in every built-in theme,
  `globals.css`), so no new PAIRS entries were needed -- confirmed by a clean 361/361 run.
  `pnpm typecheck` clean; `node scripts/ci-local.mjs`: 16/16 steps PASS, including the Tauri debug
  build and `check:ui-text` (0 leaks across 371 files).

- [X] T237 [US1] Gate round 1 remediation (PR #909: code-reviewer/ui-architect-v3 FAIL on one
  shared High, both PASS after the fix; accessibility-auditor, security-auditor, test-reviewer all
  PASS with findings): fixed `errorLine()` (`ToolRow.tsx`) -- the original cut stripped OMP's own
  `Command exited with code N` line together with its `Wall time:` footer, so a SILENT `bash`
  failure (`exit 9`, no stdout/stderr) showed OMP's own `(no output)` placeholder instead of the
  one fact that explains it; now only `Wall time: Ns` is stripped, the exit/timeout line that
  follows it is read FIRST as a fallback ("Exited with code N" / "Command timed out after N
  seconds"), and a lone `(no output)` left after the cut is also treated as wrapper chrome, never
  content. Also fixed: a settled group's own Error line is prefixed with the failing member's
  target, muted, whenever it differs from the header's own visible (last-call) target (M2); the
  group meta's "N failed"/"N interrupted" counts are joined by a visible middle dot plus an
  sr-only comma, matching #632's own grammar, instead of two bare adjacent spans (M1); FR-008 and
  `product-chat.md` corrected to say the running ICON alone keeps its pre-existing working colour
  (only the LABEL is neutral for running) rather than claiming the whole row is "fully neutral";
  `toolStatus.tsx` and `subagentStatus.tsx` now both read one shared icon/colour table
  (`statusGlyph.ts`, decision 3) instead of two hand-written copies; C0 controls and bidi-override
  characters are stripped from the Error line and its `<p>` gets `dir="auto"` (security Low); two
  `severity-error` pairs (background, muted) added to `theme-contrast-pairs.mjs` at the real 4.5:1
  text floor, not just the pre-existing 3:1 icon floor (a11y Low); the committed probe script
  (`docs/spike/bash-error-probe-570.mjs`) now actually runs both scenarios FINDINGS 60 claims
  (a real stderr failure and a silent `exit 9`), re-run live and FINDINGS 60 corrected to match.
  Filed issue #911 (a user-initiated Stop mid-flight renders the FULL failed/red treatment, not
  neutral -- confirmed live, not merely [INFERENCE], out of scope for #570, pre-existing #510/#490
  code untouched by this story) and a decision-20 note on #552 (the HC red-on-hover floor).
  `scripts/verify-570-tool-colours.mjs` rebuilds fresh immediately before every run now (no reused
  exe -- round 1's first rerun lost exactly that race to a sibling lane's own concurrent rebuild
  of the shared target) and asserts a #570-only string in the built bundle before trusting
  anything else; the group's settled Error line, the solo Error line, and the 360px Error line are
  all now asserted against the exact expected text, not merely logged. `node scripts/ci-local.mjs`
  not re-run in full this round (no Rust change beyond the already-passing build); `pnpm
  typecheck` and `node scripts/check-theme-contrast.mjs` (394/394, up from 361, the two new
  `severity-error` pairs) both clean. Live re-run: **zero failures** -- the exit-code fallback, the
  group-detail attribution, the AX-tree-measured accessible name, the 360px clamped Error line, and
  the M3 Stop-mid-flight finding (now CONFIRMED, not [INFERENCE]) are all real, live evidence.
  Still not exercised: the exact spinner-still-running instant with a failed count already
  showing (narrow real-model timing, twice lost; backed by the unmodified `status` ternary
  instead) and the 240px Subagents panel case (never attempted); both remain on the verification
  backlog (#650). **Refs #570** (not Closes): those two checks are still open.

## Phase 45: Convergence

- [X] T238 [US5] Issue #567 (UX-architect-v3 roundtable decision record, delegated by Stuart
  2026-10-15, "Decided (Skippy, delegated by Stuart 2026-10-15)" on the issue): restyle the
  session list's rows, group headers and footer to the record's 28-decision spec (#811/#731/#735
  already merged first, per decision 1-2's own build order). `sessionDisplay.tsx`: new
  `formatRelativeTimeShort` (decision 11's "now"/"Nm"/"Nh"/"Nd"/short-date form), leaving the
  existing long-form `formatRelativeTime` untouched for `ManageSessionRow.tsx`/the Pull requests
  view/`SessionDetailsCard.tsx` (out of this story's scope). New
  `src/renderer/lib/useMinuteTick.ts`: one shared `setTimeout`/`setInterval` pair behind
  `useSyncExternalStore`, subscribed by every row instead of a per-row timer. `SessionRow.tsx`:
  rewritten to the two-line 44px square-cornered row (`data-choice-item` on the `<li>`, `rounded-
  md` dropped, decision 8); line 1 is the state icon, the truncating title (`font-normal`, never
  reflowing on selection, decision 3) and the short time at the right; line 2 is one slot, first
  match wins (decision 9) -- start-progress text, "Terminated unexpectedly", an archived row's
  own Project name, or otherwise the branch in `font-code`. The trailing slot (decision 12) swaps
  the time for the row's own "..." menu button on hover, focus inside the row, or an open menu
  (`group-has-[[aria-expanded="true"]]`), both shown under `(hover: none)`; this is a `display`
  swap (`hidden`/`inline-flex`), not an opacity fade, since the two share one slot rather than
  reserving space for both. The accessible name is now one `aria-label`, "{name}, {status
  word}[, Archived][, focused pane]" (decision 16) -- the scattered bracketed `sr-only` spans this
  button used are gone, and so is the `isVisible && !isFocusedPane` "(shown, unfocused pane)"
  case the old spans carried, since decision 16's own formula has no slot for it (Stuart can
  overturn). The selected-session bar moves to `inset-y-1` (decision 14). `SessionDetailsCard.tsx`
  gains an `activityDescription` prop (the row's own line-2 text when it is not the branch) and a
  fuller `aria-describedby` description -- activity text, "{branch} from {base}", "Last active
  {long time}", the worktree path (decision 16) -- replacing the shorter `From {base}. {path}`
  form. `GroupHeader.tsx`: sentence case (`uppercase tracking-wide` and the `/70` opacity modifier
  dropped for `text-xs font-medium text-muted-foreground`, decision 4), the chevron and the
  optional leading icon shrink to `size-3` (decision 7), the focus ring moves to `outline-offset-
  [-2px]` (decision 15), `GROUP_HEADER_ACTIONS_OFFSET_PX` recomputed 104px to 88px for the new
  24px action buttons (3x24 + 3 gaps x 4px + 4px trailing padding), and a new optional `count`
  prop renders as a separate `tabular-nums` span after the label, folded into the accessible name
  as "{label}, {count}" (decision 5). `ArchivedGroup.tsx`: `label="Archived"` plus `count=
  {sorted.length}` instead of the old `Archived (${n})` template string; `showRepository` prop
  removed from `SessionRow` entirely (the archived-row line-2 rule now keys off `session.
  archivedAt` directly, decision 9) and its own row list's `gap-0.5` drops to `gap-0` (decision
  8). `RepositoryGroup.tsx`: the three header action buttons (new session, branch picker, "...")
  move from a mix of `icon-sm`/a raw 22px button to shared `Button variant="ghost" size="icon-
  xs"`, hidden at rest and revealed by opacity on `group-hover`/`group-focus-within`/their own
  `aria-expanded`/`creating`/an empty active-Session list, always shown under `(hover: none)`
  (decision 6) -- unifying all three to 24px (initially intended, gate round 1 found this alone
  insufficient, see T241) to resolve #908's "Archived marker column" follow-up (the old mixed
  28/28/22px actions column, about 94px real, against a stale 104px constant, put Archived's own
  Waiting marker about 18px left of a Project header's); its own row list's `gap-0.5` also drops
  to `gap-0`. `SessionList.tsx`: the Pull
  requests nav entry gains the shared 2px active-indicator bar when selected, alongside its
  existing fill (decision 18); the footer's own `border-sidebar-border` becomes `border-divider`
  (decision 20). `ProfileItem.tsx`: its own `border-t` removed, since the footer above it now
  carries the one divider for the whole block (decision 20). `scripts/theme-contrast-pairs.mjs`:
  the remaining sidebar pairs decision 26 asks for (`muted-foreground`/`sidebar-foreground`/
  `destructive` at 4.5:1, `state-working`/`severity-info` at 3:1, each on `sidebar` and `sidebar-
  accent` -- `active-indicator`/`state-idle`/`state-needs-you`/`state-stopped`/`state-unread-
  response` already had theirs from #731/#735). Docs: `CONTEXT.md` gains the **Activity line**
  entry the record's own CONTEXT.md section asks for (**Group header** and the "Unread
  response"/"Response ready" note were already correct from #527/#731); `docs/design/foundations-
  typography-spacing.md` records the type ladder (decision 3); `docs/design/components.md` adds a
  "Labelled ghost nav and footer entries" note for the Pull requests/Add repository buttons
  (decisions 18, 21); `docs/design/product-layout.md:16` rewritten to use **Project** instead of
  **Repository** (the session-list bullet's own stale term CONTEXT.md's glossary already bans in
  UI-facing prose) and to describe the new row/header/footer layout -- the "no separate unread
  dot" fact itself was already correct from #731 and is kept, just re-worded into the new
  two-line description.
- [X] T239 [US5] Update the spec: amended `specs/001-core-session-workspace/spec.md` with a
  `### Session 2026-10-15 (session list restyle)` Clarifications entry citing the full decision
  record, amended FR-039 (decision 11's time-format split and decision 16's accessible-
  description formula), and a new FR-070 (renumbered from a provisional FR-075 once #570/Phase 44 landed first on origin/main
  with FR-069 as the confirmed ceiling, consecutive numbering restored) for the row/group-header/
  footer layout itself. FR-005 was reviewed against decision
  record's "update FR-005 (remove the unread dot)" instruction and left unchanged: its current
  text ("drawn by the one shared status icon and its word, with no separate unread marker") was
  already fully compliant, added by #731 before this story started -- recorded here rather than
  silently skipped.
- [X] T240 [US5] Verify live (scratch Tauri debug build, `scripts/verify-tauri-567.mjs`, new --
  reuses `verify-tauri-cdp.mjs`/`verify-tauri-session-list-helpers.mjs`, same precedent as
  `verify-tauri-735.mjs`; isolated `REFRACT_DATA_DIR`/`WEBVIEW2_USER_DATA_FOLDER`/
  `REFRACT_IMPORT_SOURCE_DIR`, the built exe copied out of the shared `CARGO_TARGET_DIR` and
  sha256-asserted against the launched process before driving it): a `#567`-only DOM marker
  (`li[data-choice-item]`) present before anything else was judged; row height measured 44px,
  square corners (`border-radius: 0px`) on both the `<li>` and its content surface; the open
  button's own focus ring measured `outline-style: solid`, `outline-width: 2px`, `outline-offset:
  -2px` under REAL keyboard navigation (Tab away, Shift+Tab back -- a mouse click or a script
  `.focus()` immediately after one does not engage Chromium's own `:focus-visible` heuristic, a
  live-verified harness correction, not a product bug); the row's accessible name measured
  `"{name}, Idle, focused pane"` (CDP Accessibility domain, never `textContent`); the trailing
  slot measured `time: block` / `menu: none` at rest and `time: none` / `menu: flex` on hover (a
  real `display` swap, not opacity -- also live-verified that the harness's own click-based
  helpers need the row hovered first, since a `display:none` button has a zero-size
  `getBoundingClientRect` to click); F2 opened the rename input on the row; a pending approval
  showed the needs-you icon with the branch in `font-code` (`"Cascadia Code", "Cascadia Mono",
  Consolas, monospace`) on line 2; archiving showed the Archived header as `"Archived" + a
  separate countSpan "1"` with no bracket, and the archived row's own line 2 as its Project name;
  the group header measured `text-transform: none` (sentence case) and its own action buttons
  24x24px, hidden until hovered (or, live-verified as a side effect once the only Session was
  archived, shown at rest because the group then had zero active Sessions, decision 6's own
  empty-group case); a closed group holding a needs-you Session carried the Waiting marker in its
  own accessible name; the footer measured a 1px divider above it and `0px` on `ProfileItem`'s own
  former border; the selected Pull requests nav entry showed the active-indicator bar. Screenshots
  (idle/selected, focused, hover/trailing-slot, renaming, needs-you, Archived open, header hover,
  collapsed-with-marker, footer, Pull requests selected, Dark (high contrast), Obsidian) and the
  run's own STEP-PASS report are kept at
  `C:/Users/shopwood/AppData/Local/Temp/refract-567-shots/`. `node scripts/ci-local.mjs` 16/16
  PASS (confirmed `CARGO_TARGET_DIR` respected -- `src-tauri/target` absent from the worktree
  afterward); `pnpm test` 148/148 (no new tests, per AGENTS.md); `check:theme-contrast` 415/415
  PASS including the 9 new sidebar pairs T238 added.

- [X] T241 [US5] Gate round 1 remediation (five-reviewer, 2026-10-16): Code, Tests, A11y and
  `ui-architect-v3` FAILed on three agreed High findings and several Medium/Low ones (Security
  PASSed). Fixed: **(1)** `SessionRow.tsx`'s own "..." trigger was `hidden` (`display:none`) at
  rest, so `menuTriggerRef.current.focus()` silently did nothing on every keyboard close path
  (Escape, a menu item, Delete > Cancel, Shift+F10) and Shift+Tab skipped it entirely (decision
  17) -- now an `opacity`/`pointer-events` swap, absolutely positioned over the time's own cell
  (the time itself swaps to `invisible`, keeping its layout box reserved), with every reveal rule
  scoped inside `[@media(hover:hover)]` so a touch pointer's own default (always visible, no
  override needed) satisfies decision 12's "under hover:none, both show" without a separate rule;
  `group-has-[[data-slot="context-menu-trigger"][data-state="open"]]` added alongside the
  dropdown's own `aria-expanded` check, since Radix's `ContextMenuTrigger` sets `data-state`, not
  `aria-expanded`. **(2)** An archived row's own Project name never reached assistive technology
  (`activityDescription` was `undefined` for that case, resting on a false comment that the
  unreachable hover card covered it) -- now set to the Project name, with `FolderGit2Icon size-3`
  added to line 2 to match the old per-repository secondary label (decision 9.4). **(3)** The
  #908 fold-in (T238) claimed the marker-column alignment was exact "by construction" at 88px;
  it was still 8px off, because `ArchivedGroup.tsx`'s spacer sits INSIDE the header row and must
  NOT also add the row's own trailing padding a second time -- added a separate
  `GROUP_HEADER_ACTIONS_WIDTH_PX` (3x24 + 2x4 = 80) for the spacer, keeping
  `GROUP_HEADER_ACTIONS_OFFSET_PX` (88) for the tooltip `sideOffset` only, and this time measured
  live (both header triggers' own `getBoundingClientRect().right`, asserted within 1px) rather
  than claimed from arithmetic alone. Medium/Low fixes: decision 24's "No sessions yet" empty-
  Project line (`RepositoryGroup.tsx`, was missing and unflagged); the "..." and header actions'
  hover/open-menu fill, which lost to `ghost`'s own `dark:hover:bg-muted/50` (every built-in theme
  sets `.dark`) -- added `dark:hover:bg-sidebar-border`/`aria-expanded:bg-sidebar-border`; a
  forced-colours focus outline on every new 24px `Button` (`COMPOSER_BUTTON_FOCUS_CLASS`, since
  `Button`'s own `focus-visible:ring-3` is a box-shadow forced colours strips); decision 8's icon
  alignment, per the UX architect's own gate ruling (`GroupHeader.tsx`'s trigger `gap-1.5`/
  `px-1.5` to `gap-1`/`px-1`, `SessionRow.tsx`'s row `pl-3` to `pl-6`, both now meeting at 24px) --
  **this changes decision 8's own literal `pl-3 pr-2 py-1`, recorded as a departure on #567, not
  silently overridden**; Resume moved outside the open button into a shared trailing area with
  the time/"..." cell so line 2 keeps the full row width on every row; the Add repository
  button's muted-at-rest colour (decision 21); the row shrinking to about 38px while renaming
  (`min-h-11`); the quick-create "+" losing its glyph-only disabled dim while creating; off-grid
  `gap-0.5`/`px-1.5` in the repository rename wrapper and the tooltip's own two-line gap
  (decision 28); `formatRelativeTimeShort`'s rounding (`Math.floor`) disagreeing with
  `formatRelativeTime`'s (`Math.round`) for the same instant, and its locale-dependent short-date
  order (`Intl.DateTimeFormat(undefined, …)` reads "Oct 12" in `en-US`, not decision 11's own
  "12 Oct") -- pinned to `'en-GB'`; and the row's own accessible description re-announcing "Last
  active {N}m ago" to a focused screen-reader user roughly once a minute (the shared tick
  recomputes it every render) -- now a stable `formatAbsoluteTime` ("Last active 14:05") in the
  description only, leaving the visible short time and the hover card's own long form ticking as
  before. **Live re-verification**: `scripts/verify-tauri-567.mjs` rebuilt and re-run from this
  fix's own commit (`pnpm tauri build` chained with the verify script in one command, so the
  run's exe is provably built from the commit under test; git HEAD logged in `report.txt`) --
  KEYBOARD-ONLY Tab reaches the "..." trigger at rest, Enter opens it, Escape returns focus to
  it, Delete > Cancel also returns focus to it, and a right-click context menu reveals the "..."
  slot without stranding focus on `<body>` on close; the header actions' opacity at rest/hover/
  keyboard-focus measured WHILE the group still has its one active Session (not after archiving,
  gate round 1's own Medium finding on the first run); the marker-column alignment measured at
  both header triggers' own `getBoundingClientRect().right` -- **0px delta, an exact match**;
  decision 24's empty-Project line; the archived row's Project name, icon and accessible
  description (via its own `aria-describedby` element's `textContent`); everything T240 already
  covered. Three harness bugs found and fixed while re-running (not product bugs): the header-
  actions-at-rest probe needed an explicit blur first (`createSessionViaQuickCreate`'s own click
  left the "+" button focused, which `group-focus-within` then kept revealed); the hover target
  needed to be the header's own div, not the whole repository container (which also spans the
  row list below it); `DeleteDialog` is an `AlertDialog` (`role="alertdialog"`), not
  `role="dialog"`, so its Cancel button needed its own selector. `node scripts/ci-local.mjs`
  16/16 PASS; `pnpm test` 148/148. Evidence (13 screenshots, `report.txt`, and 5 JSON
  diagnostics) kept at `C:/Users/shopwood/AppData/Local/Temp/refract-567-gate1-shots/`.

**Not exercised this phase** (stated plainly, not hidden): the mock image itself was not
available to diff pixel-for-pixel against (only the decision record's own textual description
was available, which every check above verifies against instead); the `(hover: none)` touch-
pointer path is now un-overridden default behaviour (gated out of the hover-hiding rules
entirely, T241) rather than a separately asserted branch, so it was not exercised under actual
touch-pointer emulation (the scratch harness has none); the Working, Stopped and Unread response
status icons were not separately live-exercised this phase (that rendering is `StateIcon`'s own,
unchanged by this story and already gate-verified under #731) -- Idle, Needs-you and Archived
were exercised, since those are the states that interact with this story's own new line-2
precedence and accessible-name logic; the 220px narrow-width truncation (decision 25) was not
re-measured after T241's `pl-6`/`gap-1` changes recovered 8px of width margin for it.

- [X] T242 [US5] Gate round 2 remediation (five-reviewer, 2026-10-16, PR #910): Tests and A11y
  FAILed on one shared High (a regression of round 1's own fix), Code escalated the "Last active"
  format to High too and found a second High (line 2 narrower than claimed); Security PASSed.
  Fixed: **(1)** round 1's keyboard-focus fix scoped the "..." trigger's base opacity/pointer-
  events visibility entirely inside `[@media(hover:hover)]`, so a touch-only pointer could never
  reveal or tap it at all, regressing decision 12's "Under hover:none, both show" -- its own
  `[@media(hover:none)]:static/opacity-100/pointer-events-auto` branch restores it, and the
  trailing cell's `h-4` becomes `min-h-4` so the time and button can share the row in flow instead
  of overlapping. CDP's `(hover:none)`/`(pointer:coarse)` media emulation was attempted for a live
  proof and found to have no effect on WebView2's own CDP endpoint (`matchMedia` never flips, no
  CDP error either) -- `scripts/verify-tauri-567.mjs` falls back to a static check that the fix's
  own `@media(hover:none)` CSS rule exists in the running bundle, code-verified rather than
  behaviourally driven. **(2)** `formatAbsoluteTime` (round 1's a11y fix for a per-minute
  re-announcing description) was hour:minute only with no date, so an archived Session idle for
  days read as "Last active 14:05", indistinguishable from one active minutes ago -- now day-aware
  ("Today HH:MM" or "{day} {month}[ year] HH:MM"), recorded as a decision 11/16 departure on #567.
  **(3)** Resume and the trailing time/"..." slot were flex siblings of the open button, narrowing
  line 2 below decision 8's own "full row width" claim (T238's own comment was wrong) -- pinned
  instead to one absolute group (`right-2 top-1 h-5`) anchored to line 1 only, with line 1's own
  `pr-28` reserving the matching space; line 2 (no such padding) spans the row again. Medium/Low
  fixes: Resume had no hover feedback (shares a new `ROW_ACTION_HOVER_CLASS` with the "..."
  trigger); Pull requests and Add repository both lost their hover fill to ghost's own
  half-strength `dark:hover:bg-muted/50` (`hover:bg-sidebar-accent dark:hover:bg-sidebar-accent`
  added to both); "No sessions yet" (decision 24's own verbatim text, for zero Sessions ever) now
  reads "No active sessions" once every Session is archived instead (the Project still has
  Sessions, just none listed); `GroupHeader.tsx`'s muddled 84/88px arithmetic comment and
  `RepositoryGroup.tsx`'s single-constant comment both corrected (name both
  `GROUP_HEADER_ACTIONS_OFFSET_PX`/`_WIDTH_PX`, not just the one each touches); `components.md`'s
  "matching every other ghost use" claim corrected (Pull requests stays foreground at rest, a
  primary nav entry, unlike a footer action). **Live re-verification**: `scripts/verify-tauri-
  567.mjs` rebuilt and re-run from this commit (`pnpm tauri build` chained with the verify script
  in one command) -- the line-2 full-width measurement (8px delta, the row's own `pr-2`); an
  isolated hover-swap proof (time at rest, "..." on hover) with its own screenshot; KEYBOARD-ONLY
  Delete > Cancel now driven by ArrowDown/Tab/Enter (never a click, correcting T241's own
  overclaim); a right-click context menu returning focus to a real row-level control on close
  (by element identity, not merely "not `<body>`"); the archived description's day-aware "Last
  active Today HH:MM"; "No active sessions" once the only Session is archived; everything T240/
  T241 already covered, re-confirmed. Shift+F10 (decision 17) was attempted too and found not
  drivable via CDP in WebView2 (confirmed with a one-shot `contextmenu` listener: no event ever
  fires) -- it and the right-click check above ultimately drive the identical `contextmenu`
  handling Radix's `ContextMenuTrigger` reacts to, so this is a harness limitation, not missing
  coverage of a distinct path. `node scripts/ci-local.mjs` 16/16 PASS. Evidence (screenshots,
  `report.txt`, JSON diagnostics) kept at
  `C:/Users/shopwood/AppData/Local/Temp/refract-567-gate2-shots/`.

**Not exercised this phase** (stated plainly, not hidden): the mock image itself was still not
available to diff pixel-for-pixel against; the dated (non-"Today") branch of `formatAbsoluteTime`
was not live-exercised (only code-verified -- every session in this run was created today, so only
the "Today HH:MM" branch occurs naturally); forced-colours rendering of the new hover classes;
the shared minute tick's own live redraw; the short-date ("12 Oct") form after 7 days; Resume's own
hover fill (no stopped/resumable Session was created in this run's flow); the 220px narrow-width
truncation (decision 25), not re-measured after this round's `pr-28`/`right-2` changes.

- [X] T243 [US5] Gate round 3 remediation (five-reviewer, 2026-10-16, PR #910): Code, Tests, A11y
  and `ui-architect-v3` all PASSed; one short follow-up round before merge. Fixed: **(1)**
  `SessionRow.tsx`'s line 1 used a flat `pr-28` (112px, the trailing group's own worst case --
  Resume, the time, and the "..." all shown together under `[@media(hover:none)]`) even under
  `[@media(hover:hover)]`, where only one of the time/"..." ever shows at once -- starving the
  title to about five characters at decision 25's own 220px minimum, far more than the group ever
  needs there. Sized to the real content instead: `pr-10` (or `pr-16` with Resume mounted) under
  hover:hover; `[@media(hover:none)]` widens further to the true additive case, `pr-17` (68px)
  without Resume or `pr-24` (96px) with it. **(2)** The "..." trigger hung about 4px below line
  1's own centre (`inset-y-0` stretching a `size-6` button inside a shorter `min-h-4` cell,
  top-anchored -- CSS keeps the explicit height and ignores `bottom` when both are set alongside
  `top`) -- `top-1/2 -translate-y-1/2` centres it regardless of the cell's own height. **(3)**
  Dropped FR-070's "provisional numbering, parent confirms the final number before merge" note
  now that #570's own merge settled FR-069 as the ceiling; records the actual renumbering reason
  instead, matching the existing FR-067/FR-068 precedent. Posted the code-verified-only items
  (the `(hover:none)`/Shift+F10 CDP gap, the dated `formatAbsoluteTime` branch, forced colours,
  the minute tick, the short-date form) on #650.

  **Live re-verification** (`scripts/verify-tauri-567.mjs`, rebuilt and re-run from this commit):
  the session-list panel dragged to its own `minSize={220}` floor (`App.tsx`) -- a precise drag
  distance computed from the panel's own measured width before dragging, not a large fixed
  offset, which gate round 3's own first attempt found overshoots the floor and triggers the
  panel's `collapsible`/`collapsedSize={0}` snap instead of clamping at 220px (a harness bug,
  not a product one) -- measures the title never overlapping the trailing group (89px of title
  kept, against the old ~36px floor); the "..." trigger's vertical centre within 1px (measured
  0px) of line 1's own centre.

  **Resume's own "with Resume" sizing (`pr-16`/`pr-24`) and hover fill stay code-verified, not
  live** -- gate round 3 attempted to create a genuinely resumable Session live (via the row's own
  Stop agent action) and found it does not work: `shared/canResumeSession.ts` requires
  `stopReason: 'agent-exited'` or `terminatedUnexpectedly`, never set by a deliberate, user-
  initiated Stop (confirmed by reading that source, then by a live attempt -- `canResume` stayed
  `false` and no Resume button ever mounted). A genuinely resumable Session needs an actual
  unexpected exit; the fake-omp engine's own `__exit__`/`exit.jsonl` crash directive exists for
  exactly this (`scripts/fixtures/omp-frames/README.md`), but is wired only into fake-omp-driven
  scripts, and this script drives a real, ambient `omp` throughout -- switching it over for one
  session is a nontrivial harness change, out of scope for this round. `pr-16`/`pr-24` are
  instead confirmed compiled into the running bundle's own CSS at the expected
  `calc(var(--spacing) * 16/24)` (64px/96px) values. `node scripts/ci-local.mjs` 16/16 PASS.
  Evidence (screenshots, `report.txt`, JSON diagnostics) kept at
  `C:/Users/shopwood/AppData/Local/Temp/refract-567-gate3-shots/`.

**Closes #567** (five-reviewer gate PASS across Code, Tests, A11y and `ui-architect-v3`; Security
PASSed every round). **Refs #908** stands: only the marker-column item is folded in and
live-measured at 0px; its other four items are untouched.

## Phase 46: Convergence

- [X] T244 [US1] #557 collapse consecutive thoughts (Decided, Skippy, delegated by Stuart
  2026-10-15; `ui-architect-v3` roundtable, full decision record on the issue): a run of two or
  more consecutive, non-empty `thinking` items with nothing else between them (a hidden
  bookkeeping tool's own failure notice does not end it, FR-052) now collapses into one row
  reading "Thought process" with the step count and, once every member is timed, the union of
  the members' own intervals as the total duration, floored at 1 second so it never reads shorter
  than any one member (gate round 1 fix, see T246) -- never a plain sum, which can overstate past
  the turn total: thoughts inside one message share an end time, `transcript.rs:920-925`. A new
  pure `groupThoughtItems.ts` (`src/renderer/features/chat/`) runs on `groupToolItems`'s own
  output, before `groupSubagentStages` (`Transcript.tsx`'s `turnsWithStages` memo); every run --
  including a run of one -- becomes a `ThoughtRun`, the same "always wrap" rule `groupToolItems`
  already follows for tool calls, so `ThoughtRunRow` (new, `ThoughtRunRow.tsx`) never switches
  React element type at this tree position as a run grows -- gate round 1 (code/a11y/architect
  High, see T246): an earlier revision DID switch element type (a run of one returned
  `<ThoughtItemRow>` directly, two or more returned `<CollapsedLine>`), remounting the row and
  losing focus/open state the moment a second thought arrived; fixed to always return ONE
  controlled `<CollapsedLine>`, switching only props/children on `solo`, mirroring `ToolGroupRow`
  exactly. `ThoughtRun` itself is declared in
  `groupToolItems.ts` beside `ToolGroup` (plus an `isThoughtRun` type guard), joining the shared
  `GroupedTranscriptItem` union there so every downstream consumer (`groupSubagentStages.ts`,
  `transcriptRowVisibility.ts`) passes a `ThoughtRun` straight through unchanged, with no edits
  needed in either file beyond `transcriptRowVisibility.ts`'s own `BOOKKEEPING_KINDS`/
  `rowVisibility` rename from `'thinking'` to `'thought-run'` (a thought row no longer reaches
  those checks under its old raw kind once grouping runs; `'thinking'` stays in the type only for
  `TranscriptRow`'s own defensive one-item fallback, mirroring `ToolGroupRow`'s ungrouped-`tool`
  fallback). A run of one renders exactly the pre-#557 solo row ("Thinking" plus a live preview,
  "Thought for Ns", or "Thought" with no timing), now at the `pl-8` label column like every other
  Spine host's solo body. A run of 2+
  gets a header (`BrainIcon`, "Thought process", no summary, meta "N steps" plus "· Ts" once
  timed) that never spins itself: while ANY member streams the header instead reads "Thinking"
  with the LATEST streaming member's own live preview (gate round 1 fix: `find` picked the FIRST
  streaming member, stale once a later one took over; now `findLast`, see T246) and a
  step-count-only meta (no explicit `triggerAriaLabel`,
  content-computed exactly as the pre-#557 solo live row always was); once every member settles it
  switches to the explicit "Thought process, N steps[, Ts]" name (the #570/#632 lesson: explicit
  beats the browser's own content computation). Members sit on a `SpineList` `<ol>`, keyed by
  `item.id`, never relabelled "Step N". Growing from one to two keeps the header's own open state
  automatically (same `CollapsedLine` instance throughout, only its props and children switch);
  member 1's own nested
  row starts open only if the header was open at the exact render where the run first grew past
  one item (captured once via a lazy ref, mirroring `ToolGroupRow`'s own lifted
  `openDialogItemId`, then cleared by an effect after its first use so a later collapse-then-
  re-expand starts member 1 collapsed again, decision 15), every other member and later mount
  starting collapsed. Default state is
  always collapsed, live and in history; `rowVisibility`'s `'thought-run'` branch is `'visible'`
  or `'hidden'` only, never `'sr-only'` (unchanged from the pre-#557 `'thinking'` branch it
  replaces). `CollapsedLine.tsx` needed no changes: its existing summary-absent flex-1 spacer
  (landed by #565/#570) already pushes meta/chevron to the right edge for a header with no
  summary. Spec 001 amended: FR-009 (the Thought-run sentence, union duration, the 1s floor,
  omission rule),
  FR-047 (Thought run joins the Spine-host enumeration), FR-052 (hidden calls also never break a
  run of thoughts), Scenario 4 under User Story 1, a Clarifications entry dated 2026-10-16
  ("thought runs") recording the decision record's summary. `CONTEXT.md` gained a **Thought run**
  glossary entry beside **Tool group**/**Spine**; `docs/design/product-chat.md` gained a **Thought
  run** bullet and amended the **Thinking**/**Hidden bookkeeping tools** bullets;
  `docs/design/accessibility.md`'s stale `Transcript.tsx:195` citation repointed to
  `ThoughtRunRow.tsx`.

- [X] T245 [US1] Build and verify: `pnpm install --frozen-lockfile`; `pnpm typecheck` clean;
  `node scripts/ci-local.mjs` 16/16 PASS (148 vitest, indentation, theme-contrast, drag-regions,
  IPC parity, file-size, version consistency, OMP schema drift x2, `cargo fmt`/`cargo test`/
  `cargo clippy`, the Tauri debug build, `check:ui-text` 0 leaks across 371 files) --
  `CARGO_TARGET_DIR=C:/Users/shopwood/.cargo-target/refract CARGO_BUILD_JOBS=4` throughout, no
  local `src-tauri/target` left in this worktree. A new committed live-check driver,
  `scripts/verify-557-thought-runs.mjs` (real ambient signed-in `omp`, scratch
  `REFRACT_DATA_DIR`/`WEBVIEW2_USER_DATA_FOLDER`/`REFRACT_IMPORT_SOURCE_DIR`, scratch repo/
  session, `claude-sonnet-5` at "high" reasoning effort via the real `model.setModel`/
  `setThinkingLevel` IPC, Approval mode seeded to Auto in `settings.json`, `SHOTS_DIR` built via
  `path.join(tmpdir(), ...)` rather than a hardcoded literal), reused the shared
  CARGO_TARGET_DIR exe, copied to a private scratch dir and sha256-confirmed unchanged through
  copy, launch, and every check (plus a `'thought-run'`
  grep of the built renderer bundle asserted BEFORE anything else, the #557-only marker). Getting
  a REAL run of 2+ consecutive thoughts needed its own scratch probe first (not committed,
  outside this repo): a model's own message almost always pairs its thinking with EITHER a tool
  call or its own visible text, so two separate messages' thinking items are normally separated
  by a visible assistant-text bubble that ends any run before the next message's thinking even
  starts; the one reliable path found is the harness's own mandatory `todo` bookkeeping tool
  (hidden, FR-052) sometimes called a SECOND time mid-turn with real reasoning immediately before
  it (`stopReason: "toolUse"`, content `[thinking, toolCall]`, no text) -- the hidden notice does
  not flush the run, so that thinking item merges with the next message's own into one real
  2-item `ThoughtRun`. The live-check prompt spells out this exact order (think, call todo, think
  again, THEN answer), with an elongated first reasoning phase to widen the live-catchable window
  (gate round 1), to make it likely, never guaranteed: a real model's own message boundaries
  are not scriptable, so the script treats "the real model did not produce a 2+ member run this
  particular run" as a genuine not-exercised, never a failure, gated behind its own
  `multiRunExercised` flag.

- [X] T246 [US1] Gate round 1 remediation (five-reviewer, 2026-10-16): Code, Tests, A11y and
  `ui-architect-v3` FAILed on one shared High; Security PASSed with two Lows. Fixed: **(1) High**
  `ThoughtRunRow.tsx` returned `<ThoughtItemRow>` for a run of one and `<CollapsedLine>` for two
  or more -- two different element types at the same tree position, so React unmounted and
  remounted the whole row the instant a second thought arrived: keyboard focus on a live solo row
  dropped to `<body>` (decision 17), an expanded solo row snapped shut (decision 14), and the
  lifted `open` state could never carry over to open member 1 (decision 15, `firstMemberDefaultOpen`
  was permanently `false`). Fixed by always returning ONE controlled `<CollapsedLine open={open}
  onOpenChange={setOpen}>`, switching only props and children on `solo` -- the exact `ToolGroupRow`
  pattern this story's own code comments already claimed to follow but did not. An effect now also
  clears the growth-only member-1 `defaultOpen` flag after its first use, so a later collapse-
  then-re-expand of the header (which genuinely unmounts/remounts the `SpineList`, no
  `forceMount`) leaves member 1 collapsed again, per decision 15's own "every later mount starts
  collapsed". **(2) Medium** `liveMember` picked the FIRST streaming member (`find`), not the
  latest (`streaming` is message-wide, so every thought in a still-streaming message reads
  `streaming: true` at once) -- switched to `findLast`. **(3) Medium** the header's own total
  duration had no floor, so it could read "0s" while every member (floored to 1s by
  `formatThinkingSeconds`) read "Thought for 1s" -- several thoughts can genuinely total under
  500ms, since Rust stamps each bound from wall-clock delivery time, not reasoning time
  (`transcript.rs:1192-1197`). Fixed: the header's own total now shares the members' 1s floor
  (`formatElapsed(Math.max(1000, durationMs))`), applied in both the visible meta and the
  accessible name; recorded as a one-line amendment to decision 2/FR-009. **(4) Low** the live-
  check script's own Tab/Escape key events had no `key`/`code` (Chromium only moves focus on a Tab
  keydown whose `key` is literally `"Tab"`), silently downgrading the Tab-into-member check to
  "not exercised" with a wrong guessed cause ("an intervening element") -- switched to the shared
  `pressTab`/`pressEscape` helpers (`verify-tauri-session-list-helpers.mjs`), now a hard
  assertion. **(5) Low docs**: `docs/design/product-chat.md`'s Thinking/Hidden-bookkeeping-tools
  bullets (decision record §6, not touched in the first pass) amended, plus a new Thought run
  bullet; `docs/design/accessibility.md`'s stale `Transcript.tsx:195` 2.2.2 citation repointed to
  `ThoughtRunRow.tsx`; spec.md's Clarifications entry had "two or more **finished** thinking
  items", which decision 3 (the live member is already part of the run) supersedes -- "finished"
  dropped. **(6) Security Lows**: `SHOTS_DIR` now built via `path.join(tmpdir(), ...)` instead of
  a hardcoded literal path; the ambient-profile `OMP_PROFILE` isolation note was flagged optional,
  not changed (matches the established #565/#570 precedent). Added a live **growth-with-focus**
  check (gate's own explicit ask): catch the run solo, keyboard-focus and `Enter`-expand it, poll
  for the run to grow to 2+ members while it is still focused and expanded, then assert
  `document.activeElement` and the header's own DOM node identity are both unchanged, the run is
  still expanded, and member 1 starts open -- then a collapse/re-expand proves member 1 does NOT
  reopen a second time. `node scripts/ci-local.mjs` 16/16 PASS; `pnpm typecheck` clean.

- [X] T247 [US1] Live CDP check, final run against the pushed commit: **PASS, zero failures**
  (`C:/Users/shopwood/AppData/Local/Temp/refract-557-gate1-shots/report.json`, git HEAD
  `99895233da20ecf41b3846f27195377d5a73bb75` -- `git rev-parse HEAD`, the build, and the CDP run
  chained in one command, working tree clean -- exe sha256 `3bd03be5…`). A real
  2-member `ThoughtRun` materialised live and the gate's own growth-with-focus sequence was
  proved: the SAME DOM element that was solo (keyboard-focused, Enter-expanded) was still the
  header after it grew to 2 members, with focus unmoved, the run still expanded, and member 1
  open; collapsing then re-expanding left member 1 collapsed. The settled header read "Thought
  process, N steps" with a total that is never "0s" (the 1s floor), with an AX-tree accessible
  name matching exactly; expands to 2+ members on a `SpineList`, each labelled "Thought for Ns"
  (never "Step N"), member body at `pl-8`; Tab from the expanded header's own trigger (via the
  shared `pressTab` helper) landed on member 1's own trigger; Dark, Obsidian and Dark (high
  contrast) screenshots with the run expanded; no horizontal scroll at 360px; a member's own
  fade-in animation suppressed under `prefers-reduced-motion: reduce`; "Show thinking" off hides
  every thought row entirely (never `sr-only`), restoring it with no reload; "Show tool calls"
  off leaves thought-run visibility unaffected; reopening the SAME `REFRACT_DATA_DIR` after a
  real restart replayed the run with step-count-only meta (no time), matching `capture_timing:
  false` on history replay. Turn (b), a separate turn with a tiny non-reasoning prompt meant to
  exercise the unchanged pre-#557 solo row (no header, no Spine), was **not exercised this run**
  (see `report.json`'s own `notExercised`); the one-thought path WAS seen live as the focused,
  expanded solo row at the start of the growth check above (driver
  `verify-557-thought-runs.mjs:226-232`), and its markup matches the pre-#557 row by
  construction (no code path change for `solo`'s single-thought branch). **Closes #557**: every
  acceptance criterion in the issue, and FR-009/FR-047/FR-052, is proved live against 9989523
  (product code unchanged since), including the growth/focus criterion the round 1 gate found
  unproven.

## Phase 47: Convergence

- [X] T248 [US1] #558 blocker callout (Decided, Skippy, delegated by Stuart 2026-10-16;
  `ui-architect-v3` roundtable, full decision record on the issue): a blocker advisory read as
  one truncated line, identical to a nit, with no file:line extraction, no actions, and no
  collapsing of long concern runs. `AdvisoryRow.tsx` now wraps its `CollapsedLine` output in a
  local wrapper `div` drawing a 3px left accent bar as an absolutely-positioned `before:`
  pseudo-element (zero layout impact, so the icon stays on the shared 24px grid in every
  state) -- the error colour on a blocker row AT ALL TIMES, collapsed or expanded; the warning
  colour on a concern row only while expanded; `CollapsedLine.tsx` itself is untouched, no new
  prop added. A blocker defaults open (`useState` initializer) live or reopened from history
  alike, with no focus steal on auto-expansion -- the row's own mount into the transcript's
  `role="log"` is decision 9's one polite announcement (gate round 2 correction: an earlier
  separate out-of-log hook, `useAdvisoryAnnouncement.ts`, was deleted outright after it turned
  out to still re-announce on a Session/Conversation switch and still double-read a live
  arrival; see T249). The expanded body, in order, shows
  the note, the guidance, then any `path:line`/`path:line:column` location(s) the note or
  guidance names, extracted by a new pure `src/renderer/lib/advisory-locations.ts` (a
  conservative, allowlisted-code-extension regex with a corrected lookbehind anchor so a drive
  letter, a relative or absolute path prefix survives intact, length-capped against
  backtracking, de-duplicated by `path:line` pair), shown as monospace copyable text; the
  shared icon-only `CopyButton` ("Copy advisory"/"Advisory copied": note, guidance and every
  location); and an outline "Ask agent to address this blocker"/"...concern" button, gated on
  the Session's own status exactly as the composer's own send control is (a not-yet-started
  Session is opened first; a stopped-for-another-reason Session disables the button with a
  visible reason), that composes a plain-text message -- the whole advisor payload bounded in
  one `<advisory>...</advisory>` block, with any literal closing tag inside the payload broken
  so it can never close the block early -- and sends it through the existing
  `window.refract.chat.send(sessionId, message)` path unchanged, posted as a real user turn;
  focus returns to the row's own trigger once the send completes, unless the developer has
  since moved focus elsewhere. A nit gets none of this: no accent bar, no Copy/Ask-agent
  actions, same plain expanded body as before. A new pure `groupAdvisoryItems.ts` (modelled on
  `groupThoughtItems.ts`) ALWAYS wraps every run of consecutive concern-severity advisories,
  including a run of one, into an `AdvisoryRun` (`CONCERN_RUN_THRESHOLD = 5`, exported so the
  threshold is a single source of truth); `AdvisoryRunRow` shows every row with no control at a
  run of five or fewer, or the newest five plus a `+ Show N more advisor concerns` button
  (placed above the rows, the hidden ones being the older ones) at six or more, moving focus to
  the first newly revealed row's own trigger on activation. `Transcript.tsx` composes
  `groupAdvisoryItems` into the existing `groupToolItems`/`groupThoughtItems`/
  `groupSubagentStages` chain. `ADVISORY_CLASS`'s `blocker`/`concern` literals renamed to the
  `text-severity-error`/`text-severity-warning` token classes (CSS aliases of identical values
  in every theme). Spec 001 FR-051 amended, two Clarifications entries added (Session
  2026-10-16, blocker callout, plus a gate round 1 amendment); `CONTEXT.md`'s three glossary
  entries corrected to match; `docs/design/product-chat.md`'s Advisory notes bullet amended;
  `docs/PLAN.md` row added; `scripts/theme-contrast-pairs.mjs` gained explicit
  `severity-warning` 4.5:1 text pairs (decision 11 now renders that token as label/summary
  text, previously gated only at the 3:1 non-text floor).

- [X] T249 [US1] Gate round 1 remediation (five-reviewer, 2026-10-16): Security and Tests
  PASSed; Code, Accessibility and `ui-architect-v3` FAILed on two shared High findings, fixed
  above (T248's own description already reflects the fixed state): (1) the blocker's own
  mount-time `aria-live` span sat inside the transcript's `role="log"`, double-announcing a
  live arrival and re-announcing on every remount (Session switch, history reopen, "Load
  earlier") -- moved to one out-of-log announcer. (2) "+ Show N more" unmounted on activation,
  dropping keyboard focus to `<body>` -- fixed with a `useLayoutEffect` focus move, the same
  defect "Load N earlier turns" was fixed for in this same file. Mediums also fixed: the
  accent-bar technique changed from a permanently-reserved `border-l-[3px]` (which shifted
  every row 3px off the shared icon grid) to a zero-layout-impact `before:` pseudo-element; a
  blocker's stripe now shows even while collapsed (a departure from the first pass, reconciling
  decision 1's own two readings); concern runs are now always-wrapped rather than only above
  five, since decision 10's "focus stability is a non-issue" premise was false (decision 13
  deliberately returns focus to a concern's own trigger); the location regex's leading `\b`
  chopped path prefixes (`C:\Repos\x\foo.ts:42` became `Repos\x\foo.ts:42`) -- replaced with a
  lookbehind that also rejects a URL's own host segment with no separate check needed;
  de-duplication now keys on the `path:line` pair, not the raw matched text; Ask-agent now
  mirrors the composer's own send-gating (`MessageInput.tsx`), bounds its payload in one
  delimited block (security), wraps the send in `try/finally`, and only refocuses the trigger
  if the user has not moved on; the body content column, order (note, guidance, locations) and
  wrap behaviour at 360px now match every other `CollapsedLine` consumer
  (`contentClassName={LABEL_COLUMN_CONTENT_CLASS}`). `node scripts/ci-local.mjs` 16/16 PASS;
  `pnpm typecheck` clean; `check:theme-contrast` 427/427.

- [X] T250 [US1] Gate rounds 2 and 3 remediation (five-reviewer each, 2026-10-16): round 2
  (Code/Tests/A11y/architect unanimous) found two new Highs the round 1 live run never checked
  the CONTENT of: (H-A) round 1's own out-of-log `useAdvisoryAnnouncement` hook still
  re-announced on a Session/Conversation switch (`seenRef` never reset) and on "Load earlier"
  (read the windowed turn list), and still double-read a live arrival -- deleted entirely; the
  row's own mount into `role="log"` is decision 9's one announcement by construction. (H-B) the
  `<advisory>` tag wrapper was parsed as a raw CommonMark HTML block by the sanitised Markdown
  renderer and silently dropped from the posted user bubble (live-proven via screenshot) --
  replaced with a fenced block, length-capped, advisor name inside. Round 2 ALSO shipped a
  `FocusHandoffOnUnmount` wrapper meant to hand focus to "+ Show" when a sixth concern hides the
  oldest visible row, conditionally applied only at the overflow boundary -- round 3 (Code/Tests
  High) found this wrapper actually stole focus on EVERY re-render of an overflowed run (its
  cleanup was keyed to an inline callback, a new identity each render), still dropped focus on
  the FIRST overflow (unwrapped below the threshold), and remounted row 0 at the boundary by
  swapping element type. Fixed by wrapping every visible row unconditionally, with an
  empty-dependency cleanup reading the callback through a ref. Round 3 also fixed: the
  advisor-name ask-agent fence now omits the line entirely when unset (not "Advisor: unknown");
  the quoted note's own fence uses a dedicated `advisor-note` info string (`Markdown.tsx`'s
  `code` renderer wraps only this one, every other fence keeps scrolling sideways unchanged); a
  queued (not yet sent) Ask-agent now announces "Queued for agent" via the existing
  `revealedAnnouncement` span, no new one added; the payload truncation no longer splits a
  surrogate pair; the Ask-agent button reverted to `COMPOSER_DISABLED_OPACITY_CLASS` alone (the
  hover-reset class was stripping the outline button's own hover fill); the location regex's own
  comment reconciled its "wrong path is worse than none" principle with the space-containing-path
  and no-space-after-label limitations it still accepts. `node scripts/ci-local.mjs` 16/16 PASS
  both rounds.

## Phase 48: Convergence

- [X] T251 [US7] Issue #917 (Decided, Stuart, 2026-10-16): allow `/advisor` (on, off, status) per
  Session, forwarded to omp, session-scoped and not persisted. `src/shared/slash-commands.ts`
  gains `advisor: ['on', 'off', 'status']` in `SUPPORTED_OMP_COMMANDS`, with a header note
  explaining this one entry was never run by `docs/spike/slash-commands-probe.mjs` (its own
  `DENYLIST` regex names `advisor`, so it sits in `contracts/omp-usage.md`'s "needs-decision"
  bucket) -- included anyway by explicit decision, verified instead by this story's own live
  check against a real signed-in profile. `src-tauri/src/session/agent/commands.rs`'s
  `supported_omp_subcommands` gains the matching `"advisor" => Some(&["on", "off", "status"])`
  arm for TS/Rust parity (kept in step by hand; no automated check covers this table). No
  renderer change: a `ui-architect-v3` roundtable (Decided, Skippy, delegated by Stuart
  2026-10-16) confirmed the other session-scoped on/off/status commands (`fast`, `slow`,
  `extended-context`) carry no indicator anywhere in Refract, so `/advisor` needs no new
  component, store or message kind -- its reply already renders through the existing
  forwarded-command path (a `command_output` frame becomes a transcript `notice` row, same as
  `/usage show`/`/session info`). No Settings toggle. Decided (Stuart, 2026-10-16): no cost
  readout (`advisor_cost_changed` stays unread); `/advisor status` reports spend on demand
  instead; a persistent on/off indicator is tracked separately as issue #937.
- [X] T252 [US7] Update the docs: amended `specs/001-core-session-workspace/spec.md` with a dated
  `### Session 2026-10-16 (advisor command)` Clarifications entry recording the decision, the
  `ui-architect-v3` confirmation, and the probe-bypass rationale; `contracts/omp-usage.md`'s
  "Slash command classification" section gained a paragraph recording `advisor`'s inclusion
  despite staying counted in the unchanged 138 `needs-decision` row (the probe table itself is a
  historical record of that run, not edited); `CONTEXT.md` gained an **Advisor** glossary entry
  distinguishing the subsystem from the existing **Advisory** terms (the note it produces);
  `docs/PLAN.md`'s new Advisor toggle row records #917 and #475 (the related, broader "enable the
  advisor at all" OMP-feature-batch row, not a duplicate: #475 is about whether Refract ever
  launches omp with the advisor on at all, #917 is narrowly the in-app per-Session switch).

This phase was written retroactively after the implementation above, in the same session that
built it (no prior `/speckit.plan`/`/speckit.tasks` pass covered issue #917). `node
scripts/ci-local.mjs` (16/16) was run after the build; see the PR body for the exact result and
the live-check evidence (a scratch Tauri debug instance, `/advisor status`, `/advisor on`, a real
turn, `/advisor off`, and the slash menu listing).

## Phase 49: Convergence

(Renumbered from provisional Phase 48/T251-T252 to Phase 49/T253-T254: PR #923 (#917) merged into
`main` first and claimed Phase 48/T251-T252.)

- [X] T253 [US5] #559 session search (Decided, Skippy, delegated by Stuart 2026-10-16;
  `ui-architect-v3` roundtable, full decision record on the issue): built the shared
  `SearchField` component (`src/renderer/components/SearchField.tsx`, docs/design/components.md
  "Reusable components first", #934 decision 5) -- a leading magnifier, Esc-clears, a clear (x)
  button shown only while there is text, and the forced-colours focus fix every other toolbar
  control in this nav already carries. Placed in `SessionList.tsx` in the slot #735 decision 26
  reserved (between Pull requests and the Collapse all/Expand all toolbar, which moves from
  `mt-4` to `mt-2`), inside its own `role="search"` landmark at the call site. The matcher
  (`matchesNameOrBranch`/`matchesSessionSearch` plus `showingCountLabel`, moved into
  `sessionDisplay.tsx` so Manage sessions' own filter and this field share one substring check
  rather than two) narrows what the list already shows: a Project group renders only once at
  least one of its own non-archived Sessions matches (name, branch, or Project name), showing
  only the matching rows, and Archived is searched the same way against each row's own Project
  name. `session-list-store.ts` gained `query`/`setQuery` and an ephemeral `searchOverride`
  (created empty -- every group open -- the instant the trimmed query goes empty to non-empty,
  discarded, not merged back, the instant it empties again) plus a new `isArchivedGroupOpen()`
  selector (`ArchivedGroup.tsx` switched onto it, replacing its own raw `archivedOpen` read) so
  every Group header and the Collapse all/Expand all toolbar stay fully interactive during a
  search without ever writing `Settings.sessionListCollapse`. Zero matches render the shared
  `Empty` compound ("No sessions match", a Clear filter button); the shown-versus-total count is
  announced politely, debounced 500ms while typing (`ManageSessionsScreen.tsx`'s own established
  pattern), with an immediate "Filter cleared" once the query empties. `App.tsx`'s Ctrl+N
  fallback, when the quick-create button is absent specifically because the search hides every
  Project, now focuses the search field and asks for the filter to be cleared, instead of its
  older, now-inaccurate "open the session list" wording. No keyboard shortcut added to focus the
  field this story (deferred, decision 24); no new `Settings`/IPC surface (the query is never
  persisted). Per FR-071, US5/AC8.
- [X] T254 [US5] Update the docs: amended `specs/001-core-session-workspace/spec.md` with new
  FR-071, a dated `### Session 2026-10-16 (session search)` Clarifications entry, US5 acceptance
  scenario 8, and a new Edge Cases bullet for a zero-match search; `docs/design/product-
  layout.md`'s session list paragraph gains the search field's own line; `docs/design/
  components.md` records that the proposed `SearchField` (#934 decision 5) is now built, by
  this story; `docs/PLAN.md` gets this story's own row.

**Gate rounds 2-3 addendum**: Main's five-reviewer gate (round 1) found the `typeSearch` live-
check helper only ever appending via `Input.insertText`, never clearing first, which doubled
earlier text onto later queries and broke screenshot 03; fixed with real Ctrl+A/Backspace key
events first. Branch matching, case-insensitivity, a query surviving a Session switch, Shift+Tab,
and zero matches hiding Archived (once one exists) were claimed but never actually driven live --
all five are now real live steps. `useSessionRowActions.ts` gained the #900 focus-redirect
pattern for a Session row's own rename. Round 2 (ui-architect-v3) then found: the Project half of
that same #900 fix was still open (a Project rename left focus on `<body>`, fixed by a new shared
`useFocusSearchOnStrandedUnmount` hook used by both `useSessionRowActions.ts` and
`RepositoryGroup.tsx`, gated on a non-empty query); the "real contrast bug" PR claim was wrong
(`--input` is itself translucent, so `dark:bg-input/30` composites far lighter than 30% -- the
field's own default fill actually clears 4.5:1 comfortably; the opaque `bg-background` override
was reverted, and `theme-contrast-pairs.mjs` gained the real composited `searchFieldContrastRows`
check instead); the hidden-create announcement could be silently replaced by a plainer one from
a racing call site, fixed with one shared `createdSessionAnnouncement()` used everywhere; Esc on
the SearchField wrapper (not just the input), `inputProps`'s `Omit`-narrowed type, one shared
`sessionSearchSelector.ts` for the `data-session-search-input` hook, a stale screenshot sitting in
the evidence folder, and a tooltip-ghost in screenshot 03 were all fixed; a D20/D28 amendment
comment was posted on #559 and the PR body's Departures section corrected.

## Phase 50: Convergence

- [X] T255 [US1] #560 quiet alert rows (Decided, Skippy, delegated by Stuart 2026-10-16;
  `ui-architect-v3` roundtable, full decision record on the issue). `ProfileAlertRows.tsx` (new)
  renders two single-line rows as `App.tsx` siblings directly after `<ProfileItem/>`, replacing
  `StatusBar.tsx`'s own low-memory and unverified-omp-version `Popover`s (its update badge is
  unchanged). Low memory keeps a "Triage" action, now opening `MemoryTriageDialog.tsx` (new): a
  `Dialog` listing every Session whose agent is `idle` -- never `working` (mid-turn) or
  `needs-you` (waiting on the user), never already `stopped` -- each with a confirmed Stop
  (`AlertDialog`, naming the Session) and one "Stop idle" bulk confirm targeting every listed
  Session at once; no per-agent memory figure, since no per-process memory API exists anywhere
  in src-tauri and none is added by this story. Unverified version keeps a "Check" action
  opening the existing `HealthCheckDialog`; `ProfileAlertRows.tsx` mounts its own independent
  instance (its own `open` state and its own `onCloseFocus`), and `ProfileItem.tsx` keeps its
  own, unchanged instance for the profile menu's Health check item -- the dialog itself supports
  more than one caller, each owning its own open/close state and its own focus-restore target.
  Each row dismisses for the run only
  (two local booleans in `ProfileAlertRows.tsx`, never persisted) -- a restart naturally re-arms
  both, satisfying "the alert returns if the condition persists after a restart" with no extra
  logic. Per FR-037 (amended) and new FR-072.
- [X] T256 [US1] Gate remediation (round 1, four reviewers, one High/High pair confirmed live by
  a CDP run): `MemoryTriageDialog.tsx` gained busy guards on both confirm flows (Escape and
  Cancel blocked while a stop is in flight, `stoppingId`/`bulkStopping` gate re-entry), a live
  re-check of each Session's `idle` status at confirm time (not the snapshot taken when its own
  Stop button was clicked), a latched last-known confirm target/count (no more text flicker
  during the close animation), a computed post-stop focus fallback (the next remaining row's own
  Stop button, else "Stop idle", else the dialog's own now-focusable heading -- never a button
  the same stop just removed), and `finally`-wrapped `stopAgent` calls so a rejected IPC call
  can never leave the dialog stuck on "Stopping…". `ProfileAlertRows.tsx`'s announcements moved
  from a local `useClearedAnnouncement` region (silenced while the nav column is `inert`) to the
  shared, always-mounted `useChatAreaAnnouncer` App.tsx already renders outside that collapsible
  subtree, with the two conditions joined into one announcement when both first appear in the
  same commit (two separate `announce()` calls in the same tick cancelled each other); its own
  outer padding is now conditional on a row actually showing (`empty:p-0` never matched, since
  the row always contained the old live region); and "N agents" is pluralised correctly (matches
  the retired `StatusBar.tsx`'s own `pluralAgents`). The bulk confirm's own destructive button now
  reads "Stop idle" (was "Stop all", which could be misread as every agent including a working
  one). Live-verified by `scripts/verify-tauri-560.mjs` (see T257).
- [X] T257 [US1] Live CDP check (`scripts/verify-tauri-560.mjs`, new, following
  `verify-tauri-559.mjs`'s own structure): isolated scratch launch per
  `refract-tauri-live-check-isolation`, with `REFRACT_FORCE_LOW_MEMORY=1` (an existing,
  pre-reviewed `#[cfg(debug_assertions)]` test knob in `shell/memory.rs`, not added by this
  story) forcing the low-memory condition, and the fake-omp harness's own hardcoded
  `omp/18.10.1` version (already outside the specifically re-probed 18.8.x range per
  `readiness.rs`) triggering the unverified-version condition with no script changes to the app
  needed for either. Proved live: both rows appear with the exact copy; Triage lists a created
  idle Session and a confirmed Stop actually stops it; a second idle Session plus "Stop idle"
  stops it via the bulk confirm, emptying the list; dismissing each row hides it immediately and
  it does not return on its own within one more memory-sampler tick even though the forced
  condition still holds; Check opens the real `HealthCheckDialog` showing a genuine
  "Passed with a warning" omp row; a keyboard-only pass (Tab/Enter) reaches and activates the
  Check action; every named control's accessible name read via the CDP Accessibility domain
  (never `textContent`). All checks passed (exit 0); nothing reported as not-exercised. Evidence
  (`report.json`, screenshots with their own sha256, `git rev-parse HEAD`) under
  `C:/Users/shopwood/AppData/Local/Temp/refract-560-shots/`.
- [X] T258 [US1] Update the docs: amended `specs/001-core-session-workspace/spec.md` with the
  reworded FR-037, new FR-072, and a dated `### Session 2026-10-16 (quiet alert rows)`
  Clarifications entry; amended `specs/008-profile-and-accounts/spec.md` FR-029 to cross-reference
  both instead of duplicating them; `CONTEXT.md` gained the **Alert row** glossary entry (the term
  the **Waiting marker** entry's own `_Avoid_` line had already reserved for this issue);
  `docs/PLAN.md` gets this story's own row. Gate-round corrections: this same task's own T255
  entry above is corrected to describe the HealthCheckDialog's TWO independent instances built
  (never a lift into App.tsx, which would have raised App.tsx's own file-size baseline back over
  its cap); `contracts/ipc.md`'s `memory:warning` row and `memory-store.ts`'s header comment no
  longer call this the status bar's notice; `HealthCheckDialog.tsx`'s own doc comment names both
  of its callers.
- [X] T259 [US1] Gate remediation (round 2, Code/Tests FAIL -> fix): three findings, Decided
  (Skippy, delegated by Stuart 2026-10-17), recorded on #560.
  **F1** (focus theft on blank-space click): the round 1 focus-redirect fix's `focusout`
  listener treated `document.activeElement === document.body` alone as proof the row's focused
  descendant had been removed from the DOM, but an ordinary click on blank space (anywhere with
  no focusable target) ALSO blurs the active element to `<body>` without removing anything --
  the previous version stole focus straight back to the row every time. `ProfileAlertRows.tsx`
  now additionally checks that the actual element leaving focus (`event.target`) is no longer
  connected to the document (`describesRemoval()`) -- only a genuine removal causes that; a
  blank-space click leaves the same button sitting there, still connected, so nothing redirects.
  Keyboard focus-return after closing Triage (the dialog's own `onCloseAutoFocus`/`onCloseFocus`
  path) is a separate mechanism, unaffected.
  **F2** (failed Stop announced as success): `sessions-store.ts`'s `stopAgent` resolved
  `Promise<void>` unconditionally, so a clean `{ok:false}` stop response (already toasted by the
  store itself) was announced via `useChatAreaAnnouncer` as a SUCCESS regardless; in bulk,
  `Promise.allSettled`'s `status === 'rejected'` filter never matched a clean failure either, so a
  partly- or wholly-failed bulk stop always reported every target as stopped. `stopAgent` now
  resolves the real `result.ok` boolean (matching `archive`/`restore`'s own established pattern,
  `sessions-store.ts` interface doc comment added); `MemoryTriageDialog.tsx`'s single and bulk
  confirm flows announce the true outcome, naming the failing Session(s) by name where available
  ("Couldn't stop {name}'s agent" / "Couldn't stop {N} agents: {names}"), joined with any success
  count into ONE `announce()` call for a partial bulk result (two calls in the same tick cancel
  each other, `chatAreaAnnouncer.ts`).
  **F3** (spec/UI mismatch on the agent count): FR-037 still promised "Low memory ({N} agents)"
  on the row itself, but round 1's own "honest agent count" fix (`ProfileAlertRows.tsx` item 5
  comment) had already dropped it, since the system's live-agent count (idle+working+needs-you)
  and Triage's idle-only list can legitimately differ. FR-037 reworded to match (the row says
  just "Low memory"); a new dated Clarifications entry (`### Session 2026-10-17 (quiet alert
  rows, gate round 2)`) records the decision; `MemoryTriageDialog.tsx`'s own `DialogDescription`
  now actually states the idle count its comments already claimed it did ("N idle agents using
  memory..."); `docs/PLAN.md`'s #560 row gets this round's own summary.
  `pnpm typecheck` and `pnpm vitest run` clean; `node scripts/ci-local.mjs` and a fresh live CDP
  run (`scripts/verify-tauri-560.mjs`, extended to prove F1 and F2) -- see T260.
- [X] T260 [US1] Live CDP check, gate round 2 (`scripts/verify-tauri-560.mjs`, extended; new
  `scripts/verify-tauri-560-gate2.mjs` split out to keep the main file under the #806 600-line
  cap): proves F1 live -- clicking the low-memory row's own non-focusable label (a real
  blank-space click inside the row) while Triage is focused leaves focus on `<body>`, never
  stolen back onto an alert row's own control; a keyboard-driven Dismiss of the last remaining
  row (Tab + Enter) leaves focus on the profile item's own name button, never a disconnected
  node. Proves F2 live -- `window.refract.sessions.stopAgent` monkey-patched in the renderer
  (no real process touched) to force one Session's Stop to resolve `{ok:false}`, single and via
  bulk "Stop idle" (n=1, reusing the one idle Session rather than a second concurrently-idle
  one -- issue #512's real low-memory start-defer feature, triggered the whole run by this
  story's own `REFRACT_FORCE_LOW_MEMORY=1`, would otherwise defer a second Session's start for
  up to its own 60s ceiling, confirmed live racing this script's own equal 60s wait): both
  announce the real failure, naming the Session, never success; the toast reads "Couldn't stop
  {name}'s agent. Try again."; the Session stays listed since it was never actually stopped.
  Two further bugs found and fixed by this same live-check work, neither part of F1/F2/F3 but
  blocking a clean run: a WebView2/CDP input-timing click race on destructive confirm buttons
  (a synthetic click immediately after a dialog/AlertDialog opens is an intermittent one-shot
  miss in this harness, confirmed via `app.log` showing zero second `stopAgent` IPC call ever
  reaching the backend when it struck -- settle-sleep guards added at every remaining site that
  lacked one), and the keyboard-Dismiss focus bug named under F1 above (Radix Tooltip's own
  Portal content re-stealing focus on its trigger's removal -- fixed by moving the redirect to
  the Dismiss click site itself, proactively, before the row is ever removed). `node
  scripts/ci-local.mjs` 16/16 PASS and this live check ALL PASS (exit 0, nothing not-exercised)
  together on the same final HEAD `91f73e1`; `report.json`'s own `gitHead` matches. Evidence
  (`report.json`, `report.txt`, `app.log`, six screenshots with their own sha256) under
  `C:/Users/shopwood/AppData/Local/Temp/refract-560-shots/`.

## Phase 51: Convergence

- [X] T261 [US1] #927 quiet composer (v0.3.0 feedback item 4, Decided, Skippy, delegated by
  Stuart 2026-10-16 -- grilled, all resolved on the issue): in Dark and Obsidian the message
  box's fill is now `transparent` (`globals.css`'s `--composer-background`, was a solid literal
  per theme) with a faint new `--composer-border` token (aliases `--divider`) replacing the
  literal `border-muted-foreground/85` class; the field's own focus-visible state now reads a
  new `--composer-focus` token for its border colour and a new `--composer-ring` token for its
  glow (`transparent` in these two themes -- no glow, a quiet border-colour change is the whole
  cue -- `MessageInput.tsx`). The Approval mode pill, Model picker and Reasoning picker
  (`pickerShared.tsx`'s shared `PICKER_TRIGGER_CLASS`) move from `badgeVariants({variant:
  'outline'})` to `badgeVariants({variant: 'ghost'})` (reused, no new classes, `docs/design/
  components.md` "Button"), with an explicit resting-muted/hover-foreground text-colour pair
  (the same convention `ReadoutChip.tsx`'s own interactive style already uses) overriding
  `ghost`'s own opposite-direction hover colour via `cn`'s tailwind-merge. A new `GHOST_FOCUS_
  CLASS`/`GHOST_BUTTON_FOCUS_CLASS` pair (`pickerShared.tsx`) reads `--composer-focus` for these
  four controls' own focus outline, split out from the unchanged `COMPOSER_FOCUS_CLASS`/
  `COMPOSER_BUTTON_FOCUS_CLASS` (still `--ring`, still used by Send/Stop only -- "Send and Stop
  are unchanged"). Dark (high contrast) is explicitly excluded: its `--composer-background`
  stays its old opaque literal, and its new `--composer-border`/`--composer-focus`/
  `--composer-ring` tokens are byte-for-byte token-izations of the prior literal classes
  (`color-mix(in oklab, var(--muted-foreground) 85%, transparent)`, `var(--ring)`, `color-mix(in
  oklab, var(--ring) 50%, transparent)` respectively) -- nothing it renders changes. `scripts/
  theme-contrast-pairs.mjs`: the now-obsolete `border`/`composer-background` pair (the Approval
  pill's old opaque outline border, gone now that it is `ghost`) removed; `send`/`composer-
  background` and `muted-foreground`/`composer-background` scoped to Dark high contrast only (a
  new `send`/`background` pair covers Dark/Obsidian instead, where the fill is transparent);
  `ring`/`composer-background` replaced by `composer-focus`/`composer-background` (enforced,
  Dark high contrast only) plus two new `composer-border`/`composer-focus` vs `background` pairs
  marked `informationalThemes: ['dark', 'obsidian']` (a new per-pair schema field, computed and
  printed but never counted toward the gate's pass/fail, for Stuart's own accepted departure).
- [X] T262 [US1] Update the docs: amended `docs/design/product-chat.md`'s "Message box" and
  "Composer tone" bullets (the latter replacing its 2026-10-04 "strictly darker than the page"
  rule with the new transparent-fill/faint-border/ghost-control/muted-focus rule, per the issue's
  own grill), `docs/design/foundations-tokens-theming.md`'s "Canvas colour" bullet (superseded
  note already landed with the issue's own filing, `docs/PLAN.md` commit 1e191f9), and `docs/
  design/accessibility.md`'s "Accepted departures" (already landed the same way); this story adds
  `specs/001-core-session-workspace/spec.md`'s FR-040 and US1 acceptance scenario 11 amendments
  and this `### Session 2026-10-16 (quiet composer)` Clarifications entry; `MessageInput.tsx`'s
  own composer-box comment and composer-dimming comment are rewritten to match (the Approval
  pill's border-for-WCAG-1.4.11 reasoning no longer applies outside Dark high contrast); `docs/
  PLAN.md`'s "v0.3.0 feedback" row gets an in-flight note for #927/#928 (shipped together per its
  own "Suggested order" line) with this story's PR link.

This phase was written retroactively after the implementation above, in the same session that
built it (no prior `/speckit.plan`/`/speckit.tasks` pass covered issue #927; a no-build prep
lane, per `docs/PLAN.md`'s own working rules). `pnpm typecheck`, `pnpm vitest run` (148 tests),
`node scripts/check-indent.mjs` (0 odd-indent lines) and `node scripts/check-theme-contrast.mjs`
(436 of 436 enforced pairs PASS across 3 themes, informational Dark/Obsidian composer-border/
composer-focus pairs printed but not counted) all ran clean after this change; `pnpm build`/
`pnpm check:ui-text`/the new CDP live check (`scripts/verify-927-928-quiet-composer.mjs`, written
but deliberately not run, per this prep lane's own NO BUILDS rule) are left for the build lane
that picks this PR up.

## Phase 52: Convergence

(Renumbered from provisional Phase 51/T261-T263: PR #951 (#927/#928) merged into `main` first and
claimed Phase 51/T261-T262.)

- [X] T263 [US1] #632 borderless thread for grouped tool calls and bash/grep/glob/read calls
  (supersedes #430; close #430 when this lands). Amended spec 001 -- FR-008 (a multi-call
  group's own header reads the tool name plus the run's own count, "bash ×2", never a call's
  own command; the group's own total time, the sum of every member's own duration, joins the
  "N failed"/"N interrupted" counts in the meta slot), FR-061 (a row's own command text wraps
  instead of truncating once the row itself is expanded) -- plus a dated
  `### Session 2026-10-17 (grouped and command-style calls)` Clarifications entry recording the
  decision to skip a derived result for `grep`/`glob`/`find`/`read` (no fixture-backed OMP
  output shape in this codebase to probe first, unlike `bash`'s own gated footer) and the
  "Explored" supergroup staying out of this slice per the issue's own default. `git diff
  --numstat origin/main -- specs/001-core-session-workspace/tasks.md` confirmed 0 deletions
  before this phase was appended.

- [X] T264 [US1] Implementation, renderer-only (no Rust/cargo touched; `extract_target` in
  `src-tauri/src/omp/transcript.rs` already gives every row its own raw target string, so no
  transcript-builder change was needed): new `formatToolCommand.ts` (`commandRowText`) gives
  `bash` its own `$ <first line of the command>` row text and `grep` its own
  `grep "<pattern>" <path>` (the path read off the call's own `args` only when it is a plain
  string, never guessed); `glob`/`find`/`read`/`write`/`edit` keep showing `item.target`
  untouched (a `read`'s own `:start-end` range, when given, already lives inside that string).
  `ToolRow.tsx`'s `ToolGroupRow`: a multi-call group's own `label` becomes `${tool} ×${count}`
  (bare tool name for the aria composition, kept separate so the accessible name never doubles
  "2 calls" and "×2"), its `summary` drops the old "last call's target + N others" text
  entirely, and its `meta` gains the run's own total duration (summed across members, shown only
  once settled, and only when every member carries its own duration -- gate round 1 fix, M6)
  alongside the existing failed/interrupted counts, joined by a new shared `joinMetaParts` helper
  (the exact visible-middot-plus-sr-only-comma grammar #570 established, now reusable instead of
  hand-copied). A new `callMeta` helper (later moved into `toolRowLabels.tsx`, gate round 2) gives
  one call's own row (solo or nested `ToolCallRow`) its duration plus, for a SETTLED
  (`status === 'done'`, gate round 1 fix, H3) `edit` call, its own neutral "+N −M" added/removed
  line stat (gate round 1 fix, H5: dropped the coloured `text-state-working`/`text-destructive`
  classes that broke #570's "success stays neutral" rule) -- a new `diffStat`/`countChanges`
  export in `lib/diff.ts`, reusing the same `buildUnifiedDiff`/`parseDiff` pipeline
  `DiffView.tsx`'s own expanded-body stat now also calls (gate round 1 fix, H2: one shared
  counter, plus a `maxEditLength` cap and a memoising `WeakMap` keyed on `item.edit` so an
  unbounded diff is never recomputed on every render), so the two can never disagree; `write`
  gets no such stat (no prior read/edit content is cached to diff it against, #630's own open
  idea, not built here). A command-style (`bash`/`grep`) row's own separate tool-name label is
  dropped, solo and member alike (gate round 1 fix, M2: the row's own command-style summary
  already names the tool, "grep grep ..." read as a duplicate); each row's own
  `triggerAriaLabel` is built explicitly from `commandRowText` (gate round 1 fix, M1, WCAG
  2.5.3: the visible text and the accessible name's own description of it can never diverge),
  including the member row, which previously had no explicit accessible name at all. A
  multi-call group's own collapsed Error line is now always prefixed with the failing call's
  own `commandRowText` (gate round 1 fix, M5: the group header's `summary` no longer names any
  call at all, so the old "only when it differs from the last call" condition no longer holds).
  `CollapsedLine.tsx`: a row's own summary now wraps (`break-words whitespace-normal`, not
  `truncate`) once `actualOpen` is true for a tool row specifically, through an opt-in
  `wrapWhenOpen` prop (gate round 1 fix, H4: NOT every `CollapsedLine` consumer, which would
  have wrapped callers that never asked for it) -- fixes the issue's own bug #2 ("the command is
  cut off twice") without adding any new Arguments/Output block (#628's own rule is unchanged;
  gate round 1 fix, H6: a `bash` call's own quiet-summary output text is now skipped entirely on
  expand, matching the issue's own "no output text" acceptance). The Subagents panel needed no
  changes of its own: it already renders through the same `ToolGroupRow` (design point 4), so
  every change above applies there automatically.

- [X] T265 [US1] Gate round 1 remediation (code-reviewer/accessibility-auditor/ui-architect-v3/
  test-reviewer, High/Medium/Low findings, all fixed): H1 (verify-565-spine.mjs/
  verify-570-tool-colours.mjs's own `BASH_HEADER_FINDER` broke on the new "bash ×N" label, fixed
  to match it; verify-565's own "+ N other(s)" multi-group detection, removed by #632, replaced
  with a "×N" suffix match) through H6, M1 through M8 (`scripts/verify-632-grouped-calls.mjs`
  rewritten: no command text in a collapsed header's own summary span; the total time equals the
  sum of member durations; member-button queries scoped to the first group; the expanded check
  reads computed `white-space` and asserts no `pre`/`code`/`[data-slot="code-block"]`; the
  Subagents panel asserts "1 failed · <total>"; `notExercised.length > 0` now fails the run; new
  assertions added for hover-tints-one-row, the ~4-line expanded height, keyboard Tab reaching
  every row with a visible focus outline, each member's accessible name, and hostile ANSI/long-
  line output rendering inert and bounded), and LOW (verify-632's own `stopLauncher` catch now
  logs its error instead of swallowing it silently). Spec amended: FR-008/FR-061 corrected to
  drop the stale "prefix only when it differs from the last call" wording (M5); FR-061's own
  "single line, 200 characters or fewer, shows verbatim" rule now excludes `bash` (H6); a new
  dated `### Session 2026-10-17 (gate round 1)` Clarifications entry records M2/M4/M5/M6.

- [X] T266 [US1] Gate round 2 remediation (Main's own review of the gate round 1 live-check
  evidence, D1 through D11 plus two corrections, all fixed): D1 `CollapsedLine.tsx`'s row is
  `items-start`, not `items-center` -- the icon slot (`h-5 w-4`), the chevron's own wrapper
  (`h-5`) and the meta span (`leading-5`) now match the label's 20px line box instead of sitting
  2-3px high on a single-line row. D2 the edit stat's own sr-only text was never announced under
  an explicit `aria-label` -- folded into both triggers' own `aria-label` arrays instead, sr-only
  span dropped. D3 `COMMAND_STYLE_TOOLS` is now a `Set` (Security Low); `grep`'s own prefix
  dropped from its aria-label/solo-group label (duplicate word). D4 a diff that aborts past
  `MAX_EDIT_LENGTH` now returns a distinct `undefined` (vs `''`), rendering "Diff too large to
  show" instead of "No changes". D5 the "..." marker now counts non-empty lines only. D6 stale
  doc text reworded (`spec.md`, `product-chat.md`, `CollapsedLine.tsx`'s `summaryWrap` comment).
  D7 decision comment posted on #632; follow-up issue #958 filed (grep/glob/find/read counts, a
  `write` diff stat, the Explored supergroup) and added to `docs/PLAN.md`. D8 the member-expand
  "no code block/output" check no longer passes vacuously when the content region itself was
  never found; `GROUP_HEADERS` excludes an expanded group's own member buttons. D9 the turn (f)
  hostile-output check no longer fails on the Error line not containing the hostile text (the
  out-of-scope `errorLine()`/OMP line-order gap, **#650**) -- recorded as a finding instead; the
  reliable assertion moved to the row's own summary span, checked collapsed and expanded, which
  still requires the hostile content present. D10 hover check extended to an expanded group's
  own member row. D11 removed a stale "#628 was live-checked" claim. Second correction: `ToolRow.
  tsx` split (`#806`) -- `joinMetaParts`/`cachedDiffStat`/`editStatForItem`/`diffStatAriaText`/
  `callMeta` moved into new `toolRowLabels.tsx`, back under the 600-line cap, no baseline entry.
  Two more script-only bugs found live during the final chained run (both pre-existing,
  `errorLine()` itself unchanged by this story): `verify-632-grouped-calls.mjs`'s own D10 check
  captured its "before" hover baseline without resetting the mouse off the header first (the
  expand click leaves it there) -- fixed. `verify-570-tool-colours.mjs` had a case-sensitivity
  bug (`/Exited .../` vs OMP's real lowercase "exited" text) and one more instance of the #650
  line-order gap in its own solo-failed-call check -- fixed/softened the same way as D9.
  `pnpm typecheck`/`pnpm vitest run`/`check:indent`/`check:file-size`/`check:ui-text` all clean;
  `node scripts/ci-local.mjs` 16/16 PASS and `scripts/verify-632-grouped-calls.mjs`/
  `verify-565-spine.mjs`/`verify-570-tool-colours.mjs` all exit 0 (0 failures each) on this
  phase's own final head -- see PR #950 for the exact commits, report.json gitHeads and
  screenshot evidence.

Opened as draft PR #950 (`feat/632-grouped-calls`). **Closes #632** and **Closes #430**: every
one of the issue's own acceptance bullets (no border at any level, the collapsed header's tool
plus count plus failed plus total-time grammar, the failed call's own visible Error line, the
wrap-on-expand fix, the ~4-line expanded height, hostile-output rendering inert and bounded both
collapsed and expanded, keyboard/accessible-name form, and a live Subagents-panel check) was
confirmed live on a real scratch instance across gate rounds 1 and 2.

## Phase 53: Convergence

- [X] T267 [US1] #554 chat reading width setting. Amended spec 001 -- FR-049's own closing
  parenthetical now reads exactly: "(amended 2026-10-18, issue #554: \"the transcript column\"
  is now whichever width FR-073's Chat width setting chooses, Full or Reading column -- in
  both, no element may add an even narrower measure of its own inside that column)" -- and new
  FR-073 (the Full/Reading column
  Settings choice, Save/Cancel live preview, the 64rem cap, no special-cased narrow-window
  breakpoint) -- plus a dated `### Session 2026-10-18 (chat reading width)` Clarifications entry
  recording the ui-architect-v3 roundtable ruling: the existing unconditional `max-w-4xl` on
  `MessageScrollerContent` (authored 2026-10-08, same day as the #474 grill) was an incidental
  stopgap, not a deliberate "Reading column" -- "Full" removes it entirely (edge to edge);
  "Reading column" is the issue's own 64rem/padding-ladder design; the composer, status line,
  brand watermark (spec 012) and scroll-to-end button all stay unaffected by the choice. `git
  diff --numstat origin/main -- specs/001-core-session-workspace/tasks.md` confirmed 0 deletions
  before this phase was appended.

- [X] T268 [US1] Implementation. Renderer: `Settings.chatWidth: ChatWidth` (new
  `src/shared/chatWidth.ts`, its own file rather than inline in `model.ts`/`ipc.ts` -- both
  already at their own `check:file-size` baseline with no slack, the same reasoning `ThemeId`
  already lives in `themes.ts` rather than `model.ts`; `TranscriptDisplaySettings` moved out to
  `transcriptDisplay.ts` (re-exported from `model.ts` for the same reason); `LowMemoryWarning`
  moved out of `ipc.ts` into `model.ts` for the same reason (re-exported from `ipc.ts`) --
  zero behaviour change, every existing import keeps working); `settings.setChatWidth`
  IPC method (`shared/ipc.ts`, `tauri-bridge/index.ts`); new `chat-width-store.ts` mirroring
  `theme-store.ts`'s `preview`/`save`/`cancelPreview` shape exactly (no `chatWidth.preview` IPC
  round trip -- unlike theme, there is no main-process effect for a reading-width preview to
  apply, so preview is renderer-local only); new `ChatWidthPicker.tsx` mirroring `ThemePicker.tsx`
  (hand-rolled roving-tabindex radiogroup, two entries); `AppearanceSection.tsx` extended so its
  Save/Cancel row, Escape handler, focus-restoration query and unmount-revert effect all cover
  both pickers. `Transcript.tsx`'s `MessageScrollerContent` className is now conditional on
  `useActiveChatWidth()`: `'w-full px-4 py-4'` (Full) vs `'mx-auto max-w-[64rem] px-6
  @min-[40rem]:px-10 @min-[48rem]:px-14 @min-[64rem]:px-16'` (Reading column, gate round 2 fix
  M1 -- the padding ladder is now a Tailwind v4 arbitrary container query keyed off the chat
  pane's own `[container-type:size]` ancestor, not the window, so a narrow window with a wide
  pane reads correctly), replacing the old unconditional `max-w-4xl mx-auto`.
  Rust: `ChatWidth` enum (new `src-tauri/src/store/chat_width.rs`, re-exported from
  `store::settings`, the same file-size-slack reasoning as the TS side), `Settings.chat_width`
  field, `SettingsStore::set_chat_width`, and the `settings.setChatWidth` IPC handler
  (`ipc/settings.rs`), registered in the dispatcher (`check:parity --gate` 99/99 requests).

- [X] T269 [US1] Docs and live check. Updated `docs/design/product-chat.md`'s "Chat text fills
  the full width..." bullet, `docs/design/product-first-run-and-settings.md`'s "Settings in the
  first build" list (Chat width: shipped, Appearance section, Full/Reading column, Save/Cancel
  live preview), `CONTEXT.md` (a **Chat width** glossary entry), `specs/001-core-session-
  workspace/data-model.md` (`Settings.chatWidth`), `contracts/ipc.md`
  (`settings.setChatWidth`) and `docs/design/foundations-typography-spacing.md`'s "Reading
  width" section (now describes the shipped Setting, not the pre-#554 placeholder); `docs/PLAN.md`'s
  UI-refresh row gets an in-flight note for #554. `scripts/verify-554-chat-width.mjs` (new,
  modelled on `verify-927-928-quiet-composer.mjs` and `verify-tauri-scratch-helpers.mjs`):
  default Full at 1280/1920px (column fills its viewport, no cap), Reading column via mouse AND
  via keyboard (Tab/Arrow/Enter) with live preview measured at 1280/1920/2560px before Save
  (64rem width, centred margins equal), composer width unchanged across both options, no
  horizontal scroll at 360px, and persistence across a full relaunch of the same built exe
  against the same scratch `REFRACT_DATA_DIR`. Run live, under a shared build slot, across
  several rounds -- not merely written: found and fixed two real bugs along the way (a pid/
  dataDir ownership collision from clicking the session-list row before the relaunch's own CDP
  target settled; the relaunch-persistence assertion itself needing to measure at 1920px, the
  one width where the 64rem cap unambiguously binds, not 1280px where Full and Reading column
  are indistinguishable). Final run before gate round 2 review: 16/16 PASS, 0 failures, 0
  `notExercised`, four screenshots and `report.json` captured. `pnpm typecheck`, `pnpm vitest
  run` (148 tests), `node scripts/check-indent.mjs` (0 odd-indent lines), `node
  scripts/check-theme-contrast.mjs` (437 of 437 pairs PASS across 3 themes), `node
  scripts/check-file-size.mjs` (0 cap violations, three pre-existing-baseline files --
  `ipc.ts`, `model.ts`, `Transcript.tsx` -- kept at or under their recorded baseline via the
  `chatWidth.ts`/`transcriptDisplay.ts`/`lowMemoryWarning.ts` extractions above),
  `node scripts/check-parity.mjs --gate` (99 of 99 requests, 23 of 23 events) and `node --check
  scripts/verify-554-chat-width.mjs` all ran clean.

- [X] T270 [US1] Gate round 2 remediation (code-reviewer/accessibility-auditor/ui-architect-v3,
  High/Medium/Low findings, all fixed, no spec amendment needed -- implementation and live-check
  fixes only). H1 `AppearanceSection.tsx`'s shared Save/Cancel focus-restoration effect always
  focused Theme's own checked radio after a commit, even when only Chat width had been touched,
  and separately could yank focus away from a radio the user never left (arrowing back to the
  saved value, or Escape while focus sat on a radio) -- fixed with a `lastDirtyGroupRef` (tracks
  which group's dirty flag most recently went false->true, read only when focus was NOT already
  on a radio) plus a "leave it" guard when focus already sits on a radio inside the section. H2
  `ChatWidthPicker.tsx` had no visual confirmation of the chosen width before Save (the real
  transcript is unmounted while Settings is open) -- added a small `aria-hidden` preview tile
  beside the radiogroup (mock prose bars, modelled on `BrandWatermark`'s own 'preview' variant)
  that narrows live, driven by `useActiveChatWidth()`, the instant the radio changes. H3 the live
  check only ever confirmed persistence by re-rendering after a relaunch, never by reading
  `settings.json` itself -- added a direct on-disk read (`JSON.parse(readFileSync(...))`) of
  `chatWidth` before the stop/relaunch, same "prove it on disk" pattern `verify-tauri-559.mjs`/
  `verify-tauri-735.mjs` already use. M1 the Reading column padding ladder
  (`px-6 sm:px-10 md:px-14 lg:px-16`) was keyed off the WINDOW via Tailwind's ordinary
  breakpoints, not the chat pane -- a split pane or a narrower sidebar state could reach a
  breakpoint the pane's own content never actually grew into; replaced with Tailwind v4's
  arbitrary container-query variants (`@min-[40rem]:px-10 @min-[48rem]:px-14
  @min-[64rem]:px-16`) against the existing `[container-type:size]` ancestor
  (`ChatPane.tsx`'s own wrapper, already a query container for the brand watermark). M2 the
  keyboard Save round trip's own layout assertions measured at 1280px, where the cap cannot bind
  for EITHER value -- a keyboard Save that silently persisted the wrong `ChatWidth` would have
  passed unnoticed; moved both assertions to 1920px, and added a Check 3b exercising Escape
  (Cancel's sibling path) mid-preview: arrow back to "Full", press Escape, confirm the radiogroup
  reverts to the saved "Reading column" with Save disabled again and the transcript still capped
  afterward. M3 the composer-width check silently skipped (no failure) when
  `.bg-composer-background` was not found -- now a hard failure; added a `getComputedStyle(...)
  .paddingLeft === '64px'` assertion at 1920px confirming M1's top container-query breakpoint
  actually applies against the pane; removed the script header's stale claim that a "status
  line" check runs (it never did -- only the composer is checked). M5 `ChatWidthPicker`/
  `useActiveChatWidth()` shared one source line in `Transcript.tsx`, leaving no slack to touch
  that file again without a baseline bump -- split onto two lines, and extracted
  `isConversationStarted` (with its full doc comment) into its own sibling
  `isConversationStarted.ts`, re-exported from `Transcript.tsx` for `ChatPane.tsx`'s existing
  import, netting real slack instead of just moving the problem. M6 `LowMemoryWarning` --
  originally defined inline in `ipc.ts`, moved into `model.ts` by this story's own T268 (NOT
  issue #806 as this file's own earlier text wrongly credited; corrected as a gate round 2 PASS
  Low finding) -- moved again, out of `model.ts`, into its own `src/shared/lowMemoryWarning.ts`,
  re-exported from `ipc.ts`; `model.ts` now ends with a trailing newline (previously missing).
  L1 `ThemePicker`'s radiogroup carried a bare `aria-label="Theme"` string duplicating its
  informal heading text, and Chat width had no heading of its own at all -- both groups now get
  an explicit `<h3>` plus a hint `<p>` in `AppearanceSection.tsx`, referenced via
  `aria-labelledby`/`aria-describedby` props threaded into each picker; the section's own intro
  paragraph reworded to cover both groups, not just Theme. L2 each radio's accessible name used
  to come from the button's entire text content (name, "Current" badge, and description all
  concatenated) -- each radio now carries `aria-labelledby` pointing at its name span alone
  (plus `aria-describedby` at its description span, Chat width only, Theme has none), and the
  "Current" badge is `aria-hidden` in both pickers (redundant with `aria-checked` for assistive
  tech). L3 "Full" did not read as the default anywhere accessible -- its description now reads
  "Default. The transcript fills the pane." L4 Chat width's rows had no leading icon slot,
  misaligning its labels against Theme's own swatch-led rows -- added a matching
  `aria-hidden size-4 shrink-0` spacer. `scripts/verify-554-chat-width.mjs` updated to match:
  `CHAT_WIDTH_RADIOGROUP_FINDER` now selects `[aria-labelledby="chat-width-heading"]` (was
  `[aria-label="Chat width"]`); a new assertion confirms the H2 preview tile's own bars measure
  narrower the instant "Reading column" is clicked, before that Save. `pnpm typecheck`, `pnpm
  vitest run` (148 tests), `node scripts/check-indent.mjs`, `node scripts/check-theme-contrast.mjs`,
  `node scripts/check-file-size.mjs` (0 cap violations) and `node --check
  scripts/verify-554-chat-width.mjs` all re-ran clean after these fixes. Live-checked under
  Main's own build slot (`ci-local.mjs`'s `cargo fmt --check`/`cargo test`/`cargo clippy`/Tauri
  debug build, chained into `verify-554-chat-width.mjs`): the first run under the slot added two
  checks Main required that this phase's own script had not yet covered (a Cancel-button revert
  distinct from Escape, and an explicit focus-stays-in-group assertion) -- the Escape-path focus
  assertion then genuinely FAILED, a real bug, not a script issue: H1's "already on a radio,
  leave it" guard keyed on `role="radio"` alone, so a stale, now off-roving-tabindex radio (a DOM
  element never auto-blurs just because its own `tabIndex` flips to -1) could still hold focus
  while reading `aria-checked="false"`, which the guard mistook for "already correct". Fixed by
  keying the guard on the focused element's `aria-checked === 'true'` instead of merely its
  `role`. Final run at commit `ea674bd`: **31 findings, 0 failures, 0 notExercised**,
  `report.json`'s `gitHead` matches the pushed head, `dirty: false`; all 7 screenshots viewed.

- [X] T271 [US1] Gate round 2 docs follow-ups (Main's own review of the PASS, Low findings, all
  fixed, no code/script change so no re-run needed): this phase's own closing paragraph (below)
  now records the confirmed `ea674bd` live-check run instead of "not yet re-run"; the
  Clarifications entry and FR-073 both corrected from the stale `sm`/`md`/`lg` WINDOW-breakpoint
  wording to the actual pane-width container-query ladder (M1); `src/shared/lowMemoryWarning.ts`'s
  own doc comment, and this phase's own T268/M6 text, corrected -- `LowMemoryWarning` was
  originally defined inline in `shared/ipc.ts`, moved into `shared/model.ts` by this story's own
  T268 (NOT a move issue #806 itself performed, as both files previously, wrongly, credited);
  `docs/design/product-chat.md`'s Chat width bullet corrected ("beside" -> "below": the H2
  preview tile renders BELOW `ChatWidthPicker`'s radiogroup, not beside it); `docs/design/
  product-first-run-and-settings.md`'s watermark-switch bullet corrected (it now sits below Chat
  width, which this story inserted between it and the Theme picker, not directly below the
  Theme picker as before). `node scripts/check-indent.mjs` reran clean (0 odd-indent lines);
  `git diff --numstat origin/main -- specs/001-core-session-workspace/tasks.md` still 0
  deletions.

Opened as draft PR (`feat/554-chat-width`), now **Closes #554**: `ci-local.mjs` all steps PASS
and `scripts/verify-554-chat-width.mjs` 31/31 PASS (0 failures, 0 notExercised) on a real scratch
instance at commit `ea674bd`, confirmed via `report.json`'s own `gitHead`; PR #966 and this
phase's PLAN.md row both record the result. Gate round 2's five reviewers PASS; T271's docs
follow-ups above are the only remaining changes, none touching code or the live-checked build.

## Phase 54: Convergence

- [X] T272 [US7] Issue #947 (Decided, Skippy, delegated by Stuart; away mode, 2026-10-16): fuzzy
  slash-command search. Added `src/shared/slashCommandSearch.ts` (`rankSlashCommands`, pure, no
  DOM): every listed command -- built-ins, project/user `file` commands, and `skill:<name>`
  entries alike -- is ranked exact/prefix/word-start (after `-`, `_`, `:` or a space)/substring/
  subsequence (fzy-style), ties keeping the input order; a skill's own `skill:` prefix is tried
  both with and without it, so `/rev` finds `skill:code-review` and `/skill` lists every skill
  via an ordinary prefix match; a command's description is searched too, but a description-only
  match always ranks below a name match. `SlashMenu.tsx`'s old prefix-only `filterSlashCommands`
  is replaced by `rankSlashMenuCommands` (wrapping the new scorer); matched name characters
  render in `<b>` inside the option's own single text node (`renderMatchedName`), so the
  accessible name is never split into separate announcements. `MessageInput.tsx` gained a
  debounced (500ms), `useClearedAnnouncement`-backed result-count announcement mirroring
  `SessionList.tsx`'s own search announcement (re-reading live draft text and commands at fire
  time, never the render-time closure, so the debounce timer does not depend on a fresh array
  identity every keystroke). Per FR-074.
- [X] T273 [US7] Issue #938 items 1 and 4 (gate follow-ups from PR #923/#917): slash subcommand
  step, and a command reply no longer stretching the previous turn's own time. `SlashMenu.tsx`
  gained `parseSlashMenuState` (replacing the old bare `parseSlashQuery`): one space after a
  RECOGNISED command with verified subcommands (`command.subcommands`, already pruned to the
  verified set) parses as that command's own subcommand step instead of closing the menu, its
  own query being whatever follows the space; a second space closes it, same as any other
  command. `orderSubcommandsForEmptyQuery` puts `status` first with nothing typed yet (every
  other subcommand keeps its existing order); a typed query ranks via the same T272 scorer, and
  the synthetic "Run /<cmd>" row shows only on an empty query (gate round 2 finding H) so a
  partial match never blind-fires the bare command. `MessageInput.tsx`'s `completeSlashCommand`
  (choosing a top-level command) now only ever leaves the box reading `/name ` -- the composer
  text re-parsing as the subcommand step is what advances the menu, with no separate step state;
  a new `completeSubcommand` completes the full `/name subcommand ` invocation, and
  `handleSlashMenuSelect` routes Enter/Tab/mousedown to whichever one the current parsed step
  calls for. Separately, `command_output` frames now get a distinct `command-output:` id prefix
  (`COMMAND_OUTPUT_NOTICE_PREFIX`, added to `src/shared/commandOutputNotice.ts` and
  `src-tauri/src/omp/transcript/notice_prefixes.rs`, consumed by `apply_frame_items`, replacing
  the generic `notice-N` id that frame type used to share with a plain `notice` frame); `turnTiming.ts`'s
  `computeTurnEnd` skips any notice carrying that prefix entirely (neither its `receivedAt`
  arrival time nor any `itemEndTime` counts), so a reply that arrives after its turn has already
  settled no longer stretches that turn's own shown elapsed time -- and (gate round 3 Medium fix)
  `TurnTotalLine`'s own remembered settle state distinguishes "never settled" from "settled, no
  usable timing" (a lazy `useState` initialiser, not a ref written during render), so a genuine
  resumption of the same turn (an async subagent result, an advisor follow-up, a retry after
  compaction) resumes live-ticking instead of staying stuck at a stale value forever, and a
  component remount (virtualised windowing, a session switch) can no longer make a settled,
  untimed turn tick through an unrelated running command. The reply itself still renders
  normally; only the turn-time MATH excludes it. The other #938 items (refusal-text wording
  naming the allowed subcommands, short-notice wrapping, a Settings mention, and the suspected
  duplicate render) are out of scope for this story and remain open on the issue. Per FR-075
  and the FR-046 amendment.
- [X] T274 [US7] Update the docs: amended `specs/001-core-session-workspace/spec.md` with new
  FR-074 and FR-075 (renumbered from a provisional FR-073/FR-074 once #966/#554 landed the real
  FR-073 on `origin/main` first), an amendment to FR-046, and two dated `### Session 2026-10-17`
  Clarifications entries recording both decision records; `docs/design/product-chat.md`'s "Slash
  commands" bullet gained a Fuzzy ranking and a Subcommand step sentence; `docs/PLAN.md`'s "Late
  2026-10-16 additions" row records both issues as built, with #938 noting only items 1 and 4 are
  covered (the rest stay open on the issue).

This phase was written retroactively after the implementation above, the same reasoning Phase 48
(#917) used: no prior `/speckit.plan`/`/speckit.tasks` pass covered either issue. Opened as draft
PR #954 (`feat/947-slash-search`), **Closes #947, Refs #938** (items 1 and 4 only -- #938's other
items stay open on the issue): `pnpm typecheck`/`pnpm vitest run` (148/148)/`node
scripts/check-indent.mjs`/`node scripts/check-file-size.mjs` all green on the final pushed head.
Live-checked under Main's own build slot across several gate rounds (`ci-local.mjs`'s `cargo
fmt --check`/`cargo test`/`cargo clippy`/Tauri debug build, chained into
`scripts/verify-947-938-slash-menu.mjs`): three earlier runs each found and fixed one genuine
test-script bug (an unscoped `aria-hidden` empty-state selector; a turn-time baseline sampling
race; an announcement live-region selector colliding with `Transcript.tsx`'s own always-mounted
regions, closed off for good with a `data-slot="slash-menu-announcement"` target), never a
product regression. Final run at commit `ee64bf0`: **31 findings, 0 failures, 0 notExercised**,
`report.json`'s `gitHead` matches the pushed head, `dirty: false`, `exeSha256` confirmed
unchanged through the copy; all 11 screenshots viewed. `git diff --numstat origin/main --
specs/001-core-session-workspace/tasks.md` confirmed 0 deletions before this phase was appended.

## Phase 55: Change-count colour and reasoning gauge (#925, #924, #919) [US1]

(Renumbered from a provisional Phase 53/T267-T270, then Phase 54/T272-T275, once #966/#554 and
#954/#947 each merged first and claimed those numbers on `origin/main` in turn.)

- [X] T275 [US1] #925 diff-stat colour tokens: `--diff-added`/`--diff-removed` component tokens
  (`globals.css`, Dark/Obsidian/Dark high contrast), aliasing `--state-working`/`--destructive`
  so the coloured figures match `DiffView.tsx`'s own insert/delete hue; `--color-diff-added`/
  `--color-diff-removed` Tailwind mapping generating `text-diff-added`/`text-diff-removed`; 20
  new `scripts/theme-contrast-pairs.mjs` PAIRS entries at the 4.5:1 text floor (the composer
  status line's `--background`/`--composer-background`, the Session details card's `--popover`,
  and the Changes tab's per-file header `--muted`), all PASS (`node
  scripts/check-theme-contrast.mjs`: 457/457 pairs).
- [X] T276 [US1] #925 shared `DiffStatCounts`/`DiffStatLine` components (`sessionDisplay.tsx`,
  replacing the old plain-string `formatDiffStat`): a zero count (`+0`/`-0`) stays muted, a
  positive count takes the new tokens, the leading +/- glyph stays the non-colour cue. Wired
  into the composer status line's `ChangesChip` (`ReadoutChips.tsx`), the Session details card's
  diff line, and the Pull requests Changes tab's aggregate line (`ChangesTab.tsx`). #919 (folded
  into #925's own scope): `DiffViewFromPatch` (`DiffView.tsx`) gains required `additions`/
  `deletions` props, rendering the same coloured stat next to its Copy button -- the per-file
  `+/-` header `ChangesTab.tsx`'s own `patch === null` fallback already showed in plain text now
  colours the same way.
- [X] T277 [US1] #924 `ReasoningGaugeIcon` (`src/renderer/components/ReasoningGaugeIcon.tsx`,
  new): a custom inline SVG reusing lucide's own `gauge` arc geometry, needle drawn at one of 7
  even steps (`off` far left, `medium` upright, `max` far right); `inherit` and an unreported
  level both draw centred. Replaces the fixed `GaugeIcon` in the composer's `ReasoningPicker`
  (`ComposerPickers.tsx`, `size-3`) and the Session details card's thinking-level row
  (`SessionDetailsCard.tsx`, `size-3.5`); decorative (`aria-hidden`), no colour change, the
  status line's context-usage gauge untouched.
- [X] T278 [US1] `scripts/verify-925-924-polish.mjs` (new): measures computed colour and
  contrast ratio of `+N`/`-N`/zero on each of the four #925 surfaces in every theme, and the
  gauge needle's rendered angle at every reasoning level in the composer picker, changing the
  level through the real UI, then cross-checks the Session details card's own identical icon
  against the picker once (at whatever level the level loop ends on), not independently at
  every level.

Gate round 1 found a real bug in this live check itself (not the product): the scratch
worktree's own tracked file checks out CRLF on Windows (`core.autocrlf=true`), so the edit's own
line-ending-naive comparison silently removed nothing -- every prior "PASS" on the composer
chip/Session details card's non-zero case was really only ever `+4 -0`, never genuinely
exercising the red `text-diff-removed` branch at all despite reading as a pass. Fixed (CRLF-safe
split, `requireBothPositive` now a hard failure if either side reads zero on these two
script-controlled surfaces), not yet re-confirmed live. The Reasoning gauge needle's own apparent
failures in the SAME run were a second, separate script bug (the angle comparison did not
account for the formula's own un-normalised >360deg values) -- fixed and later confirmed live, 8
of 8 levels genuinely PASS, plus a single Session-details-card cross-check at whatever level the
loop ends on (not independently re-verified at every level). The Pull requests Changes tab/#919
per-file header is still NOT YET CONFIRMED live: `view-store.ts`'s `openChat` pins the view's own
repository scope to whichever repo a Session is opened in (by design, research.md decision 7),
root-caused via the real on-screen error text, fixed (drives the repository Select explicitly).

`pnpm typecheck`, `pnpm test` (148/148), `check:indent`, `check:theme-contrast` (457/457),
`check:file-size` all clean on every commit in this phase.

Opened as draft PR #967 (`feat/925-924-polish`). **Refs #925**, **Refs #924**, **Refs #919**
(folded into #925's own scope; closes once every surface above is confirmed live with the
gate-round-1 fixes in place).

## Phase 56: Convergence

- [X] T279 [US1] #937 Advisor chip -- Rust lane. New `session::advisor` (issue #784's
  pre-declared-lane pattern, alongside `model`/`readout`/`side_chat`/`start_queue`/
  `subagents`/`termination`): its own `State` held in `AgentState` via `with_advisor_state`
  (`agent/mod.rs`'s `with_lane_state!` macro), its own `on_frame`/`on_launch` hooks called
  from `agent/frame.rs`/`agent/launch.rs` the same way every sibling lane already is. State
  source decided narrower than the issue's own proposal (Decided, Skippy, delegated by Stuart
  2026-10-18, recorded on issue #937): `omp://rpc.md` exposes no `get_state` field and no
  dedicated event for the advisor's on/off boolean, so only `/advisor on`'s ("Advisor
  enabled.") and `/advisor off`'s ("Advisor disabled.") own reply text, both proven stable
  by #917's `scripts/verify-917-advisor-command.mjs`, are trusted without reservation;
  `/advisor status`'s own reply is not (#917's own evidence showed it replying `Advisor
  "default" is running.` immediately after an explicit `/advisor off`), so a silent
  attach/resume probe (`consume_if_silent_probe`, a pre-dispatch veto added to `agent/
  frame.rs`'s own `"command_output"` arm so its reply never reaches the transcript --
  issue #937's own accessibility requirement) trusts only an unambiguous "Advisor is
  enabled"/"Advisor is disabled" substring, leaving every other wording (including that
  exact "is running." text) unknown -- chip hidden, never a wrong "on" state. A typed or
  chip-sent `/advisor on`/`/advisor off` is never suppressed; `session::advisor::on_frame`
  only piggy-backs on the same frame `apply_transcript_frame` already rendered. New
  `advisor:update` event (`events.rs`), `advisorOn` on `SessionSnapshot`
  (`ipc/conversations.rs`'s `build_snapshot`, `current_advisor_value`). **Code-verified
  only**: no build slot has been granted for this sub-task, so none of this has been compiled,
  `cargo test`ed, or run against a real `omp` yet -- see FR-078.

- [X] T280 [US1] #937 Advisor chip -- frontend. New `AdvisorChip` (`ReadoutChips.tsx`, built on
  the shared `ReadoutChip` baseline), rendered unconditionally (no Settings toggle) as the
  first item of `ComposerStatusLine.tsx`; icon `EyeIcon`, visible text "Advisor", accessible
  name "Advisor on. Turn off" (busy: "Advisor on. Turning off…"), hidden (renders `null`)
  while off. Clicking sends `/advisor off` via `window.refract.chat.send`, ignoring repeat
  clicks while in flight. New per-session `advisor-store.ts` (Zustand, mirrors `readout-
  store.ts`'s per-session shape), seeded from `SessionSnapshot.advisorOn` (`applySnapshot.ts`)
  and kept live by the new `advisor:update` IPC event (`shared/ipc.ts`, `tauri-bridge/
  index.ts`). `ReadoutChip.tsx` gained an optional `buttonRef?: Ref<HTMLButtonElement>` prop
  (backward-compatible, threaded onto the `onActivate` `<button>` only); a
  `useLayoutEffect` keyed on `advisorOn` reads that ref in its own cleanup (the same focus-
  handoff-on-unmount-equivalent pattern `RequestCard.tsx`'s `ResolvedRequestSummary`/
  `AskCard.tsx` already use) to move focus to the message textarea and announce "Advisor
  off" through `MessageInput.tsx`'s existing shared `useDraftStore.getState()
  .announceAttachment` live region, only when the chip's own button held focus right before
  the transition -- never for a plain typed `/advisor off`, which already has its own visible
  transcript notice. **Code-verified only**: `pnpm typecheck`/`pnpm build` have not been run
  (no build slot for this sub-task yet) -- see FR-078.

- [X] T281 [US1] #937 Docs and live-check script. Amended `CONTEXT.md`'s **Advisor** entry (the
  readout is part of what "Advisor" means, not a separate term), `docs/design/product-
  chat.md` (new Advisor readout bullet), `docs/PLAN.md` (2026-10-18 status-update), and this
  spec (new FR-078, renumbered from a provisional FR-076 once #954 landed FR-074/FR-075 and
  #967 claimed FR-076/FR-077). New `scripts/verify-937-advisor-chip.mjs`
  (modelled on `verify-917-advisor-command.mjs`/`verify-927-928-quiet-composer.mjs`'s own
  scratch-launch/CDP pattern): AX-tree accessible-name assertions for both on/off states and
  both busy wordings, a geometry comparison against a neighbouring status-line chip (24px row
  height, 14px icon), a mouse-click run and a separate keyboard-only run (Tab, Enter) each
  asserting the send, the busy no-op, the settled `/advisor status` confirmation, the chip
  leaving the AX tree, focus landing on the message textarea, and the "Advisor off"
  announcement, plus Dark/Obsidian/Dark (high contrast) screenshots of the chip ON. `node
  --check` confirmed it parses. **Not yet run**: no build slot has been granted for this
  sub-task, so this script has never executed against a real built app -- its own
  `notExercised` list additionally discloses that it cannot itself prove the silent attach-
  probe's own transcript suppression without a second scratch run across an app restart.

Not yet opened against a build at the time these three tasks were built (delegated
sub-tasks, no build slot granted): `pnpm typecheck` and `pnpm vitest run` have since passed
clean on the full worktree, and `pnpm check:indent`/`check:ui-text`'s source-only parts,
`check:theme-contrast`, `check:file-size`, and `check:parity --gate` all pass too
(`check:ui-text`'s bundle-scan half needs a built `out/` and is deferred with the rest).
Opened as draft PR #972 (`Refs #937` until the live check runs). Merged `origin/main` to pick
up #954 (FR-074/FR-075, Phase 54, T272-T274) and renumbered this phase from a provisional
Phase 54/T272-T274/FR-076 to Phase 56/T279-T281/FR-078 (Phase 55/FR-076-077 reserved for #967,
still in flight). Still pending the build slot: `cargo fmt --check`/`cargo test`/`cargo
clippy`, `pnpm build`, and `node scripts/verify-937-advisor-chip.mjs` live against a real app
-- every claim about THOSE is code-verified only (static read of the diff), per FR-078.

Build slot granted 2026-10-18, `scripts/ci-local.mjs && scripts/verify-937-advisor-chip.mjs`
chained (per the `refract-lane-pr-gate` rule): `cargo fmt --check` clean, the Rust unit suite
passed (727/727 once two genuinely flaky, unrelated git-subprocess tests --
`git::diff_stat::diff_stat_counts_tracked_edits_and_untracked_files`,
`git::worktree_validity::invalid_for_a_folder_git_has_never_registered` -- were confirmed
passing in isolation and re-run clean under the same full-suite load; neither file is touched
by this branch), the Tauri debug build succeeded, and `verify-937-advisor-chip.mjs` ran live
against the real built exe and a real `omp` process. Final head `e0c5e15`: **0 failures**
(`report.json`) -- mouse- and keyboard-driven toggle cycles (busy state, exactly-one
authoritative "Advisor disabled." reply, AX-tree removal, focus-to-textarea, the "Advisor off"
announcement), chip geometry (24px row, 14px icon) and order (second-to-last, right before the
Current time chip, with `current-time` explicitly enabled for the check), no-cost-leak, and a
live-measured contrast ratio all PASS across Dark/Obsidian/Dark (high contrast). One
`contract_replay` regression this round's own `advisorOn` field caused against the frozen
golden trace (`scripts/fixtures/contract-replay/session-scenario.rust-trace.json`) was found
and fixed (new field added to the golden file and to `scrub_known_divergences`'s Rust-only-
field allowlist, same pattern as `readout.branch`). A genuine, falsified-against-the-DOM
harness limitation, not a product bug: the themed hover check's own mouse-away tooltip-close
assertion never settles (`[role="tooltip"]`'s `data-state` never leaves `delayed-open`/
`instant-open` across a 3s poll) because CDP's synthetic `mouseMoved` does not reliably
produce the real `pointerleave` DOM event Radix's open-state tracking needs against this
Tauri/WebView2 target -- confirmed the pointer genuinely left (`document.elementFromPoint`)
and that the contrast measurement itself is unaffected (native `:hover` tracking is
independent of JS event dispatch); recorded honestly as `notExercised`, not asserted as a
failure it cannot back up. **Still `Refs #937`, not `Closes`**: the silent attach/resume
probe's own firing (acceptance item 4's "on agent attach" clause) was not independently
provable without a second across-restart scratch run (tracked on #650), so FR-078's own
attach-probe guarantee stays code-verified rather than live-proven on that one point.

Merged `origin/main` twice more (`0b63b00`: #967 diff-stat colour/reasoning gauge, 3-file
conflict resolved keeping both sides, no semantic gap -- #967 touches zero Rust/IPC/shared-
schema code; `06af543`: #953 PR filters/resizable column, clean auto-merge, no conflicts, no
gap) and re-ran the full chain on the resulting head. One build-infrastructure issue hit and
fixed (not a code regression): the shared `CARGO_TARGET_DIR` carried a stale `refract-tauri`
build-script cache from a different worktree's own prior build, producing a linker error
(`LNK1327`) that referenced that OTHER worktree's own `windows-app-manifest.xml` path even
though the file exists correctly at the same relative path in this one. Fixed with a scoped
`cargo clean -p refract-tauri` (only this one package's cached artifacts in the shared target
dir, not a wipe of the whole directory) before rebuilding clean. **Final confirmed run, head
`06af543`** (clean tree, `dirty: false`): `cargo fmt --check`, the full Rust unit suite, and
the Tauri debug build all passed; `verify-937-advisor-chip.mjs` reports **0 failures**
(`report.json`), reproducing every finding from the first live run (toggle cycles, geometry,
order, no-cost-leak, contrast across all 3 themes) with the same `notExercised` disclosures
(the silent attach-probe's own firing, the tooltip mouse-away harness limitation, the indirect
busy-window no-op check). All 3 themed screenshots viewed directly again. `pnpm typecheck`,
`pnpm vitest run` (148/148), `check:indent`, `check:theme-contrast` (455/455),
`check:file-size`, `check:parity --gate` (24/24 events, 100/100 requests),
`check:drag-regions`, `check:versions`, `check:omp-schema-drift` all green on this head too.
PR #972 body and this plan row updated with the final-run evidence; still `Refs #937`, not
`Closes`, for the same acceptance-item-4 reason as before.

## Phase 57: Stage naming, green finished state, real dependencies (#941, part 1 of 2) [US1]

(Provisional numbering: renumbers against `origin/main` just before this merges.)

- [X] T282 [US1] Rust: `TranscriptItem::Subagent` gains `context: Option<String>` (the batch
  `task()` call's own shared `context` argument, sibling of `tasks[]` on the wire per
  `omp/tools/task.md`'s own batch schema `{ context, tasks[] }`), threaded through both
  construction sites -- the live `tool_execution_start` path (`upsert_subagent_items`'s new
  `context` parameter) and the message-echo path, split into a new sibling function
  `subagent_items::build_message_subagent_items` (keeps `transcript.rs` under its own 600-line
  cap, per the issue's own technical note). `session::readout`'s `TodoPhaseState` gains a `name`
  field (OMP `todoPhases[].name`, previously parsed then discarded) and a new `todoPhases` wire
  field on `SessionReadout` -- `Array<{name, pendingCount}>` for every phase with outstanding
  work, `null` otherwise -- computed in a new sibling module `readout_todo.rs` (same file-size
  reason). Both are brand-new, Rust-only fields (Electron's own frozen shells never had either):
  `contract-replay`'s golden trace (`session-scenario.rust-trace.json`) and
  `scrub_known_divergences` updated the same way #937/PR #972 did for its own `advisorOn` field
  (merged just before this phase, Phase 56 above).
- [X] T283 [US1] `groupSubagentStages.ts` computes a Stage's own `label` (the batch context's
  first line, Markdown heading/"Goal:" stripped, ~60 chars, else the agents' shared name prefix,
  else `null`) and real `dependencies` (`agent://<id>` references in the Stage's own context/
  tasks resolved against EARLIER Stages' agent ids only, dropped when unmatched or forward-
  pointing) via a new sibling `stageMeta.ts`. `statusGlyph.ts` gains a `success-done` glyph key;
  `subagentStatus.tsx` maps `finished` to it (green icon on every consumer: `SubagentRow`, Stage
  rows, the chain, the panel) and exports `isSubagentSuccessStatus`/`SUBAGENT_SUCCESS_TEXT_CLASS`
  for the matching green TEXT half -- tool rows/groups (`toolStatus.tsx`) are untouched.
  `SubagentChainRow.tsx`'s `StageGroupRow`/`ChainStageLine`/`ChainAgentEntry` and `ToolRow.tsx`'s
  `SubagentRow` apply the green text and the Stage label; a new `StageDependencies.tsx` renders
  the "Uses:" line (grouped by the earlier Stage, each id a real button when the live tracker
  still knows it, else plain text). `SubagentRow` also gains a one-line `summary` of the agent's
  own result, visible the moment its owning Stage is expanded, with no need to expand the row
  itself too. A multi-agent Stage's own expansion also shows its full batch context as rendered
  Markdown, visually capped to about 6 lines, above its member rows.
- [X] T284 [US1] The Subagent panel's own Stage-level tree node (grouping `SubagentSummary[]` by
  `toolCallId` the same way, through the same `stageMeta.ts`/`StageDependencies.tsx` helpers)
  and the "Up next" list (from the `todoPhases` readout field T282 already wired) below the
  Subagent chain. Built in Phase 58 below (second PR, as planned here).

This phase covers issue #941's 2026-10-15 grill items 2 to 5 and the Subagent chain/Stage-row
half of item 7 (terms, item 1, already landed via PR #942's docs-only change); items 6 (Up next)
and the Subagent panel half of item 7 are explicitly deferred to a second PR.

`pnpm typecheck`, `pnpm vitest run` (148/148), `node scripts/check-indent.mjs`, `node
scripts/check-file-size.mjs`, `node scripts/check-parity.mjs --gate` (100/100 requests, 23/23
events), `node scripts/check-drag-regions.mjs`, `node scripts/check-theme-contrast.mjs`
(455/455 pairs) all clean on this phase's own head. The Rust side is CODE-VERIFIED ONLY at
authoring time (no build slot granted yet): `cargo fmt --check`/`cargo test`/`cargo clippy`/the
Tauri debug build, and a live check against a real `omp`, are each pending the build slot grant
from Main.

Opened as draft PR (number recorded once opened) on branch `feat/941-stages`. **Refs #941**
(items 6 and the Subagent panel half of item 7 are not yet built, and nothing above has been
live-proven against a real build yet).

## Phase 58: Session start notice, one centred presentation (#672, follow-up to #618) [US1]

- [X] T285 [US1] #672 `SessionStartNotice.tsx`: drop the `variant` prop and the `inline` layout
  entirely -- one centred presentation for every Session. The joke-stage emoji renders on its own
  line at `text-[40px]` (`@min-[40rem]:text-5xl`) with a `session-start-emoji-bob` 2.4s loop
  (new `@keyframes`, `globals.css`, neutralised by the existing global
  `prefers-reduced-motion` rule); the message renders at `text-xl text-balance text-foreground`
  (`@min-[40rem]:text-2xl`), no longer muted; the elapsed-seconds counter stays explicit
  `text-xs text-muted-foreground`. queued/memory-deferred (and the brief pre-pick gap) keep the
  small `text-base` spinner-plus-text look. `ChatPane.tsx` drops `showInline`, its
  `isConversationStarted`/`useTranscriptStore` probe, and the second (`inline`) render site, and
  always passes the one `SessionStartNotice` to `Transcript.tsx`. `Transcript.tsx` dims the
  transcript behind the notice to `opacity-40 pointer-events-none` (`dimTranscript`, true
  whenever a notice is showing over a Session that has history or a conversation already under
  way), restoring full opacity the instant the start ends.
- [X] T286 [US1] `scripts/verify-672-start-message.mjs` (new): live-checks a brand-new Session's
  start notice (centred, large, no dimming) and a Session-with-history's start notice (centred,
  large, transcript dimmed behind it, non-interactive), the computed emoji/message/counter font
  sizes and colours in a normal-width pane and a split pane, the queued/memory-deferred plain
  `text-base` state, the message clearing once the agent is ready, one screen-reader
  announcement, and `prefers-reduced-motion` leaving the emoji static, across Dark, Obsidian, and
  Dark (high contrast).
- [X] T287 [US1] #672 gate fixes (code/a11y/UI/test, decided by Main) across three rounds: the
  dimmed transcript stays fully interactive (`Transcript.tsx` drops `pointer-events-none`, keeps
  only `opacity-40`; `focus-within:opacity-100` restores full strength for a focused control; no
  transition, so the dim appears/clears instantly) and a wheel/pointerdown/touch on the notice's
  own buttons no longer cancels the scroll-landing loop (scoped to `viewport.contains(target)`,
  the same guard `handleFocusInput` already used). `SessionStartNotice.tsx` gains a `dimmed` prop
  (via a render function, `startNotice(dimmed)`, not `React.cloneElement`): when dimmed, a soft
  borderless `bg-background/90 backdrop-blur-sm` panel backs the notice (the same token the
  file-drop overlay uses) so its text stays readable against the dim; none for a brand-new
  Session. WCAG 2.4.11: while keyboard focus sits anywhere inside the dimmed history, the overlay
  (not the inner wrapper -- `peer-focus-within:*` only ever matches a SIBLING of `.peer`, a real
  bug caught live by Main's own Tailwind-compile analysis) hides via `opacity`/`pointer-events`,
  never `visibility` (which would make Keep waiting/Cancel untabbable), `transition-opacity
  duration-150`; the next real Tab (focusing the LAST tabbable element inside the history first,
  so it is guaranteed to exit) lands on a button and brings it straight back. The overlay wrapper
  gains `items-center-safe`+`overflow-y-auto`, and the notice's own padding shrinks under
  `@max-h-[28rem]`, so Keep waiting/Cancel stay reachable on a short pane. The message gets
  `max-w-[28rem]` (so `text-balance` has something to balance against) and `gap-2`; the emoji's
  bob runs a fixed 2 iterations (4.8s, under WCAG 2.2.2's 5s threshold). Dead code: the unused
  `export { isConversationStarted }` (`Transcript.tsx`) removed; stale `inline`/`showInline`
  comments fixed in `isConversationStarted.ts`, `ChatPane.tsx`, `globals.css`.
  `scripts/verify-672-start-message.mjs` rewritten across the three rounds to poll opacity with a
  timeout instead of a single read (including the overlay's own 150ms transition); assert the
  dimmed history still scrolls on a real wheel dispatch (`elementFromPoint`-confirmed to land
  inside the transcript and outside the notice, `deltaY:-150` since the transcript already sits
  scrolled to "end") and reaches full opacity on focus; assert the notice hides on history-focus
  and a real Tab reveals it; assert the panel's own real computed background/alpha (0.85-0.95)
  composited over a worst-case `--foreground@40%`-over-`--background` backdrop against
  message/counter/guidance/button-label colours in every theme, with a self-validating
  fault-injection step (forcing the panel transparent) that is itself a FAILURE if it cannot
  prove the check has teeth; actually narrow the split pane and drive a genuinely short window via
  `Emulation.setDeviceMetricsOverride` (never only measuring whatever width/height the run
  happens to get), reaching buttons via a real repeated wheel scroll and `elementFromPoint`
  hit-testing (not rect math), again with a teeth-proving fault injection
  (`overflow-y:hidden`); write `report.json` even when an early setup step throws. Split into
  `verify-672-start-message.mjs` + `verify-672-start-message-helpers.mjs` (#806: the round-2
  additions pushed the single file past the 600-line cap). Harness root cause found 2026-10-18
  (code review): the live-check never built/PATH-prepended the recorded-frame omp shim, so every
  run silently launched the real `omp` instead of the fake one -- fixed (`buildOmpShim`/
  `pathPrepend`, `setupLaunch` now refuses unless the shim's own debug log proves it ran);
  `prompt`/`extended`/`queued` restored to real live assertions.

`pnpm typecheck`, `pnpm test`, `check:indent`, `check:file-size` clean on every commit in this
phase; `check:theme-contrast` unaffected (no new colour pair, FR-080).

Renumbered against `origin/main` just before merging (this file's own convention, per the
`refract-ui-lane-gate-checklist` skill): #941 merged first and kept Phase 57/T282-T284/FR-079;
this phase moved to Phase 58/T285-T287, and the spec's own new line moved to FR-080 (`spec.md`).

Opened as draft PR #978 (`feat/672-start-message`). **Refs #672** until the live check above
confirms every acceptance item; switches to **Closes #672** once it does (follow-up to #618,
already closed).
## Phase 59: Subagent panel Stage grouping, green state, Up next (#941, part 2 of 2) [US1]

Renumbered against `origin/main` just before merging (this file's own convention, per the
`refract-ui-lane-gate-checklist` skill): #672 (follow-up to #618) merged first as Phase 58
(`origin/main`, PR #978); this phase moved to Phase 59.

- [X] T284 (see Phase 57 above, checked off there): `SubagentPanel.tsx`'s `buildSubagentTree`
  rewritten against a new sibling `groupSubagentPanelStages.ts` (groups `SubagentSummary[]` by
  `toolCallId` -- the only correlation key that interface carries, confirmed against
  `src/shared/model.ts`; research.md decision 17), reusing `stageMeta.ts`'s `computeStageLabel`/
  `extractAgentRefs` directly. Gate round 1 fix (item 1, CRITICAL): keyed on `item.nameOrTask`,
  not `item.id` (`${toolCallId}:${nameOrTask}`, `subagents.rs::handle_task_start`'s own
  `base_id`, never the bare name -- the `model.ts` doc comment this first assumed otherwise
  from is itself corrected). Gate round 1 fix (item 2, HIGH): the "latest earlier occurrence
  wins" dependency algorithm is a single shared `resolveStageDependencies` (`stageMeta.ts`), both
  `groupSubagentStages.ts` and `groupSubagentPanelStages.ts` call it, not two independent
  copies. A call with exactly one member stays a single flat row; 2+ members get a Stage header
  treeitem with its real members nested one `aria-level` deeper. Green state
  (`isSubagentSuccessStatus`/`SUBAGENT_SUCCESS_TEXT_CLASS`, confirmed absent from the panel
  before this) applies uniformly to every row, its own roll-up ("N done, M failed",
  `stageRollupText`, also shared with the chat pane) in a trailing muted slot folded into the
  header's own accessible name too. Gate round 1 decision (item 3, ui-architect-v3 ruling): a
  Stage header's own label never shows "Stage N" -- the panel numbers Stages session-wide by
  `toolCallId` while the chat numbers per turn, so the SAME Stage would disagree between the two
  surfaces; the shared name prefix (else "N agents") is shown instead, and a real "Uses:" line
  renders plain NAMES ONLY (no "(Stage N)" suffix), scoped to earlier calls in the session; a
  solo call's own dependency stays chat-pane-only (documented scope boundary, no header row in
  the panel to attach one to).
- [X] New `UpNextList.tsx`, mounted in `Transcript.tsx` right after `SubagentChainRow` for every
  turn -- a sibling, outside the chain's own collapsible content, `mt-6 px-2` matching the
  chain's own turn-rhythm spacing: reads `ReadoutState.todoPhases` (already wired by T282),
  rendering nothing when null/empty (the backend's own `compute_up_next` already filters to
  non-empty, live-only state, research.md decision 17) -- gated additionally on `isLastTurn`
  (`Transcript.tsx` already computes this for `TurnTotalLine`) and `stages.length > 0`, so the
  CURRENT, session-scoped Todo list is shown once per conversation, not repeated after every
  past qualifying turn. Gate round 1 fix (item 4, HIGH): a labelled list (`useId`, `aria-
  labelledby` on the `<ul>`), not a bare unlabelled one. Gate round 1 fix (item 8, LOW): "1
  task" singular, "N tasks" otherwise; each entry keyed by name plus index (two phases sharing
  one name would otherwise collide).

This phase covers issue #941's 2026-10-15 grill item 6 (Up next) and the Subagent panel half of
item 7, completing the story (items 1-7 all built across the two PRs).

`pnpm typecheck`, `pnpm vitest run` (148/148), `node scripts/check-indent.mjs`, `node
scripts/check-file-size.mjs`, `node scripts/check-parity.mjs --gate`, `node
scripts/check-drag-regions.mjs`, `node scripts/check-theme-contrast.mjs` all clean on this
phase's own head. Live-checked via a new `scripts/verify-941-part2.mjs` (reuses part 1's own
`stages-941.jsonl` fixture, additively extended with a `todoPhases` field on its one `get_state`
response) across all 3 themes: Stage grouping (header + nested members at the right
`aria-level`, solo calls stay flat), green state (including Stage 5's own mixed finished/failed
negative case), the "Up next" list's own exact wording, and a negative check that no panel
Stage shows a stray "Uses:" line (the fixture's own task names carry no `agent://` reference,
`SubagentSummary` has no `context` for one to come from otherwise -- the panel's positive
"Uses:" case is recorded honestly as not exercised, not worth risking part 1's own fixture for).

Opened as draft PR #993 on branch `feat/941-stages-part2`, stacked on part 1's now-merged
`feat/941-stages` (PR #979, merged as `d9c88f2`). **Refs #941** until the live check above
confirms every acceptance item; switches to **Closes #941** once it does.

## Phase 60: Slash refusal text, notice wrap, advisor settings mention (#938 items 2, 3, 5) [US1]

Renumbered against `origin/main` just before merging (this file's own convention): #941 part 2
merged first and kept Phase 59 (research.md decision 17); this phase moved to Phase 60 and its
own research.md note to decision 18.

- [X] T288 [US1] #938 item 2/FR-081: `src-tauri/src/session/agent/commands.rs` gains a shared
  `resolve_matched_descriptor(name, commands)` helper (also used by `classify_slash_invocation`
  itself) and `classify_unsupported_arguments(name, rest, commands) -> SubcommandRefusal`,
  distinguishing an unrecognised first word (lists the verified subcommand names, `[]` for a
  command with none, including `/switch`, whose own table is always pruned empty) from a
  recognised first word with extra text following it (names that one subcommand instead).
  `src-tauri/src/ipc/chat.rs`'s `UnsupportedArguments` branch matches on `SubcommandRefusal` to
  pick the right wording. Exported via `session::agent::mod.rs`.
- [X] T289 [US1] #938 items 3 and 5/FR-082/FR-083: `NoticeRow.tsx`'s short-notice branch passes
  `summaryWrap` to `CollapsedLine` (ui-architect-v3 roundtable ruling: wrap in place, never an
  expand control with nothing behind it). `ModelRolesSection.tsx`'s Advisor role description
  becomes "Reviews a Session's turns while the Advisor is on (/advisor on); falls back to
  Slow."
- [X] T290 [US1] #938 item 6 investigated (research.md decision 18, spec.md Clarifications):
  not a bug, no code change -- see those entries for the full root cause (OMP's own
  incomplete-todo nudge made the model reply twice, two real distinct messages). New
  `scripts/verify-938-slash-rest.mjs` (modelled on `verify-917-advisor-command.mjs`'s own real-
  ambient-omp structure, since no existing fake-omp fixture lists a builtin command with
  verified subcommands and AGENTS.md forbids adding one): asserts the Settings > Model roles
  Advisor description's exact new text, the refusal toast's exact text computed from this
  install's own real `/advisor` subcommand list (never hardcoded), and the short-notice
  summary span's real wrapping behaviour (narrowed viewport, `textOverflow`/`scrollWidth`/
  height measured, never a className check alone unless wrapping cannot be forced) across
  Dark, Obsidian, and Dark (high contrast), with screenshots and `report.json` (`gitHead`,
  `dirty`, `exeSha256`, `scriptSha256`, `findings`, `failures`, `notExercised`).

`pnpm typecheck`, `node scripts/check-indent.mjs`, `node scripts/check-file-size.mjs` all clean
on this phase's own head. `node --check` on the new script, plus a real import of it, confirmed
it refuses at its own module-scope `requireSharedCargoTarget` guard (issue #946) before touching
the filesystem or build -- the intended non-build-check behaviour when no build slot is granted
yet. The Rust side is CODE-VERIFIED ONLY at authoring time (no build slot granted yet):
`cargo fmt --check`/`cargo test`/`cargo clippy`, the Tauri debug build, and
`verify-938-slash-rest.mjs` run live against a real app are each pending the build slot grant
from Main.

**Gate round 1 fixes** (code-reviewer HIGH/MEDIUM, ui-architect-v3 decided, test-reviewer
MEDIUM): item 6's cause corrected (above, research.md decision 18); the old
`verified_subcommand_names` helper (with its own separate, unreachable-in-context any-match
fallback) is replaced by `classify_unsupported_arguments` sharing `resolve_matched_descriptor`
with `classify_slash_invocation` -- that shared resolver still has an any-match fallback, but
it is genuinely reachable there (`classify_slash_invocation`'s own file/skill command path
calls it for every command, not only a builtin already known to be `UnsupportedArguments`); a
first-word-is-a-valid-subcommand-but-extra-text-follows refusal now reads "/{name} {sub}
doesn't take more text yet. Try /{name} {sub} on its own." (never the "takes one of" listing,
which is reserved for an unrecognised first word); `docs/design/product-chat.md` documents both
the short-notice wrap rule and the two refusal wordings; the item-3 live check now forces real
wrapping (narrowed viewport) and measures it directly, falling back to a disclosed
`notExercised` only if it genuinely cannot be forced to wrap; the item-2 skip text now reads
"unproven in this run" rather than claiming unit coverage, and a missing `/advisor` is a hard
failure for both checks it would otherwise skip; the script's own toast wait counts toasts
present before sending and waits for a NEW one, and resolves the `/advisor` descriptor the same
way Rust does (prefer a builtin-sourced match, then name/alias) instead of a bare
`.find(name)`.

Opened as draft PR #996 (branch `feat/938-slash-rest`), merged `origin/main` (v0.4.0, `47e4ad7`)
before the build slot, no src/src-tauri conflicts. Build slot granted 2026-10-18: `cargo fmt
--check` found two real formatting diffs in this phase's own new Rust (fixed with `cargo fmt`);
the first two live runs each found and fixed one genuine SCRIPT-only bug, never product
behaviour: `clearKnownOutputFiles`'s own safety guard expects `SHOTS_DIR`'s parent to resolve
directly to the OS temp dir (one level, matching `verify-556-zero-box.mjs`'s own pattern), not
the two-level container-then-timestamp folder this script first used; and `clearComposer` must
click the message field before backspacing -- a prior `clickByLabel('Send message')` leaves real
browser focus on the Send BUTTON (no `onMouseDown` guard prevents it), so raw Backspace events
landed on the button instead of the textarea whenever a refusal left the draft text unCleared
(FR-019). **Final clean run, head `4721e918` (clean tree, `dirty: false`)**: `ci-local.mjs` all
16 steps PASS (Rust tests, Rust lint, and the Tauri debug build all genuinely ran this time, not
skipped); `verify-938-slash-rest.mjs` against the real built exe and real omp: **0 failures, 0
notExercised** -- FR-083's exact description text confirmed via DOM read; FR-081's two refusal
wordings both confirmed verbatim ("/advisor takes one of: on, off, status." and "/advisor on
doesn't take more text yet. Try /advisor on on its own."); FR-082's short notice was forced to a
REAL second line at a narrowed 220px width (height 40px over the 20px one-line baseline, no
horizontal overflow, text-overflow "clip") and screenshotted across Dark, Obsidian, and Dark
(high contrast). **Refs #938** switches to **Closes #938**: every remaining item (2, 3, 5) is
now live-proven on this exact head; item 1 and 4 already shipped via #954; item 6 was resolved
by investigation (research.md decision 18), no code to ship for it.

## Phase 61: Stage row focus and toggle follow-ups (#991, gate follow-ups from #941 part 1, PR #979) [US1]

Renumbered against `origin/main` just before merging (this branch's own convention, matching
Phase 60's own note above): #938/PR #996 merged first and claimed Phase 60, FR-081 to FR-083,
and research.md decision 18 -- this phase moved to Phase 61, its own tasks renumbered T288/T289
to T291/T292, its FR renumbered FR-081 to FR-084, and its own research.md note to decision 19.

**Goal**: fix the three code-level follow-ups the #941 lane's final gate deferred (four-round
rule, 2026-10-18): a running Stage auto-closing can drop a keyboard user's focus (a11y, WCAG
2.4.3), a manual Stage/chain-row toggle forgotten on remount, and a selector-scoping gap in
`scripts/verify-941-stage-naming-helpers.mjs`. The fourth item (a mouse user reading a Stage row
while it auto-closes) is a reconsideration, not a bug; see research.md decision 19 for the
ui-architect-v3 ruling that answers it and, as a side effect, item 1 too.

- [X] T291 `SubagentChainRow.tsx`'s `StageGroupRow`: the sync effect changes from bidirectional
  ("sync `open` to `isOpenByDefault` whichever way it moves") to upward-only -- a Stage still
  auto-opens while running/failed/cancelled/exited, but never auto-closes once open, matching
  FR-068's existing rule for the per-turn Subagent chain row (research.md decision 19).
- [X] New `src/renderer/features/chat/useStickyDisclosure.ts` (shared by both rows, gate round 1
  fix, code-reviewer DRY) plus `src/renderer/state/stage-toggle-store.ts` (`useStageToggleStore`,
  non-persisted, `bySession: Record<string, Record<string, boolean>>`, keyed by session id plus
  a Stage's own `group.id` or `chain:<first stage id>` for the chain row): the hook's own LOCAL
  state holds the auto-open latch (needs no persistence), the store holds ONLY a user's own
  manual toggle, surviving a remount (a session switch's own keyed-list reconciliation, or
  `Transcript.tsx`'s sr-only-stub/full-row swap -- gate round 2 correction: the chain row's own
  `stages.length < 2` early return does NOT unmount it; `null` keeps the instance and its hooks)
  (FR-084).
- [X] `scripts/verify-941-stage-naming-helpers.mjs`'s `titleSelector` scoped to the closest
  `[data-slot="message-scroller-item"]` ancestor, so it can never match the open per-turn
  Subagent chain row's own duplicate title text (`ChainStageLine`); `stageContentSelector`/
  `stageTriggerSelector` gate round 1 fix: `?.closest(...)` (not a bare `.closest(...)`) so a
  not-yet-rendered row evaluates to `undefined` throughout instead of throwing mid-`waitFor`.
- [X] T292 New `scripts/verify-991-stage-focus.mjs`, reusing the existing `stages-941.jsonl`
  fixture with one additive `{"__delay__": 1500}` (no new fixture, AGENTS.md): proves keyboard
  focus placed inside a genuinely running Stage 1 survives it settling all-success with the row
  itself staying open; proves `titleSelector`'s scoping (recorded honestly as order-independent
  hardening, not a red/green regression in this fixture's own DOM order); proves a manual toggle
  on a solo Stage row and on the chain row both survive a real session-switch remount, while an
  UNTOUCHED settled Stage (Stage 1) closes instead (proving the store holds only the manual
  choice). Gate round 1 fixes: a shim-confirmed check (fake-omp debug log's startup line); a
  real `waitFor` replacing a fixed sleep after the session switch; `clearKnownOutputFiles` plus
  a post-`stopLauncher` exit confirmation. Written, not run end-to-end (no build slot granted for
  this sub-task): `node --check` plus a real `import()` load-check on every touched/adjacent
  script, `pnpm typecheck` and `pnpm vitest run` (148/148) clean, `node scripts/check-indent.mjs`
  and `node scripts/check-file-size.mjs` clean.
- [X] Gate round 2 remediation (test-reviewer, code-reviewer, security-auditor, UI Lows): the
  store/hook stays manual-only (no change needed from round 1's own redesign); `open` now reads
  `manualOpen ?? (latchedAutoOpen || autoOpen)` (closes a one-render lag); the latch resets
  during render if its own session+row identity ever changes. The live check's Phase 3 uses
  Stage 1 (not Stage 2, which can mount already settled -- unpaced frames, dropped for
  reliability) as the proof that an untouched Stage closes on remount; a missed Running window
  is caught and recorded in `notExercised` instead of aborting the run; `SHOTS_DIR` regained its
  default timestamp suffix (now in the same path segment, not a nested folder, so
  `clearKnownOutputFiles`'s own direct-child-of-`tmpdir()` check still passes). Corrected two
  stale claims: the chain row's own `stages.length < 2` early return does not unmount it
  (returning `null` keeps the instance and every hook's state); `defaultOpen`'s own historical
  comment reworded to the past tense. `clearKnownOutputFiles` (verify-tauri-scratch-helpers.mjs)
  hardened against a symlink/junction planted at the shots-dir path, and now deletes/recreates
  under its own validated, canonical path rather than the caller's raw string.
- [X] Gate round 3 remediation (test-reviewer, code-reviewer, security-auditor, UI): the
  `{"__delay__": 1500}` plus the upward-only redesign together mean Stage 1 is now
  deterministically OPEN by the time `verify-941-stage-naming.mjs`'s own expand-cycle assertion
  for it ever runs -- fixed to expect `'true'`, not `'false'`; Stage 2/Stage 7 (no delay of
  their own, unpaced frames) now accept either known boolean instead of asserting a specific
  starting state. `expandByFinder`/`expandRow`/`assertExpandCycleByFinder` extracted to a new
  `scripts/verify-941-stage-naming-expand-helpers.mjs` (#806 file-size discipline, re-exported
  from the main helpers file for every existing consumer). The live check's own Stage-1-closes-
  on-remount proof is now explicitly recorded (in both the header and a `notExercised` entry) as
  hardening that cannot fail against `origin/main` on its own -- the genuine red there comes from
  the earlier stays-open/focus-preserved checks and the Stage 6/chain-row manual-toggle proof.
  Failure-visibility wording corrected throughout (no toast exists for a Stage failure; the
  visible signal is the closed Stage's own red icon plus "N done, M failed" header, the chain
  row's own roll-up only when the turn has 2+ Stages, and the screen-reader-only settle
  announcement). `useStickyDisclosure`'s identity-reset branch now also clears
  `localManualOpen`, so local-only state genuinely lasts only while an id stays `null`.
  `clearKnownOutputFiles` refuses any `fileNames` entry that is not a bare filename
  (`path.basename(name) !== name`), closing a path-traversal gap.
- [X] All five reviewers PASS (gate round 4). Follow-ups filed, not built here: issue #1000
  (Stage rows auto-opening AND the chain row both showing every agent once a turn has 2+
  Stages; narrows the auto-open condition in that case) and issue #1001 (the pre-existing
  solo-body/SpineList focus-loss path, #941).

Draft PR #999, branch `feat/991-stage-focus`, merged `origin/main` (#938/PR #996, `73c2c87`)
after the gate, before the build slot: renumbered FR-081 to FR-084, decision 18 to decision 19,
Phase 60 to Phase 61, T288/T289 to T291/T292 (all above) -- no src/src-tauri conflicts, only the
four doc files (this one, spec.md, research.md, docs/PLAN.md), all additive. **Refs #991** until
the live check above is actually run against a real built exe and confirms every acceptance
item; switches to **Closes #991** once it does.

## Phase 62: Async-result job matching scoped to unresolved Stage items (#989) [US1]

Filed 2026-10-18 by the #941 lane from PR #979: `apply_async_result_jobs`
(`subagent_items.rs`) matched an async-result job against EVERY `subagent` item in the whole
turn by bare `job_id`/`label`, with no `tool_call_id` scoping, so a repeated subagent name
across Stages (fixture `stages-941.jsonl`'s own "Story559", Stage 2 then Stage 5) let Stage 5's
later async-result clobber Stage 2's already-settled `result`/`duration_ms` (research.md
decision 20, FR-085). Gate round 1 (`agent://Main`, Code/Test FAIL) found the first fix under-
protected two ways and found a real clippy violation; all addressed below.

- [X] T293 [US1] `apply_async_result_jobs` (`subagent_items.rs`) rewritten as a single pass per
  job: an idempotency no-op check first (a job whose `job_id` an already-settled item holds,
  with that item's current status/result/duration already matching exactly what re-applying it
  would write, is skipped outright -- the live pipeline applies the SAME async-result message
  twice, `transcript.rs`'s `message_start`/`message_end` call sites both carrying the identical
  `details.jobs[]`); then candidate selection among still-UNSETTLED items, pooling a `job_id`
  match and a label match (the latter only when the item's own `job_id` is unset) into ONE set
  with no match-type priority, the latest `started_at` winning ties; each job claims at most one
  item per call. No `tool_call_id` scoping was possible: the async-result frame itself carries
  none (confirmed against `stages-941.jsonl`, the only fixture carrying any `async-result`
  message at all).
- [X] T294 [US1] Gate round 1 remediation (`agent://Main`, 3 findings, all addressed):
  **(1, HIGH, Code)** settlement is no longer `result.is_none()` -- a new Rust-only
  `async_settled` flag (`TranscriptItem::Subagent`, `#[serde(skip)]`, no wire/TS change) is set
  `true` only when a job's REAL data (`resultText`/`errorText`/`schema.data`) resolves a row,
  fixing the double-application-and-idempotency gap above. **(2, MEDIUM, Code+Test)** a
  label-only fallback result (no `resultText`/`schema`/`errorText` at all, e.g. the `wait` job
  for "gamma" in `subagents-background-turn.jsonl`) never sets `async_settled`, so a later real
  result for that same `job_id` still applies. **(3, MEDIUM, Code)** `job_id` matches no longer
  out-rank label matches by priority alone -- hand-traced repro (not executed against a real
  build): Stage 2's Story559 errors at
  the batch level with no result (`job_id` already `"Story559"` from its own
  `apply_batch_task_result`-read `progress[].id`, status Error, still unsettled); Stage 5's
  LATER async-result for ITS OWN Story559 then arrives -- pooling both match types and picking
  the latest `started_at` now correctly selects Stage 5 (started after Stage 2) instead of
  reusing the earlier bug's own failure mode through a different combination of unsettled rows.
  Doc comment and research.md decision 20/FR-085 amended to record all three rules.
- [X] T295 [US1] **(HIGH, Test, clippy)** `map_or(true, ...)` replaced with `.is_none_or(...)`
  throughout (clippy `unnecessary_map_or`, `-D warnings` in CI, matches the repo's own
  `ipc/sessions_agent.rs:284` precedent); the `else if { if ... }` nesting this rewrite
  introduced for the match-type-priority logic is gone entirely now that job_id/label matches
  are pooled (no `collapsible_if` surface left).
- [X] T296 [US1] Live-check coverage added additively to `scripts/verify-941-part2.mjs`
  (reusing the `stages-941.jsonl` fixture already recorded there -- no new fixture): a new
  `assertAsyncResultStageScoping` expands Stage 2 (starts collapsed) and Stage 5 (starts
  EXPANDED by default -- `StageGroupRow`'s own `isOpenByDefault` is true because Stage 5 has a
  failed member, FailAgent; `expandRow` no-ops safely on an already-open row) and
  reads each one's own Story559 member row's rendered result summary
  (`extractResultSummary`)/duration (`formatElapsed`) straight from `textContent`, asserting
  each Stage keeps its OWN result/duration and never shows the OTHER Stage's (Stage 2:
  "Implemented the fix for #559.", 1800ms -> "2s"; Stage 5: "Polished Story559 follow-up
  items.", 4300ms -> "4s"). `node --check`ed; not run (no-build prep lane, blocked on the build
  slot).
- [X] T297 [US1] Gate round 1 (MEDIUM, Test): duration assertions narrowed to the Story559
  member row's own rendered duration text specifically, not the whole Stage's `textContent`
  (which also happens to contain Story560's own "2s" in Stage 2); `notExercised` entries added
  naming what this fixture does NOT prove -- a `job_id` match beating a label match when BOTH
  are still unsettled, the latest-`started_at` tie-break among two still-unsettled candidates
  (this fixture's two Story559 rows are never BOTH unsettled at once -- Stage 2 settles via its
  own `msg-ar2` well before Stage 5 starts), one job resolving at most one row when two jobs in
  the same frame could otherwise compete, the `from_history` replay path (applies each stored
  message once), and the `wait`-tool `tool_execution_end` path (`transcript.rs:1293`/`:1529`)
  -- this fixture drives every job through the `custom`/`async-result` message path only.
  Gate round 2 correction: the "double-application-is-a-no-op case IS exercised" claim this
  task originally recorded was wrong -- no fixture state lets a second application land on a
  different row than the first, so it was never actually a proven finding; superseded by T299's
  design change, which removes the second application entirely (see T303's corrected
  `notExercised` entry).
- [X] T298 [US1] Docs: FR-085 added to this spec (`### Session 2026-10-18 (async-result Stage
  scoping, issue #989)` Clarifications entry plus the FR itself), research.md decision 20, and
  this Phase 62.

Gate round 2 (`agent://Main`, Code Critical + Design + Q1, Test HIGH): round 1 shipped a
compile error and two further design gaps; all addressed.

- [X] T299 [US1] **CRITICAL (Code)**: `upsert_subagent_items` (`subagent_items.rs:88`) lost its
  own `let existing_pos = items.iter().position(...)` binding during T293's rewrite, leaving a
  compile error (`match existing_pos` with nothing bound). Restored. Grepped every identifier
  T293 removed (`targets`, `by_job_id`, `by_label`) for leftover uses -- none found.
- [X] T300 [US1] **Design change (Code reviewer's option 2)**: a custom `async-result`
  message's jobs are now applied exactly ONCE, on `message_end` only -- `apply_message_snapshot`
  (`transcript.rs`) gates the `try_apply_async_result` call on its own `streaming == false`
  parameter (`message_start`/`message_update` both carry `streaming == true`), matching what
  `items_from_history` already did. A custom message is never token-streamed (no
  `message_update` at all); `message_start`/`message_end` arrive back to back with no frame
  between them for every one of `stages-941.jsonl`'s ten async-result messages (confirmed by
  reading the raw fixture: `msg-ar1`'s pair sits at raw file lines 66/67), so skipping the
  `message_start` application leaves no user-visible gap. Round 1's value-based idempotency
  no-op check (T293) is deleted outright -- no longer needed, and could itself have wrongly
  no-op'd a genuinely new job that happened to match a settled row's current values.
- [X] T301 [US1] **(MEDIUM, Code, Q1)** Candidate ranking replaced with three tiers, each only
  a tie-break for the one before it: (1) a still-**Running** row beats one already ended by its
  own batch result (Error/Cancelled/Done without a real async result yet); (2) a `job_id` match
  beats a label-only match; (3) latest `started_at` wins any remaining tie (implemented as one
  lexicographic tuple comparison `(is_running, matches_job_id, started_at)`). Traced by hand
  (not executed against a real build) against three scenarios, recorded in research.md decision
  20's gate-round-2 correction: (a) the sequential repro (Stage 2 batch-errored, not Running;
  Stage 5 later, Running) -- tier 1 alone decides it, Stage 5 wins outright; (b) the concurrent
  trace (A: Running, already carries this job's own `job_id`; B: Running, later `started_at`,
  label-only) -- tier 1 ties, tier 2 decides it, A wins even though B started later ("A must
  win", Q1's own answer verbatim); (c) the real committed fixture's own Stage 2/Stage 5 path --
  Stage 2 is excluded entirely at the settlement filter (settled via its own real `msg-ar2`
  before Stage 5 even starts), so Stage 5 is the only candidate and wins trivially, confirming
  the fixture itself never exercises (a) or (b) directly.
- [X] T302 [US1] **(MEDIUM, Test)** Known, accepted limit recorded: any overlap of two same-name
  jobs whose own async-result is still outstanding, both still Running (tiers 1 and 2 both
  tie), can still have results swapped by tier 3's best-effort `started_at` guess -- there is no
  real correlation key on this frame to settle it for certain; the real fix is #712's
  `parentToolCallId`. FR-085's "MUST only ever resolve the specific item" guarantee is narrowed
  to sequential Stages accordingly; the gate-round-1 Clarifications answer (spec.md, "Session
  2026-10-18 (async-result Stage scoping, issue #989)") is marked SUPERSEDED by a new, separate
  gate-round-2 entry (add-only convention), never edited in place.
- [X] T303 [US1] **(HIGH, Test)** `scripts/verify-941-part2.mjs`'s finding claiming the
  double-application case "IS exercised" was wrong (no fixture state lets a second application
  land on a different row than the first -- it was never actually proven); removed, replaced
  with a `notExercised` entry stating T300 removes the second application entirely, so there is
  nothing left to exercise either way. All "traced by hand"/"hand-traced ... not executed"
  language (this file, `subagent_items.rs`'s doc comment, research.md decision 20,
  `verify-941-part2.mjs`, `docs/PLAN.md`) now says exactly that, replacing "verified"/
  "live repro"/"proven" wording that overclaimed execution which never happened -- nothing is
  proven or live until a real build-slot run.

Gate round 3 (`agent://Main`, Code FAIL): item 1 required settling a fact from the REAL
installed omp, not the fixture; all 5 items addressed.

- [X] T304 [US1] **Settled from the real omp 18.11.1 binary (`agent://Main` item 1)**: extracted
  the bundled JS source embedded in the installed `omp.exe` (no separate npm/bun-global install
  exists; the compiled binary's own embedded strings were read directly) and found
  `packages/agent/src/agent-loop.ts`'s own `rt(e, t)` helper -- the ONE place in the whole
  binary that constructs a `message_start` frame -- unconditionally pushes it immediately
  followed by a `message_end` for the SAME message, with no code path anywhere that constructs
  one without the other. An async-result message (built by `packages/coding-agent/src/session/
  async-job-delivery.ts`'s `bQe(u)`, confirmed matching this repo's own fixture/Rust field
  shape) is appended the same way as any other message, through this exact pair. Settles T300's
  design (apply at `message_end` only) as grounded in REAL omp behaviour, not merely a fixture
  assumption -- `stages-941.jsonl`'s own header already says "SYNTHESIZED, not captured live".
- [X] T305 [US1] **HIGH (Code, `agent://Main` item 2)**: the same `bQe(u)` builder confirms real
  omp always sets `display: true` on an async-result message. Before this fix, a `message_start`
  frame (its own job application already skipped by T300) fell through every other `custom` arm
  to the plain `display == true` Notice branch, leaving a permanent Notice row that
  `message_end`'s own async-result application never replaces or removes. Fixed by
  short-circuiting on `custom_type == ASYNC_RESULT_CUSTOM_TYPE` before any other `custom` arm
  (`transcript.rs`): an async-result message now never builds a Notice/advisory/agent-message
  item at ANY frame.
- [X] T306 [US1] **LOW (Code, `agent://Main` item 3, decided)**: tier 2 (`job_id` beats
  label-only) now applies ONLY between two rows that are both still Running -- a `job_id` match
  from a row that is itself not running must never out-rank a label-only match just because it
  shares this job's `job_id`; among two not-running rows, tier 2 ties and tier 3 (`started_at`)
  decides directly. Known-limit sentence (T302) widened to "any overlap of two same-name jobs
  whose async-result is still outstanding".
- [X] T307 [US1] **MEDIUM (Test, `agent://Main` item 4)**: dropped the false claim that
  `subagents.jsonl`/`subagents-background-turn.jsonl` were checked for async-result messages
  (neither has any; only `stages-941.jsonl` does). Fixed the `msg-ar1` line citation to the raw
  file's actual lines 66/67 (the earlier "19/20" came from a filtered, comment-stripped line
  array, not the real file). Corrected research trace (a): Stage 5's row is a `job_id` match
  (its own `apply_batch_task_result` already set `job_id` from `progress[].id` before its own
  async-result applies, exactly like Stage 2), not label-only as originally traced. Recorded
  that `stages-941.jsonl` is synthesized (its own header says so) and T304's real-omp finding,
  not the fixture, is what actually grounds the `message_end`-guarantee assumption.
- [X] T308 [US1] **LOW (Test, `agent://Main` item 5)**: fixed the "Both Stage rows start
  collapsed" JSDoc claim in `scripts/verify-941-part2.mjs` -- Stage 5 actually starts EXPANDED
  by default (`StageGroupRow`'s own `isOpenByDefault = total > 1 && (isRunning || status ===
  'failed' || ...)` evaluates true because Stage 5 has a failed member, FailAgent); `expandRow`
  is a safe no-op on an already-open row, so behaviour is unaffected, only the doc comment was
  wrong. Left `verify-941-stage-naming-helpers.mjs`'s `?.closest` fix to #999's branch, not
  duplicated here, per instruction (it merges first, ahead of this lane's own eventual
  pre-slot `origin/main` merge).

Gate round 4 (`agent://Main`, Code/Test/Sec all PASS, one follow-up to make the live run prove
round 3's HIGH): all 3 items addressed.

- [X] T309 [US1] `scripts/fixtures/omp-frames/stages-941.jsonl`: `"display":true` added to
  every async-result message (`msg-ar1`..`msg-ar10`, both `message_start` and `message_end`
  frames), matching real omp. Checked origin/main's full set of this fixture's consumers
  (`git grep -l "stages-941" origin/main -- 'scripts/*.mjs'`: only `verify-941-part2.mjs` and
  `verify-941-stage-naming.mjs`) -- neither references `display`/`Notice`/`async-result` text
  anywhere, so none is affected (an async-result message never renders a transcript row of its
  own regardless). Fixture header comment updated to record the change and that check.
- [X] T310 [US1] `scripts/verify-941-part2.mjs`: new check after all ten Stages settle --
  scans the whole Transcript for `NoticeRow`'s own `sr-only` level marker ("Info:") and fails if
  any exist (every async-result message's own `content` is `""` in this fixture, so a bare
  substring match on "async-result" or the content text would never fire regardless of the bug;
  the row's own EXISTENCE, not its text, is the only reliable signal). Confirmed by reading
  `transcript.rs` at `53882ee` (gate round 2 head): `message_start` (`streaming: true`) still
  falls through past the skipped job-application to the `display == true` Notice branch with no
  short-circuit, and `message_end`'s own async-result application never removes the item it
  left behind -- ten stray notices would survive to the end of the turn. At HEAD the gate-round-
  3 short-circuit returns `items` unchanged on `message_start`, so none is ever built.
- [X] T311 [US1] Narrowed the doc comment at `transcript.rs`'s `"custom"` arm: the "never builds
  a Notice/advisory/agent-message item at ANY frame" claim applies to the LIVE path only --
  `items_from_history`'s own separate `"custom"` arm keeps its unchanged fallthrough, so a
  stored async-result message with no `details.jobs` at all still falls through to the same
  checks. Added the tier-1 swap clause to `subagent_items.rs`'s known-limit sentence: row A
  already ended its own batch call but is still unsettled (genuinely owed its own real
  async-result), row B is a later same-named Stage still Running -- a job meant for A can still
  land on B instead, since tier 1 always prefers the Running row regardless of which row the
  job actually belongs to; A then never settles. Tracked on #712 alongside the existing limit.

Opened as draft PR (branch `fix/989-async-stage`); `Closes #989` once the live check above is
confirmed against a real build. No cargo build run in this lane (no-build prep lane, blocked on
the build slot).

## Phase 63: Bounded Conversation preview/title scan (#862) [US1]

Renumbered against `origin/main` just before merging (this file's own convention): #1003
merged first and claimed Phase 62, FR-085, and research.md decision 20 -- this phase moved to
Phase 63, its own tasks renumbered T293/T294 to T312/T313, its FR renumbered FR-087 to FR-086,
and its own research.md note to decision 21.

**Goal**: fix the bug where the Conversation history list silently hid any Conversation whose
first user message landed past the Rust build's old fixed 8 KB preview-scan window (OMP's own
`memory_recall`/eager-prelude entries now routinely push it there) -- see research.md decision 21
for the full root cause and the bounded-line-streaming design that replaces the old fixed window.

- [X] T312 `src-tauri/src/ipc/conversations.rs`: `read_conversation_file` redesigned to read
  through an `AsyncReadExt::take(PREVIEW_SCAN_HARD_CAP_BYTES)`-limited handle (64 KiB hard cap on
  bytes actually read from disk) and stream complete JSONL lines (`read_until(b'\n', ...)` into
  one reused buffer), never a fixed-size byte buffer that can cut a record off mid-way, replacing
  the old fixed `PREVIEW_SCAN_BYTES` (8 KiB) window and its `read_preview_window` helper
  entirely. Reading stops the instant the first `role: 'user'` message is found; a file whose cap
  is hit first still returns its title with `preview: None` (turned into an empty string by
  `list_conversations`, FR-086) instead of being skipped -- `None` is now returned only when real
  end-of-file is reached within the cap with no user message anywhere, unchanged from the
  existing rule. `src/shared/model.ts`'s `ConversationInfo.preview` doc comment,
  `specs/001-core-session-workspace/data-model.md`'s own `preview` row, and
  `docs/spike/FINDINGS.md` item 11's stale "within the first 8 KB" assumption are all updated to
  match (FR-086, research.md decision 21).
- [X] T313 New `scripts/verify-862-conversation-history.mjs`, reusing the existing fake-omp
  harness and `user-message-time.jsonl` fixture verbatim (no new fixture, AGENTS.md) plus
  `verify-941-stage-naming-helpers.mjs`'s `buildOmpShim`/`launchBuiltExeWithEnv` and
  `verify-tauri-session-list-helpers.mjs`'s `addRepository`/`createSessionViaQuickCreate`: seeds
  two real, hand-built Conversation `.jsonl` files in the Session's own `session_dir` before
  launch (a normal one, and a long-prelude one whose own prefix bytes are measured at runtime and
  asserted to sit strictly between the old 8 KiB window and the new 64 KiB cap -- about 9.6 KB,
  matching issue #862's own observed shape), then opens the Conversation-history dialog and
  asserts both rows render with the correct title and preview text. Shim-confirmed guard
  (fake-omp debug log's own startup pid line) and a fresh-log guard (the debug log lives inside a
  freshly `mkdtemp`'d directory every run, never a reused path). MUST fail on `origin/main`:
  there, `list_conversations` silently `continue`s past the long-prelude file, so the row-count
  assertion reads 1, not 2 -- explained from the code in the script's own header comment, not run
  against `origin/main` (no build slot granted for this sub-task). **Not exercised by this
  script**: a Conversation whose cap is hit with no user message found (asserting it is still
  listed, title only); a Conversation reaching real end-of-file within the cap with genuinely no
  user message (asserting it is skipped); and that a genuinely multi-megabyte Conversation file
  stays cheap to list -- all three are proven by reading `read_conversation_file`'s own
  `take()`-enforced hard cap, its early break on match, and its unchanged real-EOF skip path, not
  by constructing the corresponding fixture files on disk (recorded honestly in the script's own
  `notExercised`). Checks run before the live check itself: `node --check` plus a real
  `import()` load-check on every helper module it imports, `node scripts/check-indent.mjs` and
  `node scripts/check-file-size.mjs` clean, `cargo fmt --manifest-path src-tauri/Cargo.toml --
  --check` clean, `pnpm typecheck` clean, `pnpm vitest run` (148/148) clean,
  `node scripts/check-parity.mjs --gate` clean (103/103, 24/24). Run end-to-end once the build
  slot was granted (below): green.
- [X] Gate round 1 remediation (code-reviewer FAIL, test-reviewer FAIL, security-auditor PASS,
  PR #1006): the cap was not actually hard -- a plain `BufReader::read_line` over the raw file
  handle only checked an own-tracked byte counter AFTER each complete line, so one sufficiently
  long single line could still be read past the cap; fixed by wrapping the handle in
  `AsyncReadExt::take(PREVIEW_SCAN_HARD_CAP_BYTES)` before the `BufReader` (research.md decision
  22's own gate round 1 correction). Lines (including the title line) now parse from raw bytes
  (`serde_json::from_slice`) rather than a `String` conversion first, confirming invalid UTF-8 in
  one line fails to parse and is skipped rather than aborting the whole scan. A `role: 'user'`
  message with empty/missing `content` (image-only) now counts as found immediately (`preview:
  Some(String::new())`) instead of leaving the scan to keep looking for a later, text-bearing
  message and hiding the row if none existed (Decided, Skippy, delegated by Stuart 2026-10-18,
  gate round 1; FR-086 and its Clarifications entry updated). Script fixes: an explicit
  `mkdirSync(SHOTS_DIR, { recursive: true })` added as belt-and-braces alongside
  `clearKnownOutputFiles`'s own internal one; `notExercised` reworded into the three specific
  entries above; header comment's approximate prefix size corrected to the measured ~9.6 KB.
- [X] Gate round 2 remediation (code-reviewer PASS, test-reviewer PASS, security-auditor PASS,
  PR #1006): round 1's cap still had two edge-case gaps, both fixed. (1) Any missing trailing
  newline unconditionally set `cap_hit`, even genuinely below the cap (a valid final line with
  no trailing newline lost its own preview; a truncated last line with no user message got
  listed anyway) -- fixed by checking `bytes_read_total > PREVIEW_SCAN_HARD_CAP_BYTES` first;
  only that counts as a cap hit, and a within-budget piece missing its newline is now parsed as
  the file's own genuine last line. (2) `take(cap)` plus a `>= cap` comparison could misreport a
  real, exactly-cap-sized file with no user message as a cap hit -- fixed by `take(cap + 1)` (one
  sentinel byte past the cap) and testing `bytes_read_total > cap` (strictly past), so only a
  file that genuinely holds more than the cap is ever reported as a cap hit. `BufReader::new`
  replaces `with_capacity(cap, ...)`: `take` already bounds every read, so the extra 64 KiB
  upfront buffer was wasted I/O/memory. Script: the long-prelude fixture's own upper-bound guard
  now adds the final user-message line's own bytes to the prelude's, not just the prelude alone;
  a 4th `notExercised` entry (image-only/empty-content first message) added, cited to the exact
  lines.

**Live-verified (2026-10-18, build slot granted by Main, PR #1006 at `7b0c936`)**:
`node scripts/ci-local.mjs` ran all 16 `ci.yml` steps clean -- typecheck; vitest 148/148;
indent; theme-contrast; drag-regions; IPC parity 103/103 requests, 24/24 events; file-size;
version consistency; OMP schema drift plus its self-test; `cargo fmt --check`; `cargo test`
738/738 (0 failed, 1 ignored); `cargo clippy --all-targets -- -D warnings`; `tauri build
--debug --no-bundle`; UI text. `node scripts/verify-862-conversation-history.mjs` then ran
green against that build: `report.json` records `failures: []`, `exitCode: 0`; the saved
screenshot shows the Conversation-history dialog with both rows rendered, the long-prelude
Conversation's own title and its real preview text ("ISSUE862-LONG-PREVIEW-CHECK: real first
user message, found past the old 8...") in full, 9,901 bytes into the file -- past the old
8,192-byte window, under the new 65,536-byte cap. PR #1006 switched from `Refs #862` to
`Closes #862`.

## Phase 64: Stage rows defer running auto-open to the chain row (#1000, FR-087, research.md
decision 22) [US1]

Takes the next free numbers against `origin/main` (this branch's own convention, matching
Phase 60/61's own notes above): #1003 (Async-result job matching, FR-085, decision 20, Phase 62,
T293-T311) and #1006 (Conversation preview/title scan, FR-086, decision 21, Phase 63, T312/T313)
both merged first, claiming every number this phase previously used (including a second,
independent collision on the same T312/T313/FR-086/decision-21/Phase-63 set this branch had
already renumbered to once for #1003) -- renumbered again to Phase 64, FR-087, decision 22,
T314/T315 below.

**Goal**: narrow `StageGroupRow`'s own auto-open condition (FR-067/FR-084) so that once a turn
has two or more Stages, a Stage row no longer auto-opens merely because one of its own agents
is running -- only failed/cancelled/exited still do -- since the per-turn Subagent chain row
(FR-068) already carries the live running overview for the whole turn at that point, and a
turn's running agents were otherwise shown expanded twice over (ui-architect-v3 ruling at PR
#999's own gate, recorded on issue #1000; full rationale in research.md decision 22).

- [X] T314 `SubagentChainRow.tsx`'s `StageGroupRow`: `isOpenByDefault` now reads
  `group.totalStages` -- while a turn has only one Stage, unchanged (`total > 1 && (isRunning ||
  failed/cancelled/exited)`); once a turn has two or more Stages, `running` is dropped from the
  condition (`total > 1 && (failed/cancelled/exited)`). No change to `useStickyDisclosure`'s own
  upward-only latch, `StageGroupRow`'s solo-Stage exclusion (`total > 1`), or `SubagentChainRow`'s
  own `isUnsettled`/default-open rule -- all three already give this decision everything it
  needs with no further code (FR-087).
- [X] T315 New `scripts/verify-1000-stage-defer.mjs`, reusing the existing `stages-941.jsonl`
  fixture with one additional additive `{"__delay__": 1500}` (no new fixture, AGENTS.md; mirrors
  Stage 1's own existing delay, now also applied to Stage 2) -- the only window in this fixture
  where a Stage genuinely, observably runs while the turn already has two or more Stages.
  Proves: Stage 2 stays closed while running at that point, with the chain row already open and
  showing "2 stages"/"Running"; Stage 1 (opened earlier, single-Stage-so-far) does not close
  itself once the turn grows past it (amended: Stage 3, see gate round 1); after the whole
  ten-Stage turn settles, Stage 2 stays
  closed (never auto-opened, so nothing to self-close) while Stage 5 (its own failed member) is
  open regardless of Stage count; a manual open plus keyboard focus placed inside Stage 2 while
  running survives both it settling and every later Stage streaming in behind it (WCAG 2.4.3).
  Shim-confirmed check and a fresh, `mkdtemp`'d debug-log path (same pattern as
  `verify-941-part2.mjs`/`verify-991-stage-focus.mjs`). Written, not run end-to-end (no build
  slot granted for this sub-task): `node --check` plus a real `import()` load-check, `pnpm
  typecheck`, `node scripts/check-indent.mjs`, `node scripts/check-file-size.mjs`, and `node
  scripts/check-parity.mjs --gate` all clean.
- [X] Confirmed, no change needed: `scripts/verify-941-stage-naming-helpers.mjs`'s own Stage 1
  `'true'` expand-cycle expectation and `scripts/verify-991-stage-focus.mjs`'s own
  focus-survives-settling phase both still hold exactly as before -- Stage 1's own render during
  ITS OWN delay window is still single-Stage-so-far (Stage 2's new delay runs strictly later in
  the tape), so it auto-opens under the UNCHANGED single-Stage half of the new condition either
  way; by the time either script's own assertions run (after the whole turn settles), Stage 1
  stays open purely through `useStickyDisclosure`'s own upward-only latch, set during its own
  earlier running window, regardless of the turn later being reclassified multi-Stage. Also
  confirmed unaffected by the fixture's own second additive delay (a pure wall-clock pacing
  change, no JSON field): `verify-941-stage-naming-panel-helpers.mjs`'s own Story559
  duration-based disambiguation ("2s" from Stage 2's 1800ms, "4s" from Stage 5's 4300ms) and
  `verify-941-part2.mjs`'s own position-scoped `EXPECTED_PANEL_ROWS` structure check.
- [X] Gate round 1 remediation (code-reviewer, test-reviewer, a11y-auditor; #1007): T314's
  `isOpenByDefault` now reads a new `hasBadMember` (`counts.failed`/`counts.cancelled`/
  `counts.exited` directly, not the Stage's own overall `status`), opening a multi-Stage Stage
  the instant any ONE member goes bad instead of waiting for the whole Stage to settle
  (Decided, Skippy, delegated by Stuart, UI architect's suggested fix; FR-087 and research.md
  decision 22 reworded to match, Clarifications wording split into two sentences). T315's
  `verify-1000-stage-defer.mjs` rewritten: "is Stage 2 running" now reads the always-rendered
  TRIGGER's own `aria-label`, never the collapsible content (Radix never renders it while
  closed -- Stage 2 staying closed IS the behaviour under test, so the old content-based wait
  silently timed out and masked the whole discriminator); the closed-while-running screenshot
  now taken BEFORE the manual-open step, so it actually shows what it claims; a NEW, genuinely
  untouched multi-agent Stage (Stage 3) checked closed at full settle, since Stage 2 itself is
  manually opened later in the same run and is no longer a clean "never touched" witness; a
  distinct NOT-PROVEN verdict and exit code (2), never DONE/exit 0, when the critical discriminator
  window is missed. `SubagentChainRow.tsx` gained `aria-live="off"` on the Stage content
  wrapper (context brief/"Uses:" line), matching `SpineList`/`UpNextList`'s own convention.
  Stale "Stage 2 has no delay" comments fixed in `verify-941-stage-naming-expand-helpers.mjs`
  and `verify-991-stage-focus.mjs` (both now state Stage 2 carries its own additive delay too
  and is deterministically closed, not merely unpaced). Non-build checks re-run clean
  (`node --check`, `pnpm typecheck`, `pnpm vitest run` 148/148, `check:indent`, `check:file-size`,
  `check:parity --gate`).

## Phase 65: Stop-cut-short tool rows settle neutral (#911, FR-088) [US1]

**Goal**: a tool call the user Stops mid-flight settles to a new, neutral `cancelled` status
(stop-circle icon, muted "Stopped" label, no Error line) instead of the full failed/red
treatment a genuine failure gets -- confirmed live during #570's own gate round 1
(`verify-570-tool-colours.mjs` turn (c), 2026-10-16), recorded there as a gap this story's own
pre-existing `interrupted`/`exited` code did not cover (out of scope for #570). Tool rows had
no `cancelled` concept the way subagents already got at #563 decision 15.

- [X] T316 `src-tauri/src/omp/transcript.rs`: new `ToolStatus::Cancelled` variant. New
  `AgentState.turn_abort_requested` (`session/agent/mod.rs`), set by `chat.rs::stop()` under
  the same lock its existing no-op checks already read (before the `abort` RPC goes out),
  cleared by `handle_turn_settled` (`frame.rs`) once the turn it belongs to fully settles.
  Threaded through `apply_transcript_frame` → `TranscriptState::apply_frame` →
  `apply_frame_items` → `apply_tool_execution_end`, which now settles a call's `isError:true`
  end frame to `Cancelled` (instead of `Error`) only when the flag is set AND the call's own
  prior status was genuinely `Running` -- never by matching the call's own error text ("Command
  aborted" is OMP's wording, not a contract). `finalize_live_transcript`'s process-exit path
  (`diff.rs`) extended the same way: `SubagentFinalizeCause::UserStop` now also settles a
  still-running Tool row to `Cancelled` (`Crash` still settles it `Error`), removing the one
  remaining "Tool rows have no `Cancelled` concept" exception that split left behind.
  Renderer: `src/shared/model.ts`'s tool `status` union gains `'cancelled'`; `toolStatus.tsx`'s
  `RowStatus`/`toolStatusLabel` ("Stopped")/`GLYPH_KEY_BY_STATUS` (the SAME `cancelled`
  stop-circle shape `subagentStatus.tsx`'s own subagent `cancelled` already uses, via the
  shared `statusGlyph.ts` table, never a second hand-written copy); `ToolRow.tsx`'s
  `ToolGroupRow` gains a `cancelledCount`, ranked between `interrupted` and `done` in the
  group's own worst-state order, with an "N stopped" meta count beside "N failed"/
  "N interrupted"; `transcriptRowVisibility.ts`'s tool-group force-visible rule deliberately
  does NOT extend to `cancelled` (as unremarkable as `done`, FR-088); `RequestCard.tsx`'s `ask`
  tool handling folds the new status into its existing "Cancelled" wording (D22), alongside the
  pre-existing `error` case.
- [X] T317 New `scripts/verify-911-stop-neutral.mjs`, modelled on
  `scripts/verify-570-tool-colours.mjs` (live Stop button) and
  `scripts/verify-1000-stage-defer.mjs` (fake-omp fixture, report.json, themed screenshots).
  New fixture `scripts/fixtures/omp-frames/stop-911.jsonl` (AGENTS.md: a fake-omp frame
  fixture genuinely needed here -- no existing tape scripts an `abort` wait, and a real omp's
  own abort timing is not deterministic enough to assert against): turn A runs a `bash` call,
  waits for the real `abort` command the script's own Stop click sends, then settles that
  call's `tool_execution_end` with `isError:true` (OMP's own real wire shape, per #570's live
  finding) and a `prompt_result` of `status: "aborted"`; turn B runs a second `bash` call that
  fails genuinely (`isError:true`, no abort in flight); a third, already-`done` call proves
  unaffected. Proves: turn A's row settles to the neutral `cancelled` treatment (stop-circle
  icon class, muted colour token, "Stopped" label, no Error line); turn B's row stays `error`
  (red icon/label, Error line); the done call is untouched. Must fail on `origin/main` for the
  right reason (no `Cancelled`/`turn_abort_requested` code there at all -- turn A settles
  `error` exactly like turn B). Screenshots in all 3 themes (`switchTheme`). Written, not run
  end-to-end: no build slot granted for this sub-task (the fix is Rust-side, so the live check
  cannot genuinely pass without a rebuilt exe) -- `node --check` plus a real `import()`
  load-check are the only commands actually run against this file and the new fixture.
  **notExercised**: the fixture's own `abort`→`tool_execution_end{isError:true}`→
  `prompt_result{status:"aborted"}` sequence is hand-written against the documented wire
  contract (`src/shared/frames.ts`'s `PromptResultFrame.status` union already lists
  `'aborted'`; `transcript.rs`'s own `apply_prompt_result_notice` already has an `"aborted"`
  arm) and against #570's own live finding of the exact `isError:true`/"Command aborted" shape
  a genuine OMP abort produces -- it is not itself a fresh live capture of a real signed-in
  `omp`'s own abort response (recapturing one was out of scope for this fix; #570's own
  turn (c) already captured the shape once, live, confirming it).

**Spec**: `spec.md` gains FR-088 (amends FR-008) and a dated Clarifications section recording
the decision, Decided/Skippy/delegated-by-Stuart per this story's own away-mode convention.

**Gate round 1 remediation** (code-reviewer/test-reviewer/accessibility-auditor/ui-architect-v3;
all addressed): **(1, High)** `turn_abort_requested` narrowed to only SET while a turn is
genuinely in flight (`Working`/`NeedsYou` AND odd `turn_generation`), and cleared in every
place it could otherwise leak (`agent_start`, a fresh launch/attach, `handle_exit`, and
`chat.rs::stop()` itself when the `abort` RPC errors/times out/returns `success != true`).
**(2, High)** `src-tauri/tests/transcript_golden.rs:79` updated for the new `apply_frame`
signature (contract update, not a new test); grepped the whole crate for every other caller of
every changed signature, none found. **(3, Medium)** `handle_exit`'s own `finalize_cause` now
also reads `UserStop` from `turn_abort_requested` alone (not only the session-level
`requested && stop_requested`), so a process exit racing an in-flight Stop still settles
`Cancelled`. **(4, Medium)** `apply_batch_task_result` (`subagent_items.rs`) settles a still-
`Running` subagent member `Cancelled` when `turn_abort_requested` is set, even when OMP's own
per-agent `progress[i]` entry says nothing of the kind. **(5, Medium, Decided)** history
reload has no persisted abort signal -- recorded as a known limitation (FR-088, Clarifications,
and the live-check's own `notExercised`), deliberately NOT worked around with an error-text
heuristic. **(6, Medium, Decided)** the `prompt_result{status:"aborted"}` notice now reads
"Turn stopped." (was "Turn aborted."); subagent `Cancelled` and the `ask` tool's own
"Cancelled" wording are unchanged (both confirmed to have sources other than the user's Stop).
**(7, Medium)** `docs/design/foundations-icons.md`/`product-chat.md` updated for the tool-row
`cancelled` status and the group's "N stopped" count. **(8, Medium)** `verify-911-stop-
neutral.mjs` now waits for the bash row's own status word to read "Running" before clicking
Stop, and re-resolves both colour tokens plus both rows' own icon colour once per theme inside
the existing screenshot loop, not only under the default theme. **(9, Low)**
`finalize_live_items`'s own stale doc comment fixed; a stopped hidden bookkeeping call (e.g.
`todo`) no longer posts a red failure notice; the no-matching-`tool_execution_start` end-frame
branch now also respects `turn_abort_requested`.

## Phase 66: Stage label colour and jump-to-Stage from the chain row (#1008, FR-089) [US1]

**Goal**: a failed Stage's own label reads `text-severity-error`, the same way a failed tool
call's own label already does; the chain row's own "Stage N" text becomes a real button that
scrolls to, opens, and focuses the Stage row it describes -- both items pre-decided on the
issue (ui-architect-v3 gate on PR #1007/#1000).

- [X] T318 `src/renderer/features/subagents/subagentStatus.tsx`: new `isSubagentFailedStatus`
  (mirrors `isSubagentSuccessStatus`), `SUBAGENT_ERROR_TEXT_CLASS` (`text-severity-error`), and
  the shared `subagentStatusTextClass(status)` combinator (green when finished, the new error
  class when failed, `undefined` otherwise) both `StageGroupRow` and `ChainStageLine` read, so
  the two surfaces can never colour a Stage differently.
- [X] T319 `src/renderer/features/chat/CollapsedLine.tsx`: new optional `id` prop threaded onto
  whichever element already receives focus (the plain row `div` with no `children`, or the
  `CollapsibleTrigger` button with them) -- a stable DOM id a sibling component (the chain row)
  can look a Stage row up by, since there is no React ref across sibling subtrees.
- [X] T320 `src/renderer/features/chat/SubagentChainRow.tsx`: `StageGroupRow`'s own
  `labelClassName` reads `subagentStatusTextClass(status)` (replacing the success-only
  ternary), tagged with the new `id={stageRowDomId(group.id)}`; `ChainStageLine`'s "Stage N"
  `<span>` becomes a `<button>` (accessible name "Go to Stage N", same colour class) calling
  the new `jumpToStage(sessionId, stage.id)` on click. Split `stageRowDomId`/`jumpToStage` out
  to a new `src/renderer/features/chat/stageJump.ts` module (keeps `SubagentChainRow.tsx` under
  the #806 600-line cap): `jumpToStage` forces the target's manual-open state through
  `useStageToggleStore.setManualOpen` directly (the same store `useStickyDisclosure` already
  reads, decision 19/FR-084/#991), then `document.getElementById`/`scrollIntoView`/`.focus()`s
  the row found by its new DOM id, dropping to `'auto'` scroll under
  `prefers-reduced-motion` (matching `SideChatPanel.tsx`'s own convention).
- [X] T321 New `scripts/verify-1008-stage-label-jump.mjs`, modelled on
  `scripts/verify-1000-stage-defer.mjs`'s harness scaffolding and
  `verify-941-stage-naming-helpers.mjs`'s selectors/`resolveCssVarColor` pattern. Reuses the
  SAME `stages-941.jsonl` fixture (AGENTS.md: no new fixtures needed -- it already carries a
  genuinely failed Stage, Stage 5's own `FailAgent`, among ten Stages). Measures Stage 5's own
  label against the theme's resolved `--severity-error` (red/green discriminator 1: reads the
  default colour on `origin/main`) and Stage 1's own label against the same token (a done-Stage
  regression guard). Proves the jump on Stage 1 (mouse click) and Stage 3 (keyboard: focus the
  button directly, then a real Enter keypress) -- both multi-member, fully finished, never
  otherwise touched, so each starts genuinely closed: asserts the target row opens
  (`aria-expanded`), holds `document.activeElement`, and sits inside the viewport
  (`getBoundingClientRect`). The jump button's own existence
  (`button[aria-label="Go to Stage N"]`) is red/green discriminator 2 -- `origin/main` never
  renders one (`ChainStageLine`'s text stays a plain span there). Screenshots in all 3 themes.
  **Written, not run end-to-end**: no build slot granted for this sub-task -- `node --check`
  plus a real `import()` load-check (`CARGO_TARGET_DIR` unset, stopping at the shared
  build-slot guard) are the only commands actually run against this file.

**Spec**: `spec.md` gains FR-089 (amends FR-079, FR-068) and a dated Clarifications section
recording both decisions, Decided/Skippy/delegated-by-Stuart per this story's own away-mode
convention; `research.md` gains decision 23 with the full rationale.

**Gate round 1 remediation** (Main, 2026-10-18; Sec/Code/A11y PASS, Test/UI FAIL -- all 9 items
addressed, no build slot used): **(1, High, UI, Decided)** the "Go to Stage N" button now
renders only while its own Stage row reads `rowVisibility(stage, transcriptDisplay) ===
'visible'` (`ChainStageLine.tsx`) -- "Show tool calls" off can drop a settled, problem-free
Stage's own row entirely (not merely an `'sr-only'` stub), leaving nothing for `jumpToStage` to
find; a hidden Stage falls back to its original plain-text label, and `jumpToStage` itself
defensively no-ops `setManualOpen` when the row lookup comes back empty. **(2, Medium, UI,
Decided: top-aligned, not centred)** `jumpToStage` (`stageJump.ts`) now scrolls ONLY the
transcript's own `[aria-label="Transcript"]` viewport (found via `row.closest(...)`, its
position relative to the row computed by rect maths, `viewport.scrollTo({ top, behavior })`),
never a bare `scrollIntoView` that would walk up every scrollable ancestor (a real hazard in a
split pane); `row.focus({ preventScroll: true })` stops the browser's own native focus-scroll
fighting it. **(3, Medium, UI, Decided)** the button gained `cursor-pointer`, `hover:underline`,
a `title` of "Go to {stage heading}", and `py-0.5` to match `ChainAgentEntry`'s own 28px button
height. **(4, Medium, UI, Decided: scope by sessionId)** `stageRowDomId` now takes `sessionId`
too -- a split pane showing two Sessions at once could otherwise produce a duplicate DOM id
across their two Transcript trees, a real HTML violation, not merely an ambiguous lookup. **(5,
Medium, UI)** `subagentStatusTextClass` now takes the roll-up `counts` directly (not a single
derived `status`): a Stage with any member settled `failed` is red immediately, even while a
sibling member is still running, matching FR-089's own "any member failed" wording exactly
(previously derived from `overallStatus`, whose running-first priority order delayed the red
label until the whole Stage settled). **(6, Low, all, Decided)** the button's own `aria-label`
is now "Go to {full stage heading, speech form}" (e.g. "Go to Stage 5, Finish the remaining
Story559 polish and run the fail probe."), not a bare "Go to Stage N" that never distinguished
two unopened Stages for a screen reader user. **(7, High, Test)**
`scripts/verify-1008-stage-label-jump.mjs`'s colour checks moved INSIDE the per-theme loop,
re-resolving `--severity-error`/`--severity-success` after each `switchTheme` (previously
resolved once, under the default theme only), and now also measure the chain row's own "Go to
Stage 5" button text, not only the in-place label. **(8, Medium, Test)** before each jump, the
script scrolls the transcript to its own end and hard-asserts the target row starts off-screen
(Stage 1/Stage 3 sit near the top of the ten-Stage turn); after the jump, `cdp.waitFor` polls
for in-viewport instead of a single immediate read, since the now-smooth scroll settles
asynchronously. **(9, Medium, Test)** #991 persistence across a remount is now exercised: right
after Stage 1's own mouse jump, "Show tool calls" is toggled off then back on via the real
`window.refract.settings.setTranscriptDisplay` IPC round trip (the same dev-exposed call
`verify-557-thought-runs.mjs` already uses) -- doubling as item 1's own visibility-gating proof
(Stage 1's button must disappear while hidden, Stage 5's must stay, force-visible) and
confirming Stage 1's manual-open survives the remount once restored. `prefers-reduced-motion` is
recorded in the script's own `notExercised` (no CDP emulation set up for it), never silently
skipped without comment. `ChainStageLine`/`ChainAgentEntry` were also split out of
`SubagentChainRow.tsx` into a new `ChainStageLine.tsx` during this round, purely to stay under
the #806 600-line cap once the above fixes landed (safe circular import back to
`SubagentChainRow.tsx` for hoisted `function`/`type` exports only).

**Non-build checks** (re-run after gate round 1 remediation): `pnpm typecheck`, `pnpm run
check:indent`, `pnpm run check:file-size` (`SubagentChainRow.tsx` 500 lines, new
`ChainStageLine.tsx` well under the cap, no baseline bump), `pnpm run check:parity -- --gate`,
`pnpm exec vitest run` (148/148 existing tests, no new tests per the prototyping-phase rule),
`node --check` plus a real `import()` load-check on the rewritten live-check script
(`CARGO_TARGET_DIR` unset, stopping at the shared build-slot guard) all clean.

## Phase 67: One-agent to two-agent Stage focus-loss follow-up (#1001, FR-090) [US1]

**Goal**: a keyboard-focused solo Stage's own Prompt/Result code block never drops focus to
`<body>` the instant a second agent streams into the same Stage and the content swaps from a
bare `SubagentBody` to a `SpineList` -- pre-decided on the issue (accessibility auditor finding
at PR #999's own gate, Decided/Skippy/delegated-by-Stuart 2026-10-18/2026-10-19).

- [X] T322 `src/renderer/features/chat/SubagentChainRow.tsx`: `StageGroupRow` gains
  `memberContentRef` (a CALLBACK ref -- see the live-run record below for why, wrapping only
  the solo-body-or-`SpineList` slot, never unmounting itself across the transition),
  `triggerRef` (forwarded onto the Stage's own `CollapsedLine`), `focusWasInsideRef` (kept
  current by a `focusin`/`focusout` listener attached via that callback ref, since a focused
  node's removal blurs it to `<body>` synchronously -- there is no later point at which the
  just-removed element can be asked whether it held focus), and `prevTotalRef`. A
  `useLayoutEffect` keyed on `total` moves focus to `triggerRef` the instant a 1-to-2-member
  transition is observed with `focusWasInsideRef.current` true and `document.activeElement`
  already fallen to `<body>`/`null`. Structural no-remount alternative (pre-wrapping the solo
  body in the same `SpineList`/`SpineItem` shape) considered and rejected: see FR-090/spec.md
  Clarifications for the full rationale. **Live-run record**: first attempt (head `3941250`)
  FAILED -- the listener was attached via a plain `useRef` + `useEffect(() => {...}, [])`,
  which runs once at mount, but a solo Stage starts collapsed (Radix never renders
  `CollapsibleContent` while closed), so the ref was still `null` then and the listener never
  attached once the row was later expanded; fixed with a callback ref (head `28b26e1`, re-fires
  on every real mount/unmount). **Gate round 1** (Main, 2026-10-19) found two further Mediums
  in the `focusin`/`focusout` handling, both fixed: a window blur fires `focusout` with
  `relatedTarget` null while `document.activeElement` stays the SAME element (never reassigned
  by a blur) -- the handler now returns early (keeping the flag) when `event.target ===
  document.activeElement`; a click onto a non-focusable spot used to leave the flag stuck true
  forever (indistinguishable from a real removal using `relatedTarget`/`activeElement` alone)
  -- now uses the repo's own `ProfileAlertRows.tsx`/`FileExplorerPanel.tsx` rAF-plus-
  `isConnected` pattern to tell a deliberate click-away apart from a genuine removal.
- [X] T323 New fixture `scripts/fixtures/omp-frames/stages-1001.jsonl` (a new fixture was
  required: every existing `stages-941.jsonl` Stage declares its full member count upfront in
  one `task()` call's own `tasks[]`, so none of them ever grows after first render). One Stage
  whose two members arrive as two SEPARATE `task()` calls sharing one assistant message id --
  the documented mechanism (`transcript.rs`/`subagent_items.rs`) by which a Stage genuinely
  grows `total` from 1 to 2 in place. The first call's own shared batch `context` is the only
  one either member ever carries, so the Stage's own header label stays stable across the
  transition (`computeStageLabel`'s tier-1 rule), giving the live check one stable title
  selector throughout.
- [X] T324 New `scripts/verify-1001-stage-focus-join.mjs`, modelled on
  `scripts/verify-1000-stage-defer.mjs`/`verify-991-stage-focus.mjs`'s harness scaffolding and
  `verify-941-stage-naming-helpers.mjs`'s selectors. Places keyboard focus on the solo member's
  own Prompt code block, then samples `document.activeElement` on every animation frame (not
  Node-side polling, so no CDP round-trip jitter can narrow the window) across the whole join --
  THE red/green discriminator: zero sampled frames may ever read `document.activeElement ===
  document.body`. Also confirms focus lands specifically on the Stage's own trigger once
  settled (the fix's own stated remedy, not merely "somewhere other than body"). Per-theme
  screenshots only (no colour-dependent assertion), matching `verify-991-stage-focus.mjs`'s own
  theme-loop rationale. **Live-run record**: first attempt (head `3941250`) FAILED --
  `document.activeElement` was `<body>` in 208 of 390 sampled frames -- fixed with a callback
  ref (head `28b26e1`, see T322's own note above); re-ran clean (0 failures, 0 notExercised,
  verdict DONE).

**Spec**: `spec.md` gains FR-090 (amends FR-067) and a dated Clarifications section recording
the no-remount-vs-fallback structural decision, Decided/Skippy/delegated-by-Stuart per this
story's own away-mode convention.

**Gate round 1 remediation** (Main, 2026-10-19; five Mediums, all fixed, no build slot used):
**(1, A11y/UI)** a window blur fires `focusout` with `relatedTarget` null while
`document.activeElement` stays the SAME element (never reassigned by a blur) --
`StageGroupRow`'s handler now returns early (keeping the flag) when `event.target ===
document.activeElement`, the window-blur signature, preferred over `document.hasFocus()`.
**(2, Code/Test/A11y)** a click onto a non-focusable spot used to leave the flag stuck true
forever -- now uses the repo's own `ProfileAlertRows.tsx`/`FileExplorerPanel.tsx`
rAF-plus-`isConnected` pattern (the just-blurred target is still connected one frame later only
when nothing removed it) to tell a deliberate click-away apart from a real removal. **(3,
Code)** a missed join (or a missed pre-join precondition) is now a hard failure in
`verify-1001-stage-focus-join.mjs`, not a silent `notExercised`; the LAST pre-join frame (not
merely "any") must confirm focus; `joinedMemberExpr` is scoped to the Stage's own content.
**(4, Test/A11y, Visual)** focus is placed with a real keyboard Tab (not `.focus()`), arming
`:focus-visible` for the rest of the run; the Dark-theme screenshot (taken before any theme
switch steals focus) is backed by a hard `:focus-visible` match, not eyeballing alone; the
later per-theme shots are honestly labelled as non-proofs. **(5, Test)** a simulated window
blur (`Emulation.setFocusEmulationEnabled`) is spliced in before the join, re-using the
existing assertions; a dedicated click-away negative proof needs its own second 1-to-2
transition and is recorded in `notExercised` instead.

**Non-build checks** (re-run after gate round 1 remediation): `pnpm typecheck`, `pnpm vitest
run` (148/148, no new tests per the prototyping-phase rule), `pnpm run check:indent`, `pnpm run
check:file-size` (no baseline change), `node --check` on the updated script, plus a real
`import()` load-check (fails only at the shared `CARGO_TARGET_DIR` build-slot guard, confirming
every import resolves) -- all clean.

## Phase 68: Code-block background follows theme surface (#975, FR-050 amended) [US1]

(Renumbered against `origin/main` just before merging, this file's own convention: Phase 67/
T322-T324 claims the next free numbers as of this branch's cut from `origin/main`.)

**Goal**: a fenced code block's header and body share one literal background -- the active
preset's own `--card` -- in every built-in theme, never a bundled Shiki syntax theme's fixed
colour; every token colour that syntax theme ships still clears 4.5:1 against the new
background. Pre-decided on the issue (Decided, Skippy, delegated by Stuart 2026-10-19).

- [X] T325 `src/renderer/features/chat/Markdown.tsx`: `CodeBlockHeader` moves from `bg-muted` to
  `bg-card` (matching the body/gutter's existing surface). `CodeBlock`'s `codeToHtml` effect
  neutralises Shiki's own root background to `transparent` via `colorReplacements`, keyed on
  `highlighter.getTheme(syntaxTheme).bg`; the highlighted-body wrapper `<div>` gains its own
  `bg-card` (the inner `<pre>`'s `[&>pre]:m-0` means its box exactly covers the div's, same as
  the plain-fallback `<pre>` already painting its own box directly).
- [X] T326 `src/shared/themes.ts`: `dark`, `obsidian`, `nordic-frost` and `cyber-amber` move
  `syntaxTheme` from `github-dark` to `github-dark-default` (research.md decision 25's own
  "no amount of surface retuning can fix `github-dark`'s comment colour" finding);
  `dark-high-contrast`'s `github-dark-high-contrast` is unchanged.
- [X] T327 `scripts/theme-contrast-pairs.mjs`: new `shikiTokenContrastRows(themes,
  themeMetadata)` -- loads every distinct `syntaxTheme` via `shiki`'s `createHighlighter`
  (JS regex engine, no WASM), collects each theme's distinct non-self-backgrounded token
  foreground colours (plus its own default `.fg`), and checks each against that preset's
  resolved `--card` at 4.5:1. `scripts/check-theme-contrast.mjs`'s `THEME_METADATA_RE` gains a
  `syntaxTheme` capture group (between `swatch` and `titleBarOverlay`, `themes.ts`'s own
  declaration order) and wires the new check into the existing composited-checks loop.
- [X] T328 Update the docs: amended `specs/001-core-session-workspace/spec.md` with FR-050
  (amended again, after issue #558's own prior amendment) and a dated `### Session 2026-10-19
  (Code-block background follows theme surface, #975)` Clarifications entry; `research.md`
  decision 25 records the full rationale, including why a surface retune alone cannot fix
  `github-dark`'s own comment colour; `src/shared/themes.ts`'s own `nordic-frost`/`cyber-amber`
  doc comment (originally written by #551) is rewritten to record the follow-up as resolved.
- [X] T329 New fixture `scripts/fixtures/omp-frames/code-surface-975.jsonl` (hand-extended copy
  of `user-message-time.jsonl`'s own first-turn shape, a FIXED assistant reply carrying one
  deterministic JavaScript fence -- a comment, a string, a keyword, a function -- so the
  rendered Shiki token colours are stable run over run, which a real model turn could not
  guarantee) and new `scripts/verify-975-code-surface.mjs`, modelled on
  `verify-439-history-truncate.mjs`'s own fixture-driven harness and `verify-551-presets.mjs`'s
  themed-screenshot loop. For every built-in preset: asserts by computed style that the header
  and body share one literal background, that it equals the theme's own live-resolved `--card`
  (read off a throwaway `div.bg-card` probe, never a hand-copied hex), that Shiki's own raw
  `<pre>` background computes to transparent (`rgba(0, 0, 0, 0)`, a hard check the WRAPPER div's
  own `bg-card` alone cannot prove), and that the rendered comment TOKEN -- the leaf `span.line >
  span` with no children, not the outer line wrapper, which inherits the `<pre>`'s own default
  foreground (gate round 1 fix, Main, Code1/Code2 High) -- clears 4.5:1 against that background,
  measured live via `contrast-math.mjs`'s `measuredContrastRatio`; screenshots each preset
  (Cyber Amber the headline shot). **Live-verified (build slot, head `9b7afa8`, re-run after gate
  round 1 remediation): `report.json` 0 failures, exitCode 0, gitHead matches, dirty false.**
  Every preset's header/body backgrounds were byte-identical computed-style strings equal to
  that theme's own live `--card` probe; Shiki's own `<pre>` background computed to transparent
  in every preset; the comment token measured 5.35:1 (Obsidian, the lowest) to 5.82:1 (Dark) for
  the four `github-dark-default` presets, 11.31:1 for Dark high contrast's own
  `github-dark-high-contrast` -- matching research.md decision 25's own predicted range exactly,
  and genuinely distinct from each theme's own inherited default foreground (the gate round 1
  regression guard). All 5 screenshots viewed: Cyber Amber (headline) and Dark both show one
  seamless surface behind header and body, every token readable.

**Non-build checks**: `pnpm typecheck`, `pnpm vitest run` (148/148, no new tests per the
prototyping-phase rule), `pnpm run check:indent` (0 odd-indent lines), `pnpm run check:file-size`
(`Markdown.tsx` exactly at its existing 997-line baseline, no growth; `check-theme-contrast.mjs`
exactly at its existing 743-line baseline), `pnpm run check:theme-contrast` (828 of 828 pairs
PASS across 5 themes, up from 773 -- 50 new rows: 45 Shiki-token rows, including `carriage-return`
now correctly included rather than wrongly excluded per gate round 1, plus a new `ring`/`card`
pair for `CodeBlock`'s own focus ring), `node --check` on both edited scripts -- all clean.
**Live Tauri verify: DONE** (see T329 above, re-run at head `9b7afa8` after gate round 1
remediation); `ci-local.mjs` all steps PASS (`cargo fmt --check`, `cargo test` 731 passed/0
failed/1 ignored, `cargo clippy -D warnings`, Tauri debug build) at head `9b7afa8`.

## Phase 69: Convergence -- composer role chip, pin persistence, fallback signal, provider line (#741, FR-091)

**Written retroactively** (code landed before this phase; `/speckit.converge`'s own append-only
contract applied here reflects reality rather than driving it). Real commits: `1daa6e57` on
`feat/741-role-chip` (`stuarthopwood/refract`, PR #1037) carries every item below; this phase's
own doc/spec edits (`spec.md` FR-091, this file, `docs/PLAN.md`) land in later commits on the
same branch/PR, cited by sha where the report below gives one.

- [X] T330 `src-tauri/src/store/registry.rs`: `Session.pinned_model: bool` (`#[serde(default)]`,
  an old `registry.json` reads `false`) and `SessionPatch.pinned_model: Option<bool>`, applied in
  `update_session`. Every `registry::Session` literal across the Rust tree (`ipc/
  sessions_lifecycle.rs`, `ipc/pull_requests/handlers.rs`, `session/manager.rs` and its test
  helper, `session/side_chat.test.rs`, `session/termination.test.rs`, `session/agent/
  launch_support.test.rs`, `store/registry_tests.rs`, `ipc/sessions_lifecycle_tests.rs`) updated.
- [X] T331 `src-tauri/src/session/model/model_support.rs`: `ensure_pin_seeded` (lazily folds the
  registry's persisted `pinned_model` into in-memory `State.pinned` on the first
  `current_selection` call per Session per run) and `persist_pinned` (writes it back on every
  `set_model`/`cycle_model`/`handle_switch_text` pin and `apply_role_now` un-pin, best-effort,
  `session_list_changed` emitted on success). Called from `model.rs`'s `current_selection` and
  all three pin/un-pin sites.
- [X] T332 `src-tauri/src/session/model/model_support.rs`: `model_change_role` maps a
  `model_change` entry's `resolvedModelIsFallback: true` to the reserved `"fallback"` role,
  overriding `role`; `maybe_invalidate_role_cache` clears the cached role on OMP's own
  `model_changed`/`retry_fallback_succeeded` frames (`model.rs`'s `on_frame`), so a live fallback
  refreshes the chip without a restart. `model.rs`'s `current_selection` early-return additionally
  lets a freshly-cached `"fallback"` outrank a stale `pinned` flag (a Session OMP has since moved
  off a hand-picked model no longer reads Custom).
- [X] T333 FINDINGS item 61 + `docs/spike/fallback-probe-741.mjs`: an isolated, credential-less,
  zero-real-token probe attempting to force `resolvedModelIsFallback: true` live. Inconclusive in
  90s against a connection-refused model (no fallback frame, no second `model_change` entry, no
  `prompt_result` at all in that window). T332 ships code-verified against the documented field
  per the issue's own decision 2 fallback clause; forcing/confirming the transition live is #650.
- [X] T334 `src/renderer/lib/modelRoles.ts` (new): role labels (reused from
  `ModelRolesSection.tsx`'s now-exported `CHAT_ROLE_DESCRIPTORS`), provisional per-role lucide
  icons, the `"fallback"`/`"custom"` sentinels and their tooltips, a friendly provider map
  (`friendlyProviderLabel`), and `roleChipDisplay()` (pinned -> Custom; `currentRole` -> its
  label/icon/tooltip or nothing at all for an unrecognised value).
- [X] T335 `src/renderer/features/chat/ComposerPickers.tsx`: `RoleChip` (text plus icon, no
  colour, `aria-disabled` ghost button with an `sr-only` "Role: " prefix and a Tooltip, no click
  handler pending #766); mounted in `MessageInput.tsx`'s bottom row immediately before
  `ModelPicker`.
- [X] T336 `src/renderer/lib/modelDisplay.ts`: `formatModelLabel` is now name-only (was
  `provider/name`); `src/renderer/features/sessions/SessionDetailsCard.tsx` gets a muted "via
  {provider}" second line (`friendlyProviderLabel`); `ModelPicker.tsx` (its one other caller, at
  its 600-line cap, unchanged tooltip scope) migrated to build its own `provider/name` string
  locally instead of through the now-renamed helper.
- [X] T337 Docs: `specs/001-core-session-workspace/spec.md` FR-091 (new), acceptance scenario 6
  (User Story 5) amended for the role chip and the provider line, two new Edge Cases (pin
  survives a restart; fallback outranks a stale pin), and a dated `### Session 2026-10-19
  (Composer role chip, pin persistence, fallback signal, #741)` Clarifications entry recording
  `issuecomment-6266024041`'s four decisions. This Convergence phase. `docs/PLAN.md`'s #741 row.
- [X] T338 Live CDP verification (`scripts/verify-741-role-chip.mjs` + `verify-741-role-chip-
  helpers.mjs`, five launches, a fake-omp tape): chip text and icon for a role Session; muted-text
  contrast >= 4.5:1 and a real keyboard path (Tab/focus-visible/Tooltip/Escape/Shift+Tab) on the
  chip; real-geometry truncation (not a guessed selector); Custom after a hand-pick AND after a
  restart with the same `REFRACT_DATA_DIR` (pin persisted, found by session id not index); a
  mid-session fallback WHILE PINNED (an autonomous `retry_fallback_succeeded` frame, the pin
  itself never cleared); no chip for an unrecognised role (asserted only after `sessions.list()`
  reports the seeded role) AND for an empty conversation file (`currentRole: null`); Fallback
  from a tape entry carrying `resolvedModelIsFallback: true` (tape-proven, since T333 could not
  force it live; the real-OMP probe is #650), its own accessible name asserted too; the details
  card's name and "via ..." line; the role chip and Model picker wrapping together at 380px/520px
  chat widths; accessible names via the AX tree; strip screenshots in all five theme presets.
  Gate round 1 fixes (Main's five-reviewer gate on this Convergence): `model.rs`/`model_support.rs`
  fallback-outranks-a-pin made reachable (a `role_needs_reprobe`/`role_generation` pair forces a
  re-probe even while pinned, generation-guarded against a race with a second invalidation), the
  pin-seeding race closed (every pin/un-pin writer also sets `pinned_seeded`; `persist_pinned`
  reads back from state and skips a no-op write), `ComposerPickers.tsx`'s `RoleChip` contrast and
  AX-name fixes (an explicit `aria-label`, not a visible-text-plus-sr-only-span join, which
  measured an extra space live), `RoleAndModelPicker` (narrow-width wrap-together),
  `modelRoles.ts` icon swap and the `CUSTOM_ROLE` string-forgery guard, `ModelPicker.tsx`'s
  `friendlyProviderLabel`/`ROLE_LABEL` reuse, `SessionDetailsCard.tsx`'s tighter model/provider
  grouping. **Real product bug found live and fixed**: `maybe_invalidate_role_cache` updated
  Rust-side role/pin state correctly but never emitted `session_list_changed` -- the renderer's
  own Sessions store is purely event-driven (`init-stores.ts`'s `onSessionListChanged`, no
  polling timer), so a live fallback's new role sat correct in Rust state but invisible to the
  chip until this fix.

**FINAL LIVE-VERIFIED PASS, clean HEAD `871b89bb`**: full chained `ci-local.mjs && verify-741-
role-chip.mjs` -- `ci-local.mjs` all 11 non-build steps PASS, `cargo fmt --check`/`cargo test`
PASS; `verify-741-role-chip.mjs`: **0 failures, 0 notExercised** across all five launches.
Screenshots viewed: the chip at full muted-text strength in all five theme presets (`01-chip-
default-*.png`), the composer row right after the real keyboard Tab/Shift+Tab path (focus ring
visible on the Ask pill after Shift+Tab, `06-composer-row.png`), the Session details card's real
hover-triggered "via GitHub Copilot" line (`06-details-card.png`), the hand-pick-to-Custom and
restart-persisted-Custom chips (`02`/`03`), the mid-session Fallback-while-pinned transition with
no restart (`07-chip-fallback-while-pinned.png`), the standalone tape-proven Fallback chip with
its exact composed Tooltip text (`04-chip-fallback.png`), both no-chip cases (`05`/`10`), and the
role chip + Model picker sharing one row at 380px and 520px (`08`/`09`). Three fix rounds against
this exact build before it passed clean (this file's own trailer, immediately below, keeps the
non-build-only citation from before the build slot was granted, for the record).

**Non-build checks** (re-run at head `1daa6e57`, before gate round 1): `pnpm tsc --noEmit -p
tsconfig.web.json` clean; `node scripts/check-indent.mjs` (0 odd-indent lines); `node
scripts/check-file-size.mjs` (0 cap violations, no baseline raised -- `model.rs`/`manager.rs`/
`ModelPicker.tsx`/`MessageInput.tsx` all brought back to/under cap by splitting pin/fallback
helpers into `model_support.rs` and condensing comments); targeted `vitest run` on `model-roles-
store.test.ts`, `modelRoleSuffix.test.ts`, `sessions-store.test.ts` (28/28 passed; no new
renderer tests, per the prototyping-phase rule).

## Phase 70: Convergence (#891, FR-029 amended) [US6]

(Next free numbers after merging `origin/main`: Phase 69/T330-T338 claimed by #741 above, so this
phase claims Phase 70/T339 onward.)

**Goal**: Delete no longer dead-ends on a full, generated-file worktree or one still held open by
another program. The Delete dialog runs a background leftover-files walk on open; the worktree-
held preflight runs before the agent is stopped; Refract removes the worktree's own files with its
own long-path-safe walker instead of `git worktree remove --force`. Decided on the issue (Stuart,
2026-10-15 and 2026-10-19 grill, issue #891); Rust implementation already landed on this branch.

- [X] T339 `src-tauri/src/fs/remove_tree.rs` (new): long-path-safe recursive worktree-file
  remover replacing `git worktree remove --force` for this Session's own worktree. Per-entry
  `symlink_metadata` (never following a link), `\\?\`-prefixed paths used over 260 characters,
  read-only attributes cleared before removal, junctions/symlinks removed as links and never
  descended into or deleted through. Only this worktree's own `.git/worktrees/<name>` admin entry
  is removed afterward (never `git worktree prune`), verified with `git worktree list
  --porcelain`. **Gate round 1 decision (issuecomment-6273798707):** reversed to
  `std::fs::remove_dir_all` behind a containment gate instead of a hand-rolled walker. **Gate
  round 3 (H2):** `remove_dir_all` retried up to 10 times (300ms apart) on raw OS errors
  32/33/5/145, re-checking containment before each attempt.
- [X] T340 `src-tauri/src/git/worktree_holders.rs` (new): the holder preflight run before the
  agent is stopped. Windows Restart Manager names a program and pid holding a file open inside
  the worktree, excluding this Session's own recorded `omp` pids (`process/pid_records.rs`); only
  if Restart Manager finds nobody, a safe rename probe (rename the worktree folder to a sibling
  name inside the worktrees root and straight back) catches a folder held only as a working
  directory. A named holder, or an in-use folder with no named holder, refuses the delete; a
  holder that cannot be detected does not block. **Gate round 3 (H1), the real root cause of an
  earlier "transient sharing violation":** Refract's own background `sessions.deleteCheck`
  refresh (not this preflight) was racing a Retry's own removal; fixed with a new per-Session
  `fs/worktree_access.rs` read/write lock, not a change to this file.
- [X] T341 `src-tauri/src/ipc/sessions_lifecycle.rs`: registers `sessions.deleteLeftoverSummary(id:
  string): Promise<Result<LeftoverSummary>>` (`LeftoverSummary = { generatedFolders: { name:
  string; fileCount: number }[]; otherFiles: string[]; moreCount: number; unavailable: boolean }`),
  a background filesystem walk started when the Delete dialog opens, separate from the existing
  git-based `sessions.deleteCheck`. Wires `worktree_holders`'s preflight into `sessions.delete`
  ahead of stopping the agent, surfacing a refusal as the new `worktree-held` error code through
  the existing `Promise<Result<void>>` error channel (no signature change); a refusal leaves the
  Session running. `remove_session_worktree`'s own signature stays stable (#476). **Gate round 3
  (H1):** both `sessions.deleteCheck` and `sessions.delete` wired to the new `fs/worktree_access`
  read/write lock.
- [X] T342 `src/shared/ipc.ts`: `IpcErrorCode` gains `worktree-held`; the `sessions` interface
  gains `deleteLeftoverSummary(id: string): Promise<Result<LeftoverSummary>>` and the `LeftoverSummary`
  type, alongside the existing `deleteCheck`/`delete` entries.
- [X] T343 `src/renderer/features/sessions/DeleteDialog.tsx`: fetches `deleteLeftoverSummary`
  alongside the existing `deleteCheck`, on the same cancelled-guard `useEffect([open,
  session.id, check])` pattern, rendering the generated-folders/other-files list with a
  "Checking files…" loading state and Delete enabled throughout; a `worktree-held` refusal
  surfaces through the dialog's existing `role="alert"` error paragraph, so Retry is clicking
  Delete again with no new control. **Gate rounds 2-3:** a unified always-mounted status line,
  a `refused` flag (not bare `error`) driving the Retry label, a separate `refreshing` flag so
  the post-refusal background refresh never greys out Retry, a generation counter guarding every
  refresh callback against an out-of-order stale result, and stale-state clearing on a failed
  refresh.
- [X] T344 Docs: amended `specs/001-core-session-workspace/spec.md` FR-029, two new Acceptance
  Scenarios (User Story 6) and two new Edge Cases, and a dated `### Session 2026-10-19 (Session
  delete: leftover summary and holder preflight, issue #891)` Clarifications entry;
  `plan.md`'s new `## Amendment 2026-10-19` section; `contracts/ipc.md`'s new
  `sessions.deleteLeftoverSummary` row and the `worktree-held` error documented on
  `sessions.delete`.

**Non-build checks**: Rust side already compiles clean (`cargo check -p refract-tauri
--all-targets`, confirmed on this branch before this phase was appended); this phase's own work
is documentation plus the frontend dialog wiring (T342/T343), landing in the same PR.

**FINAL LIVE-VERIFIED PASS (gate round 3), clean HEAD `6452a137`**: full chained `ci-local.mjs &&
verify-891-delete-leftovers.mjs` -- `ci-local.mjs` all 16 steps PASS (`cargo fmt --check`, `cargo
test`, `cargo clippy -D warnings`, Tauri debug build); `verify-891-delete-leftovers.mjs`: **0
failures, 3 honest `notExercised`**, `gitHead` matches, `dirty: false`. All acceptance scenarios
PASS, including (c) and (d)'s Retry succeeding on a single click (the real `fs/worktree_access.rs`
read/write-lock fix, not a retry-loop band-aid). All five screenshots viewed directly.

## Phase 71: Composer command pill, no spelling underline (#1050, FR-092)

(Next free numbers against `origin/main` at this branch's own cut, b29367aa: Phase 70/T339-T344
claimed by #891 above, so this phase claims Phase 71/T345 onward; the highest FR in this spec is
FR-091, so this phase claims FR-092.)

**Goal**: a recognised leading command or skill token in the composer's draft gets a subtle
accent pill (`--card` fill, `--accent-text` glyphs) and the box turns spellcheck off while it
shows; an unrecognised token (`/zzz`) gets neither. Decided (Skippy, delegated by Stuart
2026-10-19, away mode, issue #1050; reversible on the issue) -- see spec.md's own 2026-10-20
Clarifications entry for the six-point decision record.

- [X] T345 Docs convergence: this phase, `spec.md` FR-092 (new, amends FR-032/FR-033) and its
  dated `### Session 2026-10-20 (Composer command pill, no spelling underline, #1050)`
  Clarifications entry recording all six decided points, including the `--muted` -> `--card`
  pill-fill correction found by measurement (not by eye, per the issue's own instruction).
  `docs/PLAN.md`'s "Composer command pill" row.
- [X] T346 `src/renderer/features/chat/CommandPillOverlay.tsx` (new): `findRecognisedCommandToken`
  (reuses `parseSlashCommand`/`classifySlashInvocation` from `shared/slash-commands.ts` against
  the composer's own `commands` list -- never a hard-coded copy of either), `CommandPillSegments`
  (the invisible-gap/pill/invisible-gap render, same shape `ChipOverlaySegments` already uses,
  `rounded-sm bg-card text-accent-text [box-decoration-break:clone]`, no border, no padding so no
  layout shift), and `useCommandPillOverlay` (the memo/ref/scroll-sync-on-mount hook) --
  `MessageInput.tsx`'s own file-size baseline (1632 lines) had zero headroom, so every piece of
  logic beyond the bare integration call lives here.
- [X] T347 `src/renderer/features/chat/MessageInput.tsx`: wires `useCommandPillOverlay`, the new
  overlay div (same inert/`aria-hidden`/scroll-synced box-model-matching pattern as the ghost-
  text/chip overlays beside it) and `spellCheck={!commandToken}` on the `<textarea>`, plus the
  overlay's own scroll sync in the existing `onScroll` handler -- net file-size growth kept at
  zero against the baseline (condensed one pre-existing wrapped comment by the same margin the
  new wiring needed; `pnpm check:file-size` confirms 1631/1632, 0 cap violations).
- [X] T348 `scripts/theme-contrast-pairs.mjs`: new `{ fg: 'accent-text', bg: 'card', min: 7,
  onlyThemes: ['dark-high-contrast'] }` pair (the generic `accent-text`/`card` 4.5:1 pair already
  existed and already covers every preset's own baseline floor for this pill). `pnpm check:
  theme-contrast` confirms all 830 pairs PASS across all five presets.
- [X] T349 Live CDP verification (`scripts/verify-1050-command-pill.mjs`, fake-omp tape
  `1050-command-pill.jsonl` carrying the native `/btw` built-in plus one tape-provided
  `source: 'skill'` descriptor): `/btw hi` and `/skill:demo-review do it` show the pill and
  `spellCheck === false`; `/zzz` shows neither; the pill's own rect sits over the token's own
  glyph box (measured against the textarea's own padding, not a guessed selector); the textarea's
  own `getBoundingClientRect().height`/`scrollHeight` and `selectionStart`/`selectionEnd` after
  an identical keystroke sequence are identical with and without the pill; spellcheck returns the
  instant the leading slash is deleted; arguments render as plain invisible-gap text (asserted
  structurally, not by pixel guess); the pill stays aligned across all five theme presets and in
  a scrolled multi-line draft (`scrollTop` sync asserted directly); screenshots per state.

**Non-build checks** (re-run after merging `origin/main` twice, `3140b87c`): `pnpm typecheck`
clean; `pnpm test` 148/148 passed (no new renderer tests, per the prototyping-phase rule); `node
scripts/check-indent.mjs` (0 odd-indent lines across 426 files); `node scripts/check-file-
size.mjs` (0 cap violations, `MessageInput.tsx` 1631/1632); `node scripts/check-theme-
contrast.mjs` (all 830 pairs PASS); `node scripts/check-parity.mjs` (104/104 requests, 24/24
events, unaffected by this issue); `node scripts/check-drag-regions.mjs` (0 violations).

**FINAL LIVE-VERIFIED PASS, clean HEAD `3140b87c`**: full chained `ci-local.mjs &&
verify-1050-command-pill.mjs` -- `ci-local.mjs` all 16 steps PASS (`cargo fmt --check`, `cargo
test` 731 passed/0 failed/1 ignored, `cargo clippy -D warnings`, Tauri debug build, check:ui-text
0 leaks); `verify-1050-command-pill.mjs`: **48/48 checks PASS, 0 failures, 0 notExercised**,
`gitHead` matches, `dirty: false`. Screenshots viewed directly, zoomed 4-8x on the composer: the
pill renders with a rounded, borderless fill (`--card`) and `--accent-text` glyphs exactly over
the token in every one of the five presets, no doubled or ghost text anywhere (the real
textarea's own plain glyphs are fully masked), arguments stay plain, the real caret is visible
and correctly positioned (end of draft for `/skill:demo-review do it`, position 0 after the
slash is deleted), and the scrolled-draft screenshot shows the pilled token correctly out of
view with nothing duplicated at the wrong scroll offset. Draft PR #1064 (`Closes #1050`).

**Gate round 1 remediation (2026-10-20, Code/Test/A11y/UI reviewers, all four independently;
Sec PASS)**: one HIGH, found by all four -- the opaque pill overlay painted ON TOP of the real
`<textarea>` (confirmed from `02-pill-btw.png`: the caret at offset 3 was gone), hiding the
native caret, selection highlight and IME composition inside the recognised token. Fixed with
the standard "highlight-within-textarea" technique: `CommandPillOverlay` (renamed from
`CommandPillSegments`) now renders the WHOLE draft as a mirror sitting UNDER the textarea; the
textarea itself goes `relative z-[1] text-transparent caret-foreground selection:text-foreground`
(`COMMAND_PILL_TEXTAREA_CLASS`) ONLY while a token is present, so the native caret/selection/IME
keep painting on the real control, on top of the mirror. `useCommandPillOverlay`'s own scroll
sync moved from `useEffect` to `useLayoutEffect` (no one-frame flash of the mirror at `scrollTop:
0` on mount). One MEDIUM: the pill's fill is now a dedicated `--command-pill-bg` token (not
`--card` directly) -- the gate added a "visibly distinct from the composer surface" floor
(>=1.4:1) alongside the existing accent-text floor; `--command-pill-bg` resolves to `--muted` in
Nordic Frost/Cyber Amber (clears both outright) and to `--card` in Dark/Obsidian/Dark (high
contrast) (an accepted, documented gap on the new floor only -- proven analytically that no
single colour clears both there, see `globals.css`'s own per-theme comment and spec.md's new
2026-10-20 gate-round-1 Clarifications entry). One file-organisation fix (no separate severity,
bundled with the HIGH): `COMPOSER_MIRROR_CLASS` is now a shared constant (`CommandPillOverlay.tsx`)
used by the ghost-text, chip AND pill mirrors (was three verbatim copies of the same className
string in `MessageInput.tsx`); `[scrollbar-gutter:stable]` added to it and to the textarea
unconditionally (a scrolled draft's real content width must match every mirror's own wrapping
width exactly); a trailing `\n` gets a zero-width-space line-box fix. `MessageInput.tsx`'s own
earlier single-line-squashed import/render (a mis-aimed attempt to protect its file-size cap)
reverted to normally-formatted code -- the real saving comes from `COMPOSER_MIRROR_CLASS`
deduplication instead, landing at **1627/1632**, five lines BELOW the cap, not merely at it.
`scripts/verify-1050-command-pill.mjs` gained: pixel-level, blink-safe caret-visibility checks at
offset 0 and mid-token; a real Ctrl+A selection-highlight pixel check; completing a partial
command via a real slash-menu click; `/btw` -> `/btwx` (an unrecognised edit) dropping the pill;
a long wrapping skill name; a pasted-text chip beside the pill (ghost text recorded
`notExercised`: no scripted `predict_word` reply exists in this tape, and FR-058 degrades
silently on no reply); the overlay's own structural proof that arguments stay plain, rewritten
for the new whole-draft mirror shape. Split into `verify-1050-command-pill-helpers.mjs` (both
under the 600-line cap, no baseline needed). Non-build checks re-run clean: `pnpm typecheck`;
`pnpm test` 148/148; `check:indent` 0/427 files; `check:file-size` 0 violations
(`MessageInput.tsx` 1627/1632); `check:theme-contrast` all 837 pairs PASS; `check:parity` 106/106
requests + 24/24 events (the +2 requests are Main's own unrelated #1063 merge, not this issue);
`check:drag-regions` 0 violations. **A fresh FINAL LIVE-VERIFIED PASS (the chained `ci-local.mjs
&& verify-1050-command-pill.mjs` run) is pending the next build slot** -- not yet run; the
paragraph above this one is round 0's own build, superseded by this remediation.

**Gate round 2 remediation (2026-10-20, Main)**: round 1's accepted 3-theme gap (Dark/Obsidian/
Dark (high contrast) could not clear the new 1.4:1 fill-vs-composer floor without dropping
`--accent-text` below its own 4.5:1 floor) was not accepted -- the conflict is `--accent-text`
against the fill, so the pill now gets its OWN text token too. `globals.css`: `--command-pill-bg`
is a plain neutral step in every preset now (Dark `oklch(0.31 0 0)`, Obsidian `oklch(0.32 0.02
255)`, Dark high contrast `oklch(0.30 0 0)`, Nordic Frost/Cyber Amber unchanged `var(--muted)`),
chosen only to clear 1.4:1 against the effective composer backdrop (measured 1.50-1.52:1 in all
five); `--command-pill-fg` (new) is the same hue as `--accent-text`, lightened/desaturated only
as far as needed to clear 4.5:1 (7:1 Dark high contrast) on that fill (Dark 4.66:1, Obsidian
4.54:1, Dark high contrast 7.26:1, all measured) -- a plain alias of `--accent-text` in Nordic
Frost/Cyber Amber, which already cleared both floors. `CommandPillOverlay.tsx`'s `PILL_CLASS`
now reads `text-command-pill-fg` (was `text-accent-text`). `theme-contrast-pairs.mjs`: the
informational exception is gone -- `command-pill-fg`/`command-pill-bg` (4.5:1, 7:1 HC) and
`command-pill-bg`/background-or-composer-background (1.4:1) are BOTH enforced in every preset
now, measured via `node scripts/check-theme-contrast.mjs`: **all 840 pairs PASS, no gap, no
informational exception.** `spec.md`'s new 2026-10-20 "gate round 2" Clarifications entry and
FR-092's own amended text record the correction. Non-build checks re-run clean (unchanged file-
size/indent/parity/drag-region numbers from round 1; theme-contrast now 840/840, was 837/837).
**A fresh FINAL LIVE-VERIFIED PASS is still pending the next build slot** -- not yet run.

**Gate round 3 remediation (2026-10-20, Main)**: round 2's delta gate found one CRITICAL (Send/
Stop unclickable while a pill shows, `MessageInput.tsx`'s Send/Stop button container had no
z-index at all so the pill-only textarea `z-[1]` painted over it -- fixed with its own `z-[3]`,
full stacking order documented in `CommandPillOverlay.tsx`'s `COMMAND_PILL_TEXTAREA_CLASS`
comment), two HIGHs (the selection highlight painted nothing -- `selection:text-foreground` set
only a text colour, and CSS falls an author `::selection` rule's unset properties back to the
element's ordinary value, never the UA's special highlight; fixed with a real
`selection:bg-composer-selection-bg` fill, new `--composer-selection-bg`/`-fg` tokens that are
plain aliases of the already-enforced `accent-foreground`/`accent` pair -- and an IME
composition underline would have gone invisible too under the old `color`-based masking, since
anything reading `color` was hidden along with the glyphs; fixed by masking via
`[-webkit-text-fill-color:transparent]` instead, which leaves `color` itself real, with its own
`::selection`/`forced-colors` overrides since that property doesn't inherit the UA's forced-
colours safety net the way `color` does) and two MEDIUMs (a ~150ms flicker from the shared
`Textarea` primitive's own `transition-colors` fading the mask on/off out of sync with the
mirror's instant mount/unmount -- fixed by narrowing the composer's OWN textarea to
`transition-[border-color,box-shadow]`, not touching the shared primitive; Dark/Obsidian's
`--command-pill-fg` hue had drifted 15-25 degrees off `--accent-text`'s real measured hue --
retuned to 279/280 respectively, Dark 4.65:1/Obsidian 4.75:1/Dark high contrast 7.26:1, all
measured, `check:theme-contrast` 856/856 PASS including two new enforced `composer-selection-
fg`/`composer-selection-bg` pairs). Plus a UI Low (the pill's own fill now extends 2px past the
token's glyph box via `box-shadow`, which never reserves layout space, so edge glyphs no longer
sit flush against the fill) and a spec/notExercised Low (the IME `notExercised` entry narrowed to
what is actually proven: composed text shows through the mirror correctly; the underline's own
colour is still not live-verified, no IME harness built).

`scripts/verify-1050-command-pill.mjs` gained: a real `elementFromPoint` + pointer-click proof
that Send reaches the button while a pill shows (run LAST, since a real click genuinely consumes
the fake-omp tape's one scripted `prompt` reply); the selection-highlight check rewritten to
sample a GLYPH-FREE cell (the space after the token, not the pill's own inked centre, which gave
a false pass from ordinary glyph-rendering noise) and assert the selected pixel matches the
live-resolved `--composer-selection-bg`, not merely "differs"; the resting `02-pill-btw.png`
shot now taken BEFORE Ctrl+A (it used to capture the already-selected state); a new
`02b-selection-highlight.png` for the selected state; an OKLCH hue-difference assertion (<=5
degrees from `--accent-text`) in the theme loop; a stuck Profile-name tooltip now explicitly
dismissed (pointer moved to a neutral point, waited for `[role="tooltip"]` to clear) before each
theme's own measurement/screenshot; a caret-visibility check on a WRAPPED visual line of the
long skill name (offset 150, past the first line) and another after scrolling a long draft to
its own bottom (previously every caret check only ever covered the unwrapped, unscrolled first
line); a pasted-text chip's own `elementFromPoint` clickability check beside the pill.

Non-build checks re-run clean: `pnpm typecheck`; `pnpm test` 148/148 (no new tests); `check:
indent` 0/429; `check:file-size` 0 violations (`MessageInput.tsx` and `theme-contrast-pairs.mjs`
both condensed back to their own baselines after this round's comments); `check:theme-contrast`
all 856/856 pairs PASS; `check:parity` 106/106 + 24/24 (unaffected); `check:drag-regions` 0
violations. `spec.md`'s new 2026-10-20 "gate round 3" Clarifications entry and FR-092's own
amended text record every correction. **A fresh FINAL LIVE-VERIFIED PASS is still pending the
next build slot** -- not yet run.

## Phase 72: Agent rows show only the goal (#1077, FR-093)

(Next free numbers against `origin/main` at this branch's own cut, `4996ede9`: Phase 71/
T345-T349 claimed by #1050 above, so this phase claims Phase 72/T350 onward; the highest FR in
this spec is FR-092, so this phase claims FR-093.)

**Goal**: an expanded Stage row or subagent row shows only the goal; the full Prompt/Result
move behind a "See input & output" toggle. Decided (Stuart, `grill-with-docs`, 2026-10-20,
issue #1077; none deferred) -- see spec.md's own 2026-10-20 Clarifications entry for the
four-point decision record.

- [X] T350 Docs convergence: this phase, `spec.md` FR-093 (new, amends FR-067/FR-068) and its
  dated `### Session 2026-10-20 (Agent rows show only the goal, #1077)` Clarifications entry
  recording the four decided points. `docs/PLAN.md`'s "Agent rows show only the goal" row status.
- [X] T351 `src/renderer/components/InlineDisclosure.tsx` (new, ADR 0003): the shared text-link
  disclosure shape lifted out of `Markdown.tsx`'s `MermaidBlock` "Show source" toggle -- a
  caller-controlled `open`/`onOpenChange`, `aria-expanded`/`aria-controls`, and an Escape
  handler that closes and returns focus to the trigger whether focus sits on the trigger
  itself or deep inside (a CodeBlock's own Copy button) -- the WCAG 2.4.3 hazard issues
  #991/#1001 fixed one level up for a Stage's own trigger. `Markdown.tsx`'s `MermaidBlock`
  ported onto it unchanged (net line reduction) -- it gains both Escape-to-close and a correct
  `:focus-visible` ring for free, live-checked directly (gate round 1 fix, item 8).
- [X] T352 `src/renderer/features/chat/stageMeta.ts`: a shared `findFirstContentLine` helper
  (gate round 1 fix, item 2) replaces the copied line-finding loop in both `extractContextLabel`
  and the new `extractTaskGoalPreview` -- `item.task`'s own first non-blank lines, heading
  markers and blank lines cleaned THROUGHOUT (not only the first line), capped at 1500
  code-points (`GOAL_PREVIEW_MAX_CHARS`, a code-point-safe `truncateByCodePoint`, never
  `.slice()`, which can split a surrogate pair) as a DOM-size guard only -- the visible clamp is
  the caller's own `line-clamp-3`.
- [X] T353 `src/renderer/features/chat/ToolRow.tsx`/`SubagentGoalPreview.tsx` (new, own file,
  file-size): `SubagentRowProps.showGoal` is required (no implicit default, gate round 1 fix,
  item 10); `SubagentGoalPreview` (exported) renders the clamped goal paragraph alone, reused by
  both `SubagentBody` (a Stage member's own goal) and `StageGroupRow` directly (a context-less
  solo Stage's own goal, item 7); `SubagentBody` wraps its existing Prompt/Result blocks in the
  new `InlineDisclosure` ("See input"/"See input & output", gated on `item.result`'s own
  presence, flipping to "Hide ..." once open), its own label carrying an `sr-only` suffix naming
  the agent (item 9, every sibling link otherwise reads identical visible text).
- [X] T354 `src/renderer/features/chat/SubagentChainRow.tsx`: `StageGroupRow`'s own direct
  `SubagentBody` call (solo Stage) passes `showGoal={!group.context}`; each multi-agent member's
  own `SubagentRow` call passes `showGoal={!toolCallIdsWithContext.has(item.toolCallId)}` (gate
  round 1 fix, item 1: `item.context` alone is unreliable per member -- the wire stamps a call's
  own `context` argument onto only that call's spec-index-0 item, so a correlation by
  `toolCallId` is required for a call's 2nd+ member to resolve correctly). A context-less solo
  Stage's own goal renders at the Stage level, before "Uses:" (item 7); a failed/cancelled/
  exited solo Stage also keeps its own one-line failure reason visible there (item 6).
- [X] T355 Live CDP verification (`scripts/verify-1077-agent-goal.mjs`, new fake-omp tape
  `stages-1077.jsonl`): an expanded Stage row shows the goal and the toggle link with no Prompt/
  Result visible; the link opens and closes input/output with the correct labels and
  `aria-expanded`/`aria-controls`; a still-running agent shows "See input" (no "& output"); a
  single subagent row (no Stage goal) shows its own task as the goal, clamped to 3 lines;
  closing the toggle (Escape, focus deep inside) returns focus to the link; reopening starts
  collapsed again (no remembered state); screenshots in 2 themes with no stray hover card/
  tooltip open. `report.json` records `gitHead`, `dirty`, failures and `notExercised`.

**Non-build checks**: `pnpm typecheck` clean; `pnpm test` 148/148 passed (no new renderer
tests, prototyping-phase rule); `node scripts/check-indent.mjs` 0 odd-indent lines across 451
files scanned (3 allow-listed); `node scripts/check-file-size.mjs` 0 cap violations across 516
files scanned (`ToolRow.tsx` 594/600, `Markdown.tsx` 994/997 baseline, both within cap, no
growth past Markdown.tsx's own baseline); `node scripts/check-theme-contrast.mjs` all 872 pairs
across 5 themes PASS (no new token, reuses `--muted-foreground`/`--foreground`/`--ring`); `node
scripts/check-parity.mjs` 115 of 115 requests, 25 of 25 events (unaffected, frontend-only
change); `node scripts/check-drag-regions.mjs` 0 violations across 152 files.

**FINAL LIVE-VERIFIED PASS**: `node scripts/ci-local.mjs` all steps PASS (`cargo fmt --check`,
`cargo test`, `cargo clippy`, Tauri debug build, typecheck, vitest 148/148, indent, theme-
contrast, drag-regions, parity, file-size, versions, omp-schema drift, check:ui-text).
`scripts/verify-1077-agent-goal.mjs` against the just-built exe: **gitHead
`1f775683e761c0a2e4f66642ed54205c87b69237`, dirty: false, exeSha256 `601c930a0656…`, 0 failures,
1 notExercised, exitCode 0**. Two script bugs found and fixed first, neither a product defect:
Phase 8 opened a member's own toggle before its owning Stage had settled (a missing wait); a
plain `cdp.click` on a nested member toggle landed off-screen (fixed with the established
`clickScrolled` helper, same fix `verify-941-stage-naming-helpers.mjs` already carries for this
exact class of bug). Screenshots viewed directly: a solo Stage (no context) shows only its own
goal, genuinely clamped (`scrollHeight=64 > clientHeight=48`), its leading "# Goal" heading
stripped, the toggle reading "See input" while running then "See input & output" once settled;
opening reveals both Prompt and Result; Escape with focus deep inside returns it to the link;
collapsing/re-expanding the Stage resets the toggle; Stage B's own shared goal shows once with
neither member duplicating it, each member's own toggle independent. The Dark and Obsidian
screenshots were captured with Stage B's two members already expanded (not the pristine
goal-only state shots 01/02 prove) -- both confirmed to show no stray hover card or tooltip,
and Stage B's two members' own opened Prompt/Result each correctly scoped to itself.

**Gate round 1 remediation (2026-10-20, Main; Sec/Test/A11y/UI PASS, Code FAIL on one High)**:
one HIGH, four MEDIUM, five LOW, all fixed in this one round.
- **HIGH (item 1)**: a context-less multi-agent Stage showed no goal anywhere --
  `SubagentChainRow.tsx:368`'s member call was hardcoded `showGoal={false}`. Fixed with a
  `toolCallIdsWithContext` correlation by `toolCallId` (`item.context` alone is unreliable per
  member -- the wire stamps a call's own `context` argument onto only that call's spec-index-0
  item, per `groupSubagentStages.ts`'s own `flush()` comment, so a call's 2nd+ member carries no
  `item.context` of its own even when its OWN call genuinely had one). New fixture Stage C
  (`flat-task`, two agents, no context) live-checks the genuinely context-less case directly.
- **MEDIUM (item 2)**: the goal preview's own 240-char cap was tighter than its visual
  `line-clamp-3` needed, `.slice()` could split a surrogate pair, and only the FIRST line had
  its heading/blank-line noise cleaned. Fixed: raised to 1500 code points (a DOM-size guard
  only), a code-point-safe `truncateByCodePoint`, cleaning THROUGHOUT via a new shared
  `findFirstContentLine` helper (replacing the copied loop); FR-093 and the stale `notExercised`
  wording both corrected.
- **MEDIUM (item 3)**: Escape now also bails on `event.defaultPrevented` (a nested Tooltip's own
  dismiss gets the first press, WCAG 1.4.13) and the listener moved to the OUTER wrapper so
  Escape also works when focus sits on the trigger itself, not only deep inside the content.
- **MEDIUM (item 4)**: dropped `preventScroll` on the focus-return `.focus()` call -- a focused
  element deep inside a long, internally-scrolled `CodeBlock` now comes back into view.
- **MEDIUM (item 5)**: `InlineDisclosure`'s content div regained its own `space-y-2` (the 8px
  Prompt/Result gap `CollapsibleContent`'s own ambient spacing used to supply for free); the
  trigger now uses the shared `mutedLinkClassName` (extracted into a new `linkStyles.ts` to
  avoid an import cycle back through `Markdown.tsx`), matching "Show full brief" exactly.
- **MEDIUM (item 6)**: a failed/cancelled/exited solo Stage's own one-line failure reason
  (`extractResultSummary`, the same mechanism a multi-agent member's own `summary` slot already
  used) is restored next to its own goal, not only reachable behind the toggle.
- **MEDIUM (item 7)**: a context-less solo Stage's own goal now renders at the Stage level,
  before "Uses:" -- the same order a context-bearing Stage's own `StageContextBrief` already
  used -- instead of nested inside `SubagentBody`, after "Uses:".
- **MEDIUM (item 8)**: `Markdown.tsx`'s `MermaidBlock` "Show source" toggle, already ported onto
  the shared `InlineDisclosure`, gains Escape-to-close and a correct focus ring for free; T351
  and the PR body corrected to say so, and a new live-check phase opens it via real keyboard
  input (Shift+Tab back from the composer, a real Enter), asserts a hard `:focus-visible` match,
  screenshots the ring, then confirms Escape closes it too.
- **MEDIUM (item 9)**: each toggle's own label now carries an `sr-only` suffix naming its agent
  (`"See input & output for MemberOne"`) -- every sibling link otherwise read identical visible
  text, ambiguous to a screen reader user tabbing between them.
- **LOW (item 10)**: `showGoal` is now required (no implicit default); `InlineDisclosureProps`
  dropped its unused `className`/`buttonClassName` (neither caller ever used one); this script's
  own header corrected from a stale "WRITTEN, NOT RUN" claim to describe the real first
  build-slot run above; T354's text and the Dark-screenshot claim above both corrected; every
  screenshot (including the new Mermaid ring shot, via a lighter non-blurring equivalent that
  preserves the very focus state it proves) confirms no stray tooltip first, fatally.

Non-build checks re-run clean: `pnpm typecheck`; `pnpm test` 148/148; `check:indent` 0/454
files; `check:file-size` 0 violations (`ToolRow.tsx` 599/600, `SubagentChainRow.tsx` 588/600,
`SubagentGoalPreview.tsx`/`linkStyles.ts` new, both small); `check:theme-contrast`/`check:
parity`/`check:drag-regions` unaffected (no new token, no IPC/drag-region change). **A fresh
FINAL LIVE-VERIFIED PASS is still pending the next build slot** -- not yet run.

## Phase 73: Enter sends queued follow-up (#1067, FR-094)

(Next free numbers against `origin/main` at this branch's own cut, `a5e3ff7b`: Phase 72/T350-T355
claimed by #1077 above, so this phase claims Phase 73/T356 onward; the highest FR in this spec is
FR-093, so this phase claims FR-094.)

**Goal**: Enter on a blank composer with at least one queued follow-up sends the oldest one,
exactly as its own "Send now" chip would. Decided (Stuart, `grill-with-docs`, 2026-10-20, issue
#1067; none deferred) -- see spec.md's own 2026-10-20 Clarifications entry for the decision
record.

- [X] T356 Docs convergence: this phase, `spec.md` FR-094 (new, amends FR-011/FR-012) and its
  dated `### Session 2026-10-20 (Enter sends queued follow-up, #1067)` Clarifications entry
  recording the decided rule, the "blank" definition, and the discoverability/single-flight
  details. `docs/PLAN.md`'s "Enter sends queued follow-up" row status.
- [X] T357 `src/renderer/features/chat/enterSendsQueuedFollowUp.ts` (new, small helper --
  `MessageInput.tsx` is at its own `check:file-size` baseline cap; renamed from
  `useEnterSendsQueuedFollowUp.ts` in gate round 1, DECIDED item 4: not a hook, no `use*` prefix):
  `computeEnterSendsQueuedFollowUp(text, attachments, pendingAttachmentReads, chips, showSlashMenu, ghost, disabled)`
  derives whether a plain Enter should steer the oldest queued follow-up instead of calling the
  ordinary `handleSend()`, returning a discriminated `{ applies: true; chip: DerivedChip } | {
  applies: false }` union (gate round 1, DECIDED item 4: replaces a plain `{ applies: boolean;
  chip: DerivedChip | undefined }` shape that forced callers to assert `chip!`). "Blank" (amended
  gate round 1, DECIDED item 1) is `text === ''` exactly, not merely whitespace-only -- a single
  space or a Shift+Enter-inserted newline is a real draft -- with no pending images, text chips,
  or file attachments, AND no attachment read still in flight (gate round 1, DECIDED item 3:
  `pendingAttachmentReads`, PR #723's own guard; this is deliberately distinct from issue #744's
  still-open `hasSendableContent`, which asks the opposite question for the Send button). The
  oldest follow-up is `chips.find`'s first `queue === 'followUp'` entry (follow-ups list before
  any steering chip, in `followUp` array/FIFO order); a steering-only queue yields no match. The
  rule is suppressed while the slash menu is open, a live ghost-text suggestion is showing, or
  the composer is `disabled` (gate round 2, Main, MEDIUM item b: the helper used to ignore
  `disabled` entirely; now short-circuits to `applies: false` before any other check). Neither
  slash-menu nor ghost-text can actually coexist with a blank draft today -- `showSlashMenu`
  requires `text` to start with `/`, `isGhostTextEligible` requires text already on the line --
  but both guards are explicit anyway.
- [X] T358 `src/renderer/features/chat/MessageInput.tsx`: the Enter branch of `handleKeyDown`
  calls `handleSendNow(enterQueuedFollowUp.chip)` instead of `handleSend()` when
  `enterQueuedFollowUp.applies` (gate round 1, DECIDED item 4: the discriminated union above
  removes the need for a `chip!` non-null assertion), reusing its existing `inFlightChips`
  single-flight guard unchanged (a fast double Enter resolves to the same chip key on both
  presses, so the second call is a no-op) and its existing "Sending now…" announcement. The
  empty-state hint overlay's lead text reads the shortened "Enter: send next queued" (gate round
  2, LOW item 5: the original full sentence still truncated at the 360px panel floor; shortened
  to fit) while the rule applies, in place of the default "Message the agent" wording; the
  `composerHintId` sr-only description (already wired into the textarea's `aria-describedby`,
  issue #533) keeps the FULL "Enter sends the next queued message" sentence, with the ordinary
  "Markdown is supported. Type slash for commands." text appended after it (gate round 1, DECIDED
  item 5). The Send button's own `aria-keyshortcuts="Enter"` is dropped while the rule applies
  (gate round 1, DECIDED item 6: the button must never claim Enter sends the empty draft while
  Enter actually steers the queue instead); its tooltip reads plain "Send" instead of
  `<Kbd>Enter</Kbd>` (gate round 2, UI review (a): the button is unconditionally `aria-disabled`
  while the rule applies, so the tooltip -- wired into the button's own `aria-describedby` by
  Radix -- must not describe an action, the queued send, the disabled button itself cannot
  perform). IME composition and Shift+Enter are unaffected (both already gated before this branch
  runs).
- [X] T359 Live CDP verification (`scripts/verify-1067-enter-queued.mjs`, new fake-omp tape
  `scripts/fixtures/omp-frames/1067-enter-queued.jsonl`). Covers: two queued follow-ups mid-turn,
  chips render oldest-first; the hint and `aria-describedby` while the rule applies, in two
  themes, plus one 360px-wide screenshot proving the hint fits without horizontal overflow; an
  attachment-only "blank" composer (text === '', a real pasted file attachment, follow-up queued)
  does NOT promote the queued follow-up and the hint stays the DEFAULT wording (gate round 1,
  Code1/Test1 HIGH: live-exercised via a synthetic clipboard file paste, no longer merely reasoned
  about); Enter on a blank composer sends the oldest queued follow-up then the next, with the
  composer's own focus confirmed before the steering-only no-op check (gate round 1 LOW item);
  Enter with typed text still sends that text even with a follow-up queued; opening the slash
  menu on an unmatched command sends no command (the composer's ordinary unknown-command
  refusal, honestly relabelled in gate round 1 as NOT a live test of FR-094's own slash-menu guard
  -- see `notExercised` below for why that combination is unreachable); a fast double Enter sends
  exactly once (proven by an exact fake-omp debug-log RECV count), with its own "Sending now…"
  announcement recorded via `assertTrue` (gate round 1 LOW item) rather than merely waited for;
  Shift+Enter inserts a newline and sends nothing. `report.json` records `gitHead`, `dirty`,
  failures and `notExercised` (a ghost suggestion showing at the same instant as a blank composer;
  the slash menu open at the same instant as an otherwise-blank composer; an IME composition in
  progress at the same instant as a blank composer -- all three structurally unreachable, per
  their own doc comments in the script). Four script bugs were found and fixed while getting this
  green, none a product defect: the visible-hint selector matched zero elements (a generic
  `[aria-hidden="true"].text-muted-foreground` class selector was too fragile; replaced with a
  search for a genuinely visible span carrying the exact expected text, excluding `.sr-only`
  duplicates); two chip-index assertions assumed insertion order instead of the real render order
  (`chips` always lists every follow-up chip before any steering chip, regardless of when each
  was queued); `pressShiftEnter`'s synthesized CDP key event carried no `text` payload, so
  Chromium never ran the native "insert a newline" edit command the production code deliberately
  relies on (mirrors the bug class `verify-1077-agent-goal.mjs`'s own gate-round-1 remediation
  already warns about -- a synthetic key dispatch with no `text` field reaches `onKeyDown` but
  inserts nothing); a bare `pressEnter()` after the theme-switch screenshot loop landed on nothing
  (`settleForScreenshot` blurs the active element and `switchTheme` leaves focus inside the
  profile menu), fixed with an explicit re-click of the composer textarea before relying on any
  later bare Enter.

**Non-build checks** (run against the renderer changes alone, before any build slot): `pnpm
typecheck` clean; `pnpm test` 148/148 passed (no new renderer tests, prototyping-phase rule);
`node scripts/check-indent.mjs` 0 odd-indent lines across 457 files scanned (3 allow-listed);
`node scripts/check-file-size.mjs` 0 cap violations across 522 files scanned (`MessageInput.tsx`
1632/1632 baseline, unchanged -- new logic lives in `enterSendsQueuedFollowUp.ts` instead);
`node scripts/check-theme-contrast.mjs` all 872 pairs across 5 themes PASS (no new token); `node
scripts/check-parity.mjs` 115 of 115 requests, 25 of 25 events (unaffected, frontend-only
change); `node scripts/check-drag-regions.mjs` 0 violations across 153 files.

**FINAL LIVE-VERIFIED PASS**: branch merged with `origin/main` (v0.7.0 release, #1039 Cyber
Amber retune) first; non-build checks re-run clean on the merged tree (`pnpm typecheck`; `pnpm
test` 148/148; `check:indent` 0/458; `check:file-size` 0/523, `MessageInput.tsx` unchanged at
1632/1632; `check:theme-contrast` 872/872; `check:parity` 115/115 requests, 25/25 events;
`check:drag-regions` 0/153). `node scripts/ci-local.mjs` all steps PASS (`cargo fmt --check`,
`cargo test`, `cargo clippy`, Tauri debug build, typecheck, vitest, indent, theme-contrast,
drag-regions, file-size, versions, omp-schema drift, check:ui-text).
`scripts/verify-1067-enter-queued.mjs` against the just-built exe: **gitHead
`965184456b5d50c8d0d5b76c2f1c1dd065016b8e`, dirty: true (the verify script's own in-flight fixes
were uncommitted at run time, now committed in this same change), 0 failures, 2 notExercised,
all 14 assertions PASS**. Screenshots viewed directly (`hint-dark.png`, `hint-obsidian.png`):
both queued follow-up chips show with their own "Send now" buttons, and the composer's hint
overlay reads "Enter sends the next queued message" in place of "Message the agent", the "/ for
commands" and "Markdown supported" hints unchanged beside it, in both themes.

## Phase 74: Model roles overhaul (#1069, FR-095 to FR-099)

- [X] T360 [US1] Docs convergence: amend `specs/001-core-session-workspace/spec.md` with the
  `### Session 2026-10-20 (Model roles overhaul, #1069)` Clarifications entry and FR-095 to
  FR-099 (provider switch, filtered dropdown, off-provider display, trigger text, reasoning
  radios). Thread `reasoning: boolean`/`thinking: string[] | null` through `ModelCatalogEntry`
  (`src/shared/model.ts`; `src-tauri/src/ipc/model_roles.rs`'s struct and
  `parse_catalog_response`), updating that file's two existing parse tests to the now-true "six
  needed fields" shape (no new tests, prototyping-phase rule) rather than leaving them asserting
  a superseded premise. `cargo test --lib ipc::model_roles`: 18/18 passed.
- [X] T361 [US1] Build the provider switch and reasoning radios as new components, not inlined
  into the 469-line `ModelRolesSection.tsx` (#806 file-size cap): `modelProviderFilter.ts` (pure
  helpers -- provider list, provider-filtered catalog, current-value catalog resolution, default
  provider), `ProviderSwitch.tsx` (the `ToggleGroup` row, ADR 0003, extending
  `ManageSessionsToolbar.tsx`'s own segmented-filter pattern), `RoleReasoningRadios.tsx` (the
  seven-option radio group per chat role, `RadioGroup`/`RadioGroupItem`/`RadioGroupIndicator` plus
  `RADIO_RING_CLASS`/`RADIO_DOT_CLASS` from #1043/PR #1057). Wired `ModelRolesSection.tsx` to:
  track the selected provider (initialised once from the Default role's current model, falling
  back to the first catalog provider); filter each chat role's `SelectContent` to the selected
  provider and drop the provider from its item labels; resolve a role's current value against the
  FULL catalog to render its trigger as the model's display name, with a muted "via {provider}"
  tag when it is on a different provider than the one selected; render `RoleReasoningRadios` under
  each of the 10 chat roles only, writing/clearing the role's `:level` suffix through
  `modelRoleSuffix.ts`'s existing helpers (FR-095 to FR-099). Extracted `friendlyProviderLabel`
  out of `lib/modelRoles.ts` into a new leaf module, `lib/providerLabels.ts` (re-exported from
  `modelRoles.ts` unchanged for its existing callers), because `ModelRolesSection.tsx` importing
  `ProviderSwitch.tsx` importing `lib/modelRoles.ts` would otherwise be a real circular import --
  that file reads this section's own `CHAT_ROLE_DESCRIPTORS` at its module top level.
- [ ] T362 Non-build checks and the live check: `pnpm typecheck`, `pnpm test` (148/148, unchanged),
  `pnpm check:indent` (0/468), `pnpm check:file-size` (0 violations -- `src/shared/model.ts`'s
  doc comment trimmed to land exactly on its 656-line baseline, not past it),
  `pnpm check:theme-contrast` (892/892, no new token), `pnpm check:parity` (115/115 requests,
  25/25 events, unaffected), `pnpm check:drag-regions` (0/155); `cargo fmt --check`, `cargo
  clippy --all-targets -- -D warnings` (`src-tauri`) all clean. Write
  `scripts/verify-1069-roles-overhaul.mjs` (new, modelled on an existing Settings CDP check,
  teaching the shared `verify-tauri-fake-omp.mjs` harness the one-shot `omp config get/set
  modelRoles --json` and `omp models --kind <kind> --json` CLI calls it never answered before --
  neither is part of the `--mode rpc-ui` wire tape, and no earlier live check drove the Model
  roles section this deep) proving the switch starts on Default's provider and filters every
  dropdown, items carry no provider prefix, an off-provider role shows "via {provider}", the
  radios exist only on chat roles with unsupported levels disabled and a reason, picking a level
  writes the suffix (read back through a fresh `modelRoles.list()` IPC call) and Inherit clears
  it, triggers show the name only, and the switch/radios are keyboard-operable. Gated on the
  build slot (no `verify-*.mjs` run by this worker); run and reported once granted.

This phase was written retroactively after the implementation above, in the same session that
built it (no prior `/speckit.plan`/`/speckit.tasks` pass covered issue #1069). T360/T361's own
checks (`cargo test`, `pnpm typecheck`) were run as each landed; T362's non-build checks were run
and are green (see above), and `scripts/verify-1069-roles-overhaul.mjs` plus its
`scripts/fixtures/model-catalogs/chat-1069.json` fixture and the `verify-tauri-fake-omp.mjs`
one-shot `config`/`models` handling it needs are written and syntax-checked (`node --check`), but
NOT yet run against a built exe -- Main's "ready for build slot" instruction gates that (no
`verify-*.mjs` run by this worker); T362 stays open until the build slot is granted, the Tauri
debug build runs, and the script's own pass (and its `report.json`) is recorded here.

## Phase 75: Convergence (#838 agent-to-agent lines, #762 `/models`, FR-100/FR-101)

`/speckit.converge` against the amended spec (FR-100, FR-101 and the 2026-10-22 Clarifications
entry): seven findings, all appended below; nothing else in scope was found unmet.

- [X] T363 Handle a bare `/models` in `MessageInput.tsx` before `open()` (clear the draft,
  `useViewStore.openSettings('model-roles')`, send nothing) and list it in
  `session/agent/commands.rs` `NATIVE_BUILT_COMMANDS` ("Open model role settings"), keeping it in
  `NATIVE_RESERVED_COMMANDS` per FR-100 (missing)
- [X] T364 Teach the Rust transcript builder OMP's `irc:incoming` custom type and pass
  `details.fromParent`/`replyTo` through as optional `agent-message` fields (`fromParent`,
  `replyTo` in `src/shared/model.ts`); a missing `to` with `fromParent` reads "this agent", not
  "main agent". Moved into `omp/transcript/agent_message.rs` (#806 cap) per FR-101 (missing)
- [X] T365 Draw `AgentMessageRow` with a direction glyph (`agentMessageDirection.ts`:
  `fromParent` first, then the "Main"/"main agent" names), the label in `--agent-message`,
  "Main agent" as the parent's one label, and an sr-only "Agent message from X to Y" per
  FR-101 (partial)
- [X] T366 Render a `write agent://<id>` call as a main-to-subagent line (`AgentSteerRow`,
  status glyph while running/failed/interrupted/stopped, "failed" in the error colour, "View full
  call" on expansion), a grouping boundary in `groupToolItems.ts` and never hidden by "Show tool
  calls" (`transcriptRowVisibility.ts`) per FR-101 (missing)
- [X] T367 Add `--agent-message` to every built-in theme in `globals.css` (Tailwind
  `text-agent-message`) and its 4.5:1 pairs (`background`, `muted`) to
  `scripts/theme-contrast-pairs.mjs` per FR-101 (missing)
- [X] T368 Amend `docs/design/foundations-icons.md`'s colour rule (agent-to-agent message
  identity) and add the agent-message token and a reserved-hue table to
  `docs/design/foundations-tokens-theming.md` per FR-101 (missing)
- [x] T369 Verify: `pnpm ci:local` and a live scratch-instance check
  (`scripts/verify-p1-agentmsg.mjs`: glyph, colour and accessible name per direction in Dark,
  Obsidian and Dark (high contrast); `/models` opens Model roles) per FR-100/FR-101 (partial)

## Phase 76: Side chat panel double scrollbar (#802) [US1]

**Goal**: fix the bug where the Side chat panel (spec 014) showed two vertical scrollbars at
its right edge once an answer grew taller than the pane -- chore/bugfix, no FR change (same
category as #811/Phase 38): the panel's documented behaviour (one scroll container, composer
pinned, nothing clipped) is unchanged; only the implementation that failed to deliver it is
fixed.

- [X] T370 [US1] `src/renderer/features/right-pane/side-chat/SideChatPanel.tsx`: root div
  changed from `flex h-full flex-col` to `flex min-h-0 flex-1 flex-col`. Root cause (read from
  code; the issue's own on-issue probe needs a live build this lane was never granted):
  `react-resizable-panels`' `Panel` component (`node_modules/react-resizable-panels/dist/
  react-resizable-panels.js`) renders an un-overridable wrapper whose own `height` default is
  the literal string `"auto"` (not `100%`), wrapping an inner div with its own un-overridable
  `overflow: "auto"` default -- an ancestor scroll container entirely invisible to a
  source-level grep of `RightPaneShell.tsx`/`App.tsx`/`resizable.tsx` (the issue's own grep
  found none, correctly, since this one is injected by the library at runtime). A bare `h-full`
  on `SideChatPanel.tsx`'s own root depends on every ancestor in that chain resolving a
  definite height to stay bounded to the pane's own available space; every OTHER self-scrolling
  root in this codebase that fills a flex column already avoids that dependency entirely
  (`Transcript.tsx`'s `MessageScroller className="h-full flex-1"`, `ModelPicker.tsx`'s list
  `min-h-0 flex-1 overflow-y-auto`) by using `flex-1` (flex-basis:0%, flex-grow:1), which
  derives its size directly from the flex algorithm's own free-space distribution rather than a
  percentage that can resolve against an indefinite ancestor. `SideChatPanel.tsx` was the one
  outlier; matching the proven pattern removes the second scroll container without touching the
  `react-resizable-panels` wrapper itself (out of scope: every other `ResizablePanel` in the app
  shares the same injected wrapper and none of them are reported as double-scrolling, so
  changing the shared library wrapper is not this bug's fix).
- [X] T371 [US1] New `scripts/fixtures/omp-frames/side-chat-long-answer.jsonl` (a minimal
  Session-shaped tape plus one `get_btw_history`/`btw` exchange whose response is already a
  COMPLETE record with a deliberately tall-but-narrow 87-line markdown answer: a 40-item bullet
  list, a small 2-column table, and a 30-line code block, ending in a literal last-line marker)
  and new `scripts/verify-802-side-chat-scrollbars.mjs`, modelled on
  `verify-439-history-truncate.mjs`/`verify-862-conversation-history.mjs`'s own guarded-tmpdir,
  fresh-exe-copy, themed-screenshot pattern: opens the Side chat panel through the real
  permanent icon rail, types the question and presses Enter (never `window.refract.*`
  directly), waits for the answer's own last-line marker to render, then asserts exactly one
  element inside `#right-pane-active-panel` has `scrollHeight > clientHeight` and a computed
  `overflow-y` of `auto`/`scroll`, asserts zero elements in that subtree have
  `scrollWidth > clientWidth`, scrolls the one container to its own `scrollHeight` and asserts
  the last-line marker's bounding rect falls inside the container's visible viewport bounds,
  and re-confirms both the one-scroller and no-horizontal-overflow guarantees under Dark,
  Obsidian and Dark (high contrast), screenshotting each. WRITTEN, NOT RUN (lane brief: "NO
  BUILD"): `node --check` passed; a real `import()` check with `CARGO_TARGET_DIR` unset
  confirmed every import resolves and the script stops exactly at the
  `requireSharedCargoTarget` guard, never starting `pnpm tauri build` itself.

Opened as draft PR (branch `fix/802-side-chat-scrollbars`); `Refs #802` until the live check
above is confirmed against a real build (no cargo build run in this lane -- no-build prep lane,
blocked on the build slot). `pnpm typecheck` (both tsconfigs, 0 errors), `pnpm check:indent` (0
odd-indent lines across 395 files), `pnpm check:file-size` (0 cap violations across 447 files),
and the existing `pnpm vitest run` suite (148 pass, no new tests added per AGENTS.md's
prototyping rule -- the new fixture is a fake-omp frame tape, not a test) all ran clean.
**Decided (Skippy, delegated by Stuart 2026-10-18, issue #802):** the optional, separately-noted
polish items the issue itself calls "not the fix" (the themed `scrollbar-thin` treatment and
`overscroll-contain` on the side-chat scroller) are intentionally NOT built in this change --
root-cause fix only, no scope creep; filed nowhere else since the issue's own text already
records them as open, undecided follow-ups.

## Phase 77: Convergence (#1200 pull request detail layout)

- [x] T372 Reproduce issue #1200 by opening a long pull request containing a long description,
  comments, review comments, wide tables, code blocks, and unbroken strings; use CDP to inspect
  computed heights up the ancestor chain and identify the element that grows the document per
  FR-102. Reproduced on PR #1104: `html.scrollHeight` 6636 at 1920x1080 (9989 at 1280x720); the
  culprit is the comment box's `sr-only` `role=alert` paragraph (`position: absolute`) at the
  end of the Overview, which had no positioned ancestor and so laid out against the viewport.
- [x] T373 Apply a CSS-only fix for the identified layout growth per FR-102: `relative` on the
  app root in `src/renderer/App.tsx` and on the Overview and Changes `TabsContent` scrollers in
  `src/renderer/features/pull-requests/PullRequestDetail.tsx`. No `min-h-0`, `min-w-0` or
  `PullRequestsView.tsx` change was needed.
- [x] T374 Apply any CSS-only overflow containment or wrapping adjustment needed in the pull
  request comment markdown renderer per FR-102. Not needed: the markdown content did not grow
  the document once the `sr-only` alert was contained (body width equals the window at both
  sizes on PR #1104).
- [x] T375 Verify the long pull request live at 1920x1080 and 1280x720 per FR-102. After the fix
  `html.scrollHeight` equals the window height at both sizes, body width equals the window
  width, the list column renders 50 rows, the document `scrollTop` stays 0 after End plus wheel
  overscroll, and PageDown, Home and End scroll only the Overview.
- [x] T376 Run the required gates after the fix per FR-102: `pnpm typecheck` passed,
  `pnpm test` 148/148, and `check:indent`, `check:ui-text`, `check:theme-contrast`,
  `check:drag-regions` and `check:file-size` all report 0 issues.

## Phase 78: Convergence (#1205 open stopped Sessions without starting the agent, FR-103 to FR-107)

`/speckit.converge` against the amended spec (FR-103 to FR-107, the 2026-10-23 Clarifications
entry, and plan.md "Amendment 2026-10-23"): eleven findings, all appended below; none of the
issue's behaviour exists in the code yet. Evidence: a passive `sessions.open` still auto-starts
through `can_auto_start` (`src-tauri/src/ipc/sessions_agent.rs:45-65`) in
`attach_snapshot_decision` (`:383-407`); `build_snapshot` (`src-tauri/src/ipc/conversations.rs:47-93`)
returns only the live agent's `runtime_view()` transcript; no `showAgentStoppedBar` setting,
Settings > Sessions section, or "Agent stopped" bar exists; `ChatPane.tsx:205`
(`canAutoStartSession`) still drives the "Starting agent" notice on a passive open. No new tests
(prototyping phase): verification is a live run with the fake-omp harness.

- [x] T377 Confirm OMP's session-file record format on a real `.jsonl` (a file under a Session's
  `sessionDir`, cross-checked with `omp://session.md` "File Format"): the `type: "title"` first
  line, `type: "message"` records and their nested `message` shape (`user`, `assistant`,
  `toolResult`, `toolCall` parts), the prelude entry types to skip, and whether one file can hold
  more than one branch (`id`/`parentId`) and if so how the active branch is found. Record it as a
  new item in `docs/spike/FINDINGS.md` before T378 starts, per Constitution IV and FR-103
  (missing)
- [x] T378 Add `src-tauri/src/session/saved_history.rs`: read the Session's
  `current_conversation` file (`store/registry.rs:35-44`) line by line, skip malformed lines and
  non-message records as `conversations.rs`'s `read_conversation_file` does, collect the
  `message` objects in order (following the active branch if T377 found branches), and return
  `omp::transcript::TranscriptState::from_history(&messages)` items; report a missing or empty
  file as its own result per FR-103 and FR-024 (missing)
- [x] T379 Make a passive `sessions.open` never start the agent: in
  `src-tauri/src/ipc/sessions_agent.rs` `attach_snapshot_decision` starts only when `force_start`
  (`userAction: true`, `sessions.recover`); keep `can_auto_start` only for choosing the stop
  banner, and update its doc comment and `contracts/ipc.md`'s `sessions.open` row (already
  amended) per FR-103 and FR-104 (contradicts)
- [x] T380 In `src-tauri/src/ipc/conversations.rs` `build_snapshot`, when the agent stays
  stopped, inject T378's items into `runtime.transcript` (and a plain missing-or-empty notice
  when the file is absent) so the existing `SessionSnapshot` shape (`src/shared/ipc.ts:224-236`)
  carries the history with no `omp` process; the live transcript replaces it once the agent
  starts per FR-103 (missing)
- [x] T381 Route every passive path through the history-only open and audit it: Session-row
  click, Ctrl+click into a Split (`split-store.ts`), a notification click and startup pane
  restore (`init-stores.ts` `onUiOpenSession`), all via `ChatPane.tsx`'s snapshot effect
  (`useSessionsStore.getState().open(sessionId)`); none may pass `userAction: true` per FR-103
  (partial)
- [x] T382 Sending to a stopped Session: `MessageInput.tsx` keeps the draft and the pending
  message while `open(sessionId, true)` starts the agent, waits for ready through the existing
  `src-tauri/src/session/start_queue.rs` ready signal (no new queue), then sends exactly once;
  a failed start keeps the draft and shows the existing stop banner per FR-104 (partial)
- [x] T383 Add `src/renderer/features/chat/AgentStoppedBar.tsx` from shared `components/ui`
  primitives: text "Agent stopped", a **Start agent** button (`open(sessionId, true)`) and a
  **Don't show again** text button; not a live region, not colour alone, keyboard reachable;
  shown only while the shown Session is stopped with no FR-034/FR-035 stop banner and
  `showAgentStoppedBar` is on; mount it above the composer in `ChatPane.tsx` without growing
  `ChatPane.tsx` past its file-size baseline (1,445; extract a block if needed) per FR-105 and
  the #806 cap (missing)
- [x] T384 Show the "Starting agent" notice only while a start is actually running: replace the
  `isOpening && status === 'stopped' && canAutoStartSession` condition (`ChatPane.tsx` about
  `:205-224`) with the real start signal, and announce the start once to assistive technology
  per FR-106 (contradicts)
- [x] T385 Add the `showAgentStoppedBar` setting (default `true`; an absent field reads `true`):
  `src-tauri/src/store/agent_stopped_bar.rs` (new, beside `chat_width.rs`), `store/settings.rs`,
  `ipc/settings.rs` registering `settings.setShowAgentStoppedBar`, and `Settings` plus the
  setter in `src/shared/model.ts` and `src/shared/ipc.ts`, keeping `pnpm check:parity` green
  per FR-107 and `contracts/ipc.md` (missing)
- [x] T386 Add Settings > Sessions: `src/renderer/features/settings/SessionsSection.tsx` (new)
  with the "Show the Agent stopped bar" toggle from a shared switch component, a `'sessions'`
  `SettingsSectionId` in `view-store.ts`, and its `SECTIONS` entry in `SettingsScreen.tsx`; wire
  **Don't show again** to turn the setting off with a `sonner` toast confirming it and an
  **Undo** action that turns it back on per FR-107 (missing)
- [x] T387 Verify live with the fake-omp harness (`scripts/verify-tauri.mjs`; add a stopped
  Session fixture with a saved `.jsonl` under `scripts/fixtures/` if none fits; a fixture, not a
  test) against quickstart.md Story 4 steps 5 to 8: history shows and no `omp` starts on each
  passive path, no "Starting agent" notice until **Start agent** or a send, the queued send lands
  once, the bar toggle and **Undo** work, and keyboard and screen reader checks pass; then run
  `pnpm typecheck`, `pnpm test`, `check:indent`, `check:ui-text`, `check:theme-contrast`,
  `check:drag-regions`, `check:file-size`, `check:parity`, and `cargo fmt --check`,
  `cargo clippy --all-targets -- -D warnings`, `cargo test` per FR-103 to FR-107 (missing)

## Phase 79: Convergence (#526 Session row Activity line, FR-108 to FR-111, spec 004 FR-041)

- [ ] T388 Extend the shared derive in `src/shared/activity.ts`: an optional `pending` input
  (first pending request: `{ kind: 'question', text }` or `{ kind: 'approval', tool, target }`)
  giving "Needs your input: <text>" or "Waiting for approval: <tool> <target>" (sanitised,
  target reduced to its base name), "Waiting for your answer" when `needsYou` has no pending; a
  `SessionActivity` type (the ActivityInput fields minus `needsYou`/`pending`); and a pure
  `playfulPhrase(sessionId, slot)` over a fixed list of about 12 phrases, per spec 004 FR-041
  (partial)
- [ ] T389 Add a Rust per-Session activity emitter (new module beside
  `src-tauri/src/session/readout_activity.rs`) that builds `SessionActivity` from the existing
  readout state (running subagent count, current todo `{ number, total, content }` matching
  `deriveTodoTotals`/`deriveCurrentTask`, latest intent and tool, retry, compacting) and emits
  `session:activity` for every live agent, not gated by visibility, at most once per second per
  Session with a trailing update and only when the value changed; add `emit_session_activity`
  to `events.rs` and never log the payload per FR-109 (missing)
- [ ] T390 Add `activity: SessionActivity | null` to `SessionSummary` in `src/shared/ipc.ts` and
  the Rust `sessions.list` builder, the `session:activity` event name and `onSessionActivity`
  bridge, and patch the one row in the sessions store from `init-stores.ts` (no list refetch);
  keep `pnpm check:parity` green per FR-109 and `contracts/ipc.md` (missing)
- [ ] T391 Add the `activityText: 'plain' | 'playful'` setting (default `'plain'`, absent reads
  `'plain'`): a Rust store module beside `chat_width.rs`, `store/settings.rs`, `ipc/settings.rs`
  registering its setter, and `Settings` plus the setter in `src/shared/model.ts` and
  `src/shared/ipc.ts`; add the "Activity text" Plain | Playful control to
  `AppearanceSection.tsx` from a shared component per FR-111 (missing)
- [ ] T392 Move the banner's 600 ms hold into one shared hook (with Playful 10 s rotation for the
  `working` kind) used by `CurrentWorkBanner.tsx` and the row; pass the first pending request
  from `usePendingRequestsStore` into the banner's derive per spec 004 FR-041 and FR-110
  (partial)
- [ ] T393 Add the `activity` case to `lineTwoKind` in `SessionRow.tsx` (after start-progress,
  terminated and archived; only while working or needs-you), render the derived text as one
  truncated muted line with no tooltip and no live region, and lead `activityDescription` and the
  `SessionDetailsCard` with it, keeping `SessionRow.tsx` under the #806 cap per FR-108, FR-110,
  US5/AC9 (missing)
- [ ] T394 Verify live with the fake-omp harness (`scripts/verify-tauri.mjs`; add a
  recorded-frame fixture under `scripts/fixtures/omp-frames/` if none fits; a fixture, not a
  test) for a background and an open Session: subagents, todo, intent, tool verb, needs-you
  question and approval, idle revert to the branch, Playful rotation, setting persistence,
  keyboard and screen-reader description; then run `node scripts/ci-local.mjs` per FR-108 to
  FR-111 and spec 004 FR-041 (missing)

## Phase 80: Convergence (#730 right pane rail drag to rearrange, FR-112 to FR-116)

- [X] T395 Add the generic reorder pieces in `src/renderer/components/reorder/`: a `useReorderable`
  hook (pointer drag after 6 px, Esc cancels, `Alt+Shift+Up/Down` keyboard move, polite
  announcement "<name>, position N of M", moved item keeps focus, reduced motion respected), an
  insertion marker, and no list-specific code so #638 can reuse it, per FR-113 and FR-116
  (missing)
- [X] T396 Add `panelOrder: string[]` to `RightPaneSettings` (`src/shared/rightPane.ts`, default
  `[]` meaning default order), validate and persist it in `src-tauri/src/store/right_pane.rs`
  (tolerate an absent field in old files; cap length and id length), and keep
  `pnpm check:parity` green per FR-114 (missing)
- [X] T397 Reorder `HOSTED_PANELS` to the default order, add `DEFAULT_PANEL_ORDER`, a pure
  `mergePanelOrder(saved, registered)` (unregistered ids kept, missing panels inserted at their
  default slot) and `useOrderedPanels()` in `panel-registry.ts`/`right-pane-store.ts`; persist it
  through `right-pane-persistence.ts`; the rail and `PanelLauncher.tsx` read the ordered list, the
  tab bar is untouched, per FR-112 and FR-114 (missing)
- [X] T398 Make `IconRail.tsx` use the reorder hook: drag a button, `Alt+Shift+Up/Down`, roving
  tabindex and the toggle click preserved, per FR-113 (missing)
- [X] T399 Add "Reset panel order" to `RightPaneSection.tsx` from the shared `Button` per FR-115
  (missing)
- [X] T400 Update `docs/design/components.md` (the reorder pieces), `docs/PLAN.md` row 20, then
  verify live on the built app with a scratch `REFRACT_DATA_DIR` (default order, drag, keyboard
  move, restart persistence, launcher agreement, Reset, screenshots viewed), then run
  `node scripts/ci-local.mjs` per FR-112 to FR-116 (missing)

## Phase 81: Convergence (#1236 mid-turn assistant prose as a row, FR-117, FR-118)

- [x] T401 Add `groupMidTurnProse.ts` (a pass after `groupToolItems`: an `assistant-text` followed
  later in the turn by a `tool-group`, `subagent` or `assistant-text` becomes a `mid-turn-prose`
  group of one) and wire it into the `Transcript.tsx` grouping chain, per FR-117 (missing)
- [x] T402 Extend `CollapsedLine` with a `clampLines` prop and a shared Show more clamp, per FR-118
  (missing)
- [x] T403 Add `MidTurnProseRow.tsx` (a "Note" `CollapsedLine`, first-line summary, icon distinct
  from the thought row's, clamp at 8 lines) and render it from `TranscriptRow.tsx`; the row needs no
  entry in `transcriptRowVisibility.ts` (prose is not bookkeeping and "Show tool calls" never
  hides it), per FR-117 and FR-118 (missing)
- [x] T404 Verify live with the fake-omp harness (a multi-tool turn with mid-turn prose; check the
  collapse, the streaming switch, the clamp, the final reply untouched), update `docs/PLAN.md`,
  then run `node scripts/ci-local.mjs` per FR-117 and FR-118 (missing)

## Phase 82: Convergence (#1250 turn timers, FR-046, FR-119; spec 004 FR-039)

- [x] T405 Remove the elapsed time and "·" from `CurrentWorkBanner.tsx` (delete `useElapsedMs` and the
  `formatElapsed` import), per spec 004 FR-039 (missing)
- [x] T406 Add the `showFinishedTurnTimes` setting (default off) through Rust `store/`, `ipc/`
  (`settings.setShowFinishedTurnTimes`), `shared/ipc.ts`, `model.ts`, the bridge and
  `settings-store.ts`, per FR-119 (missing)
- [x] T407 Gate the settled branch of `TurnTotalLine` (visual and sr-only) on the setting, keep the
  running line always shown, and add a "Show finished turn times" switch to Settings > Chat from
  `SettingSwitchRow`, per FR-046 and FR-119 (missing)
- [x] T408 Verify live with the fake-omp harness (banner has no time; a settled turn shows no total
  with the switch off and "Turn took Ns" with it on; the running line always ticks; the switch
  applies live and persists), update `docs/PLAN.md`, then run `node scripts/ci-local.mjs` per
  FR-046 and FR-119 (missing)

## Phase 83: Convergence (#1127 reasoning radios gate follow-ups, FR-099)

- [x] T409 `RoleReasoningRadios.tsx`: keep the stored-unknown-token radio mounted while it holds focus
  or a save is pending (WCAG 2.4.3), make the settle step a layout effect, guard re-selecting the
  unknown token as a no-op, give the remount refusal its own message, and reword the focus-recovery
  comment, per FR-099 (missing)
- [x] T410 `verify-1069-roles-overhaul.mjs` and `-helpers.mjs`: focus assertion without re-focusing,
  assert the held pick registered and wait before counting `config-set`, poll the "dot does not
  move" reads, fix the "High" docstring, per FR-099 (missing)
- [x] T411 Verify live with the fake-omp harness, update `docs/PLAN.md`, then run
  `node scripts/ci-local.mjs` per FR-099 (missing)
- [x] T412 Stop banner focus handoff: `focusStopBanner`, `useComposerFocusHandoff`, single
  `stopAndRestore` focus, per FR-120 (issue #1285)
- [x] T413 Live check `scripts/verify-tauri-092.mjs` for FR-120, then `ci:local` and gate

## Phase 84: Convergence (#1648 OMP command output as Markdown, FR-121, FR-122)

- [x] T414 [US1] Decided no Rust change: the typed `/usage` parser recognises the reply from its own
  header, so the notice carries no command name, per FR-122
- [x] T415 [US1] `NoticeRow.tsx`: render command-output bodies through `Markdown` (variant chat) with a
  stripped first-line summary, per FR-121 (missing)
- [x] T416 [US1] `parseUsageOutput` (one typed parser) and a `UsageNoticeCard` built from `Card` and
  `ProgressStrip` (state prop), with the Markdown fallback, per FR-122 (missing)
- [ ] T417 [US1] Live check `scripts/verify-tauri-1648.mjs` in a light and a dark theme, update
  `docs/PLAN.md`, then `node scripts/ci-local.mjs` and gate

## Phase 85: Convergence (#1663 only short mid-turn prose is a Note row, FR-117)

- [x] T418 `groupMidTurnProse.ts`: wrap a followed assistant text only when it is at most 3 lines and
  280 characters; longer text stays a normal `assistant-text` row, per FR-117 (partial)
- [x] T419 Live check that a long mid-turn reply renders expanded and a short one stays a Note row, update
  `docs/PLAN.md`, then `node scripts/ci-local.mjs` per FR-117 (missing)

## Phase 86: Convergence (#758 virtual write targets are not file links, FR-123)

- [x] T420 [US1] `linkify.ts`: add `isLinkableFilePath` (refuses empty, `scheme://`, `~`, `$VAR`,
  `%VAR%`, UNC) and call it from `isPathShaped`, per FR-123 (missing)
- [x] T421 [US1] `Markdown.tsx`: `FileLinkButton` renders plain text when the path is not linkable, so
  `ToolRow` and `DiffView` are covered, per FR-123 (missing)
- [x] T422 [US1] Live check `scripts/verify-tauri-758.mjs`, update `docs/PLAN.md`, then
  `node scripts/ci-local.mjs` per FR-123 (missing)

## Phase 87: Convergence (#1157 every Refract git/gh reader holds a worktree read guard, FR-029/FR-030)

- [x] T423 [US1] Take `worktree_access::read_guard_bounded` per git/gh call in the explorer status,
  `sessions.diffStat`, readout `diff_stat`/`compute_branch`, HEAD watch, PR lookup and touched-item
  lookups; a refusal reads as `None`/unavailable, per FR-029 and FR-030 (missing)
- [x] T424 [US1] Record the one-guard-per-call rule at `worktree_access.rs`, then `node scripts/ci-local.mjs`
  per FR-030 (missing)

## Phase 88: Convergence (#1741 linked images in PR descriptions, FR-124)

- [x] T425 [US1] `Markdown.tsx`: an image inside a link renders `ResolvedImage` (alt text as fallback)
  when `resolveImage` is set; the chat branch is unchanged, per FR-124 (missing)
- [x] T426 `github/images.rs`: allow `dependabot-badges.githubapp.com` and accept SVG from that host only
  (signature checked), with Rust tests, per FR-124 (missing)
- [x] T427 Live check a Dependabot PR description, update `docs/PLAN.md`, then `cargo` and
  `node scripts/ci-local.mjs` per FR-124

## Phase 89: Convergence (#1159 Delete flow hardening, FR-125, FR-029)

- [x] T428 [US6] `fs/leftover_summary.rs`: move the read guard into the `spawn_blocking` closure, so a
  dropped IPC future cannot release it while the walk runs, per FR-125(d) (missing)
- [x] T429 [US6] `fs/remove_tree.rs`: pin the attempt-1 canonical path across retries, refuse when a
  later attempt resolves elsewhere, and `log::debug!` each retry; keep the #1158 behaviour, per
  FR-125(b) (missing)
- [x] T430 [US6] `git/worktree_holders.rs`: give `Unreadable` its own message and use
  `normalize_git_path` for the displayed path, per FR-125(a), (b) (missing)
- [x] T431 [US6] `git/worktree_delete.rs`: reword `registration_unknown_message` and normalise its
  path, per FR-125(a) (partial)
- [x] T432 [US6] `git/worktree_delete_check.rs`: leave `D` and ` D` porcelain lines out of
  `uncommitted_files`, per FR-125(c) (missing)
- [x] T433 [US6] `components/DialogError.tsx`: the shared always-mounted error live region; use it in
  `ConfirmAlertDialog.tsx` and `ReviewDialog.tsx`, per FR-125(f) (missing)
- [x] T434 [US6] `DeleteDialog.tsx`: bump the generation in the open effect, keep "Retry" while
  deleting, spinner and "Rechecking…" for loading and re-check, drop the dead `outline-offset`
  class, reword the unreadable-list copy, per FR-125(e), US6/AC8 (missing)
- [x] T435 [US6] Update `docs/PLAN.md` and `docs/design/components.md`, then run the TS checks;
  `cargo`, `ci:local` and the live check stay pending per FR-125 (missing)
- [x] T436 [US6] `ConfirmAlertDialog.tsx`/`DeleteDialog.tsx`: confirm button `min-w-24`, move focus to it
  before the file list is replaced; trim the `fs/remove_tree.rs` header comment, per FR-125(e) (missing)

## Phase 90: Convergence (#1817 skill-prompt row never built in Rust, FR-063)

- [x] T437 [US1] `transcript/skill_prompt.rs`: build the `skill-prompt` item (name, args, line count, summary) from
  OMP's custom message, called once from the live `message_*` path and once from the history path in
  `transcript.rs`, with a `SkillPrompt` variant and the `description` field in `model.ts`, per FR-063 (missing)
- [x] T438 Rust tests from the captured live and replay messages (`tests/fixtures/skill-prompt.json`) and the
  malformed (no name) Notice fallback, per FR-063
- [x] T439 [US1] `SkillPromptRow.tsx`: pass the summary as `iconTooltip` (hover and keyboard focus), per FR-063 (missing)
- [ ] T440 Live check a `/skill:<name>` send on a built app (live and after a Session reopen), update `docs/PLAN.md`,
  then `cargo` and `node scripts/ci-local.mjs` per FR-063

## Phase 91: Convergence (#1856 Keyboard shortcuts list overflows the dialog, FR-126)

- [x] T441 [US4] `KeyboardShortcutsDialog.tsx`: give the dialog a `minmax(0,1fr)` middle grid row and put the list in the
  shared `ScrollArea`, per FR-126 (missing)
- [x] T442 Live check the dialog at a short window height (list scrolls by keyboard, Done visible), update
  `docs/PLAN.md`, then `node scripts/ci-local.mjs` per FR-126

## Phase 92: Convergence (#1876 advisory stripe beside the body only, #1877 agent-to-agent accent colour, FR-051, FR-101; retroactive: code 6278aedd, b0cdfb41 came first)

- [x] T443 [US1] `AdvisoryRow.tsx`: move `STRIPE_CLASS` from the `data-advisory-severity` wrapper to the expanded body's
  `contentClassName`, so a collapsed card of any severity draws no bar, with `AdvisoryRow.test.ts` and
  `scripts/verify-558-blocker-callout.mjs` reading the body's `::before`, per FR-051 (partial)
- [x] T444 [US1] Point `--agent-message` at `--accent-text` in `globals.css` and the six theme files (a one-step
  lightened accent in Dark/Obsidian where plain accent misses 4.5:1 on the row hover), teach
  `scripts/theme-tokens.mjs` to parse `color-mix`, per FR-101 (contradicts)
- [x] T445 Live check the collapsed and expanded advisory card and an agent-to-agent row in one dark and one light theme
  (and after an accent change), update `docs/PLAN.md`, then `node scripts/ci-local.mjs` per FR-051, FR-101

## Phase 93: Convergence (#1950 chat issue and pull request references open the right pane, FR-127)

- [x] T446 [US1] `openItemRef.ts` (new, beside `ItemRefLink.tsx`): the click decision as a pure function with injected
  pin and open-in-browser. A plain click on an in-Project reference looks the item up, then pins it with `focus: false`
  as an issue or a pull request by the looked-up kind; Ctrl/Cmd or middle click opens GitHub without a lookup; a failed
  lookup or another repository opens GitHub, per FR-127 (missing)
- [x] T447 [US1] `ItemRefLink.tsx`: call it from `onClick` and `onAuxClick`, replacing the Pull requests view open for
  pull requests and the GitHub open for issues; keep the five-minute cache and the hover-only lookup, per FR-127 (contradicts)
- [x] T448 [US1] `ItemTypeIcon.tsx` (new) and `itemCardCache.ts` (new, the five-minute cache moved out of `ItemRefLink.tsx` with a
  render-safe `peekCard`): a leading type icon, neutral (`HashIcon`) until the item is known from a hover, focus or
  click lookup or a cached lookup, then `CircleDotIcon` or `GitPullRequestIcon` in the state colour; the hover Item card
  opens with the icon and the type word; no lookup or prefetch at render, per FR-127 (missing)
- [x] T449 `openItemRef.test.ts`, `ItemTypeIcon.test.ts`, `itemCardCache.test.ts` and `ItemRefLink.test.ts`: each guard (focus stays in chat, kind routing, modifier and middle
  click, failed lookup, out-of-Project, neutral icon) fails when removed, per FR-127
- [x] T450 Live check on a built app (`pnpm verify:tauri`): click pins and reveals the pane without taking focus, re-click
  focuses the pin, Ctrl-click leaves the pane alone; update `docs/PLAN.md`, then `node scripts/ci-local.mjs` per FR-127

## Phase 94: Convergence (#1878 composer chip shows the role from start and resume, FR-128)

- [x] T451 [US1] `model_support.rs` (`role_after_launch`, `seed_role_at_launch`) and `model.rs` (`on_launch`), called from
  `launch.rs` after `sync_from_state`: reset the cached role and read it from the Conversation file once the process has
  launched, `default` when the file names none, none when pinned, then emit `session_list_changed`, per FR-128 (missing)
- [x] T452 [US1] `roleModelText.ts` (`roleShown`, `shownText`, `chipText`, `chipTooltip`), `RoleModelPill.tsx`: the visible text is the role
  alone (the model name only for a pinned or role-less Session); the model name moves to the tooltip, per FR-128 (contradicts)
- [x] T453 `modelRoles.ts`: remove the `custom` sentinel, its label, icon, tooltip and `roleChipDisplay`, per FR-128 (contradicts)
- [x] T454 `roleModelText.test.ts` and the `launch_role_tests` module: each guard (role-only text, pinned shows model,
  tooltip carries the model, fresh session defaults, resumed keeps its role, pinned claims none) fails when removed, per FR-128
- [x] T455 Live check on a built app (`scripts/verify-tauri-1878.mjs`): a started Session and a resumed one show the role in the
  chip with the model in the tooltip; a pinned Session with a long name truncates; a queued change reads the new tooltip; update `docs/PLAN.md`, then `node scripts/ci-local.mjs` per FR-128

## Phase 95: Convergence (#1892 the Starting agent notice blurs the history behind it, FR-080; Spec Kit route none per triage, spec amended in place)

- [x] T456 [US1] `components/ui/blur-content.ts` (new): the shared blur and transition classes; `LoadingOverlay` uses them,
  behaviour unchanged, per FR-080 (missing)
- [x] T457 [US1] `Transcript.tsx`: replace the `opacity-40` dim of the transcript viewport with the shared blur, keep
  `focus-within` clearing it, animate it with `motion-reduce:transition-none` (also on the notice overlay's fade), per FR-080 (contradicts)
- [x] T458 No new logic (class names only), so no unit test; `scripts/verify-tauri-1892.mjs` reads the computed filter, opacity,
  transition and notice sharpness on a built app and screenshots the notice, then `node scripts/ci-local.mjs` per FR-080
  (live run green on a built app)
