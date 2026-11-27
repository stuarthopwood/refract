// The repo has no jsdom: the card is rendered to a string and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AskedUserAnswer, AskedUserLineModel, AskedUserQuestion } from '@/features/chat/askedUserLine'

// The real Markdown renderer is under test (#2033); the state barrel it imports needs a browser `window`, so it is stubbed.
vi.mock('@/state', () => ({
  notifyPersistentError: vi.fn(),
  useSyntaxTheme: () => 'github-dark',
  useSessionsStore: (select: (state: { sessions: [] }) => unknown) => select({ sessions: [] })
}))
import { AskedUserLine } from './AskedUserLine'

const pick = (label: string, extra: Partial<AskedUserAnswer> = {}): AskedUserAnswer => ({ label, other: false, recommended: false, ...extra })
const question = (prompt: string, answers: AskedUserAnswer[] = [pick('Postgres')], multi = false): AskedUserQuestion => ({ prompt, multi, answers })
const ANSWERED: AskedUserLineModel = { status: 'answered', questions: [question('Which database?')] }

function render(model: AskedUserLineModel, open = false) {
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(AskedUserLine, { model, defaultOpen: open })))
}

/** The text of every element carrying `attribute`, in order. */
function textsOf(html: string, attribute: string): string[] {
  return [...html.matchAll(new RegExp(`<(\\w+)[^>]*${attribute}[^>]*>(.*?)</\\1>`, 'gs'))].map((match) => match[2]!.replace(/<[^>]+>/g, ''))
}

describe('AskedUserLine collapsed (FR-139)', () => {
  it('is collapsed by default behind a real button that reads Expand', () => {
    const html = render(ANSWERED)
    expect(html).toMatch(/<button[^>]*type="button"[^>]*aria-expanded="false"/)
    expect(html).toContain('Expand')
    expect(html).not.toContain('Collapse')
  })

  it('reads the header with a count and a success check', () => {
    const html = render({ status: 'answered', questions: [question('A?'), question('B?')] })
    expect(html).toContain('Questions from the agent · 2 answered')
    expect(html).toContain('text-severity-success')
  })

  it('shows one digest line per question with the prompt on the left and the arrowed answer on the right', () => {
    const html = render({ status: 'answered', questions: [question('Which database?'), question('Which cache?', [pick('Redis')])] })
    expect(html.match(/data-asked-digest/g)).toHaveLength(2)
    expect(html).toMatch(/class="min-w-0 flex-1 truncate">Which database\?<\/span>/)
    expect(html).toContain('→ Postgres')
    expect(html).toContain('→ Redis')
  })

  it('digests a multi-line prompt to its first line and keeps the rest out of the card', () => {
    const html = render({ status: 'answered', questions: [question('Which database?\nPostgres is the default.')] })
    expect(html).toContain('>Which database?</span>')
    expect(html).not.toContain('Postgres is the default.')
  })

  it('joins the picks of a multiple-choice question', () => {
    expect(render({ status: 'answered', questions: [question('Which?', [pick('A'), pick('B')], true)] })).toContain('→ A, B')
  })

  it('shows an option note in the warning colour', () => {
    const html = render({ status: 'answered', questions: [question('Which?', [pick('Postgres', { note: 'use v16 please' })])] })
    expect(html).toMatch(/text-severity-warning[^>]*><span class="sr-only">Note: <\/span>use v16 please</)
  })

  it('marks a recommended pick with a success star and a screen-reader label', () => {
    const html = render({ status: 'answered', questions: [question('Which?', [pick('Postgres', { recommended: true })])] })
    expect(html).toMatch(/data-recommended-mark[^>]*text-severity-success[^>]*><span aria-hidden="true">✦<\/span><span class="sr-only">Recommended<\/span>/)
  })

  it('renders no mark or note when the source has none', () => {
    const html = render(ANSWERED)
    expect(html).not.toContain('data-recommended-mark')
    expect(html).not.toContain('text-severity-warning')
  })

  it('shows → no answer for a question without an answer', () => {
    const html = render({ status: 'not-answered', questions: [question('Which?', [])] })
    expect(html).toContain('→ no answer')
    expect(html).toContain('Questions from the agent · not answered')
  })

  it('names Away Mode in the header and still shows a check', () => {
    const html = render({ status: 'answered-by-away', questions: [question('A?'), question('B?')] })
    expect(html).toContain('Questions from the agent · 2 answered by Away Mode')
  })

  it.each([
    ['cancelled', 'Questions from the agent · cancelled'],
    ['timed-out', 'Questions from the agent · timed out, recommended answers applied'],
    ['not-answered', 'Questions from the agent · not answered']
  ] as const)('reads %s in the header without a success check', (status, header) => {
    const html = render({ status, questions: [question('Which?')] })
    expect(html).toContain(header)
    expect(html).not.toContain('text-severity-success')
  })

  it('names the group from its first question so history cards tell apart', () => {
    expect(render(ANSWERED)).toContain('role="group" aria-label="Questions from the agent: Which database?"')
  })

  it('keeps a keyboard focus ring and a forced-colors outline on the programmatically focused card root', () => {
    const root = render(ANSWERED).match(/<div[^>]*role="group"[^>]*>/)?.[0] ?? ''
    expect(root).toContain('tabindex="-1"')
    expect(root).toContain('focus-visible:ring-(length:--focus-ring-width)')
    expect(root).toContain('focus-visible:ring-ring')
    expect(root).toContain('focus-visible:outline-hidden')
  })

  it('keeps the toggle name stable by hiding its Expand and Collapse text from assistive tech', () => {
    expect(render(ANSWERED)).toMatch(/<span aria-hidden="true"[^>]*>Expand<svg/)
    expect(render(ANSWERED, true)).toMatch(/<span aria-hidden="true"[^>]*>Collapse<svg/)
  })
})

