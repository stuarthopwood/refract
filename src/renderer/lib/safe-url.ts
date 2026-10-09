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
//
// Quality-gate fix (Sec/Verif Medium, issue #610 round 3): returns `parsed.href` (the URL
// object's own canonical serialization -- punycode host, every reserved/control/bidi-override
// character in the path, query and userinfo percent-encoded), never the original raw `href`
// string. The one caller that matters here is `Markdown.tsx`'s inline-code URL case: a bare
// `` `https://\u0430pple.com` `` (Cyrillic `\u0430`, not Latin `a`) typed in a code span reaches this
// function directly, with no prior markdown-level `normalizeUri` pass to percent-encode it first
// (unlike a real markdown `href`/`src`, which `remark`/`rehype` already normalize before
// `markdownUrlTransform` ever calls this). Returning the raw string let the tooltip/description
// display the homograph while Chromium actually navigated to the punycode `xn--` host --
// defeating decision 7's whole point ("the tooltip names the real destination"). Every other
// caller (`markdownUrlTransform`'s `a`/`img` hrefs) gets the identical canonical form too, which
// is never observably different from a well-formed href.
export function safeUrl(href: string | null | undefined): string | undefined {
  if (!href) return undefined
  let parsed: URL
  try {
    parsed = new URL(href)
  } catch {
    return undefined
  }
  return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined
}
