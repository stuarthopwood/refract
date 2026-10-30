# Spec 064: Command palette and shared action registry, slice 1 (#5)

Ctrl+K (alias Ctrl+Shift+P) opens a modal palette over one fuzzy list grouped as Sessions, Conversations, Actions, Settings, and Pull requests and Issues. A leading `>` filters to Actions only. Every action comes from one shared action registry that the palette and the Keyboard shortcuts dialog read. Slice 1 of 2: context menus and the native app menu reading the registry are slice 2 and are not built here.

## Clarifications

### Session 2026-10-30 (answers from the #5 grill, Stuart)

- Q: Which chords? A: Ctrl+K, alias Ctrl+Shift+P. Both were unbound.
- Q: What does the list hold? A: Sessions, Conversations, Actions, Settings sections, and Pull requests and Issues, in one fuzzy list. `>` first shows Actions only.
- Q: Where do commands come from? A: One action registry (id, label, chord, when-enabled, run), read by the palette and the shortcuts dialog now, and designed so context menus and the app menu read it in slice 2.
- Q: Which actions first? A: New session, Open Settings, Stop, Close chat pane, collapse the right pane, Pause and Resume, Pause all, New session from an issue or pull request (#1310), Rewind and Fork (#696), registering only those whose behaviour exists on main.
- Q: Accessibility? A: Modal combobox with listbox, arrow keys, Enter, Esc, focus returned to the invoker, group names announced, chords shown as text (WCAG 2.1.1, 2.4.3, 4.1.2).
- Q: Slicing? A: Slice 1 is the registry, the palette and the shortcuts dialog reading it. Slice 2 is the context menus and `shell/menu.rs`.

### Session 2026-10-30 (agent decisions, no questions could be asked)

- Q: Ctrl+K already applies a link in the Markdown composer toolbar. [Confirmed by Stuart, 2026-10-30] The palette ignores a Ctrl+K that the editor already handled (`defaultPrevented`); Ctrl+Shift+P opens the palette everywhere.
- Q: Do the existing window-level handlers (Ctrl+N, Ctrl+W, Ctrl+, and so on) move onto the registry? [Confirmed by Stuart, 2026-10-30] No. They keep their own guards; the registry holds the chord as display metadata and the palette's own chords are dispatched from the registry. Rewiring every handler risks regressions in the live-tested guards and is left to slice 2.
- Q: Which Sessions appear? [Confirmed by Stuart, 2026-10-30] Sessions that are not archived and not hidden; selecting one opens it in the focused pane (the same call as Home's session rows).
- Q: Which Conversations appear? [Confirmed by Stuart, 2026-10-30] The Conversations of the Session in the focused pane, loaded when the palette opens. Selecting the current one just closes the palette; another one opens it only while the Session is idle or stopped, matching the existing Conversation switcher.
- Q: Which pull requests and issues appear? [Confirmed by Stuart, 2026-10-30] Only those already loaded in the pull request and issue stores. The palette never starts a GitHub fetch. Selecting one opens the view with that item selected.
- Q: New session from a pull request, with the fork warning? [Confirmed by Stuart, 2026-10-30] Not registered. The list items do not know whether a pull request is from a fork, and the palette must not bypass the fork warning in `PullRequestDetail.tsx`. Selecting a pull request opens its detail, where New session lives.
- Q: Pause and Resume wording? [Confirmed by Stuart, 2026-10-30] Two actions, "Pause session" and "Resume session", for the focused Session, enabled by its pause state; "Pause all" and "Resume all" follow `PauseAllButton`'s rule.
- Q: Is the existing Open Usage entry kept? [Confirmed by Stuart, 2026-10-30] Yes. `usageViewAction.ts`, which waited for this palette, is replaced by a registry action `open-usage`.
- Q: Ranking and the `>` prefix? [Confirmed by Stuart, 2026-10-30] cmdk's built-in fuzzy scoring; `>` is stripped before scoring and hides every section but Actions. An empty query shows Actions, then Sessions, Conversations, Settings, Pull requests and Issues, with no more than 50 rows rendered per section.

## Functional requirements

- FR-1: An action registry module exposes `registerActions`, `getActions`, `findAction` and `isActionEnabled`. An action has `id`, `label`, `group`, optional `chord` and `aliasChord`, `when()` and `run()`.
- FR-2: Built-in actions register on app start: `new-session`, `open-settings`, `open-usage`, `stop`, `close-chat-pane`, `toggle-right-pane`, `pause-session`, `resume-session`, `pause-all`, `resume-all`, `open-palette`.
- FR-3: Ctrl+K and Ctrl+Shift+P open the palette from the chat, Home, pull request, issue, usage and Settings views, never on the Readiness screen, and toggle it closed when it is open. Other window-level chords stay suppressed while it is open (it is a `role="dialog"`).
- FR-4: The palette is a Dialog containing a shadcn `Command` (`cmdk`) with an input (`role="combobox"`, `aria-activedescendant`), a listbox, and sections announced by name. Arrow keys move, Enter runs, Esc closes.
- FR-5: Focus returns to the element that had it before the palette opened, unless the chosen action moved focus itself.
- FR-6: Actions show their chord as text (`Ctrl+Shift+X`). A disabled action (its `when()` is false) is not listed.
- FR-7: Typing `>` first lists Actions only and scores the text after the `>`.
- FR-8: The Keyboard shortcuts dialog builds its rows from the registry's chords, grouped by `group`, plus a short list of contextual keys that are not actions (Enter, Shift+Enter, Esc, Space, Ctrl+Click). Its Ctrl+K note is replaced by the real chords.
- FR-9: `docs/design/index.md` Keyboard table and `docs/PLAN.md` list the new chords and the status.

## Success criteria

- SC-1: Ctrl+K opens the palette, typing `new` ranks New session first, Enter creates a Session, and focus lands where Ctrl+N would put it.
- SC-2: A screen reader announces the combobox, the active option and the section names; the palette is fully operable without a pointer.
- SC-3: Every chord shown in the shortcuts dialog's registry rows is a registry action with a `run`.
- SC-4: `pnpm typecheck`, `pnpm test` and every runnable `pnpm check:*` pass.

## Edge cases

- No Session exists: Sessions and Conversations sections are empty and hidden; Actions and Settings still list.
- The focused Session is working: Conversations are listed but selecting another one announces a wait message through the chat-area live region instead of switching.
- Empty result: the listbox shows a "No results" text, announced politely.
- `conversations.list` fails: the Conversations section is omitted and a notice is raised through `notify`.

## Gaps (behaviour not on main, not built here)

- Rewind and Fork (#696): there is no Rewind or Fork behaviour; `/fork` is only a reserved name. Not registered.
- New session from an issue (#1310): no issue-to-Session path exists. New session from a pull request exists only inside `PullRequestDetail.tsx` behind the fork warning, so it is not registered (see decision above).
- Collapse of the session list (Ctrl+B, #453) has no handler; not registered.

# Slice 2: menus read the registry, chords route through it, icons, native-menu block (#5, #1404, #1405)

Slice 1's registry now also drives context menus and dropdowns, the window-level chord handlers, and menu icons. The deferred slice 1 items land here.

## Slice 2 clarifications

### Session 2026-10-30 (answers from the #5 grill, #1404 and #1405, Stuart)

- Q: What does slice 2 cover? A: Menu-item builders on the registry; every existing context menu and dropdown moved onto them with no behaviour change; the `App.tsx` chord handlers routed through the registry; `shell/menu.rs` dispatching through the registry where an item maps; #1404 and #1405 folded in.
- Q: Ctrl+K in the Markdown editor? A: Still inserts a link (slice 1 decision stands).
- Q: Out of scope? A: New #471 surfaces (transcript, code blocks, tool rows, Mermaid), Rewind and Fork (#696), New session from an issue (#1310), Ctrl+B session-list collapse.
- Q: Native menu block (#1404)? A: One app-wide `contextmenu` handler blocks the native WebView2 menu wherever Refract has no menu; the repo header in the Session list gets a context menu; the row context menu and the ellipsis dropdown are never open together.
- Q: Menu icons (#1405)? A: Menu item components take an optional lucide `icon`; registry actions carry an `icon`; every menu item gets one.

### Session 2026-10-30 (agent decisions, no questions could be asked)

- Q: Which native menu items map to a registry action? [DECISION by agent, confirm] None do: `menu.rs` holds Close, Maximize, zoom, full screen, minimize and the predefined edit items, all Rust-only, and `AppMenuBar.tsx` only pops those submenus. `menu.rs` is left unchanged; no duplicate handler exists to remove.
- Q: Where does the text-editing item set live? [DECISION by agent, confirm] One builder `textEditItems` in the palette feature produces Cut, Copy, Paste, Paste as text and Select all (with their `Ctrl+X` and similar hints), used by the composer menu and any other text surface.
- Q: A menu item with an action id that is disabled? [DECISION by agent, confirm] It renders disabled, never hidden, matching what the menu did before; the palette still omits disabled actions.
- Q: One open menu at a time, how? [DECISION by agent, confirm] A tiny shared store holds the id of the open menu; each shared menu root closes itself when another id opens, and a menu that opens while another is open replaces it.
- Q: Where is the native menu blocked? [DECISION by agent, confirm] Everywhere except editable fields (`input`, `textarea`, `contenteditable`) that lack a Refract menu, where the browser menu still gives spellcheck and paste, and except an element inside a Radix context-menu trigger (which handles its own event).
- Q: Which chords route through the registry? [DECISION by agent, confirm] Ctrl+N, Ctrl+W, Ctrl+, , Ctrl+Shift+B, Ctrl+Shift+\ and Ctrl+Shift+X, by one window-level dispatcher that matches `chordMatches` against every enabled registry action and keeps each handler's existing guards inside the action's `when()`/`run()`. Chords that are not registry actions (Enter, Esc, Space and similar) are untouched.

## Slice 2 functional requirements

- FR-10: The registry exports menu-item builders that turn action ids into menu entries (label, chord hint, icon, disabled state from `when()`, `run`), and one `textEditItems` builder for Cut, Copy, Paste, Paste as text and Select all.
- FR-11: A `PaletteAction` has an optional `icon` (a lucide component); every built-in action has one.
- FR-12: `ContextMenuItem`, `DropdownMenuItem`, their checkbox and radio items and the sub-trigger take an optional `icon`: 16px, in a fixed-width leading slot so labels align when some items lack icons, muted, item colour on highlight, destructive colour for destructive items, `aria-hidden`.
- FR-13: Every context menu and dropdown in the app (composer, links, session rows, tree nodes, checks, pane width, git changes rows, approval, pickers, profile, app menu bar, add project, repository group, quick actions, context shake menu, split button) uses the shared items with an icon; what each menu does is unchanged.
- FR-14: Where a menu item maps to a registry action it is built from the registry (`actionMenuItem`), so label, chord hint and enabled state come from one place.
- FR-15: One window-level dispatcher handles the registered chords: Ctrl+N, Ctrl+W, Ctrl+, , Ctrl+Shift+B, Ctrl+Shift+\ and Ctrl+Shift+X run their registry action when enabled. The shortcuts dialog and the bound chords read the same registry, so they cannot drift. Ctrl+K in the Markdown editor still inserts a link.
- FR-16: `shell/menu.rs` is unchanged; the renderer has no duplicate handler for any native item (see decision).
- FR-17: One app-wide `contextmenu` handler calls `preventDefault` on any context-menu event that no Refract menu handles, except in editable fields.
- FR-18: The repo header in the Session list has a context menu.
- FR-19: At most one context menu or dropdown is open at a time; opening one closes the other.
- FR-20: `docs/PLAN.md` and `docs/design/index.md` record the slice 2 status and the chord table.

## Slice 2 success criteria

- SC-5: Right-clicking anywhere in the app without a Refract menu shows no WebView2 menu; right-clicking a repo header shows its menu.
- SC-6: Opening a row's ellipsis dropdown while its context menu is open closes the context menu, and the reverse.
- SC-7: Every menu item shows an icon and labels align in menus with mixed icons.
- SC-8: Each chord in FR-15 works as before; the shortcuts dialog lists them from the registry.
- SC-9: `pnpm ci:local` passes.

