# Plan: spec 085

## Technical context

Tauri v2 (Rust, `src-tauri/`) with a React renderer (`src/renderer`). Shared components live in `src/renderer/components`; lint gates are `scripts/check-*.mjs` run by `pnpm ci:local`. No theme token files are touched.

## Constitution check

- Principle V (Tauri security baseline): display names get stricter. No new IPC, no new capability.
- Reusable components: every changed control stays on `IconButton` or `Button`; the inset outline becomes one shared constant.
- No god files: touched files stay under 600 lines or within their baseline; comment density gate passes.
- No new tests: verified by the live check instead.

## Design

- `components/ui/focus-classes.ts` exports `INSET_FOCUS_OUTLINE_CLASS`; `cn()` (tailwind-merge) lets it override the base Button forced-colors offset.
- `button.tsx` base class: `active:not-aria-[haspopup]:not-aria-disabled:translate-y-px`.
- Local `aria-disabled:pointer-events-none` removed in the sites listed in `tasks.md`; each site's own click handler already returns early when busy.
- Rust: `truncate_display_name` filters `is_control()` plus an explicit set of Unicode format/bidi code points, then the profile fetch filters an empty result to `None`.
- Live check follows `verify-tauri-082-ui.mjs`: fake `omp`, scratch `REFRACT_DATA_DIR`, own debugging port.
