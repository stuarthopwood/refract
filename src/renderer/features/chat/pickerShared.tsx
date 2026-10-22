// Shared helpers for the composer's Model and Reasoning pickers (gate round 2, LOW: split out of
// the former single `ComposerPickers.tsx`, which had grown past the single-responsibility
// threshold at 427 lines/three components -- `ModelPicker` moved to its own file,
// `ModelPicker.tsx`, alongside this shared module both it and `ReasoningPicker` depend on).
import { useEffect, useState } from 'react'
import { badgeVariants } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/** Shared by both pickers: blocks only an attempt to OPEN while `disabled`, and force-closes an
 * already-open menu the instant `disabled` becomes true. The pickers are no longer disabled by
 * Session status (#766 part B: changes queue for the next turn), so callers pass `false` unless
 * they have their own reason. */
export function usePickerOpenState(disabled: boolean) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])
  function onOpenChange(next: boolean) {
    if (next && disabled) return
    setOpen(next)
  }
  return { open, setOpen, onOpenChange }
}

/** Gate round 5 fix (Visual Medium #4, #11): one shared composer focus treatment instead of each
 * control drawing its own mix of ring/outline/border-colour. `badgeVariants`-based triggers
 * (the pill, the pickers) already show a visible outline once a width utility is applied (their
 * base class never sets `outline-style: none`); `Button`-based controls (`button.tsx`) start
 * from `outline-none` and draw their own `ring`/`border-ring` focus instead, so
 * `COMPOSER_BUTTON_FOCUS_CLASS` additionally turns the outline style back on (`outline-solid`)
 * and drops Button's own ring/border-colour change so the two never show at once.
 *
 * #927 split (quiet composer, decision 4a): Send and Stop are the one pair left on this full,
 * opaque `--ring` treatment ("Send and Stop are unchanged (filled, round)") -- every OTHER
 * composer control (the Approval pill, Model, Reasoning, Attach) is now a borderless ghost
 * trigger and moved to `GHOST_FOCUS_CLASS`/`GHOST_BUTTON_FOCUS_CLASS` below, which read the new
 * `--composer-focus` token (muted in Dark/Obsidian, an exact alias of `--ring` in Dark high
 * contrast, so that theme's own ghost triggers still draw the full opaque outline). */
export const COMPOSER_FOCUS_CLASS = 'focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
export const COMPOSER_BUTTON_FOCUS_CLASS = cn(COMPOSER_FOCUS_CLASS, 'focus-visible:border-transparent focus-visible:outline-solid')

/** #927 (quiet composer, decision 4a): the SAME shape as `COMPOSER_FOCUS_CLASS`/
 * `COMPOSER_BUTTON_FOCUS_CLASS` above, reading `--composer-focus` instead of `--ring` directly
 * -- the muted outline every ghost composer trigger (Approval pill, Model, Reasoning, Attach)
 * now shares. Focus is never invisible, only muted (the accepted WCAG 1.4.11 departure,
 * docs/design/accessibility.md "Accepted departures"), and Dark (high contrast) renders this
 * identically to the opaque pair above since its own `--composer-focus` aliases `--ring`. */
// M2 (gate951UI): a bare `focus-visible:outline-composer-focus` left `ghost`'s own resting
// `border-transparent` unset on focus, so a BORDERED theme (Dark high contrast) could show a
// stray border edge alongside the muted outline -- `focus-visible:border-transparent` matches
// `GHOST_BUTTON_FOCUS_CLASS`'s own pair below, so keyboard focus reads as the muted outline
// alone, consistently.
export const GHOST_FOCUS_CLASS = 'focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-composer-focus focus-visible:border-transparent'
export const GHOST_BUTTON_FOCUS_CLASS = cn(GHOST_FOCUS_CLASS, 'focus-visible:outline-solid')

/** Gate round 5 fix (Visual LOW): disabled composer triggers used two different opacities (0.5,
 * `badgeVariants`' own `aria-disabled:opacity-50`; 0.6, the box-dim-matching override gate round
 * 4 added per-picker) and still showed hover feedback while disabled. One shared opacity value,
 * applied unconditionally wherever `aria-disabled` is the only disabled signal (no separate
 * native `disabled` attribute).
 *
 * Gate round 7 fix (Visual Medium 1, `agent://Arch877`/`agent://G564Code`): split the hover
 * RESET out into its own class. The reset (`aria-disabled:hover:bg-transparent
 * aria-disabled:hover:text-current`) only suits a control whose resting fill IS transparent
 * (the outline/ghost triggers below) -- applied to Send, whose resting fill is the OPAQUE
 * `--send` token, `[aria-disabled=true]:hover` (0,3,0 specificity) beat Send's own
 * `hover:bg-[color-mix(...)]` (0,2,0), so hovering a disabled, empty-draft Send (its ordinary
 * resting state) dropped the indigo fill to transparent, leaving a bare white arrow. Send now
 * takes `COMPOSER_DISABLED_OPACITY_CLASS` alone; everything that was transparent at rest keeps
 * the combined `COMPOSER_DISABLED_CLASS` below, unchanged. */
