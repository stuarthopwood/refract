import { EyeOffIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

// Issue #748: the one "Hidden" marker. The default is a chip (Manage sessions row, chat pane
// header); `compact` is the plain muted label for the dense sidebar row, whose accessible name
// already says "Hidden", so it is decorative there.
export function HiddenMarker({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <span aria-hidden className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <EyeOffIcon className="size-4" />
        Hidden
      </span>
    )
  }
  return (
    <Badge variant="secondary" className="shrink-0">
      <EyeOffIcon aria-hidden className="size-4" />
      Hidden
    </Badge>
  )
}
