# Plan: spec 082

## Technical context

Tauri v2 (Rust, `src-tauri/`) with a React renderer (`src/renderer`). Shared components live in `src/renderer/components`; lint gates are `scripts/check-*.mjs` run by `pnpm ci:local`. No theme token files are touched.

## Constitution check

- Principle V (Tauri security baseline): `image_save` still writes only inside the validated destination; the temp name loop uses `create_new` and never follows an existing file. Display names are stricter, not looser.
- Reusable components: every changed control is built from `IconButton`, `Button` or the new shared `FieldLabel`; no one-off buttons.
- No god files: all touched files stay under 600 lines or within their baseline. Comment density gate passes.
- No new tests: verified by the live check instead.

## Design

1. Renderer controls: swap hand-built buttons for `IconButton` in `ChatHeader.tsx`, `PanelTabBar.tsx`, `MessageMenu.tsx`. `IconButton` supplies the tooltip, aria-label, minimum target and optional shortcut hint.
2. Alarm popover: `FieldLabel` plus an `errorId` wired through `aria-describedby`; error state cleared on edit and on form open.
3. Lint: one shared `rendererTsxFiles()` walk; widen the two regexes; regenerate baselines (`icon-only-controls` shrinks, `split-button.tsx` is added at 1; `hit-targets` unchanged).
4. Rust: `truncate_display_name` (strip control characters, then cap) shared by `github/profile.rs` and `store/profile_cache.rs`; `image_save` temp-name retry loop; remove a pass-through wrapper in `github/cli.rs`.
5. Docs and specs: spec 079 amendments, plan-template advisory items, `docs/design/components.md`, `docs/PLAN.md` row.

## Verification

`pnpm ci:local` (typecheck, tests, every `check:*`, cargo fmt, clippy, test) under the build slot with `CARGO_TARGET_DIR=C:\Users\shopwood\.cargo-target\refract`, `CARGO_BUILD_JOBS=4`, `CARGO_INCREMENTAL=0`. Then `pnpm exec tauri build --debug --no-bundle`, and `scripts/verify-tauri-082.mjs` from the committed HEAD with a scratch `REFRACT_DATA_DIR` and its own debugging port; `report.json.gitHead` must equal HEAD. Then the six-reviewer gate.

## Risks

- Lint widening flags existing code: mitigated by regenerating baselines; the hit-targets baseline did not change.
- `image_save` loop: bounded at 8 attempts; a failure returns the original `AlreadyExists` error.
- ChatHeader re-indent is large in the diff but behaviour-neutral; the live check asserts size, name and shortcut hints.
