# Plan 061: comment rule and `check:comment-density` gate

## Files

- `AGENTS.md`: new "Comments" HARD RULE section.
- `scripts/comment-density-scan.mjs`: comment-range scanners (TypeScript compiler API for `.ts`/`.tsx`/`.mjs`, hand-written lexer for `.rs`) and the per-file line metrics.
- `scripts/check-comment-density.mjs`: file walk, baseline compare, CLI (`--write-baseline`).
- `scripts/comment-density-baseline.json`: generated offender baseline.
- `package.json`, `.github/workflows/ci.yml`: `check:comment-density` script and CI step.
- `docs/rust-build.md`, `docs/PLAN.md`: gate list entry and #1322 row status.

## Design

- Both scanners return comment character ranges. A shared function turns ranges into line metrics: a line is a comment line when every non-whitespace character on it lies inside a comment. Blocks are runs of consecutive comment lines.
- TypeScript: parse with `ts.createSourceFile`, walk `getChildren()` and collect `ts.getLeadingCommentRanges` at each token's full start (every comment is leading trivia of some token, including end-of-file). JSX text nodes are skipped so `//` in JSX text is not read as a comment.
- Rust: single pass handling line comments, nested block comments, strings, raw strings (`r#"..."#`, `br`, `cr`), char literals versus lifetimes.
- Metrics per file: `commentLines`, `nonBlank`, `maxBlock`. Violation: `maxBlock > 6`, or `nonBlank >= 40` and `commentLines * 4 > nonBlank`.
- Baseline compare mirrors `check-file-size.mjs`: new violator fails; baselined file fails on growth of either number; stale entries are reported, not failed. `--write-baseline` records current offenders (and prunes stale ones) and is the only way to add entries.

## Constitution check

No UI, no IPC, no network, no new dependency (`typescript` is already a dev dependency). Reads files under the repo only.
