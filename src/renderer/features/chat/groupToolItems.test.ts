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

const callOf = (id: string, name: string, target: string) =>
  ({ kind: 'tool', id, tool: name, status: 'done', target }) as unknown as TranscriptItem

describe('groupToolItems tool commands (#2141)', () => {
  it('groups a v19 tool command with the old write xd:// form of the same tool', () => {
    const grouped = groupToolItems([callOf('a', 'bash', 'lsp hover'), callOf('b', 'write', 'xd://lsp'), callOf('c', 'bash', 'lsp refs')])
    expect(grouped.filter(isToolGroup)).toHaveLength(1)
  })

  it('keeps a tool command apart from plain bash and from another tool', () => {
    const grouped = groupToolItems([callOf('a', 'bash', 'ls -la'), callOf('b', 'bash', 'lsp hover'), callOf('c', 'bash', 'debug attach'), callOf('d', 'bash', 'pwd')])
    expect(grouped.filter(isToolGroup)).toHaveLength(4)
  })

  it('groups consecutive plain bash calls as before', () => {
    const grouped = groupToolItems([callOf('a', 'bash', 'ls'), callOf('b', 'bash', 'pwd')])
    expect(grouped.filter(isToolGroup)).toHaveLength(1)
  })
})
