import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/state', () => ({
  useSettingsStore: (select: (state: { settings: object }) => unknown) => select({ settings: {} })
}))

import { Collapsible } from '@/components/ui/collapsible'
import { TooltipProvider } from '@/components/ui/tooltip'
import { GroupHeaderTrigger } from './GroupHeader'
import type { ActiveSessionEntry } from './sessionDisplay'

const TWO: ActiveSessionEntry[] = [
  { id: 'a', name: 'Refract Dev Team', line: 'Waiting for 2 subagents' },
  { id: 'b', name: 'Docs', line: 'Working...' }
]

function render(props: Partial<Parameters<typeof GroupHeaderTrigger>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(Collapsible, { open: false }, createElement(GroupHeaderTrigger, { label: 'Refract', ...props }))
    )
  )
}

describe('GroupHeaderTrigger active-Session badge (issue #1854, FR-193)', () => {
  it('shows the count in a shared Badge when Sessions are active', () => {
    const html = render({ activeSessions: TWO })
    expect(html).toMatch(/<span[^>]*data-slot="badge"[^>]*>2<\/span>/)
  })

  it('shows no badge without active Sessions', () => {
    expect(render({ activeSessions: [] })).not.toContain('data-slot="badge"')
    expect(render()).not.toContain('data-slot="badge"')
  })

  it('names the count and every Session in the trigger accessible name', () => {
    const html = render({ activeSessions: TWO })
    expect(html).toContain('aria-label="Refract, 2 active Sessions: Refract Dev Team: Waiting for 2 subagents; Docs: Working..."')
  })

  it('hides the badge from assistive tech so the name is not read twice', () => {
    expect(render({ activeSessions: TWO })).toMatch(/data-slot="badge"[^>]*aria-hidden="true"|aria-hidden="true"[^>]*data-slot="badge"/)
  })

  it('keeps the waiting marker in its own right-aligned column after the badge (#908)', () => {
    const html = render({ activeSessions: TWO, marker: { status: 'needs-you', label: 'Needs you' } })
    const badgeAt = html.indexOf('data-slot="badge"')
    const markerAt = html.indexOf('ml-auto')
    expect(badgeAt).toBeGreaterThan(-1)
    expect(markerAt).toBeGreaterThan(badgeAt)
    expect(html).toContain('2 active Sessions')
    expect(html).toContain('Needs you')
  })

  it('does not reserve badge space in the marker span', () => {
    const html = render({ activeSessions: TWO, marker: { status: 'needs-you', label: 'Needs you' } })
    const markerSpan = html.slice(html.indexOf('ml-auto'))
    expect(markerSpan).not.toContain('data-slot="badge"')
  })
})
