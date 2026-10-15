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
// parent) shows "Retrying…" with a spinner and blocks a second concurrent call; the text itself
// says reopening the menu also retries, for the one path that still only works by mouse today.
import { CheckIcon, Loader2Icon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ModelCatalogEntry } from '../../../shared/model'
import { PICKER_OPTION_ACTIVE_CLASS, PICKER_OPTION_CLASS } from './pickerShared'

export function ModelCatalogGroup({
  modelsHeadingId,
  roleCount,
  catalogError,
  catalog,
  filteredCatalog,
  clampedActiveIndex,
  optionId,
  retrying,
  currentModel,
  onHoverIndex,
  onRetry,
  onSelectModel
}: {
  modelsHeadingId: string
  roleCount: number
  catalogError: string | undefined
  catalog: ModelCatalogEntry[] | undefined
  filteredCatalog: ModelCatalogEntry[]
  clampedActiveIndex: number | null
  optionId: (index: number) => string
  retrying: boolean
  currentModel: { provider: string; id: string } | null
  onHoverIndex: (index: number) => void
  onRetry: () => void
  onSelectModel: (entry: ModelCatalogEntry) => void
}) {
  return (
    <div role="group" aria-labelledby={modelsHeadingId}>
      <div id={modelsHeadingId} role="presentation" className="px-2 py-1 text-xs font-medium text-muted-foreground">
        Models
      </div>
      {catalogError && (
        <div
          id={optionId(roleCount)}
          role="option"
          aria-disabled={retrying || undefined}
          data-active={roleCount === clampedActiveIndex}
          onMouseEnter={() => {
            if (!retrying) onHoverIndex(roleCount)
          }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            if (event.button !== 0) return
            if (retrying) return
            onRetry()
          }}
          className={cn(
            PICKER_OPTION_CLASS,
            'justify-between',
            roleCount === clampedActiveIndex && PICKER_OPTION_ACTIVE_CLASS,
            retrying && 'cursor-not-allowed opacity-60'
          )}
        >
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {catalogError} Reopening this menu also retries.
          </span>
          <span className="flex shrink-0 items-center gap-1 text-xs font-medium">
            {retrying && <Loader2Icon aria-hidden className="size-3 animate-spin" />}
            {retrying ? 'Retrying…' : 'Retry'}
          </span>
        </div>
      )}
      {!catalogError && catalog === undefined && (
        <div role="option" aria-disabled className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
          <Loader2Icon aria-hidden className="size-3.5 shrink-0 animate-spin" />
          Loading models…
        </div>
      )}
      {!catalogError && catalog !== undefined && catalog.length === 0 && (
        <div role="option" aria-disabled className="px-2 py-1.5 text-sm text-muted-foreground">
          No models available. Check the agent's own model configuration.
        </div>
      )}
      {!catalogError && catalog !== undefined && catalog.length > 0 && filteredCatalog.length === 0 && (
        <div role="option" aria-disabled className="px-2 py-1.5 text-sm text-muted-foreground">
          No models match.
        </div>
      )}
      {!catalogError &&
        filteredCatalog.map((entry, modelIndex) => {
          const flatIndex = roleCount + modelIndex
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
              <span className="min-w-0 flex-1 truncate">
                {/* Gate round 6 fix (`agent://Arch877` Visual N6): `text-xs`, matching the Roles
                    group's own secondary text size (was unset, inheriting the row's `text-sm`). */}
                {entry.name} <span className="text-xs text-muted-foreground">{entry.provider}</span>
              </span>
              {checked && <CheckIcon aria-hidden className="size-3.5 shrink-0" />}
            </div>
          )
        })}
    </div>
  )
}
