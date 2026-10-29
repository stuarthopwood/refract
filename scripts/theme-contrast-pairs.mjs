// FR-007/FR-008 token pairs actually rendered by this codebase, extracted from
// scripts/check-theme-contrast.mjs (gate round 4 follow-up, #806 file-size ratchet: the script
// had grown past its own recorded baseline for legitimate new pairs, and the ratchet is lower-
// only -- a baseline entry may never be RAISED, so the growth was moved out into its own module
// instead). `check-theme-contrast.mjs` imports `PAIRS` from here and iterates it exactly as it
// did when the array lived inline; the two composited checks below (search field, user-bubble
// links) moved out alongside it for the same reason, sharing `contrast-math.mjs`'s own alpha-
// compositing primitives with `check-theme-contrast.mjs` rather than each keeping a private
// copy (gate round 5, Main's finding 1: a private copy here once silently regressed to a wrong,
// naive linear-space blend -- one shared module can only drift in one place, never two).
//
// `min: 4.5` = WCAG AA body/UI text; `min: 3` = WCAG AA large text and non-text UI components
// (focus rings, control-edge borders, scrollbar thumbs, status icons used without accompanying
// text). `--divider` is NOT a control edge (#550: it is the soft decorative edge, read by no
// component yet except where it IS a real rendered fill -- see DIVIDER_PAIRS's own comment
// below). `--border` IS a control edge in every theme in this remediated cut (Dark/HC keep
// rendering every un-migrated `border-border` call site with it, unchanged; Obsidian's own
// `--border` is tuned to the same floor) -- checked here, same as `--border-strong`, its alias.
//
// Two optional per-pair fields (#927, quiet composer): `onlyThemes: string[]` restricts a pair
// to the named theme ids (default: every declared theme, the original behaviour, unchanged for
// every pair above that omits it) -- for a token that only renders on a real, meaningful
// surface in SOME themes (Dark/Obsidian's `--composer-background` is `transparent` since #927,
// so a pair against it only makes sense in Dark high contrast). `informationalThemes:
// string[]` ALSO restricts to the named themes, but additionally marks the pair never-enforced
// there (`check-theme-contrast.mjs` still computes and prints its real ratio, tagged
// "informational", but never counts it toward `checkedCount`/`failCount`) -- for a pair that is
// Stuart's own accepted WCAG departure (docs/design/accessibility.md "Accepted departures"),
// kept visible in the gate's output for anyone re-measuring it, never failing the run.

import { clamp01, compositeOverLinear, contrastRatio, linearToHex, relativeLuminance, resolvedLinear, srgbGammaDecode, srgbGammaEncode } from './contrast-math.mjs'
import { createHighlighter } from 'shiki'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

