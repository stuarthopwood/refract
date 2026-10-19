# Accessibility

This page makes the WCAG 2.2 AA rules from the #474 grill testable, and gives the design-system checklist used at the Spec Kit plan gate. Decided by Stuart in the #474 grill, 2026-10-08.

## WCAG 2.2 AA checklist

Each item names the criterion, the rule, and where to check it.

| Criterion | Rule | Where it applies |
|---|---|---|
| **1.4.1** Use of color | Colour is never the only signal. Session state, severity, and change counts each pair a colour with a distinct icon shape and a visible or `sr-only` word. | State icons and severity icons ([components.md](components.md), [patterns.md](patterns.md)); git-change counts, green/red ([components.md](components.md#tabs-and-the-right-pane)). |
| **1.4.11** Non-text contrast | Control edges (inputs, outline buttons, toggles, the focus ring) meet at least 3:1 against what is behind them. Decorative dividers (between panes, rows, headers, sections) carry no contrast requirement; they are soft by design. | [foundations-tokens-theming.md](foundations-tokens-theming.md) (surface ladder and edges). |
| **1.4.13** Content on hover or focus | A tooltip (or any hover/focus popover) is dismissible with Esc without moving pointer or focus, hoverable (the pointer can reach it without it closing — never set Radix's `disableHoverableContent`), and persistent until hover or focus leaves or the user dismisses it. (Keyboard focus-visible reveal is a separate requirement, tracked in the Tooltip bundle, not part of 1.4.13 itself.) | Tooltip bundle ([components.md](components.md#tooltip)). |
| **2.2.2** Pause, stop, hide | Open: no user-operable pause path is decided yet for animations that can run unbounded (the subagent-row shimmer, the waiting three-dot animation, the streaming caret, the agent-working spinner (`AgentSpinner`, issue #612), every `animate-spin` icon — `Loader2Icon`/`LoaderCircleIcon` on sign-in, readiness, running tool rows (`ToolRow.tsx:55`), the streaming thinking row (`ThoughtRunRow.tsx:37-42,206-217`), running subagents (`SubagentPanel.tsx:31`), readiness rows (`CheckRow.tsx:47`), and the New session button (`SessionList.tsx:390`) — the spinning `CheckIcon` for a pending PR check (`PullRequestRow.tsx:74`, `PullRequestDetail.tsx:210`), the spinning `RefreshCwIcon` on pull-request refresh (`PullRequestList.tsx:86`, `PullRequ…
| **2.3.3** Animation from interactions (AAA, adopted beyond AA) | `prefers-reduced-motion: reduce` disables transitions and spinners globally, replacing a spinner with a static glyph plus the word; colour, icon, and `sr-only` state text remain as the non-motion signal. | [foundations-motion.md](foundations-motion.md#reduced-motion) (Reduced motion). |
| **2.5.3** Label in name | An accessible name starts with its own visible text; an icon-only control's accessible name equals its tooltip text. | Tooltip ([components.md](components.md)); profile item sign-in states (existing rule). |
| **2.5.8** Target size (minimum) | Every pointer target is at least 24×24 CSS px, or meets the spacing exception: a 24px circle centred on the bounding box of each undersized target does not intersect another target or the 24px circle of any other undersized target. Exempt: inline text links, user-agent-controlled controls, essential targets where the function itself requires a smaller size, and Equivalent (the same function is available through another control on the page that meets 24×24). | Targets, below; [Known gaps for the #579 sweep](#known-gaps-for-the-579-sweep). |
| **2.5.7** Dragging movements | Every drag-only action (pane and splitter resize) has a single-pointer, non-drag alternative — for example width-preset buttons or a menu — alongside the pointer drag. | Tabs and the right pane ([components.md](components.md#tabs-and-the-right-pane)) — alternative not yet specified; see Open, below. |
| **2.4.11** Focus not obscured (minimum) | A keyboard-focused element is never entirely hidden behind a sticky header, the composer, or a floating layer (menu, dialog, toast). | Open: not yet audited against the composer and floating-layer stacking; no page defines an implementation rule for it yet (the WCAG rule itself is stated in this row). |
| **3.3.8** Accessible authentication (minimum) | The device flow's one-time code is a transcription step, mitigated by the Copy code button (`AddAccountPanel.tsx:132-135`) so the user can paste it instead of retyping. GitHub's own sign-in page (password, 2FA) is third-party and not audited here. | Manage accounts / GitHub sign-in. |

### Accessible names

Every icon-only control has an `aria-label` that equals its tooltip text, verb first, sentence case (see "Microcopy vocabulary" in [patterns.md](patterns.md)). A control whose only content is an icon and that lacks an `aria-label` is a defect, not a style choice.

### Contrast

- Normal text: at least 4.5:1; non-text UI (focus rings, borders, status icons shown without accompanying text): at least 3:1. `pnpm check:theme-contrast` verifies the pairs in its `PAIRS` list (`scripts/theme-contrast-pairs.mjs`) for every `.theme-*` block that exists in `globals.css` today — all five built-in presets, `.theme-dark`, `.theme-dark-high-contrast`, `.theme-obsidian`, `.theme-nordic-frost` and `.theme-cyber-amber` (#551); `pnpm check:mermaid-contrast` covers Mermaid diagram colours only, never app text, and cannot run at all since #796 (it needs a real Electron renderer to capture, and the Electron build is deleted) until it is reworked onto Tauri/WebView2 (#388). A pair whose token is missing from a theme block is reported as `pass: null, note: 'token missing'` and skipped — it does not fail the run or count toward checked pairs (`check-theme-contrast.mjs:196-198`).
- Accent text (links, focus, the indigo accent token) needs its own lighter token per canvas, since the base accent value fails 4.5:1 as text on both the Dark and Obsidian canvases — see "Accent and primary fill" in [foundations-tokens-theming.md](foundations-tokens-theming.md). White on the base accent `#6366F1` is **4.467:1**, which **fails** the 4.5:1 normal-text threshold; this corrects an earlier, rounded figure (4.5:1) quoted in the mock review and an earlier draft of the same decision. Use the measured 4.467:1 figure as the one source of truth; do not reintroduce the rounded number. Issue #610 added `accent-text` to `check-theme-contrast.mjs`'s `PAIRS` list against `background`/`card`/`popover`, plus a dedicated composited pair for the user message bubble's own `accent/50`-on-`background` fill; `Markdown.tsx`'s `linkClassName` (web/file links) and `mutedLinkClassName` (the same links on a `bg-muted` surface, where `accent-text` fails 4.5:1 -- underline only, inherited colour, there) are the first real consumers. All pairs PASS in every theme.
- Dark (high contrast) raises every value: text 7:1, every edge including dividers 4.5:1 (soft dividers are switched off in this theme), and no tone-only depth between surfaces — borders carry it instead. Same components and rules as Dark; only the token values change, so it stays a theme file, not a separate component set. **Focus-ring width is unresolved across the docs**: the grill record calls the high-contrast ring "a thicker 2px," but [foundations-motion.md](foundations-motion.md)'s base Focus rule is also 2px, and the code's actual ring (`button.tsx:7`, `focus-visible:ring-3`) is 3px today — the numbers don't resolve to a consistent "thicker," so treat the exact pair (for example 2px default / 3px high contrast) as open pending Stuart's confirmation rather than picked here. None of these raised values are checked by the script yet.
- Obsidian, Nordic Frost and Cyber Amber (#550, #551) all have their own `.theme-*` block in `globals.css` and are checked by `check-theme-contrast` the same way Dark and Dark (high contrast) are; theme-file loading (import and export) is still not built, so there is no loader to run the check against once a user-supplied theme exists.

### Targets

WCAG 2.5.8 applies to every pointer target, not only icon-only controls: each is at least 24×24 CSS px, or meets the spacing exception: a 24px circle centred on the bounding box of each undersized target does not intersect another target or the 24px circle of any other undersized target. Exempt: inline text links, user-agent-controlled controls (for example a native `<select>`), essential targets where the function itself requires a smaller size, and Equivalent (the same function is available through another control on the page that meets 24×24). Icon-only buttons meet the floor through `icon-xs` (24px) and `icon-sm` (28px); see "Sizes" in [components.md](components.md).

#### Known gaps for the #579 sweep

Existing controls measured below 24px, verified in code, not fixed by this documentation change:

- `Switch` (`switch.tsx:29`): `h-5` is a 20px-tall target.
- The resizable-panel handle (`resizable.tsx:37`): the hit area (`after:w-1`) is 4px wide; the visible line is 1px. It also needs the single-pointer resize alternative above (2.5.7).
- The pasted-image remove button (`AttachmentStrip.tsx:41-49`, `size-4`): a 16px target.
- The queued-message remove button (`MessageInput.tsx:717-720`, `p-0.5` around a `size-3` icon): about 16px.
- The session-row and repository-header `⋮` menu triggers (`SessionList.tsx:299-301` and `:414-416`, `p-1` around a `size-3.5` icon): about 22px.

### Hover-only actions need a keyboard path

Nothing in Refract exists only in a context menu or only on hover. Every action reachable by hovering a row (row actions, the Repository actions menu) or by right-clicking (#471) is also reachable by keyboard:

- The row's own `⋮` menu trigger, reachable by Tab.
- The Menu key and `Shift+F10` open the same menu as a right-click, once the row has focus.
- Arrow keys and type-ahead move inside the menu; Esc closes it and returns focus to the triggering element.

### High contrast theme

Dark (high contrast) is a theme file, not a separate design: the same components, the same zero-box rule, the same icon set, with only the token values listed above changed. A component must never branch its markup or its icon choice on which theme preset is active; only CSS custom properties change.

**Decision (Stuart, 2026-10-08, agenda items 7 and 9; #552): keep colour-coded glyphs, raise every value.** Dark (high contrast) keeps all state and severity colours and their distinct icons, but raises text to 7:1, every edge including dividers to 4.5:1 (soft dividers switched off), widens the focus ring, and gives borders the depth cue instead of tone — see "High contrast preset" in [foundations-tokens-theming.md](foundations-tokens-theming.md) for the full value list. The mock's alternative **Terminal Monochrome** treatment (every state colour white, glyph-and-label only) is **not adopted**: this app's existing one-icon-per-state convention (1.4.1, above) already removes colour as the only signal, so collapsing every severity to one hue would trade a working redundancy for a new one without fixing anything, and the new pill/count surfaces named in #552 (#529 PR states, #538 change counts) keep their colour-plus-icon-or-sign pairing unchanged. This answers #552's own open question (which option); the full redesign this decision calls for — every edge and divider at 4.5:1, the wider ring — is not built here, so #552 stays open.

**Decided; delivered so far (Skippy, delegated by Stuart 2026-10-18, #552): the red (severity/stopped/PR-closed) now clears 7:1.** `--destructive`/`--severity-error`/`--state-stopped`/`--pr-closed` (one literal value, duplicated per #570's own "literal copies, not var aliases" rule) previously measured about 6.65:1 against `--muted`/hover and `--sidebar-accent` (#570 decision 20, recorded on #552 2026-10-16) — under this theme's own declared 7:1 high-contrast text floor, though still clearing the ordinary 4.5:1 AA floor every preset is held to. Raised `oklch(0.78 0.17 22)` to `oklch(0.82 0.17 22)` (same hue/chroma): now 7.26:1 against `--muted`/`--sidebar-accent` (the binding surfaces), 9.82:1 against `--background`, 9.30:1 against `--card`/`--popover`. `scripts/theme-contrast-pairs.mjs` gained dedicated `severity-error`/`muted`, `state-stopped`/`sidebar-accent` and `pr-closed`/`muted` pairs at `min: 7`, scoped to this theme — the other presets are not held to a 7:1 floor by their own design, only the ordinary 4.5:1 AA floor. **Not covered by this fix**: the destructive Button variant's own translucent hover/focus fill (`hover:bg-destructive/80`) still measures only about 6.7:1 against a dialog-footer backdrop — real AA (4.5:1), not this theme's own stricter 7:1 target, since that fill is a reduced-opacity composite, not the flat token. The raised value's rendered hex (`#ff9391`) reads visually warmer/coral than the un-raised `#ff8685`, an effect of this app's OKLCH-to-sRGB gamut clipping at this lightness/chroma combination (`check-theme-contrast.mjs`'s own header note), not a hue change — the token's hue stays `22` throughout. `check:theme-contrast`: 763/763 pairs across 5 themes PASS (two more HC-only pairs added for `state-stopped`/`sidebar-accent` and `pr-closed`/`muted`, #551's own additional pairs for the two new presets, and 30 more after merging `origin/main`'s #925/#924 `--diff-added`/`--diff-removed` pairs — Nordic Frost/Cyber Amber were missing those two tokens post-merge since they were built in a parallel branch before #967 added them; fixed in `globals.css` by aliasing the same way Dark/Obsidian/HC already do). Every other part of #552's decision (every other edge/divider at 4.5:1, the wider ring) stays deferred, as recorded in "High contrast preset" in [foundations-tokens-theming.md](foundations-tokens-theming.md) and the surface-ladder note there.

### Accepted departures

Departures from the checklist above that Stuart accepted on purpose. Each names its scope, so nothing else may cite it.

- **Quiet composer (Stuart, 2026-10-16, issue #927).** In Dark and Obsidian, the composer's border and the focus outline of its controls (Approval mode, Model, Reasoning, Attach, the text field) fall below 3:1 (1.4.11 non-text contrast; 2.4.7 focus stays visible, only muted). Hover is never the only interactive cue: keyboard focus still draws the muted outline. Dark (high contrast) keeps the full 3:1 edges and focus ring. The difference lives in token values only (`--composer-border`, the composer focus and control-edge tokens), never in markup, per the rule above. **Extended (Skippy, delegated by Stuart 2026-10-18, #551): Nordic Frost and Cyber Amber are the same non-HC dark family with the same quiet-composer intent, so this departure covers them too** — both ship a transparent `--composer-background` exactly like Dark/Obsidian; `scripts/theme-contrast-pairs.mjs`'s `onlyThemes`/`informationalThemes` scopes for this pair list both new ids alongside `dark`/`obsidian`, same informational (never-enforced) reporting.

## Design-system checklist (Spec Kit plan gate)

Governance (agenda item 12) decided to put this checklist in the Spec Kit plan template; it is not wired in yet (`.specify/templates/plan-template.md` has no design-system section today — see "Open," below). Until it is, apply this checklist by hand: one box per rule, grouped by the page it comes from, checked against a story's plan before work starts, or the plan names which boxes do not apply and why.

### Foundations ([foundations-tokens-theming.md](foundations-tokens-theming.md), [foundations-typography-spacing.md](foundations-typography-spacing.md), [foundations-icons.md](foundations-icons.md), [foundations-motion.md](foundations-motion.md))

- [ ] No hex literals or Tailwind palette colours in component code; only semantic or component tokens.
- [ ] No opacity modifiers on a token class (`bg-accent/50`); alpha lives inside the token value.
- [ ] Spacing uses only the 4/8/12/16/24px steps; no arbitrary pixel values.
- [ ] Icons are `lucide-react` by default; `@tabler/icons-react` is used only when lucide lacks the needed icon (2026-10-10, supersedes the brand-marks-only limit).
- [ ] Icon size matches its context (12/14/16px ladder).
- [ ] New animation has a reduced-motion fallback, verified by running the app with OS reduced motion on (constitution: automated tests are not required), and a pause path if it can run longer than 5s (blocked on #566 for the pause mechanism; record as not yet satisfiable until it is decided).
- [ ] Theme-file loading treats the file as untrusted and meets every point of [Untrusted input](foundations-tokens-theming.md#theme-files): main-process loader reached only through the preload allowlist, path stays in the themes folder with no symlink following, size cap, try/catch parsing, known token names only (unknown keys rejected), colour-grammar values only, no `url()` or at-rules, import via the same validator, export only via a save dialog, security policy unchanged.

### Components ([components.md](components.md))

- [ ] Button variant matches its role (`outline` default, `default` only for the one commit action, `ghost` for icon-only, `destructive` only as a dialog confirm).
- [ ] No new use of `secondary` or `link` button variants.
- [ ] Menu items are all-icon or all-text within one menu, matching its type (action versus destination/settings).
- [ ] Destructive menu item is last, after a separator.
- [ ] Every icon-only control has a `Tooltip`, matching `aria-label`, a 24px+ target (the strict icon-only bundle has no spacing exception; the general 2.5.8 rule above covers other targets), and a keyboard focus-visible reveal.
- [ ] No box (fill or border) outside the components.md "Cards and boxes" allow-list or its named user-bubble exception, and no box nested inside another box (zero-box rule, #556).
- [ ] A grouped list of rows (a tool group, a Stage, the Subagent chain) hangs from a **Spine** -- one neutral `border-divider` left rule, never coloured, animated, or shown for a group of exactly one member (issue #565).
- [ ] Toast/banner/inline/transcript channel matches the scope of the message, and errors never auto-dismiss. Exception: slash-command refusal warnings stay until dismissed, with a close button (#997).

### Patterns ([patterns.md](patterns.md))

- [ ] Button and tooltip text matches the Add/New/Create/Cancel/Close/Dismiss/Remove/Delete/Archive vocabulary.
- [ ] Confirm buttons repeat the verb; never "OK" or "Yes."
- [ ] No unbuilt feature shown as "Coming soon" or disabled-with-reason; it is hidden, or (only for #393's panes) shown as labelled, switchable sample data.
- [ ] `pnpm check:ui-text` passes on the built bundle (no leaked requirement/task/story terms).

### Accessibility (this page)

- [ ] Colour is never the sole signal for state, severity, or a count.
- [ ] `pnpm check:theme-contrast` exits 0 and its table shows no `token missing` row for any theme (a pair with a missing token is skipped, not failed, so a clean exit code alone does not prove full coverage).
- [ ] Pairs the script does not cover yet (high-contrast's remaining 4.5:1 edges beyond the red severity/stopped/PR-closed pairs already at 7:1, any loaded theme file, the accent-as-text token) are measured by hand and the ratios recorded in the plan.
- [ ] Every hover-only or context-menu-only action has a keyboard path.
- [ ] Focus returns to the triggering element after a menu or dialog closes.

## Open

- Compliance beyond this checklist — an automated lint for palette-colour and alpha-modifier leaks, and for icon-only controls missing a `Tooltip` — is planned to sit beside `check:ui-text` and the contrast scripts, but is not built yet (agenda item 12), and this checklist is not yet wired into the Spec Kit plan template either. Until both exist, nothing enforces these rules automatically; reviewers apply this checklist by hand.
- The pause path for looping animations (2.2.2) is not decided: #566 leaves open whether pausing is a dedicated Settings switch or follows the OS reduced-motion setting. Neither pausing on a hidden window nor honouring `prefers-reduced-motion` satisfies 2.2.2 on its own.
- A single-pointer alternative to dragging the right pane's border (2.5.7) is not yet specified; see "Tabs and the right pane" in [components.md](components.md#tabs-and-the-right-pane).
