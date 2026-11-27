import { useRef } from 'react'
import { EllipsisIcon, GitPullRequestIcon } from 'lucide-react'
import { HeaderActionButton } from '@/components/HeaderActionButton'
import { HeaderRefBadge } from '@/components/HeaderRefBadge'
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
const kindWord = (item: TouchedRef) => (item.kind === 'pr' ? 'pull request' : 'issue')

/** State icon shared by the badge and menu rows so labels line up for PRs and issues alike; menu rows also speak the state. */
function TouchedState({ item, speakState = true }: { item: TouchedRef; speakState?: boolean }) {
  const stateWord = speakState ? <span className="sr-only">{item.state}</span> : null
  if (item.kind === 'issue') {
    return (
      <>
        <IssueIcon state={item.state} />
        {stateWord}
      </>
    )
  }
  const display = item.state === 'unknown' ? null : PULL_REQUEST_STATE_DISPLAY[item.state]
  const Icon = display?.icon ?? GitPullRequestIcon
  return (
    <>
      <Icon aria-hidden className={cn('size-4', display?.colorClass)} />
      {stateWord}
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

  const badgeProps = { ref: triggerRef, icon: <TouchedState item={first} speakState={false} />, text: refLabel(first), status: first.state, extra, itemTitle: first.title || undefined }
  return (
    <div className="flex shrink-0 items-center gap-1">
      {extra > 0 ? (
        menu(<HeaderRefBadge {...badgeProps} action="show pull requests and issues" />)
      ) : (
        <HeaderRefBadge {...badgeProps} action={`open ${kindWord(first)}`} onClick={() => openTouched(first, sessionId, triggerRef.current)} />
      )}
    </div>
  )
}
