// Spec 060 S2-08: the Usage view's filter row, built from the shared `ListToolbar`, `FilterTabs`
// and `Select`. Every change goes through the store, which persists it and refetches.
import { FilterTabs } from '@/components/FilterTabs'
import { ListToolbar } from '@/components/ListToolbar'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useUsageStore } from '@/state/usage-store'
import type { UsageFilters as Filters, UsageRange } from '../../../shared/ipc-usage'

const RANGES: Array<{ value: UsageRange; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All' },
  { value: 'custom', label: 'Custom' }
]

// Radix Select forbids an empty-string item value, so "any" gets a sentinel.
const ANY = '__any__'

interface FilterSelectProps {
  label: string
  anyLabel: string
  value: string | null | undefined
  options: string[]
  onChange(value: string | null): void
}

function FilterSelect({ label, anyLabel, value, options, onChange }: FilterSelectProps) {
  return (
    <Select value={value ?? ANY} onValueChange={(next) => onChange(next === ANY ? null : next)}>
      <SelectTrigger aria-label={label} className="min-w-0 max-w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper">
        <SelectItem value={ANY}>{anyLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function toDateInput(ms: number | undefined): string {
  if (ms === undefined) return ''
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** A date input's `YYYY-MM-DD` as local midnight, or the end of that local day for `to`. */
function fromDateInput(value: string, endOfDay: boolean): number | undefined {
  if (!value) return undefined
  const [y = 0, m = 1, d = 1] = value.split('-').map(Number)
  return endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999).getTime() : new Date(y, m - 1, d).getTime()
}

export function UsageFilters() {
  const filters = useUsageStore((s) => s.filters)
  const options = useUsageStore((s) => s.options)
  const setFilters = useUsageStore((s) => s.setFilters)
  const patch = (next: Partial<Filters>) => setFilters(next)
  return (
    <>
      <ListToolbar className="px-0">
        <FilterTabs
          ariaLabel="Date range"
          tabs={RANGES}
          value={filters.range}
          onValueChange={(range) => patch({ range })}
        />
        <FilterSelect label="Project" anyLabel="All projects" value={filters.project} options={options.projects} onChange={(project) => patch({ project })} />
        <FilterSelect label="Model" anyLabel="All models" value={filters.model} options={options.models} onChange={(model) => patch({ model })} />
        <FilterSelect
          label="Reasoning level"
          anyLabel="Any reasoning"
          value={filters.reasoning}
          options={options.reasonings}
          onChange={(reasoning) => patch({ reasoning })}
        />
        <FilterSelect
          label="Agent type"
          anyLabel="Main and subagents"
          value={filters.agentType}
          options={['main', 'subagent']}
          onChange={(agentType) => patch({ agentType: agentType as Filters['agentType'] })}
        />
      </ListToolbar>
      {filters.range === 'custom' && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-2">
            From
            <Input
              type="date"
              className="w-40"
              value={toDateInput(filters.from)}
              onChange={(event) => patch({ from: fromDateInput(event.target.value, false) })}
            />
          </label>
          <label className="flex items-center gap-2">
            To
            <Input
              type="date"
              className="w-40"
              value={toDateInput(filters.to)}
              onChange={(event) => patch({ to: fromDateInput(event.target.value, true) })}
            />
          </label>
        </div>
      )}
    </>
  )
}
