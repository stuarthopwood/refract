# Analysis: spec, plan and tasks (#2075)

Run by hand on 2026-11-19, after you absorbed the UI ruling (rulings 1-4, C1, H1-H10, M1-M9, L1-L5).

## Result

Consistent after the fixes below. No open gaps.

## Checks

- **FR coverage:** every FR-001 to FR-034 appears in the `tasks.md` Coverage line; every SC maps to T023 or T024.
- **Task traceability:** every task T002 to T025 cites at least one FR, SC or finding ID. T001 (gate) is done; T025 is the PR gate.
- **Terminology:** the spec, plan and tasks use "Split", "Chat pane", "Session" and "Document tab" as `CONTEXT.md` defines them. No "split view".
- **Reusable components (ADR 0003):** FR-025 lists the shared components; T003, T007, T008, T010 and T018 build on them, and none forks a component.
- **Docs style:** the spec folder uses second person, active voice and sentence-case headings.

## Gaps found and fixed

- FR-032 was out of numeric order and its wording was unclear; it now reads "Panel liveness" and T011 covers it.
- FR-020 pointed at a verification task that no longer exists (T015); it now names the Ctrl+N fallback announcer path, and T019 checks it.
- The old tasks had no task for the narrow-window note (M6); T021 and T020 now cover it.
- The old tasks had no docs task (M7); T022 covers it.
- Phase numbering and task IDs changed: the Coverage line was rewritten against the new IDs.

## Grounding facts verified against `81ecabf4`

| Claim | Result |
|---|---|
| Ctrl+Shift+H collides with an in-app chord | No. Existing chords: Ctrl+Shift+P, X, B, `\`, 0, and Ctrl+W, Ctrl+K, Ctrl+N. WebView2 behaviour stays a live check (T024). |
| `builtinActions.ts:129` is `toggle-right-pane` | Right (the `id` sits at line 129). `close-chat-pane` is at 117, its `when()` at 122; `focus-other-pane`'s `when()` at 144. |
| Rust `WIDTH_MAX` mirrors the renderer | Right: `right_pane.rs:14` is 520, mirroring `RIGHT_PANE_MAX_WIDTH_PX` (`right-pane-store.ts:7`). |
| M6: no window minimum | Confirmed. `tauri.conf.json` sets no `minWidth`; no `min_inner_size` anywhere in `src-tauri`. `lib.rs:280` opens at 1280 by 800, and `window_state.rs:17-18` (`MIN_WIDTH` 800, `MIN_HEIGHT` 500) clamps only a restored saved size at startup (line 91), so you can still resize below 800 px. The spec Grounding and edge cases say so. |
| `previewRequestSeq` | `file-explorer-store.ts:176`, keyed by Session only; the spec now says file tabs key it by Session and path. |
| `watcherRefCounts` | In both `GitChangesPanel.tsx:16` and `FileExplorerPanel.tsx:72`. |
| `init-stores.ts` guard | The restore guard is at line 320, not 319. |
| `navCollapsed` sync | `App.tsx:163`, not 161. |
| `GitChangesPanel.tsx:299` hand-built label | Right. |
| `FilePreviewPane.tsx:156` `role="region"` | Right. |
| `quickCreateFallback.ts:21` | Announcer call for the Ctrl+N fallback. |

## Left for implement time

Re-check every line number when the tasks start; the plan says so in its heading.

## Deviations found at implement time

- **T002 tab key (2026-11-19):** the plan says the tab id is a stable hash of the identity. The store keys tabs by the identity string itself (`file:<path>`, `diff:<group>:<path>`), so two identities can never collide on a hash. `documentTabDomId(id)` gives the DOM-safe hashed id (`doc-tab-<base36>`) for `aria-controls` and `aria-labelledby`, because a path can hold spaces and slashes. Later tasks use the identity string as the key and `documentTabDomId` only for DOM attributes.
