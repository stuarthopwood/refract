# Implementation Plan: Composer `#` picker (#1789)

**Spec**: [spec.md](./spec.md) | **Branch**: `feat/1789-hash-picker`

## Approach
Isolate the feature in new files so a merge with PR #1837 (which also edits `MessageInput.tsx` and `useSlashMenuCompletion.ts`) is trivial; `MessageInput.tsx` only gains one hook call, one key-routing line, one mount and the combobox ARIA merge.

## Backend (Rust)
- `src-tauri/src/github/item_ref.rs`: `search_items(repo_path, slug, query)`. `sanitize_query` keeps letters, digits, `.`, `_`, `-`; `search_query` always starts `repo:owner/repo`; one `gh api search/issues` with `per_page=10` and a 15 s timeout; a digits-only query adds one exact lookup pinned first and de-duplicated; result capped at 10. Rust tests cover query building, hostile input and parsing.
- `src-tauri/src/ipc/item_refs.rs`: `itemRefs.search(repositoryId, query)`; the slug always comes from the Project's own remote.

## Shared contract and bridge
- `src/shared/ipc-item-refs.ts`: `ItemSummary` and `ItemRefsApi.search`; `tauri-bridge` request entry.

## Renderer
- `hashTrigger.ts`: pure trigger parser over the text before the caret (start or whitespace, no mid-word, no inline code, no code fence, no whitespace in the query).
- `useHashPicker.ts`: owns open/active index/Escape dismissal, debounced search with stale-response drop, key handling (Up, Down, Enter, Tab, Escape), insertion of `#N ` and caret placement, the live announcement, and the combobox ARIA values. Disabled when the Project has no GitHub remote or the slash menu shows.
- `HashPicker.tsx`: listbox rows (state icon plus word, `#number`, title) and loading, empty and error rows via `InlineStatus`.
- `SlashMenu.tsx`: exports the shared popover, list and row classes (no copy).

## Verification
Typecheck and node checks now; Rust compile, `ci:local` and a live check once the build slot is free.
