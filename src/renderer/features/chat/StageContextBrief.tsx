// Issue #941 grill item 4: a Stage's own captured batch context, rendered Markdown, visually
// capped to about 6 lines behind the shared ClampedContent (#1262): the toggle shows only when
// the content genuinely overflows, and a focusable descendant past the fade is pulled out of the
// Tab order while collapsed (the visible text is never inert). The label-column indent is the
// CALLER's own choice (`className`), never hardcoded here -- a one-agent Stage's
// `CollapsibleContent` already supplies it.
import { ClampedContent } from '@/components/ClampedContent'
import { Markdown } from './Markdown'

export function StageContextBrief({ id, context, className }: { id: string; context: string; className?: string }) {
  return (
    <ClampedContent
      maxHeight="9rem"
      fade
      pastCutFocus="skip-tab"
      collapsedLabel={(more) => `Show full brief (${more} more line${more === 1 ? '' : 's'})`}
      className={className}
    >
      <Markdown id={id} text={context} className="text-xs text-muted-foreground [&_*:last-child]:mb-0" />
    </ClampedContent>
  )
}
