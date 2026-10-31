import type { CSSProperties, ElementType, ReactNode, Ref } from 'react'
import { cn } from '@/lib/utils'

/** The one 40 px height every title-bar-band row shares (#1467, docs/design/components.md "Panel header"). */
export const PANEL_HEADER_HEIGHT_CLASS = 'h-10'

/** Width of the native window-controls overlay, for a header that spans the title bar. */
export const WINDOW_CONTROLS_OVERLAY_STYLE: CSSProperties = { width: 'calc(100vw - env(titlebar-area-width, 100vw))' }

export interface PanelHeaderProps {
  /** Landmark element: `header` for a pane header, `div` (default) elsewhere. */
  as?: 'div' | 'header'
  ref?: Ref<HTMLDivElement>
  className?: string
  /** Title side (left). */
  children?: ReactNode
  /** Right-aligned actions; they sit in a `no-drag-region` group so clicks are never swallowed as window drags. */
  actions?: ReactNode
  /** Reserves the native window-controls overlay at the right end with this width style. */
  windowControlsSpacerStyle?: CSSProperties
}

export function PanelHeader({ as: Tag = 'div', ref, className, children, actions, windowControlsSpacerStyle }: PanelHeaderProps) {
  const Root = Tag as ElementType
  return (
    <Root ref={ref} className={cn('drag-region titlebar-surface flex shrink-0 items-center gap-2 px-4', PANEL_HEADER_HEIGHT_CLASS, className)}>
      {children}
      {actions && <div className="no-drag-region ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
      {windowControlsSpacerStyle && (
        <div aria-hidden className={cn('no-drag-region shrink-0', !actions && 'ml-auto')} style={windowControlsSpacerStyle} />
      )}
    </Root>
  )
}
