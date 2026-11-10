# Implementation Plan: Session usage panel scope and range toggles

**Spec**: `specs/123-session-usage-scope-1743/spec.md` | **Issue**: #1743

## Technical context

Rust (rusqlite) usage queries in `src-tauri/src/usage/`, prefs in `src-tauri/src/ipc/usage_prefs.rs`; TypeScript contract `src/shared/ipc-usage.ts`; per-Session store `src/renderer/state/session-usage-store.ts`; panel `src/renderer/features/usage/SessionUsagePanel.tsx`. No schema change and no new IPC channel.

## Design

**Rust.**
- `Filters.session_file: Option<String>` (`queries.rs`). `queries_session.rs` gains `file_clause(w, file, column)`: `lower(replace(column, '/', '\')) = ?` with the bound value folded the same way as `clause`; an empty value is `InvalidArgument`. `Filters::session_clause` ANDs the directory and file clauses; `session_scoped()` and `needs_tool_calls()` treat either as a Session scope so rollup tables (which carry no session column) are bypassed.
- `usage_prefs.rs`: keys `sessionScope` and `sessionRange`, allowlisted (`session|conversation`, `all|today`). `read_choice` returns a stored value or default; `patch_choice` rejects anything else with `invalid-argument`. `usage.getPrefs` returns both, `usage.setPrefs` writes the ones present.
- `today` already starts at local midnight from the request's offset (`Filters::window`), so nothing changes there.

**Contract.** `ipc-usage.ts`: `UsageSessionScope`, `UsageSessionRange`, `UsageFilters.sessionFile`, `UsagePrefs.sessionScope/sessionRange`, `setPrefs` patch keys. `specs/060-usage-view/contracts/ipc.md` rows updated.

**Renderer.**
- `session-usage-store.ts`: `scope` and `range` state, loaded once from `getPrefs` before the first refresh; `setScope`/`setRange` update state, call `setPrefs`, and refresh the watched target. `refresh` and `showMore` take a `SessionUsageTarget { sessionDir, sessionFile }`. Entries are keyed by `entryKey` (Session dir, Conversation file when `effectiveScope` is Conversation, range). The Usage view's offset expression is used inline. Today buckets the timeseries by hour. The credit-period query ignores range, keeps scope.
- New `SessionUsageToggles.tsx`: two shared `ToggleGroup`s (`type="single"`, `size="sm"`, `aria-label`), Conversation `disabled` when there is no Conversation file.
- `SessionUsagePanel.tsx`: reads `currentConversation` from the Sessions store, memoises the target, mounts the toggles above the body, adapts the empty-state text and passes `bucket` to the compact chart.

**Docs.** `docs/PLAN.md` row for #1743 and ipc contract rows.

## Files the implementation touches

Rust: `usage/queries.rs`, `usage/queries_session.rs`, `usage/queries.test.rs`, `ipc/usage_prefs.rs`.
TS: `shared/ipc-usage.ts`, `state/session-usage-store.ts`, `features/usage/SessionUsagePanel.tsx`, new `features/usage/SessionUsageToggles.tsx`.
Docs: `specs/060-usage-view/contracts/ipc.md`, `docs/PLAN.md`, this spec folder.

## Constitution and repo rules

No new TS tests (prototyping); comments "why" only; 600-line cap; shared `ToggleGroup` reused (ADR 0003); `cargo`, `ci:local` and the live check are pending the build slot.

## Risks

- `ToggleGroup` items that are disabled still need a visible reason: a `title` is added.
- A new Conversation changes the target and triggers a refresh; the sequence guard in the store drops the superseded one.
