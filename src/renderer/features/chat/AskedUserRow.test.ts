// Dispatch coverage (T502): every finished ask, whichever source wrote it, reaches the one Asked-user line.
// The repo has no jsdom, so the row is rendered to a string; the expanded view is covered in AskedUserLine.test.ts. Dispatch cases render with "Expand answered questions" off so the digest is asserted (#1747).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TranscriptItem } from '../../../shared/model'

// The row renders questions through the real Markdown renderer (#2033); the state barrel it imports needs a browser `window`, so it is stubbed.
vi.mock('@/state', () => ({
  notifyPersistentError: vi.fn(),
  useSyntaxTheme: () => 'github-dark',
  useSessionsStore: (select: (state: { sessions: [] }) => unknown) => select({ sessions: [] })
}))
import { AskedUserRow } from './AskedUserRow'

const display = vi.hoisted(() => ({ expandAnsweredAsks: false }))
vi.mock('@/state', () => ({
  useSettingsStore: (select: (s: { settings: object }) => unknown) => select({ settings: { transcriptDisplay: display } })
}))

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

function tool(partial: Partial<ToolItem>): ToolItem {
  return { kind: 'tool', id: 'a1', toolCallId: 'c1', tool: 'refract_ask', target: '', status: 'done', args: undefined, ...partial }
}

function render(item: ToolItem, expandAnsweredAsks = false): string {
  display.expandAnsweredAsks = expandAnsweredAsks
  return renderToStaticMarkup(createElement(AskedUserRow, { item }))
}

const DB_ARGS = { questions: [{ id: 'db', question: 'Which database?', options: [{ label: 'Postgres', recommended: true }, { label: 'MySQL' }] }] }
const HTML = '<fieldset><legend>Which language?</legend><label><input type="radio" name="lang" value="TS">TS</label></fieldset>'

describe('ask row dispatch to the Asked-user line (FR-139)', () => {
  it('Given a refract_ask answered with a note, When rendered, Then the collapsed card shows the digest and the note', () => {
    const details = { results: [{ id: 'db', selectedOptions: ['Postgres'], notes: [{ option: 'Postgres', text: 'use v16' }] }] }
    const html = render(tool({ args: DB_ARGS, details }))
    expect(html).toContain('Questions from the agent · 1 answered')
    expect(html).toContain('→ Postgres')
    expect(html).toContain('use v16')
    expect(html).toContain('aria-expanded="false"')
  })

  it('Given a refract_ask Away Mode answered, When rendered, Then the header says so', () => {
    const details = { results: [{ id: 'db', selectedOptions: ['Postgres'], byAway: true }] }
    expect(render(tool({ args: DB_ARGS, details }))).toContain('1 answered by Away Mode')
  })

  it('Given a cancelled refract_ask, When rendered, Then the header reads cancelled and the row reads → no answer', () => {
    const html = render(tool({ args: DB_ARGS, output: 'The developer cancelled the questions.' }))
    expect(html).toContain('Questions from the agent · cancelled')
    expect(html).toContain('→ no answer')
  })

  it('Given a timed-out refract_ask, When rendered, Then the header reads timed out', () => {
    expect(render(tool({ args: DB_ARGS, details: { results: [{ id: 'db', timedOut: true }] } }))).toContain('· timed out')
  })

  it('Given an HTML-form ask with saved answers, When rendered, Then the same card shows the answer', () => {
    const details = { answers: [{ name: 'lang', question: 'Which language?', answer: 'TS' }] }
    const html = render(tool({ tool: 'ask', args: { html: HTML }, details }))
    expect(html).toContain('Questions from the agent · 1 answered')
    expect(html).toContain('→ TS')
  })

  it('Given a timed-out HTML-form ask, When rendered, Then it is the Asked-user line with timed out and → no answer', () => {
    const html = render(tool({ tool: 'ask', args: { html: HTML }, details: { timedOut: true } }))
    expect(html).toContain('Questions from the agent · timed out')
    expect(html).toContain('→ no answer')
    expect(html).not.toContain('Timed out, no answer')
  })

  it('Given an old native ask with a timed-out answer, When rendered, Then it renders through the same card', () => {
    const args = { questions: [{ id: 'db', question: 'Which database?', options: ['Postgres', 'MySQL'], recommended: 0 }] }
    const html = render(tool({ tool: 'ask', args, details: { selectedOptions: ['Postgres'], timedOut: true } }))
    expect(html).toContain('timed out, recommended answers applied')
    expect(html).toContain('→ Postgres')
  })
})

describe('answered ask rows follow Expand answered questions (#1747)', () => {
  const answered = { results: [{ id: 'db', selectedOptions: ['Postgres'] }] }

  it('Given the setting on, When an answered ask renders, Then it is open and announces aria-expanded true', () => {
    const html = render(tool({ args: DB_ARGS, details: answered }), true)
    expect(html).toMatch(/<button[^>]*aria-expanded="true"/)
    expect(html).toContain('Collapse')
    expect(html).toContain('Postgres')
    expect(html).not.toContain('data-asked-digest')
  })

  it('Given the setting off, When an answered ask renders, Then it is the collapsed digest with aria-expanded false', () => {
    const html = render(tool({ args: DB_ARGS, details: answered }), false)
    expect(html).toMatch(/<button[^>]*aria-expanded="false"/)
    expect(html).toContain('data-asked-digest')
  })

  it('Given the setting on, When a cancelled ask renders, Then it stays collapsed', () => {
    const html = render(tool({ args: DB_ARGS, output: 'The developer cancelled the questions.' }), true)
    expect(html).toMatch(/<button[^>]*aria-expanded="false"/)
  })
})
