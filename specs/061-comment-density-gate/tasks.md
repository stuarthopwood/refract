# Tasks 061: comment rule and gate

- T001 Write `scripts/comment-density-scan.mjs` (ranges + metrics). [FR-2]
- T002 Write `scripts/check-comment-density.mjs` (walk, baseline, CLI). [FR-3, FR-4, FR-5, FR-7]
- T003 Generate `scripts/comment-density-baseline.json` with `--write-baseline`. [FR-4]
- T004 Add the `check:comment-density` script to `package.json` and the step to `ci.yml`. [FR-6]
- T005 Add the "Comments" rule to `AGENTS.md`. [FR-1]
- T006 Add the gate to `docs/rust-build.md`; set the #1322 row in `docs/PLAN.md` to slice 1 in review. [FR-8]
- T007 Scratch proof outside the repo: 7-line block fails; baseline growth by one line fails. [SC-1, SC-2]
- T008 Five-reviewer gate, then `pnpm ci:local` on the final head. [SC-3]