export const PAIRS = [
  // #887: the ten Project colour presets on the Session list background.
  ...Array.from({ length: 10 }, (_, i) => ({ fg: `project-${i + 1}`, bg: 'sidebar', min: 4.5 })),
  ...Array.from({ length: 10 }, (_, i) => ({ fg: `project-${i + 1}`, bg: 'sidebar-accent', min: 4.5 })),
  { fg: 'foreground', bg: 'background', min: 4.5 },
  { fg: 'card-foreground', bg: 'card', min: 4.5 },
  { fg: 'popover-foreground', bg: 'popover', min: 4.5 },
  { fg: 'primary-foreground', bg: 'primary', min: 4.5 },
  { fg: 'send-foreground', bg: 'send', min: 3 },
  { fg: 'agent-message', bg: 'background', min: 4.5 }, { fg: 'agent-message', bg: 'muted', min: 4.5 }, // #838: AgentMessageRow glyph + label, at rest and on the trigger's hover:bg-muted
  // #927 (quiet composer): `--composer-background` is now `transparent` in Dark and Obsidian
  // (the field shows the chat background through instead of a solid fill), so Send no longer
  // renders on it there -- `onlyThemes` scopes this pair to Dark (high contrast), the one
  // preset #927 leaves on a real, opaque `--composer-background`. The pair just below measures
  // Send against `--background` instead, the real backdrop in the other two themes.
  { fg: 'send', bg: 'composer-background', min: 3, onlyThemes: ['dark-high-contrast'] },
  // #551: Nordic Frost and Cyber Amber both follow the same quiet-composer (#927) pattern as
  // Dark/Obsidian -- a transparent `--composer-background` -- so they join this scope too.
  { fg: 'send', bg: 'background', min: 3, onlyThemes: ['dark', 'obsidian', 'nordic-frost', 'cyber-amber'] },
  { fg: 'secondary-foreground', bg: 'secondary', min: 4.5 },
  { fg: 'muted-foreground', bg: 'background', min: 4.5 },
  { fg: 'accent-foreground', bg: 'accent', min: 4.5 },
  { fg: 'destructive-foreground', bg: 'destructive', min: 4.5 },
  { fg: 'chat-foreground', bg: 'background', min: 4.5 },
  { fg: 'state-working-foreground', bg: 'state-working', min: 4.5 },
  { fg: 'state-needs-you-foreground', bg: 'state-needs-you', min: 4.5 },
  { fg: 'state-stopped-foreground', bg: 'state-stopped', min: 4.5 },
  { fg: 'ring', bg: 'background', min: 3 },
  { fg: 'scrollbar-thumb', bg: 'background', min: 3 },
  { fg: 'active-indicator', bg: 'background', min: 3 },
  // Gate round 5 (#564 follow-up): dropdown-menu.tsx's active-row inset shadow now uses this token (was --ring), rendered on bg-popover.
  { fg: 'active-indicator', bg: 'popover', min: 3 },
  { fg: 'active-indicator', bg: 'accent', min: 3 }, // #1122: ActiveIndicatorBar now also sits on bg-accent
  { fg: 'active-indicator', bg: 'muted', min: 3 }, // #1122: SubagentPanel.tsx's `hover:bg-muted/50` row hover can paint under a selected row's bar
  { fg: 'ring', bg: 'accent', min: 3 }, // #1122: focus-visible:ring-ring now paints while focused on an accent-filled selected row
  { fg: 'severity-success', bg: 'accent', min: 3 },
  { fg: 'severity-error', bg: 'accent', min: 3 },
  { fg: 'destructive', bg: 'accent', min: 4.5 }, // #1122: ManageSessionRow.tsx's "Worktree missing" body text on the selected row's bg-accent
  { fg: 'state-idle', bg: 'accent', min: 3 },
  { fg: 'state-needs-you', bg: 'accent', min: 3 },
  { fg: 'state-stopped', bg: 'accent', min: 3 },
  { fg: 'state-working', bg: 'accent', min: 4.5 }, // #1122/#700: real body text ("In progress") on the new accent-filled selected row
  { fg: 'destructive', bg: 'background', min: 3 },
  { fg: 'state-working', bg: 'background', min: 4.5 }, // #700: also real BODY TEXT ("In progress"), not just icon-only -- 4.5 subsumes the old 3:1 icon floor
  { fg: 'state-idle', bg: 'background', min: 3 },
  { fg: 'state-needs-you', bg: 'background', min: 3 },
  { fg: 'state-stopped', bg: 'background', min: 3 },
  // Issue #731: the shared `StateIcon` renders both `state-idle` and the new
  // `state-unread-response` on the session row (`sidebar`/`sidebar-accent` when selected or
  // hovered), the chat header (`background`) and the session details hover card (`popover`) --
  // the same four surfaces `agent-spinner-core` above is already checked against. `state-idle`
  // only had the `background` pair before this issue; `sidebar`/`sidebar-accent`/`popover` were
  // never checked for it either, so #567 decision 26 (the remaining `state-*` sidebar pairs)
  // must not duplicate these four lines.
  { fg: 'state-idle', bg: 'sidebar', min: 3 },
  { fg: 'state-idle', bg: 'sidebar-accent', min: 3 },
  { fg: 'state-idle', bg: 'popover', min: 3 },
  { fg: 'state-unread-response', bg: 'sidebar', min: 3 },
  { fg: 'state-unread-response', bg: 'sidebar-accent', min: 3 },
  { fg: 'state-unread-response', bg: 'background', min: 3 },
  { fg: 'state-unread-response', bg: 'popover', min: 3 },
  // These real component-boundary pairs were missing and measure as genuine failures --
  // `--input` (the border of every Input/Textarea/Select/outline-Toggle/outline-Button,
  // including the Appearance section's own Cancel button).
  { fg: 'input', bg: 'background', min: 3 },
  // #550 (theme foundation, palette v2): the control-edge tokens (`--border`, the one every
  // un-migrated component actually renders with, and `--border-strong`, its forward-looking
  // alias -- #550's own divider-versus-control-edge rule) and the new semantic roles the
  // contrast script must learn or it would silently pass a theme that never defines them (the
  // 'token missing' path below still fires if any of these are absent).
  { fg: 'border', bg: 'background', min: 3 },
  { fg: 'border', bg: 'card', min: 3 },
  { fg: 'border', bg: 'popover', min: 3 },
  { fg: 'border', bg: 'muted', min: 3 },
  // #1043 (shared `DropdownMenuRadioItem`'s new leading ring-and-dot mark, `dropdown-menu.tsx`,
  // `radio-group.tsx`'s `RADIO_RING_CLASS`/`RADIO_DOT_CLASS`): the filled dot (`bg-foreground`)
  // renders directly on `DropdownMenuContent`'s own `bg-popover`, a surface it was never
  // checked against before, in its real WCAG 1.4.11 (3:1 non-text) role -- the Ask card/
  // MergeDialog's identical dot renders on a dialog's `--background`/`--card`, a pre-existing,
  // unrelated gap out of scope. The ring's UNCHECKED border (`border-muted-foreground`) needs
  // no new entry: `muted-foreground`/`popover` already exists above at the stricter 4.5:1 floor.
  { fg: 'foreground', bg: 'popover', min: 3 },
  // Gate round 1 fix (PR #1057, Code/Test/UI High): the CHECKED ring's own border was
  // `border-primary` (`--primary`/`--popover` measured only 2.92-2.99:1 in Obsidian/Nordic
  // Frost/Cyber Amber at the time -- under 3:1, visibly INVERTED there since `--primary`'s own
  // relative luminance was LOWER than `--muted-foreground`'s). Never "the same pre-existing
  // gap" an earlier cut of this comment claimed: `primary`/`card` and `primary`/`background`
  // both clear 3:1 with margin -- `--popover` was the one failure. #1039 (2026-10-20) retuned Cyber
  // Amber's `--primary` to `#c2410c` (clears 3:1 on `--popover`, 3.46:1); Obsidian (2.99:1)/Nordic
  // Frost (2.92:1) still measure under the floor, so the fix below applies to every theme.
  // Fixed by changing `RADIO_RING_CLASS`'s checked border to `border-foreground` instead
  // (`radio-group.tsx`) -- `foreground`/`popover` above already covers the resting case;
  // `foreground`/`accent` below covers the row's own `focus:bg-accent` fill (a focused AND
  // checked row sits on `--accent`, never `--popover`, while focused).
  { fg: 'foreground', bg: 'accent', min: 4.5 }, // #1122: PR/Manage sessions/Subagent rows' unstyled title span, real body text
  // Gate round 4 (#564 follow-up) pair REMOVED by #927 (quiet composer): the Approval mode pill's own `badgeVariants({variant: 'outline'})` border moved to `variant: 'ghost'` (`pickerShared.tsx`'s `PICKER_TRIGGER_CLASS`), which has no border in any theme, so nothing renders this pair any more.
  { fg: 'border-strong', bg: 'background', min: 3 },
  { fg: 'border-strong', bg: 'card', min: 3 },
  { fg: 'border-strong', bg: 'popover', min: 3 },
  { fg: 'border-strong', bg: 'muted', min: 3 },
  { fg: 'accent-text', bg: 'background', min: 4.5 },
  { fg: 'accent-text', bg: 'card', min: 4.5 },
  { fg: 'accent-text', bg: 'popover', min: 4.5 },
  { fg: 'accent-text', bg: 'muted', min: 3 }, // #1125
  // TODO(#579): `accent-text` on `surface-hover` (the muted/accent hover fill) measures only
  // 4.00:1 in Dark and 4.28:1 in Obsidian -- under the 4.5:1 text floor. Not added as a PAIRS
  // entry (it would fail both themes today). Issue #610 reads `--accent-text` now
  // (`Markdown.tsx`'s `linkClassName`), but never on `surface-hover`: every link/file-link
  // surface it renders on -- the plain chat background/card/popover, and the composited user
  // message bubble checked below -- is covered by a real gate entry. Before #579 migrates a
  // link/text colour onto a hover row, either lighten `accent-text` further (it already has
  // margin to spare against background/card/popover) or add this pair here once it passes.
  { fg: 'severity-success', bg: 'background', min: 3 },
  { fg: 'severity-success', bg: 'card', min: 3 },
  { fg: 'severity-success', bg: 'popover', min: 3 },
  { fg: 'severity-warning', bg: 'background', min: 3 },
  { fg: 'severity-warning', bg: 'card', min: 3 },
  { fg: 'severity-warning', bg: 'popover', min: 3 },
  { fg: 'severity-error', bg: 'background', min: 3 },
  { fg: 'severity-error', bg: 'card', min: 3 },
  { fg: 'severity-error', bg: 'popover', min: 3 },
  { fg: 'severity-info', bg: 'background', min: 3 },
  { fg: 'severity-info', bg: 'card', min: 3 },
  { fg: 'severity-info', bg: 'popover', min: 3 },
  // `muted-foreground` and `destructive` are rendered as actual BODY TEXT (code-block/diff-path
  // headers, inactive tab labels, notice text, dropdown-menu destructive items, alert
  // descriptions), not just against the page `--background` the two pre-existing pairs above
  // already covered -- against `--muted`/`--accent` (the shadcn "neutral highlight"
  // hover/selected fills text sits on) and `--card`/`--popover` (dialog/menu surfaces)
  // respectively.
  { fg: 'muted-foreground', bg: 'muted', min: 4.5 },
  { fg: 'muted-foreground', bg: 'accent', min: 4.5 },
  { fg: 'muted-foreground', bg: 'card', min: 4.5 },
  // Chrome band (#682): text and icons on the shared `--titlebar` surface.
  { fg: 'foreground', bg: 'titlebar', min: 4.5 },
  { fg: 'muted-foreground', bg: 'titlebar', min: 4.5 },
  { fg: 'muted-foreground', bg: 'popover', min: 4.5 },
  { fg: 'muted-foreground', bg: 'surface-hover', min: 4.5 },
  { fg: 'chat-foreground', bg: 'accent', min: 4.5 }, // #1119: Explorer name span vs its own aria-selected:bg-accent fill
  // Issue #630: `DiffView.tsx`'s new +N added-line count sits as real `text-xs` body text on the diff box's own `bg-muted` header (chosen over a raw palette colour precisely so it is gated here).
  { fg: 'state-working', bg: 'muted', min: 4.5 },
  // Subagent status icons on `--muted` (#563 remediation, decision 26): finished/failed icons.
  { fg: 'state-idle', bg: 'muted', min: 3 },
  { fg: 'severity-error', bg: 'muted', min: 3 },
  // #565 decision 32: a node icon, and a notice's own coloured summary text, must keep their
  // floor on the hover tint too (`CollapsedLine`'s own `hover:bg-muted`, decision 18).
  // `state-working/muted` and `ring/muted` already gated at stricter floors above; only `destructive`/`muted` and `state-needs-you`/`muted` were missing -- both real rendered text (a long error/warning `NoticeRow`'s own summaryClassName) sitting on this tint once hovered.
  { fg: 'destructive', bg: 'muted', min: 4.5 },
  { fg: 'state-needs-you', bg: 'muted', min: 4.5 },
  // Issue #570, gate round 1 (accessibility-auditor/test-reviewer Low): `ToolGroupRow`'s own
  // "N failed" meta text and a failed row's own label/Error line now render `text-severity-
  // error` directly (never `text-destructive`), on both the row background and this hover tint.
  // `severity-error` was previously gated only at the 3:1 icon floor (its `bg: 'background'`/`bg: 'muted'` pairs earlier in this file); the two
  // tokens share an identical value in every built-in theme (`globals.css`), so this passes
  // today purely because of that alias, but the gate must check the token actually RENDERED, not
  // rely on an alias that could be split apart later without this file noticing.
  { fg: 'severity-error', bg: 'background', min: 4.5 },
  { fg: 'severity-error', bg: 'muted', min: 4.5 },
  // Issue #941, gate round 1: a finished agent or Stage's own name/label now renders
  // `text-severity-success` directly (icon AND text, the one exception to "done is neutral"),
  // on both the row background and the `hover:bg-muted` tint `CollapsedLine`'s own trigger
  // uses -- same precedent as `severity-error` immediately above. `severity-success` was
  // previously gated only at the 3:1 icon floor (`bg: 'background'`/`bg: 'card'`/`bg: 'popover'`
  // pairs earlier in this file).
  { fg: 'severity-success', bg: 'background', min: 4.5 },
  { fg: 'severity-success', bg: 'muted', min: 4.5 },
  // #552 fix (Skippy, delegated by Stuart 2026-10-18): Dark (high contrast)'s own declared
  // design target is 7:1 text, not the ordinary 4.5:1 AA floor every preset above is held to
  // (`docs/design/accessibility.md`/`foundations-tokens-theming.md` "High contrast preset").
  // `--muted` is the lightest of this theme's background/card/popover/muted surfaces, so it is
  // the binding case; scoped to this theme only -- the other presets are not held to a 7:1
  // floor by their own design.
  { fg: 'severity-error', bg: 'muted', min: 7, onlyThemes: ['dark-high-contrast'] },
  // Gate round 1 (#997, Low): the matching HC 7:1 pair above only ever covered
  // `severity-error`/`muted` -- `severity-warning` (`NoticeRow.tsx`'s warning summary) and, since
  // #1121, `severity-success` ("Checks passed") render real body text in the identical role.
  { fg: 'severity-warning', bg: 'muted', min: 7, onlyThemes: ['dark-high-contrast'] },
  { fg: 'severity-success', bg: 'muted', min: 7, onlyThemes: ['dark-high-contrast'] },
  // #558 gate round 1 (Low): `severity-warning` label/summary text now renders in this role
  // (decision 11) and was previously gated only at the 3:1 non-text floor, passing today purely
  // because it aliases `state-needs-you` (already gated at 4.5) -- the same "check the token
  // actually rendered" rule the #570 comment above states.
  { fg: 'severity-warning', bg: 'background', min: 4.5 },
  { fg: 'severity-warning', bg: 'muted', min: 4.5 },
  { fg: 'destructive', bg: 'card', min: 4.5 },
  { fg: 'destructive', bg: 'popover', min: 4.5 },
  // Issue #601: `CheckRow.tsx`'s failed/warning hint text (`text-destructive`/
  // `text-state-needs-you`) used to sit on `--card` (the readiness screen's own grey box).
  // Only `destructive`/`card` had a 4.5:1 pair there already (just above); `state-needs-you`/
  // `card` was never gated at 4.5:1 anywhere. Both tokens were gated against `--background`
  // only at the 3:1 non-text floor (the pairs above, shared with the icon-only use of these
  // same tokens). Removing the box puts the hint text directly on `--background`, so both now
  // need their own real 4.5:1 text pair there too.
  { fg: 'destructive', bg: 'background', min: 4.5 },
  { fg: 'state-needs-you', bg: 'background', min: 4.5 },
  // Issue #533: the composer's new empty-state hint overlay (icons plus "for commands" /
  // "Markdown supported" text, `MessageInput.tsx`) renders `text-muted-foreground` directly on
  // `--composer-background`, the composer field's own distinct per-theme fill (NOT the page
  // `--background` the `muted-foreground`/`background` pair above already covers). That token
  // already carried real text -- the old native placeholder and the typed draft itself -- this
  // pair was simply missing from the gate, not newly rendered text; closes a pre-existing gap.
  // #927 scopes this to Dark (high contrast): Dark/Obsidian's `--composer-background` is now
  // `transparent`, so the hint text there actually sits on `--background`, already covered by
  // the generic `muted-foreground`/`background` pair above.
  { fg: 'muted-foreground', bg: 'composer-background', min: 4.5, onlyThemes: ['dark-high-contrast'] },
  // `--input`/`--ring`, the control-edge tokens every dialog footer's outline Cancel button and
  // every focus ring actually render, checked only against `--background` before -- dialogs
  // and menus sit on `--popover`/`--muted`, not the page.
  { fg: 'input', bg: 'popover', min: 3 },
  { fg: 'input', bg: 'muted', min: 3 },
  { fg: 'ring', bg: 'popover', min: 3 },
  { fg: 'ring', bg: 'muted', min: 3 },
  // Issue #975 gate round 1 (Main, Low): `CodeBlock`'s own scrollable/body region
  // (`Markdown.tsx`, `focus-visible:ring-2 focus-visible:ring-ring`) sits directly on `--card`
  // -- this issue's own new code-block background -- and was never checked against it before.
  { fg: 'ring', bg: 'card', min: 3 },
  // Gate round 4 (#564 follow-up): the Approval mode pill's `focus-visible:outline-ring` used to
  // render its opaque focus outline directly on `--composer-background`. #927 (quiet composer)
  // replaced that token with `--composer-focus` (muted in Dark/Obsidian, an exact `--ring` alias
  // in Dark high contrast) for every ghost composer trigger (Approval pill, Model, Reasoning,
  // Attach) -- checking `composer-focus` here, not `ring`, per #570's own "check the token
  // actually rendered, not an alias" rule. Scoped to Dark (high contrast), the one theme #927
  // keeps enforced (Dark/Obsidian's own ratio is deliberately below 3:1, the accepted WCAG
  // 1.4.11 departure, docs/design/accessibility.md "Accepted departures") -- the two
  // `informationalThemes` pairs just below surface that real, unenforced ratio for Dark/
  // Obsidian instead, against `--background` (their real backdrop, now that the composer's own
  // fill is transparent).
  { fg: 'composer-focus', bg: 'composer-background', min: 3, onlyThemes: ['dark-high-contrast'] },
  { fg: 'composer-border', bg: 'background', min: 3, onlyThemes: ['dark-high-contrast'] },
  // #551: Nordic Frost and Cyber Amber accept the same WCAG 1.4.11 departure for this pair
  // (docs/design/accessibility.md "Accepted departures"), so they join the informational scope.
  { fg: 'composer-border', bg: 'background', min: 3, informationalThemes: ['dark', 'obsidian', 'nordic-frost', 'cyber-amber'] },
  { fg: 'composer-focus', bg: 'background', min: 3, informationalThemes: ['dark', 'obsidian', 'nordic-frost', 'cyber-amber'] },
  // U1 (gate951UI/A11y High): Dark high contrast's Approval/Model/Reasoning triggers keep a
  // real, enforced resting border (`--composer-control-border`, `var(--border)` there) -- the
  // reinstated equivalent of the stale `border-strong`/`background` comment just above, scoped
  // to the one theme #927 actually keeps bordered.
  { fg: 'composer-control-border', bg: 'composer-background', min: 3, onlyThemes: ['dark-high-contrast'] },
  // Agent-working spinner (issue #612, #616 review round 4): Stuart's decision -- the brand
  // violet is now a per-theme Layer 3 component token (`--agent-spinner-core`, same value in
  // every theme today, declared in each `.theme-*` block in globals.css), not a fixed colour.
  // Checked against every surface the mark actually renders on: the session list (`--sidebar`),
  // that same row selected or hovered (`--sidebar-accent`, `SessionList.tsx` -- the icon is the
  // only visible status cue there, the "Working" text is `sr-only`), the chat header
  // (`--background`), and the session details hover card (`--popover`, `hover-card.tsx` -- NOT
  // `--card`, corrected in round 5 after the A11y gate found the real surface).
  // Quality-gate remediation (A11y HIGH, round 5): `--sidebar-accent` was missing from this list
  // entirely and the original `#864DD6` measured under 3:1 against it in every theme (2.91 Dark
  // / 2.54 Obsidian / 2.99 Dark HC); Stuart's `#9A68E4` fix (see `.theme-dark`'s own comment)
  // clears it everywhere (3.94 / 3.43 / 4.05). `--card` is kept as a fourth pair even though
  // `--popover` is the real card surface, since `--card` happens to equal `--popover` in Dark
  // and Dark HC (not in Obsidian) and nothing currently regresses by also checking it.
  { fg: 'agent-spinner-core', bg: 'sidebar', min: 3 },
  { fg: 'agent-spinner-core', bg: 'sidebar-accent', min: 3 },
  { fg: 'agent-spinner-core', bg: 'card', min: 3 },
  { fg: 'agent-spinner-core', bg: 'popover', min: 3 },
  { fg: 'agent-spinner-core', bg: 'background', min: 3 },
  // #735 (session list collapse/expand): the Waiting marker (decision 21) and the visible
  // Session's active bar (decision 22) both render inside the session list's own `bg-sidebar`
  // surface, and the toolbar's two buttons (decision 23) render their focus ring there too --
  // none of these were ever checked against `--sidebar`/`--sidebar-accent` specifically before,
  // only against the page `--background` (the icon-only pairs above).
  { fg: 'state-needs-you', bg: 'sidebar', min: 3 },
  { fg: 'state-needs-you', bg: 'sidebar-accent', min: 3 },
  { fg: 'state-stopped', bg: 'sidebar', min: 3 },
  { fg: 'state-stopped', bg: 'sidebar-accent', min: 3 },
  // #552 gate round 1 fix (Skippy, delegated by Stuart 2026-10-18): `state-stopped` is a
  // literal copy of `--destructive`/`--severity-error` in this theme (same reasoning, same
  // under-floor value before the fix) -- `--sidebar-accent` is this theme's selected/hovered
  // session row, the real surface a stopped Session's status icon renders on.
  { fg: 'state-stopped', bg: 'sidebar-accent', min: 7, onlyThemes: ['dark-high-contrast'] },
  { fg: 'active-indicator', bg: 'sidebar', min: 3 },
  { fg: 'active-indicator', bg: 'sidebar-accent', min: 3 },
  { fg: 'ring', bg: 'sidebar', min: 3 },
  { fg: 'ring', bg: 'sidebar-accent', min: 3 },
  // The toolbar's two ghost buttons default to `text-muted-foreground` (real icon/label text,
  // not icon-only against background), same floor `muted-foreground`/`background` uses above.
  { fg: 'muted-foreground', bg: 'sidebar', min: 4.5 },
  // #567 decision 26: the remaining sidebar pairs the restyled session row and group header
  // actually render -- `sidebar-foreground` (the row's own title text) and `destructive` (the
  // row's "Terminated unexpectedly" line 2) at the 4.5:1 text floor; `state-working` (the
  // working spinner's resting colour, distinct from `agent-spinner-core`'s own working-fill
  // check above) and `severity-info` at the 3:1 icon floor. `muted-foreground`/`sidebar-accent`
  // was missing too -- only its `sidebar` pair existed above (the toolbar's own comment).
  { fg: 'muted-foreground', bg: 'sidebar-accent', min: 4.5 },
  { fg: 'sidebar-foreground', bg: 'sidebar', min: 4.5 },
  { fg: 'sidebar-foreground', bg: 'sidebar-accent', min: 4.5 },
  { fg: 'destructive', bg: 'sidebar', min: 4.5 },
  { fg: 'destructive', bg: 'sidebar-accent', min: 4.5 },
  { fg: 'state-working', bg: 'sidebar', min: 3 },
  { fg: 'state-working', bg: 'sidebar-accent', min: 3 },
  { fg: 'severity-info', bg: 'sidebar', min: 3 },
  { fg: 'severity-info', bg: 'sidebar-accent', min: 3 },
  // Issue #568/#529: the pull request StatePill (solid fill, icon + word) -- its own text
  // colour against its own fill, in every theme. `pr-open`/`pr-closed` alias existing already-
  // gated fills (`state-working`/`destructive`), but the ALIAS NAME itself was never a PAIRS
  // entry before, so this still needs its own row per #570's own "check the token actually
  // rendered, not an alias" rule (decision 3 there). `pr-draft` (achromatic grey) and
  // `pr-merged` (new purple) had no prior pairing at all.
  { fg: 'pr-open-foreground', bg: 'pr-open', min: 4.5 },
  { fg: 'pr-draft-foreground', bg: 'pr-draft', min: 4.5 },
  { fg: 'pr-closed-foreground', bg: 'pr-closed', min: 4.5 },
  // #552 gate round 1 fix (Skippy, delegated by Stuart 2026-10-18): `pr-closed` is a literal
  // copy of `--destructive`/`--severity-error` in this theme -- same under-floor value before
  // the fix, checked against `--muted` (the PR list/detail's own hover tint, same binding
  // surface as `severity-error`/`muted` above).
  { fg: 'pr-closed', bg: 'muted', min: 7, onlyThemes: ['dark-high-contrast'] },
  { fg: 'pr-merged-foreground', bg: 'pr-merged', min: 4.5 },
  // Issue #925: the diff-stat "+A -D" colouring -- real BODY TEXT (never icon-only), so the
  // 4.5:1 floor, not the 3:1 non-text floor `state-working`/`destructive` already clear
  // elsewhere above. `diff-added`/`diff-removed` are new token NAMES (aliasing
  // `state-working`/`destructive`, `globals.css`), so #570's own "check the token actually
  // rendered, not an alias" rule means these need their own rows even though the underlying
  // value is already gated. Five real surfaces, three distinct backdrops: the composer status
  // line's Changes chip and the Pull requests Changes tab's own aggregate line both render on
  // `--background` in EVERY theme, including Dark high contrast (gate round 2 correction, Main:
  // confirmed live -- unlike Send/the "Markdown supported" hint text precedent above, the
  // status line sits OUTSIDE the composer's own fill, so it is never painted on
  // `--composer-background`; one `onlyThemes`-free pair below covers all three themes, not a
  // Send-style split); the Session details card's `HoverCardContent` renders on `--popover`;
  // the Changes tab's per-file diff header (`DiffViewFromPatch`'s own `bg-muted` header row,
  // #919) AND the chat transcript's own expanded `DiffView` header (gate round 1 M1, the
  // identical `bg-muted` header shape) both render on `--muted`, so one shared pair covers both.
  { fg: 'diff-added', bg: 'background', min: 4.5 },
  { fg: 'diff-removed', bg: 'background', min: 4.5 },
  { fg: 'diff-added', bg: 'popover', min: 4.5 },
  { fg: 'diff-removed', bg: 'popover', min: 4.5 },
  { fg: 'diff-added', bg: 'muted', min: 4.5 },
  { fg: 'diff-removed', bg: 'muted', min: 4.5 },
  { fg: 'border', bg: 'sidebar', min: 3 }, // #738 resize grip (bg-border) beside the session list
  { fg: 'border', bg: 'titlebar', min: 3 }, // resize grip rests on the titlebar-adjacent chrome
  { fg: 'accent-text', bg: 'sidebar', min: 3 }, // grip focus/drag beside the session list
]

