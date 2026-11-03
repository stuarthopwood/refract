// Per-model compaction thresholds as a small table (Settings > Advanced): model picker, percent of
// that model's context window, remove, and an "Add model" button. A new row is a local draft until
// a model is picked, because a threshold without a model is not a valid value.
import { useEffect, useState } from 'react'
import { ChevronRightIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { ImpactWarning } from '@/components/settings/ImpactWarning'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useModelRolesStore } from '@/state'
import { parsePercent } from '../../../../shared/tokenGuard'
import type { TokenGuardImpact } from '../../../../shared/tokenGuard'
import { MAX_PERCENT, MIN_PERCENT, percentToTokens, windowFor } from './contextWindow'
import { formatCount, NumberUnitField, WINDOW_UNKNOWN_HINT } from './NumberUnitField'

interface PerModelThresholdTableProps {
  id: string
  /** Model selector to `"N%"`. */
  value: Record<string, string>
  /** Warns on a row whose percent is above the global threshold (`seedPercent`). */
  impact?: TokenGuardImpact
  /** Percent a newly added model starts with: the global threshold. */
  seedPercent: number
  disabled?: boolean
  describedBy?: string
  /** Whether the table is expanded; owned by the row so its summary warning is only described while closed. */
  open: boolean
  onOpenChange: (open: boolean) => void
  onChange: (value: Record<string, string>) => Promise<boolean>
}

