import { Loader2Icon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { RadioMark } from '@/components/ui/radio-group'
import type { ModelCatalogEntry } from '../../../shared/model'
import { PICKER_OPTION_ACTIVE_CLASS, PICKER_OPTION_CLASS } from './pickerShared'

export function ModelCatalogGroup({
  modelsHeadingId,
  indexOffset,
  catalogError,
  catalog,
  filteredCatalog,
  clampedActiveIndex,
  optionId,
  retryOptionId,
  retrying,
  currentModel,
  nextModel,
  onHoverIndex,
  onRetry,
  onSelectModel
}: {
  modelsHeadingId: string
  indexOffset: number
  catalogError: string | undefined
  catalog: ModelCatalogEntry[] | undefined
  filteredCatalog: ModelCatalogEntry[]
  clampedActiveIndex: number | null
  optionId: (index: number) => string
  retryOptionId: string
  retrying: boolean
  currentModel: { provider: string; id: string } | null
  nextModel: { provider: string; modelId: string } | null
  onHoverIndex: (index: number) => void
  onRetry: () => void
  onSelectModel: (entry: ModelCatalogEntry) => void
}) {
  return (
    <div role="group" aria-labelledby={modelsHeadingId}>
      <div id={modelsHeadingId} role="presentation" className="px-2 py-1 text-xs text-muted-foreground">
        Models
      </div>
      {catalogError && (
        <div
          id={retryOptionId}
          role="option"
          aria-disabled={retrying || undefined}
          data-active={indexOffset === clampedActiveIndex}
          onMouseEnter={() => {
            if (!retrying) onHoverIndex(indexOffset)
          }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            if (event.button !== 0) return
            if (retrying) return
            onRetry()
          }}
          className={cn(
            PICKER_OPTION_CLASS,
            'items-start justify-between gap-2',
            indexOffset === clampedActiveIndex && PICKER_OPTION_ACTIVE_CLASS,
            retrying && 'cursor-not-allowed opacity-60'
          )}
        >
          <span className="min-w-0 flex-1 whitespace-normal break-words text-muted-foreground">{catalogError}</span>
          <span className="flex shrink-0 items-center gap-1 text-xs">
            {retrying && <Loader2Icon aria-hidden className="size-4 animate-spin" />}
            {retrying ? 'Retrying…' : 'Retry'}
          </span>
        </div>
      )}
      {!catalogError && catalog === undefined && (
        <div role="option" aria-disabled className="flex items-center gap-2 px-2 py-1 text-sm text-muted-foreground">
          <Loader2Icon aria-hidden className="size-4 shrink-0 animate-spin" />
          Loading models…
        </div>
      )}
      {!catalogError && catalog !== undefined && catalog.length === 0 && (
        <div role="option" aria-disabled className="px-2 py-1 text-sm text-muted-foreground">
          No models available. Check the agent's own model configuration.
        </div>
      )}
      {!catalogError && catalog !== undefined && catalog.length > 0 && filteredCatalog.length === 0 && (
        <div role="option" aria-disabled className="px-2 py-1 text-sm text-muted-foreground">
          No models match.
        </div>
      )}
      {!catalogError &&
        filteredCatalog.map((entry, modelIndex) => {
          const flatIndex = indexOffset + modelIndex
          const active = flatIndex === clampedActiveIndex
          const checked = Boolean(currentModel && entry.provider === currentModel.provider && entry.id === currentModel.id)
          return (
            <div
              key={entry.selector}
              id={optionId(flatIndex)}
              role="option"
              aria-selected={checked}
              data-active={active}
              onMouseEnter={() => onHoverIndex(flatIndex)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                if (event.button !== 0) return
                onSelectModel(entry)
              }}
              className={cn(PICKER_OPTION_CLASS, active && PICKER_OPTION_ACTIVE_CLASS)}
            >
              <RadioMark checked={checked} />
              <span className="min-w-0 flex-1 truncate">
                {entry.name} <span className="text-xs text-muted-foreground">{entry.provider}</span>
                {checked && <span className="text-xs text-muted-foreground"> current</span>}
                {nextModel && entry.provider === nextModel.provider && entry.id === nextModel.modelId && <span className="text-xs text-muted-foreground"> next</span>}
              </span>
            </div>
          )
        })}
    </div>
  )
}
