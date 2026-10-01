# Tasks: Core session workspace

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Prerequisites**: OMP 18.4.x signed in; Git for Windows; Node 24+; `pnpm`. Windows 11 only.

**Tests**: none. Pinion is a prototype (constitution, Development Workflow). Each phase ends with a **Checkpoint** that runs the matching [quickstart.md](quickstart.md) section by hand. `pnpm typecheck` and `pnpm build` MUST pass before a change lands on `main`.

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
- [X] T004 Gate: confirm self-join works in the real app, not only in a bare Electron test (`docs/spike/job-object-probe.mjs` already proved `koffi` plus self-join inside Electron 44.5.1's main process): in the electron-vite app, create the kill-on-close job, assign the main process to it, spawn `ping -n 120 127.0.0.1`, force-kill the app, and confirm the child dies. Also check the side effect that everything Pinion launches joins the job: with all browsers closed, call `shell.openExternal('https://example.com')` from inside the job, then force-quit the app; if the browser dies with it, set `JOB_OBJECT_LIMIT_BREAKAWAY_OK` on the job and open URLs through a launch that uses `CREATE_BREAKAWAY_FROM_JOB` or hand off via `explorer.exe <url>` (the `omp` tree guarantee still holds because `omp` does not request breakaway [INFERENCE]). Record both results in FINDINGS item 12 (depends on T002). Status 2026-09-30: self-join verified in the real app; the `openExternal` side-effect check was NOT run because browsers were open; it moved to issue #68 (#22 is closed). The self-join half is verified (FINDINGS items 12, 16, 18).
- [X] T005 [P] Gate: probe the "OMP signed in" signal in `docs/spike/signed-in-probe.mjs` (reuse the frame driver from `docs/spike/resume-probe.mjs`): start `omp --mode rpc-ui`, wait for `ready`, call `get_available_models`, and record what a signed-in machine returns. If an unsigned state cannot be produced safely, say so; then choose the readiness rule (research.md "Unknowns") and record it in `contracts/ipc.md` under `readiness.check`.
- [X] T006 [P] Gate: record the shape of an `edit` tool result in `docs/spike/edit-diff-probe.mjs`: run a tiny turn in a scratch git repo that asks the agent to edit a file (`--approval-mode=yolo`), capture the `tool_execution_end` frame, and record whether `result.details` carries a diff. Record the outcome and the chosen diff source in `contracts/omp-usage.md` ("Tool row fields").

**Checkpoint**: `pnpm dev` opens a window; T003 to T006 each have their result written into the design docs.

---

## Phase 2: Foundational (blocks every user story)

**Purpose**: the core that every story uses: shared types, stores, git helpers, the OMP process wrapper with its frame decoder and Job Object, the transcript builder, and the per-Session controller.

- [X] T007 [P] Write `src/shared/model.ts` with `Repository`, `Session`, `Settings`, `ProcessRecord`, `SessionRuntime`, `SessionStatus`, `TranscriptItem`, `PendingRequest`, and `ConversationInfo` exactly as in data-model.md (keep the field names and the `'idle' | 'working' | 'needs-you' | 'stopped'` and `'ask' | 'edit-freely' | 'auto'` literals).
- [X] T008 [P] Write `src/shared/frames.ts` with the subset of OMP frame types Pinion reads (`ready`, `response`, `agent_start`, `agent_end`, `message_start/update/end`, `tool_execution_start/end`, `queue_update`, `extension_ui_request`, `prompt_result`, `session_settled`, `available_commands_update`, `command_output`, `notice`, `rpc_chunk`) per contracts/omp-usage.md "Frames Pinion consumes". Unknown frame types must type-check as `unknown`, never throw.
- [X] T009 Write `src/shared/ipc.ts` with every request and event in contracts/ipc.md, including `Result<T>` and the error codes listed there (depends on T007).
- [X] T010 [P] Write `src/main/store/atomicJson.ts` (write `<name>.json.tmp`, flush, rename over `<name>.json`; on a parse failure rename the bad file to `<name>.json.corrupt-<timestamp>` and return the default) and `src/main/store/registry.ts` + `src/main/store/settings.ts` for `registry.json` and `settings.json` in `app.getPath('userData')` (depends on T007). Enforce: `worktreePath` unique across Sessions, `branch` unique within a Repository.
- [X] T011 [P] Write `src/main/git/git.ts` (an `execFile('git', args, { cwd, windowsHide: true })` helper returning stdout, with typed errors) and `src/main/git/worktrees.ts`: `defaultBranch(repo)`, `listBranches(repo)`, `generateName()` (readable adjective-noun, checked against existing branches and folders), `addWorktree(repo, name, baseBranch)` creating `<repo>/../pinion-worktrees/<repoName>/<name>` with a new branch of the same name, `removeWorktree`, `deleteCheck(worktreePath)` (uncommitted files via `status --porcelain`, unpushed commits via `rev-list`), and `branchExists`. `addWorktree` MUST remove the worktree and branch it created if any step fails (no half-created Session) and map failures to `worktree-failed`, `base-missing`, `path-too-long`.
- [X] T012 [P] Write `src/main/process/jobObject.ts` (the only file with Windows-specific FFI): `joinKillOnCloseJob()` creates one Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` through `koffi` and assigns the current process to it via `AssignProcessToJobObject(job, GetCurrentProcess())`; it MUST run at app start before anything is spawned, and its failure MUST be logged and shown as a notice (the pid records below then become the only protection). Write `src/main/process/pidRecords.ts` for `processes.json`: `record(pid, startTime, sessionId)`, `remove(pid)`, and `reapStale()` which, at app start, stops (`taskkill /PID <pid> /T /F`) each recorded process that is still running with the same creation time and an `omp` image name, and discards every other record (depends on T004, T007, T010).
- [X] T013 Write `src/main/omp/OmpProcess.ts`: spawn `omp --mode rpc-ui --approval-mode=<mode>` with `cwd = worktreePath`, `windowsHide: true`, `stdio: 'pipe'`, no shell, no `--session-dir`, no `--model`, no `--resume` (reattach binds the Conversation with `switch_session` instead, per constitution Principle III, FINDINGS item 17); record its pid immediately (Job Object membership is inherited because the main process joined the job at start); read stdout as newline-delimited JSON (log and skip unparseable lines); negotiate protocol v2 after `ready` and reassemble `rpc_chunk` frames (validate `chunkId`, `index`, `count`, `byteLength`, strict UTF-8, reject interleaving, 64 MiB ceiling; copy the working reassembler from `docs/spike/resume-probe.mjs`); correlate responses by `id` with a per-request timeout; expose `request()`, `on('frame')`, `on('exit')`, `stop()` (clos…
- [X] T014 [P] Write `src/main/omp/transcript.ts`: `fromHistory(messages)` and `applyFrame(items, frame)` producing `TranscriptItem[]` per contracts/omp-usage.md "Message parts": `user`, `assistant-text`, `thinking` (only when the text is non-empty), `tool` (keyed by `toolCallId`; `target` is `path` for read/edit/write, `command` for bash, `pattern` for grep/glob, else the first string argument, truncated to 200 characters), `notice`. `message_update` replaces the item from the whole `message` snapshot. Hide `role: 'custom'` and `role: 'developer'` unless `display: true` (depends on T007, T008).
- [X] T015 [P] Write `src/main/omp/dialogs.ts`: classify `extension_ui_request` per contracts/omp-usage.md "Dialogs" (`select` whose title starts `Allow tool:` is an approval, options `Approve` and `Deny`, details from the following title lines; other `select` is a question; `input` and `editor` are free text; `confirm` is Yes/No; `cancel` withdraws a pending id) and build the `extension_ui_response` for each answer form. `notify` becomes a notice; `setStatus`, `setWidget`, `setTitle`, `set_editor_text`, `open_url` are ignored (depends on T007, T008).
- [X] T016 Write `src/main/omp/SessionAgent.ts` core lifecycle: `start()` (check the worktree exists, else `stopped`/`worktree-missing`; spawn; `get_state`; reattach verification per data-model.md; `get_messages`; status `idle`), `stop()`, exit handling (`stopped`/`agent-exited` with the exit code when Pinion did not ask), status and patch events with coalescing to at most one patch per 50 ms per Session, and reading `get_state` after each `session_settled` to update `lastMessageCount`, `lastActivityAt`, `sessionDir`, `currentConversation` in the registry. Later stories add turn handling, dialogs, and restart in this same file (depends on T010, T013, T014, T015).
- [X] T017 Write `src/main/index.ts`: single-instance lock, `app.setAppUserModelId(process.execPath)` in development, `joinKillOnCloseJob()` first of all, then `reapStale()`, create the window with the T003 security settings, open external links in the system browser and block in-app navigation, register every `contracts/ipc.md` request with a `not-implemented` result until its story lands, and stop all agents on `before-quit` (depends on T009, T012, T016).
- [X] T018 Write `src/preload/index.ts` exposing `window.pinion` with exactly the channels in contracts/ipc.md, and `src/renderer/state/` (zustand stores for repositories, sessions, the visible transcript, queue, pending requests, settings) subscribed to the events in contracts/ipc.md (depends on T009).
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

- [X] T034 [US4] On start, load `registry.json`, list every non-archived Session as `stopped` with `stopReason: 'not-started'` (shown as asleep, not as an error) and start no agent; `sessions.open` starts and reattaches the Session's current Conversation by spawning without `--resume` and binding it with `switch_session`. Verify with the data-model.md rules: `sessionFile` equals `currentConversation`, `messageCount > 0` and is at least `lastMessageCount` when set (OMP can append messages outside Pinion's settle flow). On a mismatch or a missing file show a plain notice naming the failed check, never a blank chat (FR-022 to FR-024) (depends on T016, T022).
- [X] T035 [US4] Prove the force-kill guarantee with the chosen Job Object strategy: with a Session mid-turn running a long tool (`ping -n 120 127.0.0.1` via the agent), end the Pinion process from Task Manager and confirm no descendant of its `omp` remains within 10 s. Record the run in FINDINGS. Confirm `reapStale()` removes a stale record for a still-running matching process created for the test (FR-031, SC-006).

**Checkpoint**: run quickstart Story 4 end to end.

---

## Phase 7: User Story 5 - Several sessions at once, and memory (Priority: P2)

**Goal**: many Sessions work at once without mixing; the list and notifications show what needs the user; low memory is visible and actionable.

**Independent test**: [quickstart.md](quickstart.md) Story 5 and the Memory check.

- [X] T036 [US5] Send `transcript:patch` only for the Session the user is viewing (plus a full snapshot when a Session becomes visible) and keep every Session's transcript, queue, and pending requests in its own `SessionAgent`, so background Sessions keep working and never write into another Session (FR-026).
- [X] T037 [US5] Track `unread`: set when a Session goes `working` to `idle` while it is not the visible Session or no Pinion window is focused; clear it when the Session is opened. Show the unread dot and the four states in `SessionList.tsx` (FR-005, FR-006) (depends on T023, T024).
- [X] T038 [US5] Windows notifications in `src/main/index.ts`: use Electron's `Notification` only when no Pinion window is focused and only when a Session becomes `needs-you` or finishes; clicking focuses the window and sends `ui:open-session`; no other state change notifies (FR-027).
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
- UI components come from shadcn/ui (research.md decision 2). T019 initialises its CSS-variable tokens and adds the four state-colour roles as extra tokens in the documented way (`:root`, `.dark`, `@theme inline`), plus `--font-ui` and `--font-code`; its three-region layout uses shadcn `Resizable`. T025 builds the transcript with shadcn `Message`, `Message Scroller`, and `Collapsible` (Thinking and tool rows) and falls back to `react-virtuoso` only if Message Scroller does not handle a 30-row streaming turn smoothly. Copied components are Pinion's code: edit them in place rather than wrapping them.
- GitHub issues: every task has an issue titled `Tnnn: ...`, labelled with a type, an area, a priority, and `spec:001`. For T001 to T049 the issue number is the task number + 18 (T001 is #19, T049 is #67). T050 to T052 are #72 to #74 and T053 to T055 are #75 to #77, because #68 to #71 were already taken. Created with `/speckit.taskstoissues` (2026-09-30, and 2026-10-01 for Phases 11 and 12); tick the checkbox here and close the issue together.

## Phase 11: Convergence

- [ ] T050 [US1] Make the repository header `+` button create a Session in one click: in `src/renderer/features/sessions/SessionList.tsx` call `window.pinion.sessions.create({ repositoryId, baseBranch: repository.defaultBranch })` directly (no dialog); ignore clicks while a creation for that repository is in flight (per-repository flag; use `aria-disabled` plus a guard in the handler, not `disabled`, so focus is not dropped); show a failure with `notify` and leave no half-created Session; on success refresh the list, then select and open the new Session (`setVisibleSessionId`, ChatPane's effect opens it). Accessible name and tooltip name the branch, e.g. "New session from main" using the real default branch name per FR-002, US1/AC1, US1/AC10 (partial)
- [ ] T051 [US1] Add a second header button with lucide `GitBranchPlusIcon` beside `+` that opens the existing `NewSessionDialog` Base branch picker (default branch preselected), with accessible name and tooltip "New session from a branch..."; make `NewSessionDialog.handleSubmit` select and open the new Session after a successful create exactly as T050 does (share one helper, no duplicated create logic); Cancel creates nothing and focus returns to the branch button per FR-002, US1/AC10 (missing)
- [ ] T052 [US1] Update the docs for the two-button flow and verify it live: `specs/001-core-session-workspace/quickstart.md` Story 1 step 2, `docs/DESIGN.md` ("First run and empty states" and the session list header), `CONTEXT.md` Base branch, `specs/001-core-session-workspace/data-model.md` `defaultBranch` comment; then run quickstart Story 1 step 2 on the built app (one-click create from the default branch, the new Session selected and open, the picker with another Base branch, a double-click creates one Session, a failure shows its reason) per FR-002 (partial)

## Phase 12: Convergence

- [ ] T053 [US1] Group the Base branch picker and show Session display names: change `repositories.branches` (`src/main/ipc/repositories.ts`, `src/shared/ipc.ts`, `src/preload/index.ts`, `contracts/ipc.md`) to return entries `{ name, kind: 'default' | 'branch' | 'session', sessionName?, archived? }` built in main from `listBranches` plus the registry's Sessions for that repository (match `Session.branch`; use the live `Session.name` and `archivedAt`), so a rename is always reflected; render them in `src/renderer/features/sessions/NewSessionDialog.tsx` with `SelectGroup` and `SelectLabel`: "Branches" (default branch first and preselected, lucide `GitBranchIcon`) and "Sessions" (lucide `FolderGit2Icon`, the display name as the primary text, the branch id as secondary text, and an "Archived" `Badge` for archived Sessions); the selected value stays the branch name and `sessions.create` validation is unchanged per FR-002, US1/AC10 (missing)
- [ ] T054 [US1] Fix the Base branch picker opening over its own field: in `src/renderer/features/sessions/NewSessionDialog.tsx` pass `position="popper"`, `side="bottom"` and a small `sideOffset` to the Base branch `SelectContent` (the shadcn default in `src/renderer/components/ui/select.tsx` line 60 is `item-aligned`, which draws the list over the trigger); the list MUST NOT cover the field or its label, and keyboard navigation and the highlighted-item cue stay as they are per FR-002, US1/AC10 (partial)
- [ ] T055 [US1] Update the docs for the grouped picker and verify it live: `specs/001-core-session-workspace/contracts/ipc.md` (`repositories.branches` response), `specs/001-core-session-workspace/data-model.md`, `docs/DESIGN.md` (picker content and placement), `CONTEXT.md` Base branch; then on the built app: the picker opens below its field; create a Session, rename it, open the picker and confirm the Sessions group shows the new display name with the branch id; an archived Session is tagged Archived; the default branch is first and preselected; creating from a Session's branch produces a worktree based on that branch (right after create, `git rev-parse <new-branch>` equals `git rev-parse <session-branch>`; `git merge-base` alone proves nothing because the merge-base with the default branch matches too) per FR-002, US1/AC10 (partial)
