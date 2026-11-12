// What a click on a chat `#123` reference does (#1950): pin an in-Project item in the right pane, else open GitHub.
import type { ItemCard } from '../../../shared/ipc-item-refs'
import type { ItemRefTarget } from './itemRefs'

export interface OpenItemRefDeps {
  lookup(target: ItemRefTarget): Promise<ItemCard | null>
  pin(kind: ItemCard['kind'], target: { repositoryId: string; number: number; sessionId: string | null; opener: HTMLElement | null; focus: false }): void
  openUrl(url: string): void
}

export interface OpenItemRefRequest {
  target: ItemRefTarget
  sessionId: string | null
  opener: HTMLElement | null
  /** Ctrl, Cmd or middle click: the browser, never the right pane. */
  toBrowser: boolean
  /** `owner/repo` the reference lives in, for the GitHub URL; null when the Project has no GitHub remote. */
  ownerRepo: string | null
}

/** True for a click that asks for the browser: Ctrl or Cmd held, or the middle button. */
export function wantsBrowser(event: { ctrlKey: boolean; metaKey: boolean; button: number }): boolean {
  return event.ctrlKey || event.metaKey || event.button === 1
}

/** `focus: false` keeps the keyboard in the chat; a lookup that fails still opens the item on GitHub. */
export async function openItemRef({ target, sessionId, opener, toBrowser, ownerRepo }: OpenItemRefRequest, deps: OpenItemRefDeps): Promise<void> {
  // `/issues/N` redirects to the pull request when N is one, so the fallback needs no lookup.
  const fallbackUrl = ownerRepo ? `https://github.com/${ownerRepo}/issues/${target.number}` : null
  if (toBrowser) {
    if (fallbackUrl) deps.openUrl(fallbackUrl)
    return
  }
  const card = await deps.lookup(target)
  if (card && target.inProject) {
    deps.pin(card.kind, { repositoryId: target.repositoryId, number: target.number, sessionId, opener, focus: false })
    return
  }
  const url = card?.url ?? fallbackUrl
  if (url) deps.openUrl(url)
}