// Issue #559 decision 28 (gate round 3 correction): the search field's own `<Input>` keeps its
// default translucent fill (`bg-transparent dark:bg-input/30`, `SearchField.tsx`'s own comment)
// -- `.dark` is always applied to `<html>` regardless of the active theme, so `dark:bg-input/30`
// always renders, in every built-in theme. A real PAIRS entry cannot express this: `--input` is
// ITSELF translucent (its own `alpha` is already < 1 once parsed from `oklch(1 0 0 / 36%)`),
// so `bg-input/30` composites at `input.alpha * 0.3` -- roughly 11% white over `--sidebar` in
// Dark/Obsidian, not a flat 30% an earlier (reverted) calculation wrongly assumed (that cut
// treated `--input` as opaque, landing on 2.55:1/2.61:1 and an unnecessary opaque-fill "fix").
// Exported as a function, not a plain `PAIRS` entry, since this module holds only simple
// token-name pairs and this needs real alpha-compositing math.
export function searchFieldContrastRows(themes) {
  const rows = []
  for (const [themeId, props] of Object.entries(themes)) {
    const input = props['input']
    const sidebar = props['sidebar']
    const mutedForeground = props['muted-foreground']
    if (!input || !sidebar || !mutedForeground) {
      rows.push({ themeId, fg: 'muted-foreground', bg: 'search-field (input*0.3 on sidebar)', min: 4.5, ratio: null, pass: false, note: 'token missing' })
      continue
    }
    const fieldLinear = resolvedLinear({ raw: 'input*0.3', alpha: input.alpha * 0.3, linear: input.linear }, sidebar)
    // Gate-fix (#1074 round 1, Code/Test HIGH): `muted-foreground` is translucent -- `.linear`
    // alone scores it as opaque; `resolvedLinear` composites it over the real field backdrop.
    const fgLinear = resolvedLinear(mutedForeground, { raw: 'search-field', alpha: 1, linear: fieldLinear })
    const ratio = contrastRatio(relativeLuminance(fgLinear), relativeLuminance(fieldLinear))
    rows.push({
      themeId,
      fg: 'muted-foreground',
      bg: 'search-field (input*0.3 on sidebar)',
      min: 4.5,
      ratio,
      pass: ratio >= 4.5,
      fgHex: linearToHex(fgLinear),
      bgHex: linearToHex(fieldLinear),
    })
  }
  return rows
}

