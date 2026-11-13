// The layers of one stack, bottom first (#1867, FR-008): every other layer is a link, the current
// one is plain text. Status carries an icon plus a word, never colour alone (FR-030).
import type { ComponentType } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface StackLayerItem {
  number: number
  /** `null` when the layer is not in the loaded list, so only its number shows. */
  title: string | null
  status: { label: string; icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>; colorClass: string }
  current: boolean
}

interface StackLayersProps {
  layers: readonly StackLayerItem[]
  onOpen(number: number): void
  className?: string
}

export function StackLayers({ layers, onOpen, className }: StackLayersProps) {
  return (
    <ol aria-label="Layers in this stack" data-stack-layers className={cn('flex flex-col gap-1 text-xs', className)}>
      {layers.map((layer) => {
        const Icon = layer.status.icon
        const label = layer.title ? `#${layer.number} ${layer.title}` : `#${layer.number}`
        return (
          <li key={layer.number} className="flex min-w-0 items-center gap-2" data-stack-layer={layer.number}>
            <span className={cn('flex shrink-0 items-center gap-1', layer.status.colorClass)}>
              <Icon aria-hidden className="size-4" />
              {layer.status.label}
            </span>
            {layer.current ? (
              <span aria-current="true" className="min-w-0 truncate font-medium">
                {label}
                <span className="sr-only"> (this pull request)</span>
              </span>
            ) : (
              <Button variant="text" size="xs" className="min-w-0 justify-start truncate px-0" onClick={() => onOpen(layer.number)}>
                {label}
              </Button>
            )}
          </li>
        )
      })}
    </ol>
  )
}
