# Spec 031: Keep focus in the composer when Stop unmounts (issue #897)

Specify route (small bug; amends the composer behaviour of spec 030 FR-005). Grill outcome, Stuart, 2026-10-28: focus the message field, only when Stop held focus.

## Problem

Spec 030 (PR #1281) focuses the composer when Stop is clicked or Ctrl+Shift+X is pressed. It does not cover a turn that ends on its own while the Stop button holds keyboard focus (the user tabbed to it). Stop unmounts and focus falls to `<body>`, stranding keyboard users.

## Requirements

- **FR-001**: When a turn ends (status leaves `working`) and the Stop button held focus immediately before, focus moves to the message field.
- **FR-002**: Focus is never moved if Stop did not hold focus, or if the user already moved focus elsewhere (the move happens only when focus fell to `<body>`).
- **FR-003**: The Stop click and Ctrl+Shift+X paths from spec 030 are unchanged.

## Clarifications

- Message field, not Send: the user's next action is typing; Send is disabled when the draft is empty.
- The Stop-clicked case already works via spec 030, so FR-001 is mainly the natural end of a turn; the same code path is harmless for the Stop case.

## Success criteria

After a turn ends with Stop focused, `document.activeElement` is the composer textarea, not `body`.
