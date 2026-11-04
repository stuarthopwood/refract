import { useRef } from 'react'
import { CircleCheckIcon, CircleDotIcon, CircleHelpIcon, EllipsisIcon, GitPullRequestIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { HeaderActionButton } from '@/components/HeaderActionButton'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { StatePill } from '@/features/pull-requests/StatePill'
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

function TouchedState({ item }: { item: TouchedRef }) {
  if (item.kind === 'pr' && item.state !== 'unknown') {
    return <StatePill state={item.state === 'merged' || item.state === 'closed' || item.state === 'draft' ? item.state : 'open'} variant="subtle" labelClassName="sr-only" />
  }
  const Icon = item.kind === 'pr' ? GitPullRequestIcon : item.state === 'closed' ? CircleCheckIcon : item.state === 'unknown' ? CircleHelpIcon : CircleDotIcon
  return (
    <>
      <Icon aria-hidden className="size-4" />
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
  const select = (item: TouchedRef) => {
    if (item.repositoryId) markPinned()
    openTouched(item, sessionId, triggerRef.current)
  }
  const badgeText = `${kindWord(first)} ${refLabel(first)}, ${first.state}${extra > 0 ? `, and ${extra} more` : ''}`
  const menu = (trigger: React.ReactNode) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      {/* Radix would hand focus back to the trigger and undo the move into the panel. */}
      <DropdownMenuContent align="end" onCloseAutoFocus={onCloseAutoFocus}>
        {items.map((item) => (
          <DropdownMenuItem key={`${item.ownerRepo}/${item.kind}/${item.number}`} onSelect={() => select(item)}>
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
        {menu(<HeaderActionButton ref={triggerRef} icon={EllipsisIcon} text={`+${items.length}`} label={`${items.length} more pull requests and issues`} />)}
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
        <HeaderActionButton ref={triggerRef} icon={first.kind === 'pr' ? GitPullRequestIcon : CircleDotIcon} text="View" label={openLabel} onClick={() => select(first)} />
      )}
    </div>
  )
}