// ---- issue #610 (hyperlinks) and #1074 (chat text opacity): both a link/file-link AND the
// chat prose itself composite over the user bubble's own translucent fill (`bg-accent/50`,
// `UserMessageRow.tsx`'s `MessageContent`), not flat `--background` -- the plain-background/
// card/popover PAIRS entries never exercise this composited case, and `--chat-foreground` is
// now itself translucent (#1074), so its own alpha composites a SECOND time on top of the
// bubble's. Checked the same way the destructive-footer block above checks its own composited
// backdrop: gamma-blend the bubble fill over the chat area's own `--background`, then gamma-
// blend each foreground (itself translucent or not) over THAT blended result, then WCAG-
// contrast.
export function userBubbleContrastRows(themes) {
  const rows = []
  for (const [themeId, props] of Object.entries(themes)) {
    const accent = props['accent']
    const background = props['background']
    const accentText = props['accent-text']
    const chatForeground = props['chat-foreground']
    if (!accent || !background || !accentText || !chatForeground) {
      rows.push({ themeId, fg: 'accent-text/chat-foreground', bg: 'user-bubble (accent/50 on background)', min: 4.5, ratio: null, pass: false, note: 'token missing' })
      continue
    }
    const bubble = { raw: 'bubble', alpha: 1, linear: resolvedLinear({ raw: 'accent/50', alpha: 0.5, linear: accent.linear }, background) }
    const bubbleLum = relativeLuminance(bubble.linear)
    for (const [fg, entry] of [['accent-text', accentText], ['chat-foreground', chatForeground]]) {
      const fgLinear = resolvedLinear(entry, bubble)
      const ratio = contrastRatio(relativeLuminance(fgLinear), bubbleLum)
      rows.push({ themeId, fg, bg: 'user-bubble (accent/50 on background)', min: 4.5, ratio, pass: ratio >= 4.5, fgHex: linearToHex(fgLinear), bgHex: linearToHex(bubble.linear) })
    }
  }
  return rows
}

