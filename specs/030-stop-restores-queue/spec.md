# Spec 030: Stop returns queued messages to the composer (issue #517)

Converge route: amends spec 001's contract (`specs/001-core-session-workspace/contracts/omp-usage.md`, "Stop") and the composer's queue behaviour (spec 009/010). Grill outcomes, Stuart, 2026-10-28.

## Problem

Stop sends a plain `abort`. OMP then requeues stranded steers and drains them into a fresh turn, which can run messages the user meant to cancel.

## Requirements

- **FR-001**: Stop sends `abort_and_restore_queue` (OMP 18.6.3+). It withdraws every queued steering and follow-up message, with images, then aborts. No new turn starts from withdrawn messages.
- **FR-002**: Withdrawn messages go back into the composer in order (steering first, then follow-ups, each oldest first). They are appended below any text the user already typed, separated by a blank line; they never replace the draft. Their images are added to the draft's images.
- **FR-003**: If OMP rejects the command (older runtime), Stop falls back to plain `abort` with no change in behaviour.
- **FR-004**: When OMP reports `imagesDropped` or `truncated`, a warning toast says so.
- **FR-005**: Accessibility: a polite live region announces "N queued message(s) returned to the editor"; focus moves to the composer.
- **FR-006**: Ctrl+Shift+X and the Stop button behave identically.

## Out of scope

- Focus restoration when the Stop button unmounts (#897, separate lane).
- The `queuedImages` side map the issue mentions no longer exists in the Rust build; nothing to remove.
