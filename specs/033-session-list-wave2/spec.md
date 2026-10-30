# Feature Specification: Session list (wave 2)

**Feature Branch**: `session-list-wave2`
**Status**: Draft
**Input**: One PR for the wave 2 "Session list" bundle in `docs/PLAN.md`: #1203, #1204, #731, #934, #646, #482, #887. Decisions: the grill comments on each issue (2026-10-15, 2026-10-23, 2026-10-29). Numbered 033 because 030 to 032 are taken on `origin/main`.

## Clarifications

### Session 2026-10-29 (wave 2 grill, Stuart)

- Q: BrandSpinner in the Working slot (#482)? -> A: In Icons mode the spinner is tinted with `--state-working`, so every state is colour-coded.
- Q: Live apply or Save/Cancel? -> A: Live apply.
- Q: Non-colour cue for Dots? -> A: Shape per state: Idle hollow ring, Working pulsing filled dot, Needs you filled dot with ring, Stopped small squarish dot, Unread response ring with inner dot; sr-only labels everywhere.
- Q: Scope of the setting? -> A: The shared `StateIcon` only; the Subagent panel and Transcript keep their own icons.
- #731: the unread-dot move and idle icon shipped (PR #902); the background-colour investigation concluded as "icon only, no tint". Nothing to build; the issue closes with this PR.
- #646: items 1 to 3 only (brand marks, three-way host classification, owner/repo tooltip). Backend is Rust. Refresh on Session create stays out.
- #887, #934, #1203, #1204: the earlier grills stand unchanged.

### Session 2026-10-29 (clarify, assumptions recorded without a question)

- Q: Manage sessions "Sort: Status" order? -> A: Needs you, Unread response, Working, Idle, Stopped (the existing `STATUS_ORDER`).
- Q: Pull requests and Issues adopting the shared header and toolbar? -> A: Not in this PR (#874, #504 own them); the components are built so they can.
- Q: Does Dots mode draw a trailing unread dot? -> A: No (#731 removed it).
- Q: Forced colours with a Project colour? -> A: The Project colour is dropped; system colours apply.

## User Scenarios and Testing

### User Story 1 - Readable group headers and status icons (P1)

1. **Given** the Session list, **Then** Project and Archived group headers and their counts are 14 px, medium weight, muted, with the chevron (#1203).
2. **Given** a stopped Session anywhere the shared status icon shows, **Then** it is `CirclePauseIcon` in `text-state-stopped` (#1204).

### User Story 2 - Session status style (P1)

1. **Given** Settings > Appearance, **Then** a radio group offers Icons (default) and Dots with a preview of all five states in the active theme; choosing applies live and persists (#482).
2. **Given** Dots, **Then** each state has a distinct shape and an sr-only label.

### User Story 3 - Project colour (P2)

1. **Given** a Project header, **When** I choose "Colour..." in its menu, **Then** a popover offers 10 presets, a hex field, a picker, a live preview and Reset; Apply saves, Cancel or Esc reverts (#887).
2. **Given** any colour under 4.5:1 on the current theme, **Then** the nearest passing shade is drawn and "Adjusted for readability" shows.

### User Story 4 - Host brand marks (P2)

1. **Given** a Project whose remote is github.com, gitlab.com or bitbucket.org, **Then** its header shows that brand mark; any other remote keeps the generic remote icon; no remote keeps the local-only icon.
2. **Given** a remote, **Then** the tooltip reads "Git repository, remote: {host}/{owner}/{repo}" with credentials never sent over IPC (#646).

### User Story 5 - Manage sessions on shared components (P2)

1. **Given** Manage sessions, **Then** it uses `ScreenHeader`, `ListToolbar` (All/Active/Archived tabs, Project select, Sort select, `SearchField`), 32 px controls, a plain count line, and the Session list's row component extended with Project, last active and Archive columns (#934).
2. **Given** Manage sessions, **Then** each row is the shared `SessionRow` (the component the sidebar list uses) in its `table` layout, not a second row implementation; it keeps the same visible columns (state, name and branch, Project, flags, last active) and the same Archive/Restore quick action, "..." menu, right-click menu, rename, delete and focus behaviour; `ManageSessionRow` shrinks to a thin wrapper that supplies the Manage-only slots and callbacks (#934, converge amendment 2026-10-30).
3. **Given** the sidebar Session list, **Then** it looks and behaves exactly as before the row reuse.

## Requirements

- **FR-001** Group headers use `text-sm` (#1203). **FR-002** Stopped uses `CirclePauseIcon` (#1204).
- **FR-003** `Settings.statusStyle: 'icons' | 'dots'`, default icons, persisted; `StateIcon` is the single change point (#482).
- **FR-004** Presets `--project-1..10` per theme meet 4.5:1; `Repository.color` optional, `repositories.setColor` in `repositories_color.rs` (#887).
- **FR-005** `RepositoryRemote` gains a known-host variant; owner/repo parsed in Rust; userinfo stripped (#646).
- **FR-006** `ScreenHeader`, `ListToolbar` shared components; `TabsList` is 32 px app-wide (#934).
- **FR-009** `SessionRow` takes a discriminated `layout` (`list` default, `table`); `useSessionRowActions` takes an optional `SessionRowSurface` (terminal focus fallback, announce, open, created) for the Manage-only differences; no row markup or row action logic is duplicated in `features/profile/` (#934).
- **FR-007** No file crosses 600 lines; the file-size baseline never grows.
- **FR-008** Verified live in Dark, Dark (high contrast) and one accent theme.
