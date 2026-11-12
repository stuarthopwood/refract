import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TranscriptItem } from '../../../shared/model'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AdvisoryRow } from './AdvisoryRow'

// The real `@/state` wires stores to `window` at import time, which this node-environment suite lacks.
vi.mock('@/state', () => ({
  notify: vi.fn(),
  useSessionsStore: (select: (state: { sessions: unknown[] }) => unknown) => select({ sessions: [] })
}))

type AdvisoryItem = Extract<TranscriptItem, { kind: 'advisory' }>

function render(severity: AdvisoryItem['severity']): string {
  const item: AdvisoryItem = { kind: 'advisory', id: `a-${severity}`, severity, text: 'Check the migration.' } as AdvisoryItem
  return renderToStaticMarkup(
    React.createElement(TooltipProvider, null, React.createElement(AdvisoryRow, { item, sessionId: undefined, onQueuedAnnounce: () => {} }))
  )
}

// Matches the opening tag of the element carrying `attr`, so a class on the wrapper is told apart from one on the body.
function openingTag(html: string, attr: string): string {
  return html.match(new RegExp(`<[^>]*${attr}[^>]*>`))?.[0] ?? ''
}

describe('AdvisoryRow severity stripe (#1876)', () => {
  it.each(['blocker', 'concern'] as const)('keeps the %s stripe off the card wrapper that holds the header', (severity) => {
    expect(openingTag(render(severity), 'data-advisory-severity')).not.toContain('before:')
  })

  it('draws the blocker stripe on the expanded body in the error colour', () => {
    const body = openingTag(render('blocker'), 'data-slot="collapsible-content"')
    expect(body).toContain('before:bg-severity-error')
    expect(body).not.toContain('hidden')
  })

  it('hides the concern body, and so its stripe, while the card is collapsed', () => {
    const body = openingTag(render('concern'), 'data-slot="collapsible-content"')
    expect(body).toContain('before:bg-severity-warning')
    expect(body).toContain('hidden')
  })
})
