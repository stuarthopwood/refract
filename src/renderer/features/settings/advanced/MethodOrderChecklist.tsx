// The compaction method order as a reorderable checklist (Settings > Advanced): a checkbox per
// method OMP knows, and move up / move down buttons for the ticked ones (no drag-only path). The
// ticked methods in list order are the saved value; unticked ones sit below.
import { useRef, useState } from 'react'
import { ArrowDownIcon, ArrowUpIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CHECKBOX_BOX_CLASS, CHECKBOX_LIST_ITEM_CLASS, CheckboxIndicator, CheckboxItem } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { COMPACTION_METHODS } from '../../../../shared/tokenGuard'

interface MethodOrderChecklistProps {
  id: string
  value: string[]
  disabled?: boolean
  describedBy?: string
  onChange: (value: string[]) => Promise<boolean>
}

const labelOf = (method: string): string => COMPACTION_METHODS.find((m) => m.value === method)?.label ?? method

export function MethodOrderChecklist({ id, value, disabled, describedBy, onChange }: MethodOrderChecklistProps) {
  const [announcement, setAnnouncement] = useState('')
  const focusTarget = useRef<string | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const unticked = COMPACTION_METHODS.map((m) => m.value).filter((m) => !value.includes(m))
  const all = [...value, ...unticked]

  const save = (next: string[]): void => {
    void onChange(next).then((ok) => {
      setSaveFailed(!ok)
      const target = focusTarget.current
      focusTarget.current = null
      // Wait a frame so the re-rendered buttons have their new disabled state before focus moves.
      if (ok && target) requestAnimationFrame(() => document.getElementById(target)?.focus())
    })
  }

  const move = (method: string, delta: -1 | 1): void => {
    const to = value.indexOf(method) + delta
    const next = value.filter((m) => m !== method)
    next.splice(to, 0, method)
    setAnnouncement(`${labelOf(method)} moved to position ${to + 1} of ${value.length}`)
    // At an end the pressed button is now disabled, so focus follows to the opposite one.
    const atEnd = delta === -1 ? to === 0 : to === value.length - 1
    const direction = atEnd ? (delta === -1 ? 'down' : 'up') : delta === -1 ? 'up' : 'down'
    focusTarget.current = `${id}-${method}-${direction}`
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

  const moveButton = (method: string, direction: 'up' | 'down', isDisabled: boolean) => {
    const Icon = direction === 'up' ? ArrowUpIcon : ArrowDownIcon
    const name = `Move ${labelOf(method)} ${direction}`
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button
              id={`${id}-${method}-${direction}`}
              variant="ghost"
              size="icon-sm"
              disabled={disabled || isDisabled}
              aria-label={name}
              aria-describedby={describedBy}
              onClick={() => move(method, direction === 'up' ? -1 : 1)}
            >
              <Icon aria-hidden />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{name}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <div className="flex w-full flex-col gap-1">
      <div role="group" aria-labelledby={`${id}-label`} aria-describedby={describedBy}>
        <ul className="flex flex-col gap-1">
          {all.map((method) => {
            const index = value.indexOf(method)
            const ticked = index >= 0
            const description = COMPACTION_METHODS.find((m) => m.value === method)?.description
            const descriptionId = `${id}-${method}-description`
            return (
              <li key={method} className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <CheckboxItem
                    id={`${id}-${method}`}
                    checked={ticked}
                    disabled={disabled}
                    aria-describedby={[describedBy, description ? descriptionId : undefined].filter(Boolean).join(' ') || undefined}
                    onCheckedChange={(state) => toggle(method, state === true)}
                    className={`w-32 ${CHECKBOX_LIST_ITEM_CLASS}`}
                  >
                    <span aria-hidden className={CHECKBOX_BOX_CLASS}>
                      <CheckboxIndicator />
                    </span>
                    {labelOf(method)}
                  </CheckboxItem>
                  <span aria-hidden className="w-4 text-xs text-muted-foreground">
                    {ticked ? index + 1 : ''}
                  </span>
                  {moveButton(method, 'up', !ticked || index === 0)}
                  {moveButton(method, 'down', !ticked || index === value.length - 1)}
                </div>
                {description && (
                  <span id={descriptionId} className="pl-6 text-xs text-muted-foreground">
                    {description}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      </div>
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