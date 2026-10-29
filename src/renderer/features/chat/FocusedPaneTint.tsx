import { cn } from '@/lib/utils'

// #684 (CONTEXT.md "Focused pane tint"): the focused split pane's body cue, replacing the left
// accent bar. Always mounted so the cue fades both ways by opacity alone (the global
// reduced-motion block makes it instant); starts below the 40 px header (`top-10`) so the shared
// title bar stays one colour across both panes. High contrast has no tint: `--pane-focused-edge`
// draws a 2 px inset edge around the body instead.
export function FocusedPaneTint({ active }: { active: boolean }) {
  return (
    <span
      aria-hidden
      data-focused-pane-tint={active ? 'on' : 'off'}
      className={cn(
        'pointer-events-none absolute inset-x-0 top-10 bottom-0 -z-10 bg-pane-focused shadow-[inset_0_0_0_2px_var(--pane-focused-edge)] transition-opacity duration-150 ease-out',
        active ? 'opacity-100' : 'opacity-0'
      )}
    />
  )
}
