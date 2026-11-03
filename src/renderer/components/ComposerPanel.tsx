// The collapsible panel shape shared by the panels stacked above the composer (the pinned Todo
// panel, #700, and the Queued panel, #1145; ADR 0003): a full-width header row that toggles the
// body (title, then a chevron), optional header actions beside it, a top divider, `text-xs`, and
// a body capped at one shared max height that then scrolls. Callers own the body's content and
// padding, so a body can span the pane and keep its scrollbar on the pane edge (#1130).
import { useId, type ComponentProps, type ReactNode, type Ref } from 'react'
import { ChevronDownIcon } from 'lucide-react'
import { create } from 'zustand'
import { Button } from '@/components/ui/button'
import { COMPOSER_BUTTON_FOCUS_CLASS } from '@/components/ui/composerFocus'
import { cn } from '@/lib/utils'

/** The tallest any panel or banner above the composer grows before it scrolls. */
export const COMPOSER_PANEL_MAX_HEIGHT_CLASS = 'max-h-[min(12rem,30vh)]'

export interface SessionCollapseState {
  collapsedBySession: Record<string, boolean>
  setCollapsed(sessionId: string, collapsed: boolean): void
}

/** A per-Session collapse store for one panel, in memory only (reset by an app restart). */
export function createSessionCollapseStore() {
  return create<SessionCollapseState>((set, get) => ({
    collapsedBySession: {},
    setCollapsed: (sessionId, collapsed) => set({ collapsedBySession: { ...get().collapsedBySession, [sessionId]: collapsed } })
  }))
}

interface ComposerPanelProps {
  id: string
  slot: string
  label: string
  /** Fixed accessible name of the toggle; the visible title describes it. */
  toggleLabel: string
  title: ReactNode
  /** Full title text for a truncated header, shown on hover. */
  titleHint?: string
  collapsed: boolean
  onToggle: () => void
  /** The body's id, named by the toggle's `aria-controls` while expanded. */
  bodyId: string
  /** Extra header controls, placed after the toggle. */
  actions?: ReactNode
  rootRef?: Ref<HTMLElement>
  children: ReactNode
}

export function ComposerPanel({ id, slot, label, toggleLabel, title, titleHint, collapsed, onToggle, bodyId, actions, rootRef, children }: ComposerPanelProps) {
  const titleId = useId()
  return (
    <section ref={rootRef} id={id} data-slot={slot} aria-label={label} aria-live="off" className="shrink-0 border-t border-divider py-2 text-xs">
      <div className="flex h-6 items-center gap-1 px-4">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-expanded={!collapsed}
          aria-controls={collapsed ? undefined : bodyId}
          aria-label={toggleLabel}
          aria-describedby={titleId}
          className={cn('-ml-2 h-6 min-w-0 flex-1 justify-between font-normal text-foreground aria-expanded:bg-transparent', COMPOSER_BUTTON_FOCUS_CLASS)}
          onClick={onToggle}
        >
          <span id={titleId} className="min-w-0 flex-1 truncate text-left" title={titleHint}>
            {title}
          </span>
          <ChevronDownIcon aria-hidden className={cn('size-4 shrink-0 text-muted-foreground transition-transform', collapsed && '-rotate-90')} />
        </Button>
        {actions}
      </div>
      {!collapsed && children}
    </section>
  )
}

/** The capped, scrolling body of a `ComposerPanel`. */
export function ComposerPanelBody({ className, ...props }: ComponentProps<'div'>) {
  return <div {...props} className={cn('mt-1 overflow-y-auto [overflow-anchor:none]', COMPOSER_PANEL_MAX_HEIGHT_CLASS, className)} />
}
