import type { MessageImageData } from '../../shared/ipc-images'

const MAX_ENTRIES = 16
const MAX_TOTAL_CHARS = 48_000_000
const cache = new Map<string, MessageImageData>()
let totalChars = 0
const inFlight = new Map<string, Promise<MessageImageData>>()

/** Loads one Message image by id through `images.get`, with a small LRU so scrolling back to a
 * message does not refetch, and de-duplication so a tile and the viewer share one request. */
export function loadMessageImage(id: string): Promise<MessageImageData> {
  const hit = cache.get(id)
  if (hit) {
    cache.delete(id)
    cache.set(id, hit)
    return Promise.resolve(hit)
  }
  const pending = inFlight.get(id)
  if (pending) return pending
  const request = window.refract.images
    .get(id)
    .then((result) => {
      if (!result.ok) throw new Error(result.error.code)
      const data = result.value
      cache.set(id, data)
      totalChars += data.dataUrl.length
      // Evict oldest first, but never the entry just added.
      while (cache.size > 1 && (cache.size > MAX_ENTRIES || totalChars > MAX_TOTAL_CHARS)) {
        const oldest = cache.keys().next().value as string
        totalChars -= cache.get(oldest)?.dataUrl.length ?? 0
        cache.delete(oldest)
      }
      return data
    })
    .finally(() => inFlight.delete(id))
  inFlight.set(id, request)
  return request
}
