# Feature Specification: Pause cancels the Session's subagents (#1835)

**Feature Branch**: `feat/1835-pause-cancel`

**Created**: 2026-11-11

**Status**: Draft (docs only; no code yet)

**Input**: GitHub issue #1835, "Bug: Pause: pausing does not pause running subagents, so the Session never pauses". Route: specify, clarify, plan, tasks, analyze, implement. The issue's triage comment does not exist (no `<!-- pinion-issue-triage` comment by github-actions[bot]), so the route is the one the lane brief states. Amends spec 056 (pause mode); it does not replace it.

## Problem

Pausing a Session today (`src-tauri/src/session/agent/pause.rs:123-164`) only holds the user's queued and new messages. It sends nothing to subagents, so a turn that is waiting on subagents keeps spending tokens and the Session never settles into Paused. Spec 056 and #477 said pausing covers subagents ("as OMP's does"); the shipped pause does not. OMP has no RPC pause gate (its `/pause` is TUI-only), so Refract has to act through the RPC commands OMP does expose.

## Clarifications

### Session 2026-11-11 (grill, Stuart; decided)

- Q: How does Pause stop a running subagent? -> A: Refract calls `cancel_subagent` for each running subagent immediately. The Session goes straight to Paused: there is no wait for subagents to wind down and no 2-minute grace. Reason: the 2026-11-10 probe showed a stop steer ends the subagent's task (`completed`, then `Subagent not running`), while `cancel_subagent` returns at once with `cancelled: true` and keeps the subagent revivable.
- Q: What happens to the earlier "Pausing: waiting for N subagents" design (2026-11-10 11:19)? -> A: Dropped. The wait-for-subagents Pausing state and the 2-minute cancel are not built.
- Q: What if the parent spawns a subagent while the Session is Paused? -> A: Refract auto-cancels it. OMP has no RPC gate, so Refract enforces it: every `subagent_lifecycle` frame that reports a subagent starting while the Session is paused is answered with `cancel_subagent`.

### Session 2026-11-11 (clarify; decided by Stuart)

- Q (DC-1, decided): How does Resume treat subagents that Pause cancelled? -> A: Resume only clears the pause and posts one chat notice listing the subagents the pause cancelled. Nothing is respawned or revived automatically; the parent can re-run them. No `steer_subagent` or `write agent://<id>` revive is built.
- Q (DC-2, decided): Does the shipped "Pausing" label for a Session whose own turn is still running go? -> A: No. The turn-boundary Pausing label (`pause.rs:25-36`) stays. Pause cancels subagents at once, but the label stays while the parent's turn finishes.

