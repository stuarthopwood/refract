# Tokens and theming

This page covers the three token layers, markdown tokens as the first component-token group, theme files, the surface ladder and edge classes, elevation, accent and primary fill colour, canvas colour, and the high contrast preset.

Decided by Stuart in the #474 grill, 2026-10-08.

## Three token layers

Every colour in Refract resolves through exactly three layers (agenda item 9 / B4, #456, #458).

| Layer | What it holds | Example |
| --- | --- | --- |
| 1. Palette | Raw colour values only. Never referenced directly by components. | a single indigo hex |
| 2. Semantic roles | `background`, `foreground`, `surface-1` to `surface-3`, `border`, `accent`, `state-*`, `severity-*` | `--background`, `--accent` |
| 3. Component tokens | One token per element, for example `--chat-user-bubble-bg`, `--composer-border`, `--md-inline-code-bg` | `--chat-user-bubble-bg` |

A component token defaults to a semantic role, so a custom theme can recolour one element without changing hovers or any other element that shares the same role.

Components may use only layers 2 and 3. Specifically:

- Never a hex literal in component code.
- Never a Tailwind palette colour (`text-green-600`, `text-amber-500`, and the like).
- Never a Tailwind opacity modifier (`bg-accent/50`). Alpha lives inside the token value itself, so a theme file controls its own transparency instead of every call site guessing at it. The shared translucent tokens (#579) are `--row-hover-bg`, `--focus-glow`, `--elevated-edge`, `--scrim-bg`, `--invalid-ring`, `--primary-hover-bg`, `--destructive-hover-bg`, `--field-bg` and `--field-hover-bg`; `pnpm check:alpha-modifiers` baselines the remaining uses per file (`scripts/alpha-modifiers-baseline.json`), which may shrink, never grow.

`pnpm check:literal-colours` (#1473, spec 083) enforces the no-hex and no-palette-class rule over `src/renderer` `.ts` and `.tsx`, with a shrink-only per-file baseline in `scripts/literal-colours-baseline.json`; `rgb()`/`hsl()` literals are not yet checked (#1474). The Spec Kit plan-gate checklist in [accessibility.md](accessibility.md) still covers the rest.

**Current code note:** `src/renderer/styles/globals.css` currently defines mostly semantic-role tokens (`--background`, `--card`, `--popover`, `--accent`, and so on) inside `.theme-dark` and `.theme-dark-high-contrast`, plus a few ad hoc element tokens (`--chat-foreground`, `--composer-background`, `--active-indicator`, `--scrollbar-thumb`, `--scrollbar-thumb-hover`, `--scrollbar-track`) that are not yet organised as layer 3 or defaulted to a role; there is no `--surface-1`/`--surface-2`/`--surface-3` role (`--chat-user-bubble-bg` and similar are illustrative names from the decision, not tokens that exist in the checkout today). The three-layer model above is the decided target; see [ADR 0001](../adr/0001-three-layer-design-tokens.md) for why it was chosen over keeping two layers or ad hoc per-component literals.

### Markdown tokens (#456)

Markdown rendering is the working default component-token group under this model, not a decided build order: inline code, code blocks, and the chat bubble backgrounds each get their own component token defaulting to a semantic role (for example a `surface` role), rather than a literal colour or an ad hoc Tailwind class.

### Agent-working spinner token (issue #612, #616 review round 4)

`--agent-spinner-core` (`AgentSpinner.tsx`, `src/renderer/components/brand/AgentSpinner.tsx`) is this model's first actually-shipped layer-3 component token (the markdown tokens above are still the working default, not yet built) -- declared once per theme block (`.theme-dark`, `.theme-obsidian`, `.theme-dark-high-contrast` in `globals.css`), defaulting to the same brand violet in every theme today (Stuart, 2026-10-09: "same brand violet in every theme for now"; `#9A68E4` since round 5's A11y remediation -- the original `#864DD6` failed 3:1 against `--sidebar-accent`, the selected/hovered session row where the icon is the only visible status cue, in all three themes). A custom theme file (#458) may override it per-theme once theme-file loading is built, exactly as the three-layer model intends. The component's own `palette` prop/`data-palette` attribute offers two further, deliberately NON-theme-derived overrides (`'export'`, `'blue'`) for Stuart to compare visually -- these are fixed per-instance values, not theme tokens, and win over the inherited theme value because they are declared directly on the `.agent-spinner` element itself. Checked against `--sidebar`, `--sidebar-accent`, `--card`, `--popover` and `--background` (every surface the mark renders on) by `scripts/check-theme-contrast.mjs`'s `PAIRS` list, >=3:1 non-text floor, in every theme.

### Diff-stat colour tokens (issue #925)

`--diff-added`/`--diff-removed` (`globals.css`, every built-in theme) are layer-3 component
tokens for the coloured `+N`/`-N` portion of a change-count stat, wherever one shows (the
composer status line's Changes readout, the Session details card's identical diff line, the
Pull requests Changes tab's aggregate line and per-file diff header, and the chat transcript's
own expanded `DiffView` header): aliases of the SAME `--state-working`/`--destructive` values
`DiffView.tsx`/`diff-view.css` already colour the diff gutter and its own line markers with
(issue #630), never a second, independently-tunable hue (this page's own "do not create a
second set" rule, #550). A count takes its colour only when strictly positive; a count of
exactly zero stays `--muted-foreground` in either direction, so a `-0` never reads as an error
-- the shared `DiffStatCounts` component (`sessionDisplay.tsx`) is the one place this rule is
implemented.

### Agent-message token (issue #838)

`--agent-message` (`globals.css`, every built-in theme; `oklch(0.78 0.12 295)`, raised to
`oklch(0.85 0.1 295)` in Dark (high contrast)) colours the glyph and the "<sender> to
<recipient>" label of an agent-to-agent line (`AgentMessageRow.tsx`), never its preview or
expanded text, and nothing else. Checked at 4.5:1 against `--background` and `--muted` (the
row's hover) in every theme by `scripts/theme-contrast-pairs.mjs`. It shares the violet family
with the brand spinner's `--agent-spinner-core` (a brand mark, not a meaning colour, and never
drawn on a chat line), so the two cannot be confused in context.

### Role colour tokens (spec 036)

`--role-default`, `--role-smol`, `--role-slow` and `--role-plan` identify the four chat roles in Settings > Models as a swatch beside the role name. Every theme preset defines them at 3:1 or better against background, card, popover and accent (`scripts/theme-contrast-pairs.mjs`). Within each theme, every role hue (OKLCH) sits at least 30 degrees (circular) clear of that theme's own info, agent-message violet, green, amber, red and accent hues, and the four role hues are at least 30 degrees apart from each other. Two themes cannot fit that: Dark (high contrast) and Nordic Frost leave only two free gaps (about 101-131 and 325-352), so they relax to 25 degrees (Dark (high contrast) default at 191 is 29 from green 162 and info 220; Nordic Frost default/smol at 327/355 are 28 apart and smol is 27 from red 22). Per-theme role hues (default / smol / slow / plan): Dark and Obsidian 197 / 340 / 101 / 131; Dark (high contrast) 191 / 327 / 101 / 131; Nordic Frost 327 / 355 / 101 / 131; Cyber Amber 125 / 340 / 233 / 262. The swatch is decorative (`aria-hidden`); other roles stay neutral.

### Git decoration tokens (issue #768, spec 035)

`--git-modified`, `--git-added`, `--git-untracked`, `--git-deleted`, `--git-ignored`,
`--git-renamed`, `--git-conflicted` and `--git-staged` (`globals.css`, every built-in theme,
mapped to `text-git-*` utilities) colour the name and file icon of a File explorer row
(`git-decoration.ts`, `TreeNodeRow.tsx`) and the trailing status icon. They are separate from
the `--state-*` and `--severity-*` colours: session state and git status never share a token.
A folder takes the most significant status among its descendants (conflicted, deleted,
modified, staged, renamed, added, untracked; ignored does not roll up). Colour is never the
only signal: the trailing icon and its screen-reader word stay, and a folder rollup adds
"contains changes" to the row's accessible name. Each token is checked at 4.5:1 against
`--background`, `--sidebar`, `--sidebar-accent` and `--accent` (the hover and selected rows) in
every theme by `scripts/theme-contrast-pairs.mjs`; Dark (high contrast) uses brighter values.

### Right pane surface

`--sidebar-right` (Tailwind `bg-sidebar-right`) is the right pane's and the icon rail's surface (spec 035, #674): in every theme block it is the oklab 50% midpoint of that theme's `--background` and `--sidebar`, `color-mix(in oklab, var(--background) 50%, var(--sidebar))`, so it sits between the chat canvas and the left sidebar. `scripts/theme-contrast-pairs.mjs` checks `foreground`, `muted-foreground` and `accent-text` on it in every theme, resolving the `color-mix` through `scripts/derived-tokens.mjs`.

### Reserved hues

Each categorical colour that carries meaning, so a new one is checked against the others first.

| Hue | Meaning | Tokens |
|---|---|---|
| Green | Working, success, added lines | `--state-working`, `--severity-success`, `--diff-added` |
| Amber | Needs you, warning | `--state-needs-you`, `--severity-warning` |
| Red | Stopped, error, deleted lines | `--state-stopped`, `--severity-error`, `--destructive`, `--diff-removed` |
| Blue | Info, unread response | `--severity-info`, `--state-unread-response` |
| Grey | Idle, neutral, done tool calls | `--state-idle`, `--muted-foreground` |
| Violet | Agent-to-agent message identity (#838); the brand spinner (a brand mark) | `--agent-message`, `--agent-spinner-core` |
| Per theme: Dark/Obsidian 197, Dark (high contrast) 191, Nordic Frost 327, Cyber Amber 125 | Chat role: default (Settings > Models swatch) | `--role-default` |
| Per theme: Dark/Obsidian 340, Dark (high contrast) 327, Nordic Frost 355, Cyber Amber 340 | Chat role: smol | `--role-smol` |
| Per theme: 101 (Cyber Amber 233) | Chat role: slow | `--role-slow` |
| Per theme: 131 (Cyber Amber 262) | Chat role: plan | `--role-plan` |
| Per-theme accent | Links and primary fills, never a state | `--accent-text`, `--primary` |

## Theme files

A theme is a data file (JSON) of palette, semantic-role, and component-token overrides, loaded from the user's profile folder and listed in the Appearance section of Settings beside the built-in presets (agenda item 9, #458).

- **Import and export.** Settings > Appearance imports a theme file (copied into the themes folder through the same validator), exports a custom theme or a full starter copy of a built-in one, shows a file in its folder and removes it. A theme file is `{version:1, name, base, tokens}`: `base` is a built-in preset id, and any token a file omits falls back to that preset. The active file's id lives in the `customTheme` setting; `Ctrl+Shift+0` ("Reset theme to Dark") and the `--reset-theme` launch argument recover from an unreadable theme.
- **Allowlist.** `src/shared/theme-tokens.json` is the one token list Rust validates against and the renderer re-checks. Contrast warnings (27 in-app token pairs, a provable subset of the build gate in `scripts/theme-contrast-pairs.mjs`, which `check:theme-contrast` enforces) never block applying a theme. Slice 6 (#1474, spec 084) adds 45 more: 37 `mermaid-*` (diagram variables, resolved at render time by `withResolvedTokens`), `code-block-fg` and 7 `syntax-*` (Shiki switches to its `css-variables` theme only when a custom theme overrides one; built-ins keep their bundled theme). Scrollbar tokens already existed. Slice 4 (#1472, spec 081) adds 39 per-element colour tokens, each defaulting to a role in one `:is(:root, .theme-*)` block of `globals.css`: `tool-row-*`, `thinking-row-*`, `notice-*-fg`, `approval-card-*`, `composer-control-*`, `button-{secondary,destructive,outline}-*`, `status-bar-*`, `status-pill-attention-*`, `tooltip-*` and `session-row-*`. Slices 5 and 6 are #1473 and #1474.
- **No in-app colour editor.** Refract never ships a colour picker or live token editor; a theme file is authored outside Refract and only loaded by it.
- **Validity and contrast check on load.** Every theme file is checked for structural validity and run through the same WCAG contrast checks as the built-in presets before Refract accepts it. This is what lets a hand-authored "hot-pink-bubble" theme exist at all: it is checked once, on load, the same way a built-in preset is checked by `scripts/check-theme-contrast.mjs`, rather than trusted blindly.
- **Untrusted input (constitution V, security requirement from the #580 quality-gate review, not a #474 grill decision).** A theme file is untrusted. The loader runs in the main process and exposes it to the renderer only through the preload allowlist. It reads only `*.json` from the themes folder, after resolving each path and confirming it stays inside that folder, with no symlink following. It enforces a size cap and parses with try/catch. It accepts only the token names Refract already defines; unknown keys are rejected. Every value must be a colour in a strict colour grammar: hex (3/4/6/8 digits) or `oklch()`/`rgb()`/`hsl()` with numeric arguments and an optional alpha; no other CSS function (including `var(`, `calc(`, `color-mix(`, `env(`) is accepted, and any value containing `url(`, `image-set(`, `@`, `;`, `{`, `}`, a backslash or quotes is rejected. A theme file never carries script, fonts, images or selectors, and loading one never changes the renderer security policy. Import copies the chosen file into the themes folder through the same validator; export writes only through a save dialog.

**Spec 007 amendment.** `specs/007-app-themes/spec.md` said "Presets only" with no import or export (spec.md:17, 269). #458 supersedes that; spec 078 (`specs/078-custom-themes/`) is the amendment of record. See [ADR 0002](../adr/0002-theme-files-without-editor.md).

## Surface ladder and edge classes

**Built** (#550, PR #596; #551, draft PR #973; #606 wires the divider token into four component call sites). Depth comes from a ladder of surfaces, not elevation or shadow (agenda item 9, #550, mock review #549): **background**, then **surface-1** (aliased to `--card`), **surface-2** (aliased to `--popover`), **surface-3** (the "neutral highlight" hover/selected fill, `--surface-hover`), each a step lighter, so nesting is shown by tone, not borders. Measured steps above each preset's own canvas (CIE L*, a roughly perceptual scale): **Obsidian** -- card +7.10, popover +11.49, sidebar +2.65. **Dark** -- card +5.03, sidebar +5.03 (same value as card). **Nordic Frost** (#551) -- card +5.27, popover +11.12, sidebar +2.87. **Cyber Amber** (#1039, amended 2026-10-20) -- card +5.00, popover +5.00, sidebar +5.00 -- byte-identical to Dark's own ladder: Stuart's 2026-10-20 amendment removed the first #1039 cut's barely-visible warm tint (chroma 0.005) from every surface token (`--background`/`--card`/`--popover`/`--sidebar`/`--surface-3`/`--border`), so these are now PURE neutral (chroma 0), literally the same hex as `.theme-dark`'s own tokens. `--foreground`/`--chat-foreground`/`--muted-foreground` were also retuned softer as part of #1039 for a time, then that text-softening was reverted entirely (Stuart, 2026-10-20): it moved to a separate, app-wide issue, so these text tokens are simply untouched by #1039, byte-identical to Dark's own CURRENT `origin/main` values (as they already were before #1039). Only the accent family, the warning hue, and `themes.ts`'s own `swatchPrimary` remain Cyber-Amber-specific. **Dark (high contrast)** -- card +2.48, sidebar +0.90, both below the roughly-5-L* step the other presets use; its own stricter-floor redesign (soft dividers switched off, every edge/text at a tighter floor) stays deferred to #552, same as everywhere else in this story -- its ladder is additive-only (new token names alias existing, unchanged values), not retuned to match the other presets' step size. **Landed (#1074, Stuart 2026-10-20, FR-023):** that separate, app-wide issue is #1074 -- `--foreground`/`--chat-foreground`/`--muted-foreground` move to white at 90%/78%/60% alpha respectively, each composited over the surface it actually sits on, in Dark, Obsidian, Nordic Frost and Cyber Amber; Dark (high contrast) stays solid. A foreground on a coloured, non-neutral fill (Send, destructive, state/PR-state, and the composer's own selection-highlight text) stays a solid, opaque literal, FR-023's own "stays solid" exception. `scripts/check-theme-contrast.mjs`: 887/887 pairs across 5 themes PASS; live-verified (`scripts/verify-1074-text-opacity.mjs`, draft PR #1104).

Edges split into two classes, and a theme can only change token values, never which class a given edge belongs to:

| Edge class | Minimum contrast | Used for |
| --- | --- | --- |
| Control edges | At least 3:1 against what's behind them (WCAG 1.4.11) | Inputs, outline buttons, toggles, focus rings. `--border`/`--border-strong` in every theme (Dark/HC keep their existing `--border` unchanged; Obsidian's is retuned strong, `#6F7C9D`; Nordic Frost `#79818c`, Cyber Amber `oklch(0.56 0 0)` (#1039, amended 2026-10-20: byte-identical to Dark's own `--border`, `#747474` -- no warm tint, was `oklch(0.56 0.005 50)`/`#887e78` under the first #1039 cut and under #551); `--border-strong` is a plain alias of `--border` everywhere). |
| Decorative dividers | No contrast requirement ("soft"), carry no meaning | Between panes, rows, headers, sections. A separate `--divider` token, never `--border` weakened (Dark `oklch(1 0 0 / 16%)`, Obsidian `#2E3342`, Nordic Frost `oklch(1 0 0 / 14%)`, Cyber Amber `oklch(1 0 0 / 16%)` (#1039, matching Dark's own value since Cyber Amber's surfaces follow Dark's own ladder exactly), HC aliases `--border`). |

`scripts/check-theme-contrast.mjs` resolves `var()` indirection and treats `--divider` pairs as informational only (the high-contrast-specific stricter floor stays deferred to #552); `--border`/`--border-strong` are checked as real control-edge pairs in every theme. #606 wires `--divider` (via the `border-divider`/`bg-divider` utilities) into the main-split resize handle, the Pull requests list/detail divider, the status bar's top border, and the composer's top border. It also removed the bottom border outright from `ChatHeader.tsx`, `SessionList.tsx`'s own header, and `SubagentPanel.tsx`'s header -- **accepted by Stuart, 2026-10-09, as the correct rule, not a gap**: a panel header is never separated from its own content by a divider line, only by a different surface shade and/or whitespace (see "Panel header" in [components.md](components.md#panel-header)). `PullRequestsView.tsx`'s own header still carries its original full-strength `border-border` today, which does not follow this rule -- an inconsistency left for the #579 sweep to fix, not a second accepted pattern.

## Display-profile audit (#553, spec 063)

`pnpm check:display-profiles` applies a display transform to each theme's key pairs (card, popover and sidebar against the canvas, dividers, control and input edges, muted text) and lists the pairs that fall under their threshold. It is a developer tool: nothing ships to users, it is not in Settings, and it is not in `ci:local` yet because existing themes would fail. Pass `--strict` to exit 1 on any offender.

- **Profiles** (`scripts/display-profiles.mjs`): TN washout, VA black crush and sunlight glare. Each is a gamma (against 2.2), black-level lift, crush and gain curve applied to relative luminance after alpha tokens are composited over their surface.
- **Limits:** it is not a simulation of a specific panel. It ignores viewing angle, colour shift, local dimming and real panel response, so use it to find pairs worth checking by eye.
- **Thresholds:** the ladder rule above. Cards and popovers at least 5 L* above the canvas, the sidebar at least 2.3 L*, dividers at least 1.5:1, control and input edges at least 3:1, muted text at least 4.5:1. "Also baseline" marks a pair that already misses its threshold with no profile.

## Wave 1 token API (spec 032)

The app-wide tokens later bundles build on:

- **`--titlebar`** (every theme, defaulting to `--card`): the Chrome band surface. Apply it with the shared `titlebar-surface` class (background plus an inset 1 px `--divider` bottom line, 40 px row unchanged) on every `drag-region` row; `check:drag-regions` fails a row without it. Screens with no header row render `TitlebarBand`. The native overlay colour in `src/shared/themes.ts` must equal `--titlebar` (`check:theme-contrast` checks it). In High contrast dark, `--divider` is the solid border colour.
  - **Superseded 2026-10-30 (#1385, built, spec 071):** the Chrome band goes. `titlebar-surface` paints no background and no bottom line in every theme except Dark (high contrast), which keeps its line; each top strip shows its own column's background (chat, right pane, right rail, screen page). Rows stay `drag-region` and keep the class, so `check:drag-regions` and `check:theme-contrast` change with it. This supersedes #682's coloured top bar.
- **Non-white text weight:** inside `.text-muted-foreground`, `.text-accent-text`, `.text-destructive` and `.text-severity-*`, the weight tokens remap one step up (normal 400, medium 500, semibold 600); white `foreground` text stays 300. An explicit `font-*` utility still wins and resolves one step up. Wrap white text in its own element inside a muted parent.
- **`--pane-focused`, `--pane-focused-edge`, `--focused-badge-bg`** (every theme, #684): the **Focused pane tint**. `--pane-focused` is one opaque fill painted behind the focused chat pane's body (not its header) while two panes are on screen; it sits on the ladder `--background` <= `--pane-focused` < `--surface-1` (Dark and Cyber Amber `oklch(0.175 0 0)`, Obsidian `#161821`, Nordic Frost `#0a1322`; Dark must not go lighter, the user bubble is then below 4.5:1). `--pane-focused-edge` is `transparent` except in High contrast dark, where `--pane-focused` equals `--background` (no tint) and the edge is `--active-indicator`, a 2 px inset edge around the body. `--focused-badge-bg` is `color-mix(in oklab, var(--active-indicator) 20%, transparent)`, the header badge fill (no opacity modifier on a token class). Controls that float over the pane (scroll-to-bottom, attachment remove) use `bg-surface-1`, not `bg-background`. `check:theme-contrast` gates text, border, ring, indicator, user bubble and badge pairs on the tint, the two buttons on `--surface-1`, and the ladder.
- **Menus:** one shared class set in `components/ui/menu-item-classes.ts` serves `dropdown-menu.tsx` and `context-menu.tsx`; never restyle an item locally.
- **Active tab underline:** `--accent-text` (`after:bg-accent-text`), no divider under a tab bar.
- **Resize grip:** a functional circle, 4 by 32 px, drawn from `--border`, 3:1 against both neighbours.

## Corner radius scale

Decided 2026-10-28 (wave 1 grill, #843): the base `--radius` in `globals.css` is `0.25rem` (4px). The rest of the scale derives from it, so every theme preset inherits it (none overrides `--radius`):

| Token | Multiplier | Value |
| --- | --- | --- |
| `rounded-sm` | 0.5 | 2px |
| `rounded-md` | 1 | 4px |
| `rounded-lg` | 1 | 4px |
| `rounded-xl` | 2 | 8px |

Every step is a whole pixel (no fractional radii), and `rounded-md` equals `rounded-lg`.

Components take a token and never an arbitrary `rounded-[...]` or `min(var(--radius-md), Npx)` cap. Text pills, chips and badges use `rounded-md` (or the shared `Badge`). The square-choice rule (`border-radius: 0`) still applies to choice items.

**Functional circle rule:** a control or mark whose round shape carries meaning stays `rounded-full` whatever the token is (see "Functional circle" in [CONTEXT.md](../../CONTEXT.md)). The kept circles are status and unread dots, spinners, avatars, the switch track and thumb, the radio mark, the scrollbar thumb, the composer Send/Stop button, progress bars, and the pane resize grip.

## Elevation and shadows

Two levels only (agenda item 9, #549 mock review):

- **In-flow surfaces** (cards, panes, rows, the composer) have no shadow. Depth is the surface ladder above, not elevation.
- **Floating layers** that overlap content (menus, popovers, tooltips, dialogs, toasts) use the highest surface tone, a soft edge, and one shared shadow token.

Today tooltips and menus already share the elevated `--popover` surface and a border (see [Tooltip](components.md#tooltip)), but each component picks its own Tailwind shadow class (`shadow-md` or `shadow-lg`), and dialogs use a ring with no shadow; the single shared shadow token is not built yet. This resolves the mock, which said one depth, no shadows, but visibly shadows its own cards and menus: the decision is no shadow in-flow, one shadow token for floating layers, contradicting the mock's stated "no shadows" claim.

## Accent and primary fill colour

**Decided (Stuart, 2026-10-09): the focus ring stays achromatic, not a gap.** Indigo family: the filled commit button and the accent role both use the mock's indigo (agenda item 9, #549, #550 mock review, PR #596). Accent covers **fills** (the commit button, the accent role) and **text/links** (via the new `--accent-text` token); the **focus ring is a decided exception**: `--ring` stays achromatic grey in every preset including the new Obsidian (`oklch(0.62 0 0)`, only brightened from Dark/HC's shared `oklch(0.556 0 0)`, never retuned to indigo), matching Dark/HC's existing grey focus rings. This corrects this page's own earlier wording, which said accent is used "as text, links, AND focus"; that third use is now ruled out by decision, not left as a declared gap on PR #596 awaiting Stuart. Contrast is unaffected by the ring staying achromatic: `scripts/check-theme-contrast.mjs`'s `ring`/`background`, `ring`/`popover` and `ring`/`muted` pairs (the 3:1 WCAG 1.4.11 non-text floor) already pass for the grey ring in every theme, since the floor only requires sufficient tonal separation from the surface, not a particular hue. **Nordic Frost and Cyber Amber (#551) are the exception to the indigo family itself, not to the achromatic-ring rule above (both still keep a grey `--ring`):** each is additive, built with its own distinct per-preset accent hue instead of a second indigo value, matching the mock's own per-theme signature -- Nordic Frost's `--accent-text`/`--primary` are a cyan (`#1ad1d1`/`#007a7c`, real hue ~195, the mock's "arctic" identity); Cyber Amber's were originally a warm orange-amber (`#fcae93`/`#c14100`, the mock's "phosphor amber" identity), **retuned by #1039 (2026-10-19) to a vivid orange: `--accent-text` `#fb923c` (real hue ~55.9), `--primary`/`--send` `#c2410c` (real hue ~38.4) with white text** -- see `globals.css`'s own `.theme-cyber-amber` header comment for the full #1039 rationale.

**Chosen values** (measured unrounded, WCAG relative luminance; corrects an earlier draft of this same agenda item that quoted 4.5:1 and 4.3:1):

- White on `#6366F1` (the mock's literal fill) is **4.467:1**, below the 4.5:1 normal-text threshold, so it does not pass as-is for white text. Obsidian's `--primary` (the one preset that uses this fill as a live canvas call site; Dark/HC's own `--primary` is untouched, see "Canvas colour") is nudged to **`#5A5EEE`** (4.92:1 for white text) -- the first of the three candidates this page previously listed.
- `#6366F1` used directly as text measures 4.26:1 on `#0F1014` (Obsidian's canvas) and well under 4.5:1 on Dark's unretuned `#0a0a0a`, so a lighter `--accent-text` token is built for both: Obsidian's is `#8C8FF5` (6.67:1 against `--background`, 5.77:1 against `--card`, 5.16:1 against `--popover`, 4.62:1 against `--surface-hover`, the binding constraint since #1873); Dark's is `#8082F4` (6.05:1 against `--background`, 5.47:1 against `--card`/`--popover`, 4.62:1 against `--surface-hover`). Both were nudged lighter in #1873 so the borderless "+N" chip clears 4.5:1 on a hovered row.

This settles #550's own open values; the two candidates this page did not choose (`#5B5FEF`, `#6064F0`) were not built.

## Canvas colour

**Built** (#550, PR #596): both Dark and the new Obsidian preset ship as built-in presets (agenda item 9, canvas colour, #549, #550), and Dark is purely additive -- **the #452 retune below did not land as part of this build** and stays open:

- **Dark** keeps today's unretuned `--background`, `oklch(0.145 0 0)` ≈ `#0a0a0a`, darker than Obsidian's `#0F1014`, as the default. The 2026-10-07 retune to about `#1a1a1a` to `#1e1e1e` (#452) is explicitly deferred, not folded into this story: PR #596's own remediation made Dark and Dark (high contrast) additive-only specifically so nothing already rendering on `origin/main` could regress, and a canvas retune would have been exactly that kind of change.
- A new built-in **Obsidian** preset uses the mock's `#0F1014` canvas, built out in full since nothing existing renders with it yet: `--border` retuned strong (`#6F7C9D`), `--accent-text` (`#8C8FF5`) and `--severity-error` widened with margin against `--popover`.
- Both pass the contrast script (`node scripts/check-theme-contrast.mjs` reports the current pair count), and Dark is the settled default (Q14); Stuart can compare the two live and revisit the retune later.
- ~~The composer stays strictly darker than the page background on either canvas~~ **Superseded 2026-10-16 (#927):** on both canvases the composer's fill is transparent with a faint `--composer-border`; only Dark (high contrast) keeps a 3:1 composer edge. See "Composer tone" in [product-chat.md](product-chat.md).
- Indigo text needs its own lighter accent token on either canvas: Dark's `--accent-text` is `#8082F4` (6.05:1 against `--background`, 5.47:1 against `--card`/`--popover`), measured against TODAY's unretuned background, not the still-deferred #452 retune; Obsidian's is `#8C8FF5` (6.67:1 / 5.77:1 / 5.16:1 against background/card/popover). Run `node scripts/check-theme-contrast.mjs` for the full current table.

This resolves the canvas call left open in plan row B6: both presets exist, but the #452 Dark retune this page originally expected "once built" is a separate, still-open piece of work -- not a deviation from this decision, since #549/#550's own canvas-colour call only required both to ship as presets with Dark as default, which is what landed.

## High contrast preset

Dark (high contrast) keeps all state and severity colours and glyphs, but raises every value (agenda items 7 and 9, #552):

- Text: **7:1**.
- Every edge, including dividers: **4.5:1** (soft dividers are switched off in this preset).
- A thicker **2px** focus ring.
- No tone-only depth between surfaces: borders carry the depth instead.

Same components and rules as every other preset; only token values change, so high contrast stays a theme file rather than a separate code path. The Terminal Monochrome treatment (glyph-first, minimal hue), a #552 proposal that was never built, is **not adopted** -- written into the design document, answering that open question. **#552 stays open**: this decision's full value list (every edge and divider at 4.5:1, the wider ring) is not built yet, only the red (severity/stopped/PR-closed, gate round 1, now at 7:1 -- see [accessibility.md](accessibility.md) "High contrast theme").

## Open

- **Shiki and Mermaid colours** (#1474, spec 084): Mermaid variables are built in `src/shared/mermaidTheme.ts` from `--mermaid-*` tokens, so a theme file recolours diagrams live. Shiki's built-in syntax theme id still lives in `src/shared/themes.ts`. `check:mermaid-contrast` needs Electron and is not in the gate (#388).
- **Profile theme submenu swatches** (#474, carried from agenda item 5): the Profile menu's theme submenu shows colour swatches, not icons, which is the one documented exception to the leading-icon rule: the radio ring is the leading mark and the chip is a trailing, decorative preview (settled in #1466).
- **Focus ring width conflict** (#552, flagged for Stuart, not resolved here): the base focus ring is decided as 2px (Q11), but today's code uses a 3px ring (`focus-visible:ring-3`, `button.tsx`), and the high-contrast preset above calls its own ring "a thicker 2px focus ring" — inconsistent with a 2px base. Same note in [foundations-motion.md](foundations-motion.md#focus). Picking new numbers (for example 2px default / 3px high contrast, or 2px for both) is Stuart's call, not made in this PR.

- **Customising Mermaid, code and scrollbars** (#1474). In a theme file, set `mermaid-*` tokens for diagrams: core (`mermaid-bg`, `-text`, `-line`, `-node-fill`, `-node-fg`, `-border`, `-accent`, `-accent-fill`), notes and tasks, and the numbered palette (`mermaid-palette-N`, 1-based). Spec 086 renamed `mermaid-cscale-12` to `mermaid-cscale-11` and `mermaid-cscale-label-12` to `mermaid-cscale-label-11`; a theme file that sets an old name is rejected, so rename the key. `mermaid-node-fill` has no effect on flowchart nodes: they take `mermaid-accent-fill`, so set that for flowcharts. Set `syntax-*` and `code-block-fg` for code: overriding any of them switches Shiki to its `css-variables` theme, so override all of them together. Scrollbars use `scrollbar-thumb`, `-thumb-hover` and `-track`. Contrast warnings cover the Mermaid text, node text and scrollbar thumb pairs.
