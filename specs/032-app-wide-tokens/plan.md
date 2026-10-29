# Plan: App-wide design tokens (wave 1)

Spec: `spec.md`. One PR, built in five disjoint slices (S1 to S5) that touch different files; shared files (`globals.css`, `docs/design/*`) get small edits in separate regions.

## Token API (documented in `docs/design/foundations-tokens-theming.md`)

- Radius: `--radius` 0.25rem; scale `rounded-sm` 2.4, `rounded-md` 3.2, `rounded-lg` 4, `rounded-xl` 5.6 px. Functional circles use `rounded-full` and are listed in the doc.
- Weight: colour utilities `.text-muted-foreground`, severity and accent text carry one weight step above the base weight (FR-004).
- Surfaces: `--titlebar` (per theme) and a shared `titlebar-surface` class; `--divider` for decorative lines; `--border` for control edges.
- Menus: one exported item class constant in `components/ui/menu-item-classes.ts` used by both menu primitives.
- Tabs: `--accent-text` active underline, shared where a tab primitive exists.

## Slices

| Slice | Issues | Main files |
| --- | --- | --- |
| S1 radius and pills | #843, #1144 | `globals.css` radius block, `components/ui/{button,toggle,select,toggle-group}.tsx`, each `rounded-full` site, `CommandPillOverlay`, `AttachmentStrip`, `QueuedChipList`, `StatePill`, `ChatHeader`, design docs |
| S2 weights | #1267 | `globals.css` weight block, `Markdown.tsx`, `kbd.tsx`, `ChangesTab.tsx`, `MessageInput.tsx` comment |
| S3 menus, tabs, dividers | #1124, #1125, #1073, #1065 | `dropdown-menu.tsx`, `context-menu.tsx`, `GitChangesFileRow.tsx`, `PullRequestDetail/List.tsx`, `PanelTabBar.tsx` (underline only), settings separators, `AskCard.tsx`, `MergeDialog.tsx`, `theme-contrast-pairs.mjs`, spec 008, `components.md` |
| S4 Chrome band | #682 | `globals.css` token, `themes.ts`, `titleBarOverlay`/Tauri overlay, `App.tsx`, headers, `check-theme-contrast.mjs` |
| S5 grip and polish | #738, #1270 | `components/ui/resizable.tsx`, `PanelTabBar.tsx` (count collapse), `panel-registry.ts`, `AddRepositoryDialog.tsx`, `AlertRow.tsx`, `select.tsx` (nits only), stale comments, `specs/013-right-pane-shell/tasks.md` |

## Risks

- `globals.css` and `PanelTabBar.tsx` are shared by slices; edits are small and in separate regions, and the director re-reads the file after each slice.
- File-size baseline: no file may grow past its entry.
- Radius change must not change layout; verified by screenshots.
