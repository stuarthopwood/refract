# Plan

1. Rust: `session/readout_pr.rs` (negative cache, warn log, url cap, `unknown` issue state); `src/shared/model.ts` issue state.
2. Renderer: `StatePill` subtle variant, `chat/header/*`, shared pinned shell, `pinned-panels-store.ts`, shared selector constant, check display map out of `PullRequestRow`, theme focus token if under 3:1.
3. Scripts: older fake `gh` scripts to the GraphQL shape; `scripts/verify-tauri-101.mjs` live check.
4. Gate: `pnpm ci:local`, live check, six-reviewer gate.
