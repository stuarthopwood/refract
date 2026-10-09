# Accessibility

This page makes the WCAG 2.2 AA rules from the #474 grill testable, and gives the design-system checklist used at the Spec Kit plan gate. Decided by Stuart in the #474 grill, 2026-10-08.

## WCAG 2.2 AA checklist

Each item names the criterion, the rule, and where to check it.

| Criterion | Rule | Where it applies |
|---|---|---|
| **1.4.1** Use of color | Colour is never the only signal. Session state, severity, and change counts each pair a colour with a distinct icon shape and a visible or `sr-only` word. | State icons and severity icons ([components.md](components.md), [patterns.md](patterns.md)); git-change counts, green/red ([components.md](components.md#tabs-and-the-right-pane)). |
| **1.4.11** Non-text contrast | Control edges (inputs, outline buttons, toggles, the focus ring) meet at least 3:1 against what is behind them. Decorative dividers (between panes, rows, headers, sections) carry no contrast requirement; they are soft by design. | [foundations-tokens-theming.md](foundations-tokens-theming.md) (surface ladder and edges). |
| **1.4.13** Content on hover or focus | A tooltip (or any hover/focus popover) is dismissible with Esc without moving pointer or focus, hoverable (the pointer can reach it without it closing — never set Radix's `disableHoverableContent`), and persistent until hover or focus leaves or the user dismisses it. (Keyboard focus-visible reveal is a separate requirement, tracked in the Tooltip bundle, not part of 1.4.13 itself.) | Tooltip bundle ([components.md](components.md#tooltip)). |
| **2.2.2** Pause, stop, hide | Open: no user-operable pause path is decided yet for animations that can run unbounded (the subagent-row shimmer, the waiting three-dot animation, the streaming caret, the agent-working spinner (`AgentSpinner`, issue #612), every `animate-spin` icon — `Loader2Icon`/`LoaderCircleIcon` on sign-in, readiness, running tool rows (`ToolRow.tsx:55`), the streaming thinking row (`Transcript.tsx:195`), running subagents (`SubagentPanel.tsx:31`), readiness rows (`CheckRow.tsx:47`), and the New session button (`SessionList.tsx:390`) — the spinning `CheckIcon` for a pending PR check (`PullRequestRow.tsx:74`, `PullRequestDetail.tsx:210`), the spinning `RefreshCwIcon` on pull-request refresh (`PullRequestList.tsx:86`, `PullRequestDetail.tsx:221`), the remaining `LoaderCircleIco…
| **2.3.3** Animation from interactions (AAA, adopted beyond AA) | `prefers-reduced-motion: reduce` disables transitions and spinners globally, replacing a spinner with a static glyph plus the word; colour, icon, and `sr-only` state text remain as the non-motion signal. | [foundations-motion.md](foundations-motion.md#reduced-motion) (Reduced motion). |
| **2.5.3** Label in name | An accessible name starts with its own visible text; an icon-only control's accessible name equals its tooltip text. | Tooltip ([components.md](components.md)); profile item sign-in states (existing rule). |
| **2.5.8** Target size (minimum) | Every pointer target is at least 24×24 CSS px, or meets the spacing exception: a 24px circle centred on the bounding box of each undersized target does not intersect another target or the 24px circle of any other undersized target. Exempt: inline text links, user-agent-controlled controls, essential targets where the function itself requires a smaller size, and Equivalent (the same function is available through another control on the page that meets 24×24). | Targets, below; [Known gaps for the #579 sweep](#known-gaps-for-the-579-sweep). |
| **2.5.7** Dragging movements | Every drag-only action (pane and splitter resize) has a single-pointer, non-drag alternative — for example width-preset buttons or a menu — alongside the pointer drag. | Tabs and the right pane ([components.md](components.md#tabs-and-the-right-pane)) — alternative not yet specified; see Open, below. |
| **2.4.11** Focus not obscured (minimum) | A keyboard-focused element is never entirely hidden behind a sticky header, the composer, or a floating layer (menu, dialog, toast). | Open: not yet audited against the composer and floating-layer stacking; no page defines an implementation rule for it yet (the WCAG rule itself is stated in this row). |
| **3.3.8** Accessible authentication (minimum) | The device flow's one-time code is a transcription step, mitigated by the Copy code button (`AddAccountPanel.tsx:132-135`) so the user can paste it instead of retyping. GitHub's own sign-in page (password, 2FA) is third-party and not audited here. | Manage accounts / GitHub sign-in. |

### Accessible names

Every icon-only control has an `aria-label` that equals its tooltip text, verb first, sentence case (see "Microcopy vocabulary" in [patterns.md](patterns.md)). A control whose only content is an icon and that lacks an `aria-label` is a defect, not a style choice.

### Contrast

- Normal text: at least 4.5:1; non-text UI (focus rings, borders, status icons shown without accompanying text): at least 3:1. `pnpm check:theme-contrast` verifies the pairs in its `PAIRS` list (`scripts/check-theme-contrast.mjs:153-183`) for every `.theme-*` block that exists in `globals.css` today (`.theme-dark`, `.theme-dark-high-contrast`); `pnpm check:mermaid-contrast` covers Mermaid diagram colours only, never app text. A pair whose token is missing from a theme block is reported as `pass: null, note: 'token missing'` and skipped — it does not fail the run or count toward checked pairs (`check-theme-contrast.mjs:196-198`).
- Accent text (links, focus, the indigo accent token) needs its own lighter token per canvas, since the base accent value fails 4.5:1 as text on both the Dark and Obsidian canvases — see "Accent and primary fill" in [foundations-tokens-theming.md](foundations-tokens-theming.md). White on the base accent `#6366F1` is **4.467:1**, which **fails** the 4.5:1 normal-text threshold; this corrects an earlier, rounded figure (4.5:1) quoted in the mock review and an earlier draft of the same decision. Use the measured 4.467:1 figure as the one source of truth; do not reintroduce the rounded number. This accent-as-text pair is not yet in `check-theme-contrast.mjs`'s `PAIRS` list; verify it by hand until it is added.
- Dark (high contrast) raises every value: text 7:1, every edge including dividers 4.5:1 (soft dividers are switched off in this theme), and no tone-only depth between surfaces — borders carry it instead. Same components and rules as Dark; only the token values change, so it stays a theme file, not a separate component set. **Focus-ring width is unresolved across the docs**: the grill record calls the high-contrast ring "a thicker 2px," but [foundations-motion.md](foundations-motion.md)'s base Focus rule is also 2px, and the code's actual ring (`button.tsx:7`, `focus-visible:ring-3`) is 3px today — the numbers don't resolve to a consistent "thicker," so treat the exact pair (for example 2px default / 3px high contrast) as open pending Stuart's confirmation rather than picked here. None of these raised values are checked by the script yet.
- Obsidian (the `#0F1014` canvas preset) has no `.theme-*` block in `globals.css` yet, so `check-theme-contrast` cannot measure it today; theme-file loading (import and export) is not built either, so there is no loader to run the check against once a user-supplied theme exists.

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

## Design-system checklist (Spec Kit plan gate)

Governance (agenda item 12) decided to put this checklist in the Spec Kit plan template; it is not wired in yet (`.specify/templates/plan-template.md` has no design-system section today — see "Open," below). Until it is, apply this checklist by hand: one box per rule, grouped by the page it comes from, checked against a story's plan before work starts, or the plan names which boxes do not apply and why.

### Foundations ([foundations-tokens-theming.md](foundations-tokens-theming.md), [foundations-typography-spacing.md](foundations-typography-spacing.md), [foundations-icons.md](foundations-icons.md), [foundations-motion.md](foundations-motion.md))

- [ ] No hex literals or Tailwind palette colours in component code; only semantic or component tokens.
- [ ] No opacity modifiers on a token class (`bg-accent/50`); alpha lives inside the token value.
- [ ] Spacing uses only the 4/8/12/16/24px steps; no arbitrary pixel values.
- [ ] Icons are `lucide-react` only, except a documented third-party brand mark (`@tabler/icons-react`).
- [ ] Icon size matches its context (12/14/16px ladder).
- [ ] New animation has a reduced-motion fallback, verified by running the app with OS reduced motion on (constitution: automated tests are not required), and a pause path if it can run longer than 5s (blocked on #566 for the pause mechanism; record as not yet satisfiable until it is decided).
- [ ] Theme-file loading treats the file as untrusted and meets every point of [Untrusted input](foundations-tokens-theming.md#theme-files): main-process loader reached only through the preload allowlist, path stays in the themes folder with no symlink following, size cap, try/catch parsing, known token names only (unknown keys rejected), colour-grammar values only, no `url()` or at-rules, import via the same validator, export only via a save dialog, security policy unchanged.

### Components ([components.md](components.md))

- [ ] Button variant matches its role (`outline` default, `default` only for the one commit action, `ghost` for icon-only, `destructive` only as a dialog confirm).
- [ ] No new use of `secondary` or `link` button variants.
- [ ] Menu items are all-icon or all-text within one menu, matching its type (action versus destination/settings).
- [ ] Destructive menu item is last, after a separator.
- [ ] Every icon-only control has a `Tooltip`, matching `aria-label`, a 24px+ target (the strict icon-only bundle has no spacing exception; the general 2.5.8 rule above covers other targets), and a keyboard focus-visible reveal.
- [ ] No new box nested inside another box (zero-box rule).
- [ ] Toast/banner/inline/transcript channel matches the scope of the message, and errors never auto-dismiss.

### Patterns ([patterns.md](patterns.md))

- [ ] Button and tooltip text matches the Add/New/Create/Cancel/Close/Dismiss/Remove/Delete/Archive vocabulary.
- [ ] Confirm buttons repeat the verb; never "OK" or "Yes."
- [ ] No unbuilt feature shown as "Coming soon" or disabled-with-reason; it is hidden, or (only for #393's panes) shown as labelled, switchable sample data.
- [ ] `pnpm check:ui-text` passes on the built bundle (no leaked requirement/task/story terms).

### Accessibility (this page)

- [ ] Colour is never the sole signal for state, severity, or a count.
- [ ] `pnpm check:theme-contrast` exits 0 and its table shows no `token missing` row for any theme (a pair with a missing token is skipped, not failed, so a clean exit code alone does not prove full coverage).
- [ ] Pairs the script does not cover yet (high-contrast 7:1 text and 4.5:1 edges, Obsidian, any loaded theme file, the accent-as-text token) are measured by hand and the ratios recorded in the plan.
- [ ] Every hover-only or context-menu-only action has a keyboard path.
- [ ] Focus returns to the triggering element after a menu or dialog closes.

## Open

- Compliance beyond this checklist — an automated lint for palette-colour and alpha-modifier leaks, and for icon-only controls missing a `Tooltip` — is planned to sit beside `check:ui-text` and the contrast scripts, but is not built yet (agenda item 12), and this checklist is not yet wired into the Spec Kit plan template either. Until both exist, nothing enforces these rules automatically; reviewers apply this checklist by hand.
- The pause path for looping animations (2.2.2) is not decided: #566 leaves open whether pausing is a dedicated Settings switch or follows the OS reduced-motion setting. Neither pausing on a hidden window nor honouring `prefers-reduced-motion` satisfies 2.2.2 on its own.
- A single-pointer alternative to dragging the right pane's border (2.5.7) is not yet specified; see "Tabs and the right pane" in [components.md](components.md#tabs-and-the-right-pane).
