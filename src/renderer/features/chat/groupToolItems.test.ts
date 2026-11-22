import { describe, expect, it } from 'vitest'

import type { TranscriptItem } from '../../../shared/model'
import { groupToolItems, isToolGroup } from './groupToolItems'

const tool = (id: string, name: string, status: string) =>
  ({ kind: 'tool', id, tool: name, status, target: '' }) as unknown as TranscriptItem

describe('groupToolItems refract_ask (#1989)', () => {
  it('leaves an answered refract_ask out of the tool groups, its card shows it', () => {
    const grouped = groupToolItems([tool('a', 'refract_ask', 'success')])
    expect(grouped.some(isToolGroup)).toBe(false)
  })

  it('groups a refract_ask that failed validation like an ordinary failed tool call', () => {
    const grouped = groupToolItems([tool('a', 'refract_ask', 'error')])
    expect(grouped.filter(isToolGroup)).toHaveLength(1)
  })
})
