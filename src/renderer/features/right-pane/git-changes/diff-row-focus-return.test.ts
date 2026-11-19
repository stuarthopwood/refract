import { describe, expect, it } from 'vitest'
import { decodeOrigin, encodeOrigin, moveOrigin } from './diff-row-focus-return'

describe('encodeOrigin and decodeOrigin', () => {
  it('round-trips a group and a path, including a path with a newline', () => {
    expect(decodeOrigin(encodeOrigin('staged', 'odd\nname.ts'))).toEqual({ group: 'staged', path: 'odd\nname.ts' })
  })
})

describe('moveOrigin', () => {
  it('carries the row path to the renamed tab in its new group', () => {
    const origins = new Map([['s1\ndiff:changes:a.ts', encodeOrigin('changes', 'a.ts')]])
    moveOrigin(origins, 's1', 'diff:changes:a.ts', 'diff:staged:a.ts', 'staged')
    expect([...origins]).toEqual([['s1\ndiff:staged:a.ts', encodeOrigin('staged', 'a.ts')]])
  })

  it('keeps the origin the target tab already has when two tabs merge', () => {
    const origins = new Map([
      ['s1\ndiff:changes:a.ts', encodeOrigin('changes', 'a.ts')],
      ['s1\ndiff:staged:a.ts', encodeOrigin('staged', 'a.ts')]
    ])
    moveOrigin(origins, 's1', 'diff:changes:a.ts', 'diff:staged:a.ts', 'staged')
    expect([...origins.keys()]).toEqual(['s1\ndiff:staged:a.ts'])
  })

  it('does nothing for a tab that was not opened from a row', () => {
    const origins = new Map<string, string>()
    moveOrigin(origins, 's1', 'diff:changes:a.ts', 'diff:staged:a.ts', 'staged')
    expect(origins.size).toBe(0)
  })
})
