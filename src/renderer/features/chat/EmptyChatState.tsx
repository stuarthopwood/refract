// Spec 012 (research.md decision 3): the no-session-open empty state -- extracted from App.tsx
// (gate round 2, item 11) to keep that file under its own file-size baseline (#806) once issue
// #1048's `HolidayEmptyStateLine` needed its own JSX line (one statement per line, never two
// packed onto one to dodge the cap). No composer exists in this branch, so the mark anchors to
// this div's own full box.
//
// Quality-gate remediation (code-reviewer/ui-architect, Medium): `20cqw` needs this root itself
// to be the query container (`[container-type:size]`), not the window, matching ChatPane.tsx's
// own transcript container (research.md decision 8) -- missing it here sized the mark off the
// WHOLE window instead of this box. `isolate` plus the mark's own `-z-10` (BrandWatermark.tsx)
// then keeps the absolutely-positioned mark painting BEHIND this normal-flow text instead of
// over it: `isolate` is what creates the stacking context here (`container-type` does not, it
// only applies style and size containment).
import { BrandWatermark } from './BrandWatermark'
import { HolidayAmbientLoop } from '../holidays/HolidayAmbientLoop'
import { HolidayEmptyStateLine } from '../holidays/HolidayEmptyStateLine'

export function EmptyChatState() {
  return (
    <div
      data-chat-empty-state
      role="region"
      aria-label="Chat"
      tabIndex={-1}
      className="relative isolate flex flex-col h-full items-center justify-center text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [container-type:size]"
    >
      <BrandWatermark variant="live" />
      <HolidayAmbientLoop />
      <span>Select a Session or create one.</span>
      <HolidayEmptyStateLine className="text-xs" />
    </div>
  )
}
