// External-link policy (issue #793 security baseline): the renderer renders ordinary
// `<a target="_blank">` links (`Markdown.tsx`, `ReadoutItem.tsx`, the profile/PR panes) and relies on
// this listener to open them in the system browser and silently drop anything that is not
// `http:`/`https:`. `tauri_plugin_opener`'s own `init()` defaults to `open_js_links_on_click(true)`, which injects ITS OWN `<a>`-click
// interceptor, unscoped beyond whatever capability the renderer is granted. This capture-phase
// listener REPLACES that script (`lib.rs` now builds the plugin with `open_js_links_on_click
// (false)`, so this is the ONLY interceptor a link click ever reaches), narrowed to the exact
// `http`/`https`-only scope `capabilities/default.json` grants (narrower than the plugin's own
// `allow-default-urls`, which also permits `mailto:`/`tel:`); the native new-window path is always
// denied and the link opens externally only when it passes that scope.
import { invoke } from '@tauri-apps/api/core'

/** Always prevents the default `target="_blank"` action, then conditionally
 * opens the link through the opener plugin only when it parses as `http:`/`https:` -- anything
 * else (a malformed string, `mailto:`, `javascript:`, ...) is silently dropped, never logged with
 * the URL itself (privacy). A left click (plain or modified --
 * Ctrl/Cmd/Shift/Alt, which a real browser would use to pick a new-tab/new-window variant this
 * app has none of) and a middle click (which Chromium reports as `auxclick`, not `click`) are
 * both handled the same way: there is no second window/tab for a modifier to target, so every
 * one of them just opens the link externally like a plain click would. */
function handlePointerEvent(event: MouseEvent): void {
  if (event.defaultPrevented || (event.button !== 0 && event.button !== 1)) return
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
}

export function installExternalLinkHandler(): void {
  document.addEventListener('click', handlePointerEvent, true)
  // Middle-click never fires `click` in Chromium/WebView2 -- only `auxclick` (and, unlike
  // `click`, `auxclick` is NOT cancelled by `preventDefault()` on a different event, so this
  // needs its own listener rather than relying on the one above).
  document.addEventListener('auxclick', handlePointerEvent, true)
}