### Session 2026-11-11 (clarify; deferred with interim behaviour, not guessed)
- Q (DC-3): Does Pause or auto-cancel add a chat note? -> Deferred. Interim: one notice per Pause naming each subagent Pause cancelled, and one notice per auto-cancel (this carries forward the 11:19 decision's "chat note naming each cancelled subagent").
- Q (DC-4): Messages from other agents to a paused subagent (13:57 decision, point 2: hold them, and block them after a #1672 watchdog cancel). -> Deferred. Refract does not see agent-to-agent messages (they travel inside OMP) and there is no #1672 watchdog code on `main`. Interim: not built; out of scope.
- Q (DC-5): Can the parent re-spawn or revive subagents in a loop while Paused, since Pause does not abort its turn? -> Deferred. Interim: each one is auto-cancelled; no loop limit and no abort of the parent turn.
- Q (DC-6): Should a subagent be cancelled if Pause lands while it is already settling (frame race)? -> A (derived): cancel anyway and treat `cancelled: false` and `Subagent not running` as "nothing to cancel", per the RPC docs.

## User Scenarios & Testing

### User Story 1 - Pause stops running subagents (Priority: P1)

A Session has a turn waiting on subagents. Stuart presses Pause.

**Why this priority**: the reported defect.

**Independent Test**: fake-OMP unit test with two listed subagents; live check against real OMP (probe driver `Probe1835/drive.mjs`).

**Acceptance Scenarios**:

1. **Given** a Session with two running subagents, **When** the user pauses it, **Then** Refract sends `get_subagents`, then `cancel_subagent` for each listed id, and the subagents settle as Cancelled in the Subagents panel.
2. **Given** a Session with no subagents, **When** the user pauses it, **Then** it pauses exactly as spec 056 describes and no `cancel_subagent` is sent.
3. **Given** a subagent that already finished, **When** Pause runs, **Then** `cancelled: false` (or `Subagent not running`) is ignored and Pause still succeeds.
4. **Given** `get_subagents` or `cancel_subagent` fails or times out, **When** the user pauses, **Then** the Session still pauses and the failure is logged and shown as a notice; messages are still held.

### User Story 2 - New subagents are refused while Paused (Priority: P1)

**Independent Test**: unit test feeding a `subagent_lifecycle` `started` frame to a paused agent and asserting the `cancel_subagent` request.

**Acceptance Scenarios**:

1. **Given** a paused Session whose parent turn is still running, **When** the parent spawns a subagent, **Then** Refract cancels it as soon as its `started` frame arrives.
2. **Given** the Session is not paused, **When** a subagent starts, **Then** nothing is cancelled.
3. **Given** the user resumes, **When** the parent spawns a subagent afterwards, **Then** it runs normally.

### User Story 3 - Resume (Priority: P2)

**Acceptance Scenarios**:

1. **Given** Pause cancelled two subagents, **When** the user resumes, **Then** held messages are delivered as today and a notice names the cancelled subagents. Nothing is revived or respawned; the parent can re-run them.

### Edge Cases

- Pause on an idle Session with background (detached) subagents still running: they are cancelled too; pause state is not conditioned on the turn.
- `pauseAll` pauses every live Session; each cancels its own subagents (`ipc/chat_pause.rs:64`).
- App restart while paused: the OMP process and its subagents are gone; the recorded cancelled list is in memory only and is not persisted.
- Pause pressed twice: the second call returns early (`pause.rs:128-130`) and cancels nothing more.
- While Paused the Subagents chip is unreachable (the Paused body is inert), so the right-rail Subagents button is the Paused entry point for inspecting subagents.
- Subscription missing (older OMP answers `success:false` to `set_subagent_subscription`): `get_subagents` still works for Pause; auto-cancel of new subagents needs the lifecycle frames, so it degrades to "not enforced" and is noted in the Assumptions.

## Requirements

### Functional Requirements

- **FR-001**: `SessionAgent::pause()` MUST, when a live process exists, request `get_subagents` and send `cancel_subagent` for every listed running subagent, whatever the turn state.
- **FR-002**: The Session MUST go straight to Paused for subagent purposes: Pause waits for the cancel responses only (each bounded by the RPC timeout), never for subagents to wind down, and has no grace period.
- **FR-003**: `cancelled: false` and `Subagent not running: <id>` MUST be treated as "nothing to cancel", not errors. Any other failure MUST NOT prevent the pause or the message hold.
- **FR-004**: While `pause.held` is set, a `subagent_lifecycle` frame reporting a starting subagent MUST trigger `cancel_subagent` for its id.
- **FR-005**: Refract MUST record the ids it cancelled during the current pause (in memory) and clear them on Resume.
- **FR-006**: Resume MUST clear the pause and deliver held messages exactly as today, and MUST post one notice naming the subagents Pause cancelled (DC-1 decided 2026-11-11). It MUST NOT revive or respawn subagents.
- **FR-007**: A Session with no running subagents MUST behave exactly as spec 056.
- **FR-008**: Each Pause that cancels at least one subagent MUST add one chat notice naming the cancelled subagents (DC-3 interim); each auto-cancel adds one notice.
- **FR-009**: Cancelled subagents MUST show as Cancelled in the Subagents panel via the existing lifecycle (`aborted`) handling; no new renderer state.

### Key Entities

- **Paused cancel list**: ids of subagents Refract cancelled during the current pause; in-memory in `pause::State`.

## Success Criteria

- **SC-001**: Pausing a Session with N running subagents leaves none running within one RPC round trip per subagent.
- **SC-002**: No subagent runs in a Paused Session for longer than the time to receive its `started` frame and answer it.
- **SC-003**: A Session without subagents sends no extra RPC on Pause.
- **SC-004**: Spec 056 behaviour (held messages, Resume order, `/pause`, `pauseAll`) is unchanged.

## Assumptions

- `cancel_subagent` is idempotent and returns at once (probe, OMP 18.17.0; RPC docs, "Cancelling subagents").
- `get_subagents` lists exactly the running subagents; cancelled ones are not listed afterwards.
- `set_subagent_subscription` at level `progress` (already sent by `subagents_progress.rs:177-191`) delivers `subagent_lifecycle` `started` frames.
- Out of scope: abort of the parent turn on Pause, OMP-side pause gate, #1672 watchdog, agent-to-agent message gating.
