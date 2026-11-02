import type { LucideIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { ValueCrossfade } from '@/components/ValueCrossfade'
import { cn } from '@/lib/utils'
import { PICKER_TRIGGER_CLASS } from '../features/chat/pickerShared'

export interface ModePillItem<T extends string> {
  value: T
  label: string
  hint: string
  icon: LucideIcon
}

interface ModePillProps<T extends string> {
  scope: string
  /** Names the control for assistive tech, e.g. "approval mode". */
  noun: string
  items: ModePillItem<T>[]
  value: T
  /** Text for a queued switch, e.g. "Plan mode after this turn". */
  pendingLabel?: string | null
  onSelect: (value: T) => void
  className?: string
}

/** Single-choice composer pill with an icon, a label and a hint per item; used by the approval and working-mode pickers. */
export function ModePill<T extends string>({ scope, noun, items, value, pendingLabel, onSelect, className }: ModePillProps<T>) {
  const current = items.find((item) => item.value === value) ?? items[0]!
  const CurrentIcon = current.icon
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={`${current.label}, ${noun}${pendingLabel ? `. ${pendingLabel}` : ''}`}
          className={cn(PICKER_TRIGGER_CLASS, className)}
        >
          <CurrentIcon aria-hidden className="size-4" />
          <ValueCrossfade scope={scope} value={current.label} />
          {pendingLabel && <span className="text-muted-foreground">&middot; {pendingLabel}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onSelect(next as T)}>
          {items.map((item) => (
            <DropdownMenuRadioItem key={item.value} value={item.value} icon={item.icon}>
              <div className="flex flex-col gap-1 py-1">
                <span>{item.label}</span>
                <span className="text-xs text-muted-foreground">{item.hint}</span>
              </div>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
