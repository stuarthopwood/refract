// External-link policy (issue #793 security baseline): the renderer (shared, unchanged) renders
// ordinary `<a target="_blank">` links (`Markdown.tsx`, `ReadoutChip.tsx`, the profile/PR panes)
// trusting Electron's own `setWindowOpenHandler`/`openExternalSafe` (`src/main/index.ts`) to open
// them in the system browser and silently drop anything that is not `http:`/`https:`. Tauri/wry
// has no `on_new_window` handler registered (`lib.rs`'s own security comment: a same-window
// navigation to a remote origin is denied separately by `is_allowed_navigation_url`), so a
// `target="_blank"` click here would otherwise just be swallowed with no visible effect. This
// capture-phase listener is the Tauri-build equivalent: the opener plugin's own `open_url`
// command, scoped in `capabilities/default.json` to `http`/`https` only (narrower than the
// plugin's own `allow-default-urls`, which also permits `mailto:`/`tel:`).
import { invoke } from '@tauri-apps/api/core'

/** Always prevents the default `target="_blank"` action (matching Electron's own
 * `setWindowOpenHandler`, which ALWAYS denies the native new-window request), then conditionally
 * opens the link through the opener plugin only when it parses as `http:`/`https:` -- anything
 * else (a malformed string, `mailto:`, `javascript:`, ...) is silently dropped, never logged with
 * the URL itself (privacy, matching `openExternalSafe`). */
export function installExternalLinkHandler(): void {
  document.addEventListener(
    'click',
    (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const anchor = (event.target as Element | null)?.closest?.('a[href][target="_blank"]')
      if (!(anchor instanceof HTMLAnchorElement)) return
      event.preventDefault()
      let protocol: string
      try {
        protocol = new URL(anchor.href, window.location.href).protocol
      } catch {
        return
      }
      if (protocol === 'http:' || protocol === 'https:') {
        void invoke('plugin:opener|open_url', { url: anchor.href, with: null })
      }
    },
    true
  )
}
