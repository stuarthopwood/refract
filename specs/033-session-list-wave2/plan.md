# Plan: Session list (wave 2), spec 033

## Slices (two workers in parallel, disjoint files)

**Worker 1: group header** (`features/sessions/GroupHeader.tsx`, `RepositoryGroup.tsx`, `ArchivedGroup.tsx`, `src-tauri/src/ipc/repositories*.rs`, registry model, `src/shared/model.ts` repository fields, `globals.css` project tokens)
- #1203 header `text-sm`.
- #646 `@tabler/icons-react` per-icon imports; widen `RepositoryRemote`; parse owner/repo in the Rust remote module; tooltip.
- #887 `Repository.color`, `repositories_color.rs`, tokens `--project-1..10`, contrast helper, picker popover, header menu "Colour...".

**Worker 2: status and Manage sessions** (`sessionDisplay.tsx`, Settings Appearance section, `settings.rs`, `src/shared/model.ts` Settings fields, `features/profile/Manage*`, `components/ScreenHeader.tsx`, `components/ListToolbar.tsx`, `components/ui/tabs.tsx`)
- #1204 `CirclePauseIcon`.
- #482 `statusStyle` setting (Rust settings field with serde default, no migration needed), Dots shapes in `StateIcon`, preview component, Appearance control.
- #934 `ScreenHeader`, `ListToolbar`, shared `SearchField` use, shared Session row with extra-column slots, 32 px `TabsList`, wording (Project not repository).

## Constraints
- Shared component changes are additive (new prop or slot) and named in the report.
- Colours only via tokens; the custom hex is validated user data applied as an inline custom property.
- No new tests. Existing tests stay green.
- Rust commands use the shared cargo env.
