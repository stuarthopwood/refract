// A small inert HTML reader. It builds a tree of plain objects from agent-supplied markup and
// never touches the DOM, so nothing in the markup can run, load, or reach the page.

export interface HtmlText {
  readonly type: 'text'
  readonly text: string
  readonly parent: HtmlElement | null
}

export interface HtmlElement {
  readonly type: 'element'
  readonly tag: string
  readonly attrs: ReadonlyMap<string, string>
  readonly children: HtmlNode[]
  readonly parent: HtmlElement | null
}

export type HtmlNode = HtmlText | HtmlElement

const VOID_TAGS: Record<string, true> = { area: true, base: true, br: true, col: true, embed: true, hr: true, img: true, input: true, link: true, meta: true, source: true, track: true, wbr: true }
// Script and style bodies are dropped; textarea and title bodies are kept as plain text.
const RAW_TEXT_TAGS: Record<string, true> = { script: true, style: true, textarea: true, title: true }
const DROPPED_RAW_TAGS: Record<string, true> = { script: true, style: true }
// Controls and script-like elements contribute no label text.
const NON_TEXT_TAGS: Record<string, true> = { input: true, textarea: true, select: true, button: true, script: true, style: true }
const CONTROL_TAGS: Record<string, true> = { input: true, textarea: true, select: true, button: true }
const MAX_DEPTH = 128

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }
const TAG_NAME = /^<([a-zA-Z][^\s/>]*)/
const END_TAG = /^<\/([a-zA-Z][^\s/>]*)[^>]*>?/
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`=]+)))?/y

function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (match, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? match
    const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? '', 16)
    const valid = Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
    return valid ? String.fromCodePoint(code) : '\ufffd'
  })
}

function readStartTag(html: string, start: number): { tag: string; attrs: Map<string, string>; selfClosing: boolean; end: number } | null {
  const name = TAG_NAME.exec(html.slice(start, start + 64))
  if (!name) return null
  const attrs = new Map<string, string>()
  let pos = start + name[0].length
  let selfClosing = false
  while (pos < html.length) {
    const ch = html.charAt(pos)
    if (ch === '>') {
      selfClosing = html[pos - 1] === '/'
      pos += 1
      break
    }
    if (ch === '/' || /\s/.test(ch)) {
      pos += 1
      continue
    }
    ATTRIBUTE.lastIndex = pos
    const attr = ATTRIBUTE.exec(html)
    if (!attr) {
      pos += 1
      continue
    }
    const key = (attr[1] ?? '').toLowerCase()
    // HTML keeps the first of a duplicated attribute.
    if (!attrs.has(key)) attrs.set(key, decodeEntities(attr[2] ?? attr[3] ?? attr[4] ?? ''))
    pos = ATTRIBUTE.lastIndex
  }
  return { tag: (name[1] ?? '').toLowerCase(), attrs, selfClosing, end: pos }
}

export function parseHtmlTree(html: string): HtmlElement {
  const root: HtmlElement = { type: 'element', tag: '#root', attrs: new Map(), children: [], parent: null }
  const stack: HtmlElement[] = [root]
  const lower = html.toLowerCase()
  const top = (): HtmlElement => stack[stack.length - 1] ?? root
  const pushText = (text: string) => {
    if (text) top().children.push({ type: 'text', text, parent: top() })
  }
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt === -1) {
      pushText(decodeEntities(html.slice(i)))
      break
    }
    if (lt > i) pushText(decodeEntities(html.slice(i, lt)))
    i = lt
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4)
      i = end === -1 ? html.length : end + 3
      continue
    }
    if (html[i + 1] === '!' || html[i + 1] === '?') {
      const end = html.indexOf('>', i)
      i = end === -1 ? html.length : end + 1
      continue
    }
    if (html[i + 1] === '/') {
      const close = END_TAG.exec(html.slice(i, i + 64))
      if (!close) {
        pushText('<')
        i += 1
        continue
      }
      const tag = (close[1] ?? '').toLowerCase()
      const at = stack.map((el) => el.tag).lastIndexOf(tag)
      if (at > 0) stack.length = at
      const end = html.indexOf('>', i)
      i = end === -1 ? html.length : end + 1
      continue
    }
    const start = readStartTag(html, i)
    if (!start) {
      pushText('<')
      i += 1
      continue
    }
    i = start.end
    const el: HtmlElement = { type: 'element', tag: start.tag, attrs: start.attrs, children: [], parent: top() }
    top().children.push(el)
    if (RAW_TEXT_TAGS[start.tag] && !start.selfClosing) {
      const close = lower.indexOf(`</${start.tag}`, i)
      const bodyEnd = close === -1 ? html.length : close
      if (!DROPPED_RAW_TAGS[start.tag]) {
        // The HTML parser drops one newline right after a textarea start tag.
        const body = html.slice(i, bodyEnd).replace(/^\r?\n/, '')
        if (body) el.children.push({ type: 'text', text: decodeEntities(body), parent: el })
      }
      i = bodyEnd
      continue
    }
    if (!VOID_TAGS[start.tag] && !start.selfClosing && stack.length < MAX_DEPTH) stack.push(el)
  }
  return root
}

export function* descendantElements(node: HtmlElement): Generator<HtmlElement> {
  for (const child of node.children) {
    if (child.type !== 'element') continue
    yield child
    yield* descendantElements(child)
  }
}

export function containsControl(node: HtmlNode): boolean {
  if (node.type === 'text') return false
  if (CONTROL_TAGS[node.tag]) return true
  return node.children.some(containsControl)
}

export function closestAncestor(node: HtmlNode, tag: string): HtmlElement | null {
  for (let cur = node.parent; cur; cur = cur.parent) if (cur.tag === tag) return cur
  return null
}

/** Visible text with whitespace collapsed; control elements contribute nothing. */
export function textContent(node: HtmlNode): string {
  const parts: string[] = []
  const walk = (n: HtmlNode) => {
    if (n.type === 'text') parts.push(n.text)
    else if (!NON_TEXT_TAGS[n.tag]) n.children.forEach(walk)
  }
  walk(node)
  return parts.join('').replace(/\s+/g, ' ').trim()
}
