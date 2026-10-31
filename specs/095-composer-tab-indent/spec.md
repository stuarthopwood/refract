# Spec 095: Composer Tab indents (issue #1080)

Status: in progress. Source: Stuart's grill of 2026-10-20 (all decisions in issue #1080, none deferred).

## Problem

Tab in the composer moves focus to Send, so nested markdown lists cannot be indented.

## Requirements

- FR-1 Tab indents and Shift+Tab outdents the caret line, or every line a selection touches. A selection that ends at the start of a line excludes that line. After the edit the selection covers the same lines.
- FR-2 Precedence on Tab: slash menu row, ghost suggestion, then indent. Ctrl/Alt/Meta+Tab and IME composition are untouched.
- FR-3 The unit is two spaces. Shift+Tab removes up to two leading spaces (or one leading tab). Inside a fenced code block (between lines starting with three backticks or tildes) Tab inserts a literal tab at a collapsed caret, or prefixes each selected line with a tab.
- FR-4 Ctrl+M toggles "Tab moves focus" for this composer (not persisted, reset when focus leaves the box). While on, Tab and Shift+Tab move focus as before and a hint under the box reads "Tab moves focus · Ctrl+M to indent". The toggle is announced politely through the composer's existing live region ("Tab moves focus" / "Tab indents"). Plain Esc still clears the draft.
- FR-5 The textarea's description says "Tab indents. Press Ctrl+M to move focus with Tab instead." (or the reverse while focus mode is on). Ctrl+M and Tab/Shift+Tab are listed in Keyboard shortcuts (Message box group).
- FR-6 Shift+Enter on a list line (`-`, `*`, `+`, `1.`, `1)`, task `[ ]`) starts the next line with the same indent and marker (numbers increment, tasks start unchecked). Shift+Enter on an empty list item ends the list by removing the marker. Outside lists, inside code fences, with a selection, or during IME composition Shift+Enter keeps its newline. Plain Enter still sends.
- FR-7 Every edit keeps the native undo stack: one keypress is one Ctrl+Z step.

## Out of scope

The Markdown editor's own Indent and Outdent (#878). New automated tests (prototyping phase).

## Acceptance

`scripts/verify-tauri-095.mjs` proves, in the built app: Tab indents, Shift+Tab outdents, Tab in a code fence inserts a tab, Ctrl+M makes Tab move focus, Shift+Enter continues and ends a list.
