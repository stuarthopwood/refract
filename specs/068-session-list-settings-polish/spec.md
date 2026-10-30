# Spec 068: Session list and Settings polish batch (#1422, #1416, #1418, #1420, #1428, #1424)

Six small p1 fixes in one branch. Each issue's own text is the requirement; this file records the grill outcomes and the choices the issues left open.

## Clarifications

### Session 2026-10-30 (self-grill against CONTEXT.md, docs/adr and the code; Stuart is away)

- Q: #1422, does `focus-within` or `:has(:focus-visible)` drive the keyboard fill? A: `has-[:focus-visible]`. Plain `focus-within` leaves the fill on after a mouse click on a button. [ui-architect-v3 ruling]
- Q: #1422, forced-colors? A: the row gets a `Highlight` outline on hover and keyboard focus, because forced colors removes the fill. [ui-architect-v3 ruling]
- Q: #1422, where does the shared fill live? A: a `GroupHeaderRow` component beside `GroupHeaderTrigger` in `GroupHeader.tsx`, used by the Repository, Archived and Git changes headers. It forwards its ref and props so `ContextMenuTrigger asChild` still works, and takes `plain` to drop the fill while renaming.
- Q: #1416, how is the reset triggered? A: an effect in `ShowHiddenToggle` that fires on the hidden count moving from at least one to zero while Show hidden is on, plus one check in `init-stores.ts` right after `restore()` when the Sessions loaded (`sessionsLoad.ok`) and none is hidden. A component-level check alone would fire against the `[]` fallback or before hydration and erase a valid persisted flag.
- Q: #1416, focus? A: if the toggle holds focus when it unmounts, focus moves to "Collapse all groups" through one helper shared with the existing off path.
- Q: #1418, anything open? A: no. `outline` becomes `ghost` on both buttons.
- Q: #1420, where is the shared definition? A: `src/renderer/components/revealAction.ts` exports the label, the icon and a name builder. `path-actions.tsx`, `SessionDetailsCard.tsx`, `sessionActions.ts` and `FileLinkButton` read it. The Session row menus already take icons through the shared menu item prop from #1440, so `sessionActions.ts` is the single place for both row menus.
- Q: #1420, accessible-name format? A: the bare label everywhere except the chat file link, which adds `: <name>`. The Session details card shows the path directly above its button and the Session row menu belongs to its row, so a target suffix would be read twice. The file explorer panel's other two icon buttons (Open in VS Code, Copy path) are bare too, so Show in File Explorer stays bare there for consistency. [ui-architect-v3 ruling, with the panel buttons left bare]
- Q: #1420, docs? A: `docs/design/foundations-icons.md` and `product-layout.md` name the old labels and are updated.
- Q: #1428, new tone or reuse `working`? A: `working` is used only by the Agents badge (`git grep tone=`), so it is replaced by `accent` (`bg-primary text-primary-foreground`); the `forced-colors:border-[CanvasText]` stays. Contrast passes AA in every theme per the architect's check. In the Default dark theme the pill is near-white; checked visually in the live run.
- Q: #1424, preview model? A: removed entirely. Choosing a Theme or Chat width calls `save`; `previewing`, `preview` and `cancelPreview` go from both stores, along with the Save/Cancel row, the dirty-group focus logic and the Escape handler. The `theme.preview` IPC channel stays in the Rust bridge for parity (no renderer caller). No live-region announcement is added: the radio group already announces the selection. Failures still go through `notify`. [ui-architect-v3 ruling]

## Functional requirements

- FR-1 (#1422): hovering anywhere on a project, Archived or Git changes header row shows one `rounded-md bg-sidebar-accent` fill; a hovered action button keeps `hover:bg-sidebar-border`; the trigger has no fill of its own; no fill while renaming; layout and `GROUP_HEADER_ACTIONS_*` unchanged.
- FR-2 (#1416): Show hidden turns itself off when the hidden count drops to zero and at start-up when nothing is hidden; focus lands on Collapse all groups if the toggle held it.
- FR-3 (#1418): Copy path and Show in File Explorer use `variant="ghost"`, `size="xs"`.
- FR-4 (#1420): every reveal action reads "Show in File Explorer" with `FolderOpenIcon`; no user-facing "Reveal in File Explorer", "Open in file explorer" or "Open worktree folder" remains.
- FR-5 (#1428): the Agents badge fills with `bg-primary text-primary-foreground`.
- FR-6 (#1424): Appearance shows no Save or Cancel; Theme and Chat width save on choice.

## Success criteria

- `pnpm ci:local` and `pnpm check:ui-text` pass; live screenshots show each change.
