# Plan: spec 098

Specify route, chore-sized. Clarifications are the issue's decided comment (no open questions).

- Renderer: `button.tsx` variant neutralisers plus base cursor and forced-colors; remove copies in `SessionDetailsCard`, `SideChatPanel`, `QueuedChipList`, `LongConversation`, `pickerShared`, `ComposerBox`; `CompactList`, `callLogRow`, `GitChangesFileRow`, `ShowHiddenToggle`, `RepositoryGroup`, `IconButton`, `App`, `ProfileItem`, `theme-store`.
- Rust: `src-tauri/src/omp/advisor_roster.rs` (`same_path`, `NAMES_LONGEST_FIRST`).
- Script: `scripts/verify-tauri-091.mjs`.
- Risk: a variant neutraliser resets hover to the variant's own base colour, so a caller that overrides the base colour must add its own `aria-disabled:hover:bg-*`. Audited `aria-disabled` callers: only the composer send button does.
