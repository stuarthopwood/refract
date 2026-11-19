// The repo has no jsdom, and zustand hooks read their initial state on the server, so the
// store-free PanelTabStrip view is rendered to a string with items passed in.
import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// The state barrel touches `window` at import. A vi.mock factory is hoisted above static
// imports, so the real stores can only be pulled in with a dynamic import here.
vi.mock('@/state', async () => ({
  ...(await import('@/state/git-changes-store')),
  ...(await import('@/state/right-pane-store')),
  ...(await import('@/state/readout-store')),
  useSettingsStore: () => undefined
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import type { DocumentTab } from '@/state/document-tabs-store'
import { PanelTabStrip } from './PanelTabBar'
import type { PanelId } from './panel-registry'
import { buildTabItems } from './tab-items'

const file = (path: string): DocumentTab => ({ kind: 'file', path, id: `file:${path}`, dead: false })

function render(panels: PanelId[], documents: DocumentTab[], activeKey: string | null = null): string {
  const labels = Object.fromEntries(documents.map((tab) => [tab.id, tab.path.split('/').pop() ?? tab.path]))
  const strip = createElement(PanelTabStrip, {
    sessionId: 's1',
    items: buildTabItems(panels, documents),
    labels,
    activeKey,
    wrapperRef: createRef<HTMLDivElement>(),
    tabListRef: createRef<HTMLDivElement>(),
    tabRefs: { current: {} },
    onSelect: () => undefined,
    onClose: () => undefined,
    onKeyDown: () => undefined
  })
  return renderToStaticMarkup(createElement(TooltipProvider, null, strip))
}

describe('PanelTabStrip', () => {
  it('shows a title row, not a tablist, for a lone panel tab', () => {
    const html = render(['outline'], [])
    expect(html).not.toContain('role="tablist"')
    expect(html).toContain('id="right-pane-panel-title"')
    expect(html).toContain('aria-label="Close Outline panel"')
  })

  it('titles a lone document tab by its full path and names its close button from the kind', () => {
    const html = render([], [file('src/deep/index.ts')])
    expect(html).toContain('>src/deep/index.ts</h2>')
    expect(html).toContain('aria-label="Close index.ts file"')
  })

  it('pins panel tabs before one aria-hidden separator and the scrolling document container', () => {
    const html = render(['outline', 'file-explorer'], [file('a.ts'), file('b.ts')])
    expect(html.match(/aria-hidden="true" class="mx-1 h-4 w-px/g)).toHaveLength(1)
    const separator = html.indexOf('mx-1 h-4 w-px')
    expect(html.indexOf('>Outline<')).toBeLessThan(separator)
    expect(html.indexOf('>a.ts<')).toBeGreaterThan(separator)
    expect(html.indexOf('overflow-x-auto')).toBeGreaterThan(separator)
  })

  it('omits the separator when there are no document tabs', () => {
    expect(render(['outline', 'file-explorer'], [])).not.toContain('mx-1 h-4 w-px')
  })

  it('renders each tab and its close button as siblings inside a presentation wrapper', () => {
    const html = render(['outline'], [file('a.ts')])
    expect(html).toMatch(/<div role="presentation" class="flex shrink-0 items-center"><button[^>]*role="tab"[^>]*>(?:(?!<\/button>)[^])*<\/button><button[^>]*aria-label="Close a\.ts file"/)
  })

  it('sizes document tabs min-w-28 max-w-48 shrink-0 and leads with a type icon', () => {
    const html = render(['outline'], [file('a.ts')])
    expect(html).toMatch(/class="[^"]*min-w-28 max-w-48 shrink-0[^"]*"/)
    expect(html).toContain('lucide-file')
  })

  it('marks only the active document tab selected, tabbable and controlling its panel', () => {
    const html = render(['outline'], [file('a.ts'), file('b.ts')], 'file:b.ts')
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*aria-controls="[^"]+-panel"[^>]*aria-label="File, b\.ts"[^>]*tabindex="0"/)
  })

  it('keeps the All tabs control outside the tablist, mounted even with no document tabs', () => {
    const html = render(['outline', 'file-explorer'], [])
    expect(html.indexOf('aria-label="All tabs"')).toBeGreaterThan(html.indexOf('</div></div><button'))
  })
})
