# Feature Specification: Chat navigation (wave 4)

**Feature Branch**: `chat-navigation-wave4`
**Status**: Draft
**Input**: One PR for the wave 4 "Chat navigation" row in `docs/PLAN.md`: #750 (foundation, still open, built here), #751, #752, #753 and #754, on one shared message index (ADR 0005). Numbered 041: 030 to 040 are taken. The Outline is a new tenant of spec 013 (right-pane panels); its record lives here per the issue's "fold into one Chat navigation feature".

## Clarifications

### Session 2026-10-29 (wave 4 grill, Stuart)

- #750 was open and unbuilt, so the index, bridge and `jumpToMessage` ship in this PR (Closes #750 too).
- Earlier decisions stand: Outline is a right-pane panel; Previous/Next step through any message; search covers user and agent messages only.
- #751: Alt+Up and Alt+Down adopted, active with focus in the transcript or composer. Scroll to end changes to `ArrowDownToLineIcon`; Scroll to top (#468) stays out.
- #752: Outline sits last in the default rail order, after Side chat.
- #753: counts and highlights use rendered text for rendered messages and source text for windowed-out ones.
- #754: rendered rows only plus an "N earlier turns" stub that triggers Load earlier. A Settings toggle "Show scrollbar map" in the Chat group, default on.
- Platform note: the issues say Electron; the build is Tauri v2 on WebView2 (Chromium), so the CSS Custom Highlight API is probed there, with a no-highlight fallback (list and jump still work).
- Clarify pass: no further ambiguity that changes the implementation.

## Requirements

- **FR-001** (#750) A per-pane navigation store holds the ordered navigable-message index (user and `assistant-text` items only, from the full transcript, not only the rendered window) and a bridge to the scroller (`scrollToMessage`, scrollable `{start,end}`, visible ids) registered by `Transcript`. One `jumpToMessage(sessionId, messageId)` reveals windowed-out turns, runs the existing landing correction, detaches from autoscroll, highlights the target briefly and announces "Message N of M" once.
- **FR-002** (#751) Previous message and Next message icon buttons sit above Scroll to end, fade in while the transcript scrolls and out about 2 s after, stay while hovered or focused, are revealed on focus, hide Previous at the top and Next at the bottom, and step per the "top of current message first" rule. Alt+Up and Alt+Down do the same from the transcript or composer. Scroll to end uses `ArrowDownToLineIcon`.
- **FR-003** (#752) An `outline` hosted panel (last in `HOSTED_PANELS`) follows the active pane's Session: user messages top level, agent text nested, first line plus role marker (and time for user messages), current position marked (`aria-current="location"`), click jumps without moving focus, Enter also focuses the message, per-turn collapse and header Collapse all / Expand all, windowed with `react-virtuoso`, roving tabindex list, empty state "No messages yet".
- **FR-004** (#753) Ctrl+F while focus is in a chat pane, or a header ghost search icon, opens a floating find bar (`role="search"`: input, "N of M" count, previous and next, Match case, Close) and a results list; Enter and Shift+Enter step, Esc closes and restores focus and clears highlights. Rendered matches highlight with the CSS Custom Highlight API (current stronger than others, not colour alone). Debounced, chunked, cancellable search; results capped at 500; per-pane state, last query remembered per Session. Ctrl+F elsewhere is untouched. A "Find in chat" menu hint with its shortcut if the menu bar exists.
- **FR-005** (#754) A canvas map in the scrollbar gutter marks navigable messages (user left half, agent right half, at least 2 px), shows a viewport window, jumps on click (nearest mark within about 6 px, else proportional), drags to scroll, shows a hover tooltip after about 300 ms, merges sub-pixel marks, hides under 1.5 viewports and when empty, covers rendered rows only plus an "N earlier turns" stub that triggers Load earlier, is `aria-hidden`, and is controlled by a Settings toggle "Show scrollbar map" (Chat group, default on).
- **FR-006** Highlight, map-mark and current-match colour pairs are added to `check:theme-contrast` and pass in every preset including High contrast; UI text passes `check:ui-text`.

## Success criteria

- `pnpm ci:local` is green on the merged tree; the live check on a scratch exe exercises each feature in Dark and High contrast.
- Previous/Next, Outline click and search results all land on the same message through the single `jumpToMessage`.
- No file grows past its `scripts/file-size-baseline.json` value (`Transcript.tsx` baseline 1059, now 990); new files stay under 600 lines; reusable components only (ADR 0003).
- No new tests (prototyping phase); existing tests keep passing.
