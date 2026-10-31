# Clarifications (spec 095)

All questions were resolved by the 2026-10-20 grill on #1080; none remain.

- Indent unit: two spaces; tab inside fences.
- Way out of the focus trap: Ctrl+M (WCAG 2.1.2); Esc keeps clearing the draft.
- Announcement channel: the composer's existing polite attachment live region, so no new region is added.
- Undo: edits go through `document.execCommand('insertText'/'delete')`, which the controlled textarea receives as a normal `input` event.
- Shift+Enter on a list item with a selection keeps the native newline (replacement semantics are ambiguous).
