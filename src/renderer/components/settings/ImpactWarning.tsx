// Shared token-impact warning: icon plus sentence so meaning never rests on colour alone (ADR 0003).
// Controls point `aria-describedby` at `id` so it is read after the row description.
import { TriangleAlertIcon } from 'lucide-react'

interface ImpactWarningProps {
  id: string
  text: string
}

export function ImpactWarning({ id, text }: ImpactWarningProps) {
  return (
    <span id={id} className="flex items-start gap-1 text-xs text-severity-warning">
      <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
      <span>{text}</span>
    </span>
  )
}
