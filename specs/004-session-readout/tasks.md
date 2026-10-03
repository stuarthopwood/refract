# Tasks: Session readout

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Prerequisites**: spec 001 tasks T098 (Approval mode pill / chip row) and T068 (`sessions.diffStat`) already on `main` — this spec's chip row and Changes chip build on them, never duplicate them. OMP 18.4.x or 18.5.x signed in; Git for Windows; Node 24+; `pnpm`; the GitHub CLI (`gh`) signed in. Windows 11 only.

**Tests**: none. Refract is a prototype (constitution, Development Workflow). Each phase ends with a **Checkpoint** that runs the matching [quickstart.md](quickstart.md) section by hand. `pnpm typecheck` and `pnpm build` MUST pass before a change lands on `main`.

**Organization**: tasks are grouped by user story so each story can be built and checked on its own. Paths are relative to the repository root.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task).
- **[Story]**: the user story from [spec.md](spec.md) (US1 to US3). Setup, Foundational, and Polish tasks carry no story label.
- Tasks that edit the same file are never both marked [P].

---

## Phase 1: Setup and gates

**Purpose**: settle the three OMP facts the constitution (Principle IV) says must be verified before any chip or panel code names a real field, per research.md's Unknowns table.

- [ ] T001 [P] Gate: probe context-window usage in `docs/spike/context-usage-probe.mjs`: start a Session, run a turn of some size, call `get_state` and (if it exists) `get_session_stats`, and also run `/context` and capture its `command_output`; compare all three for a consistent tokens-used/window-size pair. Record the result as a new numbered FINDINGS item and the resolved field/request name in `contracts/omp-usage.md` section (a) per research.md item 1. (#211)
- [ ] T002 [P] Gate: probe task-list ("todo") progress in `docs/spike/todo-progress-probe.mjs`: run a turn that creates and partially completes a task list, and inspect `get_state` and the `todo` tool's own call/result for a done/total shape. Record the result as a new numbered FINDINGS item and the resolved source in `contracts/omp-usage.md` section (b) per research.md item 2. (#219)
- [ ] T003 [P] Gate: extend FINDINGS C6 and spec 001 task T071(d)'s probe (do not repeat it) for per-subagent live-stream data in `docs/spike/subagent-stream-probe.mjs`: start a turn with two or more subagents, subscribe with `set_subagent_subscription`, and check whether `tool_call_update` (or any other frame received while subagents run) carries a stable per-subagent id and enough text/tool-call content to build a selectable live stream, not just a status summary. Record the extension to FINDINGS C6 and the resolved shape in `contracts/omp-usage.md` section (c) per research.md item 3. (#225)

**Checkpoint**: `contracts/omp-usage.md` has all three "Question"/"Probe" sections replaced with resolved field/frame names; FINDINGS.md has the two new numbered items plus the C6 extension.

---

## Phase 2: Foundational (blocks every user story)

**Purpose**: the shared types, settings, IPC plumbing, and tracking structures every story's chips or panel read from.

- [ ] T004 [P] Extend `Settings` in `src/shared/model.ts` with `ReadoutKind` and `sessionReadout: Record<ReadoutKind, boolean>` and the `DEFAULT_SESSION_READOUT` constant exactly as data-model.md lists (every kind `true` except `current-time`); make `src/main/store/settings.ts`'s `SettingsStore.open` merge the default under any existing settings object that parses but lacks the key (data-model.md "Migration"); add `settings.setReadoutVisibility(kind, visible)` to `src/shared/ipc.ts`, `src/preload/index.ts`, and `src/main/ipc/settings.ts`, following `setApprovalMode`'s existing race-safety pattern (return this call's own written value) and pushing the existing `settings:changed` event, no new event (FR-012 to FR-014). (#232)
- [ ] T005 [P] Add `turnStartedAt: number | null` to `SessionRuntime` in `src/shared/model.ts`; in `src/main/omp/SessionAgent.ts` set it from the existing `agent_start` frame handling and clear it on `session_settled` or a stop, beside the status transitions already there (spec 001 data-model.md "State transitions") (depends on nothing beyond spec 001's existing frame handling; research.md item 8). (#238)
- [ ] T006 [P] Write `src/main/git/github.ts`: `pullRequestForBranch(repoPath, branch)` running `gh pr list --head <branch> --json number,url,state --repo <owner>/<repo>` (argument arrays, no shell, read-only), inferring `owner/repo` from the Repository's `origin` remote URL, returning `{ number, url } | null`; any `gh` failure (not installed, not signed in, offline, rate limited) returns `null`, never an error (FR-006, SC-007; research.md item 3). (#246)
- [ ] T007 Write `src/main/omp/readout.ts`: `assembleReadout(session, runtime)` building a `SessionReadout` (data-model.md) from `sessions.diffStat` (spec 001 T068, retaining the last non-null `changes` while the agent is not running), the context-usage field/request T001 resolved (retaining last non-null, `'not-available'` only when a reading was expected and never arrived), `turnStartedAt` (T005), the PR lookup (T006, polled on a timer and after each settle, retaining last non-null), the current turn's subagent running/finished count (not failed, per FR-007's own wording, research.md item 9) from T008's tracking structure, and the todo-progress source T002 resolved; call it after every state change that could move a readout and push `readout:update` coalesced to at most one per 50 ms per Session, matching `transcript:patch`'s discipline; include the initial `readout` in `SessionSnapshot` (`src/main/ipc/sessions.ts`, `src/shared/ipc.ts`) returned by `sessions.open`/`recover`/`conversations.startNew`/`conversations.open` per FR-002 to FR-008, FR-021 (depends on T004, T005, T006, T008). (#252)
- [ ] T008 Add subagent tracking to `src/main/omp/SessionAgent.ts`: on a `task` tool call, create one `SubagentSummary` (`src/shared/model.ts`) per subagent named in its `tasks` array using the id/name scheme T003 resolved, `status: 'running'`; update to `finished`/`failed` with `durationMs` when that subagent's portion of the call ends; build and keep a `TranscriptItem[]` stream per subagent id from the frames T003 resolved, the same way the main transcript is built (`src/main/omp/transcript.ts`); clear all of a Session's subagents when its next turn starts (`agent_start`). Add `chat.setVisibleSubagent(sessionId, subagentId | null)` and `chat.subagentSnapshot(sessionId, subagentId)` (error `not-found` for an unknown id) to `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/ipc/chat.ts`; push `subagents:update` (`{ sessionId, subagents }`, whole-array replace) whenever the list changes, and `subagent:patch` (`{ sessionId, subagentId, ops }`, reusing `TranscriptOp`) only for whichever subagent the Session's last `chat.setVisibleSubagent` named per FR-007, FR-017, FR-018 (depends on T003). (#260)
- [ ] T009 [P] Write `src/renderer/state/view-store.ts`: the unified four-way shape agreed with specs 003 and 008 during planning (data-model.md "view-store.ts") — `view: 'chat' | 'pull-requests' | 'settings' | 'manage-sessions'`, `repositoryId: string | null`, `settingsSection: SettingsSectionId | null`, and all four actions; implement `openChat`/`openSettings` fully (set `view` and `settingsSection`/`repositoryId` as given, defaulting `settingsSection` to the one section this spec builds when called with no argument or an unknown one); leave `openPullRequests`/`openManageSessions` as typed stubs that only set `view` (and `repositoryId` for the former), for specs 003/008 to build real behaviour on without re-touching this file's shape, supporting FR-011's entry point and FR-015's extensibility. (#265)

**Checkpoint**: `pnpm typecheck` and `pnpm build` pass; a scratch script can open a Session, read its `SessionSnapshot.readout`, start a turn, and observe `readout:update`/`subagents:update` events firing.

---

## Phase 3: User Story 1 - See a session's state at a glance (Priority: P1) 🎯 MVP

**Goal**: the chip row shows Changes, Context window usage, Turn time, Current time, Pull request, Subagents (count only — activation is Story 3), and Todo progress, each live, each hidden or "Not available" per its own rule, never conveyed by colour alone.

**Independent test**: [quickstart.md](quickstart.md) Story 1.

- [ ] T010 [US1] Write `src/renderer/features/chat/readout/ReadoutChip.tsx`: a shared chip baseline (icon slot, label, value text or children, optional `onActivate` making it a keyboard-operable button with an accessible name, otherwise a plain element readable as one phrase) and `src/renderer/state/readout-store.ts` subscribing to `readout:update`/`subagents:update` and seeding from `SessionSnapshot.readout` on open; append the chip row to `src/renderer/features/chat/MessageInput.tsx` directly after spec 001 task T098's `ApprovalModePill` (the row's existing first item; this task does not touch the pill), filtering which chips render by `useSettingsStore().sessionReadout`, and laying the row out to wrap onto a further line or scroll at any supported window width rather than ever hiding or overlapping the message box (FR-001, FR-009, FR-010). (#272)
- [ ] T011 [P] [US1] Write the Changes chip in `src/renderer/features/chat/readout/ReadoutChips.tsx`: reads `readout.changes` from T007/T010, shows "N files, +A -D" abbreviated with `Intl.NumberFormat` compact notation past 1000, and "Not available" for the `'not-available'` literal, matching the Session details card's figure (spec 001 FR-039) (FR-002). (#278)
- [ ] T012 [P] [US1] Add the Context window usage chip to `ReadoutChips.tsx`: reads `readout.contextUsage`, shows "N/M tokens (P%)", hidden when `null`, "Not available" for the `'not-available'` literal, and a visible warning (an icon plus the word "high", never colour alone) once `percent >= 90` (research.md item 5) (FR-003). (#284)
- [ ] T013 [P] [US1] Add the Turn time chip to `ReadoutChips.tsx`: reads `readout.turnTime`, hidden when `null`; while set, ticks the elapsed time once a second client-side from `startedAt` ("28s", "1m 14s"), matching spec 001 task T076's duration formatting (FR-004). (#289)
- [ ] T014 [P] [US1] Add the Current time chip to `ReadoutChips.tsx`: a pure client clock via `Intl.DateTimeFormat`, updating at the top of each minute, with no `aria-live` region (so the routine tick is never announced) and a static accessible name read only on focus; defaults hidden per `DEFAULT_SESSION_READOUT` (T004) (FR-005). (#295)
- [ ] T015 [P] [US1] Add the Pull request chip to `ReadoutChips.tsx`: reads `readout.pullRequest`, hidden when `null`; shows "#N"; activating it calls `shell.openExternal` (via a new allowlisted preload call, `shell.openPullRequest(url)`, or the existing external-link helper if spec 001 already exposes one) per research.md item 4, with an accessible name "Open pull request #N" (FR-006, SC-007). (#300)
- [ ] T016 [P] [US1] Add the Subagents chip to `ReadoutChips.tsx`: reads `readout-store`'s subagent list, shows the count of ones `running` or `finished` (excluding `failed`, research.md item 9), hidden when the turn has started none; render it as a non-interactive chip in this task (an accessible name stating the count as one phrase) — Story 3 (T022) makes it activatable (FR-007). (#306)
- [ ] T017 [P] [US1] Add the Todo progress chip to `ReadoutChips.tsx`: reads `readout.todoProgress`, shows "Todo N/M", hidden when `null`, with an accessible name "Todo: N of M tasks done" (FR-021). (#311)
- [ ] T018 [US1] Update the docs and verify live: `docs/DESIGN.md` Chat (the chip row's readouts, after the Approval mode pill), `data-model.md`, `contracts/ipc.md`; then on the built app in an isolated instance, run quickstart Story 1 end to end (changes count, a missing-worktree "Not available", a running turn's context usage and turn time, the current time chip after turning it on, an open pull request's chip and activation, a multi-subagent turn's count, a task list's progress, a narrow-window wrap, and full keyboard/screen-reader operability) per FR-001 to FR-010, FR-021. (#316)

**Checkpoint**: run quickstart Story 1. `pnpm typecheck` and `pnpm build` pass.

---

## Phase 4: User Story 2 - Choose which readouts show (Priority: P2)

**Goal**: a Settings screen with one "Session readout" section toggles each readout on or off, applied live to every open Session and persisted across restarts.

**Independent test**: [quickstart.md](quickstart.md) Story 2.

- [ ] T019 [US2] Write `src/renderer/features/settings/SettingsScreen.tsx`: a left-section-list layout (one section today, `SettingsSectionId = 'session-readout'`, reading `view-store`'s `settingsSection` to focus it, FR-015) with controls for all seven `ReadoutKind`s, each wired to `settings.setReadoutVisibility` (T004) and reflecting `useSettingsStore().sessionReadout`; wire `App.tsx` to read `view-store`'s `view` and render `SettingsScreen` in place of the SessionList+Chat `ResizablePanelGroup` when it is `'settings'` (same slot `showReadiness` already swaps on); add one temporary, plainly-labelled gear control (not styled as a profile item) calling `openSettings()`, solely so this spec's own quickstart can reach the screen until spec 008's profile-item cog supersedes it (research.md item 7) (FR-011 to FR-013, FR-015, FR-016). (#320)
- [ ] T020 [US2] Update the docs and verify live: `docs/DESIGN.md` Layout (the Settings screen, its entry point noted as temporary pending spec 008), `quickstart.md` Story 2; then on the built app in an isolated instance, run quickstart Story 2 end to end (defaults on open, a toggle reaching every open Session within about 1 s, the choice surviving a restart, full keyboard operability) per FR-011 to FR-016. (#326)

**Checkpoint**: run quickstart Story 2. `pnpm typecheck` and `pnpm build` pass.

---

## Phase 5: User Story 3 - Inspect subagents (Priority: P3)

**Goal**: activating the Subagents chip opens the right-side pane's first occupant: a closeable panel listing the turn's subagents with a selectable live stream.

**Independent test**: [quickstart.md](quickstart.md) Story 3.

- [ ] T021 [US3] Add the right-pane `ResizablePanel` to `src/renderer/App.tsx` (the region spec 001's layout comment already reserves), rendered only while the panel is open, hosting a new `src/renderer/features/subagents/SubagentPanel.tsx`: lists `readout-store`'s current subagents (name/task, state icon with the state word, never colour alone) from `subagents:update`; selecting one calls `chat.setVisibleSubagent` and `chat.subagentSnapshot` for the initial stream, then renders live `subagent:patch` updates through the existing transcript item renderers; a Close control calls `chat.setVisibleSubagent(sessionId, null)` and unmounts the panel, leaving the chat pane's size and scroll exactly as before (FR-017 to FR-020). (#330)
- [ ] T022 [US3] Make the Subagents chip (T016) activatable: add `onActivate` opening the panel (T021) via a small panel-open store or prop, with an accessible name "Open subagents panel (N running)"; a subagent finishing while its stream is the panel's open selection updates the panel in place without closing it (FR-020) (depends on T016, T021). (#335)
- [ ] T023 [US3] Update the docs and verify live: `docs/DESIGN.md` Layout (the right pane is no longer reserved-and-hidden; the Subagents panel is its first occupant) and Chat (the Subagents chip opens it); `quickstart.md` Story 3; then on the built app in an isolated instance, run quickstart Story 3 end to end (two subagents listed with their states, a live stream for the selected one updating within about 2 s, a finish updating state without closing, Close restoring the chat pane exactly) per FR-017 to FR-020, SC-006. (#338)

**Checkpoint**: run quickstart Story 3. `pnpm typecheck` and `pnpm build` pass.

---

## Phase 6: Polish and cross-cutting

- [ ] T024 [P] Accessibility pass across every surface this spec adds: the chip row (keyboard reach, focus indicators, accessible names, never colour alone — FR-010), the Settings screen (FR-016), and the Subagent panel (focus trap or return-focus-on-close, state conveyed by icon/text as well as colour — FR-017 to FR-020); fix any gap found rather than deferring it. (#342)
- [ ] T025 Update `CONTEXT.md` (add "Readout chip" and "Subagent panel" to the shared vocabulary if not already covered by the per-story docs tasks) and `docs/DESIGN.md` as needed; run all of [quickstart.md](quickstart.md) once, top to bottom, on the reference machine; `pnpm typecheck` and `pnpm build` pass; commit and push to `main`. (#345)

---

## Dependencies and execution order

- **Prerequisite (outside this spec)**: spec 001 tasks T098 and T068 MUST already be on `main`. This spec's Foundational and US1 phases assume both exist and do not rebuild either.
- **Setup (Phase 1)**: T001, T002, T003 are independent probes and can run together.
- **Foundational (Phase 2)**: needs Phase 1's resolved field/frame names. T004, T005, T006, T009 are independent files and can run together; T008 needs T003's resolved shape; T007 needs T004, T005, T006, and T008.
- **User stories** need Phase 2. US1 (T010 to T018) is the MVP and does not need US2 or US3. US2 (T019, T020) only needs Phase 2 (it reads and writes `Settings`, independent of the chip row's own rendering, though T019's screen is naturally built after T010 exists to verify live toggling). US3 (T021 to T023) needs T016 (the Subagents chip it makes activatable).
- **Polish** last.

`src/renderer/features/chat/readout/ReadoutChips.tsx` is edited by T011 to T017 — different chips, same file; do not run those seven in parallel against each other even though they are otherwise independent logic, to avoid merge churn in one file. `SessionAgent.ts` is edited by T005 and T008; do those in sequence too.

## Parallel examples

- Phase 1: T001, T002, T003 (three independent probe scripts).
- Phase 2: T004, T005, T006, T009 (four different files) once Phase 1's findings exist.
- US1: T011 to T017 are independent chips but share one file (`ReadoutChips.tsx`); land them as a small sequential group rather than a true parallel batch, each a short diff.

## Implementation strategy

1. **MVP**: Phases 1, 2, and 3 (Story 1). Stop and run quickstart Story 1; the chip row is now the useful, glanceable surface Stuart asked for, with its defaults.
2. Add Story 2 next: it is what makes the row configurable, the thing that turns a fixed default into what Stuart asked for ("Configurable from a settings page").
3. Add Story 3 last: the count alone already communicates that subagents are running; the panel is the deeper, lower-priority view.

## Notes

- The gates T001 to T003 change `contracts/omp-usage.md` and `research.md`'s Unknowns table if a
  probe finds OMP does not report something at all (for example, no context-usage source exists);
  record that outcome and adjust T012/T017 to the "always hidden, not 'Not available'" rule FR-003
  already allows for exactly this case.
- Commit after each task or small group; keep `main` building.
- FR and SC ids in task text refer to [spec.md](spec.md).
- GitHub issues: every task above has an issue titled `004-Tnnn: ...`, labelled with a type, one
  area, a priority matching the task's story (P1 for Setup/Foundational/US1/Polish, P2 for US2,
  P3 for US3), and `spec:004`. Areas: `settings` (T004, T019, T020 — the Settings data layer and
  screen), `chat` (T001, T002, T005, T007, T010 to T018, T024, T025 — the chip row and its live
  data), `right-pane` (T003, T008, T021 to T023 — the subagent panel and its live data),
  `pull-requests` (T006 — the GitHub lookup), `design` (T009 — the cross-view navigation
  mechanism). Issue numbers are recorded below once created.

### Task-to-issue mapping

| Task | Issue | Task | Issue | Task | Issue |
|---|---|---|---|---|---|
| T001 | [#211](https://github.com/stuarthopwood/refract/issues/211) | T010 | [#272](https://github.com/stuarthopwood/refract/issues/272) | T019 | [#320](https://github.com/stuarthopwood/refract/issues/320) |
| T002 | [#219](https://github.com/stuarthopwood/refract/issues/219) | T011 | [#278](https://github.com/stuarthopwood/refract/issues/278) | T020 | [#326](https://github.com/stuarthopwood/refract/issues/326) |
| T003 | [#225](https://github.com/stuarthopwood/refract/issues/225) | T012 | [#284](https://github.com/stuarthopwood/refract/issues/284) | T021 | [#330](https://github.com/stuarthopwood/refract/issues/330) |
| T004 | [#232](https://github.com/stuarthopwood/refract/issues/232) | T013 | [#289](https://github.com/stuarthopwood/refract/issues/289) | T022 | [#335](https://github.com/stuarthopwood/refract/issues/335) |
| T005 | [#238](https://github.com/stuarthopwood/refract/issues/238) | T014 | [#295](https://github.com/stuarthopwood/refract/issues/295) | T023 | [#338](https://github.com/stuarthopwood/refract/issues/338) |
| T006 | [#246](https://github.com/stuarthopwood/refract/issues/246) | T015 | [#300](https://github.com/stuarthopwood/refract/issues/300) | T024 | [#342](https://github.com/stuarthopwood/refract/issues/342) |
| T007 | [#252](https://github.com/stuarthopwood/refract/issues/252) | T016 | [#306](https://github.com/stuarthopwood/refract/issues/306) | T025 | [#345](https://github.com/stuarthopwood/refract/issues/345) |
| T008 | [#260](https://github.com/stuarthopwood/refract/issues/260) | T017 | [#311](https://github.com/stuarthopwood/refract/issues/311) | | |
| T009 | [#265](https://github.com/stuarthopwood/refract/issues/265) | T018 | [#316](https://github.com/stuarthopwood/refract/issues/316) | | |

Created with `/speckit.taskstoissues` (2026-10-02). Posted as a comment on tracking issue #103.
