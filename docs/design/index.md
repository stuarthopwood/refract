# Refract design documentation

Decided by Stuart in the #474 grill, 2026-10-08.

This page indexes Refract's UI design system: what each page covers, how the rules are enforced, and the product's design principles, keyboard shortcuts, and backlog process. `docs/DESIGN.md` is now a short pointer to this folder.

## Pages

| Page | Covers |
|---|---|
| [Tokens and theming](foundations-tokens-theming.md) | Palette, semantic roles, component tokens, theme files (#456, #458) |
| [Typography and spacing](foundations-typography-spacing.md) | Font roles, the 8px spacing grid, density (#4, #360, #473) |
| [Icons](foundations-icons.md) | Icon set, sizes, stroke weight, and the icon-only requirements bundle (#469) |
| [Motion](foundations-motion.md) | Reduced motion, waiting and running indicators, focus ring (#566) |
| [Components](components.md) | Button, menu, tooltip, tab, card, row, chip, dialog, toast, empty state |
| [Patterns](patterns.md) | Destructive actions, loading, errors, status, keyboard and focus |
| [Accessibility](accessibility.md) | WCAG 2.2 AA rules and the Spec Kit plan-gate checklist |
| [Product look and feel](product-look-and-feel.md) | Theme, density, fonts, state colour roles, scrollbars, chat text colour, and other old `docs/DESIGN.md` "Look and feel" rules, reproduced verbatim |
| [Product layout](product-layout.md) | The three-region window layout, session list, panes, and the profile item |
| [Product chat](product-chat.md) | Chat transcript, message box, and composer behaviour |
| [Product first run and settings](product-first-run-and-settings.md) | Readiness checklist, first-run empty states, Settings, and feedback channels |
| [Implementation notes](implementation-notes.md) | Confirmed implementation behaviour and a record of superseded `docs/DESIGN.md` text |

## ADRs

- [0001: Three-layer design tokens](../adr/0001-three-layer-design-tokens.md) -- palette, semantic role, and component token layering (#474 agenda item 9, #456, #458).
- [0002: Theme files without an in-app editor](../adr/0002-theme-files-without-editor.md) -- custom themes ship as data files with import and export, no colour editor (#458).

## How the rules are applied

- Governance decided the design-system checklist ([accessibility.md](accessibility.md#design-system-checklist-spec-kit-plan-gate)) goes into the Spec Kit plan gate; it is not wired in yet (`.specify/templates/plan-template.md` has no design-system section today), so reviewers apply it by hand against a feature's plan before work starts.
- Lint scripts for palette-colour literals, alpha modifiers, and icon-only controls without a Tooltip are planned beside `pnpm check:ui-text` and the contrast scripts (agenda item 12); none is built yet.
- One sweep issue lists every place that breaks these rules, ordered by visibility, rather than filing a new issue per violation.

## Icon, button, and tooltip rules live here, not in CONTEXT.md

All icon, button, and tooltip rules live in `docs/design/` (mainly [components.md](components.md), [foundations-icons.md](foundations-icons.md), and [patterns.md](patterns.md)). `CONTEXT.md` carries only the UI vocabulary glossary (pill, chip, row, card, panel, pane, tab, readout), never implementation detail.

## Principles

- Show state at a glance; never make the developer open a Session to learn whether it needs them.
- A dense turn stays readable: many tool calls must not bury the answer.
- Every action has a visible button; shortcuts are a second way, never the only way.
- Destructive actions name what will be lost before they happen.
- The agent does the work; Refract is the place to watch, steer, and approve it.

## Keyboard


| Action | Shortcut |
|---|---|
| Send message | Enter |
| Newline in message | Shift+Enter |
| Clear the message box | Esc |
| Stop the running turn | Ctrl+Shift+X |
| New session | Ctrl+N |
| Close chat pane | Ctrl+W |
| Collapse or expand the right pane (chat view) | Ctrl+Shift+B |
| Open Settings | Ctrl+, |
| Command palette | Ctrl+K or Ctrl+Shift+P |
| Open in split (a session row) | Ctrl+click |
| Move focus to the other pane (split open) | Ctrl+Shift+\ |

Ctrl+Esc and Ctrl+Shift+Esc were considered for Stop and rejected: Windows reserves them (Start menu and Task Manager), so the app may never receive them.

Ctrl+W closes the chat pane that is showing right now; it no longer closes the window (Alt+F4 and the window's own caption button still do). Known limitation: on layouts whose physical W key types ASCII punctuation and have no w (e.g. Hebrew), Ctrl+W does not fire; use the Close button.

Ctrl+N creates a session: in the focused chat pane's own project (its default branch), or -- with no pane open -- the sole project if there is exactly one, else it moves keyboard focus to the first project group's "+" button instead of guessing. Works in the chat view only (not Settings, Manage sessions, or Pull requests).

Six rows were removed 2026-10-09 (#429): New Session (Ctrl+N), New Conversation (Ctrl+Shift+N), Jump to the Nth Session (Ctrl+1 to Ctrl+9), Hide or show the session list (Ctrl+B), Cycle Approval mode (Ctrl+Shift+A), and Command palette (Ctrl+K) had no working handler anywhere in the renderer or main process. New Session (Ctrl+N) got a real handler back (#6's first slice, PR #647) and stays. **Issue #6 closed 2026-10-10 by decision:** Ctrl+Shift+N, Ctrl+1 to Ctrl+9 and Ctrl+Shift+A are not built and are no longer tracked by any open issue; Ctrl+B is tracked separately by #453; Command palette (Ctrl+K) was #5, closed (as completed) without a palette ever shipping, and has no open issue. Open Settings (Ctrl+,) is the one other row that instead got a real handler (#395) and stays.

Send, Stop, New session, Close chat pane and Settings each name their chord in a tooltip on hover and keyboard focus, as key-cap icons (the `Kbd` component), not plain text; the chord is not drawn beside the button.


## Backlog


Ideas and features live in the GitHub issue log for `stuarthopwood/refract`. Labels:

- **Type**: `idea` (the inbox), `feature`, `bug`, `spike`, `chore`.
- **Area**: `session-list`, `chat`, `approvals`, `worktree`, `transport`, `notifications`, `settings`, `design`, `right-pane`, `build`.
- **Priority**: `p1`, `p2`, `p3`.
- **Spec link**: `spec:NNN` when an issue has been shaped into `specs/NNN-...`.

Status is only open or closed. A new thought is filed as an `idea`; when it is worth building it is shaped with `/speckit.specify`, gets a `spec:NNN` label, and links to the spec.
