import { describe, expect, test } from 'vitest'
import { type TranscriptItem } from '../../../shared/model'
import { findPrecedingAskItem } from './findPrecedingAskItem'

const tool = (id: string, name: string) => ({ kind: 'tool', id, tool: name }) as unknown as TranscriptItem
const request = (id: string) => ({ kind: 'request', id }) as unknown as TranscriptItem
const text = (id: string) => ({ kind: 'agent', id }) as unknown as TranscriptItem

describe('findPrecedingAskItem', () => {
  test('Given an ask directly before a request, When searched, Then the ask is returned', () => {
    const ask = tool('a', 'ask')
    expect(findPrecedingAskItem([ask, request('r')], 1)).toBe(ask)
  })

  test('Given earlier request frames of the same ask, When searched, Then they are skipped to reach the ask', () => {
    const ask = tool('a', 'ask')
    expect(findPrecedingAskItem([ask, request('r1'), request('r2'), request('r3')], 3)).toBe(ask)
  })

  test('Given a non-ask tool between the ask and the request, When searched, Then no ask is linked', () => {
    expect(findPrecedingAskItem([tool('a', 'ask'), tool('b', 'bash'), request('r')], 2)).toBeUndefined()
  })

  test('Given non-tool rows between the ask and the request, When searched, Then the scan passes over them', () => {
    const ask = tool('a', 'ask')
    expect(findPrecedingAskItem([ask, text('t'), request('r')], 2)).toBe(ask)
  })

  test('Given no tool item before the request, When searched, Then undefined', () => {
    expect(findPrecedingAskItem([text('t'), request('r')], 1)).toBeUndefined()
    expect(findPrecedingAskItem([request('r')], 0)).toBeUndefined()
  })

  test('Given an ask after the request, When searched, Then only earlier items are considered', () => {
    expect(findPrecedingAskItem([request('r'), tool('a', 'ask')], 0)).toBeUndefined()
  })
})
