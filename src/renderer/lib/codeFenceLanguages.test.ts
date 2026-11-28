import { describe, expect, it } from 'vitest'
import { FENCE_LANGUAGES, languageLabel, resolveFenceTag, resolveOneLineTag } from './codeFenceLanguages'

describe('resolveFenceTag', () => {
  it('resolves every alias in lower and upper case to its lowercase tag', () => {
    for (const alias of Object.keys(FENCE_LANGUAGES)) {
      expect(resolveFenceTag(alias)).toEqual({ tag: alias, label: FENCE_LANGUAGES[alias] })
      expect(resolveFenceTag(alias.toUpperCase())?.tag).toBe(alias)
    }
  })

  it('returns null for a prose word and for inherited object keys', () => {
    for (const word of ['hello', 'is', 'away', 'constructor', 'toString', '__proto__', '']) expect(resolveFenceTag(word)).toBeNull()
  })
})

describe('resolveOneLineTag', () => {
  it('never turns the ambiguous words go and c into a tag in prose', () => {
    expect(resolveOneLineTag('go', 'away')).toBeNull()
    expect(resolveOneLineTag('C', 'is a letter')).toBeNull()
  })

  it('accepts go and c when the rest looks like code', () => {
    expect(resolveOneLineTag('go', 'fmt.Println("x")')?.tag).toBe('go')
    expect(resolveOneLineTag('c', 'int x = 1;')?.tag).toBe('c')
  })

  it('accepts an unambiguous alias whatever follows', () => {
    expect(resolveOneLineTag('TS', 'hello world')).toEqual({ tag: 'ts', label: 'TypeScript' })
  })
})

describe('languageLabel', () => {
  it('names a known tag case-insensitively and returns null otherwise', () => {
    expect(languageLabel('ts')).toBe('TypeScript')
    expect(languageLabel('TS')).toBe('TypeScript')
    expect(languageLabel('zig')).toBeNull()
    expect(languageLabel(null)).toBeNull()
  })
})
