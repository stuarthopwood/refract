# Feature Specification: Goal and Prewalk composer modes (#1865)

**Feature Branch**: `feat/goal-prewalk-modes-1865` (this spec lands on `spec/1865-goal-prewalk`)
**Created**: 2026-11-27
**Status**: Clarified (probes P1 and P2 pending; see Clarifications)
**Input**: GitHub issue #1865 (child of #479 and the composer epic #1136). Route: specify. Builds on [ADR 0014](../../docs/adr/0014-away-mode-answers-never-cancels.md) (Away answers, never cancels), [ADR 0015](../../docs/adr/0015-plan-mode-is-an-approval-policy.md) (config overlay precedent) and [spec 112](../112-composer-working-mode-menu-433/spec.md) (the working-mode `ModePill`).

## Clarifications

Citations are `file:line` as read in this worktree (`origin/main` at `1b82db2e`) or "#1865" for the issue comments. Items marked **INFERENCE** are not verified and are not product decisions; the lane that builds this either proves them (T001 to T003) or asks.

### Session 2026-11-27

- Q: Which modes does the picker offer? -> A: Decided (Stuart 2026-11-10, #1865; reaffirmed by Skippy, delegated by Stuart 2026-11-27): Goal and Prewalk only. The 2026-11-10 spike found `/vibe` and `/loop` unavailable over RPC (OMP issue can1357/oh-my-pi#18719 tracks it); they are filed separately and are out of scope.
- Q: Is this a new working mode? -> A: Decided (Skippy, delegated by Stuart 2026-11-27): no. Goal and Prewalk get their own picker, a second `ModePill` (`components/ModePill.tsx`) beside `WorkingModeMenu` (`features/chat/WorkingModeMenu.tsx`, mounted by `ComposerModePills.tsx:5-12`). They are not in `WORKING_MODES` (`shared/workingMode.ts:6`) and combine with Interactive, Grill and Away.
- Q: Where do Goal's prerequisites (`goal.enabled`, `goal.continuationModes: [rpc]`) come from? -> A: Decided (Skippy, delegated by Stuart 2026-11-27): a Refract config overlay passed as `--config`, like the plan overlay (`omp/plan_overlay.rs:44-64`, wired at `omp/process_args.rs:7-14,33-35`). Refract never edits the user's global OMP config.
- Q: Does a goal survive a Refract restart? -> A: Decided (Skippy, delegated by Stuart 2026-11-27): Refract persists nothing (no entry in `working-modes.json`, no new store file). OMP restores a paused goal; Refract reads it from `get_state.goal` and shows it paused until the user resumes it.
- Q: Goal in Plan mode? -> A: Decided (Skippy, delegated by Stuart 2026-11-27): the Goal item is disabled in Plan mode with a tooltip, because OMP refuses `goal create` in plan mode (#1865 spike, "Documented but not exercised").
- Q: Away Mode with a goal? -> A: Decided (Skippy, delegated by Stuart 2026-11-27): a goal's requests are answered through `session/working_mode/away.rs` unchanged (ADR 0014). `away.rs` is not edited; T022 proves a goal turn's ask and approval go through it and T025 checks the file's diff is empty.
- Q: What is proved before the build? -> A: Decided (Skippy, delegated by Stuart 2026-11-27): two probes first, as the first tasks. P1 (T001): an abort mid-turn pauses the goal, read from `get_state.goal.status`. P2 (T002): `/new` (`new_session`) does not carry a goal into the new Conversation. The spike saw neither (#1865: "I did not observe the documented 'abort pauses the goal' case"). T010 and T011 are gated on them.
- Q: What does the active state look like? -> A: Decided (Stuart 2026-11-10, #1865): a pill in the composer shows the active mode, for example "Goal: <objective>", with a button that exits the mode; the Session row shows a small mode badge.
- Q: How does Refract start, read and stop a goal? -> A: Verified in the 2026-11-10 spike (OMP 18.17.0, #1865): start `{type:"goal", op:"create", objective, token_budget?}`; read `get_state.goal` (`{enabled, mode, goal:{status, tokensUsed, tokenBudget, ...}}`) and `goal_updated` frames; stop `op:"drop"`; suspend and continue `op:"pause"` and `op:"resume"`. Failures arrive as `success:false` with text ("A goal is already active. Drop it before creating another.", "Goal mode is disabled (goal.enabled).", "No paused goal to resume."). No code in this tree handles `goal`, `goal_updated` or `get_state.goal` today (grepped `src` and `src-tauri/src`; the only "goal" hits are subagent orchestration goals).
- Q: How does Prewalk work? -> A: Verified in the spike and in this tree: it is a slash command (`/prewalk`, `/prewalk off`) with no `get_state` field; the only state is OMP's own replies, already parsed by `session/prewalk.rs:7-37` (`armed`, `off`, `unknown`), emitted as `PREWALK_UPDATE` (`events.rs:34,324-329`) and held in `state/prewalk-store.ts`. The Session menu already toggles it through `features/sessions/prewalkActions.ts:4-6` (#695). This feature reuses that path and adds no second source of truth.
- Q: Are Goal and Prewalk exclusive in the picker? -> A: **INFERENCE** (not decided): `ModePill` is single-choice (`ModePill.tsx:21-31`), and the spike never ran a goal and an armed prewalk together. The first build offers a single choice among None, Goal and Prewalk. Stuart can widen it to two independent controls once a probe shows they combine; that is not built here.
- Q: How does the user enter a Goal's objective? -> A: **INFERENCE** (not decided): choosing Goal opens a small dialog on the existing `components/ui/dialog.tsx` primitive with an objective field and an optional token budget (the RPC takes `token_budget?`). The issue does not say where the objective is typed.
- Q: Is the overlay applied to every launch? -> A: **INFERENCE**: yes, so a goal can start in a running Session without a restart. Unknown: whether `goal.enabled: true` adds the agent's `goal` tool to Sessions that never use Goal, and whether `--config` beats a user's own `goal.enabled: false` (#479 triage flags `overriddenBy`). T003 reads both from the probe run and decides; if the tool appears for everyone, the overlay becomes launch-conditional and picking Goal restarts the Session at idle, as Plan does (`working_mode/mod.rs:223-236`, `Applied::Restart`). The overlay is a separate file from the Settings-driven `omp/token_guard/overlay.rs`, which renders only user-set values; INFERENCE, to keep that file's contract.
- Q: What if a goal is active and the user switches to Plan? -> A: **INFERENCE**: Plan needs an OMP restart (`working_mode/mod.rs:223`), after which OMP shows a restored paused goal, and OMP refuses `resume` in plan mode. This spec does not invent a rule; the Goal item is disabled and the pill shows "Paused" with Resume disabled and the same tooltip. T003 records whether that matches what OMP does.
- Q: A failed overlay write? -> A: **INFERENCE**: unlike plan mode (whose overlay is a safety policy, so a failed write fails the launch, `process_args.rs:5-6`), Goal's overlay is a convenience; a failed write adds a launch warning (the `warnings` vector of `build_args`, `process_args.rs:16-41`) and the Goal item is disabled with the reason.
- Q: Is `/goal` a slash command? -> A: **INFERENCE**: the issue says slash commands offer Goal and Prewalk, but `/goal` is not an RPC slash command (the spike: dedicated command only). `/prewalk` already has subcommand completion (`shared/slash-commands.ts:11`, `session/agent/commands.rs:24`). A Refract-native `/goal <objective>` would be a new entry in `NATIVE_RESERVED_COMMANDS` (`shared/slash-commands.ts:34`, `session/agent/commands.rs:51`), handled in `ipc/chat.rs`, and would reach the same IPC as the picker. Priority P2 (User Story 4).
- Q: Away-mode grill 2026-11-28 (#1865): scope, how a Pre-walk failure is detected, and where Goal's prerequisites come from? -> A: Decided (away-mode grill, Skippy, Stuart away): (1) scope stays Goal and Pre-walk only; Vibe and Loop stay blocked on #2333 until OMP exposes them over RPC (can1357/oh-my-pi#18719 is the upstream issue). (2) A Pre-walk failure is detected by parsing the `command_output` text, because OMP returns `success: true` for an unknown model; `success` is never read as proof that Pre-walk armed. This amends FR-009: `session/prewalk.rs` `state_from_frame` today returns no state for a `command_output` that is neither "Prewalk on:" nor "Prewalk off:" (`prewalk.rs:17-23`), so a failed arm leaves the pill and Session menu silent. (3) Goal uses the Refract config overlay (`goal.enabled: true`, `goal.continuationModes: [rpc]`), as the spike found; this is FR-002 and settles the always-on part of the overlay inference above (T003 still decides only whether it must be launch-conditional).

## User Scenarios & Testing

### User Story 1 - Pick Goal and let the agent run to it (P1)

I open the second pill beside the working-mode pill, choose Goal, type an objective and confirm. The agent starts working toward it and keeps going turn after turn. The pill reads "Goal: <objective>", and I can pause, resume or exit it.

**Independent Test**: with a scripted OMP process, `goal.create` sends `{type:"goal", op:"create", ...}`; a `goal_updated` frame makes the pill read the objective and the status.

**Acceptance Scenarios**:
1. **Given** an idle Session in Interactive mode, **When** I confirm an objective, **Then** Refract sends one `goal create` and the pill shows "Goal: <objective>" from OMP's reply, not from my input (the label follows OMP, as prewalk does, #695).
2. **Given** an active goal, **When** I press Exit, **Then** Refract sends `op:"drop"` and the pill returns to None only after OMP's `get_state.goal` or `goal_updated` says so.
3. **Given** a paused goal (aborted, or restored after a restart), **When** I press Resume, **Then** Refract sends `op:"resume"`; on `success:false` the message appears as a notice and the pill is unchanged.
4. **Given** OMP replies `success:false` ("A goal is already active..."), **Then** the reply text is shown through `notify` and nothing else changes.

### User Story 2 - Goal is unavailable where OMP refuses it (P1)

**Acceptance Scenarios**:
1. **Given** Plan mode, **When** I open the picker, **Then** the Goal item is disabled and its tooltip says why; the item cannot be activated by keyboard or pointer.
2. **Given** a goal turn asks a question or needs approval while Away is on, **Then** `away.rs` answers or denies it exactly as for any turn (ADR 0014), with no goal-specific branch.
3. **Given** I stop the agent mid-turn (Stop), **Then** the pill shows what OMP reports (P1 decides whether that is Paused); Refract never guesses.

### User Story 3 - Prewalk from the same pill (P1)

**Acceptance Scenarios**:
1. **Given** prewalk is `off` or `unknown`, **When** I choose Prewalk, **Then** Refract sends `/prewalk` through the existing `setPrewalk` and the pill follows `usePrewalkStore`.
2. **Given** prewalk is `armed`, **When** I choose None, **Then** `/prewalk off` is sent.
3. **Given** the Session menu's prewalk toggle (#695), **When** it arms prewalk, **Then** this pill shows the same state: one store, no second copy.

### User Story 4 - Type `/goal` (P2)

**Acceptance Scenarios**:
1. **Given** the composer text `/goal Ship the migration`, **When** I send, **Then** it goes to the same IPC as the picker, not to the model as plain text.

### Edge Cases

- A goal completes on its own (the agent's `goal` tool, `op:"complete"`): `goal_updated` carries `status:"complete"`, then `get_state.goal` is `null`; the pill returns to None.
- A Session whose OMP process is not running: the pill reads the last known state and the actions are disabled until the process is up.
- A very long objective: the pill label clamps to one line; the full text is in the tooltip and the accessible name.
- `/new` (new Conversation): P2 decides whether a goal must be dropped; the pill always ends in the state `get_state.goal` reports.
- Prewalk is one-shot (it hands off to a cheaper model at the first edit), so after the switch the pill returns to None, from OMP's notice, not from a timer (#1865 "Prewalk details").

## Requirements

- **FR-001**: Two probes (P1 abort, P2 `/new`) are run against a real OMP process in an isolated scratch profile before any code task, and their results are recorded in this spec's Clarifications and on #1865.
- **FR-002**: A Refract-generated `goal-mode.yml` (`omp/goal_overlay.rs`, modelled on `omp/plan_overlay.rs`) sets `goal.enabled: true` and `goal.continuationModes: [rpc]` and is passed with `--config` from `omp/process_args.rs`. Refract calls no `omp config set` for these keys.
- **FR-003**: `ComposerModePills.tsx` renders a second `ModePill` (`GoalPrewalkMenu`) between `WorkingModeMenu` and `ApprovalModePill`; `shared/workingMode.ts` is unchanged.
- **FR-004**: The renderer API gains `goal.create(sessionId, objective, tokenBudget?)`, `goal.pause`, `goal.resume` and `goal.drop`, handled in `src-tauri/src/ipc/goal.rs`, each sending the matching `{type:"goal", op}` request through the Session's process and returning OMP's `success:false` text as an `IpcError`.
- **FR-005**: Goal state comes only from OMP: `get_state.goal` on launch, on `sync_from_state`, and on every `goal_updated` frame, emitted as a new `GOAL_UPDATE` event (`goal:update`, payload `{ sessionId, goal }` with `goal: null | { status, objective, tokensUsed, tokenBudget }`). Refract writes no goal state to disk.
- **FR-006**: While a goal exists the pill shows "Goal: <objective>" (clamped) and its status, with a pause or resume button and an exit button, each a real button with an accessible name.
- **FR-007**: The Goal item is disabled in Plan mode with a tooltip, in the renderer (`GoalPrewalkMenu`) and in the backend (`goal.create` and `goal.resume` refuse while the Session's working mode is Plan, returning the same text).
- **FR-008**: `ModePill` supports a disabled item with a tooltip; existing callers (`WorkingModeMenu`, `ApprovalModePill`) render and behave as before.
- **FR-009**: Prewalk uses the existing `setPrewalk`, `usePrewalkStore`, `PREWALK_UPDATE` and `session/prewalk.rs`; the pill reads `armed`, `off` and `unknown` and never assumes a state. Amended 2026-11-28 (#1865 away-mode grill): a `command_output` reply to `/prewalk` that is neither an armed nor an off reply is a failure, detected by parsing its text because OMP returns `success: true` for an unknown model; the failure text is shown through `notify`, the pill state stays what OMP last reported (never "armed"), and `success` is not used to decide the outcome.
- **FR-010**: `session/working_mode/away.rs` is not modified; a goal turn's requests reach it through the existing request path.
- **FR-011**: A goal is not carried into a new Conversation (behaviour set by P2) and Stop leaves the goal in the state OMP reports (behaviour set by P1).
- **FR-012**: The Session row shows a small mode badge while a goal exists (#1865, 2026-11-10). Prewalk's existing Session-menu toggle (#695) is unchanged.
- **FR-013**: A Refract-native `/goal <objective>` routes to the same IPC as the picker; `/prewalk` keeps its existing path (P2 priority).
- **FR-014**: Vibe and Loop are not offered anywhere (no pill item, no slash entry).
- **FR-015**: The picker is keyboard operable and announces state changes (`role="status"` as in `ModePill.tsx:64`).

## Success Criteria

- **SC-001**: The P1 to P3 results are written in Clarifications before T005 starts, and each later task gated on them cites the result.
- **SC-002**: Starting a goal in a live Tauri debug build against a real OMP process produces a `goal_updated`-driven pill, and exit returns it to None (T024, with screenshots).
- **SC-003**: With the overlay, `get_state.goal.enabled` is `true` and the user's global OMP config file is byte-identical before and after (T024).
- **SC-004**: In Plan mode the Goal item cannot be activated by pointer or keyboard, and the backend refuses it (named tests).
- **SC-005**: `away.rs` and its tests show an empty diff against `origin/main` (T025); a goal-turn request in an Away Session is answered by it (T022).
- **SC-006**: Existing `ModePill`, `WorkingModeMenu`, `prewalk`, `prewalk-store` and `slash-commands` tests pass unchanged.
- **SC-007**: Prewalk state shown by the new pill always equals the Session menu's (shared store test).

## Out of scope

Vibe and Loop (blocked on can1357/oh-my-pi#18719); Prewalk with a chosen model (`/prewalk <model>`, `/prewalk restart`); persisting a goal in Refract; editing a goal's objective in place; editing `away.rs`; editing the user's global OMP config; `docs/PLAN.md` (the controller owns it).
