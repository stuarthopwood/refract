// The Model popover's "Models" listbox group -- extracted from `ModelPicker.tsx` (gate round 6,
// issue #806's 600-line cap: this round's Retry-row rebuild pushed that file to 647 lines). Pure
// presentational: all keyboard/selection state (`activeIndex`, `retrying`, `pendingLabel`, the
// `open` popover state) lives in `ModelPicker.tsx`; this component only renders what it is given
// and reports hover/click back up through callbacks, exactly like `SlashMenu.tsx`'s own split
// between state and rows elsewhere in this app.
//
// Gate round 5 fix (Flow Medium #7, #8): the catalog's three real states -- loading, loaded-but-
// empty, filtered-to-no-match -- render distinct text instead of one "Loading models…" row
// covering the first two; a cached error forces a reload on every open (`ModelPicker.tsx`'s own
// effect) AND offers this row's own immediate Retry, independent of reopening the popover.
//
// Gate round 6 fix (`agent://G564Code`/`agent://G564A11y` Low, `agent://Arch877` Medium 1): Retry
// is no longer a `<button>` nested inside `role="option"` (an invalid combination a screen reader
// may not expose at all, and which Tab/arrow-keys could never reach anyway) -- the row itself IS
// the option now (`ModelPicker.tsx`'s own `activatableIndices` includes it), so Enter and a
// direct click both retry without ever closing the popover; a local `retrying` flag (owned by the
// parent) shows "Retrying…" with a spinner and blocks a second concurrent call.
//
// Gate round 7 fix (`agent://Arch877` Medium 2, Flow/Layout Low): the error text now wraps
// (`whitespace-normal break-words`, was `truncate`, cutting any real error to about 33 visible
// characters in this 288px-wide popover) -- the stale "Reopening this menu also retries." hint
// is gone too, since the row itself is now directly Enter/click-activatable, not just reachable
// by closing and reopening the menu. The row also gets its OWN id (`retryOptionId`, passed down
// rather than derived from `optionId`) so a successful retry's `aria-activedescendant` never
// reuses an id that belonged to the now-gone error row.
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
            // Gate round 7 fix (`agent://Arch877` Medium 2): `items-start` (was the row's own
            // `items-center`) so a wrapped multi-line error doesn't centre the Retry label
            // against only its first line.
            'items-start justify-between gap-2',
            indexOffset === clampedActiveIndex && PICKER_OPTION_ACTIVE_CLASS,
            retrying && 'cursor-not-allowed opacity-60'
          )}
        >
          {/* Gate round 7 fix (`agent://Arch877` Medium 2): `whitespace-normal break-words` (was
              `truncate`) -- a real error cut to about 33 visible characters in this 288px popover
              hid the diagnostic from every sighted user; the stale "Reopening this menu also
              retries." hint is gone, since the row is now directly Enter/click-activatable, not
              just reachable by closing and reopening the menu. */}
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
          // Gate round 1 fix (MEDIUM, code-reviewer): compares identity (`provider` + `id`),
          // never the display label -- the old `modelLabel === \`${provider}/${name}\``
          // comparison missed a Session whose `lastModel.name` is absent and double-ticked any
          // two entries sharing a name.
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
                {/* Gate round 6 fix (`agent://Arch877` Visual N6): `text-xs`, matching the Roles
                    group's own secondary text size (was unset, inheriting the row's `text-sm`). */}
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