// #551 gate round 1, item 9 (Skippy, delegated by Stuart 2026-10-18): `--sidebar-border` is a
// REAL rendered hover/expanded fill, not merely decorative, in EVERY theme -- `sidebar.tsx`'s
// separator, `SessionList.tsx`'s toolbar buttons, `SessionRow.tsx`'s trailing menu button and
// `RepositoryGroup.tsx`'s row actions all apply `hover:bg-sidebar-border`/`aria-expanded:bg-
// sidebar-border` with `muted-foreground` (or `foreground`, on `:hover`) text/icon on top -- a
// surface the existing `sidebarBorderAliasesDivider` check in check-theme-contrast.mjs only
// ever measures for a preset whose `--sidebar-border` literally aliases `--divider` (Obsidian).
// Dark, Dark high contrast, Nordic Frost and Cyber Amber all have an INDEPENDENT `--sidebar-
// border` value and were never checked against this real fill at all before now.
// Informational only (never fails the run): adding this as a genuine PAIRS entry would newly
// fail Dark (high contrast) (`muted-foreground` on its own `--sidebar-border`/`--sidebar`
// composite measures only ~2.50:1, a real, pre-existing gap unrelated to this story's own
// scope -- recorded on #552/flagged to Main, not fixed here). Every other theme clears 4.5:1 with
// margin (Dark/Cyber Amber 5.93:1, Obsidian 5.64:1, Nordic Frost 6.00:1 -- gate-fix round 1, #1074: real alpha composited, not scored as solid).
export function sidebarBorderContrastRows(themes) {
  const rows = []
  for (const [themeId, props] of Object.entries(themes)) {
    const sidebarBorder = props['sidebar-border']
    const sidebar = props['sidebar']
    const mutedForeground = props['muted-foreground']
    if (!sidebarBorder || !sidebar || !mutedForeground) {
      rows.push({ themeId, fg: 'muted-foreground', bg: 'sidebar-border-hover (sidebar-border on sidebar)', min: 4.5, ratio: null, pass: true, note: 'token missing, informational only -- not enforced (#551)' })
      continue
    }
    const fillLinear = resolvedLinear(sidebarBorder, sidebar)
    // Gate-fix (#1074 round 1, Code/Test HIGH): same translucent-as-solid bug as above.
    const fgLinear = resolvedLinear(mutedForeground, { raw: 'sidebar-border-hover', alpha: 1, linear: fillLinear })
    const ratio = contrastRatio(relativeLuminance(fgLinear), relativeLuminance(fillLinear))
    rows.push({
      themeId,
      fg: 'muted-foreground',
      bg: 'sidebar-border-hover (sidebar-border on sidebar)',
      min: 4.5,
      ratio,
      pass: true,
      fgHex: linearToHex(fgLinear),
      bgHex: linearToHex(fillLinear),
      note: ratio >= 4.5 ? 'informational, real rendered hover fill' : 'informational -- below 4.5:1, a real pre-existing gap, not enforced (#551 gate round 1, flagged not fixed)',
    })
  }
  return rows
}

