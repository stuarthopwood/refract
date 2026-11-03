// Catalog loading/error status for ONE catalog kind, rendered once per kind in a group (not once
// per role: ten chat roles share the `chat` kind). Extracted from `ModelRolesSection.tsx`.
import { Loader2Icon, OctagonXIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { CatalogKind, ModelCatalogEntry } from '../../../shared/model'

// Human-readable kind names for error text and labels: the raw ids ("tts", "stt") are spelled
// letter by letter by a screen reader.
export const CATALOG_KIND_LABEL: Record<CatalogKind, string> = {
  chat: 'chat',
  tiny: 'tiny',
  image: 'image',
  tts: 'text-to-speech',
  stt: 'speech-to-text',
  search: 'web search',
  judge: 'judge'
}

interface RoleCatalogStatusProps {
  kind: CatalogKind
  catalog: ModelCatalogEntry[] | undefined
  error: string | undefined
  isRetrying: boolean
  onRetry(kind: CatalogKind): void
}

export function RoleCatalogStatus({ kind, catalog, error, isRetrying, onRetry }: RoleCatalogStatusProps) {
  if (catalog === undefined && !error && !isRetrying) {
    return (
      <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2Icon aria-hidden className="size-4 shrink-0 animate-spin" />
        Loading models…
      </p>
    )
  }
  if (!error) return null
  const kindLabel = CATALOG_KIND_LABEL[kind]
  return (
    <p id={`model-role-catalog-error-${kind}`} className="mt-2 flex items-center gap-2 text-xs text-destructive">
      <span className="flex items-center gap-1">
        <OctagonXIcon aria-hidden className="size-4 shrink-0" />
        Could not load {kindLabel} models: {error}
      </span>
      <Button
        id={`model-role-catalog-retry-${kind}`}
        variant="ghost"
        size="xs"
        className="aria-disabled:opacity-50"
        aria-disabled={isRetrying || undefined}
        // The accessible name follows the in-flight state the same way the visible text does.
        aria-label={isRetrying ? `Retrying ${kindLabel} models` : `Retry loading ${kindLabel} models`}
        onClick={() => onRetry(kind)}
      >
        {isRetrying ? 'Retrying…' : 'Retry'}
      </Button>
    </p>
  )
}
