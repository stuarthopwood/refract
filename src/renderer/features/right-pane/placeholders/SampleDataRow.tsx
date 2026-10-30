import type { LucideIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

/** Props for {@link SampleDataRow}. */
export interface SampleDataRowProps {
  icon: LucideIcon
  text: string
  meta?: string
}

/** Placeholder row of sample data. */
export function SampleDataRow({ icon: Icon, text, meta }: SampleDataRowProps) {
  return (
    <li className="flex items-center gap-2 rounded-md px-2 py-1 text-sm">
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
