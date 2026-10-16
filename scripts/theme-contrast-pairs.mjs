// FR-007/FR-008 token pairs actually rendered by this codebase, extracted from
// scripts/check-theme-contrast.mjs (gate round 4 follow-up, #806 file-size ratchet: the script
// had grown past its own recorded baseline for legitimate new pairs, and the ratchet is lower-
// only -- a baseline entry may never be RAISED, so the growth was moved out into its own module
// instead). Pure data, no behaviour change: `check-theme-contrast.mjs` imports `PAIRS` from here
// and iterates it exactly as it did when the array lived inline.
//
// `min: 4.5` = WCAG AA body/UI text; `min: 3` = WCAG AA large text and non-text UI components
// (focus rings, control-edge borders, scrollbar thumbs, status icons used without accompanying
// text). `--divider` is NOT a control edge (#550: it is the soft decorative edge, read by no
// component yet except where it IS a real rendered fill -- see DIVIDER_PAIRS's own comment
// below). `--border` IS a control edge in every theme in this remediated cut (Dark/HC keep
// rendering every un-migrated `border-border` call site with it, unchanged; Obsidian's own
// `--border` is tuned to the same floor) -- checked here, same as `--border-strong`, its alias.

export const PAIRS = [
  { fg: 'foreground', bg: 'background', min: 4.5 },
  { fg: 'card-foreground', bg: 'card', min: 4.5 },
  { fg: 'popover-foreground', bg: 'popover', min: 4.5 },
  { fg: 'primary-foreground', bg: 'primary', min: 4.5 },
  { fg: 'send-foreground', bg: 'send', min: 3 },
  { fg: 'send', bg: 'composer-background', min: 3 },
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
  // Gate round 4 (#564 follow-up): the Approval mode pill's own `badgeVariants({variant:
  // 'outline'})` renders `border-border` (opaque), not the composer box's own translucent
  // `border-muted-foreground/85` -- a different token, never checked against this specific
  // surface, since the composer-dimming change now leaves the pill resting directly on
  // `--composer-background` in both the enabled and the (never-dimmed-anymore) disabled state.
  { fg: 'border', bg: 'composer-background', min: 3 },
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
  { fg: 'muted-foreground', bg: 'composer-background', min: 4.5 },
  // `--input`/`--ring`, the control-edge tokens every dialog footer's outline Cancel button and
  // every focus ring actually render, checked only against `--background` before -- dialogs
  // and menus sit on `--popover`/`--muted`, not the page.
  { fg: 'input', bg: 'popover', min: 3 },
  { fg: 'input', bg: 'muted', min: 3 },
  { fg: 'ring', bg: 'popover', min: 3 },
  { fg: 'ring', bg: 'muted', min: 3 },
  // Gate round 4 (#564 follow-up): the Approval mode pill's `focus-visible:outline-ring` (and
  // the Model/Reasoning picker triggers' own, `PICKER_TRIGGER_CLASS`, already live since gate
  // round 1) both render their opaque focus outline directly on `--composer-background`, never
  // checked against that specific surface before -- closes the same kind of pre-existing gap
  // the `muted-foreground`/`composer-background` pair above closed.
  { fg: 'ring', bg: 'composer-background', min: 3 },
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
]
