// The visible Chrome band (#682, CONTEXT.md) for screens whose top 40px has no header row of its
// own (Readiness, the empty chat state). Purely cosmetic: `aria-hidden`, `pointer-events-none`,
// painted behind the screen's content (`-z-10`, so the parent must be `relative isolate`); the
// invisible drag strip in `App.tsx` keeps the window draggable. `reservesWindowControls` leaves
// room for the native caption buttons, mirroring `WINDOW_CONTROLS_SPACER_STYLE`.
import { cn } from '@/lib/utils'
import { PANEL_HEADER_HEIGHT_CLASS } from './PanelHeader'

export function TitlebarBand({ reservesWindowControls = false }: { reservesWindowControls?: boolean }) {
  return (
    <div
      aria-hidden
      data-titlebar-band
      className={cn('titlebar-surface pointer-events-none absolute inset-x-0 top-0 -z-10', PANEL_HEADER_HEIGHT_CLASS)}
      style={reservesWindowControls ? { right: 'calc(100vw - env(titlebar-area-width, 100vw))' } : undefined}
    />
  )
}