// Issue #975 (code-block background follows each preset's own `--card`, not whatever a bundled
// Shiki theme ships with): `Markdown.tsx`'s `CodeBlock` neutralises Shiki's own root background
// to `transparent` and renders `CodeBlockHeader`/the Shiki output/the plain-text fallback on
// `bg-card`, so a fenced code block's REAL backdrop in every theme is now `--card`, never the
// `syntaxTheme` chosen in `src/shared/themes.ts`. Checks every distinct, non-self-backgrounded
// tokenColour foreground that chosen `syntaxTheme` ships -- keywords, strings, comments, the
// theme's own default text colour (`.fg`, what an UNstyled token actually renders, per Shiki's
// own `codeToHast` source) -- against that preset's own resolved `--card`, at the 4.5:1 floor
// the #975 decision comment set (not the 3:1 non-text floor `PAIRS` uses elsewhere: a code
// token is real body text, same as `muted-foreground`/`card` above).
//
// Gate round 1 fix (Main, Code4 Medium): a tokenColour entry carrying its OWN `settings.
// background` is excluded ONLY when every one of its scope names is CONFIRMED unreachable --
// scanned all 346 bundled Shiki language grammars' own JSON for a rule producing `markup.
// ignored`/`markup.untracked` (the only self-backgrounded scopes `github-dark`/`github-dark-
// default`/`github-dark-high-contrast` ship): zero matches anywhere, including `diff`, the one
// bundled language whose own scope names plausibly suggested a hit -- so no fence this app can
// ever highlight (`lang` loads whichever bundled Shiki language id an agent-authored fence
// names) can produce either scope. The previous cut's own claim ("it always renders on that
// literal paired background") was wrong for a THIRD self-backgrounded scope, `carriage-return`:
// the bundled `mdx` grammar's own hard-line-break rule (two or more trailing spaces) genuinely
// stacks it onto a token's own scope list, so an `mdx`-tagged fence CAN reach it -- confirmed
// live against `bundledLanguages.mdx`, not assumed. `carriage-return` is deliberately NOT in
// the confirmed-unreachable set below: it stays in the loop, measured against `--card` like any
// other token (its real backdrop when it fires is its own literal paired background, a separate
// concern this issue's neutralisation never touches, but there is no way to prove it unreachable
// the way the other two are, and its own foreground clears comfortably against every preset's
// `--card` regardless). The scope-less root-default entry (the theme's own overall `foreground`/
// `background` pair, redundant with the `.fg` entry already seeded below) stays skipped too.
const SELF_BACKGROUND_SCOPES_CONFIRMED_UNREACHABLE = new Set(['markup.ignored', 'markup.untracked'])
export function hexToLinearSrgb(hex) {
  let h = hex.slice(1)
  if (h.length === 3) h = [...h].map((c) => c + c).join('')
  const r = parseInt(h.slice(0, 2), 16) / 255
  const g = parseInt(h.slice(2, 4), 16) / 255
  const b = parseInt(h.slice(4, 6), 16) / 255
  return [srgbGammaDecode(r), srgbGammaDecode(g), srgbGammaDecode(b)]
}

