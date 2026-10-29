// The Report an issue dialog's label picker (issue #503, spec 049 decision 6): a searchable
// popover checklist of the repository's own labels plus outline chips for the chosen ones. The
// colour dot is decorative only (bordered, forced-colour safe); a label's colour is never a fill.
import { useState } from 'react'
import { TagIcon, XIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CHECKBOX_BOX_CLASS, CHECKBOX_LIST_ITEM_CLASS, CheckboxIndicator, CheckboxItem } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SearchField } from '@/components/SearchField'
import type { IssueLabel } from '../../../shared/ipc-issues'

function ColourDot({ color }: { color: string }) {
  const safe = /^[0-9a-fA-F]{6}$/.test(color) ? `#${color}` : 'transparent'
  return (
    <span
      aria-hidden
      className="size-2.5 shrink-0 rounded-full border border-border [forced-color-adjust:none]"
      style={{ backgroundColor: safe }}
    />
  )
}

interface IssueLabelPickerProps {
  labels: IssueLabel[]
  selected: string[]
  onChange: (selected: string[]) => void
  disabled?: boolean
  unavailable?: boolean
}

export function IssueLabelPicker({ labels, selected, onChange, disabled, unavailable }: IssueLabelPickerProps) {
  const [filter, setFilter] = useState('')
  const needle = filter.trim().toLowerCase()
  const visible = labels.filter((label) => label.name.toLowerCase().includes(needle))
  const toggle = (name: string) =>
    onChange(selected.includes(name) ? selected.filter((entry) => entry !== name) : [...selected, name])
  const colorOf = (name: string) => labels.find((label) => label.name === name)?.color ?? ''

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {selected.map((name) => (
          <Badge key={name} variant="outline" className="gap-2">
            <ColourDot color={colorOf(name)} />
            {name}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove label ${name}`}
                  aria-describedby={undefined}
                  disabled={disabled}
                  className="-mr-1 size-5"
                  onClick={() => toggle(name)}
                >
                  <XIcon aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Remove label</TooltipContent>
            </Tooltip>
          </Badge>
        ))}
        <Popover onOpenChange={(open) => open && setFilter('')}>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" size="xs" disabled={disabled || unavailable || labels.length === 0}>
              <TagIcon aria-hidden />
              {selected.length === 0 ? 'Add labels' : 'Edit labels'}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="flex w-72 flex-col gap-2 p-2">
            <SearchField label="Filter labels" placeholder="Filter labels…" value={filter} onValueChange={setFilter} />
            <div role="group" aria-label="Labels" className="flex max-h-56 flex-col gap-1 overflow-y-auto">
              {visible.length === 0 && <p className="px-1 py-2 text-xs text-muted-foreground">No matching labels</p>}
              {visible.map((label) => (
                <CheckboxItem
                  key={label.name}
                  className={CHECKBOX_LIST_ITEM_CLASS}
                  checked={selected.includes(label.name)}
                  onCheckedChange={() => toggle(label.name)}
                >
                  <span className={CHECKBOX_BOX_CLASS}>
                    <CheckboxIndicator />
                  </span>
                  <ColourDot color={label.color} />
                  <span className="min-w-0 flex-1 truncate">{label.name}</span>
                </CheckboxItem>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        {unavailable && <span className="text-xs text-muted-foreground">Labels could not be loaded</span>}
        {!unavailable && labels.length === 0 && selected.length === 0 && (
          <span className="text-xs text-muted-foreground">This repository has no labels</span>
        )}
      </div>
    </div>
  )
}
