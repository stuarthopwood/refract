# Quickstart: verifying Brand spinner

Refract is a prototype with no automated tests. Each check below is a manual run of the app.
Requirement and story numbers refer to [spec.md](spec.md); the component's shape is in
[data-model.md](data-model.md); the inventory and design decisions are in
[research.md](research.md).

## Prerequisites

- Windows 11, with Settings > Accessibility > Visual effects > "Animation effects" available to
  turn off (this is the reduced-motion signal `globals.css` reads).
- The prerequisite brand assets (`build/refract-icon-v2.svg`,
  `src/renderer/assets/brand/refract-hero.svg`, spec.md "Prerequisite") landed on this branch or
  merged from `main` first. Where they have not landed yet, build `BrandSpinner.tsx` against
  placeholder path data and re-run every check once they do.
- `pnpm install`, `pnpm dev` or `pnpm build` + the built app, `pnpm typecheck` -- same as every
  prior spec.
- At least one repository added, so Sessions can be created and started.

## Checks per story

**Story 1: the working indicator is the brand mark (FR-001, FR-002, FR-003, FR-012)**

1. Start an agent running in a Session (any prompt that keeps it busy for a few seconds). Look at
   its row in the session list. Expect: the state icon is the brand mark, animating -- not
   `lucide-react`'s plain circular spinner.
2. With the same Session open, look at its chat header. Expect: the identical brand mark, same
   animation, same position the old spinner occupied.
3. Hover or keyboard-focus the row to open its details card. Expect: the identical brand mark
   there too.
4. Let the turn finish (or stop it). Expect: the icon changes to the existing hollow circle
   (idle), bell (needs-you), or square (stopped) -- whichever applies -- with the brand mark gone;
   confirm none of these three changed from before this feature.
5. Start two or more Sessions working at once. Expect: every one of their spinners' highlighted
   arm is in the same place (teal/amber/violet) at the same instant, not drifting independently
   (sample this at a few different moments a few seconds apart).
6. Turn on a screen reader and reach a working Session's row. Expect: the icon itself is not
   announced; the existing "Working" text is announced exactly as before this feature.
7. Run a repository-wide search for `animate-spin`. Expect: it appears only in `ToolRow.tsx`,
   `Transcript.tsx`, `SubagentPanel.tsx`, `SessionList.tsx` (the per-repository create button),
   `Readiness.tsx` (both sites), and `sonner.tsx` -- not in `sessionDisplay.tsx` (SC-001).

**Story 2: the mark stays legible, calm, and cheap (FR-005 to FR-011, FR-013)**

1. Zoom in on (or screenshot and magnify) a working Session's 16px state icon. Expect: a
   recognisable, simplified silhouette of the mark -- flat colour per arm, no attempt at the
   source artwork's fine internal facets, and no illegible blur.
2. Open Windows Settings > Accessibility > Visual effects and turn off "Animation effects". Look
   at a working Session's state icon. Expect: it is completely static -- no arm brightening or
   lifting -- while the row's sr-only "Working" text (confirm via a screen reader or the
   accessibility tree) is unchanged. Turn the setting back on and confirm the animation resumes.
3. Open twenty or more Sessions and start all their agents (a script or quickly repeated "New
   session" clicks works). Scroll the session list up and down. Expect: smooth scrolling with no
   stutter attributable to the spinners; open DevTools' Performance panel during the scroll and
   confirm no long frame is spent on style/layout work the spinners would explain (the animation
   should cost compositor time only).
4. With a working Session visible, switch the Settings > Appearance theme (spec 007) between Dark
   and Dark (high contrast). Expect: the spinner's colours are identical in both -- unaffected by
   the switch, unlike every other themed surface.
5. In DevTools, inspect the rendered `BrandSpinner` element's CSS: confirm the animated properties
   are only `transform` and/or `opacity` (FR-005), and confirm two simultaneously-mounted instances
   report different computed `animation-delay` values that nonetheless land both at the same
   animation progress at the same wall-clock instant (sample `getComputedStyle` at the same moment
   for two different spinners and confirm their delays differ by a multiple of 1.2s, not an
   arbitrary amount).

## Repository-wide verification (SC-001, SC-002)

- `grep -rn "animate-spin" src/renderer` and confirm the seven kept sites from research.md decision
  1's table, and no others.
- Read `ChatHeader.tsx`, `SessionDetailsCard.tsx`, and `SessionList.tsx` directly and confirm all
  three still call `<StateIcon status={...} />` with no local spinner of their own -- the only
  change is inside `StateIcon` itself.

## Forward-provisioned large size (spec.md Assumptions, research.md decision 10)

- During implementation only (not a shipped check): temporarily render `<BrandSpinner size={48}
  />` behind an unshipped harness (for example, a throwaway line in `Readiness.tsx`, reverted before
  committing) and confirm it renders the Full, faceted variant legibly at that size, then remove
  the temporary harness entirely -- confirmed by `git diff` showing no trace of it in the committed
  tree.
