// The shared external-link listener (tauri-bridge/externalLinks.ts) is the one place a URL opens and the one place its
// http/https-only policy lives; this hands it a link click, so nothing else opens a URL itself.
export function openInBrowser(url: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.target = '_blank'
  anchor.rel = 'noreferrer noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}