export async function shikiTokenContrastRows(themes, themeMetadata) {
  const distinctSyntaxThemes = [...new Set(Object.values(themeMetadata).map((m) => m.syntaxTheme).filter(Boolean))]
  const rows = []
  if (distinctSyntaxThemes.length === 0) return rows
  const highlighter = await createHighlighter({ themes: distinctSyntaxThemes, langs: [], engine: createJavaScriptRegexEngine() })
  const tokenColoursByTheme = new Map()
  for (const syntaxTheme of distinctSyntaxThemes) {
    const resolved = highlighter.getTheme(syntaxTheme)
    const colours = new Map()
    colours.set(resolved.fg.toLowerCase(), '(default text)')
    for (const entry of resolved.settings) {
      const fg = entry.settings?.foreground
      if (!fg) continue
      const scopeNames = Array.isArray(entry.scope) ? entry.scope : entry.scope ? [entry.scope] : []
      if (entry.settings?.background && (scopeNames.length === 0 || scopeNames.every((s) => SELF_BACKGROUND_SCOPES_CONFIRMED_UNREACHABLE.has(s)))) continue
      const scope = scopeNames.length > 0 ? scopeNames.join(', ') : '(default text)'
      if (!colours.has(fg.toLowerCase())) colours.set(fg.toLowerCase(), scope)
    }
    tokenColoursByTheme.set(syntaxTheme, colours)
  }

  for (const [themeId, props] of Object.entries(themes)) {
    const syntaxTheme = themeMetadata[themeId]?.syntaxTheme
    const card = props['card']
    if (!syntaxTheme || !card) {
      rows.push({ themeId, fg: 'shiki token colour', bg: 'card', min: 4.5, ratio: null, pass: false, note: `'${themeId}' has no syntaxTheme (themes.ts) or --card token (globals.css)` })
      continue
    }
    const cardLum = relativeLuminance(card.linear)
    for (const [hex, scope] of tokenColoursByTheme.get(syntaxTheme)) {
      const ratio = contrastRatio(relativeLuminance(hexToLinearSrgb(hex)), cardLum)
      rows.push({
        themeId,
        fg: `shiki:${syntaxTheme} ${scope}`,
        bg: 'card',
        min: 4.5,
        ratio,
        pass: ratio >= 4.5,
        fgHex: hex,
        bgHex: linearToHex(card.linear),
      })
    }
  }
  return rows
}
