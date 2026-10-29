# Components

This page covers the shared UI primitives: button, menus, tooltip, tabs and the right pane, cards and boxes, chips and pills, list rows, dialogs, toasts and notices, empty states, and the panel header. Decided by Stuart in the #474 grill, 2026-10-08, unless a rule says otherwise.

## Reusable components first

**Rule (Stuart, 2026-10-15, #934, ADR 0003):** "All UI elements should be re-usable components, enhanced when use cases add complexity." Every control a screen shows comes from a shared component in `src/renderer/components/`: a primitive in `components/ui/`, or a composed component that owns one recurring pattern (a screen header, a list toolbar, a search field, a session row). A new use case extends the shared component with a prop or slot; it never copies the markup into a feature folder or restyles a primitive in place (the hand-made selected class on Manage sessions' archive filter is the example that prompted the rule). The rule covers new UI and any UI a change touches; existing one-offs are inventoried in #935 and fixed one group per PR. Reviewers block a new one-off where a shared component exists or should exist.

Shared components decided in #934: **ScreenHeader** (**built**, `src/renderer/components/ScreenHeader.tsx`: back button, heading, plain-text count, trailing actions), **ListToolbar** (**built**, `src/renderer/components/ListToolbar.tsx`: Filter tabs, selects, SearchField, "Showing X of Y" while any filter is non-default), **SearchField** (leading magnifier, "Filter <things>…", Esc clears, a clear button once there is text -- **built** by issue #559 as `src/renderer/components/SearchField.tsx`, first used by the session list's own search; #934 adopts or extends it for Manage sessions rather than forking it), and one **Session row** shared by the Session list and Manage sessions (not yet built, follow-up). Toolbar controls are 32 px, including the Filter tabs strip.

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
| `default` (filled) | The single commit action in a dialog or form, and in first run (Add repository, Create, Save). One filled button per surface. |
| `ghost` | Icon-only toolbar and row actions. |
| `destructive` | The final confirm button inside a dialog only. Never at rest in a list or card. |
| `invert` | A solid, neutral fill (foreground-on-background inverted), never red/destructive. Composer Stop only (2026-10-15 grill, issue #564, decision 5): stopping a turn keeps the work done so far, the opposite of a destructive action, so it never takes the destructive colour. |
| `text` | A non-primary action in a banner (#746): foreground text, no border or fill, underlined on hover and keyboard focus, 2px focus ring, 24px minimum target. `text-destructive` is the same shape with a red label, for a destructive action that opens a confirm dialog. |
| `secondary`, `link` | Not part of the design system, except the one decided `link` use below. |

**Quiet dismiss text button (Stuart, 2026-10-26, #1205):** the "Agent stopped" bar's **Don't show again** is a `link` variant, muted at rest with `text-muted-foreground`, beside the bar's `outline` **Start agent**. A dismiss-forever action on a quiet bar reads as a text action, not a second button; the muted colour keeps **Start agent** the stronger action. Any other new `link` use still needs its own decision.

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

| Menu type | Icons | Examples |
|---|---|---|
| Action menus | Text only, never an icon | Session row, repository row, manage-session row, and every right-click context menu: Rename, Archive, Delete, Copy. |
| Destination and settings menus | A leading icon on every item | Profile, Appearance, GitHub accounts, Approval mode. |

Within a single menu it is all items or none: never a mix (matches the agenda item 1 rule that decisions are labels, not icons).

For both kinds:

- The shortcut, when one exists, is a right-aligned `Kbd`.
- Groups are split by separators.
- The destructive item is last, after a separator, in the destructive colour.
- Check marks and radio marks are allowed. **A single-choice menu is a real radio group** (`DropdownMenuRadioGroup`/`DropdownMenuRadioItem`, `menuitemradio` with `aria-checked`) whose leading radio mark is the shared `RADIO_RING_CLASS` ring-and-dot (`radio-group.tsx`; the same mark the Ask card's and Merge dialog's radios use, a `--foreground` ring), filled for the selected item; never a trailing check standing in for a radio (Stuart, 2026-10-19, #1043; #1065).

Evidence at `origin/main` 9f23d22: action-menu items carry no icons today (`SessionList.tsx:309-327` and `:420-422`, `ManageSessionRow.tsx:422-439`); the Profile and Approval mode menus already have a leading icon on nearly every item.

Decided (Stuart, 2026-10-19, #1043; swatch ruling amended 2026-10-20, ui-architect-v3): the Profile menu's theme submenu is a radio group; each theme's colour swatch is a small two-colour chip (the theme's own `--background` and `--primary`, split down the middle) after the name, never a round mark that could read as a radio. The swatch-versus-icon question for tokens and theming (#456, #458) is otherwise unchanged.

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

- **Icon rail.** A permanent strip at the window's right edge (48px wide, `RAIL_WIDTH_PX` in `src/shared/layout.ts`), one 40px icon button (`Button` size `icon-xl`) with a 24px icon per available panel. The pressed button keeps a `bg-muted` fill and colours its glyph `text-accent-text` (no border). The rail stays visible when the pane is collapsed, so every panel and its count stay reachable. The rail and the pane use the `--sidebar-right` surface.
- **Collapsible pane.** Beside the rail, resizable by dragging its border, collapsible to nothing and restorable with the same panels and tab order. One component owns the open, collapsed, and width state for every panel; no panel manages its own open flag. The WCAG 2.5.7 alternative to dragging is `PaneWidthMenu` (Narrow 240 / Default 320 / Wide 520 / Close pane, current width marked), offered from the handle's context menu (right-click, Shift+F10) and the app menu bar's "Right pane width" dropdown; the handle also takes Arrow, Home/End and double-click (reset to 320), and its accessible name includes the current width. See [accessibility.md](accessibility.md#wcag-22-aa-checklist).
- **Tab bar.** Two or more open panels get a tab bar (ARIA tabs pattern), the active tab marked by more than colour, each tab closable, and each tab also showing that panel's live count. One open panel shows its own title row and close button, no tab strip.
- **Launcher list.** With the pane open and no panel open, a centred (both vertically and horizontally) list of every available panel, each row a button with its icon, name, and (when it has one) its count. Closing the last open panel closes only that panel; the pane stays open on the launcher list. This supersedes #394's "closing the last tab closes the panel."
- **Counts.** Agents: the number running, with an agents icon, in the running colour. Git changes: `+additions` in green and `−deletions` in red, with a git icon. Counts are never colour alone — see [accessibility.md](accessibility.md).

Decided for #538 (spec 024, Skippy delegated by Stuart 2026-10-26, see the decision comment on #538): rail icons carry count badges while the pane is collapsed (a running Subagent count in the running colour, a neutral changed-file count, "9+" over nine, never colour alone); the rail's top button collapses and expands the pane (`aria-expanded`, Ctrl+Shift+B, which never fires while an overlay is open); open or collapsed, width, open panels in tab order and the active tab persist in `Settings.rightPane`, restored before first paint and written only by `right-pane-persistence.ts`. It amends spec 013 as spec 024 rather than reopening specs 004 and 005. Not in scope: dragging the rail to rearrange (#730), the header-row reorder (#674), and a View-menu item.

## Reorderable lists

A list whose items the user can rearrange uses `useReorderable` (`src/renderer/components/reorder/use-reorderable.ts`) and `ReorderAnnouncer`, never its own drag code (issue #730). Pointer drag starts after 6 px so a click still works, Esc cancels, `Alt+Shift+Up/Down` (Left/Right on a horizontal list, `axis: 'x'`) is the keyboard alternative (WCAG 2.5.7), each move is announced politely, the moved item keeps focus, and `REORDER_MARKER_CLASS` draws the insertion bar on a `relative` item. The icon rail is the first consumer; #638 (repositories) adopts it next.

## Cards and boxes

The zero-box rule (#556, settled against the AI Studio mock review #549, agenda item 9/8): a box — a fill or a border around content — is allowed only where it marks something interactive or needing a hard boundary:

- The composer.
- Decision cards (approval, question).
- Dialogs and floating layers.
- Code blocks, inline code, diffs and tables.
- Rendered diagrams (code-block family, e.g. `Markdown.tsx`'s Mermaid `<img>`).
- Attachments and chips, including the pasted-text preview dialog (`TextPreviewModal.tsx`, code-block family).

Everything else — tool rows, thinking, notices, subagent rows, agent messages — is an unboxed row separated by spacing, with a **Spine** (a neutral `border-divider` left rule hanging from a group header's own status icon, never coloured or animated, issue #565) or a divider only when grouping is needed. No box inside a box: a nested card loses its own box and uses a soft divider instead.

Stuart's own "Self vs. other layout" rule (2026-10-04, in [product-chat.md](product-chat.md)) makes the user's own message bubble a standing exception: its fill marks authorship, not a card around content. **2026-10-16 delegated addition (Skippy, delegated by Stuart, #556):** it is never nested inside another box, and only Markdown's code-family surfaces (code blocks, inline code, tables, rendered diagrams) render inside it. **2026-10-18 delegated addition (Skippy, delegated by Stuart, #926, FR-035):** a file/folder attachment chip is a second written exception -- the sent bubble renders the SAME chip the composer strip already allows (line 112's own "Attachments and chips" bullet), never raw inlined text or a bare path line, so a 256 KB inlined file never floods the transcript. **2026-10-27 (#513):** message images (the MessageImageGrid tiles) are a third: a bordered thumbnail in the bubble, never a card around it.

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

A list row (session row, repository row, subagent row) is an unboxed row under the zero-box rule, with a state icon or leading icon, its label, and trailing actions. Repeated row actions are icon-only with a tooltip (agenda item 1). The row's own action menu is an action menu (text only, see "Menus" above) reachable from an `⋮` trigger, a right-click, and the row's native context-menu keys (`Shift+F10`, the Menu key).

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

Every panel and pane (chat, Agents, Pull requests, FDB panes, side chat) shares one panel header pattern (agenda item 8): a fixed-height row, title left, ghost icon-only actions right. **Accepted rule change (Stuart, 2026-10-09):** a panel header carries no bottom divider line; it is separated from its own content by a different surface shade and/or whitespace instead. This reads #606's live-review removal of the `ChatHeader.tsx`/`SessionList.tsx`-header/`SubagentPanel.tsx`-header bottom border as the correct call, superseding this page's earlier "soft divider below" wording. `PullRequestsView.tsx`'s header still carries its original full-strength `border-border` today -- **not** this rule, an inconsistency left for the #579 sweep to fix, not a second accepted pattern. The agenda item 8 decision proposed 40px pending a measurement against today's chat header; `ChatHeader.tsx`'s `<header>` carries `h-10` (40px), confirming 40px as the settled row height — see [foundations-typography-spacing.md](foundations-typography-spacing.md#panel-header-height) for the measurement.

### Open

Tab pattern details are deferred to #394.

**Settings pages (wave 2):** every Settings section is a `SettingsPage` (`components/settings/`; `max-w-2xl`, `wide` = `max-w-3xl` for Models) holding `SettingsGroup` blocks (`role=group` labelled by its h3) of `SettingRow` rows (label, description, optional 16px `icon`, control; stacks under about 480px). `SettingFieldRow` and `SettingSwitchRow` wrap `SettingRow`. Do not hand-copy row markup.

## Banners

A pane banner (Worktree missing, Terminated unexpectedly, The agent stopped, start failed) is the shared `PaneBanner` (`src/renderer/components/PaneBanner.tsx`), decided for #746 (Stuart, 2026-10-29).

- **Unboxed.** A flat row at the pane's left edge: no border, no fill. A banner is not on the zero-box list.
- **Icon and title.** The severity icon (octagon for an error, triangle only for a warning) is the only red; the title is normal foreground, a short sentence with no trailing full stop.
- **Detail line.** The path, id or reason goes on a second muted line in the Code font, wrapping anywhere and selectable. Pass `detailMono={false}` for a prose sentence.
- **Actions.** One `outline` primary first (the action that fixes it; it takes the pane focus through `data-pane-banner`), the other actions as `text` buttons, a destructive action last as `text-destructive` with no fill. `destructive` stays the dialog confirm button only.
- **Live region.** `role="alert"` applies at appearance only. An expanding disclosure (Details) sits outside the banner element so toggling it never re-announces the banner.
- Other rows in the family (for example the Turn error row, #1284) reuse `PaneBanner` rather than a hand-styled copy.