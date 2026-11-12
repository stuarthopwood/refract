// A `#123` / `owner/repo#123` reference in chat prose (#1155): a link with a hover Item card. The
// lookup runs only on hover, focus or click (#610: no existence check at render time) and is cached
// for five minutes per repository and number. A plain click pins an in-Project item in the right
// pane (#1950); the type icon stays neutral until a lookup (or a cached one) has resolved the type.
import * as React from 'react'
import { InlineStatus } from '@/components/InlineStatus'
import { UserAvatar } from '@/components/UserAvatar'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { StatePill } from '@/features/pull-requests/StatePill'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { usePinnedPanelsStore, useRepositoriesStore, useSessionsStore } from '@/state'
import type { ItemCard } from '../../../shared/ipc-item-refs'
import { linkClassName } from './linkStyles'
import { lookupCard, peekCard } from './itemCardCache'
import { resolveItemRef, type ItemRefTarget } from './itemRefs'
import { ItemTypeIcon, itemTypeVisual } from './ItemTypeIcon'
import { openItemRef, wantsBrowser } from './openItemRef'

// The shared external-link listener (tauri-bridge/externalLinks.ts) is the one place a URL opens.
function openInBrowser(url: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.target = '_blank'
  anchor.rel = 'noreferrer noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

function ItemCardBody({ card }: { card: ItemCard }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs font-medium">
        <ItemTypeIcon card={card} />
        {itemTypeVisual(card).label}
      </div>
      <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {card.ownerRepo} on {new Date(card.createdAt).toLocaleDateString()}
      </div>
      <div className="font-medium [overflow-wrap:anywhere]">
        {card.title} <span className="text-muted-foreground">#{card.number}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <StatePill state={card.state === 'open' && card.draft ? 'draft' : card.state} />
        <UserAvatar name={card.authorLogin} src={card.avatarDataUrl ?? undefined} size="xs" />
        <span className="text-xs [overflow-wrap:anywhere]">{card.authorLogin}</span>
      </div>
      {card.kind === 'pull-request' && card.baseRef && card.headRef && (
        <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {card.baseRef} &larr; {card.headRef}
        </div>
      )}
    </div>
  )
}

export function ItemRefLink({ text, sessionId, streaming }: { text: string; sessionId: string | null; streaming: boolean }) {
  const repositoryId = useSessionsStore((state) => state.sessions.find((session) => session.id === sessionId)?.repositoryId)
  const repository = useRepositoriesStore((state) => state.repositories.find((candidate) => candidate.id === repositoryId))
  const target = React.useMemo(() => (repository ? resolveItemRef(text, repository) : null), [text, repository])
  const [card, setCard] = React.useState<ItemCard | null | 'loading'>('loading')
  const [open, setOpen] = React.useState(false)
  // A lookup resolving fills the cache; this re-renders so the icon reads it.
  const [, refreshIcon] = React.useReducer((count: number) => count + 1, 0)
  const contentId = React.useId()
  if (!target) return <>{text}</>
  // Inert while streaming, like every other link in a live message.
  if (streaming) return <span className="text-accent-text underline underline-offset-2">{text}</span>

  const lookup = (forTarget: ItemRefTarget): Promise<ItemCard | null> => {
    const found = lookupCard(forTarget)
    void found.then(refreshIcon)
    return found
  }

  const openItem = (event: React.MouseEvent<HTMLElement>): void => {
    const remote = repository?.remote
    const ownerRepo = target.owner ? `${target.owner}/${target.repo}` : remote?.kind === 'has' ? `${remote.owner}/${remote.repo}` : null
    void openItemRef(
      { target, sessionId, opener: event.currentTarget, toBrowser: wantsBrowser(event), ownerRepo },
      { lookup, pin: (kind, pinTarget) => usePinnedPanelsStore.getState().pin(kind, pinTarget), openUrl: openInBrowser }
    )
  }

  return (
    <HoverCard
      openDelay={300}
      onOpenChange={(isOpen) => {
        setOpen(isOpen)
        if (!isOpen) return
        // A previous failed or loaded card must not flash before this lookup settles.
        setCard('loading')
        void lookup(target).then(setCard)
      }}
    >
      <HoverCardTrigger asChild>
        <Button
          type="button"
          variant="link"
          className={cn(linkClassName, 'inline h-auto min-h-6 p-0 whitespace-normal')}
          aria-describedby={open ? contentId : undefined}
          onClick={openItem}
          // Middle click does not raise `click`; without the mousedown guard Windows starts autoscroll.
          onMouseDown={(event) => {
            if (event.button === 1) event.preventDefault()
          }}
          onAuxClick={(event) => {
            if (event.button === 1) openItem(event)
          }}
        >
          <ItemTypeIcon card={peekCard(target)} className="mr-1" />
          {text}
        </Button>
      </HoverCardTrigger>
      <HoverCardContent id={contentId} side="top" align="start">
        {card === 'loading' ? (
          <InlineStatus tone="loading" density="compact" className="p-0">
            Loading {text}...
          </InlineStatus>
        ) : card ? (
          <ItemCardBody card={card} />
        ) : (
          <InlineStatus tone="notice" density="compact" className="p-0">
            Could not load {text}.
          </InlineStatus>
        )}
      </HoverCardContent>
    </HoverCard>
  )
}
