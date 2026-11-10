import { useEffect, useRef } from 'react'
import { InlineStatus } from '@/components/InlineStatus'
import { PULL_REQUEST_STATE_DISPLAY } from '@/features/pull-requests/PullRequestRow'
import type { ItemSummary } from '../../../shared/ipc-item-refs'
import { IssueIcon } from './header/IssueIcon'
import { COMPOSER_MENU_LIST_CLASS, COMPOSER_MENU_NOTICE_CLASS, composerMenuRowClass } from './SlashMenu'

export type HashPickerStatus = 'loading' | 'ready' | 'error'

export interface HashPickerProps {
  id: string
  rows: readonly ItemSummary[]
  status: HashPickerStatus
  errorMessage: string | null
  activeIndex: number
  onSelect(item: ItemSummary): void
  onActiveIndexChange(index: number): void
}

/** Stable per row: the number is unique within the Project's repository. */
export function hashOptionId(pickerId: string, item: ItemSummary): string {
  return `${pickerId}-option-${item.number}`
}

/** State as icon plus word, never colour alone; a pull request's draft is its own state. */
function RowState({ item }: { item: ItemSummary }) {
  if (item.kind === 'issue') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <IssueIcon state={item.state === 'closed' ? 'closed' : 'open'} />
        <span className="sr-only">Issue, </span>
        {item.state === 'closed' ? 'Closed' : 'Open'}
      </span>
    )
  }
  const display = PULL_REQUEST_STATE_DISPLAY[item.draft ? 'draft' : item.state]
  const Icon = display.icon
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
      <Icon aria-hidden className="size-4" />
      <span className="sr-only">Pull request, </span>
      {display.label}
    </span>
  )
}

/** The composer `#` picker's popover, in the slash menu's look. Titles are untrusted GitHub text. */
export function HashPicker({ id, rows, status, errorMessage, activeIndex, onSelect, onActiveIndexChange }: HashPickerProps) {
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, rows])

  if (status === 'loading') {
    return (
      <div className={COMPOSER_MENU_NOTICE_CLASS}>
        <InlineStatus tone="loading" density="compact" className="p-0">
          Searching...
        </InlineStatus>
      </div>
    )
  }
  if (status === 'error') {
    return (
      <div className={COMPOSER_MENU_NOTICE_CLASS}>
        <InlineStatus tone="error" density="compact" className="p-0">
          {errorMessage ?? 'Could not search this repository.'}
        </InlineStatus>
      </div>
    )
  }
  if (rows.length === 0) {
    // Announced through the composer's live region, so hidden here like the slash menu's empty state.
    return (
      <div aria-hidden="true" className={COMPOSER_MENU_NOTICE_CLASS}>
        No matching items
      </div>
    )
  }

  return (
    <ul ref={listRef} id={id} role="listbox" aria-label="Issues and pull requests" className={COMPOSER_MENU_LIST_CLASS}>
      {rows.map((item, index) => (
        <li
          key={item.number}
          id={hashOptionId(id, item)}
          role="option"
          aria-selected={index === activeIndex}
          data-active={index === activeIndex}
          onMouseEnter={() => onActiveIndexChange(index)}
          onMouseDown={(event) => {
            event.preventDefault()
            onSelect(item)
          }}
          className={composerMenuRowClass(index === activeIndex)}
        >
          <RowState item={item} />
          <span className="shrink-0 font-normal">#{item.number}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={item.title}>
            {item.title}
          </span>
        </li>
      ))}
    </ul>
  )
}
