# Plan: spec 077

Renderer and docs only; no IPC, Rust or state changes.

1. Slice A: add `IconButton`, swap icon-only call sites, set tooltip delay.
2. Slice B: Manage sessions row actions to `icon-xs`.
3. Slice C: add tokens to `globals.css`, replace modifiers, add `check:alpha-modifiers` and its CI step.
4. Docs: `docs/design/components.md`, `foundations-tokens-theming.md`, `docs/PLAN.md`.
5. Verify: `pnpm ci:local`, `scripts/verify-tauri-077.mjs`, six-reviewer gate.
