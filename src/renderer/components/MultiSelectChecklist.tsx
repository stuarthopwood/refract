// A popover checklist behind one trigger button (the Issues view's Project filter, #504). The
// trigger shows `summary`; each option is a shared `CheckboxItem` with an optional leading adornment.
import type { ReactNode, Ref } from 'react'
import { ChevronDownIcon } from 'lucide-react'
import { CHECKBOX_BOX_CLASS, CHECKBOX_LIST_ITEM_CLASS, CheckboxIndicator, CheckboxItem } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { POPOVER_PANEL_MIN_WIDTH_CLASS, SELECT_CHEVRON_CLASS, SELECT_ITEM_BOX_CLASS, SELECT_TRIGGER_CLASS } from '@/components/ui/select'
import { cn } from '@/lib/utils'

export interface ChecklistOption {
  value: string
  label: string
  leading?: ReactNode
}

interface MultiSelectChecklistProps {
  /** Accessible name of the trigger and of the checkbox group. */
  label: string
  summary: string
  options: ChecklistOption[]
  selected: string[]
  onChange: (selected: string[]) => void
  className?: string
  triggerRef?: Ref<HTMLButtonElement>
}

export function MultiSelectChecklist({ label, summary, options, selected, onChange, className, triggerRef }: MultiSelectChecklistProps) {
  const toggle = (value: string) =>
    onChange(selected.includes(value) ? selected.filter((entry) => entry !== value) : [...selected, value])
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button ref={triggerRef} type="button" aria-label={`${label}: ${summary}`} className={cn(SELECT_TRIGGER_CLASS, className)}>
          <span className="min-w-0 flex-1 truncate text-left">{summary}</span>
          <ChevronDownIcon aria-hidden className={SELECT_CHEVRON_CLASS} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className={cn(POPOVER_PANEL_MIN_WIDTH_CLASS, 'flex w-max max-w-80 flex-col gap-1 p-1')}>
        <div role="group" aria-label={label} className="flex max-h-64 flex-col gap-1 overflow-y-auto">
          {options.map((option) => (
            <CheckboxItem
              key={option.value}
              className={cn(CHECKBOX_LIST_ITEM_CLASS, SELECT_ITEM_BOX_CLASS, 'px-2')}
              checked={selected.includes(option.value)}
              onCheckedChange={() => toggle(option.value)}
            >
              <span className={CHECKBOX_BOX_CLASS}>
                <CheckboxIndicator />
              </span>
              {option.leading}
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
            </CheckboxItem>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
