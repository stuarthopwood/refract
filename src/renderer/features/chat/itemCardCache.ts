// The five-minute per-repository-and-number cache behind the chat `#123` hover card and type icon
// (#1155, #1950). Only hover, focus and click call `lookupCard`; render only `peekCard` (#610).
import type { ItemCard } from '../../../shared/ipc-item-refs'
import type { ItemRefTarget } from './itemRefs'

const CACHE_MS = 5 * 60 * 1000
const CACHE_MAX = 200
interface CacheEntry {
  at: number
  card: Promise<ItemCard | null>
  /** Set once the lookup resolves with a card, so render can read it without a lookup of its own. */
  value?: ItemCard
}
// Insertion order is recency order: a hit is deleted and re-inserted, so the first key is the oldest.
const cache = new Map<string, CacheEntry>()

function cacheKey(target: ItemRefTarget): string {
  return `${target.repositoryId}|${target.owner ?? ''}/${target.repo ?? ''}#${target.number}`
}

/** The card a lookup already resolved, or undefined; never starts a lookup. */
export function peekCard(target: ItemRefTarget): ItemCard | undefined {
  const hit = cache.get(cacheKey(target))
  return hit && Date.now() - hit.at < CACHE_MS ? hit.value : undefined
}

export function lookupCard(target: ItemRefTarget): Promise<ItemCard | null> {
  const key = cacheKey(target)
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
  const entry: CacheEntry = { at: Date.now(), card }
  cache.set(key, entry)
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  void card.then((value) => {
    if (cache.get(key)?.card !== card) return
    // A failed lookup (offline, no access) must not stick for five minutes.
    if (value) entry.value = value
    else cache.delete(key)
  })
  return card
}

/** Test seam: drops every entry. */
export function clearCardCache(): void {
  cache.clear()
}
