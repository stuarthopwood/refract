// Shared token-impact warning: icon plus sentence so meaning never rests on colour alone (ADR 0003).
// The polite live region stays mounted so a warning that appears is announced; controls point
// `aria-describedby` at `id` (present only while warned) so it is read after the row description.
import { TriangleAlertIcon } from 'lucide-react'

interface ImpactWarningProps {
  id: string
  text: string
  /** Whether the value is costlier than the default. */
  active: boolean
}

export function ImpactWarning({ id, text, active }: ImpactWarningProps) {
  return (
    // `empty:-mt-1` cancels the parent's flex gap while there is nothing to show.
    <div role="status" className="empty:-mt-1">
      {active && (
        <span id={id} className="flex items-start gap-1 text-xs text-severity-warning">
          <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
          <span>{text}</span>
        </span>
      )}
    </div>
  )
}
