// Spec 060 S2-08: the Usage view's filter row, built from the shared `ListToolbar`, `FilterTabs`
// and `OptionSelect`. Every change goes through the store, which persists it and refetches.
import { useEffect, useId, useState } from 'react'
import { FilterTabs } from '@/components/FilterTabs'
import { ListToolbar } from '@/components/ListToolbar'
import { OptionSelect } from '@/components/OptionSelect'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DEFAULT_USAGE_FILTERS, useUsageStore } from '@/state/usage-store'
import type { UsageFilters as Filters, UsageRange } from '../../../shared/ipc-usage'

const RANGES: Array<{ value: UsageRange; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All' },
  { value: 'custom', label: 'Custom' }
]

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

  /** How many filters differ from the defaults; a custom date range counts, so it can be cleared too. */
  export function countActiveFilters(filters: Filters): number {
    return [filters.project, filters.model, filters.reasoning, filters.agentType].filter(Boolean).length + (filters.range === 'custom' ? 1 : 0)
  }

  /** Resets every filter, including a custom date range, then returns focus to the first filter: the Clear button unmounts. */
  export function clearUsageFilters(): void {
    useUsageStore.getState().setFilters({ ...DEFAULT_USAGE_FILTERS, from: undefined, to: undefined, project: null, model: null, reasoning: null, agentType: null })
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-usage-filters] button[aria-label="Project"]')?.focus())
  }

  const AGENT_TYPE_LABELS: Record<string, string> = { main: 'Main agent', subagent: 'Subagent' }

  export function UsageFilters() {
    const filters = useUsageStore((s) => s.filters)
    const options = useUsageStore((s) => s.options)
    const setFilters = useUsageStore((s) => s.setFilters)
    const patch = (next: Partial<Filters>) => setFilters(next)
    const errorId = useId()
    const [draft, setDraft] = useState({ from: toDateInput(filters.from), to: toDateInput(filters.to) })
    const [rangeError, setRangeError] = useState('')
    // Hydration, a range switch or Clear filters changes the stored dates under the inputs.
    useEffect(() => {
      setDraft({ from: toDateInput(filters.from), to: toDateInput(filters.to) })
    }, [filters.from, filters.to])
    useEffect(() => {
      setRangeError('')
    }, [filters.range])
    const changeDate = (key: 'from' | 'to', value: string) => {
      const next = { ...draft, [key]: value }
      setDraft(next)
      const from = fromDateInput(next.from, false)
      const to = fromDateInput(next.to, true)
      if (from !== undefined && to !== undefined && from > to) {
        setRangeError('From must be on or before To.')
        return
      }
      setRangeError('')
      patch({ from, to })
    }
    const dateProps = (key: 'from' | 'to') => ({
      type: 'date' as const,
      className: 'w-36',
      value: draft[key],
      'aria-invalid': rangeError ? true : undefined,
      'aria-describedby': rangeError ? errorId : undefined,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => changeDate(key, event.target.value)
    })
    return (
      <div data-usage-filters className="max-h-[40vh] shrink-0 overflow-y-auto">
        <ListToolbar>
          <FilterTabs ariaLabel="Date range" tabs={RANGES} value={filters.range} onValueChange={(range) => patch({ range })} />
          {filters.range === 'custom' && (
            <>
              <label className="flex items-center gap-2 text-xs">
                From
                <Input {...dateProps('from')} />
              </label>
              <label className="flex items-center gap-2 text-xs">
                To
                <Input {...dateProps('to')} />
              </label>
            </>
          )}
          <OptionSelect label="Project" anyLabel="All projects" value={filters.project} options={options.projects} onChange={(project) => patch({ project })} />
          <OptionSelect label="Model" anyLabel="All models" value={filters.model} options={options.models} onChange={(model) => patch({ model })} />
          <OptionSelect
            label="Reasoning level"
            anyLabel="Any reasoning"
            value={filters.reasoning}
            options={options.reasonings}
            onChange={(reasoning) => patch({ reasoning })}
          />
          <OptionSelect
            label="Agent type"
            anyLabel="Main and subagents"
            value={filters.agentType}
            options={['main', 'subagent']}
            optionLabel={(option) => AGENT_TYPE_LABELS[option] ?? option}
            onChange={(agentType) => patch({ agentType: agentType as Filters['agentType'] })}
          />
          {countActiveFilters(filters) > 0 && (
            <Button type="button" variant="ghost" size="sm" onClick={clearUsageFilters}>
              Clear filters
            </Button>
          )}
        </ListToolbar>
        {rangeError && (
          <p id={errorId} role="alert" className="px-4 pb-2 text-xs text-destructive">
            {rangeError}
          </p>
        )}
      </div>
    )
  }
