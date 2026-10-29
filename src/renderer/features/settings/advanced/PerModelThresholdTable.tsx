// Per-model compaction thresholds as a small table (Settings > Advanced): model picker, token
// count, remove, and an "Add model" button. A new row is a local draft until a model is picked,
// because a threshold without a model is not a valid value.
import { useEffect, useState } from 'react'
import { Trash2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useModelRolesStore } from '@/state'
import { NumberUnitField } from './NumberUnitField'

interface PerModelThresholdTableProps {
  id: string
  value: Record<string, number>
  /** Token count a newly added model starts with. */
  fallbackTokens: number
  onChange: (value: Record<string, number>) => Promise<boolean>
}

export function PerModelThresholdTable({ id, value, fallbackTokens, onChange }: PerModelThresholdTableProps) {
  const catalog = useModelRolesStore((state) => state.catalogs.chat)
  const loadCatalog = useModelRolesStore((state) => state.loadCatalog)
  const [drafts, setDrafts] = useState<number[]>([])
  const [nextDraft, setNextDraft] = useState(0)
  const [saveFailed, setSaveFailed] = useState(false)
  const models = Object.keys(value)

  useEffect(() => {
    void loadCatalog('chat')
  }, [loadCatalog])

  const save = (next: Record<string, number>): Promise<boolean> =>
    onChange(next).then((ok) => {
      setSaveFailed(!ok)
      return ok
    })

  const options = (current?: string): { selector: string; name: string }[] => {
    const known = (catalog ?? []).map((entry) => ({ selector: entry.selector, name: entry.name }))
    const extra = current && !known.some((o) => o.selector === current) ? [{ selector: current, name: current }] : []
    return [...extra, ...known].filter((o) => o.selector === current || !(o.selector in value))
  }

  const picker = (rowId: string, label: string, current: string | undefined, onPick: (selector: string) => void) => (
    <Select value={current ?? ''} onValueChange={onPick}>
      <SelectTrigger id={rowId} aria-label={label} className="w-64">
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

  const addDraft = (): void => {
    setDrafts((current) => [...current, nextDraft])
    setNextDraft((n) => n + 1)
  }

  return (
    <div className="flex w-full flex-col gap-2" aria-describedby={`${id}-description`}>
      {(models.length > 0 || drafts.length > 0) && (
        <table className="w-full text-sm">
          <caption className="sr-only">Compaction threshold per model</caption>
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
                <td className="py-1 pr-2">
                  {picker(`${id}-model-${index}`, `Model ${index + 1}`, model, (selector) => {
                    const next: Record<string, number> = {}
                    for (const [key, tokens] of Object.entries(value)) next[key === model ? selector : key] = tokens
                    void save(next)
                  })}
                </td>
                <td className="py-1 pr-2">
                  <NumberUnitField
                    id={`${id}-tokens-${index}`}
                    value={value[model] ?? 0}
                    unit="tokens"
                    ariaLabel={`Threshold for ${model}`}
                    onCommit={(tokens) => save({ ...value, [model]: tokens })}
                  />
                </td>
                <td className="py-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${model}`}
                    onClick={() => {
                      const { [model]: _removed, ...rest } = value
                      void save(rest)
                    }}
                  >
                    <Trash2Icon aria-hidden />
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
            {drafts.map((draft, index) => (
              <tr key={`draft-${draft}`}>
                <td className="py-1 pr-2">
                  {picker(`${id}-draft-${draft}`, `New model ${models.length + index + 1}`, undefined, (selector) => {
                    void save({ ...value, [selector]: fallbackTokens }).then((ok) => {
                      if (ok) setDrafts((current) => current.filter((d) => d !== draft))
                    })
                  })}
                </td>
                <td className="py-1 pr-2 text-xs text-muted-foreground">Choose a model first</td>
                <td className="py-1">
                  <Button variant="ghost" size="sm" onClick={() => setDrafts((current) => current.filter((d) => d !== draft))}>
                    <Trash2Icon aria-hidden />
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {saveFailed && (
        <span role="alert" className="text-xs text-destructive">
          Could not save this value. Try again.
        </span>
      )}
      <div>
        <Button variant="outline" size="sm" onClick={addDraft}>
          Add model
        </Button>
      </div>
    </div>
  )
}
