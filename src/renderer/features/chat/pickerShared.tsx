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
 * control drawing its own mix of ring/outline/border-colour -- the Approval pill, both pickers,
 * Attach, Send and Stop all now draw the SAME opaque 2px outline with a 2px offset.
 * `badgeVariants`-based triggers (the pill, the pickers) already show a visible outline once a
 * width utility is applied (their base class never sets `outline-style: none`); `Button`-based
 * controls (`button.tsx`) start from `outline-none` and draw their own `ring`/`border-ring`
 * focus instead, so `COMPOSER_BUTTON_FOCUS_CLASS` additionally turns the outline style back on
 * (`outline-solid`) and drops Button's own ring/border-colour change so the two never show at
 * once. */
export const COMPOSER_FOCUS_CLASS = 'focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
export const COMPOSER_BUTTON_FOCUS_CLASS = cn(COMPOSER_FOCUS_CLASS, 'focus-visible:border-transparent focus-visible:outline-solid')

/** Gate round 5 fix (Visual LOW): disabled composer triggers used two different opacities (0.5,
 * `badgeVariants`' own `aria-disabled:opacity-50`; 0.6, the box-dim-matching override gate round
 * 4 added per-picker) and still showed hover feedback while disabled. One shared value, applied
 * unconditionally wherever `aria-disabled` is the only disabled signal (no separate native
 * `disabled` attribute), plus a hover reset so a disabled trigger's own hover background/text
 * classes never activate underneath the dim. */
export const COMPOSER_DISABLED_CLASS =
  'aria-disabled:cursor-not-allowed aria-disabled:opacity-60 aria-disabled:hover:bg-transparent aria-disabled:hover:text-current'

export const PICKER_TRIGGER_CLASS = cn(
  badgeVariants({ variant: 'outline' }),
  'h-6 shrink-0 gap-1.5 px-2.5 hover:bg-muted aria-expanded:bg-muted',
  COMPOSER_DISABLED_CLASS,
  COMPOSER_FOCUS_CLASS
)

/** The keyboard-active option highlight (gate round 2, accessibility-auditor HIGH): a plain
 * `bg-accent` background alone measured under 1.3:1 in every theme, since `--accent` sits very
 * close to `--popover` by design. Matches `SlashMenu.tsx`'s own pattern exactly: a left border,
 * transparent at rest, switching to the opaque `--active-indicator` token (>=3:1 everywhere,
 * already relied on elsewhere for exactly this purpose) when active. */
export const PICKER_OPTION_CLASS = 'flex cursor-default items-center gap-2 border-l-2 border-transparent px-2 py-1.5 text-sm'
export const PICKER_OPTION_ACTIVE_CLASS = 'border-l-active-indicator bg-accent text-accent-foreground'
