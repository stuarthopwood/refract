# Plan (spec 097)

- New `components/ui/input-with-action.tsx`: `InputWithAction` (relative wrapper, `Input` with `pr-8`, children overlay slot) and `InputActionButton` (ghost `icon-xs`, `absolute right-1 top-1`, composer focus classes). `SearchField` and `SecretInput` build on it.
- `ui/button.tsx`: ghost variant gains the card-footer dark hover. `RequestCard` and `AskCard` drop their overrides.
- `RequestCard`: Cancel in the footer for every question kind; error alert `role="alert"`; refocus the originating control when focus is stranded after a failed answer.
- `StopBanner`: `aria-labelledby` on the title (PaneBanner gets a `titleId` prop); bottom padding on the wrapper.
- `useComposerFocusHandoff`: lazy `pane`/`active`, pane fallback.
- `scripts/verify-tauri-092.mjs`: hardening per FR-10.
- Verification: typecheck, vitest, `check:*`, `ci:local`, `verify-tauri-092.mjs` on the pushed HEAD.
