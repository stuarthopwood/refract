// Agent/tool Markdown can contain links or images whose href/src is not really a web URL:
// relative (`/C:/Windows/System32/calc.exe`), protocol-relative (`//host/share/x.exe`),
// `file:`, `mailto:`, `javascript:`, `data:`, or an unknown scheme. In the production renderer
// (a `file://` origin) a relative or protocol-relative href resolves to a local file path, which
// a security review found can reach main's `shell.openExternal` as a `file:` URL. Only an
// absolute `http:`/`https:` URL is safe to ever expose as a clickable link.
//
// `new URL(href)` with no base throws for anything that is not already an absolute URL (that is
// exactly what rejects relative and protocol-relative hrefs here); everything else is filtered by
// checking the parsed protocol.
export function safeUrl(href: string | null | undefined): string | undefined {
  if (!href) return undefined
  let parsed: URL
  try {
    parsed = new URL(href)
  } catch {
    return undefined
  }
  return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? href : undefined
}