export function PerModelThresholdTable({ id, value, impact, seedPercent, disabled, describedBy, open, onOpenChange, onChange }: PerModelThresholdTableProps) {
  const catalog = useModelRolesStore((state) => state.catalogs.chat)
  const loadCatalog = useModelRolesStore((state) => state.loadCatalog)
  const [drafts, setDrafts] = useState<number[]>([])
  const [nextDraft, setNextDraft] = useState(0)
  const [saveFailed, setSaveFailed] = useState(false)
  const models = Object.keys(value)
  const addId = `${id}-add`

  useEffect(() => {
    void loadCatalog('chat')
  }, [loadCatalog])

  const save = (next: Record<string, string>): Promise<boolean> =>
    onChange(next).then((ok) => {
      setSaveFailed(!ok)
      return ok
    })

  const focusLater = (target: string): void => {
    requestAnimationFrame(() => document.getElementById(target)?.focus())
  }

  const options = (current?: string): { selector: string; name: string }[] => {
    const known = (catalog ?? []).map((entry) => ({ selector: entry.selector, name: entry.name }))
    const extra = current && !known.some((o) => o.selector === current) ? [{ selector: current, name: current }] : []
    return [...extra, ...known].filter((o) => o.selector === current || !(o.selector in value))
  }

  const picker = (rowId: string, label: string, current: string | undefined, onPick: (selector: string) => void) => (
    <Select value={current ?? ''} onValueChange={onPick} disabled={disabled}>
      <SelectTrigger id={rowId} aria-label={label} aria-describedby={describedBy} className="w-64 max-w-full">
        <SelectValue placeholder="Choose a model" />
      </SelectTrigger>
      <SelectContent>
        {options(current).map((option) => (
          <SelectItem key={option.selector} value={option.selector}>
            {option.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  const removeButton = (name: string, onRemove: () => void) => (
    <div className="flex h-8 items-center">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" disabled={disabled} aria-label={name} aria-describedby={describedBy} onClick={onRemove}>
            <Trash2Icon aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{name}</TooltipContent>
      </Tooltip>
    </div>
  )

  const addDraft = (): void => {
    setDrafts((current) => [...current, nextDraft])
    setNextDraft((n) => n + 1)
    onOpenChange(true)
  }

  const summary = models.length === 1 ? '1 model' : `${models.length} models`
  const showTable = models.length > 0 || drafts.length > 0

  const costlier = (model: string): boolean => impact?.costlierWhen(value[model], `${seedPercent}%`) === true
  const summaryCostlier = models.some(costlier)

  const thresholdHint = (model: string, percent: number): string | undefined => {
    const size = windowFor(catalog, model)
    return size === null
      ? WINDOW_UNKNOWN_HINT
      : `≈ ${formatCount(percentToTokens(percent, size))} of ${formatCount(size)} tokens`
  }

  return (
    <Collapsible open={open || drafts.length > 0} onOpenChange={onOpenChange} className="flex w-full flex-col gap-2">
      {showTable && (
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="group/trigger self-start" aria-describedby={describedBy} disabled={disabled || drafts.length > 0}>
            <ChevronRightIcon aria-hidden className="transition-transform group-aria-expanded/trigger:rotate-90" />
            {summary}
          </Button>
        </CollapsibleTrigger>
      )}
      {impact && <ImpactWarning id={`${id}-impact`} text={impact.text} active={summaryCostlier && !open} />}
      <CollapsibleContent>
        <div className="overflow-x-auto">
          <table className="w-full table-fixed text-sm">
            <caption className="sr-only">Compaction threshold per model</caption>
            <colgroup>
              <col className="w-64" />
              <col />
              <col className="w-10" />
            </colgroup>
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th scope="col" className="py-1 pr-2 font-normal">
                  Model
                </th>
                <th scope="col" className="py-1 pr-2 font-normal">
                  Threshold
                </th>
                <th scope="col" className="py-1 font-normal">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {models.map((model, index) => (
                <tr key={model}>
                  <td className="py-1 pr-2 align-top">
                    {picker(`${id}-model-${index}`, `Model ${index + 1}`, model, (selector) => {
                      const next: Record<string, string> = {}
                      for (const [key, percent] of Object.entries(value)) next[key === model ? selector : key] = percent
                      void save(next)
                    })}
                  </td>
                  <td className="py-1 pr-2 align-top">
                    <div className="flex flex-col gap-1">
                      <NumberUnitField
                        id={`${id}-percent-${index}`}
                        value={parsePercent(value[model])}
                        unit="%"
                        min={MIN_PERCENT}
                        max={MAX_PERCENT}
                        hint={thresholdHint(model, parsePercent(value[model]))}
                        ariaLabel={`Threshold for ${model}`}
                        describedBy={costlier(model) ? `${describedBy ?? ''} ${id}-impact-${index}`.trim() : describedBy}
                        disabled={disabled}
                        onCommit={(percent) => save({ ...value, [model]: `${percent}%` })}
                      />
                      {impact && <ImpactWarning id={`${id}-impact-${index}`} text={impact.text} active={costlier(model)} />}
                    </div>
                  </td>
                  <td className="py-1 align-top">
                    {removeButton(`Remove ${model}`, () => {
                      const { [model]: _removed, ...rest } = value
                      void save(rest).then((ok) => {
                        if (!ok) return
                        // The next row slides into this index; with none left, focus goes to "Add model".
                        focusLater(index < models.length - 1 ? `${id}-model-${index}` : drafts.length > 0 ? `${id}-draft-${drafts[0]}` : addId)
                      })
                    })}
                  </td>
                </tr>
              ))}
              {drafts.map((draft, index) => (
                <tr key={`draft-${draft}`}>
                  <td className="py-1 pr-2 align-top">
                    {picker(`${id}-draft-${draft}`, `New model ${models.length + index + 1}`, undefined, (selector) => {
                      void save({ ...value, [selector]: `${seedPercent}%` }).then((ok) => {
                        if (ok) setDrafts((current) => current.filter((d) => d !== draft))
                      })
                    })}
                  </td>
                  <td className="py-1 pr-2 align-top text-xs text-muted-foreground">
                    <div className="flex h-8 items-center">Choose a model first</div>
                  </td>
                  <td className="py-1 align-top">
                    {removeButton('Remove new model row', () => {
                      setDrafts((current) => current.filter((d) => d !== draft))
                      const nextDraftId = drafts[index + 1]
                      focusLater(nextDraftId !== undefined ? `${id}-draft-${nextDraftId}` : addId)
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CollapsibleContent>
      {saveFailed && (
        <span role="alert" className="text-xs text-destructive">
          Could not save this value. Try again.
        </span>
      )}
      <div>
        <Button id={addId} variant="outline" size="sm" disabled={disabled} aria-describedby={describedBy} onClick={addDraft}>
          <PlusIcon aria-hidden />
          Add model
        </Button>
      </div>
    </Collapsible>
  )
}