// Shared sample-row shape for both placeholder panels' sample-content branch (spec 013 FR-021,
// Code1 gate remediation: the same li + icon + truncated text + "Sample data" badge markup was
// written out twice). Display only, inert (no `onClick`, no role, no `tabIndex`) -- there is
// nothing real behind either panel yet, and a convincingly-clickable dead row would itself read
// as the "disabled control with a reason" pattern FR-019 forbids. `title={text}` recovers the
// full text on mouse hover once `truncate` clips it (WCAG 1.4.10, A11y1 gate Low); assistive
// tech reads the untruncated DOM text regardless.
// `meta`, where given, is a short trailing status word (Agent Builder's "Deployed"/"Draft") shown
// before the badge.
import type { LucideIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

export interface SampleDataRowProps {
  icon: LucideIcon
  text: string
  meta?: string
}

export function SampleDataRow({ icon: Icon, text, meta }: SampleDataRowProps) {
  return (
    <li className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm">
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate" title={text}>
        {text}
      </span>
      {meta && <span className="shrink-0 text-xs text-muted-foreground">{meta}</span>}
      <Badge variant="secondary" className="shrink-0">
        Sample data
      </Badge>
    </li>
  )
}
