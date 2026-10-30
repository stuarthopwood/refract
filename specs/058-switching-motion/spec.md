# Spec 058: Switching motion (issue #678)

Source: issue #678, "subtle enter animations when opening or switching views, Sessions, panels, panel content and models". Rules extend `docs/design/foundations-motion.md`.

## Clarifications

Session 2026-10-30. Answered by Skippy, delegated by Stuart.

- Q: Tokens? A: `--motion-fast` 100ms, `--motion-base` 150ms, `--motion-panel` 200ms, `--ease-out` cubic-bezier(0.2, 0, 0, 1), as the issue proposes.
- Q: Library? A: None added. Utility classes sit on `tw-animate-css` (`animate-in`, `fade-in`, `slide-in-from-*`) in `globals.css`.
- Q: Remount or restart? A: Never remount. Remounting a pane would reset scroll and state (#485). A shared hook `useEnterOnSwitch` restarts a CSS animation on the existing element when a key changes.
- Q: First paint and restore? A: The hook skips the first render, so launch, window restore and reopening a Session show content at once.
- Q: Rapid switches? A: A switch less than 150ms after the previous one clears the animation and shows the final state. The last switch wins.
- Q: Right pane open? A: The panel size changes instantly. Only the content fades and slides 8px over 200ms.
- Q: Dialogs, menus, tooltips, toasts? A: Audit only. They keep their `tw-animate-css` motion, moved onto the tokens. No new motion.
- Q: Exit animations? A: None.
- Q: Live tuning? A: Use the issue's defaults unless the live check shows a problem.

## Requirements

- FR-001: `globals.css` defines the four motion tokens and the utilities `motion-enter` (150ms, 4px rise), `motion-enter-fade` (120ms, opacity), `motion-enter-panel` (200ms, 8px slide from the right), `motion-crossfade` (100ms, opacity). All animate `opacity` and `transform` only.
- FR-002: `useEnterOnSwitch(key, variant)` (components) returns a ref. When `key` changes after the first render, it restarts the variant's animation on the ref element, unless the previous switch was under 150ms ago, in which case it clears the animation.
- FR-003: View switch (chat, Pull requests, Issues, Settings, Manage sessions): content uses `motion-enter`.
- FR-004: Session switch: the chat area uses `motion-enter-fade` keyed by the front Session id. Scroll restore and land-at-end are untouched.
- FR-005: Right pane open: the pane content (not its frame) uses `motion-enter-panel`, keyed by the open state and active panel id; closing never animates. A panel switch uses the same key.
- FR-006: Selected-tab indicator in `PanelTabBar` fades and grows in place over 150ms.
- FR-007: Model, thinking-level and Approval mode pill labels crossfade (`motion-crossfade`) when the value changes, never on mount.
- FR-008: A new Session list row fades in with a 4px rise. Only a Session created in the last 3s animates; restore, remount, search, group expand, archive and delete do not.
- FR-009: Settings section content fades in when a section is first shown.
- FR-010: shadcn dialog, popover, dropdown-menu, tooltip use the token duration and easing.
- FR-011: Under `prefers-reduced-motion: reduce` every switch is instant (the existing global rule). Behaviour never waits on `animationend`.
- FR-012: `docs/design/foundations-motion.md` gains a "Switching" section and the easing decision.

## Out of scope

Transcript scrolling, streamed text, drag-to-reorder, window resize, lists of 100+ rows, exit animations, new tests (prototyping phase).
