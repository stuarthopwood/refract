# Feature Specification: Delete Session in the background

**Feature Branch**: `feat/1591-background-delete`
**Created**: 2026-11-03
**Status**: Draft
**Input**: GitHub issue #1591 (P0, `enhancement`) "Feat: Delete Session runs in the background", grilled with Stuart 2026-11-02 (outcomes in the issue body and `docs/PLAN.md` line 1033).

## Clarifications

### Session 2026-11-03

All answers come from the issue's grill block, its "Intended behaviour" and "Technical notes" sections, and `docs/PLAN.md` line 1033. No other source was used.

- Q: What happens to the Delete dialog on Confirm? -> A: It closes at once once the refusal checks have passed. The Session row stays in the sidebar, dimmed, with a spinner and **Deleting…** status, and cannot be opened.
- Q: What happens when the delete succeeds? -> A: The row is removed.
- Q: What happens on refusal or failure? -> A: The row returns to normal and an error toast shows **Retry** and **Details**. **Details** reopens the Delete dialog showing the existing refusal detail (holders, leftover summary).
- Q: Do refusal checks still run before the background removal? -> A: Yes. Named holders and cwd holders are checked before the row enters Deleting…, so a refusal never leaves a half-deleted Session. Only the slow file removal moves to the background.
- Q: Can several deletes run at once? -> A: Yes, in parallel, one per Session (each has its own write guard).
- Q: What happens when the user quits during a delete? -> A: The app asks first: "A Session is still being deleted. Quit anyway?". Quitting anyway leaves a partial folder, which the existing Retry path already handles (#891).
- Q: Does a reload restore the Deleting… rows? -> A: Yes. A backend set of in-flight deletes is exposed to the renderer.
- Q: What can a Deleting… Session NOT do? -> A: It cannot be opened, archived, renamed, or deleted again.
- Q: Accessibility? -> A: The row's accessible name includes "deleting"; a polite live region announces "Deleted <name>" or the failure; the toast's Retry and Details are keyboard reachable.
- Q: Open questions in the issue? -> A: None.

Details the grill did not fix (the plan chooses a default and flags it; Stuart can overrule): the quit prompt is a native OS message dialog (the window may already be closing); the failure toast stays until dismissed; a Retry that is refused again replaces the toast instead of stacking a second one.

## User Scenarios & Testing

### User Story 1 - Keep working while a large worktree is removed (Priority: P1)

A user deletes a Session whose worktree has 100k+ files. After confirming, the dialog closes and they carry on switching Sessions, chatting, and opening PRs while the Session shows **Deleting…**.

**Why this priority**: Today the modal covers the whole app for minutes (#891). This is the point of the issue (P0).

**Independent Test**: Delete a Session with a large worktree; confirm the dialog closes straight after Confirm, the app stays usable, and the row disappears when removal finishes.

**Acceptance Scenarios**:

1. **Given** a Session that passes the refusal checks, **When** the user confirms Delete, **Then** the dialog closes and the row stays, dimmed, with a spinner and **Deleting…**.
2. **Given** a Deleting… row, **When** the user clicks it or uses the keyboard, **Then** it does not open.
3. **Given** the removal succeeds, **When** it finishes, **Then** the row disappears and a polite announcement says "Deleted <name>".
4. **Given** a Deleting… row, **When** the user opens its menu or uses its shortcuts, **Then** open, archive, rename and delete are unavailable.

---

### User Story 2 - Refusals stay immediate and safe (Priority: P1)

If named holders or a cwd holder would block the delete, the user learns this before the row enters Deleting….

**Why this priority**: A refusal must never leave a half-deleted Session.

**Independent Test**: Hold a file inside a worktree open, confirm Delete, and verify the dialog stays open with the existing refusal detail and the Session is untouched (and its agent restarted if it was running).

**Acceptance Scenarios**:

1. **Given** a holder blocks the delete, **When** the user confirms, **Then** the dialog stays open showing the refusal, exactly as today, and no row enters Deleting….
2. **Given** a running Session whose delete is refused at the cwd check, **When** the refusal returns, **Then** the agent is restarted as today.

---

### User Story 3 - Failures are recoverable (Priority: P1)

If the background removal fails after the dialog has closed, the user is told and can retry or see why.

**Independent Test**: Make the removal fail (a file locked after the checks passed); confirm the row returns to normal and a toast with **Retry** and **Details** appears.

**Acceptance Scenarios**:

1. **Given** the background removal fails, **When** it ends, **Then** the row returns to normal and an error toast appears with **Retry** and **Details**, and a polite live region announces the failure.
2. **Given** the toast, **When** the user chooses **Retry**, **Then** the delete starts again through the same checks.
3. **Given** the toast, **When** the user chooses **Details**, **Then** the Delete dialog reopens showing the failure message plus the existing holders and leftover summary.
4. **Given** the toast, **When** the user uses only the keyboard, **Then** Retry and Details are reachable and operable.

---

### User Story 4 - Parallel deletes and reload (Priority: P2)

**Independent Test**: Start deletes on two Sessions; both show Deleting… and finish independently. Reload the window mid-delete; both rows are still Deleting….

**Acceptance Scenarios**:

1. **Given** one delete in flight, **When** the user confirms Delete on another Session, **Then** both run at once and settle independently.
2. **Given** deletes in flight, **When** the window reloads, **Then** the Deleting… rows are restored.

---

### User Story 5 - Quitting during a delete asks first (Priority: P2)

**Independent Test**: Start a delete of a large worktree and close the window; a prompt "A Session is still being deleted. Quit anyway?" appears.

**Acceptance Scenarios**:

1. **Given** a delete in flight, **When** the user closes the window or otherwise quits, **Then** a prompt asks "A Session is still being deleted. Quit anyway?".
2. **Given** the prompt, **When** the user declines, **Then** the app stays open and the delete continues.
3. **Given** the prompt, **When** the user accepts, **Then** the app quits as it does today; the partial folder is handled by the existing Retry path (#891).
4. **Given** no delete is in flight, **When** the user quits, **Then** there is no new prompt.

### Edge Cases

- A second delete of the same Session while one is in flight is refused with a clear message (the UI also hides the action).
- The Session is deleted by the background task while its chat pane is showing; the pane closes as it does for any removed Session.
- `Details` on a Session that is no longer in the registry (already removed by a later success) is a no-op.
- Failure toast for a Session whose row has been removed from view (collapsed group) still appears.
- Quitting through the "Update now" path also asks.

## Requirements

### Functional Requirements

- **FR-001**: On Confirm, the system MUST run the existing refusal checks (leftover-walk cancel, write guard, named-holder check, agent shutdown, cwd-holder check) before the dialog closes, and MUST report a refusal in the dialog exactly as today.
- **FR-002**: After the checks pass, the system MUST close the dialog and perform file removal, Conversation deletion and registry removal in the background without blocking the renderer.
- **FR-003**: While removing, the Session row MUST stay in the sidebar, dimmed, with a spinner and the status text **Deleting…**, and its accessible name MUST include "deleting".
- **FR-004**: A Deleting… Session MUST NOT be openable, archivable, renamable or deletable again, in the UI and in the backend.
- **FR-005**: On success the row MUST be removed and a polite live region MUST announce "Deleted <name>".
- **FR-006**: On failure the row MUST return to normal and an error toast MUST show **Retry** and **Details**, and a polite live region MUST announce the failure.
- **FR-007**: **Retry** MUST start the delete again through the same checks. **Details** MUST reopen the Delete dialog showing the failure message plus the existing holders and leftover summary.
- **FR-008**: Several Sessions MUST be deletable at once, each independent (one write guard per Session).
- **FR-009**: The backend MUST keep the set of in-flight Session ids and expose it to the renderer so a reload restores Deleting… rows.
- **FR-010**: Quitting while any delete is in flight MUST first ask "A Session is still being deleted. Quit anyway?"; declining keeps the app and the delete running; accepting quits through the existing quit path.
- **FR-011**: Failure events MUST carry the same error payload (code, message) the dialog shows today.
- **FR-012**: The row state MUST be built on the shared sidebar row component and the toast on the shared `ui/sonner` wrapper (ADR 0003).
- **FR-013**: The toast Retry and Details MUST be reachable and operable by keyboard.

### Key Entities

- **In-flight delete**: a Session id with a running background removal; lives in the backend until success or failure; exposed to the renderer by a list query and by start/settle events.
- **Delete outcome event**: success (`sessions:deleted`, Session id) or failure (`sessions:delete-failed`, Session id + `{ code, message }`).

## Success Criteria

### Measurable Outcomes

- **SC-001**: After Confirm on a passing Session, the dialog closes within one second regardless of worktree size, and the app accepts input throughout the removal.
- **SC-002**: A refused delete leaves no row in Deleting… and the Session unchanged.
- **SC-003**: Two simultaneous deletes both complete without either blocking the other.
- **SC-004**: After a window reload mid-delete, 100% of in-flight Sessions show Deleting….
- **SC-005**: With a delete in flight, closing the window never quits without the prompt.

## Assumptions

- The Rust backend (`src-tauri`) and the renderer (`src/renderer`) both change; the file removal already runs on `spawn_blocking`, so no change to `fs::remove_tree` is needed.
- The existing `#891` Retry path for a partial folder stays as is.
- Prototyping phase: no new tests are added; existing tests are kept passing.
