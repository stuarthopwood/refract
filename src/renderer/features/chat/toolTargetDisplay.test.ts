// #1758: the three Tool targets modes decide where a row's target appears.
import { describe, expect, it, vi } from 'vitest'
// toolRowParts imports the renderer state barrel, which needs a browser `window`.
vi.mock('@/state', () => ({ useSettingsStore: (select: (s: unknown) => unknown) => select({ settings: {} }) }))
import { toolTargetDisplay } from './toolRowParts'

describe('toolTargetDisplay', () => {
  it('shows the target chip in the row and keeps the tooltip to the tool id on Show', () => {
    const result = toolTargetDisplay('show', 'read', 'src/a.ts')
    expect(result.chip).toBeDefined()
    expect(result.tooltip).toBe('read')
  })

  it('keeps the target out of the row and puts it in the tooltip on Hover', () => {
    const result = toolTargetDisplay('hover', 'bash', 'pnpm test')
    expect(result.chip).toBeUndefined()
    expect(result.tooltip).toBe('bash: pnpm test')
  })

  it('shows the target nowhere on Hide', () => {
    const result = toolTargetDisplay('hide', 'bash', 'pnpm test')
    expect(result.chip).toBeUndefined()
    expect(result.tooltip).toBe('bash')
  })

  it('falls back to the tool id when a row has no target', () => {
    expect(toolTargetDisplay('hover', 'todo', undefined).tooltip).toBe('todo')
  })
})
