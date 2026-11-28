import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TranscriptItem } from '../../../shared/model'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AdvisoryRow } from './AdvisoryRow'

const seed = vi.hoisted(() => ({ pending: 0 }))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: ((initial: unknown) => {
      if (seed.pending > 0 && typeof initial === 'boolean') {
        seed.pending -= 1
        return actual.useState(true)
      }
      return actual.useState(initial as never)
    }) as typeof actual.useState
  }
})
// The real `@/state` wires stores to `window` at import time, which this node-environment suite lacks.
vi.mock('@/state', () => ({
  notify: vi.fn(),
  useSessionsStore: (select: (state: { sessions: unknown[] }) => unknown) => select({ sessions: [] })
}))

type AdvisoryItem = Extract<TranscriptItem, { kind: 'advisory' }>

// `forceOpen` seeds the open state to true, since a static render cannot click the trigger: a blocker's own `open` is the first boolean `useState`; a nit row skips its own `open` and `asking` states, so its collapsible's is the third.
function render(severity: AdvisoryItem['severity'], forceOpen = false, extra: Partial<AdvisoryItem> = {}): string {
  const item: AdvisoryItem = { kind: 'advisory', id: `a-${severity}`, severity, text: 'Check the migration.', ...extra } as AdvisoryItem
  seed.pending = forceOpen ? (severity === 'nit' ? 3 : 1) : 0
  try {
    return renderToStaticMarkup(
      React.createElement(TooltipProvider, null, React.createElement(AdvisoryRow, { item, sessionId: undefined, onQueuedAnnounce: () => {} }))
    )
  } finally {
    seed.pending = 0
  }
}

// Matches the opening tag of the element carrying `attr`, so a class on the wrapper is told apart from one on the body.
function openingTag(html: string, attr: string): string {
  return html.match(new RegExp(`<[^>]*${attr}[^>]*>`))?.[0] ?? ''
}

describe('AdvisoryRow severity stripe (#1876)', () => {
  // Opened, so a wrapper that still carried the stripe while expanded (the pre-fix behaviour) fails here.
  it.each(['blocker', 'concern'] as const)('keeps the %s stripe off the card wrapper while the card is open', (severity) => {
    const html = render(severity, true)
    expect(openingTag(html, 'data-slot="collapsible-content"')).toContain('data-state="open"')
    expect(openingTag(html, 'data-advisory-severity')).not.toContain('before:')
  })

  it('draws the blocker stripe on the expanded body in the error colour', () => {
    const body = openingTag(render('blocker'), 'data-slot="collapsible-content"')
    expect(body).toContain('before:bg-severity-error')
    expect(body).toContain('data-state="open"')
  })

  it('hides the concern body, and so its stripe, while the card is collapsed', () => {
    const body = openingTag(render('concern'), 'data-slot="collapsible-content"')
    expect(body).toContain('before:bg-severity-warning')
    expect(body).toContain('data-state="closed"')
  })
})

describe('AdvisoryRow body renders Markdown at the chat line height (#360, FR-222)', () => {
  const markdown = { text: 'Run `pnpm test` first:\n\n1. Fix the type error\n2. Rerun', guidance: 'Prefer `readFile` over a shell `cat`.' }

  it('renders the message and guidance as code spans and a list, not raw characters', () => {
    const html = render('blocker', true, markdown)
    expect(html).toContain('>pnpm test</code>')
    expect(html).toContain('>readFile</code>')
    expect(html).toContain('<ol class="list-decimal')
  })

  it('gives the message and the guidance the shared chat leading, not the plain text-sm one', () => {
    const html = render('blocker', true, markdown)
    expect(html.match(/leading-chat/g)?.length).toBe(2)
    expect(html).not.toContain('whitespace-pre-wrap text-sm')
  })

  it('renders a nit body the same way once expanded', () => {
    const html = render('nit', true, markdown)
    expect(html).toContain('>pnpm test</code>')
    expect(html).toContain('leading-chat')
  })
})
