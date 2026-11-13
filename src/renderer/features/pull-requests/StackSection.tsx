// The detail header's stack block (#1867, FR-008): position badge plus a link to every layer.
import { StackBadge } from '@/components/StackBadge'
import { StackLayers } from '@/components/StackLayers'
import { usePullRequestsStore, useViewStore } from '@/state'
import type { StackPosition } from '../../../shared/stack-chain'
import { PULL_REQUEST_STATE_DISPLAY } from './PullRequestRow'
import { stackLayerViews } from './stack-view'

interface StackSectionProps {
  repositoryId: string
  number: number
  position: StackPosition
}

export function StackSection({ repositoryId, number, position }: StackSectionProps) {
  const items = usePullRequestsStore((s) => s.items)
  const layers = stackLayerViews(position, number, (layerNumber) =>
    items.find((item) => item.repositoryId === repositoryId && item.number === layerNumber)
  ).map((layer) => ({ ...layer, status: PULL_REQUEST_STATE_DISPLAY[layer.state] }))
  return (
    <div className="mt-2 flex flex-col gap-1">
      <StackBadge position={position.position} total={position.total} />
      <StackLayers
        layers={layers}
        onOpen={(layerNumber) => {
          usePullRequestsStore.getState().select({ repositoryId, number: layerNumber })
          useViewStore.getState().openPullRequests()
        }}
      />
    </div>
  )
}
