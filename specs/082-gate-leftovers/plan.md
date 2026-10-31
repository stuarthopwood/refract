# Plan: spec 082

Approach: small in-place edits to existing components, reuse `IconButton`, add one shared `FieldLabel`, widen two lint scripts around one shared file walk, and three small Rust tidies. No theme token files are touched.

Verification: `pnpm ci:local` (typecheck, tests, `check:*`, cargo fmt, clippy, test), then `scripts/verify-tauri-082.mjs` from the committed HEAD (debug exe, scratch data dir, own debugging port, screenshots, `report.json` gitHead), then the six-reviewer gate.

Risks: lint widening could flag existing code (baselines regenerated; hit-targets baseline unchanged). The Rust `image_save` loop is covered by existing tests.
