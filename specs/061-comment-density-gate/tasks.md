# Tasks 061: comment rule and gate

- T001 Write `scripts/comment-density-scan.mjs` (ranges + metrics). [FR-2]
- T002 Write `scripts/check-comment-density.mjs` (walk, baseline, CLI). [FR-3, FR-4, FR-5, FR-7]
- T003 Generate `scripts/comment-density-baseline.json` with `--write-baseline`. [FR-4]
- T004 Add the `check:comment-density` script to `package.json` and the step to `ci.yml`. [FR-6]
- T005 Add the "Comments" rule to `AGENTS.md`. [FR-1]
- T006 Add the gate to `docs/rust-build.md`; set the #1322 row in `docs/PLAN.md` to slice 1 in review. [FR-8]
- T007 Scratch proof outside the repo: 7-line block fails; baseline growth by one line fails. [SC-1, SC-2]
- T008 Five-reviewer gate, then `pnpm ci:local` on the final head. [SC-3]
- T009 Slice (b) done: `src-tauri/src` cut to why-only comments, comment-only diff proved by a strip-comments equivalence check, `src-tauri` baseline entries removed. [Refs #1322]
- T010 Slice (c) done: `scripts/` cut to why-only comments, comment-only diff proved by a strip-comments equivalence check, `scripts/` baseline entries removed. [Refs #1322]
- T011 Slice (a) done: `src/renderer` and `src/shared` cut to why-only comments, comment-only diff proved by a strip-comments equivalence check, their baseline entries removed. Closes #1322.
