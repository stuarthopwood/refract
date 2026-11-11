# Feature Specification: Slash commands before the agent starts

**Feature Branch**: `feat/1812-slash-before-start`
**Created**: 2026-11-09
**Status**: Implemented; pending Rust build, ci:local and live check
**Input**: GitHub issue #1812. The issue has no github-actions triage comment, so the route is the one this PR's artifacts already follow: specify, clarify, plan, tasks, analyze, implement. Renumbered 123 to 125 after merging `origin/main`, where 123 and 124 are taken.

## Problem
A Session that has not started its agent has no command list, so the composer `/` menu is empty ("No matching commands") and a typed `/command` cannot be validated. Every send also forces the agent to start (`sessions.open(id, true)`), even for commands Refract handles itself.

## Clarifications

### Session 2026-11-09 (from grill)
Answers come from the issue's stated behaviour; no grill outcomes were recorded beyond the issue and no question reached Stuart.

- Q: What does the `/` menu show before start? -> A: The last-known command list, instantly. On a new install with no saved list it shows "Starting agent…" instead of "No matching commands".
- Q: Do Refract-native commands start the agent? -> A: No. `/new`, `/pause` and `/role <role>` run locally without a start. `/models` and bare `/role` already open Settings or the switcher without a start.
- Q: What about any other command? -> A: It starts the agent, waits up to 10 s for OMP's first commands report, validates, and runs exactly once.
- Q: A started Session? -> A: Unchanged.
- Q: Double sends? -> A: One in-flight send per Session in the composer, covering the start and the `chat.send` call (not a `/btw` side question's reply); a second submit is ignored until the first resolves, and Send shows `aria-busy` plus a polite "Sending…" status meanwhile.
- Q: Open questions? -> A: None.

## User Scenarios & Testing

### User Story 1 - The menu is useful before start (Priority: P1)
**Acceptance Scenarios**:
1. **Given** a not-started Session with a saved command list, **When** I type `/`, **Then** the saved commands show at once.
2. **Given** a new install with no saved list, **When** I type `/`, **Then** the menu reads "Starting agent…", not "No matching commands".

### User Story 2 - Native commands do not start the agent (Priority: P1)
**Acceptance Scenarios**:
1. **Given** a not-started Session, **When** I send `/pause`, `/new` or `/role <role>` with no attachments, **Then** it runs locally and the agent stays stopped.
2. **Given** `/new` on a never-started Session, **Then** it is a no-op, not an error.

### User Story 3 - Other commands run exactly once (Priority: P1)
**Acceptance Scenarios**:
1. **Given** a not-started Session, **When** I send an OMP command, **Then** the agent starts, the first commands report is awaited (up to 10 s), the command is validated and sent once.
2. **Given** no report within 10 s, **Then** the send is refused with a "try again in a moment" message and the draft is kept.

### User Story 4 - No double send (Priority: P2)
**Acceptance Scenarios**:
1. **Given** a send in flight, **When** Enter or Send fires again, **Then** nothing is sent a second time.

### Edge Cases
- A native command with attachments still starts the agent (attachments are refused for slash commands anyway).
- A failed start keeps the draft.

## Requirements
- **FR-001**: One global last-known command list (the most recent non-empty report from any Session's agent, capped at 1 MiB and 500 entries on load) is persisted and served while an agent is not started.
- **FR-002**: Before a queued command is validated, the backend waits up to 10 s for OMP's first commands report.
- **FR-003**: With no commands and a not-started or starting Session, the menu's empty state reads "Starting agent…", and a polite live region announces "Starting agent, commands will appear shortly" and then the command count once the list arrives.
- **FR-004**: `/new`, `/pause` and `/role <role>` skip the forced agent start; `/new` on a never-started Session succeeds without effect.
- **FR-005**: The composer allows one in-flight start-and-send per Session; it is released before a `/btw` side question's ask, so the side-chat's own running toast guards a second `/btw`.
- **FR-006**: Started Sessions behave as before.

## Success Criteria
- **SC-001**: The `/` menu never shows "No matching commands" for an empty list while the agent is starting.
- **SC-002**: Sending a native command to a not-started Session leaves the agent stopped.
- **SC-003**: Any command is delivered at most once per submit.

## Assumptions
- `COMMANDS_WAIT` (10 s) is exported from `session::agent`.
- Unit tests: `src/shared/slash-commands.test.ts` covers `isLocalNativeCommand`; Rust tests cover the persisted list and the wait. The menu and composer state changes in `useSlashMenuCompletion.ts` and `MessageInput.tsx` have no unit test (no component test harness exists in the repo) and rely on the live check.
