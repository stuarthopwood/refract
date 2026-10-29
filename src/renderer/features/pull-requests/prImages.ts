// Image access for the Pull requests view (spec 038, ADR 0004): every image, avatar or Markdown,
// goes through the main-process allow-listed proxy and comes back as a `data:` URL; nothing here
// ever hands a remote URL to the renderer.
import { useEffect, useState } from 'react'

const IMAGE_CACHE_LIMIT = 50
const imageCache = new Map<string, Promise<string | null>>()

/** Stable (module-level) so `Markdown`'s memoised options never change between renders. */
export function resolvePullRequestImage(url: string): Promise<string | null> {
  let cached = imageCache.get(url)
  if (cached) {
    // Re-insert so the Map's insertion order tracks recency (LRU).
    imageCache.delete(url)
    imageCache.set(url, cached)
    return cached
  }
  const pending: Promise<string | null> = window.refract.pullRequests
    .fetchImage(url)
    .then((result) => (result.ok ? result.value.dataUrl : null))
    .catch(() => null)
  imageCache.set(url, pending)
  if (imageCache.size > IMAGE_CACHE_LIMIT) {
    const oldest = imageCache.keys().next().value
    if (oldest !== undefined) imageCache.delete(oldest)
  }
  void pending.then((value) => {
    if (value === null && imageCache.get(url) === pending) imageCache.delete(url)
  })
  return pending
}

/** The Markdown props every PR surface (timeline, editor Preview) shares; one stable reference. */
export const PREVIEW_PROPS = { githubStyle: true, resolveImage: resolvePullRequestImage } as const

/** The avatar's `data:` URL once fetched, or null while loading or on failure (initials show). */
export function useAvatarDataUrl(avatarUrl: string | null): string | null {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  useEffect(() => {
    setDataUrl(null)
    if (!avatarUrl) return
    let cancelled = false
    void resolvePullRequestImage(avatarUrl).then((value) => {
      if (!cancelled) setDataUrl(value)
    })
    return () => {
      cancelled = true
    }
  }, [avatarUrl])
  return dataUrl
}
