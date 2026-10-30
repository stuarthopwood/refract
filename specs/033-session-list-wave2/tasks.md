# Tasks: spec 033

## Worker 1
- [x] T001 #1203 GroupHeader and ArchivedGroup header and count to `text-sm`.
- [x] T002 #646 add `@tabler/icons-react`; widen `RepositoryRemote` (Rust + `src/shared/model.ts`); parse owner/repo; brand marks; tooltip; update `docs/design/foundations-icons.md`.
- [x] T003 #887 Rust `color` field and `repositories_color.rs`; preset tokens in `globals.css`; contrast adjust helper; popover and picker; header menu entry; forced-colors drop.

## Worker 2
- [x] T004 #1204 `CirclePauseIcon` in `StateIcon`.
- [x] T005 #482 `statusStyle` setting (Rust + shared model + store), `StateIcon` Dots, tinted Working spinner, Appearance radio group and preview.
- [x] T006 #934 `ScreenHeader`, `ListToolbar`, `TabsList` 32 px, Manage sessions rebuild, shared row, wording.

## Converge amendment (#934 row reuse, 2026-10-30)
- [ ] T008 Move `canResume`/`handleResume` out of `useSessionRowActions.ts` into `useSessionResume.ts` unchanged (frees line budget under the 600 cap).
- [ ] T009 `useSessionRowActions` accepts `repository | undefined` and an optional `SessionRowSurface` (`fallbackFocus`, `announce`, `open`, `onCreated`); sidebar behaviour unchanged when absent.
- [ ] T010 `SessionRow` gains the `table` layout (slots: Project name, flags, last active, Archive/Restore quick action); the cells live in `SessionRowTableCells.tsx`.
- [ ] T011 `ManageSessionRow` becomes a thin wrapper over `SessionRow`; delete its duplicated markup and handlers; `ManageSessionsScreen` unchanged in behaviour.
- [ ] T012 Docs: `components.md` row entry, PLAN.md #934 rows set to done.

## Director
- [x] T007 Gate (five reviewers), fixes, build slot, `pnpm ci:local`, live check, PR, PLAN.md row, follow-up issue.
