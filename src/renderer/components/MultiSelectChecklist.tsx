// A popover checklist behind one trigger button (the Issues view's Project filter, #504). The
// trigger shows `summary`; each option is a shared `CheckboxItem` with an optional leading adornment.
import type { ReactNode } from 'react'
import { ChevronDownIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CHECKBOX_BOX_CLASS, CHECKBOX_LIST_ITEM_CLASS, CheckboxIndicator, CheckboxItem } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

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
}

export function MultiSelectChecklist({ label, summary, options, selected, onChange, className }: MultiSelectChecklistProps) {
  const toggle = (value: string) =>
    onChange(selected.includes(value) ? selected.filter((entry) => entry !== value) : [...selected, value])
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" aria-label={`${label}: ${summary}`} className={className}>
          <span className="min-w-0 flex-1 truncate text-left">{summary}</span>
          <ChevronDownIcon aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-72 flex-col gap-1 p-2">
        <div role="group" aria-label={label} className="flex max-h-64 flex-col gap-1 overflow-y-auto">
          {options.map((option) => (
            <CheckboxItem
              key={option.value}
              className={CHECKBOX_LIST_ITEM_CLASS}
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
