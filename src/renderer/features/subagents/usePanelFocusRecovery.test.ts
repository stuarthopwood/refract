import { describe, expect, it } from 'vitest'
import { PanelFocusTracker, type Focusable, type FocusRoot } from './usePanelFocusRecovery'
import { buildPanelRows } from './subagentPanelRows'
import { subagentSummary } from './viewModel/testFixtures'
import { selectScenarioFromSummaries } from './viewModel'

const rows = buildPanelRows(
  selectScenarioFromSummaries([
    subagentSummary({ nameOrTask: 'Alpha', toolCallId: 'c1', specIndex: 0, id: 'a' }),
    subagentSummary({ nameOrTask: 'Beta', toolCallId: 'c1', specIndex: 1, id: 'b' })
  ]).stages,
  () => true
)
const beta = rows.find((row) => row.kind === 'agent' && row.label === 'Beta')!
const withoutBeta = rows.filter((row) => row.key !== beta.key)

const BODY = { name: 'body' }
const INSIDE_BETA = { name: 'inside beta' } as unknown as Node

/** A row element that holds only the nodes it is given. */
const rowElement = (...nodes: Node[]) => ({ contains: (node: Node | null) => node !== null && nodes.includes(node) })

function fakeFocusable() {
  const calls: string[] = []
  return { calls, target: { focus: () => calls.push('focus') } satisfies Focusable }
}

function fakeRoot(heading: Focusable | null): FocusRoot & { selectors: string[] } {
  const selectors: string[] = []
  return {
    selectors,
    querySelector: (selector) => {
      selectors.push(selector)
      return heading
    }
  }
}

/** A tracker that last saw focus inside the Beta row. */
function trackerFocusedInBeta(): PanelFocusTracker {
  const tracker = new PanelFocusTracker()
  tracker.track(new Map([[beta.key, rowElement(INSIDE_BETA)]]), INSIDE_BETA)
  return tracker
}

describe('PanelFocusTracker.recover', () => {
  it('hands focus to the tree heading when the focused row was pruned and focus fell to the body', () => {
    const heading = fakeFocusable()
    const fallback = fakeFocusable()

    trackerFocusedInBeta().recover(withoutBeta, { root: fakeRoot(heading.target), fallback: () => fallback.target, active: BODY, body: BODY })

    expect(heading.calls).toEqual(['focus'])
    expect(fallback.calls).toEqual([])
  })

  it('looks the heading up by its data attribute', () => {
    const root = fakeRoot(fakeFocusable().target)
    trackerFocusedInBeta().recover(withoutBeta, { root, fallback: () => null, active: null, body: BODY })
    expect(root.selectors).toEqual(['[data-panel-heading]'])
  })

  it('falls back to the panel container once no heading is left', () => {
    const fallback = fakeFocusable()

    trackerFocusedInBeta().recover([], { root: fakeRoot(null), fallback: () => fallback.target, active: BODY, body: BODY })

    expect(fallback.calls).toEqual(['focus'])
  })

  it('falls back to the panel container when the tree itself is gone', () => {
    const fallback = fakeFocusable()

    trackerFocusedInBeta().recover([], { root: null, fallback: () => fallback.target, active: BODY, body: BODY })

    expect(fallback.calls).toEqual(['focus'])
  })

  it('forgets the focused row after recovering, so a later prune does not steal focus again', () => {
    const heading = fakeFocusable()
    const tracker = trackerFocusedInBeta()
    const env = { root: fakeRoot(heading.target), fallback: () => null, active: BODY, body: BODY }

    tracker.recover(withoutBeta, env)
    tracker.recover(withoutBeta, env)

    expect(heading.calls).toEqual(['focus'])
  })

  it('leaves focus alone while another control holds it', () => {
    const heading = fakeFocusable()
    const fallback = fakeFocusable()

    trackerFocusedInBeta().recover(withoutBeta, { root: fakeRoot(heading.target), fallback: () => fallback.target, active: { name: 'composer' }, body: BODY })

    expect([...heading.calls, ...fallback.calls]).toEqual([])
  })

  it('leaves focus alone while the focused row is still listed', () => {
    const heading = fakeFocusable()

    trackerFocusedInBeta().recover(rows, { root: fakeRoot(heading.target), fallback: () => null, active: BODY, body: BODY })

    expect(heading.calls).toEqual([])
  })
})

describe('PanelFocusTracker.track and release', () => {
  const outside = { name: 'outside' } as unknown as Node
  const recoversTo = (tracker: PanelFocusTracker) => {
    const heading = fakeFocusable()
    tracker.recover(withoutBeta, { root: fakeRoot(heading.target), fallback: () => null, active: BODY, body: BODY })
    return heading.calls.length === 1
  }

  it('ignores focus that is inside no row', () => {
    const tracker = new PanelFocusTracker()
    tracker.track(new Map([[beta.key, rowElement(INSIDE_BETA)]]), outside)
    expect(recoversTo(tracker)).toBe(false)
  })

  it('forgets the row when an attached element loses focus', () => {
    const tracker = trackerFocusedInBeta()
    tracker.release({ isConnected: true })
    expect(recoversTo(tracker)).toBe(false)
  })

  it('keeps the row when the blur comes from a removed, detached element', () => {
    const tracker = trackerFocusedInBeta()
    tracker.release({ isConnected: false })
    expect(recoversTo(tracker)).toBe(true)
  })
})
