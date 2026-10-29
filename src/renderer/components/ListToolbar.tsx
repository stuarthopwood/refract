// Shared list toolbar (#934, docs/design/components.md "Reusable components first"): a 32 px
// row of Filter tabs, selects and the shared SearchField, with an optional plain muted
// "Showing X of Y" line. Controls are passed as children; the search field is built in so every
// list screen filters the same way.
import type { ReactNode, RefObject } from 'react'
import { SearchField } from '@/components/SearchField'
import { cn } from '@/lib/utils'

export interface ListToolbarSearch {
  value: string
  onValueChange(value: string): void
  label: string
  placeholder: string
  inputRef?: RefObject<HTMLInputElement | null>
}

export interface ListToolbarProps {
  /** Leading controls (a Filter tabs strip, selects), in order. */
  children?: ReactNode
  search?: ListToolbarSearch
  /** Plain muted text at the end of the row, shown only while something is filtered. */
  countLine?: string
  className?: string
}

export function ListToolbar({ children, search, countLine, className }: ListToolbarProps) {
  return (
    <div className={cn('flex shrink-0 flex-wrap items-center gap-2 px-4 py-2', className)}>
      {children}
      {search && (
        <div role="search" className="w-64 max-w-full">
          <SearchField
            value={search.value}
            onValueChange={search.onValueChange}
            label={search.label}
            placeholder={search.placeholder}
            inputRef={search.inputRef}
            tooltipSide="bottom"
          />
        </div>
      )}
      {countLine && <span className="shrink-0 text-xs text-muted-foreground">{countLine}</span>}
    </div>
  )
}
