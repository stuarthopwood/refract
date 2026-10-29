// Shared filter field + grouped listbox (spec 054, the Clone from GitHub dialog's repository
// list). The combobox/listbox pattern is the one ModelPicker uses (input role=combobox with
// aria-activedescendant, options never take DOM focus); it lives here so the next grouped picker
// extends this instead of copying it. Rows are plain text: callers pass already-safe nodes.
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode, RefObject } from 'react'
import { CheckIcon } from 'lucide-react'
import { SearchField } from '@/components/SearchField'
import { PICKER_OPTION_ACTIVE_CLASS, PICKER_OPTION_CLASS } from '@/features/chat/pickerShared'
import { cn } from '@/lib/utils'

export interface ListboxItem {
  id: string
}

export interface ListboxGroup<T extends ListboxItem> {
  id: string
  label: string
  items: T[]
  /** A per-group failure row, shown after the items; selecting it (Enter or click) calls `onRetry`. */
  error?: { message: string; actionLabel: string; onRetry(): void }
}

export interface FilterableGroupedListboxProps<T extends ListboxItem> {
  groups: ListboxGroup<T>[]
  value: string
  onValueChange(value: string): void
  /** Accessible name of the filter input. */
  label: string
  placeholder: string
  onSelect(item: T): void
  renderItem(item: T): ReactNode
  /** The item shown as chosen (`aria-selected`). */
  selectedId?: string | null
  /** Shown outside the listbox when no group has items or errors (plain text or a node, for example an alert with Retry). */
  empty: ReactNode
  /** Visible line under the list (for example "Showing 5 of 12"). */
  countText?: string
  /** Mirrored into a polite sr-only live region so a screen reader hears filter results. */
  announcement?: string
  inputRef?: RefObject<HTMLInputElement | null>
  className?: string
}

type FlatRow<T extends ListboxItem> =
  | { kind: 'item'; key: string; item: T }
  | { kind: 'retry'; key: string; group: ListboxGroup<T> }

export function FilterableGroupedListbox<T extends ListboxItem>({
  groups,
  value,
  onValueChange,
  label,
  placeholder,
  onSelect,
  renderItem,
  selectedId,
  empty,
  countText,
  announcement,
  inputRef,
  className
}: FilterableGroupedListboxProps<T>) {
  const baseId = useId()
  const listboxId = `${baseId}-listbox`
  const listRef = useRef<HTMLDivElement>(null)
  const [activeKey, setActiveKey] = useState<string | null>(null)

  const rows = useMemo<FlatRow<T>[]>(() => {
    const out: FlatRow<T>[] = []
    for (const group of groups) {
      for (const item of group.items) out.push({ kind: 'item', key: `${group.id}:${item.id}`, item })
      if (group.error) out.push({ kind: 'retry', key: `${group.id}:retry`, group })
    }
    return out
  }, [groups])

  // Keep the active row valid as the filter narrows: fall back to the first row.
  const activeRow = rows.find((row) => row.key === activeKey) ?? rows[0] ?? null
  const optionId = (key: string): string => `${baseId}-opt-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`

  useEffect(() => {
    if (!activeRow) return
    const frame = requestAnimationFrame(() => {
      listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
  }, [activeRow?.key])

  function activate(row: FlatRow<T>): void {
    if (row.kind === 'retry') row.group.error?.onRetry()
    else onSelect(row.item)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (rows.length === 0) return
    const index = activeRow ? rows.indexOf(activeRow) : 0
    const moveTo = (target: number): void => {
      const row = rows[Math.min(Math.max(target, 0), rows.length - 1)]
      if (row) setActiveKey(row.key)
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveTo(index + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveTo(index - 1)
    } else if (event.key === 'Home' && event.ctrlKey) {
      event.preventDefault()
      moveTo(0)
    } else if (event.key === 'End' && event.ctrlKey) {
      event.preventDefault()
      moveTo(rows.length - 1)
    } else if (event.key === 'PageDown') {
      event.preventDefault()
      moveTo(index + 10)
    } else if (event.key === 'PageUp') {
      event.preventDefault()
      moveTo(index - 10)
    } else if (event.key === 'Enter' && activeRow) {
      event.preventDefault()
      activate(activeRow)
    }
  }

  return (
    <div className={cn('flex min-h-0 min-w-0 flex-col gap-2', className)}>
      <SearchField
        value={value}
        onValueChange={onValueChange}
        label={label}
        placeholder={placeholder}
        inputRef={inputRef}
        combobox={{ listboxId, activeDescendantId: activeRow ? optionId(activeRow.key) : undefined }}
        onInputKeyDown={handleKeyDown}
      />
      {rows.length === 0 && (
        <div className="rounded-md border border-border px-2 py-4 text-sm text-muted-foreground">{empty}</div>
      )}
      <div
        ref={listRef}
        id={listboxId}
        role="listbox"
        aria-label={label}
        className={cn('max-h-64 min-h-24 overflow-y-auto rounded-md border border-border', rows.length === 0 && 'hidden')}
        // Options never take focus; keep it on the input when one is clicked.
        onMouseDown={(event) => event.preventDefault()}
      >
        {groups.map((group) => {
          if (group.items.length === 0 && !group.error) return null
          const headingId = `${baseId}-group-${group.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
          return (
            <div key={group.id} role="group" aria-labelledby={headingId}>
              <div
                id={headingId}
                role="presentation"
                className="sticky top-0 z-10 bg-popover px-2 py-1 text-xs font-medium text-muted-foreground"
              >
                {group.label}
              </div>
              {group.items.map((item) => {
                const key = `${group.id}:${item.id}`
                const active = activeRow?.key === key
                return (
                  <div
                    key={key}
                    id={optionId(key)}
                    role="option"
                    aria-selected={selectedId === item.id}
                    data-active={active ? 'true' : undefined}
                    className={cn(
                      PICKER_OPTION_CLASS,
                      'aria-selected:font-medium',
                      active && PICKER_OPTION_ACTIVE_CLASS
                    )}
                    onClick={() => onSelect(item)}
                    onMouseMove={() => {
                      if (!active) setActiveKey(key)
                    }}
                  >
                    {renderItem(item)}
                    {selectedId === item.id && <CheckIcon aria-hidden className="size-4 shrink-0" />}
                  </div>
                )
              })}
              {group.error && (
                <div
                  id={optionId(`${group.id}:retry`)}
                  role="option"
                  aria-selected={false}
                  data-active={activeRow?.key === `${group.id}:retry` ? 'true' : undefined}
                  className={cn(
                    PICKER_OPTION_CLASS,
                    'justify-between text-muted-foreground',
                    activeRow?.key === `${group.id}:retry` && PICKER_OPTION_ACTIVE_CLASS
                  )}
                  onClick={group.error.onRetry}
                  onMouseMove={() => setActiveKey(`${group.id}:retry`)}
                >
                  <span className="min-w-0 truncate">{group.error.message}</span>
                  <span className="shrink-0 underline">{group.error.actionLabel}</span>
                </div>
              )}
            </div>
          )
        })}
      </div>
      {countText && <p className="text-xs text-muted-foreground">{countText}</p>}
      <div aria-live="polite" role="status" className="sr-only">
        {announcement}
      </div>
    </div>
  )
}
