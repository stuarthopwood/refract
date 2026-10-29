import type { KeyboardEvent } from 'react'
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import { ActiveIndicatorBar } from '@/components/ActiveIndicatorBar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { formatOutlineTime, outlineItemLabel, type OutlineRow } from '../../chat-nav/outlineModel'

export interface OutlineRowItemProps {
  row: OutlineRow
  current: boolean
  tabbable: boolean
  onActivate: (row: OutlineRow, focusChat: boolean) => void
  onToggle: (row: OutlineRow) => void
  onNavigate: (row: OutlineRow, key: 'ArrowUp' | 'ArrowDown' | 'Home' | 'End') => void
  onFocusRow: (row: OutlineRow) => void
}

/** One Outline entry: a collapse chevron (user rows with replies) beside the jump button. */
export function OutlineRowItem({ row, current, tabbable, onActivate, onToggle, onNavigate, onFocusRow }: OutlineRowItemProps) {
  const { message } = row
  const label = outlineItemLabel(row)
  const marker = message.kind === 'user' ? 'You' : 'Agent'

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      onNavigate(row, event.key)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      onActivate(row, true)
    } else if (row.childCount > 0 && ((event.key === 'ArrowLeft' && !row.collapsed) || (event.key === 'ArrowRight' && row.collapsed))) {
      event.preventDefault()
      onToggle(row)
    }
  }

  return (
    <div className={cn('relative flex items-stretch', row.depth === 1 && 'pl-4')}>
      {current && <ActiveIndicatorBar />}
      {row.childCount > 0 ? (
        <button
          type="button"
          tabIndex={-1}
          aria-expanded={!row.collapsed}
          aria-label={`${row.collapsed ? 'Expand' : 'Collapse'} replies to: ${label}`}
          className="no-drag-region flex w-6 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => onToggle(row)}
        >
          {row.collapsed ? <ChevronRightIcon aria-hidden className="size-4" /> : <ChevronDownIcon aria-hidden className="size-4" />}
        </button>
      ) : (
        <span aria-hidden className="w-6 shrink-0" />
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-outline-key={row.key}
            tabIndex={tabbable ? 0 : -1}
            aria-current={current ? 'location' : undefined}
            className="no-drag-region flex min-w-0 flex-1 items-center gap-2 py-1 pr-2 text-left text-sm hover:bg-sidebar-border focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            onClick={() => onActivate(row, false)}
            onFocus={() => onFocusRow(row)}
            onKeyDown={handleKeyDown}
          >
            <span className="w-11 shrink-0 text-xs font-medium text-muted-foreground">{marker}</span>
            <span className={cn('min-w-0 flex-1 truncate', message.firstLine === '' && 'text-muted-foreground italic')}>{label}</span>
            {message.kind === 'user' && message.at !== undefined && (
              <time dateTime={new Date(message.at).toISOString()} className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {formatOutlineTime(message.at)}
              </time>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="left" className="max-w-xs break-words">
          {message.firstLine === '' ? label : message.firstLine}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
