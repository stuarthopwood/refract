# Plan: Hide Sessions

Spec: `spec.md`. Constitution check: Principle V unaffected (no capability or CSP change); ADR 0003 respected (extend `Toggle`, `CountBadge`, `Badge`, `sessionActions.ts`; no one-offs).

## Backend (Rust, `src-tauri/`)
- `store/registry.rs`: `Session.hidden_at`, tri-state `SessionPatch.hidden_at`.
- `ipc/sessions_visibility.rs` (new, small): `sessions.setHidden`. Registered in `ipc/mod.rs`.
- `store/settings.rs`, `settings_parse.rs`, `ipc/settings.rs`: `showHidden` in `SessionListCollapse`.

## Shared and bridge
- `src/shared/model.ts` (`hiddenAt`, `showHidden`), `src/shared/ipc.ts` (`SESSIONS_SET_HIDDEN`, `setHidden`), `src/tauri-bridge/index.ts`. Both big files stay at baseline.

## Renderer
- `session-list-store.ts`: `showHidden`, setter, persist/restore. `sessions-store.ts`: `setHidden`.
- `sessionDisplay.tsx`: hidden counting helper, `searchSessions` includes hidden and tags.
- `sessionActions.ts`: Hide/Unhide item. `useSessionRowActions.ts` (587 lines): the Hide flow lives in a new `useHideSession.ts`.
- `SessionRow.tsx`, `RepositoryGroup.tsx`, `ArchivedGroup.tsx`, `SessionList.tsx`: filtering, look, toggle in the toolbar (new `ShowHiddenToggle.tsx`).
- Manage sessions: `manageSessionsHelpers.ts`, `ManageSessionsToolbar.tsx`, `ManageSessionRow.tsx` (at baseline; no net growth). `view-store.ts` archive filter gains `hidden`.
- `ChatPane.tsx` (at baseline): the badge lives in a new `HiddenBadge.tsx` used from `ChatHeader.tsx`.
- `RemoveRepositoryDialog.tsx`: counts already include all Sessions of the Project; verify only.

## Verification
Typecheck, vitest, lint, `check:file-size` without the build slot; cargo, `ci:local` and the live check once granted.
