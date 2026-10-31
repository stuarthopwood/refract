# Plan: spec 089

Files: `scripts/check-literal-colours.mjs` (imports `scanTypeScriptComments` from `scripts/comment-density-scan.mjs`), `scripts/literal-colours-baseline.json`, `scripts/verify-tauri-083.mjs`, `scripts/comment-density-scan.mjs`, `scripts/check-comment-density.mjs`, `scripts/comment-density-baseline.json`, `docs/PLAN.md`. No Rust, no renderer.

Approach: blank each comment range with spaces (newlines kept) before regex counting; tighten the two hex regexes; add a rgb/hsl regex; track a range-end per character in `measureLines` so a line whose last content character sits inside a comment that continues past the line end counts as a comment line; fail on stale entries.

Verification: real `pnpm typecheck`, vitest, every `check:*` script, `tsc --checkJs` over changed scripts, scratch fixtures under the temp dir for each new rule, `pnpm ci:local` and `verify-tauri-083` at committed HEAD under the build slot.
