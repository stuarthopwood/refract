// The compaction method order as a reorderable checklist (Settings > Advanced): a checkbox per
// method OMP knows, and move up / move down buttons for the ticked ones (no drag-only path). The
// ticked methods in list order are the saved value; unticked ones sit below.
import { useEffect, useState } from 'react'
import { ArrowDownIcon, ArrowUpIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CheckboxIndicator, CheckboxItem } from '@/components/ui/checkbox'
import { COMPACTION_METHODS } from '../../../../shared/tokenGuard'

interface MethodOrderChecklistProps {
  id: string
  value: string[]
  onChange: (value: string[]) => Promise<boolean>
}

const labelOf = (method: string): string => COMPACTION_METHODS.find((m) => m.value === method)?.label ?? method

export function MethodOrderChecklist({ id, value, onChange }: MethodOrderChecklistProps) {
  const [announcement, setAnnouncement] = useState('')
  const [focusTarget, setFocusTarget] = useState<string | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const unticked = COMPACTION_METHODS.map((m) => m.value).filter((m) => !value.includes(m))
  const all = [...value, ...unticked]
  const valueKey = value.join(',')

  useEffect(() => {
    if (focusTarget) document.getElementById(focusTarget)?.focus()
  }, [focusTarget, valueKey])

  const save = (next: string[]): void => {
    void onChange(next).then((ok) => setSaveFailed(!ok))
  }

  const move = (method: string, delta: -1 | 1): void => {
    const to = value.indexOf(method) + delta
    const next = value.filter((m) => m !== method)
    next.splice(to, 0, method)
    setAnnouncement(`${labelOf(method)} moved to position ${to + 1} of ${value.length}`)
    // At an end the pressed button is now disabled, so focus follows to the opposite one.
    const atEnd = delta === -1 ? to === 0 : to === value.length - 1
    const direction = atEnd ? (delta === -1 ? 'down' : 'up') : delta === -1 ? 'up' : 'down'
    setFocusTarget(`${id}-${method}-${direction}`)
    save(next)
  }

  const toggle = (method: string, ticked: boolean): void => {
    if (!ticked && value.length === 1) {
      setAnnouncement('At least one compaction method must stay on')
      return
    }
    setAnnouncement(ticked ? `${labelOf(method)} added at position ${value.length + 1}` : `${labelOf(method)} removed`)
    save(ticked ? [...value, method] : value.filter((m) => m !== method))
  }

  return (
    <div className="flex w-full flex-col gap-1">
      <ul role="group" aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`} className="flex flex-col gap-1">
        {all.map((method) => {
          const index = value.indexOf(method)
          const ticked = index >= 0
          return (
            <li key={method} className="flex items-center gap-2">
              <CheckboxItem
                id={`${id}-${method}`}
                checked={ticked}
                onCheckedChange={(state) => toggle(method, state === true)}
                className="min-h-6 w-32 flex-row items-center gap-2 rounded-none border-none bg-transparent px-0 py-0 hover:bg-transparent data-[state=checked]:border-none data-[state=checked]:bg-transparent"
              >
                <span aria-hidden className="grid size-4 shrink-0 place-items-center rounded-sm border border-muted-foreground">
                  <CheckboxIndicator />
                </span>
                {labelOf(method)}
              </CheckboxItem>
              <span aria-hidden className="w-4 text-xs text-muted-foreground">
                {ticked ? index + 1 : ''}
              </span>
              <Button
                id={`${id}-${method}-up`}
                variant="ghost"
                size="icon-sm"
                disabled={!ticked || index === 0}
                aria-label={`Move ${labelOf(method)} up`}
                onClick={() => move(method, -1)}
              >
                <ArrowUpIcon aria-hidden />
              </Button>
              <Button
                id={`${id}-${method}-down`}
                variant="ghost"
                size="icon-sm"
                disabled={!ticked || index === value.length - 1}
                aria-label={`Move ${labelOf(method)} down`}
                onClick={() => move(method, 1)}
              >
                <ArrowDownIcon aria-hidden />
              </Button>
            </li>
          )
        })}
      </ul>
      {saveFailed && (
        <span role="alert" className="text-xs text-destructive">
          Could not save this value. Try again.
        </span>
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </div>
  )
}
