# Components

This page covers the shared UI primitives: button, menus, tooltip, tabs and the right pane, cards and boxes, chips and pills, list rows, dialogs, toasts and notices, empty states, and the panel header. Decided by Stuart in the #474 grill, 2026-10-08, unless a rule says otherwise.

## Reusable components first

**Rule (Stuart, 2026-10-15, #934, ADR 0003):** "All UI elements should be re-usable components, enhanced when use cases add complexity." Every control a screen shows comes from a shared component in `src/renderer/components/`: a primitive in `components/ui/`, or a composed component that owns one recurring pattern (a screen header, a list toolbar, a search field, a session row). A new use case extends the shared component with a prop or slot; it never copies the markup into a feature folder or restyles a primitive in place (the hand-made selected class on Manage sessions' archive filter is the example that prompted the rule). The rule covers new UI and any UI a change touches; existing one-offs are inventoried in #935 and fixed one group per PR. Reviewers block a new one-off where a shared component exists or should exist.

Shared components decided in #934: **ScreenHeader** (**built**, `src/renderer/components/ScreenHeader.tsx`: back button, heading, plain-text count, trailing actions), **ListToolbar** (**built**, `src/renderer/components/ListToolbar.tsx`: Filter tabs, selects, SearchField, "Showing X of Y" while any filter is non-default), **SearchField** (leading magnifier, "Filter <things>…", Esc clears, a clear button once there is text -- **built** by issue #559 as `src/renderer/components/SearchField.tsx`, first used by the session list's own search; #934 adopts or extends it for Manage sessions rather than forking it), and one **Session row** (**built**, `src/renderer/features/sessions/SessionRow.tsx`) shared by the Session list and Manage sessions: Manage sessions passes `layout="table"` (a table-row presentation of the same row: its own grid markup in `SessionRowTable.tsx`, with state, handlers, menus, rename and delete shared; no Resume, matching the old Manage row) plus a `SessionRowSurface` (open, announce, focus fallback, created) and `ManageSessionRow` is a thin wrapper. Toolbar controls are 32 px, including the Filter tabs strip. **ProjectListPane** (**built**, #874, `src/renderer/components/ProjectListPane.tsx`) is the list column of the Issues and Pull requests views: Filter tabs, the one Filters toggle and disclosure (search, State, Project multi-select, plus an `extraFilters` slot such as Issues' Label), the summary line, the skipped-Projects note, the one empty state, the error messages and the optional "Show more" paging. A new cross-Project list passes its tabs, rows and slots; it does not copy the pane. **ScreenSection** (**built**, #869, `src/renderer/components/ScreenSection.tsx`) is a dashboard section: heading with a muted count, trailing actions, an optional note and a one-line error above its content. It also takes `loading` (a first-fetch line, no count) and `empty` (the shared `Empty` component) with the priority loading, error, empty, list, a `useId` heading id, and an optional `headingRef` for moving focus to the heading. **ListCardButton** (**built**, #869, `src/renderer/components/ListCardButton.tsx`) is a bordered card whose body is one button with one accessible name; its `actions` slot holds secondary controls beside the body (Tidy up's Archive), never inside it. **FilterTabs** takes an optional `ariaLabel` to name the tablist when a screen has more than one. **NewSessionDialog** accepts controlled `open`/`onOpenChange` and an optional `trigger` (Home's New session Project picker menu opens it without a trigger). `ScreenHeader` takes no Back button when `backLabel` and `onBack` are omitted (Home); `AddProjectMenu` has a `toolbar` variant (an outline button in an action row).

Added by spec 074 (#935 groups: inline status text, confirm dialogs):

- **InlineStatus** (`src/renderer/components/InlineStatus.tsx`): the one line for loading, error and empty text. `tone` is `info`, `loading` or `notice` (a quiet failure such as a background refresh) (role `status`), or `error` (role `alert`, destructive colour); `density` is `block` (`p-4 text-sm`) or `compact` (`px-2 py-1 text-xs`). Do not hand-style a `<p>` for these.
- **ConfirmAlertDialog** (`src/renderer/components/ConfirmAlertDialog.tsx`): every confirm dialog uses it (Merge, Sign out, Delete, Review confirm step, Context shake, fork warning). Extra props: `cancelLabel`, `size`, `error` (an always-mounted `InlineStatus` alert line), `children` (a body slot), `bodyLabel` (names a grouped body such as Merge's radios), `confirmDisabled`, and an optional `confirmLabel` (omit it for an info dialog with one right-aligned Close button). The confirm button is `default`, or `destructive` with `tone="destructive"`; while `busy` the confirm is `aria-disabled` so focus is kept. Radix focuses Cancel on open. `onCloseAutoFocus` returning `false` lets Radix restore focus.
- **OpenOnGitHubButton** (`src/renderer/components/OpenOnGitHubButton.tsx`): the Issue and Pull request headers' ghost icon anchor (`aria-label` "Open on GitHub (opens in browser)", tooltip). Pair it with a `CopyButton` labelled "Copy link".

Added by spec 042 (Chat user avatar):

- **UserAvatar** (`src/renderer/components/UserAvatar.tsx`, spec 042): the user's own avatar in chat over the shared `Avatar`: the active GitHub account's cached photo (data URL, `useRepositoryAvatarUrl`) with git-name initials as the fallback, decorative (`alt=""`, `aria-hidden`). `size` is `default` (32 px, user bubble) or `xs` (20 px, answered Ask line); the `xs` size lives on `Avatar` itself.

Added by spec 038 (Pull requests wave 2):

- **MarkdownEditor** (`src/renderer/components/markdown-editor/`): Write/Preview editor built on `ComposerBox` (box, `ComposerField`, `ComposerTextarea` with `actionCount={0}`, `ComposerFooter`) with a formatting toolbar, `full` and `compact` sizes, Ctrl+Enter to submit and Esc to cancel. The Pull requests comment box and thread replies use it.
- **FilterableGroupedListbox** (`src/renderer/components/FilterableGroupedListbox.tsx`): a filter field (`SearchField` in `combobox` mode) over a grouped `role="listbox"` with sticky group headers, `aria-activedescendant` keyboard handling, a per-group Retry row and a polite live region. The Clone from GitHub dialog uses it; `ModelPicker` still has its own copy of the pattern.
- **AddProjectMenu** (`src/renderer/features/sessions/AddProjectMenu.tsx`): the "Add project" trigger with two text-only items, Local folder... and Clone from GitHub.... `variant="footer"` is the session list's ghost footer entry (menu opens upward); `variant="first-run"` is the first-run screen's filled primary button. `variant="toolbar"` is a small outline button in an action row (Home's Quick actions). Trigger styles live in one variant lookup map.
- **RelativeTime** (`src/renderer/components/relative-time.tsx`): a relative time as a focusable `<time>` with the full local date and time in a Tooltip. Use it for every relative time in the Pull requests view.
- **Pull requests pieces** (`src/renderer/features/pull-requests/`): `TimelineCards.tsx` (history-line entries: unboxed commit rows, soft `border-divider` cards, Avatar, "Bot" and "You" Badges), `ThreadReply.tsx` (ghost Reply toggle opening the compact editor), `CommentBox.tsx` (full editor with Post comment and a confirmed Close pull request), `ChecksSection.tsx` (checks grouped by outcome in Collapsibles, row kebab DropdownMenu), and `prImages.ts` (the image-proxy cache behind avatars and Markdown images, ADR 0004).

Built with the Project colour work (#887) and the Status style setting (#482):

- **Slider** (`components/ui/slider.tsx`): a native range input with a visible 16 px thumb (foreground fill, background border) and a bordered track, so both hold 3:1 against the surface. Optional `trackBackground` for a gradient. Arrow, Home/End and PageUp/PageDown keys come from the native input.
- **ColorPicker** (`components/ColorPicker.tsx`): Hue, Saturation and Lightness sliders that keep their own `[h, s, l]` so the hue does not snap at S=0 or L=0/100. Optional `presets` (a labelled swatch radio group with Tooltip names, a border and `forced-color-adjust: none` so swatches show in Windows High Contrast), `presetValue`, `onPresetChange` and a `presetsAction` slot.
- **StatusDot** (`features/sessions/StatusDot.tsx`): the Dots Status style, one shape per state: Idle a hollow ring, Working a filled dot, Needs you a filled disc inside a ring, Stopped a small square, Unread response an open ring with a badge dot at the top right.
- **StatusStylePreview** (`components/StatusStylePreview.tsx`): all five Session states drawn in one Status style, as phrasing content so it can sit inside a radio option.

## Button

Button hierarchy settles which `Button` variant (`src/renderer/components/ui/button.tsx`) means what, where each is allowed, and sizes (agenda item 4).

| Variant | Use |
|---|---|
| `outline` | The normal button everywhere. Cards and pane headers (Approve, Merge, Refresh) use `outline`, with emphasis coming from position and order, not weight. A banner's one primary action is `outline` too (see "Banners" below). Settles #531 (Merge no longer outweighs the title). |
| `default` (filled) | The single commit action in a form, and in first run (Add project, Create, Save). A `ConfirmAlertDialog` confirm is `default` (or `destructive`), as the only filled button in the dialog. One filled button per surface. |
| `ghost` | Icon-only toolbar and row actions. |
| `ghost-destructive` | A destructive row or toolbar action that must not look filled (for example Close pull request). |
| `destructive` | The final confirm button inside a dialog only. Never at rest in a list or card. |
| `invert` | A solid, neutral fill (foreground-on-background inverted), never red/destructive. The composer Stop button (2026-10-15 grill, issue #564, decision 5): stopping a turn keeps the work done so far, the opposite of a destructive action, so it never takes the destructive colour. |
| `text` | A non-primary action in a banner (#746): foreground text, no border or fill, underlined on hover and keyboard focus, 2px focus ring, 24px minimum target. `text-destructive` is the same shape with a red label, for a destructive action that opens a confirm dialog. |
| `secondary`, `link` | Not part of the design system, except the one decided `link` use below and the floating transcript icon buttons (see "Floating icon buttons"). |

**Quiet dismiss text button (Stuart, 2026-10-26, #1205):** the "Agent stopped" bar's **Don't show again** is a `text` variant button underlined at rest (`underline underline-offset-2`) and muted with `text-muted-foreground`, beside the bar's `outline` **Start agent**. A dismiss-forever action on a quiet bar reads as a text action, not a second button; the muted colour keeps **Start agent** the stronger action. The `link` variant stays unused.

**Composer exception (2026-10-15, issue #564, gate round 1 fix):** the message box's Stop and Send sit side by side and are BOTH filled at once while a turn runs -- the one documented exception to "one filled button per surface" above, since the two fills are visually distinct colours conveying different intents (stop vs. send), not a duplicated weight. Stop uses `invert`; Send uses `default`, but overridden with its OWN dedicated `--send`/`--send-foreground` token pair (chromatic/indigo in every built-in theme) rather than `--primary`, since `--primary` resolves to a near-white neutral in Dark and Dark (high contrast) -- almost identical to `invert`'s own fill there, failing "visibly distinct in weight". No other `default`-variant button anywhere else in the app is affected.

Evidence (variant counts from the read-only audit at `origin/main` 9f23d22): `default` 14 uses, `outline` about 28, `ghost` 2, `destructive` 1, `secondary` and `link` 0. `secondary` and `link` already exist in `buttonVariants` but carry no documented use; do not add a new use without a decision. A live JSX-aware recount for the #580 quality-gate review found at least 7 single-line `ghost` uses plus several multi-line ones, some carrying a visible label (for example `RequestCard.tsx:415`'s Cancel, `ToolRow.tsx:107,131`'s "Show all"), which the new icon-only-only rule above does not yet cover live. "`ghost` 2" is Stuart's own decision-record audit figure, quoted verbatim rather than silently revised; the live count and the labelled-ghost cases are flagged for the #579 sweep.

**Labelled ghost nav and footer entries (#567 decisions 18, 21):** a full-width left-nav entry (`SessionList.tsx`'s Pull requests button, `h-8`) and a full-width footer entry (the same file's Add project menu button, `h-8`) are both `ghost` with a leading icon AND a visible label, one more sanctioned exception to "icon-only" above alongside the pre-existing labelled-ghost uses the #580 evidence note already flagged (`RequestCard.tsx`'s Cancel, `ToolRow.tsx`'s "Show all"). A selected nav entry additionally gets the shared 2px `--active-indicator` bar plus the fill, the same selected cue a Session row uses; the footer's Add project entry has no selected state. Add project is muted at rest, foreground on hover (gate round 2 fix, architect L-f: the previous "matching every other `ghost` use" wording overreached -- Pull requests stays foreground at rest whether selected or not, since it must read as a primary nav entry even while idle, unlike a footer action). Both share one hover fix the gate found missing: `hover:bg-sidebar-accent dark:hover:bg-sidebar-accent`, since ghost's own built-in `dark:hover:bg-muted/50` read half-strength against the fill both entries otherwise match.
**Question card option rows and Cancel (#1434, #1435):** option rows use one shared fill (`OPTION_ROW_CLASS` in `components/ui/checkbox.tsx`): resting `--muted`, hover and checked a 5% foreground step, no border (a transparent one keeps a `Highlight` edge in forced colours), the radio dot or tick centred on the whole row. The Question card's Cancel is a labelled `ghost` button (`dark:hover:bg-muted`, no opacity modifier), another sanctioned labelled-ghost use. A single-choice pick by pointer or Space commits and advances or submits; arrow keys only move the pick (#1435, supersedes the older Next-only flow in #572 D14/D24).


Open:

- The filled button's colour (Refract's near-white today versus the AI Studio mock's indigo) is deferred to the tokens item; see [foundations-tokens-theming.md](foundations-tokens-theming.md).
- Refresh in pane headers: `outline` (button hierarchy, item 4) versus ghost icon-only (repeated toolbar actions, item 1; panel headers put ghost icon-only actions on the right, item 8; #532 plans a ghost icon-only `RefreshButton`) is unresolved; Stuart to decide.

### Sizes

| Size | Height | Use |
|---|---|---|
| `default` | 32px | First run and Settings primary actions (for example Add project), form commit actions, and anywhere outside a denser `sm`/`xs` context; also the confirm in a `ConfirmAlertDialog` (or `destructive`). |
| `sm` | 24px | Cards, dialogs, and panes. |
| `xs` | 24px | Dense rows. |
| `icon` | 32px | Icon-only buttons outside a dense context. |
| `icon-sm` | 24px | Icon-only buttons (standard). |
| `icon-xs` | 24px | Icon-only buttons in dense rows. |

`icon-sm` and `icon-xs` match a 24px minimum target (WCAG 2.5.8); see [accessibility.md](accessibility.md#targets). `icon-lg` exists in `buttonVariants` but has no documented role in this system.

### Whitespace (horizontal padding)

Decided (Stuart, 2026-10-21, #1144): one rule for the space between a control's edge and its text, scaled by control height, for every pill, chip, badge and text button.

| Control | Padding each side |
|---|---|
| Text tokens inside running text (the composer's slash command pill, the inline attachment chips in the message box) | 4 px |
| Pills, chips and badges up to 24 px tall, `xs` and `sm` buttons | 8 px |
| Text buttons 32 px and taller (`default`, `lg`) | 8 px (10 px before #1252 moved the app to the 8px grid) |

- The side next to a leading or trailing icon uses the same padding (8 px) since #1252: the 2 px tightening through `has-data-[icon=inline-start]` and `has-data-[icon=inline-end]` no longer applies, because 6 px is off the 8px grid.
- Use the primitive's own padding. A call-site `px-*`, `pl-*` or `pr-*` that breaks this table is a defect.
- Composer text tokens sit in a mirror layer under the masked textarea, so their padding is drawn with `box-shadow`, never real `padding` (real padding would move the caret off the text).
- Exceptions: icon-only buttons stay square (their padding comes from their fixed size), and inline code in prose keeps 4 px.

## Menus

Menus and context menus (#471) follow one rule by menu type, not by menu mechanism (agenda item 5): the same rule applies to a `DropdownMenu`, a `ContextMenu`, or a right-click menu.

Every item in every menu has a leading icon (#1405, decided by Stuart 2026-10-30, replacing the text-only rule for action menus): pass the lucide `icon` prop on `ContextMenuItem`, `DropdownMenuItem`, their checkbox and radio items and sub-trigger. The icon is 16px, muted, `aria-hidden`, and takes the destructive colour on destructive items; an icon-less item in a menu with icons passes `inset` so labels align. Registry actions carry an `icon`, and a menu item that is a registry action is built with `actionMenuItem` in `features/palette/menuItems.tsx` so label, icon, chord hint and enabled state come from one place. Cut, Copy, Paste, Paste as text and Select all come from `textEditItems`. Theme radio items are exempt from the leading lucide icon; the radio ring is the leading mark and `ThemeSwatchChip` is a trailing, decorative preview. The "Install GitHub CLI" link item is an `ExternalLink`, whose leading icon and sr-only "Opens in your browser" already satisfy the rule. Only one menu is open at a time (`components/ui/exclusive-menu.ts`), and `AppContextMenu` blocks the native WebView2 menu everywhere else (#1404).

For both kinds:

- The shortcut, when one exists, is a right-aligned `Kbd`.
- Groups are split by separators.
- The destructive item is last, after a separator, in the destructive colour.
- Check marks and radio marks are allowed. **A single-choice menu is a real radio group** (`DropdownMenuRadioGroup`/`DropdownMenuRadioItem`, `menuitemradio` with `aria-checked`) whose leading radio mark is the shared `RADIO_RING_CLASS` ring-and-dot (`radio-group.tsx`; the same mark the Ask card's and Merge dialog's radios use, a `--foreground` ring), filled for the selected item; never a trailing check standing in for a radio (Stuart, 2026-10-19, #1043; #1065). A listbox option row that is not a Radix menu (the Model picker) draws the same mark with the shared `RadioMark` (`radio-group.tsx`).

Copy feedback follows one rule (spec 080, #1469): an inline copy control is a `CopyButton` (check icon plus a polite announcement naming what was copied); a menu item that copies shows a toast, because the menu closes and takes its focus with it. Right-click "Copy image" therefore stays a toast while the inline Mermaid button shows the check. A kebab's accessible name is contextual per row ("More actions, <command or language>"), and a transcript kebab mounts its menu only on first hover or focus (`TranscriptKebab` `lazy`).

`RowKebabMenu` (`components/RowKebabMenu.tsx`) is the shared kebab for a list row whose actions live behind one visible trigger: pass `entries` (`onSelect`, or `href` for a new-tab link, plus `disabled` and `destructive`), a per-row `label` and the row `children`. Right-click, Shift+F10 and the Menu key on the row (not its `below` content) open the same menu. Settings > Appearance theme rows and the Pull request Checks rows use it.

Evidence at `origin/main` 9f23d22: action-menu items carry no icons today (`SessionList.tsx:309-327` and `:420-422`, `ManageSessionRow.tsx:422-439`); the Profile and Approval mode menus already have a leading icon on nearly every item.

Decided (Stuart, 2026-10-19, #1043; swatch ruling amended 2026-10-20, ui-architect-v3): the Profile menu's theme submenu is a radio group; each theme's colour swatch is a small two-colour chip (the theme's own `--background` and `--primary`, split down the middle) after the name, never a round mark that could read as a radio. Settled in #1466 (Skippy, delegated by Stuart 2026-10-31): `ThemeSwatchChip` stays and the theme radio items are the one documented exception to the leading-icon rule.

## Tooltip

Every icon-only control has a tooltip, following the "Q2 bundle" from agenda item 2 and its own follow-up (both #474 grill decisions). Build it with **IconButton** (`components/IconButton.tsx`, #579): one `label` prop becomes both the `aria-label` and the tooltip text, with an optional `shortcut` Kbd; the provider's open delay is 400 ms. Dialog and sheet Close use it without an Esc hint, because an open tooltip would take the first Esc away from the dialog. `ScreenHeader` and the Settings Back button, the session and project row actions and the group header buttons all use it. `ChatHeader`'s pause, find and close buttons and both `PanelTabBar` closes (the per-tab close carries the Delete hint; the single-panel close has no Delete binding, so no hint) use it too; the pause button names its session ("Pause {name} after this turn", "Cancel pause for {name}", "Resume {name}"; the pausing state shows `Undo2Icon`). The "Switch to <session>" button in `ChatHeader` is a labelled `outline` `sm` button (24 px tall, 16 px icon, name as truncating text) with the shared `Tooltip` "Switch to {name}", not a native `title`. A control that is `aria-disabled` keeps receiving pointer events so its reason tooltip shows: guard the handler, never add `aria-disabled:pointer-events-none`, and the base `Button` skips its press nudge while `aria-disabled` (spec 085, #1485). Controls flush against a clipping edge share `INSET_FOCUS_OUTLINE_CLASS` (`components/ui/focus-classes.ts`). **FieldLabel** (`components/FieldLabel.tsx`) is the label above a form field (`text-sm`, `htmlFor` required); the alarm form uses it, and the older dialog labels move onto it one group at a time (#935). The alarm's fired-state Re-arm and Dismiss are left-aligned beside the Delete exception on purpose (spec 082 Q3).

- (a) A `Tooltip` whose text equals the control's `aria-label` (verb first, sentence case; see [patterns.md](patterns.md)).
- (b) The `Kbd` shortcut in the tooltip when one exists.
- (c) Dismissible with Esc without moving pointer or focus, hoverable (the pointer can reach the tooltip without it closing — never set Radix's `disableHoverableContent`), and persistent until hover or focus leaves or the user dismisses it (WCAG 1.4.13).
- (d) The tooltip also reveals on keyboard focus-visible, not hover alone — a separate requirement from (c), not itself part of 1.4.13.
- (e) A 400ms open delay, instant when moving between neighbouring icon-only controls.
- (f) A 24px × 24px minimum target (the strict bundle has no spacing exception; see [accessibility.md](accessibility.md#targets) for the general WCAG 2.5.8 rule).

`TooltipContent` (`src/renderer/components/ui/tooltip.tsx`) floats 6px off its trigger (`sideOffset={6}`), with no arrow, on the elevated popover surface and shadow — the same surface as menus and other floating layers (see "Elevation and shadows" in [foundations-tokens-theming.md](foundations-tokens-theming.md)). This carries forward the original Tooltips rule's still-valid shape: never an inverted near-white bubble on the dark theme, and a `Kbd` inside it uses its normal key-cap colours.

Destructive or ambiguous actions are never icon-only: they carry a label, or live in a menu.

### Open

Resolved by #579 slice A (spec 077): the 12 icon-only controls the original audit found now go through `IconButton`, and the app-wide tooltip delay is 400 ms. Skipped on purpose: the unused `MessageScrollerButton`, the non-tabbable `SidebarRail` and the `aria-hidden` outline toggle.

Of those, `AttachmentStrip.tsx:41-49` ("Remove pasted image") and `MessageInput.tsx:714-722` ("Remove queued message") are reversible removals and are allowed to stay icon-only once they gain the tooltip they are missing — see "Destructive actions" in [patterns.md](patterns.md).

## Tabs and the right pane

These rules come from issue #538 (Stuart, 2026-10-07), decided the day before the #474 grill, not from the grill itself. They are included here for a single component reference. Source: `issue://538` and `docs/PLAN.md` phase C, row C1 (read-only; status `todo`, not yet built as of this writing).

- **Icon rail.** A permanent strip at the window's right edge (48px wide, `RAIL_WIDTH_PX` in `src/shared/layout.ts`), one 40px icon button (`Button` size `icon-xl`) with a 24px icon per available panel. The pressed button keeps a `bg-muted` fill and colours its glyph `text-accent-text` (no border). The rail stays visible when the pane is collapsed, so every panel and its count stay reachable. The rail and the pane use the `--sidebar-right` surface.
- **Collapsible pane.** Beside the rail, resizable by dragging its border, collapsible to nothing and restorable with the same panels and tab order. One component owns the open, collapsed, and width state for every panel; no panel manages its own open flag. The WCAG 2.5.7 alternative to dragging is `PaneWidthMenu` (Narrow 240 / Default 320 / Wide 520 / Close pane, current width marked), offered from the handle's context menu (right-click, Shift+F10) and the app menu bar's "Right pane width" dropdown; the handle also takes Arrow, Home/End and double-click (reset to 320), and its accessible name includes the current width. See [accessibility.md](accessibility.md#wcag-22-aa-checklist).
- **Tab bar.** Two or more open panels get a tab bar (ARIA tabs pattern), the active tab marked by more than colour, each tab closable, and each tab also showing that panel's live count. One open panel shows its own title row and close button, no tab strip.
- **Launcher list.** With the pane open and no panel open, a centred (both vertically and horizontally) list of every available panel, each row a button with its icon, name, and (when it has one) its count. Closing the last open panel closes only that panel; the pane stays open on the launcher list. This supersedes #394's "closing the last tab closes the panel."
- **Counts.** Agents: the number running, with an agents icon, in the accent colour (`bg-primary`, #1428). Git changes: `+additions` in green and `−deletions` in red, with a git icon. Counts are never colour alone — see [accessibility.md](accessibility.md).

Decided for #538 (spec 024, Skippy delegated by Stuart 2026-10-26, see the decision comment on #538): rail icons carry count badges while the pane is collapsed (a running Subagent count in the accent colour, a neutral changed-file count, "9+" over nine, never colour alone); the rail's top button collapses and expands the pane (`aria-expanded`, Ctrl+Shift+B, which never fires while an overlay is open); open or collapsed, width, open panels in tab order and the active tab persist in `Settings.rightPane`, restored before first paint and written only by `right-pane-persistence.ts`. It amends spec 013 as spec 024 rather than reopening specs 004 and 005. Not in scope: dragging the rail to rearrange (#730), the header-row reorder (#674), and a View-menu item.

## Reorderable lists

A list whose items the user can rearrange uses `useReorderable` (`src/renderer/components/reorder/use-reorderable.ts`) and `ReorderAnnouncer`, never its own drag code (issue #730). Pointer drag starts after 6 px so a click still works, Esc cancels, `Alt+Shift+Up/Down` (Left/Right on a horizontal list, `axis: 'x'`) is the keyboard alternative (WCAG 2.5.7), each move is announced politely, the moved item keeps focus, and `REORDER_MARKER_CLASS` draws the insertion bar on a `relative` item. The icon rail is the first consumer; #638 (projects) adopts it next.

## Cards and boxes

The zero-box rule (#556, settled against the AI Studio mock review #549, agenda item 9/8): a box — a fill or a border around content — is allowed only where it marks something interactive or needing a hard boundary:

- The composer.
- Decision cards (approval, question).
- Dialogs and floating layers.
- Code blocks, inline code, diffs and tables.
- Rendered diagrams (code-block family, e.g. `Markdown.tsx`'s Mermaid `<img>`).
- Attachments and chips, including the pasted-text preview dialog (`TextPreviewModal.tsx`, code-block family).

Everything else — tool rows, thinking, notices, subagent rows, agent messages — is an unboxed row separated by spacing, with a **Spine** (a neutral `border-divider` left rule hanging from a group header's own status icon, never coloured or animated, issue #565) or a divider only when grouping is needed. No box inside a box: a nested card loses its own box and uses a soft divider instead.

Stuart's own "Self vs. other layout" rule (2026-10-04, in [product-chat.md](product-chat.md)) makes the user's own message bubble a standing exception: its fill marks authorship, not a card around content. **2026-10-16 delegated addition (Skippy, delegated by Stuart, #556):** it is never nested inside another box, and only Markdown's code-family surfaces (code blocks, inline code, tables, rendered diagrams) render inside it. **2026-10-18 delegated addition (Skippy, delegated by Stuart, #926, FR-035):** a file/folder attachment chip is a second written exception -- the sent bubble renders the SAME chip the composer strip already allows (line 112's own "Attachments and chips" bullet), never raw inlined text or a bare path line, so a 256 KB inlined file never floods the transcript. **2026-10-27 (#513):** message images (the MessageImageGrid tiles) are a third: a bordered thumbnail in the bubble, never a card around it. **2026-10-30 delegated addition (Skippy, delegated by Stuart, #1436):** the in-chat Subagents chain row (`SubagentChainRow`, two or more Stages) is a fourth: a neutral `bg-card` / `border-divider` card around that one per-turn summary row and its expanded Stage list, because it is the turn's single summary of all Stages and Stuart asked for a boundary. The in-place Stage rows above it, `StageGroupRow`, `SubagentRow` and the right-pane tree stay unboxed. The fill never changes with status, and Stage lines keep their Spine inside it with no box of their own. **2026-10-30 delegated addition (Skippy, delegated by Stuart, #1459):** the card's edge is a 1 px `ring-1 ring-divider`, not a border, so its 4 px padding stays on the spacing step and the header icon column still lines up with the Stage rows; `border-divider` is faint on Obsidian and Nordic Frost, which is acceptable because the edge is decorative only. **Stuart's decision (2026-10-30, #1459):** the card is border-only, with no `bg-card` fill. The earlier "neutral `bg-card` / `border-divider` card" wording above is superseded; the edge stays the soft `ring-divider`.

Attachments and queued-message chips inside the composer area are control affordances, not nested cards, so they keep their box (Stuart, 2026-10-08). Swept 2026-10-16, #556 (full account in PLAN.md's "Zero-box" decision).

Depth between in-flow surfaces (cards, panes, rows, the composer) comes from the surface ladder (background, then surface 1, 2, 3, each a step lighter), never a shadow. See "Elevation and shadows" and "Surface ladder and edges" in [foundations-tokens-theming.md](foundations-tokens-theming.md).

## Diff stat

Issue #925: wherever a change-count stat ("N files changed +A -D") shows -- the composer status
line's Changes readout, the Session details card's identical diff line, the Pull requests
Changes tab's aggregate line and per-file diff header, and the chat transcript's own expanded
diff header -- it renders through one shared `DiffStatCounts` component
(`src/renderer/features/sessions/sessionDisplay.tsx`), never a per-surface copy. `+N` takes the
`--diff-added` token once N is strictly positive, `-N` takes `--diff-removed` once N is strictly
positive (see "Diff-stat colour tokens" in [foundations-tokens-theming.md](foundations-tokens-theming.md)
for the tokens themselves); a count of exactly zero stays `--muted-foreground` in either
direction, so a `-0` never reads as an error. The leading +/- glyph is the non-colour cue (WCAG
1.4.1) in every case, unchanged by which colour (if any) the figure takes.

A tool call's own edit stat (`ToolRow.tsx`/`toolRowLabels.tsx`'s `callMeta`, e.g. "bash +4 -2")
is explicitly OUT of this rule: issue #570 decision 1/3 ("success/done stays neutral on tool
rows") already governs it and this issue's own grill confirmed it is not reopened -- it keeps
`tabular-nums` with no colour class regardless of sign.

## Chips and pills

Chips and pills carry metadata or a removable value (attachment chips, pasted-text chips, readout chips) and are one of the "boxed" exceptions to the zero-box rule above. A chip's own remove control follows the icon-only tooltip rule once it is fixed (see "Open" under Tooltip, above). Their padding follows the 8px grid (#1144, wave 1 grill 2026-10-28): inline text tokens (the slash-command pill, inline chips) take 4px, with the fill extended by `box-shadow` only (4px left and right, 2px top and bottom, never real padding); pills, badges and buttons take 8px (`px-2`). Chips, pills and badges drop `rounded-full` and take the token radius (`rounded-md`; see "Corner radius scale" in [foundations-tokens-theming.md](foundations-tokens-theming.md)). Vocabulary for pill versus chip lives in [CONTEXT.md](../../CONTEXT.md); `CONTEXT.md` lists Badge only as a term to avoid, not as a defined UI vocabulary entry.

## List rows

A list row (session row, project row, subagent row) is an unboxed row under the zero-box rule, with a state icon or leading icon, its label, and trailing actions. Repeated row actions are icon-only with a tooltip (agenda item 1). The row's own action menu is an action menu (text only, see "Menus" above) reachable from an `⋮` trigger, a right-click, and the row's native context-menu keys (`Shift+F10`, the Menu key).

**Row line 2 type (#526):** line 2 of a Session row uses the normal UI font for the live Activity line and monospace (`font-code`) for the branch, on purpose: the Activity line is prose, the branch is an identifier. Rows also swap their line-2 text without the current-work banner's fade, on purpose: a list of rows changing at once would shimmer, so the shared 600 ms hold paces them instead.

**Selected-row bar (issue #1122, 2026-10-21, grilled, none deferred):** every persistent selected/active row or nav entry (the "Pull requests" nav entry, Session rows, the collapsed Project group header, the Settings nav, PR list rows, Explorer rows, Manage sessions rows, the Subagent panel) renders the one shared `ActiveIndicatorBar` component (`src/renderer/components/ActiveIndicatorBar.tsx`) -- a flush full-height (`inset-y-0`, no rounded caps) 2px `--active-indicator` bar with its own forced-colours fallback -- instead of a hand-copied `<span>`, following the "Reusable components first" rule above. Every site is square-cornered, but not all the same way: the "Pull requests" nav entry/Session rows/the Settings nav/Explorer rows/the Subagent panel join `globals.css`'s square-choice selector (`data-choice-item`/`role="treeitem"`); PR list rows and Manage sessions rows are square by omission (no rounding class was ever applied to either). Every site carries the shared accent fill except the collapsed group header (bar only, #735 decision 22, unaffected by this issue). See [product-look-and-feel.md](product-look-and-feel.md) "Active/selected indicator" for the full shape decision. The transient dropdown/menu keyboard-focus bar (issue #564) is a separate, narrower rule and keeps its own hand-written span.

## Tool icon and the collapsed line's icon tooltip

**ToolIcon** (`src/renderer/components/ToolIcon.tsx`, spec 023, #469) is the one shared tool glyph. It takes the resolved icon as its `icon` prop and never imports feature code: the caller resolves it with `resolveToolDisplay(tool, target).icon` (`src/renderer/features/chat/toolDisplay.ts`), which reads the shared verb map in `toolVerbs.ts`: a mapped tool shows its own icon, an MCP tool (`mcp__…`) shows Plug, a `write xd://<tool>` call shows `<tool>`'s icon, a `read skill://<name>` call shows the skill icon, and any other tool shows Wrench. Two tones: `muted` (the default, `text-muted-foreground`) and `error` (`text-severity-error`, for a failed call). The glyph is `aria-hidden`; the row's label and the tooltip carry the meaning. Tool rows, tool groups, the approval card title and subagent rows all render it; never import a tool glyph from `lucide-react` directly.

**CollapsedLine `iconTooltip`** (`src/renderer/features/chat/CollapsedLine.tsx`): optional supplementary text for the icon slot, shown through the shared `Tooltip` (`components/ui/tooltip.tsx`). Tool rows pass the raw tool id. It opens while the pointer hovers the icon or while the row itself has keyboard focus-visible, closes on Esc until the next hover or focus, adds no tab stop, and is never part of the accessible name. Omit it and the icon slot renders as before. The Settings > Chat switch "Show tool names on rows" (`SettingSwitchRow`) also shows the raw id muted after the label.

## Dialogs

`DialogContent` and `AlertDialogContent` (`src/renderer/components/ui/dialog.tsx:64`, `alert-dialog.tsx:59`) are a boxed floating layer under the zero-box rule, on the elevated `--popover` surface with a 1px `ring-foreground/10` edge; neither has a shadow today, unlike `TooltipContent`, menus, popovers, selects, and `SheetContent` (`shadow-md`/`shadow-lg`) — dialogs gain the shared floating-layer shadow token described in [foundations-tokens-theming.md](foundations-tokens-theming.md) once #550 lands.

- A dialog's confirm action (`AlertDialogAction`) is the one filled (`default`) button on the surface, unless the action is destructive, in which case it is `destructive` — the one place that variant is allowed (see "Button," above).
- `AlertDialogCancel` defaults to `outline`.
- Confirm buttons repeat the verb ("Delete session"), never "OK" or "Yes" — see [patterns.md](patterns.md).
- A destructive confirmation is never icon-only; it always carries a label (see "Destructive actions" in [patterns.md](patterns.md)).

## Image viewer and message images

- `ImageViewer` (`src/renderer/components/ImageViewer.tsx`) is the one full-size image dialog: controlled, sized to the window (never upscaled), with a fixed-height image area so the dialog does not resize between images. Previous/Next sit on the area's left and right edges (same size as Close, each with a tooltip); Left/Right arrow keys, Esc and the close button also work. It shows a spinner with "Loading image…" while the current image loads, announces "Image N of M, TYPE, size" through a polite live region, and returns focus to the opening tile (or its group when the tile is gone). It resolves only the current image, so a long list never loads every image. `ImagePreviewModal` (pending pastes) is a thin wrapper over it.
- `ImageThumbnail` (`src/renderer/components/ImageThumbnail.tsx`) is the one bordered image tile with loading, ready and unavailable states and an optional themed `+N` chip (rendered in every state). `ImageUnavailable` is the shared "Image no longer available" placeholder used by the tile and the viewer. The composer's pending-paste thumbnail reuses `ImageThumbnail`.
- `MessageImageGrid` (`src/renderer/components/MessageImageGrid.tsx`) shows a user message's images: one image at natural size (never upscaled, 320 px tall at most), several in a 2-across grid (4 when the bubble is 28rem or wider) with `+N` past four tiles. A tile fetches only when scrolled within about 200 px of view, reserving its aspect space until then. Each tile is a button named `Image N of M attached to your message, TYPE, size. Open larger view` (the last tile adds `, plus N more` and opens the viewer at the first hidden image); a missing image is a non-interactive `Image no longer available` placeholder. Bytes load through `images.get` and `lib/messageImageCache.ts` (16 entries and 48M characters at most).
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
| Banner | A Session- or pane-scoped problem | Stays until the problem is fixed. Built from `PaneBanner` (see "Banners"). |
| Toast | A transient app-level result | Auto-dismisses after about 5s, paused on hover and focus. **Errors never auto-dismiss.** Exception: a slash-command refusal warning stays until its own close button is used, a successful send from the same Session, or a newer refusal replaces it (#997). |
| Inline text | Form fields | Clears with the field's own validation state. |
| Transcript notice | Agent-originated news | Stays in the transcript like any other row. |

**Placement** (issue #980, decided Skippy, delegated by Stuart 2026-10-18, `ui-architect-v3` roundtable): `position="bottom-center"`, centred on the window on purpose — that is what clears the permanent full-height right rail (`IconRail.tsx`) and the Session list header, which both only ever sit at the window's left/right edges, never its centre, regardless of which pane is focused or how a split (spec 005) is divided. The protection this needs is vertical: the toast sits above whichever composer is currently tallest, tracked live (`composerHeightVar.ts`, a `ResizeObserver` per mounted composer plus a window-resize listener, published as a CSS custom property) rather than a fixed guess, since a composer's own textarea grows, split panes mount two independently-sized composers at once, and the measurement is each composer's own clearance to the viewport bottom (not just its height), so the status bar sitting below the whole chat workspace is folded in automatically. Below 600px window width, Sonner's own mobile breakpoint takes over positioning (`mobileOffset`), carrying the same live clearance for `bottom` plus a fixed `left`/`right` inset so the now-full-width toast still clears the right rail.

## Empty states

An empty state is an icon, one line saying what is empty, and the next action — nothing more. See "Placeholders and 'coming soon'" in [patterns.md](patterns.md) for what an empty state is never allowed to show instead.

## Panel header

Every panel and pane (chat, Agents, Pull requests, FDB panes, side chat) shares one panel header pattern (agenda item 8), built by `components/PanelHeader.tsx` (`ScreenHeader` wraps it; its `PANEL_HEADER_HEIGHT_CLASS` is the one 40px constant, also used by header-height rows that are not a `PanelHeader`; #1467): a fixed-height row, title left, ghost icon-only actions right. **Accepted rule change (Stuart, 2026-10-09):** a panel header carries no bottom divider line; it is separated from its own content by a different surface shade and/or whitespace instead. This reads #606's live-review removal of the `ChatHeader.tsx`/`SessionList.tsx`-header/`SubagentPanel.tsx`-header bottom border as the correct call, superseding this page's earlier "soft divider below" wording. The agenda item 8 decision proposed 40px pending a measurement against today's chat header; `ChatHeader.tsx`'s `<header>` carries `h-10` (40px), confirming 40px as the settled row height — see [foundations-typography-spacing.md](foundations-typography-spacing.md#panel-header-height) for the measurement.

### Open

Tab pattern details are deferred to #394.

**Settings pages (wave 2):** every Settings section is a `SettingsPage` (`components/settings/`; `max-w-2xl`, `wide` = `max-w-3xl` for Models) holding `SettingsGroup` blocks (`role=group` labelled by its h3) of `SettingRow` rows (label, description, optional 16px `icon`, control; stacks under about 480px). `SettingFieldRow` and `SettingSwitchRow` wrap `SettingRow`. Do not hand-copy row markup.

## Floating layer

A small floating panel over content (the previous and next message buttons) is the shared `FloatingLayer` (`src/renderer/components/floating-layer.tsx`): elevated `bg-popover` surface, border, shadow, a 120 ms fade (instant under reduced motion). When `visible` is false it fades out but stays reachable by keyboard focus (`focus-within` reveals it). Position it with `className`; do not hand-style a second floating box.

### Floating icon buttons

The icon buttons that float over the transcript (Previous message, Next message, Scroll to end) are a `secondary` `Button` with `size="icon-sm"` and the shared `FLOATING_ICON_BUTTON_CLASS` (`components/ui/message-scroller.tsx`): bordered `bg-surface-1`, `text-foreground`, `hover:bg-muted`. That secondary-surface floating button is the sanctioned style; do not copy the class string into a new button. Previous and Next sit in a `FloatingLayer` in `bare` mode (no panel chrome of its own, only the fade and focus-reveal), so each button is its own surface.

## Chat navigation (spec 041)

- **Previous and next message** (`MessageStepButtons`, in a `FloatingLayer`): reveal on scroll; Previous hides at the top, Next at the bottom. Keyboard shortcut via `useMessageStepShortcut`.
- **Outline** (`features/right-pane/outline/`): a right pane panel listing user and agent messages, following the active pane; a row jumps to the message.
- **Chat Find** (`features/chat-nav/search/`): Ctrl+F inside a chat pane opens `FindBar` and `FindResultsList`. Matches are painted with the CSS Custom Highlight API, not DOM edits. The current match is told apart by a heavier fill and a solid underline, the others by a lighter fill (a dotted underline in High contrast), so colour is never the only cue.
- **Scrollbar map** (`ScrollbarMap`): a canvas strip beside the scrollbar, `aria-hidden` because the buttons, Outline and Find are the keyboard routes. User marks are brighter (left half), agent marks dimmer (right half). Toggled by the Show scrollbar map setting.
- **Jump highlight:** the row a jump lands on shows a 2 px `--ring` outline for about 800 ms (`data-nav-highlight`).
- **Tokens and contrast:** `--find-match-bg`, `--find-match-current-bg` and `--scrollbar-map-*` have High contrast and forced-colors variants. `scripts/find-nav-contrast.mjs` (run by `check:theme-contrast`) checks text on each fill at 4.5:1, the two fills against each other, and the map marks against the track and the viewport window at 3:1, in every preset including High contrast.

## Banners

A pane banner (Worktree missing, Terminated unexpectedly, The agent stopped, start failed) is the shared `PaneBanner` (`src/renderer/components/PaneBanner.tsx`), decided for #746 (Stuart, 2026-10-29).

- **Unboxed.** A flat row at the pane's left edge: no border, no fill. A banner is not on the zero-box list.
- **Icon and title.** The severity icon (octagon for an error, triangle only for a warning) is the only red; the title is normal foreground, a short sentence with no trailing full stop.
- **Detail line.** The path, id or reason goes on a second muted line in the Code font, wrapping anywhere and selectable. Pass `detailMono={false}` for a prose sentence.
- **Actions.** One `outline` primary first (the action that fixes it; it takes the pane focus through `data-pane-banner`), the other actions as `text` buttons, a destructive action last as `text-destructive` with no fill. `destructive` stays the dialog confirm button only.
- **Live region.** `role="alert"` applies at appearance only. An expanding disclosure (Details) sits outside the banner element so toggling it never re-announces the banner.
- **Placement exception (recorded):** `StopBanner` stays under the pane header, while `AgentStoppedBar` and `RetryLine` sit above the composer in `ComposerAboveStack`; the stop banner replaces the composer path, the other two accompany it.
- Other rows in the family (for example the Turn error row, #1284) reuse `PaneBanner` rather than a hand-styled copy.

**RoleRow inline warning note.** A role row's `warning` prop (for example a WATCHDOG.yml roster overriding the Advisor role, #1409) renders as a muted line under the picker with a warning triangle and a bold "Warning:" lead, wrapping anywhere. It is an inline note, not a `PaneBanner`: it belongs to one row, has no actions, and is linked to the select through `aria-describedby`.

## Usage view components (spec 060, #1331)

Five shared pieces carry the Usage view; reuse them rather than copying.

- **Chart** (`components/ui/chart.tsx`): hand-written SVG (`StackedBarChart`, `BarChart`, `Sparkline`), no charting library. Series are told apart by fill pattern plus a legend with direct labels and totals, never colour alone; patterns are defined once per chart, and a `muted` series (such as "Other") uses the muted token. The chart has no heading: wrap it in a `ScreenSection` and put `useChartView(unavailable).toggle` (**View as table**, flipping to **View as chart**; `aria-pressed`, disabled while `unavailable`, that is loading or empty) in its `actions`. The table view is a `SortableTable`.
- **StatCard** (`components/StatCard.tsx`): a label, a value and an optional caption read as one labelled group (value and caption are its description); text wraps, never truncates.
- **SortableTable** (`components/SortableTable.tsx`): header buttons inside `th` cells carrying `aria-sort`, controlled sort, optional paging (Previous and Next use `aria-disabled` so focus survives the last page), a `loading` row and an empty row. Cells wrap.
- **ProgressStrip** (`components/ProgressStrip.tsx`): `role="progressbar"` with value, min, max and `aria-valuetext`, plus a polite live region that announces `doneText` only on a below-max to max change. Omit `doneText` when the screen owns the announcement.
- **OptionSelect** (`components/OptionSelect.tsx`): a compact "any or one of" select; the first item clears the filter; `optionLabel` maps a stored value to display text (for example `main` to "Main agent"). **Pinned filters** are the house pattern for list and dashboard screens (Pull requests, Issues, Usage): the `ListToolbar` sits outside the scroll area so it stays reachable, and its wrapper caps at `max-h-[40vh]` with `overflow-y-auto` so it cannot swallow the viewport at high zoom. Clear filters moves focus to the first filter, because its own button unmounts. `ScreenSection` `actions` wrap at narrow widths.

## App-wide polish rules (spec 071; #1399, #1395, #1387, #1385)

- **Select-type pickers are one ghost family** (#1399). `SelectTrigger` and `MultiSelectChecklist` share `SELECT_TRIGGER_CLASS` in `components/ui/select.tsx`: 32 px high, no border or fill at rest, a `bg-muted` hover fill, a 16 px muted chevron, a visible focus ring. There is no `size` prop. Every dropdown panel is at least its trigger wide and never under 9rem (`SELECT_PANEL_MIN_WIDTH_CLASS`, `POPOVER_PANEL_MIN_WIDTH_CLASS`), and its items share `SELECT_ITEM_BOX_CLASS`. Call sites pass no fixed width except the filter-bar `w-40` (spec 067), `OptionSelect` `max-w-44`, the `PerModelThresholdTable` `w-64` and form fields that fill their row.
- **Text fields are quiet** (#1395). `Input` and `Textarea` have no fill, a soft `border-field-border` edge (`--divider`; `--border` in High contrast) and no focus halo; focus swaps the border to `--ring`. High contrast keeps a 2px ring through `--field-ring-width`. Browse buttons next to a path field are `ghost`.
- **Action rows** (#1387; the `destructive-outline` variant was removed, #1449). Actions sit at the trailing edge, the primary rightmost and the only filled button on the surface; `CardFooter` right-aligns by default. Destructive secondary actions use `ghost-destructive` (red label, no fill). Exceptions: the composer Stop/Send, banners and centred empty states.
- **Chrome** (#1385). `.titlebar-surface` is transparent (High contrast keeps a hairline), the session list has no logo row, the holiday accessory (`HolidayAccessory`) sits before the avatar, and the Add project footer has an inset divider.
