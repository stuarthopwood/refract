import { useRef } from 'react'
import { CircleDotIcon, EllipsisIcon, GitPullRequestIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { HeaderActionButton } from '@/components/HeaderActionButton'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { PULL_REQUEST_STATE_DISPLAY } from '@/features/pull-requests/PullRequestRow'
import { IssueIcon } from './IssueIcon'
import { openTouched } from './openTouched'
import { usePinFromMenu } from './usePinFromMenu'
import type { TouchedRef } from '../../../../shared/model'

interface TouchedRefControlsProps {
  sessionId: string
  /** `badge` leads with the newest item; `overflow` is only the "+N" menu beside the #1315 controls. */
  mode: 'badge' | 'overflow'
  /** Newest first. */
  items: TouchedRef[]
}

const refLabel = (item: TouchedRef) => `${item.repositoryId ? '' : item.ownerRepo}#${item.number}`
const kindWord = (item: TouchedRef) => (item.kind === 'pr' ? 'Pull request' : 'Issue')

/** Bare state icon shared by the badge and menu rows so labels line up for PRs and issues alike. */
function TouchedState({ item }: { item: TouchedRef }) {
  if (item.kind === 'issue') {
    return (
      <>
        <IssueIcon state={item.state} />
        <span className="sr-only">{item.state}</span>
      </>
    )
  }
  const display = item.state === 'unknown' ? null : PULL_REQUEST_STATE_DISPLAY[item.state]
  const Icon = display?.icon ?? GitPullRequestIcon
  return (
    <>
      <Icon aria-hidden className={cn('size-4', display?.colorClass)} />
      <span className="sr-only">{item.state}</span>
    </>
  )
}

/** Header badge for pull requests and issues the session touched (#1587), or the "+N" menu of the rest. */
export function TouchedRefControls({ sessionId, mode, items }: TouchedRefControlsProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const { markPinned, onCloseAutoFocus } = usePinFromMenu()
  const first = items[0]
  if (!first) return null
  const extra = items.length - 1
  const badgeText = `${kindWord(first)} ${refLabel(first)}, ${first.state}${extra > 0 ? `, and ${extra} more` : ''}`
  const menu = (trigger: React.ReactNode) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      {/* Radix would hand focus back to the trigger and undo the move into the panel. */}
      <DropdownMenuContent align="end" onCloseAutoFocus={onCloseAutoFocus}>
        {items.map((item) => (
          <DropdownMenuItem
            key={`${item.ownerRepo}/${item.kind}/${item.number}`}
            onSelect={() => {
              if (item.repositoryId) markPinned()
              openTouched(item, sessionId, triggerRef.current)
            }}
          >
            <TouchedState item={item} />
            <span className="max-w-64 truncate">
              {refLabel(item)} {item.title}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  if (mode === 'overflow') {
    return (
      <div className="flex shrink-0 items-center gap-1">
        {menu(<HeaderActionButton ref={triggerRef} icon={EllipsisIcon} count={items.length} label={`${items.length} more pull requests and issues`} />)}
      </div>
    )
  }

  const openLabel = `Open ${kindWord(first).toLowerCase()} ${refLabel(first)}`
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Badge variant="outline" role="img" title={first.title || undefined} aria-label={badgeText}>
        <TouchedState item={first} />
        <span aria-hidden>{refLabel(first)}</span>
        {extra > 0 && <span aria-hidden>+{extra}</span>}
      </Badge>
      {extra > 0 ? (
        menu(<HeaderActionButton ref={triggerRef} icon={first.kind === 'pr' ? GitPullRequestIcon : CircleDotIcon} text="View" label={`View ${items.length} pull requests and issues`} />)
      ) : (
        <HeaderActionButton ref={triggerRef} icon={first.kind === 'pr' ? GitPullRequestIcon : CircleDotIcon} text="View" label={openLabel} onClick={() => openTouched(first, sessionId, triggerRef.current)} />
      )}
    </div>
  )
}
