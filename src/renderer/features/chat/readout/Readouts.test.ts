// The repo has no jsdom, so the pill renders to a string and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
// `@/state` registers dev handles and listeners on `window` as it loads, so the stub must land before the imports run.
vi.hoisted(() => {
  const noop = (): void => undefined
  vi.stubGlobal('window', { addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) })
})

import { EMPTY_READOUT, useReadoutStore } from '@/state/readout-store'
import type { SubagentSummary } from '../../../../shared/model'
import { subagentSummary } from '../../subagents/viewModel/testFixtures'
import type { SubagentCount } from './subagentDerive'
import { useReadoutCard } from './useReadoutCard'
import { SubagentsReadout } from './Readouts'

// The real hook, wrapped so a test can read the `disabled` option the pill passes it.
vi.mock('./useReadoutCard', async (importOriginal) => {
  const actual = await importOriginal<{ useReadoutCard: typeof useReadoutCard }>()
  return { ...actual, useReadoutCard: vi.fn(actual.useReadoutCard) }
})

const SESSION = 's1'

// The pill counts the Session's registry list, so a test states its counts as one Stage of agents with those statuses.
function setCount(subagentCount: SubagentCount | null): void {
  const subagents = Object.entries(subagentCount ?? {}).flatMap(([status, count]) =>
    Array.from({ length: count }, (_, index) => subagentSummary({ id: `${status}-${index}`, nameOrTask: `${status}-${index}`, specIndex: index, status: status as SubagentSummary['status'] }))
  )
  const bySession = { [SESSION]: { readout: EMPTY_READOUT, subagents } }
  useReadoutStore.setState({ bySession })
  Object.assign(useReadoutStore.getInitialState(), { bySession })
}

const render = (): string => renderToStaticMarkup(createElement(SubagentsReadout, { sessionId: SESSION }))
const counts = (overrides: Partial<SubagentCount>): SubagentCount => ({ running: 0, finished: 0, exited: 0, failed: 0, cancelled: 0, ...overrides })
const cardDisabled = (): boolean | undefined => vi.mocked(useReadoutCard).mock.calls.at(-1)?.[0]?.disabled

beforeEach(() => {
  vi.mocked(useReadoutCard).mockClear()
  setCount(null)
})

describe('SubagentsReadout wording', () => {
  it('shows "N running" with no failure icon while an agent runs', () => {
    setCount(counts({ running: 2, finished: 1, failed: 1 }))
    const html = render()
    expect(html).toContain('aria-label="Open subagents panel (2 running)"')
    expect(html).toContain('2 running')
    expect(html).not.toContain('data-readout-warning')
  })

  it('shows "N failed" with the warning icon once the Stage settled with a failure', () => {
    setCount(counts({ failed: 2, finished: 3 }))
    const html = render()
    expect(html).toContain('aria-label="Open subagents panel (2 failed)"')
    expect(html).toContain('data-readout-warning')
  })

  it('shows "N exited" with the warning icon', () => {
    setCount(counts({ exited: 1 }))
    const html = render()
    expect(html).toContain('aria-label="Open subagents panel (1 exited)"')
    expect(html).toContain('data-readout-warning')
  })

  it('never says finished or shows a parked count', () => {
    setCount(counts({ running: 1, finished: 4 }))
    expect(render()).not.toMatch(/finished|parked/i)
    setCount(counts({ failed: 1, finished: 4 }))
    expect(render()).not.toMatch(/finished|parked/i)
  })

  it('renders no pill when only finished or cancelled agents remain, or there is no count', () => {
    for (const c of [null, counts({}), counts({ finished: 3 }), counts({ cancelled: 2 }), counts({ finished: 1, cancelled: 1 })]) {
      setCount(c)
      expect(render()).toBe('')
    }
  })
})

describe('SubagentsReadout announcement', () => {
  it('carries no live region, so a count change is never announced', () => {
    for (const c of [counts({ running: 1 }), counts({ failed: 1 })]) {
      setCount(c)
      expect(render()).not.toMatch(/aria-live|role="(?:status|alert)"/)
    }
  })

  it('hides the visible phrase from assistive tech and names the pill on the button, with the failure as text', () => {
    setCount(counts({ failed: 1 }))
    const html = render()
    expect(html).toMatch(/<button[^>]*aria-label="Open subagents panel \(1 failed\)"/)
    expect(html).toContain('<span aria-hidden="true">1 failed</span>')
  })
})

describe('SubagentsReadout hover card', () => {
  it('is enabled only while an agent runs', () => {
    setCount(counts({ running: 1 }))
    render()
    expect(cardDisabled()).toBe(false)
  })

  it('stays disabled for a failure-only pill, so hovering it opens nothing', () => {
    setCount(counts({ failed: 2 }))
    render()
    expect(cardDisabled()).toBe(true)
  })
})
