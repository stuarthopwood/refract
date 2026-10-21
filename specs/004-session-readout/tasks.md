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

- [X] T001 [P] Gate: probe context-window usage in `docs/spike/context-usage-probe.mjs`: start a Session, run a turn of some size, call `get_state` and (if it exists) `get_session_stats`, and also run `/context` and capture its `command_output`; compare all three for a consistent tokens-used/window-size pair. Record the result as a new numbered FINDINGS item and the resolved field/request name in `contracts/omp-usage.md` section (a) per research.md item 1. (#211) -- Verified 2026-10-04 live against real signed-in omp 18.5.1: `get_state().contextUsage = { tokens, contextWindow, percent }` (percent computed by OMP itself), confirmed before and after a real turn; `get_session_stats` also exists and nests the same shape but is not needed. FINDINGS item 34; `contracts/omp-usage.md` section (a) resolved.
- [X] T002 [P] Gate: probe task-list ("todo") progress in `docs/spike/todo-progress-probe.mjs`: run a turn that creates and partially completes a task list, and inspect `get_state` and the `todo` tool's own call/result for a done/total shape. Record the result as a new numbered FINDINGS item and the resolved source in `contracts/omp-usage.md` section (b) per research.md item 2. (#219) -- Verified 2026-10-04 live: `get_state().todoPhases = [{ name, tasks: [{ content, status }] }]`, status values `completed`/`in_progress`/`pending` observed with a real partially-completed list. FINDINGS item 35; `contracts/omp-usage.md` section (b) resolved.
- [X] T003 [P] Gate: extend FINDINGS C6 and spec 001 task T071(d)'s probe (do not repeat it) for per-subagent live-stream data in `docs/spike/subagent-stream-probe.mjs`: start a turn with two or more subagents, subscribe with `set_subagent_subscription`, and check whether `tool_call_update` (or any other frame received while subagents run) carries a stable per-subagent id and enough text/tool-call content to build a selectable live stream, not just a status summary. Record the extension to FINDINGS C6 and the resolved shape in `contracts/omp-usage.md` section (c) per research.md item 3. (#225) -- Verified 2026-10-04 live with a real 2-subagent batch: the live frame is `tool_execution_update` (not `tool_call_update`), `partialResult.details.progress[]` keyed by each subagent's own `name` as a stable id, carrying `status`, `recentTools[]` (live growing tool-call stream), `recentOutput[]`, timing, and token/cost fields; `set_subagent_subscription` is real but unneeded (frames stream by default). FINDINGS item 36 (extends C6); `contracts/omp-usage.md` section (c) resolved.

**Checkpoint**: `contracts/omp-usage.md` has all three "Question"/"Probe" sections replaced with resolved field/frame names; FINDINGS.md has the two new numbered items plus the C6 extension.

---

## Phase 2: Foundational (blocks every user story)

**Purpose**: the shared types, settings, IPC plumbing, and tracking structures every story's chips or panel read from.

- [X] T004 [P] Extend `Settings` in `src/shared/model.ts` with `ReadoutKind` and `sessionReadout: Record<ReadoutKind, boolean>` and the `DEFAULT_SESSION_READOUT` constant exactly as data-model.md lists (every kind `true` except `current-time`); make `src/main/store/settings.ts`'s `SettingsStore.open` merge the default under any existing settings object that parses but lacks the key (data-model.md "Migration"); add `settings.setReadoutVisibility(kind, visible)` to `src/shared/ipc.ts`, `src/preload/index.ts`, and `src/main/ipc/settings.ts`, following `setApprovalMode`'s existing race-safety pattern (return this call's own written value) and pushing the existing `settings:changed` event, no new event (FR-012 to FR-014). (#232) -- Verified live in a scratch Electron instance: Settings screen shows all 7 toggles, defaults match `DEFAULT_SESSION_READOUT` (every kind on except Current time); toggling Current time on updated the open Session's chip row within under 1s with no reload; the choice survived a full app process restart (re-read from `settings.json`, confirmed via a fresh CDP connection after relaunch).
- [X] T005 [P] Add `turnStartedAt: number | null` to `SessionRuntime` in `src/shared/model.ts`; in `src/main/omp/SessionAgent.ts` set it from the existing `agent_start` frame handling and clear it on `session_settled` or a stop, beside the status transitions already there (spec 001 data-model.md "State transitions") (depends on nothing beyond spec 001's existing frame handling; research.md item 8). (#238) -- Verified live: Turn time chip appeared and ticked (15s -> 26s -> ...) while a real turn ran, then disappeared (hidden, `null`) the instant the session status reported `idle` again.
- [X] T006 [P] Write `src/main/git/github.ts`: `pullRequestForBranch(repoPath, branch)` running `gh pr list --head <branch> --json number,url,state --repo <owner>/<repo>` (argument arrays, no shell, read-only), inferring `owner/repo` from the Repository's `origin` remote URL, returning `{ number, url } | null`; any `gh` failure (not installed, not signed in, offline, rate limited) returns `null`, never an error (FR-006, SC-007; research.md item 3). (#246) -- Code-reviewed (byte-level CRLF/indentation check: clean, no corruption) and typechecked; the `unavailable`/`none`/`found` lookup correctly produced `unavailable` -> chip hidden against the scratch repo's remote-less origin, with no error toast (SC-007). Not live-tested against a real GitHub remote with an actual open PR -- no real remote was available in the time budget; this is a gap, noted under T018.
- [X] T007 Write `src/main/omp/readout.ts`: `assembleReadout(session, runtime)` building a `SessionReadout` (data-model.md) from `sessions.diffStat` (spec 001 T068, retaining the last non-null `changes` while the agent is not running), the context-usage field/request T001 resolved (retaining last non-null, `'not-available'` only when a reading was expected and never arrived), `turnStartedAt` (T005), the PR lookup (T006, polled on a timer and after each settle, retaining last non-null), the current turn's subagent running/finished count (not failed, per FR-007's own wording, research.md item 9) from T008's tracking structure, and the todo-progress source T002 resolved; call it after every state change that could move a readout and push `readout:update` coalesced. -- Live verification caught a real bug: `subagentCount` was gated on `state.turnStartedAt !== null`, so the Subagents chip vanished the instant a turn settled instead of persisting until the next turn clears `runtime.subagents` (per T008's own documented clearing rule and FR-007's "current turn's subagents" wording). Fixed in `readout.ts` (removed the `turnStartedAt` gate, now keyed only on `state.subagents.length > 0`) and re-verified live: after the fix, "2 subagents finished" correctly stayed visible through settle, only clearing on the next turn's `agent_start`.
- [X] T008 Add subagent tracking to `src/main/omp/SessionAgent.ts`: on a `task` tool call, create one `SubagentSummary` (`src/shared/model.ts`) per subagent named in its `tasks` array using the id/name scheme T003 resolved, `status: 'running'`; update to `finished`/`failed` with `durationMs` when that subagent's portion of the call ends; build and keep a `TranscriptItem[]` stream per subagent id from the frames T003 resolved, the same way the main transcript is built (`src/main/omp/transcript.ts`); clear all of a Session's subagents when its next turn starts (`agent_start`). Add `chat.setVisibleSubagent(sessionId, subagentId | null)` and `chat.subagentSnapshot(sessionId, subagentId)` (error `not-found` for an unknown id) to `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/ipc/chat.ts`. -- Verified live with two real omp-spawned subagents in one `task` call (not a simulation): both tracked running then finished with real durations, both listed in the Subagents panel with live state icons (see T021/T023 below for the panel itself); `src/main/omp/subagentStream.ts` (flagged earlier this session as possibly write-tool-corrupted) re-read byte-level: clean CRLF, 2-space indent, no corruption.
- [X] T009 [P] Write `src/renderer/state/view-store.ts`: the unified four-way shape agreed with specs 003 and 008 during planning (data-model.md "view-store.ts") -- `view: 'chat' | 'pull-requests' | 'settings' | 'manage-sessions'`, `repositoryId: string | null`, `settingsSection: SettingsSectionId | null`, and all four actions; implement `openChat`/`openSettings` fully (set `view` and `settingsSection`/`repositoryId` as given, defaulting `settingsSection` to the one section this spec builds when called with no argument or an unknown one); leave `openPullRequests`/`openManageSessions` as typed stubs that only set `view` (and `repositoryId` for the former), for specs 003/008 to build real behaviour on without re-touching this file's shape, supporting FR-011's entry point. -- Verified live: clicking the temporary Settings gear switches to the Settings screen and back to the chat/session-list view repeatedly, with the Subagents-panel mount-sync effect (App.tsx) confirmed to correctly re-run across that view switch after a related bug fix (see T021).

**Checkpoint**: `pnpm typecheck` and `pnpm build` pass; a scratch script can open a Session, read its `SessionSnapshot.readout`, start a turn, and observe `readout:update`/`subagents:update` events firing.

---

## Phase 3: User Story 1 - See a session's state at a glance (Priority: P1) 🎯 MVP

**Goal**: the chip row shows Changes, Context window usage, Turn time, Current time, Pull request, Subagents (count only — activation is Story 3), and Todo progress, each live, each hidden or "Not available" per its own rule, never conveyed by colour alone.

**Independent test**: [quickstart.md](quickstart.md) Story 1.

- [X] T010 [US1] Write `src/renderer/features/chat/readout/ReadoutChip.tsx`: a shared chip baseline (icon slot, label, value text or children, optional `onActivate` making it a keyboard-operable button with an accessible name, otherwise a plain element readable as one phrase) and `src/renderer/state/readout-store.ts` subscribing to `readout:update`/`subagents:update` and seeding from `SessionSnapshot.readout` on open; append the chip row to `src/renderer/features/chat/MessageInput.tsx` directly after spec 001 task T098's `ApprovalModePill`, filtering which chips render by `useSettingsStore().sessionReadout`. -- Verified live: real chip row renders after the Approval mode pill, chips appear/disappear per the settings filter.
- [X] T011 [P] [US1] Write the Changes chip in `src/renderer/features/chat/readout/ReadoutChips.tsx`: reads `readout.changes` from T007/T010, shows "N files, +A -D" abbreviated with `Intl.NumberFormat` compact notation past 1000, and "Not available" for the `'not-available'` literal, matching the Session details card's figure (spec 001 FR-039) (FR-002). (#278) -- Verified live: "0 files changed +0 -0" at rest, then "1 file changed +1 -0" after a real agent-approved `write` tool call created a file in the Session's worktree, updating live with no reload.
- [X] T012 [P] [US1] Add the Context window usage chip to `ReadoutChips.tsx`: reads `readout.contextUsage`, shows "N/M tokens (P%)", hidden when `null`, "Not available" for the `'not-available'` literal, and a visible warning (an icon plus the word "high", never colour alone) once `percent >= 90` (research.md item 5) (FR-003). (#284) -- Normal range verified live with a real Session ("N/1,000,000 tokens (P%)" tracking a real growing conversation). The >=90% warning branch was verified via the renderer's own documented verification hook (`window.__refractStores`, `src/renderer/state/index.ts`: "lets verification scripts inject store state through CDP... without a working main process") against a real open Session in a `electron-vite dev` instance, driving `readout.applyReadout` with `{percent: 95}`: rendered the triangle-alert icon plus the literal word "high" in `text-destructive`, confirming the icon+text (never colour-alone) rule. Reaching a real 900k/1M-token conversation live was outside the time budget; this one branch is code-plus-synthetic-verified, not live-organic-verified.
- [X] T013 [P] [US1] Add the Turn time chip to `ReadoutChips.tsx`: reads `readout.turnTime`, hidden when `null`; while set, ticks the elapsed time once a second client-side from `startedAt` ("28s", "1m 14s"), matching spec 001 task T076's duration formatting (FR-004). (#289) -- Verified live: chip read "15s" then "26s" ~5s later during a real running turn (ticking confirmed, not a single snapshot), then vanished the instant the turn settled.
- [X] T014 [P] [US1] Add the Current time chip to `ReadoutChips.tsx`: a pure client clock via `Intl.DateTimeFormat`, updating at the top of each minute, with no `aria-live` region (so the routine tick is never announced) and a static accessible name read only on focus; defaults hidden per `DEFAULT_SESSION_READOUT` (T004) (FR-005). (#295) -- Verified live: hidden by default; after toggling on in Settings, showed e.g. "14:53" and was still present and correctly reflecting wall-clock time after a full app restart.
- [X] T015 [P] [US1] Add the Pull request chip to `ReadoutChips.tsx`: reads `readout.pullRequest`, hidden when `null`; shows "#N"; activating it calls `shell.openExternal` (via a new allowlisted preload call, `shell.openPullRequest(url)`, or the existing external-link helper if spec 001 already exposes one) per research.md item 4, with an accessible name "Open pull request #N" (FR-006, SC-007). (#300) -- VERIFIED LIVE against a real open GitHub pull request, closing the one honest gap left after the original pass: created a throwaway private scratch repo (`stuarthopwood/refract-session-readout-t015-scratch`, never `stuarthopwood/refract` itself), registered it as a Refract Repository in a scratch Electron instance (`--user-data-dir`/`--remote-debugging-port=9444`, driven over CDP), created a Session on it (branch `bright-otter`, generated by `sessions.create`), pushed a real trivial commit on that exact branch, and opened a real PR against `main` with `gh pr create` (`#1`). Opening the Session live-assembled the chip to the real `{number: 1, url: ".../pull/1"}` via the real `pullRequestForBranch` → `gh pr list` lookup (confirmed via `sessions.open`'s own returned `readout`, not a mock), and the rendered chip read "#1" with `aria-label="Open pull request #1"` exactly. CDP-synthetic clicks on the chip's real `<a target="_blank">` were refused by Chromium as background input ("drops background mouse_click events"); retried with the `computer` tool's real OS-level click (`takeover: true`, found via the window's own AX tree after `win.find`/plain AX-click also hit the same refusal) -- this genuinely opened Firefox (the system's default browser), confirmed by its own new window title: "T015 scratch verification PR by stuarthopwood · Pull Request #1 · stuarthopwood/refract-session-readout-t015-scratch — Mozilla Firefox", screenshotted. The hidden/`unavailable` and clean-"no PR" paths were also re-confirmed live this pass (a second scratch Session, `clever-bison`, on a branch with a real GitHub remote but no PR: `pullRequest: null`, zero toasts). Scratch repo deleted afterward via `gh repo delete stuarthopwood/refract-session-readout-t015-scratch --yes` (created this pass, confirmed by name before deleting).
- [X] T016 [P] [US1] Add the Subagents chip to `ReadoutChips.tsx`: reads `readout-store`'s subagent list, shows the count of ones `running` or `finished` (excluding `failed`, research.md item 9), hidden when the turn has started none; render it as a non-interactive chip in this task (an accessible name stating the count as one phrase) — Story 3 (T022) makes it activatable (FR-007). (#306) -- Verified live with two real omp subagents in one `task` call: showed "2 subagents running" mid-call, "2 subagents finished" after both completed, correctly hidden before any turn started one. Live verification caught and fixed a real bug here (see T007's note): the count wrongly vanished on turn-settle before the fix.
- [X] T017 [P] [US1] Add the Todo progress chip to `ReadoutChips.tsx`: reads `readout.todoProgress`, shows "Todo N/M", hidden when `null`, with an accessible name "Todo: N of M tasks done" (FR-021). (#311) -- Verified live: a real agent turn using OMP's own todo tool showed "Todo 2/2", and a later turn showed "Todo 1/3" after partial completion; hidden on turns that created no todo list.
- [X] T018 [US1] Update the docs and verify live: `docs/DESIGN.md` Chat (the chip row's readouts, after the Approval mode pill), `data-model.md`, `contracts/ipc.md`; then on the built app in an isolated instance, run quickstart Story 1 end to end (changes count, a missing-worktree "Not available", a running turn's context usage and turn time, the current time chip after turning it on, an open pull request's chip and activation, a multi-subagent turn's count, a task list's progress, a narrow-window wrap, and full keyboard/screen-reader operability) per FR-001 to FR-010, FR-021. (#316) -- Verified live in a scratch Electron instance against a real signed-in omp 18.5.1 agent, across three rounds: changes count (zero and non-zero), context usage (normal range live, >=90% via the documented dev-mode store hook), turn time ticking and hiding, current time after enabling it, multi-subagent count, todo progress (round 2); a real GitHub PR chip and its real external-browser activation, a missing-worktree/no-remote "Not available"/hidden path, and a 480px-wide wrap with zero overlap against the message box, all live (T015/T025's final quickstart pass); full keyboard reach and real AX-tree accessible names on every chip (T024). `docs/DESIGN.md` Chat, `data-model.md`, and `contracts/ipc.md` were all updated (T025).

**Checkpoint**: run quickstart Story 1. `pnpm typecheck` and `pnpm build` pass.

---

## Phase 4: User Story 2 - Choose which readouts show (Priority: P2)

**Goal**: a Settings screen with one "Session readout" section toggles each readout on or off, applied live to every open Session and persisted across restarts.

**Independent test**: [quickstart.md](quickstart.md) Story 2.

- [X] T019 [US2] Write `src/renderer/features/settings/SettingsScreen.tsx`: a left-section-list layout (one section today, `SettingsSectionId = 'session-readout'`, reading `view-store`'s `settingsSection` to focus it, FR-015) with controls for all seven `ReadoutKind`s, each wired to `settings.setReadoutVisibility` (T004) and reflecting `useSettingsStore().sessionReadout`; wire `App.tsx` to read `view-store`'s `view` and render `SettingsScreen` in place of the SessionList+Chat `ResizablePanelGroup` when it is `'settings'`; add one temporary gear control calling `openSettings()`. -- Verified live: Settings screen reachable via the gear control, shows all 7 toggles, each wired toggle updates `useSettingsStore()` and persists.
- [X] T020 [US2] Update the docs and verify live: `docs/DESIGN.md` Layout (the Settings screen, its entry point noted as temporary pending spec 008), `quickstart.md` Story 2; then on the built app in an isolated instance, run quickstart Story 2 end to end (defaults on open, a toggle reaching every open Session within about 1 s, the choice surviving a restart, full keyboard operability) per FR-011 to FR-016. (#326) -- Verified live across two rounds: defaults on open (6 of 7 on), toggling Current Time on reached the open Session's chip row in well under 1s with no reload, and the choice survived a full app process kill+relaunch (round 2); full keyboard-only operability of the Settings screen, including focus landing on its own heading when entered and returning to the Settings entry button on "Back to chat" (T024 and the remediation round's focus-management fix). `docs/DESIGN.md` Layout was updated (T025); `quickstart.md` Story 2 was already present from this spec's original authoring and needed no further edit.

**Checkpoint**: run quickstart Story 2. `pnpm typecheck` and `pnpm build` pass.

---

## Phase 5: User Story 3 - Inspect subagents (Priority: P3)

**Goal**: activating the Subagents chip opens the right-side pane's first occupant: a closeable panel listing the turn's subagents with a selectable live stream.

**Independent test**: [quickstart.md](quickstart.md) Story 3.

- [X] T021 [US3] Add the right-pane `ResizablePanel` to `src/renderer/App.tsx`, hosting a new `src/renderer/features/subagents/SubagentPanel.tsx`: lists `readout-store`'s current subagents (name/task, state icon with the state word, never colour alone) from `subagents:update`; selecting one calls `chat.setVisibleSubagent` and `chat.subagentSnapshot` for the initial stream, then renders live `subagent:patch` updates; a Close control calls `chat.setVisibleSubagent(sessionId, null)` and leaves the chat pane's size and scroll exactly as before (FR-017 to FR-020). -- The flagged architectural risk was real and is now fixed: the panel's `ResizablePanel` is kept permanently mounted (collapsible, `collapsedSize={0}`, same pattern as `SessionList`'s own left-nav panel), synced open/closed via `handle.collapse()`/`handle.expand()` in a `useLayoutEffect` (never conditionally mounted/unmounted), instead of the original conditional-JSX approach that risked react-resizable-panels recomputing sibling widths on open/close. Live-verified with precise pixel measurements on a real two-subagent turn: chat pane was `{width:998, left:281, right:1279}` with `scrollTop:150` before opening the panel; `{width:678, left:281, right:959}` with the subagents panel at exactly 320px while open; and back to the EXACT SAME `{width:998, left:281, right:1279, scrollTop:150}` after Close -- pixel-for-pixel and scroll-for-scroll identical, confirming FR-020 genuinely holds, not just by eyeball. Fixing this also surfaced and fixed a second bug: the sync effect's dependency list (`[panelOpen]` only) never re-ran when the `ResizablePanelGroup` itself first mounted after the Readiness screen cleared, leaving the panel at its full `defaultSize` instead of collapsed on a fresh launch; fixed by adding `showReadiness`/`view` to the effect's dependencies, re-verified clean (panel measured at exactly 0px wide on a fresh app launch, before ever being opened).
- [X] T022 [US3] Make the Subagents chip (T016) activatable: add `onActivate` opening the panel (T021) via a small panel-open store or prop, with an accessible name "Open subagents panel (N running)"; a subagent finishing while its stream is the panel's open selection updates the panel in place without closing it (FR-020) (depends on T016, T021). -- Verified live: clicking the "2 subagents running"/"2 subagents finished" chip opened the panel listing both real subagents with live state icons (circle-check "Finished"); the panel stayed open and up to date as each subagent's `tool_execution_update` frames landed.
- [X] T023 [US3] Update the docs and verify live: `docs/DESIGN.md` Layout (the right pane is no longer reserved-and-hidden; the Subagents panel is its first occupant) and Chat (the Subagents chip opens it); `quickstart.md` Story 3; then on the built app in an isolated instance, run quickstart Story 3 end to end (two subagents listed with their states, a live stream for the selected one updating within about 2 s, a finish updating state without closing, Close restoring the chat pane exactly) per FR-017 to FR-020, SC-006. (#338) -- Verified live across three rounds: two real subagents listed with correct states, Close restoring the chat pane's pixel-exact size and scroll (round 2, T021's note); a selected RUNNING subagent's live stream updating within ~2.5s of new tool-call output, and a finish updating state in place without closing the panel (round 2's final quickstart pass); the panel staying closed/focus-correct across a new turn, a vanished Session, and a resize-handle drag (the remediation + final-remediation rounds). `docs/DESIGN.md` Layout and Chat were updated (T025); `quickstart.md` Story 3 was already present from this spec's original authoring and needed no further edit.

**Checkpoint**: run quickstart Story 3. `pnpm typecheck` and `pnpm build` pass.

---

## Phase 6: Polish and cross-cutting

- [X] T024 [P] Accessibility pass across every surface this spec adds: the chip row (keyboard reach, focus indicators, accessible names, never colour alone — FR-010), the Settings screen (FR-016), and the Subagent panel (focus trap or return-focus-on-close, state conveyed by icon/text as well as colour — FR-017 to FR-020); fix any gap found rather than deferring it. (#342) -- DONE, live against the real built app over CDP (a real Tab-key trace via `Input.dispatchKeyEvent`, real accessible names read from `Accessibility.getFullAXTree`, never just DOM attributes or visual inspection) plus real OS-level clicks where Chromium refused synthetic ones. **Chip row**: Tab reaches only the Pull request (`<a>`) and Subagents (`<button>`) chips, each showing a real `focus-visible` ring (`badgeVariants`' own `focus-visible:ring-[3px] ring-ring/50`, confirmed via each element's live computed `box-shadow`) and the exact accessible name FR-006/FR-017 specify; Changes/Context usage/Todo progress render as plain non-focusable `<span>`s (confirmed AX role `StaticText`, never in the Tab sequence), reading as one phrase; the Current time chip's real AX name is a static "Current time: HH:MM" with no `aria-live` ancestor (no routine-tick announcement, confirmed by ancestor-chain inspection); the Context usage ≥90% warning (already live-verified in T012) and every Subagent state icon pair a distinct icon shape with literal state text, never colour alone (screenshotted: green check "Finished", red X "Failed"). **Settings screen**: all 7 switches plus "Back to chat" are reachable by Tab with the same visible ring; each switch's real accessible name (queried via the Accessibility domain) is its title plus description, never empty; toggled two switches (Current time, Todo progress) with a real Space keypress each, both landing in `settings.json` through the real IPC path (`window.refract.settings.get()` re-read after), and Current time's chip appeared in the already-open Session live with no reopen. **Subagent panel**: found and fixed two real gaps instead of deferring them. (1) `SessionSnapshot` excluded `subagents` entirely, so `ChatPane.tsx`'s `applySnapshot` — re-run on every remount, including a Settings round-trip or a session switch away and back — reset the panel's own list to `[]` even while the chip's own `readout.subagentCount` kept correctly showing "2 subagents finished"; reproduced live (a real two-subagent turn, then Settings → Back to chat → reopen the panel → "No subagents this turn."), then fixed by adding `subagents: SubagentSummary[]` to `SessionSnapshot`/`buildSnapshot` (`src/shared/ipc.ts`, `src/main/ipc/util.ts`) and seeding `readout-store` from the real snapshot instead of a hardcoded empty array (`ChatPane.tsx`); re-verified live after a full app restart (new main+preload build): the same round-trip now correctly reopens to "alpha Finished"/"beta Finished". (2) Close left keyboard focus stranded on the panel's own Close button, which stays mounted but is clipped off-screen once the pane collapses to zero width (`getBoundingClientRect().x` past `window.innerWidth`) — a real "focus not returned anywhere visible" gap; fixed by having `closePanel()` (`src/renderer/state/subagent-store.ts`) focus the Subagents chip trigger (`button[aria-label^="Open subagents panel"]`, the same plain-DOM-query pattern as the existing `focusSessionsNav` fallback) before clearing its own state; re-verified live: `document.activeElement` after Close is now the on-screen, in-viewport Subagents chip. `contracts/ipc.md` updated for the `subagents` addition.
- [X] T025 Update `CONTEXT.md` (add "Readout chip" and "Subagent panel" to the shared vocabulary if not already covered by the per-story docs tasks) and `docs/DESIGN.md` as needed; run all of [quickstart.md](quickstart.md) once, top to bottom, on the reference machine; `pnpm typecheck` and `pnpm build` pass; commit and push to `main`. (#345) -- DONE for this branch (per the assignment, `session-readout-impl`, not `main`, which is out of scope for a branch-scoped pass). `docs/DESIGN.md` Layout gained the right region's real first occupant (the Subagent panel, replacing the "hidden until that spec ships" line), the full Session readout chip row (all 7 kinds, after the Approval mode pill), and the Settings screen's own layout; `CONTEXT.md` gained **Readout chip** and **Subagent panel**. Ran all of quickstart.md's Story 1/2/3 top to bottom in one continuous scratch Electron session (own `--user-data-dir`, a real throwaway GitHub repo+PR for T015, a real signed-in omp 18.5.1 agent): Story 1 — non-zero and "Not available" Changes (a session whose Base branch was deleted out from under it), a running turn's ticking Turn time and live Context usage, Current time ticking across real minutes and surviving a full process kill+relaunch, the real Pull request chip and external-browser activation (T015), a real two-and-then-one-subagent count, Todo progress, a 480px-wide viewport wrapping the row onto a second line with zero overlap with the message box (measured, not eyeballed), and full keyboard reach (T024); Story 2 — Settings' live sub-1s propagation to an already-open Session and survival across the same full restart, keyboard-only operability; Story 3 — the panel listing two real subagents, selecting a still-running one and watching its stream gain new rows within ~2.5 s, an in-place Running→Finished transition with the panel staying open, and Close restoring the chat pane. One real regression surfaced during this very pass (the Subagent-panel list-wipe bug, T024) was caught and fixed before it could ship, not merely noted. `pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text` (0 leaks) all re-run clean after every change this pass. Committed and pushed to `session-readout-impl`.

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

---

## Remediation round (2026-10-04)

A 4-reviewer quality gate (code-reviewer, security-auditor, test-reviewer, accessibility-auditor) ran against commit 707ed5c and found 1 Critical, 6 High (code/test), 3 High (a11y), 2 Medium (code), and one overclaimed note (T025). Security's own verdict was PASS with only Lows. All Critical/High items plus the two named Mediums were fixed on this branch; the false claim below is corrected rather than quietly rewritten. Live-verified in an isolated scratch Electron instance (`C:\tmp\refract-remediation-verify`: own `--user-data-dir`, own local-only scratch git repo with no GitHub remote -- the PR-lookup check only needs a call *count*, never a real discoverable PR, so no network/GitHub-account involvement was needed for any check here; driver script left on disk at `C:\tmp\refract-remediation-verify\driver.mjs` for re-run). `pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text` (0 leaks across 371 files) all pass after every fix below.

**T025 correction (false claim)**: T025's own note above claims "`CONTEXT.md` gained **Readout chip**... and **Subagent panel**..." -- that was false as written against 707ed5c (`git diff` showed `CONTEXT.md` untouched on this branch at gate time, per the test-reviewer's own finding). Rather than silently edit the historical note to hide the gap, it is corrected here: `CONTEXT.md` has now actually gained both terms (plus `_Avoid_` lines) in this remediation commit, under the existing "Language" section, matching T025's original intent; `specs/004-session-readout/data-model.md`'s `SubagentSummary` snippet was also updated for the new `toolCallId` field (see below).

### Critical -- fixed
- **Closed Subagents panel stayed in the Tab order / screen-reader browse mode** (a11y + test-reviewer, same root cause from two angles). `src/renderer/App.tsx`: the panel's content is now gated on `panelOpen && panelSessionId`, not just `panelSessionId` -- the `ResizablePanel` wrapper itself stays always-mounted (FR-020's pixel-exact sizing fix still holds). `src/renderer/state/subagent-store.ts`'s `closePanel()` also now clears `sessionId`. **Live evidence**: after Close, `document.querySelector('button[aria-label="Close subagents panel"]')` and every subagent row button are `null`/zero-length (not just hidden) -- `{"closeButtonStillInDom": false, "rowButtonCountStillInDom": 0}`; a real 15-stop `Input.dispatchKeyEvent` Tab trace from the message box afterward never landed inside a zero-width `[data-slot="resizable-panel"]` at any stop.

### High -- fixed
- **Panel could stay open across a new turn or a vanished Session** (test-reviewer sibling case). `src/renderer/state/readout-store.ts`'s `applySubagents` now detects the one transition that only ever means "a new turn started" (non-empty subagents -> `[]`, the sole thing `agent_start` does) and calls a new `subagent-store.ts` method, `resetForNewTurn`, which closes the panel (mirroring an explicit Close click, focus-restore included) if it was open for that Session, or just clears `selectedId`/`streams` otherwise. `src/renderer/features/chat/ChatPane.tsx` gained a second effect: if the visible Session disappears (archived/deleted) while the panel is open for it -- a path that never re-runs `applySnapshot` -- it closes the panel too. **Live evidence**: `"autoClosedOnNewTurn": true` -- sending turn 2 (reusing the subagent name "Echo") while the panel was open auto-closed it the instant the new turn started, with no Close click.
- **PR lookup (`gh pr list`) ran on every readout trigger**, not just the 60 s poll (code-reviewer). `src/main/git/github.ts`'s `pullRequestForBranch` call moved out of `src/main/omp/readout.ts`'s `assembleReadout` entirely into a new `SessionAgent.refreshPullRequest()`, run only from the `prPollTimer` tick, once at Session open, and a genuine `session.branch` change noticed in `computeReadout`; every other trigger (tool calls, turn start/end, get_state syncs) now reads a cached `cachedPullRequest` field instead. **Live evidence**: a temporary `console.error` counter (reverted before this commit; diff proof is simply its absence now) in `refreshPullRequest` fired exactly twice across a ~70 s run containing a real two-subagent-call turn generating many `tool_execution_update` frames, at timestamps exactly 60.00s apart -- matching `PR_POLL_INTERVAL_MS` precisely, never once per tool update.
- **Cross-turn subagent-stream leak** (code-reviewer): `selectedId`/the stream cache (renderer) and `visibleSubagentId`/`subagentPatches` (main, `SessionAgent.ts`) were never cleared on a new turn starting, only on explicit panel close. Fixed via the same `applySubagents` transition detection above (renderer) and an explicit `this.visibleSubagentId = null; this.subagentPatches.clear();` (new `PatchCoalescer.clear()` method) on the `agent_start` frame case (main). **Live evidence**: turn 1's "Echo" subagent (call 2) streamed "dlrow-olleh" (reversed "hello-world"); turn 2's "Echo" (same name, fresh turn) streamed "3" (vowels in "banana") with zero trace of turn 1's content -- `turn2Stream: {"streamText": "3Doneyield"}`.
- **Multi-task-call correlation bugs** (code-reviewer): `handleTaskEnd` used to mark every still-running subagent in the *whole turn* finished/failed regardless of which `task()` call ended, and `handleTaskUpdate`'s position-based fallback could map one call's progress onto another's subagent; a repeated name across two calls in one turn also collided via `findIndex`. Fixed: `SubagentSummary` (`src/shared/model.ts`) gained a `toolCallId` field, `id` is now `${toolCallId}:${name-or-fallback}` (globally unique, not just stable within a turn), and both `handleTaskUpdate`'s correlation and `handleTaskEnd`'s batch-completion in `SessionAgent.ts` are scoped to subagents whose `toolCallId` matches the frame being processed. **Live evidence**: a single turn with two sequential `task()` calls, both named "Echo", produced two genuinely distinct list rows (`["EchoFinished", "EchoFinished"]`, no duplicate-key collision) with correctly separated streams -- call 1 "9" (word count), call 2 "dlrow-olleh" (reversed string) -- never merged.
- **Subagents panel resize-handle drag desynced from the store** (code-reviewer): dragging the handle directly (always draggable, even "collapsed") never told `useSubagentPanelStore` anything, so a drag-to-shut left `open: true` with no way back in, and a drag-to-open showed an empty panel (`panelSessionId` still `null`). Fixed: `App.tsx`'s subagents `ResizablePanel` gained an `onResize` callback that calls `closePanel()`/`openPanel(visibleSessionId)` so the store always reflects the panel's real rendered size. **Live evidence**: a real `Input.dispatchMouseEvent` drag of the handle fully shut produced `{"contentUnmounted": true, "chipPresent": true}`; re-clicking the (still-present) chip afterward produced `{"ok": true}` and the panel genuinely reopened.
- **Focus dropped to `<body>` entering/leaving Settings** (a11y): `src/renderer/features/settings/SettingsScreen.tsx` now focuses its own `<h2>` heading (`tabIndex={-1}`, ref, focused in a mount effect) on entry, and "Back to chat" calls a new `src/renderer/lib/focus.ts` helper, `focusSettingsEntry()`, via `requestAnimationFrame` (the SessionList+ChatPane workspace remounts fresh on the same `view` flip, so there is no still-connected ref to reuse) which focuses the Settings entry button (now carrying an explicit `aria-label="Settings"` in `SessionList.tsx` for a stable query) or falls back to the message textarea. **Live evidence**: `focusOnSettingsEntry: {"tag": "H2", "text": "Session readout", "isHeading": true}`; `focusAfterBackToChat: {"tag": "BUTTON", "ariaLabel": "Settings"}`.
- **Current time / Todo progress chips unreadable to several real screen readers** (a11y): both put their only text in `aria-label` on a plain, role-less, non-focusable `<span>` with the visible text `aria-hidden` -- ARIA 1.2 does not allow naming a generic element this way, and several real screen readers (NVDA in browse mode, often Narrator/JAWS) read visible content rather than `aria-label` on a generic span, so the chip could read as nothing. Fixed in `src/renderer/features/chat/readout/ReadoutChips.tsx`: real, always-present text now lives in a visually-hidden `sr-only` sibling span (the same pattern `ToolRow.tsx`/`NoticeRow.tsx` already use), alongside the existing `aria-hidden` visual duplicate. **Live evidence**: `srOnlyCheck.todoSrText: "Todo: 3 of 3 tasks done"`; `currentTimeSrOnly: "Current time: 16:58"` -- both read directly out of the live DOM via CDP, not visual inspection.
- **Settings Off-state switch track (~1.5:1) and focus ring (~1.9:1)** (a11y): `src/renderer/components/ui/switch.tsx` gained `focus-visible:border-ring` (matching Button/Badge's own already-passing pattern) and, after one wrong first attempt (`dark:data-[state=unchecked]:bg-input/80`, which Tailwind composites as 80% of `--input`'s *already* 15%-alpha value -- 0.12 effective alpha, actually *lower* than the ~1.48:1 original, caught live via a real `getComputedStyle` read, not assumed), a corrected `dark:data-[state=unchecked]:bg-foreground/40` for the track plus a solid `dark:data-[state=unchecked]:bg-foreground` thumb. **Live evidence**: computed `trackBg: "oklab(0.985 0 0 / 0.4)"`, `thumbBg: "oklch(0.985 0 0)"` -- worked out via the OKLab->linear-sRGB->WCAG relative-luminance pipeline (docs/DESIGN.md's own "Chat text colour" note uses the same method) to ~3.66:1 track-vs-page and ~5.18:1 thumb-vs-track, both comfortably clearing the 3:1 minimum.

### Medium -- fixed
- **`reset()` in `subagent-store.ts` never told main to stop forwarding the selected subagent's live patches** the way `closePanel()` already did (code-reviewer). Fixed: `reset()` now calls `window.refract.chat.setVisibleSubagent(sessionId, null)` when a `sessionId` was set, same as `closePanel()`. Verified by code reading (not independently live-exercised; the behaviour it fixes -- a dangling IPC subscription with no listener -- has no visible symptom to screenshot).
- **A Settings round-trip reset the subagent panel even when the visible Session hadn't changed** (code-reviewer, partial fix + documented limitation). `ChatPane.tsx`'s `applySnapshot` now only calls `useSubagentPanelStore.getState().reset()` when the snapshot's `sessionId` differs from the panel's own tracked `sessionId` -- a Settings round-trip (or any other remount reapplying a snapshot for the same Session) no longer silently drops a panel the user deliberately opened. The *other* half of this finding -- a Settings round-trip still fully unmounts/remounts the whole `ResizablePanelGroup` workspace (losing session-list pane width/collapse state) because `App.tsx` swaps the entire main area on `view` rather than overlaying Settings -- was judged to need a larger structural change (rendering Settings as a sibling/overlay instead of a full replacement, or persisting the panel-group's own layout in state) than this remediation round's scope justifies; left as a known, documented limitation rather than a half-finished restructuring.

### Low -- fixed opportunistically (cheap, same file already being edited)
- `shutdown()` now clears `readoutTimer` too (previously only `prPollTimer`), in `SessionAgent.ts`.
- `TurnTimeChip` (`ReadoutChips.tsx`) now calls `setNow(Date.now())` at the start of its effect, before the first interval tick, so a new turn never briefly shows a stale elapsed time left over from the previous turn or mount.
- `runReadoutUpdate` (`SessionAgent.ts`) now has a `.catch` logging any `computeReadout` rejection instead of leaving it an unhandled promise rejection.

### Low -- intentionally skipped (would require editing files not otherwise touched this round)
- `gh` result fields not type-checked before being trusted, and `--head` not qualifying the fork owner (both `src/main/git/github.ts`, untouched this round).

### Not independently live-verified this round
Every item in the assignment's explicit live-check list was exercised (see each High entry above for its own evidence). The Medium `reset()` IPC-consistency fix and the documented Settings-round-trip limitation were judged code-correct but not independently screenshotted/CDP-driven, per this round's own evidence budget.


---

## Final remediation round (2026-10-04, second pass)

A confirmation pass over the remediation above found one more real High (a regression in the
High fix itself) plus three cheap Medium/Low items worth bundling in. One Low (position-matching
assuming OMP sends `progress[]` entries in spec order) was judged unlikely/lower-value and
skipped, per the pass's own assessment. Live-verified in a fresh isolated scratch Electron
instance (`electron-vite dev` with its own `--user-data-dir=C:/scratch/pinion-verify-userdata`,
CDP on an explicit `--remoteDebuggingPort`, driven via the existing dev-only
`window.__refractStores` hook -- no real repository/Session/OMP process needed since the bug and
its fix live entirely in renderer store logic); scratch userData dir left on disk as instructed.

### High -- fixed
- **Starting a new turn with the Subagents panel open stole focus from the message box**
  (confirmation pass): `applySubagents`'s own non-empty -> empty transition detection (added in
  the remediation round above) calls `resetForNewTurn`, which calls `closePanel()` -- but
  `closePanel()` unconditionally moved focus to the Subagents chip regardless of whether focus
  was actually inside the panel, and the chip is still mounted at that moment (the readout update
  that would eventually unmount it is debounced). A user who just sent the very message that
  starts the new turn had focus yanked out of the composer. Fixed in
  `src/renderer/state/subagent-store.ts`: `closePanel(options?: { restoreFocus?: boolean })` now
  only moves focus when `document.getElementById('subagent-panel')` (a new `id` on
  `SubagentPanel.tsx`'s root) actually contains `document.activeElement`, and every caller closing
  the panel for a reason other than the user clicking its own Close button --
  `resetForNewTurn`, `ChatPane.tsx`'s archive/vanished-Session effect, and `App.tsx`'s onResize
  drag-collapse handler -- now passes `restoreFocus: false` outright. **Live evidence**: with the
  panel open, a subagent running, and the message textarea genuinely focused
  (`{"focusedIsTextarea": true}`), calling the exact production trigger
  (`useReadoutStore.getState().applySubagents(sessionId, [])`) closed the panel
  (`{"panelOpenAfter": false}`) but left focus exactly where it was
  (`{"activeElementTag": "TEXTAREA", "activeElementAriaLabel": "Message", "textareaStillFocused": true}`).
  The explicit-Close-button path was spot-checked too, to confirm it still restores focus
  correctly when focus genuinely was inside the panel: focusing the panel's own Close button and
  clicking it produced `{"panelOpenAfter": false, "focusMovedToChip": true, "activeElementAriaLabel": "Open subagents panel (1 running)"}`.

### Medium -- fixed
- **Two subagents sharing a name within one `task()` call collided on `${toolCallId}:${name}`**
  (confirmation pass): not unique within a single batch, only across batches/turns -- two
  same-named (or two unnamed, same-task-text) specs ended up sharing one `subagentStreams` entry
  and one React key. Fixed in `SessionAgent.ts`'s `handleTaskStart`: counts each spec's base id's
  occurrences within the batch first and appends `:${occurrence}` to every duplicate (the same
  `${id}:${index}` fallback `contracts/omp-usage.md` already documents OMP's own `progress.id`
  using in the same circumstance); `handleTaskUpdate`'s existing id-match-then-position fallback
  needed no further change, since id-matching now naturally fails for a disambiguated slot and
  falls through to position, exactly as intended. **Spot-checked**: running the exact batch-build
  algorithm against two `Alpha`/`Alpha` specs, two unnamed specs with identical task text, and one
  `Beta` produced `{"ids": ["tc1:Alpha:0", "tc1:Alpha:1", "tc1:investigate the bug:0", "tc1:investigate the bug:1", "tc1:Beta"], "allUnique": true}`.
- **The 60s PR-poll timer and a branch-change-triggered lookup could race**: an older lookup
  (started for a branch the Session has since moved on from) resolving after a newer one already
  in flight for the real current branch could clobber `cachedPullRequest` with the wrong branch's
  PR, uncorrected until the next tick. Fixed in `SessionAgent.ts`'s `refreshPullRequest`: captures
  the branch it was called for locally, and after the `await` discards the result outright if
  `pullRequestBranch` (always the latest *requested* branch) no longer matches what this call
  requested -- a later call has already superseded it. **Spot-checked**: simulating an older
  branch-A lookup (slow) started before a newer branch-B lookup (fast) produced
  `{"olderResult": "discarded-stale", "newerResult": "applied", "finalCachedPullRequest": {"number": 2, "url": "https://x/B"}, "finalPullRequestBranch": "B"}`
  -- branch A's stale result never applied.

### Low -- fixed
- **`refreshPullRequest`'s own `scheduleReadoutUpdate` call could fire after `shutdown()`**,
  arming a brand-new timer post-shutdown and emitting a readout for a closed Session. Fixed:
  `refreshPullRequest` now returns early if `stopRequested` (the same flag `shutdown()` already
  sets, and `start()`/`restart()` already clear on a fresh run) is true, before scheduling
  anything. Verified by code reading (`stopRequested` is exclusively set by `shutdown()`, distinct
  from `stop()`, which only aborts the running turn).
- **Dragging the collapsed Subagents panel open with no visible Session** (`visibleSessionId`
  null) left it visually expanded while the store stayed `open: false` -- desynced again, the
  same root cause the existing `onResize` handler exists to prevent. Fixed: that branch now calls
  `subagentPanelRef.current?.collapse()` to force the real rendered panel back closed instead of
  leaving the mismatch. Verified by code reading (the same `onResize` handler's existing branches
  were already live-verified in the prior remediation round).

### Low -- intentionally skipped (per the assignment's own assessment)
- `handleTaskUpdate`'s position-based fallback assumes OMP sends `progress[]` entries in spec
  order; judged unlikely/lower-value, not worth the complexity this round.

`pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text` all pass clean (0 leaks) after this round.

## Phase 32: Durable turn marker for issue #489

**Goal**: replace `reconcileSubagentsOnAttach`'s transcript-position turn boundary (gate fixes
3's plain "last `kind:'user'` item" rule, which could not tell a steer mid-subagent apart from a
genuinely new turn) with a persisted registry marker, `Session.currentTurnSubagents`.

- [X] T128 Add `Session.currentTurnSubagents?: string[]` (`shared/model.ts`, data-model.md):
  `toolCallId:specIndex` keys for the current turn's subagents. `SessionAgent.handleTaskStart`
  persists the new keys the instant a `task` call starts (one `registry.updateSession` write per
  batch, fire-and-forget but durable -- `atomicJson.ts`'s per-file write queue serialises it
  against the `agent_start` clear). `onFrame`'s `agent_start` case clears it at the SAME trigger
  that clears `runtime.subagents`, skipped when already empty. `reconcileSubagentsOnAttach` and
  `transcript.ts`'s `settleStaleSubagentRows` both scope "the current turn" by membership in this
  persisted set instead of transcript position; `launch()`, `openConversation()`, and
  `switchRecovery.ts` thread it into `fromHistory`. (#489)
- [X] T129 Live-verify (a)-(f) against a real signed-in `omp` 18.8.0 agent on an isolated scratch
  CDP instance: steer mid-subagent (same-instance Recover AND a full app restart), an earlier
  turn's subagent never resurfacing after a later plain turn, a plain crash with no steer, two
  consecutive Recovers with no new turn, an old-format registry row loading fine, and a parallel
  batch seeding both a finished and a still-running subagent. See
  `contracts/omp-usage.md` section h for the full evidence. `pnpm typecheck`, `pnpm build`, and
  `pnpm check:ui-text` all clean. (#489)

**Verified 2026-10-07 (durable turn marker)**: all six scenarios driven live end to end via
`window.refract.*` IPC on a scratch Electron instance (own absolute `--user-data-dir` under the
OS temp dir, CDP port 9489, a real signed-in `omp` 18.8.0 agent). (a) session `bold-osprey`,
subagent `Worker` (`sleep 240`): queued+`sendNow`-steered while running (`currentTurnSubagents`
unchanged through the steer), hard-killed the real `omp.exe`, `sessions.recover()` settled it to
one `exited` row with the steer's own `user` item still positioned after it in the transcript;
then the whole scratch Electron tree was killed and relaunched against the SAME
`--user-data-dir` -- the registry's `currentTurnSubagents` survived and reopening the Session
reproduced the identical one-row `exited` result. (b) session `mellow-heron`: turn 1's finished
subagent did not resurface after a plain turn 2, crash, and Recover (`onSubagentsUpdate` read
`subagents: []`). (c) session `brisk-raven`: a plain crash mid-subagent settled to one `exited`
row, confirmed on the transcript row, the `onSubagentsUpdate` array, and the `onReadoutUpdate`
chip (`subagentCount:{running:0,finished:0,exited:1,failed:0}`). (d) two consecutive Recovers on
`brisk-raven` with no new turn left exactly one row, no spinning `running` row, and no duplicate
event. (e) `currentTurnSubagents` was deleted by hand from a registry row, the scratch app
restarted against the same `--user-data-dir`, and `sessions.list()` still returned the row with
no error. (f) session `gallant-walrus`, a parallel batch (`Fast`/`Slow`): `Fast` already `done`
and `Slow` still `running` at kill time both seeded correctly after Recover (`done`/`exited`).
Every `taskkill` targeted a pid read from the scratch instance's own `processes.json`, confirmed
via `Win32_Process` `ParentProcessId`/`CommandLine` against the scratch Electron main pid first;
the user's live pinion instance (separate `omp.exe` parent pid, `%APPDATA%\pinion`) was
untouched throughout, confirmed in the final process listing. Not separately re-driven live:
`openConversation()`'s own reconcile path and `switchRecovery.ts`'s own `fromHistory` call
(code-reviewed/typechecked only). `pnpm typecheck`, `pnpm build`, `pnpm check:ui-text` (0 leaks)
all clean.

**Verified 2026-10-07 (spec alignment)**: gate round found spec/docs still describing the OLD
transcript-position turn boundary as current behaviour after T128/T129 replaced it with the
durable registry marker. This pass: (1) added `**SUPERSEDED, durable turn marker**` pointers at
every stale "the last `user` transcript item" passage (spec.md Clarifications, three Edge Cases
passages, `contracts/omp-usage.md`'s "accepted, documented limitation" text, and
`data-model.md`'s state-transition row), keeping the original audit trail intact rather than
deleting it. (2) Corrected FR-007 and the #536 Clarification to the shipped wording (running
count while any running; otherwise a comma-joined list of whichever of
`finished`/`exited`/`failed` are non-zero, per `ReadoutChips.tsx`'s `SubagentsChip`), and matched
quickstart step 7. (3) Corrected the "persisted durably, before any crash can lose it" overclaim
in `specs/001-core-session-workspace/data-model.md` and `SessionAgent.ts`'s `handleTaskStart`
comment to the true queued/fire-and-forget write, its millisecond landing time, and its one real
loss window (the Electron main process dying between the task frame and the atomic rename, or a
logged write failure) with the resulting degrade-to-pre-marker behaviour. (4) Disclosed in
`contracts/omp-usage.md` section h that the consumed-`followUp` claim was inferred, not
exercised live; that scenario (e) only proves an already-empty key set loads fine, not the
pre-#489-crash upgrade case; and that the marker is not Conversation-scoped (different
`toolCallId`s simply never match); added quickstart step 7c (steer-then-crash-then-reopen). (5)
Hardened every `Session.currentTurnSubagents` read site (`SessionAgent.ts` launch/
openConversation/handleTaskStart/reconcileSubagentsOnAttach/agent_start-clear, and
`switchRecovery.ts`) through a new `currentTurnKeys()` helper (`transcript.ts`) that filters to
`string[]`, so a hand-edited or malformed registry field (number, object, bare string) can no
longer throw or silently iterate per-character instead of being treated as absent. `pnpm
typecheck`, `pnpm build`, `pnpm check:ui-text` all clean after this pass.


## Phase 33: Convergence

- [X] T126 [US3] Fix the Subagents panel's wrap and padding at the shared cause (issue #492):
  Radix `ScrollArea`'s own `Viewport` wraps `children` in an internal
  `<div style={{ minWidth: '100%', display: 'table' }}>` (measuring natural content width for
  its scrollbar math), which forces that div to its widest row instead of the viewport's own
  width -- long tool-call targets and paragraphs never wrap, the panel grows sideways, and the
  overflow clips. `src/renderer/components/ui/scroll-area.tsx`'s `Viewport` gets
  `[&>div]:block! [&>div]:min-w-0!` so every `ScrollArea` consumer (this panel's stream,
  `SessionList.tsx`'s repository list) inherits the fix instead of each panel re-fighting
  Radix's internal markup; `CollapsedLine.tsx` gains an opt-in `summaryWrap` prop (chat's own
  rows stay one-line/truncated; the narrower Subagents panel wraps instead), threaded through
  `ToolGroupRow`/`ToolCallRow` (`ToolRow.tsx`) so the panel's tool rows wrap.
  `SubagentPanel.tsx`'s stream container and its subagent-list `<ul>` both move from `p-2` to
  `px-3 py-2`, matching the header's existing `px-3`, so no container's padding differs from the
  header's (FR-022, edge cases). (#492)
- [X] T127 [US3] Update the docs and verify live: `specs/004-session-readout/spec.md`
  (Clarifications, User Story 3's acceptance scenario 5, two Edge Cases, FR-022) and
  `docs/DESIGN.md` ("Subagent panel" entry); then on a scratch `electron-vite dev` instance with
  CDP attached (no real repository/OMP agent needed -- the bug and its fix live entirely in
  shared renderer components, the same route spec 004's T012/T014 and spec 010's T002 already
  used), seeded through the dev-only `window.__refractStores` hook with three fake subagents
  (running/finished/failed) and a stream holding a long file path, a 120-character unbroken
  token, and a long paragraph: at the Subagents panel's own real minimum and maximum widths
  (240px and 520px, `App.tsx`'s `minSize={240}`/`maxSize={520}`, confirmed by dragging the
  separator past each limit and reading the panel's own `getBoundingClientRect()`), every row
  wrapped within the panel with no horizontal scrollbar and no panel growth, the
  header/list/stream container padding was visually even,
  and a keyboard-focused tool row's focus ring (`outline: 2px solid`, `outline-offset: 2px`,
  confirmed via `getComputedStyle`) rendered fully inside the panel's own padding, not clipped by
  the panel's `overflow-hidden` wrapper. `pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text`
  (0 leaks across 371 files) all clean.

**Verified 2026-10-07**: T126 built on `fix/492-agents-panel-wrap`
(`9dccb56` plus a same-branch follow-up aligning the subagent list's own padding, which the
original commit had left at `p-2` while only the stream container moved to `px-3 py-2`).
`pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text` (0 leaks across 371 files) all clean.
Live-verified in an isolated scratch `electron-vite dev` instance (own
`--user-data-dir=C:/tmp/refract-492-verify/userdata`, CDP on `--remoteDebuggingPort 9492`,
confirmed by its own main pid's `CommandLine` pointing at this worktree and that scratch
user-data-dir, distinct from Stuart's live `C:\Repos\personal\pinion` instance) -- no real
repository or OMP agent was driven; a fake repository and three fake `SubagentSummary` rows
(running/finished/failed) were seeded via `window.__refractStores.repositories`/`readout`, and a
fake stream (a long nested file path, a `bash` call echoing a 120-character unbroken token, and
a long paragraph ending in that same token) via `window.__refractStores.subagentPanel`, then the
panel was opened the same way the real Subagents chip does
(`subagentPanel.getState().openPanel(sessionId)`). OS-level window screenshots proved unreliable
for this background/unfocused scratch window (stale/cached frames that did not reflect a live
resize); `Page.captureScreenshot` with `fromSurface: true` over the same CDP connection gave an
accurate frame every time and is what every screenshot below came from. Dragged the real
"Resize subagents panel" separator (a trusted `Input.dispatchMouseEvent` drag, not a prop
change) to measure the panel's own column at 319px and at 484px: at both widths the long path
wrapped across several lines, the 120-character token wrapped mid-token (`break-words`) instead
of forcing a horizontal scrollbar, the paragraph wrapped normally, and the header/list/stream
containers shared the same padding -- confirmed by comparing `getBoundingClientRect()` on the
header's, a list row's, and the stream's own padded container against the panel's edges (not the
text itself, which in a list row sits further in behind the row's own `px-2` button, icon, and
`gap-2`).
Tabbed (real `Input.dispatchKeyEvent` Tab, not `.focus()`) to the `read` tool row's
`CollapsedLine` trigger at the 319px width: `getComputedStyle` confirmed
`outline: 2px solid`/`outline-offset: 2px`/`matches(':focus-visible') === true`, and the
captured screenshot showed the ring drawn completely inside the panel's own `px-3` padding, not
touching or clipped by the panel's `overflow-hidden` outer wrapper. Clicking the panel's own
**Close** button (`aria-label="Close subagents panel"`) unmounted the panel content
(`subagentPanel.getState().open === false`, `#subagent-panel` absent from the DOM) per FR-019.
Not independently driven this round: a real OMP agent actually producing a long tool call or a
120-character token live (the stream rendering path itself -- `groupToolItems`, `ToolGroupRow`,
`Markdown` -- is unchanged by this fix and already covered by T016/T018's own live verification);
the subagent list row names were only ever short strings in this round's fake data, so their own
`truncate` (unchanged, out of FR-022's scope -- the issue and FR-022 both target the panel's
*stream*, not the list's name/task column) was not re-exercised narrow. The scratch Electron
instance (main pid confirmed via `CommandLine` before kill) was closed with a targeted
`taskkill /PID` (no `/IM`, no force) and its scratch `userdata`/log directory removed afterward
from a `cwd` outside both the scratch parent and this worktree.

**Verified 2026-10-07 (gate fixes)**: a follow-up pass on the same branch, fixing the
quality-gate findings the review above raised. Code changes: `scroll-area.tsx`'s Viewport
className moved from the legacy `!` prefix (`[&>div]:!block [&>div]:!min-w-0`) to Tailwind v4's
suffix form (`[&>div]:block! [&>div]:min-w-0!`, matching `badge.tsx`'s existing `[&>svg]:size-3!`
precedent); its focus ring changed from `focus-visible:ring-[3px]` to
`focus-visible:ring-[3px] focus-visible:ring-inset`, since the un-inset ring drew 3px *outside*
the Viewport and was clipped by `#subagent-panel`'s `overflow-hidden` whenever the Viewport
itself (not a nested row) held keyboard focus; and the block comment was shortened to state the
mechanism once instead of naming and re-asserting "verified" for a fixed, hard-coded list of
consumers. Driving `SessionList.tsx` live with 15 fake repositories (45 sessions, one
repository name and one session name/branch per repository deliberately overlong) surfaced a
real bug the original pass never exercised: `RepositoryGroup`'s `CollapsibleTrigger` was
`flex flex-1` with no `min-w-0`, so its `truncate` span never engaged and the repository header
text pushed the list's own `ScrollArea` viewport to `scrollWidth: 955` against a
`clientWidth: 280` (a real horizontal scrollbar, visible in a captured screenshot); added
`min-w-0` alongside the existing `flex-1` fixes it (`scrollWidth`/`clientWidth` both 280
afterward), and both repository-name and session-name/branch truncation now read as ellipsised
text with the sidebar's vertical scroll still working (`scrollHeight: 2944` vs
`clientHeight: 587`). The Subagents panel's real minimum and maximum width (`App.tsx`'s
`minSize={240}`/`maxSize={520}`, pixels) were driven directly this time by dragging the real
separator past each limit and reading `#subagent-panel`'s own `getBoundingClientRect().width`:
it clamped at exactly `240` and exactly `520` (the earlier pass's 319px/484px were valid widths
but not the panel's actual bounds, and T127's own "inside the 320-480px range" sentence above is
corrected to cite these real numbers); at both bounds the seeded long path, 120-character token
and paragraph wrapped with `scrollWidth === clientWidth` on the stream's `ScrollArea` viewport
(no horizontal scrollbar, no panel growth) and even header/list/stream padding, confirmed in
captured screenshots. Previously-undriven FR-022 claims were also exercised: a fenced code
block and a GFM table inside the stream each scroll horizontally inside their own box
(`pre.scrollWidth: 1538` vs `clientWidth: 294`; the table's wrapper `overflowX: auto` with
`scrollWidth: 850` vs `clientWidth: 294`) while the panel's own outer viewport stayed at
`scrollWidth === clientWidth === 320`, not wider; and 40 seeded stream items forced real
vertical scroll in the stream (`scrollHeight: 2148` vs `clientHeight: 529`) with no horizontal
growth. The inset focus ring was confirmed on a text-only stream long enough to make the
Viewport itself keyboard-focusable (the installed Radix build sets no `tabIndex` on the
Viewport; it is keyboard-focusable via Chromium's own keyboard-focusable-scroller behavior once
its content overflows): tabbing to it with real `Input.dispatchKeyEvent` events (not `.focus()`,
which Chromium does not treat as `:focus-visible`) produced a computed `boxShadow` ending
`0px 0px 0px 3px inset` -- inset by construction, so it cannot be clipped by the panel's
`overflow-hidden` wrapper regardless of where the Viewport sits. `specs/004-session-readout/
spec.md`'s 2026-10-06 clarification answer is corrected: commit `d6a3e63` moved both the
subagent list's and the stream's padding to `px-3`/`py-2`, not only the stream as the answer
previously implied. `docs/PLAN.md` row A2e's files-touched column now lists `ToolRow.tsx`
alongside the files it already named. `pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text`
(0 leaks across 371 files) all clean after every change in this pass. Not independently driven
this round: a real OMP agent producing any of this content (still simulated through
`window.__refractStores`, the same route as the pass above); the Subagents panel's own fixed
per-subagent `<ul>` list is not itself wrapped in a `ScrollArea` (`shrink-0`, outside FR-022's
scope) so its own overflow behaviour with many subagents was not separately re-checked; and the
future Agents panel (#490) does not exist yet to verify inheriting this fix directly, only via
the shared `ScrollArea`/`CollapsedLine` components it will reuse. Driven in an isolated scratch
`electron-vite dev` instance (`--remoteDebuggingPort 9492`, a dedicated absolute
`--user-data-dir` under the OS temp directory, confirmed as this pass's own process by its main
pid's `CommandLine` naming both this worktree and that scratch directory before any teardown);
closed with a targeted `taskkill /PID <pid> /T /F` against that confirmed pid tree (not `/IM`),
and the scratch `--user-data-dir` removed afterward by its own literal absolute path from a
`cwd` outside both it and this worktree.

**Verified 2026-10-07 (gate fixes 2)**: a second gate-fix pass on the same branch. Code changes:
`SessionList.tsx`'s repository-name span and `SubagentPanel.tsx`'s subagent `nameOrTask` span
each gained a `title` attribute carrying the full (untruncated) text, since neither already used
the project's `Tooltip` component for this row. Live-verified in an isolated scratch
`electron-vite dev` instance (own `--remote-debugging-port=9492`, a dedicated absolute
`--user-data-dir` under the OS temp directory, confirmed as this pass's own process by its main
pid's `CommandLine` naming both this worktree and that scratch directory): seeded one
over-long repository name and session name via `window.__refractStores.repositories`/`sessions`,
and one over-long subagent `nameOrTask` via `window.__refractStores.readout`, then read each
truncating span's own `getAttribute('title')` from the live DOM -- both matched the full
untruncated string. Also re-drove T127's tool-row focus-ring claim at the Subagents panel's own
real minimum and maximum widths this time (240px and 520px, not the earlier passes' 319px/484px):
dragged the real "Resize subagents panel" separator (a trusted `Input.dispatchMouseEvent` drag)
until `#subagent-panel`'s own `getBoundingClientRect().width` read exactly `240` and, separately,
exactly `520`; at both widths, tabbed to the seeded `read` tool row's `CollapsedLine` trigger with
real `Input.dispatchKeyEvent` Tab events (not `.focus()`) and read `getComputedStyle` on the
resulting `document.activeElement`: `outline: 2px solid`, `outline-offset: 2px`,
`matches(':focus-visible') === true`, and the trigger's own `getBoundingClientRect()` stayed
fully inside the panel's edges at both widths (not touching or clipped by `overflow-hidden`). The
scratch Electron instance (main pid confirmed via `CommandLine` before kill) was closed with a
targeted `taskkill /PID <pid> /T /F` against that confirmed pid tree (not `/IM`), and its scratch
`--user-data-dir` removed afterward by its own literal absolute path from a `cwd` outside both the
scratch parent and this worktree. Doc changes: T126 now cites the suffix form
(`` `[&>div]:block! [&>div]:min-w-0!` ``) that actually shipped, not the legacy `!`-prefix form;
the first `Verified 2026-10-07` paragraph's Radix `tabIndex` explanation is corrected (the
installed Radix build sets no `tabIndex` on the Viewport -- it is keyboard-focusable via
Chromium's own keyboard-focusable-scroller behavior once its content overflows, not a Radix
`tabIndex=0`) and its header/list/stream "same horizontal inset" claim is reworded to "same
container padding" (the list row's own text sits further in, behind the row's own `px-2` button,
icon, and `gap-2`, roughly 30px more than the header's and stream's own container padding, so about 42px from the panel edge); and the
`gate fixes` paragraph's `CollapsedTrigger` typo is corrected to `CollapsibleTrigger` (the actual
component name). `docs/PLAN.md` row A2e's files-touched column now also lists `SessionList.tsx`.
`pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text` all clean after every change in this
pass. Not independently driven this round: a real OMP agent producing any of this content (still
simulated through `window.__refractStores`, the same route as every prior pass); hover-triggered
(mouse `:hover`) display of the `title` tooltip itself was not captured (the attribute's presence
and value were read directly from the DOM instead, which is what a screen reader/assistive
technology also exposes, independent of mouse hover).

## Phase 34: Convergence for issue #437

**Goal**: close the gap between the amended FR-002/FR-003 (2026-10-15 grill: one shared
lower-case `k`/`m`/`b` number formatter for the Changes Readout, the Context usage Readout, and
the Session details card's diff line, replacing the upper-case/variable-decimal
`Intl.NumberFormat(..., { notation: 'compact' })` helper `ReadoutChips.tsx` uses today only for
the Changes chip) and the code, which still shows the old format in both places and has no
shared module at all.

- [X] T130 [US1] Add `src/renderer/lib/compactNumber.ts`: one `compactNumber(n: number): string`
  export. Plain below 1,000; above it, abbreviate with lower-case `k`/`m`/`b` (English suffixes
  regardless of locale), at most one decimal, trailing zero dropped (`1m`, never `1.0m`), round
  half up; when rounding to one decimal would reach 1,000 of the current tier, carry into the
  next larger tier instead (999,950 -> `1m`, never `1000k`).
- [X] T131 [US1] `sessionDisplay.tsx`'s `formatDiffStat` uses `compactNumber` for `stat.files`,
  `stat.additions`, and `stat.deletions` (singular/plural "file"/"files" still keyed off the RAW
  `stat.files` value, unaffected by abbreviation). This is the Session details card's own figure
  (`SessionDetailsCard.tsx`), so it now abbreviates there too, matching the status line.
- [X] T132 [US1] `ReadoutChips.tsx`'s `ChangesChip` calls `formatDiffStat` unconditionally for the
  real-`DiffStat` case (the separate large-count branch and the local `compact()`/
  `COMPACT_NUMBER_FORMAT`/`COMPACT_THRESHOLD` helpers are removed entirely, now that
  `formatDiffStat` itself abbreviates).
- [X] T133 [US1] `ReadoutChips.tsx`'s `ContextUsageChip`: visible text becomes
  `"{compactNumber(used)}/{compactNumber(window)} ({percent}%)"` (drops the word "tokens"); the
  existing `NUMBER_FORMAT` constant is removed once nothing else in the file uses it. Both the
  normal and the high-usage state get a real `sr-only` span carrying the full phrase ("Context
  usage{ high|}: {used} of {window} tokens used, {percent} percent") next to the existing
  `aria-hidden` visual span, the same pattern `CurrentTimeChip`/`TodoProgressChip` already use;
  the chip's own `accessibleName` prop (passed to `ReadoutChip`'s role-less `<span>` fallback,
  which several real screen readers ignore `aria-label` on) is dropped for this chip.

**Verified 2026-10-15**: `compactNumber` checked in isolation against every decided example
before wiring it in -- `842`->`"842"`, `128000`->`"128k"`, `44842`->`"44.8k"`, `180000`->`"180k"`,
`200000`->`"200k"`, `1048576`->`"1m"`, `1500000000`->`"1.5b"`, `2000000000`->`"2b"`, and the
rounding-carry case `999950`->`"1m"` (never `"1000k"`), plus `0`/`1`/`999` staying plain and a
negative input keeping its sign -- all matched. `grep` confirms zero remaining references to
`COMPACT_NUMBER_FORMAT`/`COMPACT_THRESHOLD`/the old module-level `NUMBER_FORMAT` anywhere under
`src/renderer`. `pnpm typecheck` (`tsconfig.web.json`), `pnpm test` (148/148, unchanged -- no
existing test touched this code), `pnpm check:indent` (0 odd-indent), and `pnpm check:file-size`
(0 violations/311 files, the new module well under the cap) all pass. Live check (same isolated
scratch Tauri instance pattern as the #564 live checks in this PR): appended 1,050 lines to a
scratch Session's tracked file, forced a fresh `on_launch` via `sessions.recover` (no real model
turn needed), **7/7 checks pass** -- the status line's Changes Readout shows `1 file changed
\+1.1k -0` and, scoped strictly to the Session details card's own `[data-slot="hover-card-
content"]` container (its own on-demand diffStat, separate from the cached readout, so this
could not accidentally re-match the status line's span), the hover card shows the byte-identical
string once its own "Counting changes…" loading state resolves. Screenshots in the PR body. Not
independently driven: a real OMP agent reporting a context-window usage large enough to exercise
the `m`/`b` tiers (the scratch harness's fake model never reports usage at all, so the Context
usage chip stays hidden in every live check; `compactNumber`'s own tier logic is identical
regardless of which Readout calls it, and is exercised directly above).

## Phase 35: Convergence for gate round 5 (`agent://Arch877`)

**Goal**: two Medium findings from the fifth gate on PR #877 (#564's composer restyle), scoped
to this spec's own chips: the Subagents running state's emphasis was a no-op, and the Context
usage high-warning threshold disagreed with the displayed percent.

- [X] T131 [US1] `ReadoutChips.tsx`'s `SubagentsChip`: `className` changed from
  `running === 0 ? 'text-muted-foreground' : undefined` to `running > 0 ? 'text-foreground' :
  undefined` (FR-007 amended). `ReadoutChip.tsx`'s own base class already carries
  `text-muted-foreground`, so the old condition never actually differed from the chip's resting
  state in either branch -- flipped so the RUNNING state is the one with real visual weight.
- [X] T132 [US1] `ReadoutChips.tsx`'s `ContextUsageChip`: `high` now tests the rounded, DISPLAYED
  `percent` instead of the raw `contextUsage.percent` (FR-003 amended) -- a raw value of 89.5 to
  89.99 rounds to the shown "90%" but was previously still under the raw 90 threshold, so the
  warning silently disagreed with what the developer actually read.

**Verified 2026-10-15**: `pnpm typecheck`, `pnpm test` (148/148, unchanged -- neither chip has a
dedicated unit test, both are exercised live below), `pnpm check:indent`, and the full
`node scripts/ci-local.mjs` (all 16 steps, including `cargo test`/`clippy`/`fmt` and the Tauri
debug build) all pass. Live-checked on an isolated scratch Tauri instance alongside the rest of
this PR's gate round 5 work: the status line's own screenshots (see spec 001's tasks.md Phase 37
gate round 5 entry) show the Subagents chip's running state in the default foreground colour,
visibly distinct from the muted Readouts beside it. The Context usage high-threshold fix itself
was NOT independently live-exercised (same gap Phase 34 recorded: the scratch harness's fake
model never reports context-window usage at all, so this chip stays hidden in every live check
here) -- confirmed by direct inspection of the changed comparison instead (`percent` is computed
one line above `high` and used identically by both).

## Phase 36: Convergence (renumbered from Phase 34 during the #877/#437/#563 merge, 2026-10-15 --
origin/main already used Phase 34/35 for issue #437 and gate round 5)

- [X] T130 [US3] Rewrite the Subagent panel (`SubagentPanel.tsx`) as a keyboard-operable
  `role="tree"` (FR-024 to FR-026) in a vertical `ResizablePanelGroup` over the selected agent's
  live stream, the tree above the stream with a keyboard-operable `ResizableHandle` ("Resize
  agent tree and stream"). One level deep today (`buildSubagentTree`/`flattenSubagentTree`,
  honest about #712's not-yet-subscribed child-agent data -- no placeholder grandchild row): a
  roving tab stop, Up/Down/Home/End, single-character type-ahead, and Left/Right already wired
  for a child row that cannot exist yet (a one-line change once #712 lands, not a rewrite).
  Indentation is 16px per level, visually capped at 3 levels, with `aria-level` carrying the
  true depth regardless. The selected row is marked by the shared 2px `--active-indicator` bar
  (`SessionList.tsx`/`ManageSessionRow.tsx` precedent) instead of `bg-muted`; its status icon and
  word now come from the shared `subagentStatus.tsx` module (`SubagentStatusIcon`), replacing the
  panel's own now-superseded local `SubagentStateIcon`/`STATE_LABEL`; its duration uses the same
  `formatDuration` the chat transcript's own `SubagentRow` already imports from `toolStatus.tsx`,
  never a second formatter. Opening the panel pre-selected on an agent focuses that row once
  mounted (an effect keyed on the store's `selectedId`). (#563)
- [X] T131 [US3] Extend `subagent-store.ts`'s `openPanel`/`closePanel` and
  `hosted-panel-actions.ts`'s `openHostedPanel` with an additive
  `{ selectSubagentId?, opener? }` contract (FR-027, issue #563): a new `openerEl` field records
  whichever control opened the panel this time (replaced wholesale on every `openPanel` call,
  cleared back to `null` everywhere `sessionId` itself is cleared); closing the panel focuses
  `openerEl` first when it is still connected to the document, falling back to the Subagents
  chip only when it is not. `selectSubagentId` pre-selects an agent through the existing
  `selectSubagent` fetch/cache path (no duplicated fetch logic) -- the route the chat pane's new
  Stage/chain rows (a sibling slice, different files) use to open the panel already pointed at a
  specific agent. Every other field and method of both modules keeps its exact prior behaviour.
  (#563)

Built and verified both files above in isolation (the chat-side Stage/chain rows that actually
call `openPanel` with `selectSubagentId`/`opener` are a sibling slice, different files, landing
separately): `pnpm typecheck` (`tsc --noEmit` on both `tsconfig.node.json` and
`tsconfig.web.json`) clean; `pnpm check:drag-regions` (0 violations across 114 files),
`pnpm check:indent` (0 odd-indent lines), and `pnpm check:theme-contrast` (all 313 pairs PASS,
3 themes) all clean after these changes; `pnpm check:file-size` confirms both edited files stay
nowhere near the 600-line soft cap (`SubagentPanel.tsx` 252 lines, `subagent-store.ts` 271
lines) -- the pre-existing `src/shared/model.ts` one-line-over-baseline flag this script also
reports predates this pass (untouched by it) and is out of scope here. Not independently driven
this round: `pnpm build`/`pnpm check:ui-text` (both need a full Rust build, left for the single
combined verification pass after the sibling chat-side slice also lands, per this story's own
assignment, to avoid two agents racing a heavy build at once) and any live Electron/CDP exercise
of the new tree's keyboard behaviour or the opener-based focus return -- the latter's real
end-to-end trigger (a chat Stage/chain row's own "Show subagents panel" button) does not exist
until that sibling slice lands.

## Phase 37: Convergence

- [X] T132 [US1] #928 status line type (v0.3.0 feedback item 5, Decided, Skippy, delegated by
  Stuart 2026-10-16 -- grilled, resolved on the issue): `ReadoutChip.tsx`'s shared baseline moves
  from `text-xs`/`size-3` (12px/12px) to `text-readout`/`size-3.5` (13px/14px) at its three icon
  render sites and its one shared `baseClasses` string -- every status-line readout (`ReadoutChip`
  is used nowhere else today) picks this up automatically, read-only ones and interactive ones
  alike. `globals.css` gains `--text-readout: 13px` in the theme-independent `@theme { ... }`
  font-role block (generates the `text-readout` utility), the one new named type-scale step, not
  a bare `text-[13px]` arbitrary value.
- [X] T133 [US1] Update the docs: amended `specs/004-session-readout/spec.md`'s FR-023 and this
  `### Session 2026-10-16 (status line type)` Clarifications entry; `docs/design/foundations-
  typography-spacing.md` gains a new "Status line type" section documenting the 13px/14px step
  and the `--text-readout` token; `docs/PLAN.md`'s "v0.3.0 feedback" row gets an in-flight note
  (shipped together with #927, per its own "Suggested order" line).

This phase was written retroactively after the implementation above, in the same session that
built it (no prior `/speckit.plan`/`/speckit.tasks` pass covered issue #928; a no-build prep
lane, per `docs/PLAN.md`'s own working rules). `pnpm typecheck`, `pnpm vitest run` (148 tests)
and `node scripts/check-indent.mjs` (0 odd-indent lines) all ran clean after this change; this
ships in the same PR as #927 (`specs/001-core-session-workspace/tasks.md` Phase 50), which also
records the no-build-lane items (`pnpm build`/`pnpm check:ui-text`/the new CDP live check) left
for the build lane that picks the PR up.

## Phase 38: Convergence

- [X] T134 [US1] FR-028: `ReadoutChip.tsx` gains `pressed`/`controls` props (rendering real
  `aria-pressed`/`aria-controls` on the interactive `<button>`, never changing the plain-span or
  external-link branches); `ReadoutChips.tsx`'s `TodoProgressChip` becomes the pin-toggle control
  -- a fixed accessible name ("Pin todo list (Todo d/t)") computed from the shared derive,
  toggling a new per-Session, non-persisted `useTodoPinStore` (`pinnedBySession`), with a pin
  glyph (`PinIcon`) and a rendered border (`aria-pressed:border`) replacing the default
  `ListTodoIcon` while pinned -- never the hover/open-card background every other interactive
  readout keeps. (#700/#701)
- [X] T135 [US1] FR-029: a new `PinnedTodoPanel.tsx` (`src/renderer/features/chat/`), mounted in
  `ChatPane.tsx` directly above the message box, reading `SessionReadout.todoTree` and
  `useTodoPinStore`'s `pinned`/`collapsed` state. Header (`h-6`, the done/total figure plus the
  current task, truncated), a Collapse chevron (`aria-expanded`) and an Unpin button (both ghost
  icon buttons, fixed accessible names); the task list (`max-h-[min(12rem,30vh)]`, scrolling)
  grouped by phase (header shown only for 2+ phases, a finished phase folded to one line); each
  task shows a status icon/word (`CircleDotIcon`/working colour/`font-medium` for `in_progress`,
  `CheckCircle2Icon`/muted for `completed`, `CircleSlashIcon`/muted/strike-through for
  `abandoned`, `CircleAlertIcon`/amber plus a second "Blocked: <reason>" line for `blocked`,
  `pending` and `completed`'s own words screen-reader only). The list follows the current
  `in_progress` task, keeping it in view by setting the list's own `scrollTop` directly (never
  `scrollIntoView`, which can scroll an ancestor), latched off only by a real wheel/pointer/key
  event on the list itself, re-armed on mount, expand and re-pin. The panel unmounts entirely
  once `hasTodoPlan` is false (pin survives), and auto-collapses (the task list itself hides,
  not just the header text) once every open task completes, leaving the user free to expand it
  again afterward. (#700/#701)

  **Gate round 1 fixes (Main, consolidated five-reviewer findings on PR #1054):** the follow-
  current effect used to latch on its OWN `onScroll` (the very first follow permanently
  disabled every later one); `ChatPane.tsx` now renders this with `key={sessionId}` so latch/
  scroll state never leaks between Sessions. Unpinning, or the plan vanishing, used to strand
  focus on `<body>`; a `useLayoutEffect`-cleanup focus-intent (`isFocusStranded`, `@/lib/focus`,
  the `useFocusSearchOnStrandedUnmount.ts`/#900 precedent) now redirects it to the pill
  (`aria-controls`'s own target) or the composer. An unrecognised task status no longer crashes
  the render (renderer falls back to the `pending` glyph; `readout_todo.rs`'s own
  `parse_todo_phases` normalises an unknown/missing wire status to `"pending"` first). The panel
  is now a real `<section aria-label="Todo list">` region; the Collapse control has a FIXED
  name ("Todo list details") plus `aria-controls` to the list's own id (the permanently-pressed
  ghost-button fill from `aria-expanded:bg-muted` is overridden off for this one button); both
  Collapse and Unpin gained a Tooltip, `aria-describedby={undefined}`, and the forced-colours
  focus class (`COMPOSER_BUTTON_FOCUS_CLASS`). The scrolling list is a keyboard Tab stop
  (`tabIndex={0}`) only while it genuinely overflows. A folded phase header now shows a muted
  check icon; a completed task's own text recedes (muted); the header's current-task text
  carries a `title` attribute for when it truncates. `deriveCurrentTask` (`todoDerive.ts`) now
  returns `{phase, task}` (replacing this file's own duplicate `findCurrentTask`); `hasTodoPlan`
  is now a type guard, dropping every `as TodoPhase[]` cast.
- [X] T136 [US1] FR-030: `UpNextList.tsx` reads `useTodoPinStore`'s `pinned` flag for its own
  Session and hides (alongside its existing `isLastTurn`/`stagesCount`/empty-list guards) while
  pinned, so the plan never shows twice. (#700/#701; amends spec 001 FR-079)
- [X] T137 [US1] Shared pure derive: a new `src/shared/todo.ts` (`TodoTaskStatus`, `TodoTask`,
  `TodoPhase`, standalone so neither `model.ts` -- at its own 656-line baseline -- nor the
  renderer derive duplicate the wire shape) and a new
  `src/renderer/features/chat/readout/todoDerive.ts` (`hasTodoPlan`, `deriveTodoTotals`,
  `derivePhaseTotals`, `isPhaseFinished`, `deriveCurrentTask`, `isTodoAllDone`): `total` excludes
  `abandoned` tasks, `done` counts only `completed`, a `blocked` task counts as open -- the ONE
  place this math lives, ready for the Todo card (#700 slice (b)) and #526/#687 to import without
  a second copy. (#700/#701)
- [X] T138 [US1] Rust: `readout_todo.rs`'s `TodoTaskState` gains `content`/`blocker` alongside
  `status` (`parse_todo_phases` reads both); a new `build_todo_tree` serialises the retained tree
  to the wire shape. `readout.rs`'s `on_frame` now replaces the retained `todo_phases` tree from
  the `todo` tool's own `tool_execution_end` `result.details.phases` the instant one arrives
  (live, mid-turn), in addition to the existing `sync_from_state` resync at launch/Conversation
  switch/settle; `build_readout_value`/`empty_readout` drop the old server-computed
  `todoProgress: {done,total}` field entirely in favour of the raw `todoTree` (FR-028's shared
  derive is now the only place that math runs). `compute_up_next`/`todoPhases` (Up next) are
  unchanged. FINDINGS item 62 (`docs/spike/todo-tree-pin-probe-700.mjs`, live on `omp 18.12.2`)
  confirms the exact shape and status vocabulary before this task relied on either. (#700/#701)
- [X] T139 [US1] Docs: `specs/004-session-readout/spec.md` gains a 2026-10-19 Clarifications
  entry, FR-028 to FR-030, a 12th User Story 1 acceptance scenario, three Edge Cases, a Pinned
  todo panel Key Entity, and a deferred-to-slice-(b)/(c) Assumptions note; `data-model.md`'s
  `SessionReadout` replaces `todoProgress` with `todoTree`; `specs/001-core-session-workspace/
  spec.md`'s FR-079 gets a one-line amendment note for the new hide-while-pinned exception.
  `docs/PLAN.md`'s "Current work banner"/"Todo and agents cards, todo pin" row records slice (a)
  as shipped. (#700/#701)

Built against the issue's own decision record (Skippy, delegated by Stuart 2026-10-19, away
mode, `ui-architect-v3` ruling, full text on issue #700's latest comment), as a no-build lane
(Rust/TS code only, no spawned live agent beyond the one-shot `docs/spike/todo-tree-pin-probe-
700.mjs` FINDINGS probe): `pnpm typecheck` (both `tsconfig.node.json` and `tsconfig.web.json`)
clean; `pnpm test` (148 tests, 11 files) all passing; `pnpm check:indent` (0 odd-indent lines
across 415 files); `pnpm check:file-size` (0 cap violations -- `ChatPane.tsx` 1419/1445,
`ReadoutChips.tsx` 511/600, `model.ts` 656/656, `readout.rs` 584/600, all within their recorded
baselines or the 600-line soft cap); `pnpm check:theme-contrast` (all 829 pairs across 5 themes
PASS -- every status icon/word uses an EXISTING checked token, `text-state-working`/
`text-severity-warning`/`text-muted-foreground`, so no new `theme-contrast-pairs.mjs` entry was
needed); `cargo fmt --check` clean on both touched Rust files. Not independently driven this
round: `cargo check`/`clippy`/`test`, `pnpm build`, and the live CDP verify script
(`scripts/verify-700-todo-pin.mjs`) -- left for the build-slot pass (one heavy build at a time
across the concurrently-running lanes this session).

## Phase 39: Convergence

- [X] T140 [US1] FR-010/FR-031: `ReadoutChip.tsx` now forwards a ref and accepts
  `onPointerEnter`/`onPointerLeave`/`onFocus`/`onBlur`, spread onto whichever of its three render
  branches (button/anchor/span) is active -- the ref lets a Radix `PopoverAnchor asChild`
  composition measure the chip directly, which the component could not support before (noted as
  a known gap on `AdvisorChip`'s own comment, now closed). (#700)
- [X] T141 [US1] FR-031: a new `useReadoutCard.ts` (`features/chat/readout/`) -- the one shared
  hover/focus-open controller both cards below use: opens after a 400ms hover delay or on
  `:focus-visible`, stays open while the pointer is over the anchor OR the content ("hoverable",
  a 150ms grace window covers the travel between them), closes on Escape (a `window` keydown
  listener, since the content holds no focusable element of its own to attach a React handler
  to) or on losing both hover and focus, and accepts a `disabled` flag (the Todo card's own
  "never opens while pinned"). (#700)
- [X] T142 [US1] FR-031: the pinned panel's own row renderer (`TASK_STATUS_GLYPH`/
  `statusGlyph`/`currentTaskKeyOf`/`TodoPhaseGroup`/`TodoTaskRow`) is extracted out of
  `PinnedTodoPanel.tsx` into a new shared `TodoTree.tsx`, so the new `TodoCard.tsx` (the Todo
  hover/focus card's own content -- every phase expanded, no scroll-follow/collapse/Unpin, a
  plain capped scroll) renders the identical tree, never a second implementation of one task
  row. (#700)
- [X] T143 [US1] FR-032: a new `subagentDerive.ts` (`deriveSubagentPhrase`/
  `deriveSubagentSettledPhrase`) extracts `SubagentsChip`'s own running/settled counting wording
  so the new `AgentsCard.tsx` (one row per running agent -- its own `taskSummary` falling back to
  `nameOrTask`, plus a ticking elapsed time -- a quiet settled-counts line, and an "Open
  subagents panel" link reusing the chip's own `openHostedPanel` call) never counts a batch's
  subagents a second, different way. (#700)
- [X] T144 [US1] FR-031/FR-032: `ReadoutChips.tsx`'s `TodoProgressChip` and `SubagentsChip` each
  wrap their existing `ReadoutChip` in a controlled `Popover`/`PopoverAnchor asChild`/
  `PopoverContent side="top"`, wired to `useReadoutCard`'s own handlers and `TodoCard`/
  `AgentsCard` as the content; `onOpenAutoFocus`/`onCloseAutoFocus` are both suppressed (the
  content has nothing focusable, so focus must stay on the pill throughout); the Todo Popover's
  `useReadoutCard({ disabled: pinned })` keeps the card closed while pinned (decision item 1).
  (#700)
- [X] T145 [US1] FR-032: Rust -- `subagents.rs`'s `SummaryEntry` gains `task_summary: Option<
  String>`, computed by a new `subagent_task_summary` (first `.`/`!`/`?`-delimited sentence of
  the spec's own `task` text, inclusive, else the whole string, capped at 100 chars with `...`),
  set in `handle_task_start` alongside the existing `name_or_task`; `subagents_progress.rs`'s
  `summaries_to_value` serialises it as `taskSummary` when present (the same conditional-insert
  pattern `durationMs` already uses). `model.ts`'s `SubagentSummary` gains the matching
  `taskSummary?: string` field, added at net-zero line cost against the file's own 656-line
  baseline (a two-line doc comment reflowed to one elsewhere in the same interface). (#700)
- [X] T146 [US1] Docs: `specs/004-session-readout/spec.md` gains a 2026-10-21 Clarifications
  entry, FR-031/FR-032, a 13th User Story 1 acceptance scenario, three Edge Cases, two Key
  Entities (Todo card, Agents card), and an Assumptions update recording slice (b) as shipped
  (slice (c) still deferred); this Phase. (#700)

