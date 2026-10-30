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

- Q: Ctrl+K already applies a link in the Markdown composer toolbar. [DECISION by agent, confirm] The palette ignores a Ctrl+K that the editor already handled (`defaultPrevented`); Ctrl+Shift+P opens the palette everywhere.
- Q: Do the existing window-level handlers (Ctrl+N, Ctrl+W, Ctrl+, and so on) move onto the registry? [DECISION by agent, confirm] No. They keep their own guards; the registry holds the chord as display metadata and the palette's own chords are dispatched from the registry. Rewiring every handler risks regressions in the live-tested guards and is left to slice 2.
- Q: Which Sessions appear? [DECISION by agent, confirm] Sessions that are not archived and not hidden; selecting one opens it in the focused pane (the same call as Home's session rows).
- Q: Which Conversations appear? [DECISION by agent, confirm] The Conversations of the Session in the focused pane, loaded when the palette opens. Selecting the current one just closes the palette; another one opens it only while the Session is idle or stopped, matching the existing Conversation switcher.
- Q: Which pull requests and issues appear? [DECISION by agent, confirm] Only those already loaded in the pull request and issue stores. The palette never starts a GitHub fetch. Selecting one opens the view with that item selected.
- Q: New session from a pull request, with the fork warning? [DECISION by agent, confirm] Not registered. The list items do not know whether a pull request is from a fork, and the palette must not bypass the fork warning in `PullRequestDetail.tsx`. Selecting a pull request opens its detail, where New session lives.
- Q: Pause and Resume wording? [DECISION by agent, confirm] Two actions, "Pause session" and "Resume session", for the focused Session, enabled by its pause state; "Pause all" and "Resume all" follow `PauseAllButton`'s rule.
- Q: Is the existing Open Usage entry kept? [DECISION by agent, confirm] Yes. `usageViewAction.ts`, which waited for this palette, is replaced by a registry action `open-usage`.
- Q: Ranking and the `>` prefix? [DECISION by agent, confirm] cmdk's built-in fuzzy scoring; `>` is stripped before scoring and hides every section but Actions. An empty query shows Actions, then Sessions, Conversations, Settings, Pull requests and Issues, with no more than 50 rows rendered per section.

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
- The focused Session is working: Conversations are listed but selecting another one shows the existing "busy" notice instead of switching.
- Empty result: the listbox shows a "No results" text, announced politely.
- `conversations.list` fails: the Conversations section is omitted and a notice is raised through `notify`.

## Gaps (behaviour not on main, not built here)

- Rewind and Fork (#696): there is no Rewind or Fork behaviour; `/fork` is only a reserved name. Not registered.
- New session from an issue (#1310): no issue-to-Session path exists. New session from a pull request exists only inside `PullRequestDetail.tsx` behind the fork warning, so it is not registered (see decision above).
- Collapse of the session list (Ctrl+B, #453) has no handler; not registered.

## Deferred (slice 2 and later)

- Context menus (`SessionRow.tsx`, `ComposerContextMenu.tsx`, `LinkActions.tsx`, `TreeNodeRow.tsx` and the other `components/ui/context-menu.tsx` users) reading the registry.
- `src-tauri/src/shell/menu.rs` reading the registry.
- Rewiring the existing window-level chord handlers onto the registry.