// A2 (gate951A11y): a disabled-but-still-focusable trigger (stopped, last-known value shown)
// dimmed its own keyboard focus outline along with everything else at `opacity-60` -- the
// outline must read at full strength on focus regardless of the disabled dim.
export const COMPOSER_DISABLED_OPACITY_CLASS = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-60 focus-visible:aria-disabled:opacity-100'
export const COMPOSER_DISABLED_HOVER_RESET_CLASS = 'aria-disabled:hover:bg-transparent aria-disabled:hover:text-current'
export const COMPOSER_DISABLED_CLASS = cn(COMPOSER_DISABLED_OPACITY_CLASS, COMPOSER_DISABLED_HOVER_RESET_CLASS)

export const PICKER_TRIGGER_CLASS = cn(
  // #927 (quiet composer, decision 4a): `outline` (a visible `border-border`) -> `ghost` (no
  // border or fill at rest, the variant `components.md` "Button" already documents for
  // icon-only toolbar actions, reused here rather than inventing new classes). The explicit
  // `text-muted-foreground`/`hover:text-foreground`/`aria-expanded:text-foreground` below win
  // over `ghost`'s own (opposite-direction) hover text colour via `cn`'s tailwind-merge, so a
  // trigger reads quiet at rest and brightens on hover/open -- the same resting-muted,
  // hover-foreground convention `ReadoutChip.tsx`'s own interactive style already uses.
  badgeVariants({ variant: 'ghost' }),
  // U1 (gate951UI/A11y High): `ghost`'s own border-less resting state applied in EVERY theme,
  // including Dark high contrast -- but #927 decision 3 keeps that theme's edges unchanged, so
  // its triggers must keep a visible resting border. `--composer-control-border` is transparent
  // in Dark/Obsidian (matches ghost's own look) and `var(--border)` in Dark high contrast
  // (globals.css); `border` (1px) is added explicitly since `ghost` sets none of its own.
  // U2: `cursor-pointer`/`aria-disabled:cursor-not-allowed` -- hover must show the pointer
  // cursor (decision 4a), never the default disabled-looking arrow, except while truly disabled.
  'h-6 shrink-0 gap-2 px-2.5 border border-composer-control-border cursor-pointer aria-disabled:cursor-not-allowed text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:aria-disabled:hover:bg-transparent',
  COMPOSER_DISABLED_CLASS,
  GHOST_FOCUS_CLASS
)

/** The keyboard-active option highlight (gate round 2, accessibility-auditor HIGH): a plain
 * `bg-accent` background alone measured under 1.3:1 in every theme, since `--accent` sits very
 * close to `--popover` by design. Matches `SlashMenu.tsx`'s own pattern exactly: a left border,
 * transparent at rest, switching to the opaque `--active-indicator` token (>=3:1 everywhere,
 * already relied on elsewhere for exactly this purpose) when active. */
export const PICKER_OPTION_CLASS = 'flex cursor-default items-center gap-2 border-l-2 border-transparent px-2 py-1.5 text-sm'
export const PICKER_OPTION_ACTIVE_CLASS = 'border-l-active-indicator bg-accent text-accent-foreground'

/** #1101 (Git changes panel commit box, ADR 0003): the composer's own surface/border/focus
 * treatment (`MessageInput.tsx`'s outer wrapper div -- `border-composer-border`/
 * `bg-composer-background`/`border-composer-focus`/`ring-composer-ring`), applied directly to a
 * standalone `Input`/`Textarea` element instead. The real composer draws this on a WRAPPING div
 * and keys its focus state off a descendant textarea (`has-[textarea:focus-visible]`) because a
 * pill row and ghost-text overlay share that same box; the commit box has no such siblings, so
 * the identical tokens are applied straight to each field's own `focus-visible` state, replacing
 * `Input`/`Textarea`'s generic `border-input`/`--ring` defaults with the composer's instead of
 * re-deriving a third set of tokens.
 * Live-check fix (verify-1101, 2026-10-20): `Input`/`Textarea`'s own `dark:bg-input/30` is a
 * DIFFERENT variant group from a bare `bg-composer-background` (no `dark:` prefix), so `cn`
 * cannot recognise them as conflicting and never drops the stale one -- in Dark/Obsidian/Dark
 * high contrast the real DOM ends up carrying BOTH classes, and `dark:bg-input/30` wins the CSS
 * cascade (declared later in the generated stylesheet), confirmed live via a real computed-style
 * read (`oklab(1 0 0 / 0.108)`, exactly `--input`'s 36% alpha times Tailwind's own `/30` modifier
 * -- never `--composer-background` at all). An explicit `dark:bg-composer-background` gives
 * `cn` a same-variant competitor to actually dedupe against, the same fix this file's own
 * `text-readout` precedent (`src/renderer/lib/utils.ts`) already documents for an unrelated
 * custom-token collision. */
export const COMPOSER_INPUT_SURFACE_CLASS =
  'border-composer-border bg-composer-background dark:bg-composer-background focus-visible:border-composer-focus focus-visible:ring-3 focus-visible:ring-composer-ring'
