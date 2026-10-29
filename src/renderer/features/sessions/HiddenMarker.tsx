import { EyeOffIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

// Issue #748: the one "Hidden" marker, shared by the Manage sessions row and the chat pane header.
export function HiddenMarker() {
  return (
    <Badge variant="secondary" className="shrink-0">
      <EyeOffIcon aria-hidden className="size-4" />
      Hidden
    </Badge>
  )
}
