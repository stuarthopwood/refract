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

  it('titles a lone document tab by its path with the folder muted ahead of the file name, and names its close button from the kind', () => {
    const html = render([], [file('src/deep/index.ts')])
    expect(html).toContain('title="src/deep/index.ts"')
    expect(html).toMatch(/<span class="min-w-0 truncate text-muted-foreground">src\/deep\/<\/span><span class="max-w-full shrink-0 truncate">index\.ts<\/span><\/h2>/)
    expect(html).toContain('aria-label="Close index.ts file"')
  })

  it('titles a lone root-level document tab by its name alone', () => {
    const html = render([], [file('README.md')])
    expect(html).not.toContain('truncate text-muted-foreground')
    expect(html).toContain('>README.md</span></h2>')
  })

  it('pins panel tabs before one vertical separator and the document tabs', () => {
    const html = render(['outline', 'file-explorer'], [file('a.ts'), file('b.ts')])
    expect(html.match(/data-slot="separator"/g)).toHaveLength(1)
    const separator = html.indexOf('data-slot="separator"')
    expect(html).toContain('data-orientation="vertical"')
    expect(html.indexOf('>Outline<')).toBeLessThan(separator)
    expect(html.indexOf('>a.ts<')).toBeGreaterThan(separator)
  })

  it('gives the strip one horizontal scroller, on the tablist, and lets panel tabs shrink while document tabs keep their width', () => {
    const html = render(['outline', 'file-explorer'], [file('a.ts'), file('b.ts')])
    expect(html.match(/overflow-x-auto/g)).toHaveLength(1)
    expect(html).toMatch(/role="tablist"[^>]*class="[^"]*overflow-x-auto/)
    expect(html).toMatch(/<div role="presentation" class="flex min-w-0 shrink items-center gap-1"><div role="presentation" class="flex min-w-0 shrink items-center">/)
    expect(html).toMatch(/<div role="presentation" class="flex shrink-0 items-center gap-1"><div role="presentation" class="flex min-w-0 shrink items-center"><button[^>]*aria-label="File, a\.ts"/)
    expect(html).toMatch(/class="[^"]*min-w-15 shrink[^"]*"/)
  })

  it('omits the separator when there are no document tabs', () => {
    expect(render(['outline', 'file-explorer'], [])).not.toContain('data-slot="separator"')
  })

  it('renders each tab and its close button as siblings inside a presentation wrapper', () => {
    const html = render(['outline'], [file('a.ts')])
    expect(html).toMatch(/<div role="presentation" class="flex min-w-0 shrink items-center"><button[^>]*role="tab"[^>]*>(?:(?!<\/button>)[^])*<\/button><button[^>]*aria-label="Close a\.ts file"/)
  })

  it('marks a no-longer-changed diff tab in its name and a muted colour, not by dimming', () => {
    const dead: DocumentTab = { kind: 'diff', group: 'changes', path: 'a.ts', id: 'diff:a.ts', dead: true }
    const html = render(['outline'], [dead])
    expect(html).toContain('aria-label="Diff, a.ts, unstaged, no longer changed"')
    expect(html).toMatch(/aria-label="Diff, a\.ts[^"]*"[^>]*class="[^"]*\bitalic\b[^"]*\btext-muted-foreground\b/)
    expect(html).not.toContain('opacity-70')
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
