# Spec 089: lint hardening (#1488, #1374)

Issues: #1488 (literal-colour lint and verify script leftovers from #1473) and #1374 (`check:comment-density` follow-ups from #1371). Branch `lint-hardening-1488-1374` (Lane Z). Decisions: the "Decided (Skippy, delegated by Stuart 2026-10-31)" comments on both issues; see `clarifications.md`. No new tests (prototyping phase); gate scripts are not tests. No `src/renderer` file is touched (Lane Y owns UI polish).

## Problem

`check:literal-colours` strips comments with a regex that a `//` inside a string can fool and that goes quadratic on many unterminated `/*`; it counts `url("#id")` and quoted `#abc` selectors, counts words like `#bad`, and ignores `rgb()`/`hsl()`. `verify-tauri-083.mjs` writes to a fixed temp dir, accepts a zero-alpha background and finds the theme radio by prefix. `check:comment-density` ignores a comment that opens after code on a line, and a stale baseline entry still gives headroom.

## Functional requirements

- FR-001 `countLiteralColours` blanks comments using `scanTypeScriptComments` (tokenizer-aware, linear).
- FR-002 `HEX_QUOTED` excludes `url("#id")`, `url('#id')` and `#id` arguments of `querySelector`, `querySelectorAll`, `closest`, `matches`.
- FR-003 `HEX_INLINE` 3-4 digit matches need a digit or one repeated letter.
- FR-004 `rgb(`, `rgba(`, `hsl(`, `hsla(` followed by a number count as literal colours; baseline re-written.
- FR-005 `verify-tauri-083.mjs`: default `SHOTS_DIR` from `mkdtemp`; background assertion rejects zero alpha; radio found by exact `aria-labelledby` name.
- FR-006 `measureLines` counts a line that opens a multi-line comment after code as a comment line that starts the block.
- FR-007 `check:comment-density` exits 1 on stale baseline entries.

## Items skipped

| Item | Result |
|---|---|
| Reword help-text hex in `ProjectColorPopover.tsx` (#1488) | skipped: edits `src/renderer` (Lane Y) to save two baseline counts |
