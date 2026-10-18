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

export const PAIRS = [
  { fg: 'foreground', bg: 'background', min: 4.5 },
  { fg: 'card-foreground', bg: 'card', min: 4.5 },
  { fg: 'popover-foreground', bg: 'popover', min: 4.5 },
  { fg: 'primary-foreground', bg: 'primary', min: 4.5 },
  { fg: 'send-foreground', bg: 'send', min: 3 },
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
  // Gate round 5 (#564 follow-up): `dropdown-menu.tsx`'s own active-row inset shadow now uses
  // this token (was `--ring`), rendered on `bg-popover` (`DropdownMenuContent`'s own fill),
  // never checked against that specific surface before.
  { fg: 'active-indicator', bg: 'popover', min: 3 },
  { fg: 'destructive', bg: 'background', min: 3 },
  { fg: 'state-working', bg: 'background', min: 3 },
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
  // Gate round 4 (#564 follow-up) pair REMOVED by #927 (quiet composer): the Approval mode
  // pill's own `badgeVariants({variant: 'outline'})` used to render an opaque `border-border`
  // directly on `--composer-background` -- #927 moved the Approval pill, Model and Reasoning
  // triggers to `badgeVariants({variant: 'ghost'})` (`pickerShared.tsx`'s `PICKER_TRIGGER_CLASS`),
  // which has no border in any theme, so nothing renders this pair any more.
  { fg: 'border-strong', bg: 'background', min: 3 },
  { fg: 'border-strong', bg: 'card', min: 3 },
  { fg: 'border-strong', bg: 'popover', min: 3 },
  { fg: 'border-strong', bg: 'muted', min: 3 },
  { fg: 'accent-text', bg: 'background', min: 4.5 },
  { fg: 'accent-text', bg: 'card', min: 4.5 },
  { fg: 'accent-text', bg: 'popover', min: 4.5 },
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
  { fg: 'muted-foreground', bg: 'popover', min: 4.5 },
  { fg: 'muted-foreground', bg: 'surface-hover', min: 4.5 },
  // Issue #630: `DiffView.tsx`'s new +N added-line count sits as real `text-xs` body text on
  // the diff box's own `bg-muted` header (the same token the diff gutter's own insert tint
  // already uses, chosen over a raw Tailwind palette colour precisely so it is gated here).
  { fg: 'state-working', bg: 'muted', min: 4.5 },
  // Subagent status icons on `--muted` (#563 remediation, decision 26): finished/failed icons.
  { fg: 'state-idle', bg: 'muted', min: 3 },
  { fg: 'severity-error', bg: 'muted', min: 3 },
  // #565 decision 32: a node icon, and a notice's own coloured summary text, must keep their
  // floor on the hover tint too (`CollapsedLine`'s own `hover:bg-muted`, decision 18).
  // `state-working/muted` and `ring/muted` are already gated at the stricter 4.5/3 floors above
  // and below (lines 117, 152) -- only `destructive`/`muted` and `state-needs-you`/`muted` were
  // genuinely missing. Both are real rendered text today: a long error/warning `NoticeRow`'s own
  // `summaryClassName` (`text-destructive`/`text-state-needs-you`) sits directly on this tint
  // once hovered.
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
    const ratio = contrastRatio(relativeLuminance(mutedForeground.linear), relativeLuminance(fieldLinear))
    rows.push({
      themeId,
      fg: 'muted-foreground',
      bg: 'search-field (input*0.3 on sidebar)',
      min: 4.5,
      ratio,
      pass: ratio >= 4.5,
      fgHex: linearToHex(mutedForeground.linear),
      bgHex: linearToHex(fieldLinear),
    })
  }
  return rows
}

// ---- issue #610 (hyperlinks): a link/file-link rendered inside a user message composites
// `--accent-text` (Markdown.tsx's `linkClassName`) over the user bubble's own translucent fill
// (`bg-accent/50`, `Transcript.tsx`'s `MessageContent` for a `kind: 'user'` row), not flat
// `--background` -- the plain-background/card/popover PAIRS entries above never actually
// exercise this composited case. Checked the same way the destructive-footer block above
// checks its own composited backdrop: gamma-blend the translucent fill over the chat area's
// own `--background` (the only surface a user bubble ever renders on), then WCAG-contrast
// `--accent-text` against that blended result.
export function userBubbleLinkContrastRows(themes) {
  const rows = []
  for (const [themeId, props] of Object.entries(themes)) {
    const accent = props['accent']
    const background = props['background']
    const accentText = props['accent-text']
    if (!accent || !background || !accentText) {
      rows.push({ themeId, fg: 'accent-text', bg: 'user-bubble (accent/50 on background)', min: 4.5, ratio: null, pass: false, note: 'token missing' })
      continue
    }
    const bubbleLinear = resolvedLinear({ raw: 'accent/50', alpha: 0.5, linear: accent.linear }, background)
    const ratio = contrastRatio(relativeLuminance(accentText.linear), relativeLuminance(bubbleLinear))
    rows.push({
      themeId,
      fg: 'accent-text',
      bg: 'user-bubble (accent/50 on background)',
      min: 4.5,
      ratio,
      pass: ratio >= 4.5,
      fgHex: linearToHex(accentText.linear),
      bgHex: linearToHex(bubbleLinear),
    })
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
//
// Informational only (never fails the run): adding this as a genuine PAIRS entry would newly
// fail Dark (high contrast) (`muted-foreground` on its own `--sidebar-border`/`--sidebar`
// composite measures only ~2.50:1, a real, pre-existing gap unrelated to this story's own
// scope -- recorded on #552/flagged to Main, not fixed here). Every other theme clears 4.5:1
// with margin (Dark 5.22:1, Obsidian 4.91:1, Nordic Frost 5.19:1, Cyber Amber 5.39:1).
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
    const ratio = contrastRatio(relativeLuminance(mutedForeground.linear), relativeLuminance(fillLinear))
    rows.push({
      themeId,
      fg: 'muted-foreground',
      bg: 'sidebar-border-hover (sidebar-border on sidebar)',
      min: 4.5,
      ratio,
      pass: true,
      fgHex: linearToHex(mutedForeground.linear),
      bgHex: linearToHex(fillLinear),
      note: ratio >= 4.5 ? 'informational, real rendered hover fill' : 'informational -- below 4.5:1, a real pre-existing gap, not enforced (#551 gate round 1, flagged not fixed)',
    })
  }
  return rows
}
