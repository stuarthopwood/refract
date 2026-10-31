# Plan: spec 087

## Technical context

Tauri v2 (Rust, `src-tauri/`) with a React renderer (`src/renderer`). Shared components live in `src/renderer/components`; lint gates are `scripts/check-*.mjs` run by `pnpm ci:local`. No theme token files are touched.

## Constitution check

- Principle V (Tauri security baseline): `is_openable` gets stricter and the parser is capped; removing `theme.preview` shrinks the IPC surface. No new IPC, no new capability.
- Reusable components: the fixes extend `LoadingOverlay`, `CompactList`, `GroupHeader` and `revealAction` rather than adding one-offs.
- No god files: touched files stay under 600 lines or within their baseline; the comment density gate passes.
- No new tests: verified by the live check instead.

## Design

- `LoadingOverlay` holds a small `useDelayedFlag(loading, 150)` so blur and card show late; `aria-busy` and `inert` follow `loading` directly.
- `GroupHeader.tsx` exports `HEADER_ACTION_BUTTON_CLASS`; `RepositoryGroup` and `GitChangesGroup` import it.
- Autosave stale guard: a per-store monotonically increasing request counter; a result applies only if it is the latest.
- Announcements use `useChatAreaAnnouncer.getState().announce`.
- Rust: `is_openable` compares `file_name()` to the basenames of `FILE_NAMES`; `parse_advisors` takes `text.lines().take(MAX_LINES)` first.
- `theme.preview` removal follows the grep of renderer, scripts, capabilities and tests.
- Live check follows `verify-tauri-085.mjs`: fake `omp`, scratch `REFRACT_DATA_DIR`, own debugging port, scratch `PI_CODING_AGENT_DIR` holding a `WATCHDOG.yml` for the Settings Advisor warning.