describe('AskedUserLine expanded (FR-139)', () => {
  it('flips the button to Collapse with aria-expanded true and points it at the body', () => {
    const html = render(ANSWERED, true)
    expect(html).toMatch(/<button[^>]*aria-expanded="true"/)
    expect(html).toContain('Collapse')
    expect(html).not.toContain('Expand')
    const controls = html.match(/aria-controls="([^"]+)"/)?.[1]
    expect(controls).toBeTruthy()
    expect(html).toContain(`id="${controls}"`)
  })

  it('shows each question in full instead of the digest, with no peek, revise or edit controls', () => {
    const long = `${'q'.repeat(300)}\nsecond line`
    const html = render({ status: 'answered', questions: [question(long)] }, true)
    expect(html).not.toContain('data-asked-digest')
    expect(html).toContain('q'.repeat(300))
    expect(html).toContain('second line')
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(html).not.toMatch(/Revise|Edit|Peek/)
  })

  it('shows a checkmark per pick on a multiple-choice question only', () => {
    const multi = render({ status: 'answered', questions: [question('Which?', [pick('A'), pick('B')], true)] }, true)
    // One check in the header plus one per pick.
    expect(multi.match(/lucide-check/g)).toHaveLength(3)
    const single = render({ status: 'answered', questions: [question('Which?', [pick('A')])] }, true)
    expect(single.match(/lucide-check/g)).toHaveLength(1)
  })

  it('shows typed Other text verbatim as the answer', () => {
    const html = render({ status: 'answered', questions: [question('Which?', [pick('or SQLite\nwith WAL', { other: true })])] }, true)
    expect(textsOf(html, 'data-asked-answer')[0]).toContain('or SQLite\nwith WAL')
  })

  it('shows ✦ Recommended beside a recommended pick and Note: under its answer', () => {
    const html = render({ status: 'answered', questions: [question('Which?', [pick('Postgres', { recommended: true, note: 'use v16 please' })])] }, true)
    expect(html).toMatch(/<span aria-hidden="true">✦<\/span><span>Recommended<\/span>/)
    expect(html).toMatch(/text-severity-warning[^>]*>Note:<\/span> use v16 please/)
    expect(html.indexOf('Postgres')).toBeLessThan(html.indexOf('Note:'))
  })

  it('shows a note on each pick of a multiple-choice question under that pick', () => {
    const html = render({ status: 'answered', questions: [question('Which?', [pick('A', { note: 'first' }), pick('B', { note: 'second' })], true)] }, true)
    const answers = textsOf(html, 'data-asked-answer')
    expect(answers[0]).toContain('Note: first')
    expect(answers[1]).toContain('Note: second')
  })

  it('shows → no answer for a question without an answer', () => {
    const html = render({ status: 'cancelled', questions: [question('Which?', [])] }, true)
    expect(html).toContain('→ no answer')
    expect(html).not.toContain('data-asked-answer')
  })

  it('keeps the Away Mode header', () => {
    expect(render({ status: 'answered-by-away', questions: [question('Which?')] }, true)).toContain('1 answered by Away Mode')
  })

  it('uses theme tokens only, never a hex colour', () => {
    const html = render({ status: 'answered', questions: [question('Which?', [pick('A', { recommended: true, note: 'n' })])] }, true)
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})

describe('AskedUserLine expanded question renders as Markdown (#2033)', () => {
  const open = (prompt: string) => render({ status: 'answered', questions: [question(prompt)] }, true)

  it('renders a pipe table in the question as a table, not raw pipes', () => {
    const html = open('Which plan?\n\n| Plan | Cost |\n| --- | --- |\n| Fast | high |')
    expect(html).toContain('<table')
    expect(html).toContain('<th')
    expect(html).not.toContain('| Fast | high |')
  })

  it('keeps the digest of a collapsed card as plain first-line text', () => {
    const html = render({ status: 'answered', questions: [question('Which plan?\n\n| Plan | Cost |\n| --- | --- |')] })
    expect(html).not.toContain('<table')
    expect(html).toContain('>Which plan?</span>')
  })

  it('renders an unsafe link as plain text and never inlines an image', () => {
    const html = open('Go [here](javascript:alert(1))')
    // The card's aria-label quotes the raw prompt; only an href would be live.
    expect(html).not.toMatch(/href="javascript:/)
    expect(html).not.toContain('<a ')
    expect(open('![pic](https://example.com/i.png)')).not.toContain('<img')
  })

  it('renders a fenced code block in the question as a code block', () => {
    const html = open('Run this?\n\n```sh\nls -la\n```')
    expect(html).toContain('<pre')
    expect(html).not.toContain('```')
  })
})
