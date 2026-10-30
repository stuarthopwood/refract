// Agent/tool Markdown can contain links or images whose href/src is not really a web URL.
export function safeUrl(href: string | null | undefined): string | undefined {
  if (!href) return undefined
  let parsed: URL
  try {
    parsed = new URL(href)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined
  if (parsed.username || parsed.password) return undefined
  return parsed.href
}
