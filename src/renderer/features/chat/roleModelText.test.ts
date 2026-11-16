import { describe, expect, it, vi } from 'vitest'
import { CpuIcon, LifeBuoyIcon, PinIcon, TurtleIcon } from 'lucide-react'

// `./roleModelText` pulls in the state barrel, whose DEV block touches `window`; `environment: 'node'` has none.
vi.hoisted(() => {
  Object.assign(globalThis, { window: { addEventListener: () => {}, removeEventListener: () => {} } })
})

import { chipText, chipTooltip, roleShown, shownText } from './roleModelText'

const PROVIDER = 'GitHub Copilot'
const base = { queued: false, stopped: false, currentProvider: PROVIDER }

describe('chipText', () => {
  it('shows the role alone for a Session on a role, never the model', () => {
    expect(chipText({ roleLabel: 'Default', model: 'Claude Opus 5.5' })).toBe('Default')
  })

  it('shows the model name for a Session on a directly picked model', () => {
    expect(chipText({ roleLabel: null, model: 'Claude Opus 5.5' })).toBe('Opus 5.5')
  })

  it('says the model is not known when neither is', () => {
    expect(chipText({ roleLabel: null, model: null })).toBe('Model not known yet')
  })
})

describe('roleShown', () => {
  it('claims no role for a pinned Session even when OMP last reported one, and shows the pin glyph', () => {
    const shown = roleShown('slow', true, 'Claude Opus 5.5')
    expect(shown).toMatchObject({ pinned: true, role: null, roleLabel: null, Icon: PinIcon, model: 'Claude Opus 5.5' })
  })

  it('names a known role with its icon', () => {
    expect(roleShown('slow', false, 'Claude Opus 5.5')).toMatchObject({ pinned: false, role: 'slow', roleLabel: 'Slow', Icon: TurtleIcon })
  })

  it('shows an unrecognised role by its raw name with the generic icon', () => {
    expect(roleShown('mystery', false, null)).toMatchObject({ roleLabel: 'mystery', Icon: CpuIcon })
  })

  it('has no role label and the generic icon without a role', () => {
    expect(roleShown(null, false, null)).toMatchObject({ role: null, roleLabel: null, Icon: CpuIcon })
  })
})

describe('shownText', () => {
  it('joins the role and the short model name', () => {
    expect(shownText({ roleLabel: 'Default', model: 'Claude Sonnet 5.5' })).toBe('Default · Sonnet 5.5')
  })

  it('reads the model alone for a pinned Session', () => {
    expect(shownText(roleShown('slow', true, 'Claude Sonnet 5.5'))).toBe('Sonnet 5.5')
  })

  it('says the model is not known when there is nothing to show', () => {
    expect(shownText({ roleLabel: null, model: null })).toBe('Model not known yet')
  })
})

describe('chipTooltip', () => {
  const current = roleShown('default', false, 'Claude Sonnet 5.5')

  it('names the role first, then the current model with its provider', () => {
    expect(chipTooltip({ ...base, shown: current, current })).toBe('Default role: Claude Sonnet 5.5 via GitHub Copilot. Ctrl+R cycles roles.')
  })

  it('omits the provider when the current model has none', () => {
    expect(chipTooltip({ ...base, currentProvider: null, shown: current, current })).toBe('Default role: Claude Sonnet 5.5. Ctrl+R cycles roles.')
  })

  it('shows the short model name without the current provider while cycling to a different value', () => {
    const cycling = roleShown('slow', false, 'Claude Opus 5.5')
    expect(chipTooltip({ ...base, shown: cycling, current })).toBe('Slow role: Opus 5.5. Ctrl+R cycles roles.')
  })

  it('says the model is not known when the role has none yet', () => {
    const empty = roleShown('default', false, null)
    expect(chipTooltip({ ...base, shown: empty, current: empty })).toBe('Default role: Model not known yet. Ctrl+R cycles roles.')
  })

  it('names a pinned Session by its model and says how to return to a role', () => {
    const pinned = roleShown('slow', true, 'Claude Opus 5.5')
    expect(chipTooltip({ ...base, shown: pinned, current: pinned })).toBe('Pinned to Claude Opus 5.5 via GitHub Copilot. Ctrl+R returns to a role.')
  })

  it('says a pinned Session has no known model yet', () => {
    const pinned = roleShown(null, true, null)
    expect(chipTooltip({ ...base, shown: pinned, current: pinned })).toBe('Pinned to a model not known yet. Ctrl+R returns to a role.')
  })

  it('explains a Fallback role switch before the cycle hint', () => {
    const fallback = roleShown('fallback', false, 'Claude Sonnet 5.5')
    expect(fallback.Icon).toBe(LifeBuoyIcon)
    expect(chipTooltip({ ...base, shown: fallback, current: fallback })).toBe(
      'Fallback role: Claude Sonnet 5.5 via GitHub Copilot. The agent switched models after repeated failures. This is not your saved choice. Ctrl+R cycles roles.'
    )
  })

  it('leads a queued role change with the new value and its model, then names what runs now', () => {
    const next = roleShown('slow', false, 'Claude Opus 5.5')
    expect(chipTooltip({ ...base, queued: true, shown: next, current })).toBe('Slow (Opus 5.5) applies on next turn. Now: Default · Sonnet 5.5.')
  })

  it('says a queued change applies when the agent starts while the Session is stopped', () => {
    const next = roleShown('slow', false, 'Claude Opus 5.5')
    expect(chipTooltip({ ...base, queued: true, stopped: true, shown: next, current })).toBe(
      'Slow (Opus 5.5) applies when the agent starts. Now: Default · Sonnet 5.5.'
    )
  })

  it('leads a queued pin with the pinned model', () => {
    const next = roleShown(null, true, 'Claude Opus 5.5')
    expect(chipTooltip({ ...base, queued: true, shown: next, current })).toBe('Pinned (Opus 5.5) applies on next turn. Now: Default · Sonnet 5.5.')
  })

  it('leads a queued role whose model is not resolved yet with the role alone', () => {
    const next = roleShown('slow', false, null)
    expect(chipTooltip({ ...base, queued: true, shown: next, current })).toBe('Slow applies on next turn. Now: Default · Sonnet 5.5.')
  })
})
