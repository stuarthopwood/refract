import { TitlebarBand } from '@/components/TitlebarBand'
import { BrandWatermark } from './BrandWatermark'
import { HolidayAmbientLoop } from '../holidays/HolidayAmbientLoop'
import { HolidayEmptyStateLine } from '../holidays/HolidayEmptyStateLine'

// Root is the `cqw` query container; `isolate` makes the stacking context so the -z-10 mark paints behind the text.
/** Empty state shown when no session is open. */
export function EmptyChatState() {
  return (
    <div
      data-chat-empty-state
      role="region"
      aria-label="Chat"
      tabIndex={-1}
      className="relative isolate flex flex-col h-full items-center justify-center text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [container-type:size]"
    >
      <TitlebarBand />
      <BrandWatermark variant="live" />
      <HolidayAmbientLoop />
      <span>Select a Session or create one.</span>
      <HolidayEmptyStateLine className="text-xs" />
    </div>
  )
}
