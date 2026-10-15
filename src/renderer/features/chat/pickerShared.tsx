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

export const PICKER_TRIGGER_CLASS = cn(
  badgeVariants({ variant: 'outline' }),
  'h-6 shrink-0 gap-1.5 px-2.5 hover:bg-muted aria-expanded:bg-muted aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
  // Gate round 1 fix (MEDIUM): `badgeVariants`' own base focus ring is `ring-ring/50` (50%
  // alpha), below the WCAG 1.4.11 non-text 3:1 floor for a focus indicator. Opaque override,
  // the codebase's own `outline-ring` convention (`CollapsedLine.tsx`); `cn`'s Tailwind-merge
  // dedupes the conflicting `ring-color` utility so this wins over the base class above.
  'focus-visible:ring-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
)

/** The keyboard-active option highlight (gate round 2, accessibility-auditor HIGH): a plain
 * `bg-accent` background alone measured under 1.3:1 in every theme, since `--accent` sits very
 * close to `--popover` by design. Matches `SlashMenu.tsx`'s own pattern exactly: a left border,
 * transparent at rest, switching to the opaque `--active-indicator` token (>=3:1 everywhere,
 * already relied on elsewhere for exactly this purpose) when active. */
export const PICKER_OPTION_CLASS = 'flex cursor-default items-center gap-2 border-l-2 border-transparent px-2 py-1.5 text-sm'
export const PICKER_OPTION_ACTIVE_CLASS = 'border-l-active-indicator bg-accent text-accent-foreground'
