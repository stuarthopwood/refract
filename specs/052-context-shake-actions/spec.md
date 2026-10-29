# Feature Specification: Context shake actions

**Feature Branch**: `context-shake-actions`
**Status**: Draft
**Input**: #506 "Context: first-class /shake actions on the Context usage pill, with a visible result". Numbered 052. No existing spec covers it, so this is the specify route.

## Clarifications

### Session 2026-10-29 (self-grill, Skippy delegated by Stuart; recorded on #506)

- Q: Already shipped? A: Partly. The allow-list (`shake: ['elide','images','thinking']`, `src/shared/slash-commands.ts`), the probe (FINDINGS item 12) and the #449 tolerance for a lower `messageCount` (`launch_support.rs`) are on `origin/main`. The menu is not.
- Q: Does OMP support it? A: Yes. `/shake`, `/shake images` and `/shake thinking` are typed prompts sent through `chat.send`; FINDINGS item 12 captured their replies on 18.8.0. No new wire string.
- Q: Scope? A: The menu with the three shake actions. Compact now, the auto-compaction switch, artifact expansion and `methodOrder` Settings stay follow-ups on #506.
- Q: Visible result? A: OMP's own `command_output` notice in the transcript carries the freed figure ("Dropped 2 thinking blocks ... (~94 tokens freed)", "Nothing to shake."). The menu adds a polite announcement that the shake started and no second line.
- Q: Confirmation? A: Thinking and images (neither is recoverable) confirm in an `AlertDialog` with Cancel focused; the confirm button repeats the verb. Elide does not confirm (recoverable).
- Q: Disabled while not idle? A: Items stay focusable, `aria-disabled`, `onSelect` does nothing, one reason line under the header; the dialog's confirm re-checks idle.
- Q: Component? A: `ReadoutItem` forwards trigger props (`...rest`) so `DropdownMenuTrigger asChild` works. Menu built from `dropdown-menu.tsx` and `alert-dialog.tsx`; layout copies `ApprovalModePill`.

## Requirements

- **FR-001** The Context usage readout (figure and "Context n/a" states) is a button that opens a menu upward. Its accessible name starts with the visible text and ends with "context usage, shake options".
- **FR-002** The menu has a non-focusable header with the figure ("142k/200k (71%)"), "Shake context" (`/shake`), a separator, "Shake thinking" (`/shake thinking`) and "Shake images" (`/shake images`), each with a one-line hint saying whether the loss is recoverable.
- **FR-003** While the Session is not idle every item is `aria-disabled`, selecting does nothing, and one reason line ("Available when the session is idle") is described by each item.
- **FR-004** "Shake thinking" and "Shake images" open a confirmation naming what is lost; confirming re-checks the Session is idle, sends the command, and returns focus to the readout. "Shake context" sends immediately.
- **FR-005** A refused or failed send is reported through `notify`.
- **FR-006** The send announces "Shaking context" (or thinking, images) politely via the composer live region.
