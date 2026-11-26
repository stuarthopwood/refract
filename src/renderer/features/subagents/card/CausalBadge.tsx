import { CornerDownRightIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

/** The one phrase for every trigger: the view-model only knows which agent named another, not whether it fixes or verifies. */
export function causalBadgeText(triggeredBy: string | undefined): string | null {
  const names = triggeredBy?.trim()
  return names ? `fixes issue from ${names}` : null
}

// Sits on the file chips' row so provenance costs no extra vertical space; absent when the trigger is unknown.
export function CausalBadge({ triggeredBy }: { triggeredBy: string | undefined }) {
  const text = causalBadgeText(triggeredBy)
  if (text == null) return null
  return (
    <Badge variant="outline" title={text} className="min-w-0 max-w-full text-muted-foreground">
      <CornerDownRightIcon aria-hidden />
      <span className="truncate">{text}</span>
    </Badge>
  )
}
