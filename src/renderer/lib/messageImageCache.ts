import type { MessageImageData } from '../../shared/ipc-images'

const MAX_ENTRIES = 16
const cache = new Map<string, MessageImageData>()
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
      if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string)
      return data
    })
    .finally(() => inFlight.delete(id))
  inFlight.set(id, request)
  return request
}
