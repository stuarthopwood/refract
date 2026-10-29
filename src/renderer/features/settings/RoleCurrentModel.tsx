// Spec 035 T7: the current model of one role, shown as text at rest (the dropdown beside it is only
// the "Change" control). Wraps long names rather than clipping them; a comma list shows its first
// entry plus "then N more" with the full value in the tooltip.
import { friendlyProviderLabel } from '@/lib/providerLabels'
import type { RoleCurrent } from './modelRoleCurrent'

const LEVEL_LABEL: Record<string, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  auto: 'Auto',
  inherit: 'Inherit'
}

interface RoleCurrentModelProps {
  id: string
  current: RoleCurrent
  /** False while the catalog is still loading, so an unmatched selector is not yet called unknown. */
  catalogLoaded: boolean
}

export function RoleCurrentModel({ id, current, catalogLoaded }: RoleCurrentModelProps) {
  if (current.status === 'unset') {
    return (
      <span id={id} className="text-sm text-muted-foreground">
        OMP picks one automatically
      </span>
    )
  }
  const thinking = current.thinking ? (LEVEL_LABEL[current.thinking] ?? current.thinking) : null
  return (
    <div id={id} className="flex min-w-0 flex-col gap-1">
      <span className="text-sm break-words">
        {current.name}
        {current.provider && <span className="text-muted-foreground"> · {friendlyProviderLabel(current.provider)}</span>}
      </span>
      {current.status === 'unknown' && catalogLoaded && (
        <span className="text-xs text-muted-foreground">Not in the model list; shown as OMP stores it.</span>
      )}
      {current.via && <span className="text-xs text-muted-foreground">{current.via === 'Default' ? 'Inherits Default' : `Via ${current.via}`}</span>}
      {thinking && <span className="text-xs text-muted-foreground">Thinking: {thinking}</span>}
      {current.fullValue && (
        <span title={current.fullValue} className="text-xs text-muted-foreground">
          then {current.moreCount} more
          <span className="sr-only">: {current.fullValue}</span>
        </span>
      )}
    </div>
  )
}
