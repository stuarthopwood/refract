import type { GitHubAccount } from '../../../shared/accounts'

export function rowKey(host: string, login: string): string {
  return `${host}:${login}`
}

export function focusButton(el: HTMLElement | null | undefined): boolean {
  if (!el || !document.body.contains(el)) return false
  el.focus()
  return document.activeElement === el
}

/** Retries `preferred` on animation frames until its target exists, then falls back. */
export function focusWhenReady(preferred: () => boolean, fallback?: () => boolean, tries = 12): void {
  requestAnimationFrame(() => {
    if (preferred()) return
    if (tries <= 1) {
      fallback?.()
      return
    }
    focusWhenReady(preferred, fallback, tries - 1)
  })
}

export function isUnreachable(account: GitHubAccount): boolean {
  return account.problem === 'unreachable' || account.state === 'timeout'
}

/** A ref callback that registers the element in `map` under `key` and removes it on unmount. */
export function mapRef<T extends HTMLElement>(map: Map<string, T>, key: string): (el: T | null) => void {
  return (el) => {
    if (el) map.set(key, el)
    else map.delete(key)
  }
}
