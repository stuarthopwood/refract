# Tasks: Hide Sessions

Spec: `spec.md`. Plan: `plan.md`. No new tests (prototyping phase). Commit and push after every task. Safe deletion: literal absolute paths only. No cargo or tauri command until the director grants the build slot.

## WP-A Backend and shared
- [x] T1 `hiddenAt` on Session and SessionPatch; `sessions.setHidden` handler; IPC constant, bridge, API type.
- [x] T2 `showHidden` in `SessionListCollapse` (Rust settings, parse, IPC arg; shared model).

## WP-B Stores
- [ ] T3 `session-list-store.ts` showHidden state, setter, persist/restore. `sessions-store.ts` `setHidden`.

## WP-C Session list
- [ ] T4 `sessionDisplay.tsx` helpers and search; `sessionActions.ts` Hide/Unhide item.
- [ ] T5 Group filtering (Repository, Archived, empty Project), Hidden row look and accessible name.
- [ ] T6 `ShowHiddenToggle` with badge in the toolbar; announcement; focus rule.
- [ ] T7 Hide handler: toast with Undo, focus rules (`useHideSession.ts`).

## WP-D Other surfaces
- [ ] T8 Manage sessions Hidden tab and row marker. T9 Pane-header Hidden badge. T10 Remove repository check.

## WP-E Docs
- [x] T11 CONTEXT.md, patterns.md. [ ] T12 `docs/PLAN.md` #748 row.
