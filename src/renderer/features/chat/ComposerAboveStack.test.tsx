import { describe, expect, it } from 'vitest'
import source from './ComposerAboveStack.tsx?raw'

describe('ComposerAboveStack', () => {
  it('no longer mounts the background-agents banner above the composer', () => {
    expect(source).not.toContain('<BackgroundAgentsBanner')
  })
})
