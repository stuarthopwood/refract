# Components

This page covers the shared UI primitives: button, menus, tooltip, tabs and the right pane, cards and boxes, chips and pills, list rows, dialogs, toasts and notices, empty states, and the panel header. Decided by Stuart in the #474 grill, 2026-10-08, unless a rule says otherwise.

## Reusable components first

**Rule (Stuart, 2026-10-15, #934, ADR 0003):** "All UI elements should be re-usable components, enhanced when use cases add complexity." Every control a screen shows comes from a shared component in `src/renderer/components/`: a primitive in `components/ui/`, or a composed component that owns one recurring pattern (a screen header, a list toolbar, a search field, a session row). A new use case extends the shared component with a prop or slot; it never copies the markup into a feature folder or restyles a primitive in place (the hand-made selected class on Manage sessions' archive filter is the example that prompted the rule). The rule covers new UI and any UI a change touches; existing one-offs are inventoried in #935 and fixed one group per PR. Reviewers block a new one-off where a shared component exists or should exist.

First shared components decided (#934, names are proposals): **ScreenHeader** (back button, heading, plain-text count, trailing actions), **ListToolbar** (Filter tabs, selects, SearchField, "Showing X of Y"), **SearchField** (leading magnifier, "Filter <things>…", Esc clears, a clear button once there is text -- **built** by issue #559 as `src/renderer/components/SearchField.tsx`, first used by the session list's own search; #934 adopts or extends it for Manage sessions rather than forking it), and one **Session row** shared by the Session list and Manage sessions. Toolbar controls are 32 px, including the Filter tabs strip.

## Button

Button hierarchy settles which `Button` variant (`src/renderer/components/ui/button.tsx`) means what, where each is allowed, and sizes (agenda item 4).

| Variant | Use |
|---|---|
| `outline` | The normal button everywhere. Cards, banners and pane headers (Approve, Recover, Merge, Refresh) use `outline`, with emphasis coming from position and order, not weight. Settles #531 (Merge no longer outweighs the title). |
| `default` (filled) | The single commit action in a dialog or form, and in first run (Add repository, Create, Save). One filled button per surface. |
| `ghost` | Icon-only toolbar and row actions. |
| `destructive` | The final confirm button inside a dialog only. Never at rest in a list or card. |
| `invert` | A solid, neutral fill (foreground-on-background inverted), never red/destructive. Composer Stop only (2026-10-15 grill, issue #564, decision 5): stopping a turn keeps the work done so far, the opposite of a destructive action, so it never takes the destructive colour. |
| `secondary`, `link` | Not part of the design system. |

**Composer exception (2026-10-15, issue #564, gate round 1 fix):** the message box's Stop and Send sit side by side and are BOTH filled at once while a turn runs -- the one documented exception to "one filled button per surface" above, since the two fills are visually distinct colours conveying different intents (stop vs. send), not a duplicated weight. Stop uses `invert`; Send uses `default`, but overridden with its OWN dedicated `--send`/`--send-foreground` token pair (chromatic/indigo in every built-in theme) rather than `--primary`, since `--primary` resolves to a near-white neutral in Dark and Dark (high contrast) -- almost identical to `invert`'s own fill there, failing "visibly distinct in weight". No other `default`-variant button anywhere else in the app is affected.

Evidence (variant counts from the read-only audit at `origin/main` 9f23d22): `default` 14 uses, `outline` about 28, `ghost` 2, `destructive` 1, `secondary` and `link` 0. `secondary` and `link` already exist in `buttonVariants` but carry no documented use; do not add a new use without a decision. A live JSX-aware recount for the #580 quality-gate review found at least 7 single-line `ghost` uses plus several multi-line ones, some carrying a visible label (for example `RequestCard.tsx:415`'s Cancel, `ToolRow.tsx:107,131`'s "Show all"), which the new icon-only-only rule above does not yet cover live. "`ghost` 2" is Stuart's own decision-record audit figure, quoted verbatim rather than silently revised; the live count and the labelled-ghost cases are flagged for the #579 sweep.

**Labelled ghost nav and footer entries (#567 decisions 18, 21):** a full-width left-nav entry (`SessionList.tsx`'s Pull requests button, `h-8`) and a full-width footer entry (the same file's Add repository button, `h-8`) are both `ghost` with a leading icon AND a visible label, one more sanctioned exception to "icon-only" above alongside the pre-existing labelled-ghost uses the #580 evidence note already flagged (`RequestCard.tsx`'s Cancel, `ToolRow.tsx`'s "Show all"). A selected nav entry additionally gets the shared 2px `--active-indicator` bar plus the fill, the same selected cue a Session row uses; the footer's Add repository entry has no selected state. Add repository is muted at rest, foreground on hover (gate round 2 fix, architect L-f: the previous "matching every other `ghost` use" wording overreached -- Pull requests stays foreground at rest whether selected or not, since it must read as a primary nav entry even while idle, unlike a footer action). Both share one hover fix the gate found missing: `hover:bg-sidebar-accent dark:hover:bg-sidebar-accent`, since ghost's own built-in `dark:hover:bg-muted/50` read half-strength against the fill both entries otherwise match.

Open:

- The filled button's colour (Refract's near-white today versus the AI Studio mock's indigo) is deferred to the tokens item; see [foundations-tokens-theming.md](foundations-tokens-theming.md).
- Refresh in pane headers: `outline` (button hierarchy, item 4) versus ghost icon-only (repeated toolbar actions, item 1; panel headers put ghost icon-only actions on the right, item 8; #532 plans a ghost icon-only `RefreshButton`) is unresolved; Stuart to decide.

### Sizes

| Size | Height | Use |
|---|---|---|
| `default` | 32px | First run and Settings primary actions (for example Add repository), and anywhere outside a denser `sm`/`xs` context. |
| `sm` | 28px | Cards, dialogs, and panes. |
| `xs` | 24px | Dense rows. |
| `icon` | 32px | Icon-only buttons outside a dense context. |
| `icon-sm` | 28px | Icon-only buttons (standard). |
| `icon-xs` | 24px | Icon-only buttons in dense rows. |

`icon-sm` and `icon-xs` match a 24px minimum target (WCAG 2.5.8); see [accessibility.md](accessibility.md#targets). `icon-lg` exists in `buttonVariants` but has no documented role in this system.

## Menus

Menus and context menus (#471) follow one rule by menu type, not by menu mechanism (agenda item 5): the same rule applies to a `DropdownMenu`, a `ContextMenu`, or a right-click menu.

| Menu type | Icons | Examples |
|---|---|---|
| Action menus | Text only, never an icon | Session row, repository row, manage-session row, and every right-click context menu: Rename, Archive, Delete, Copy. |
| Destination and settings menus | A leading icon on every item | Profile, Appearance, GitHub accounts, Approval mode. |

Within a single menu it is all items or none: never a mix (matches the agenda item 1 rule that decisions are labels, not icons).

For both kinds:

- The shortcut, when one exists, is a right-aligned `Kbd`.
- Groups are split by separators.
- The destructive item is last, after a separator, in the destructive colour.
- Check marks and radio marks are allowed.

Evidence at `origin/main` 9f23d22: action-menu items carry no icons today (`SessionList.tsx:309-327` and `:420-422`, `ManageSessionRow.tsx:422-439`); the Profile and Approval mode menus already have a leading icon on nearly every item.

Open: the Profile menu's theme submenu uses colour swatches, not icons, to be settled under tokens and theming (#456, #458).

## Tooltip

Every icon-only control has a tooltip, following the "Q2 bundle" from agenda item 2 and its own follow-up (both #474 grill decisions):

- (a) A `Tooltip` whose text equals the control's `aria-label` (verb first, sentence case; see [patterns.md](patterns.md)).
- (b) The `Kbd` shortcut in the tooltip when one exists.
- (c) Dismissible with Esc without moving pointer or focus, hoverable (the pointer can reach the tooltip without it closing — never set Radix's `disableHoverableContent`), and persistent until hover or focus leaves or the user dismisses it (WCAG 1.4.13).
- (d) The tooltip also reveals on keyboard focus-visible, not hover alone — a separate requirement from (c), not itself part of 1.4.13.
- (e) A 400ms open delay, instant when moving between neighbouring icon-only controls.
- (f) A 24px × 24px minimum target (the strict bundle has no spacing exception; see [accessibility.md](accessibility.md#targets) for the general WCAG 2.5.8 rule).

`TooltipContent` (`src/renderer/components/ui/tooltip.tsx`) floats 6px off its trigger (`sideOffset={6}`), with no arrow, on the elevated popover surface and shadow — the same surface as menus and other floating layers (see "Elevation and shadows" in [foundations-tokens-theming.md](foundations-tokens-theming.md)). This carries forward the original Tooltips rule's still-valid shape: never an inverted near-white bubble on the dark theme, and a `Kbd` inside it uses its normal key-cap colours.

Destructive or ambiguous actions are never icon-only: they carry a label, or live in a menu.

### Open

The read-only audit at `origin/main` 9f23d22 found 12 icon-only controls missing a tooltip: `SessionList.tsx:304-319` and `:403-416`, `ConversationSwitcher.tsx:134-137`, `AttachmentStrip.tsx:41-49`, `MessageInput.tsx:706-722`, `dialog.tsx:72-80`, `sheet.tsx:73-81`, `sidebar.tsx:261-291`, `App.tsx:334-342`, `message-scroller.tsx:109-118`. Only the composer's Send and Stop buttons meet the full pattern today. Fixing these is tracked in the #474 follow-up sweep issue (#579), not fixed by this documentation change. Quoted verbatim from the decision record; a live recheck for the #580 quality-gate review found tighter ranges for the icon-only controls themselves (`SessionList.tsx:295-302` and `:410-417`; `MessageInput.tsx:714-722` — `:706-713` is the labelled "Send now" button, not icon-only) and that the app-wide tooltip delay is 0ms today (`tooltip.tsx:8`), not the decided 400ms — both flagged for #579 rather than silently edited into the quote above.

Of those, `AttachmentStrip.tsx:41-49` ("Remove pasted image") and `MessageInput.tsx:714-722` ("Remove queued message") are reversible removals and are allowed to stay icon-only once they gain the tooltip they are missing — see "Destructive actions" in [patterns.md](patterns.md).

## Tabs and the right pane

These rules come from issue #538 (Stuart, 2026-10-07), decided the day before the #474 grill, not from the grill itself. They are included here for a single component reference. Source: `issue://538` and `docs/PLAN.md` phase C, row C1 (read-only; status `todo`, not yet built as of this writing).

- **Icon rail.** A permanent narrow strip at the window's right edge, one icon button per available panel. The rail stays visible when the pane is collapsed, so every panel and its count stay reachable.
- **Collapsible pane.** Beside the rail, resizable by dragging its border, collapsible to nothing and restorable with the same panels and tab order. One component owns the open, collapsed, and width state for every panel; no panel manages its own open flag. Dragging the border needs a single-pointer, non-drag alternative (for example width-preset buttons or a menu) to meet WCAG 2.5.7; #538 does not yet specify one — see [accessibility.md](accessibility.md#wcag-22-aa-checklist).
- **Tab bar.** Two or more open panels get a tab bar (ARIA tabs pattern), the active tab marked by more than colour, each tab closable, and each tab also showing that panel's live count. One open panel shows its own title row and close button, no tab strip.
- **Launcher list.** With the pane open and no panel open, a centred (both vertically and horizontally) list of every available panel, each row a button with its icon, name, and (when it has one) its count. Closing the last open panel closes only that panel; the pane stays open on the launcher list. This supersedes #394's "closing the last tab closes the panel."
- **Counts.** Agents: the number running, with an agents icon, in the running colour. Git changes: `+additions` in green and `−deletions` in red, with a git icon. Counts are never colour alone — see [accessibility.md](accessibility.md).

Open (per #538 itself, unresolved by the #474 grill): whether rail icons also carry counts while the pane is collapsed; persistence of open panels, order, and width across launches; a keyboard shortcut to toggle the pane; and whether this becomes a new spec or amends specs 004 and 005.

## Cards and boxes

The zero-box rule (#556, settled against the AI Studio mock review #549, agenda item 9/8): a box — a fill or a border around content — is allowed only where it marks something interactive or needing a hard boundary:

- The composer.
- Decision cards (approval, question).
- Dialogs and floating layers.
- Code blocks, inline code, diffs and tables.
- Rendered diagrams (code-block family, e.g. `Markdown.tsx`'s Mermaid `<img>`).
- Attachments and chips, including the pasted-text preview dialog (`TextPreviewModal.tsx`, code-block family).

Everything else — tool rows, thinking, notices, subagent rows, agent messages — is an unboxed row separated by spacing, with a **Spine** (a neutral `border-divider` left rule hanging from a group header's own status icon, never coloured or animated, issue #565) or a divider only when grouping is needed. No box inside a box: a nested card loses its own box and uses a soft divider instead.

Stuart's own "Self vs. other layout" rule (2026-10-04, in [product-chat.md](product-chat.md)) makes the user's own message bubble a standing exception: its fill marks authorship, not a card around content. **2026-10-16 delegated addition (Skippy, delegated by Stuart, #556):** it is never nested inside another box, and only Markdown's code-family surfaces (code blocks, inline code, tables, rendered diagrams) render inside it.

Attachments and queued-message chips inside the composer area are control affordances, not nested cards, so they keep their box (Stuart, 2026-10-08). Swept 2026-10-16, #556 (full account in PLAN.md's "Zero-box" decision).

Depth between in-flow surfaces (cards, panes, rows, the composer) comes from the surface ladder (background, then surface 1, 2, 3, each a step lighter), never a shadow. See "Elevation and shadows" and "Surface ladder and edges" in [foundations-tokens-theming.md](foundations-tokens-theming.md).

## Chips and pills

Chips and pills carry metadata or a removable value (attachment chips, pasted-text chips, readout chips) and are one of the "boxed" exceptions to the zero-box rule above. A chip's own remove control follows the icon-only tooltip rule once it is fixed (see "Open" under Tooltip, above). Vocabulary for pill versus chip lives in [CONTEXT.md](../../CONTEXT.md); `CONTEXT.md` lists Badge only as a term to avoid, not as a defined UI vocabulary entry.

## List rows

A list row (session row, repository row, subagent row) is an unboxed row under the zero-box rule, with a state icon or leading icon, its label, and trailing actions. Repeated row actions are icon-only with a tooltip (agenda item 1). The row's own action menu is an action menu (text only, see "Menus" above) reachable from an `⋮` trigger, a right-click, and the row's native context-menu keys (`Shift+F10`, the Menu key).

## Dialogs

`DialogContent` and `AlertDialogContent` (`src/renderer/components/ui/dialog.tsx:64`, `alert-dialog.tsx:59`) are a boxed floating layer under the zero-box rule, on the elevated `--popover` surface with a 1px `ring-foreground/10` edge; neither has a shadow today, unlike `TooltipContent`, menus, popovers, selects, and `SheetContent` (`shadow-md`/`shadow-lg`) — dialogs gain the shared floating-layer shadow token described in [foundations-tokens-theming.md](foundations-tokens-theming.md) once #550 lands.

- A dialog's confirm action (`AlertDialogAction`) is the one filled (`default`) button on the surface, unless the action is destructive, in which case it is `destructive` — the one place that variant is allowed (see "Button," above).
- `AlertDialogCancel` defaults to `outline`.
- Confirm buttons repeat the verb ("Delete session"), never "OK" or "Yes" — see [patterns.md](patterns.md).
- A destructive confirmation is never icon-only; it always carries a label (see "Destructive actions" in [patterns.md](patterns.md)).

## Toasts and notices

Status and feedback (agenda item 7) define one severity set across notices and toasts, and one set of channels:

| Severity | Icon shape | Word |
|---|---|---|
| Info | Info circle | "Info" |
| Success | Check | "Success" |
| Warning | Triangle | "Warning" |
| Error | Octagon | "Error" |

Colour only reinforces the icon and the word; it is never the only signal (WCAG 1.4.1). `Toaster` (`src/renderer/components/ui/sonner.tsx`) already maps this set to lucide icons (`CircleCheckIcon`, `InfoIcon`, `TriangleAlertIcon`, `OctagonXIcon`, plus `Loader2Icon` for loading).

| Channel | Scope | Dismissal |
|---|---|---|
| Banner | A Session- or pane-scoped problem | Stays until the problem is fixed. |
| Toast | A transient app-level result | Auto-dismisses after about 5s, paused on hover and focus. **Errors never auto-dismiss.** |
| Inline text | Form fields | Clears with the field's own validation state. |
| Transcript notice | Agent-originated news | Stays in the transcript like any other row. |

## Empty states

An empty state is an icon, one line saying what is empty, and the next action — nothing more. See "Placeholders and 'coming soon'" in [patterns.md](patterns.md) for what an empty state is never allowed to show instead.

## Panel header

Every panel and pane (chat, Agents, Pull requests, FDB panes, side chat) shares one panel header pattern (agenda item 8): a fixed-height row, title left, ghost icon-only actions right. **Accepted rule change (Stuart, 2026-10-09):** a panel header carries no bottom divider line; it is separated from its own content by a different surface shade and/or whitespace instead. This reads #606's live-review removal of the `ChatHeader.tsx`/`SessionList.tsx`-header/`SubagentPanel.tsx`-header bottom border as the correct call, superseding this page's earlier "soft divider below" wording. `PullRequestsView.tsx`'s header still carries its original full-strength `border-border` today -- **not** this rule, an inconsistency left for the #579 sweep to fix, not a second accepted pattern. The agenda item 8 decision proposed 40px pending a measurement against today's chat header; `ChatHeader.tsx`'s `<header>` carries `h-10` (40px), confirming 40px as the settled row height — see [foundations-typography-spacing.md](foundations-typography-spacing.md#panel-header-height) for the measurement.

### Open

Tab pattern details are deferred to #394.
