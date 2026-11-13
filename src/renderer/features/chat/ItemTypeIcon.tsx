// The type icon of a chat `#123` reference (#1950): neutral until the item is looked up, then the issue
// or pull request icon in its state colour. The hover card header reuses it, so both read the same.
import { CircleDotIcon, GitPullRequestIcon, HashIcon, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PULL_REQUEST_STATE_DISPLAY } from '@/features/pull-requests/PullRequestRow'
import type { ItemCard } from '../../../shared/ipc-item-refs'

export interface ItemTypeVisual {
  Icon: LucideIcon
  colorClass: string
  /** The word for the type; null while it is not known. */
  label: 'Issue' | 'Pull request' | null
}

const NEUTRAL: ItemTypeVisual = { Icon: HashIcon, colorClass: 'text-muted-foreground', label: null }

/** A draft pull request shows as `draft`, not `open`; one place so the icon and the card pill agree. */
export function itemDisplayState(card: ItemCard): 'draft' | ItemCard['state'] {
  return card.state === 'open' && card.draft ? 'draft' : card.state
}

/** `card` undefined or null means the item has not been looked up (or the lookup failed): the neutral icon. */
export function itemTypeVisual(card: ItemCard | null | undefined): ItemTypeVisual {
  if (!card) return NEUTRAL
  if (card.kind === 'pull-request') {
    return { Icon: GitPullRequestIcon, colorClass: PULL_REQUEST_STATE_DISPLAY[itemDisplayState(card)].colorClass, label: 'Pull request' }
  }
  return { Icon: CircleDotIcon, colorClass: card.state === 'open' ? 'text-pr-open' : 'text-pr-merged', label: 'Issue' }
}

export function ItemTypeIcon({ card, className }: { card: ItemCard | null | undefined; className?: string }) {
  const { Icon, colorClass } = itemTypeVisual(card)
  return <Icon aria-hidden data-item-type={card?.kind ?? 'unknown'} className={cn('inline-block size-3.5 shrink-0 align-[-0.15em]', colorClass, className)} />
}
