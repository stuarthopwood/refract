// The centred launcher list (spec 013 FR-010, User Story 2): shown with the pane open and no
// panel open -- a list of every available panel, each row a button with its icon, name, and
// (where it has one) its live count. This is a valid, reachable, non-transient state: closing the
// last open panel always lands here (FR-009), it never collapses the pane.
import { cn } from '@/lib/utils'
import { DiffStatCounts } from '../sessions/sessionDisplay'
import { formatPanelCount, usePanelCount, type HostedPanelDescriptor } from './panel-registry'
import { openHostedPanel } from './hosted-panel-actions'
import { useOrderedPanels } from './panel-order'

interface PanelLauncherProps {
  sessionId: string | null
}

export function PanelLauncher({ sessionId }: PanelLauncherProps) {
  const panels = useOrderedPanels()
  return (
    <div className="flex h-full flex-col items-center justify-center overflow-auto p-4">
      <ul data-panel-launcher className="flex w-full max-w-xs flex-col gap-1" aria-label="Available panels">
        {panels.map((panel) => (
          <li key={panel.id}>
            <LauncherRow panel={panel} sessionId={sessionId} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function LauncherRow({ panel, sessionId }: { panel: HostedPanelDescriptor; sessionId: string | null }) {
  const count = usePanelCount(panel.id, sessionId)
  const Icon = panel.icon
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-foreground hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      onClick={(event) => openHostedPanel(panel.id, sessionId, { opener: event.currentTarget })}
    >
      <Icon aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{panel.name}</span>
      {count && (
        <span className={cn('shrink-0 text-xs', count.kind === 'running' ? 'text-state-working' : undefined)}>
          {count.kind === 'additions-deletions' ? (
            <DiffStatCounts added={count.additions} removed={count.deletions} accessibleLabel />
          ) : (
            formatPanelCount(count)
          )}
        </span>
      )}
    </button>
  )
}
