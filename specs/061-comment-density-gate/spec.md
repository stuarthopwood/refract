# Spec 061: "Why"-only comment rule and `check:comment-density` gate (#1322, slice 1)

Slice 1 of 4. Adds the rule and the gate so new code stops adding comment bloat. It cuts no comments; slices 2 to 4 cut them per area.

## Clarifications

### Session 2026-10-30 (answers from the #1322 grill, Stuart 2026-10-29)

- Q: What comments are allowed? A: Only "why" comments, one or two lines, explaining a non-obvious constraint, invariant, security reason or workaround, optionally with an issue ref. Exported TypeScript items and Rust `pub` items keep a one-line doc comment.
- Q: What is banned? A: History, issue archaeology, gate or review narration, spec or task IDs, prose that restates the code.
- Q: What are the gate caps? A: A file fails when comment lines exceed 25% of its non-blank lines, or when any contiguous comment block exceeds 6 lines. The percentage rule ignores files under 40 lines.
- Q: How are existing offenders handled? A: A baseline file records each offender; offenders may shrink but never grow; a file that drops under the caps leaves the baseline.
- Q: Which files are scanned? A: `.ts`, `.tsx`, `.rs`, `.mjs` under `src/renderer`, `src/shared`, `src-tauri/src` and `scripts`, tests included.
- Q: Where does the rule live? A: `AGENTS.md`; `CLAUDE.md` already imports it.

## Functional requirements

- FR-1: `AGENTS.md` has a "Comments" HARD RULE section stating the rule above.
- FR-2: `scripts/check-comment-density.mjs` scans the scoped files and counts comment lines with a real scanner: the TypeScript scanner for `.ts`, `.tsx`, `.mjs`; a Rust lexer (strings, raw strings, chars versus lifetimes, nested block comments) for `.rs`. A line counts as a comment line when it holds a comment and no code.
- FR-3: A file fails when comment lines exceed 25% of non-blank lines (files of 40 or more lines only), or when it has a contiguous comment block over 6 lines.
- FR-4: `scripts/comment-density-baseline.json` maps each offender to `{ commentLines, maxBlock }`, written by `--write-baseline`.
- FR-5: A baselined file fails when its `commentLines` or `maxBlock` exceeds the recorded value. A baselined file now within the caps, or gone, is reported as stale and does not fail. A file that violates the caps and is absent from the baseline fails.
- FR-6: `pnpm check:comment-density` exists and `.github/workflows/ci.yml` runs it, so `pnpm ci:local` includes it.
- FR-7: The script passes its own gate and stays under 600 lines.
- FR-8: `docs/rust-build.md` lists the gate beside `check:file-size`.

## Success criteria

- SC-1: On a scratch copy, a file with a 7-line comment block fails the gate.
- SC-2: On a scratch copy, growing a baseline offender by one comment line fails the gate.
- SC-3: `pnpm ci:local` is green on the head.

## Edge cases

- Comment markers inside strings, template literals, regex literals and Rust raw strings are not comments.
- A trailing comment after code does not count as a comment line and does not extend a block.
- A block comment spanning N lines counts N lines; a blank line between `//` lines ends a block.
- Generated files (`gen/` segment, `AUTO-GENERATED` or `@generated` in the first 5 lines) are skipped.

## Deferred

- The comment cuts themselves (slices 2 to 4 of #1322).
