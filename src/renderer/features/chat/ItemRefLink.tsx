// A `#123` / `owner/repo#123` reference in chat prose (#1155): a link with a hover Item card. The
// lookup runs only on hover, focus or click (#610: no existence check at render time) and is cached
// for five minutes per repository and number.
import * as React from 'react'
import { InlineStatus } from '@/components/InlineStatus'
import { UserAvatar } from '@/components/UserAvatar'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { StatePill } from '@/features/pull-requests/StatePill'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { usePullRequestsStore, useRepositoriesStore, useSessionsStore, useViewStore } from '@/state'
import type { ItemCard } from '../../../shared/ipc-item-refs'
import { linkClassName } from './linkStyles'
import { resolveItemRef, type ItemRefTarget } from './itemRefs'

const CACHE_MS = 5 * 60 * 1000
const CACHE_MAX = 200
// Insertion order is recency order: a hit is deleted and re-inserted, so the first key is the oldest.
const cache = new Map<string, { at: number; card: Promise<ItemCard | null> }>()

function lookupCard(target: ItemRefTarget): Promise<ItemCard | null> {
  const key = `${target.repositoryId}|${target.owner ?? ''}/${target.repo ?? ''}#${target.number}`
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    if (Date.now() - hit.at < CACHE_MS) {
      cache.set(key, hit)
      return hit.card
    }
  }
  const card = window.refract.itemRefs
    .lookup(target.repositoryId, target.owner, target.repo, target.number)
    .then((result) => (result.ok ? result.value : null))
    .catch(() => null)
  cache.set(key, { at: Date.now(), card })
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  // A failed lookup (offline, no access) must not stick for five minutes.
  void card.then((value) => {
    if (!value && cache.get(key)?.card === card) cache.delete(key)
  })
  return card
}

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
  const contentId = React.useId()
  if (!target) return <>{text}</>
  // Inert while streaming, like every other link in a live message.
  if (streaming) return <span className="text-accent-text underline underline-offset-2">{text}</span>

  const openItem = (): void => {
    void lookupCard(target).then((found) => {
      if (found?.kind === 'pull-request' && target.inProject) {
        usePullRequestsStore.getState().openPullRequest(target.repositoryId, target.number)
        useViewStore.getState().openPullRequests()
        return
      }
      // An issue (until the Issues view can show one) or a repository that is not a Project opens on GitHub.
      const remote = repository?.remote
      const ownerRepo = target.owner ? `${target.owner}/${target.repo}` : remote?.kind === 'has' ? `${remote.owner}/${remote.repo}` : null
      const url = found?.url ?? (ownerRepo ? `https://github.com/${ownerRepo}/issues/${target.number}` : null)
      if (url) openInBrowser(url)
    })
  }

  return (
    <HoverCard
      openDelay={300}
      onOpenChange={(isOpen) => {
        setOpen(isOpen)
        if (!isOpen) return
        // A previous failed or loaded card must not flash before this lookup settles.
        setCard('loading')
        void lookupCard(target).then(setCard)
      }}
    >
      <HoverCardTrigger asChild>
        <Button
          type="button"
          variant="link"
          className={cn(linkClassName, 'inline h-auto min-h-6 p-0 whitespace-normal')}
          aria-describedby={open ? contentId : undefined}
          onClick={openItem}
        >
          {text}
        </Button>
      </HoverCardTrigger>
      <HoverCardContent id={contentId} side="top" align="start">
        {card === 'loading' ? (
          <InlineStatus tone="loading" density="compact" className="p-0">
            Loading {text}…
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
