import { describe, expect, it, vi } from 'vitest'

// `./roleModelText` pulls in the state barrel, whose DEV block touches `window`; `environment: 'node'` has none.
vi.hoisted(() => {
  Object.assign(globalThis, { window: { addEventListener: () => {}, removeEventListener: () => {} } })
})

import { chipModelTooltip, chipText } from './roleModelText'

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

describe('chipModelTooltip', () => {
  it('names the model with its provider', () => {
    expect(chipModelTooltip('Claude Opus 5.5', 'GitHub Copilot/Claude Opus 5.5')).toBe('Opus 5.5 (GitHub Copilot/Claude Opus 5.5)')
  })

  it('omits the provider when it is not known', () => {
    expect(chipModelTooltip('Claude Opus 5.5', null)).toBe('Opus 5.5')
  })

  it('says the model is not known when there is none', () => {
    expect(chipModelTooltip(null, null)).toBe('Model not known yet')
  })
})
