// Shared helpers for the composer's Model and Reasoning pickers (gate round 2, LOW: split out of
// the former single `ComposerPickers.tsx`, which had grown past the single-responsibility
// threshold at 427 lines/three components -- `ModelPicker` moved to its own file,
// `ModelPicker.tsx`, alongside this shared module both it and `ReasoningPicker` depend on).
import { useEffect, useState } from 'react'
import { badgeVariants } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { useSessionsStore } from '@/state'

/** `notIdle`: the Session is working or needs-you -- the API's own mid-turn refusal rule.
 * `stopped`: no agent is running at all; a picker still shows the last-known value but cannot
 * change it either (decision 3). Either state disables the trigger, with its own reason text. */
export function usePickerDisabled(sessionId: string) {
  const status = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.status ?? 'stopped')
  const notIdle = status === 'working' || status === 'needs-you'
  const stopped = status === 'stopped'
  return { disabled: notIdle || stopped, notIdle, stopped }
}

/** Shared by both pickers (gate round 1 fix, code-reviewer HIGH): blocks only an attempt to
 * OPEN while disabled -- Escape, an outside click, and selecting an item all still close an
 * already-open menu even if `disabled` flipped true in the meantime -- and force-closes an
 * already-open menu the instant `disabled` itself becomes true (the Session starts a turn, or
 * stops, while the menu is sitting open). */
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
export const GHOST_FOCUS_CLASS = 'focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-composer-focus'
export const GHOST_BUTTON_FOCUS_CLASS = cn(GHOST_FOCUS_CLASS, 'focus-visible:border-transparent focus-visible:outline-solid')

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
export const COMPOSER_DISABLED_OPACITY_CLASS = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-60'
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
  // Gate round 6 fix (Visual, `agent://Arch877`): `gap-1.5` (6px) is off the 4px spacing grid
  // (`docs/design/foundations-typography-spacing.md` lists it as one of the exact violations the
  // #474 audit found, not an exception) -- `gap-2` (8px) is the nearest on-grid step.
  'h-6 shrink-0 gap-2 px-2.5 text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground',
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
