import { describe, expect, it } from 'vitest'
import { toolIntentLabel } from './toolIntentLabel'

describe('toolIntentLabel', () => {
  it('keeps the text before a colon followed by a space', () => {
    expect(toolIntentLabel('Reading config: to find the port')).toBe('Reading config')
  })

  it('keeps the text before a colon at the end', () => {
    expect(toolIntentLabel('Reading config:')).toBe('Reading config')
  })

  it('returns the full intent when the colon is at index 0', () => {
    expect(toolIntentLabel(': detail only')).toBe(': detail only')
  })

  it('returns the full intent when there is no colon', () => {
    expect(toolIntentLabel('Reading the config file')).toBe('Reading the config file')
  })

  it('does not split a colon that is not followed by whitespace', () => {
    expect(toolIntentLabel('Fetching http://example.test/a')).toBe('Fetching http://example.test/a')
  })

  it('falls back to the untrimmed full intent when the prefix before the colon is blank', () => {
    expect(toolIntentLabel('   : detail')).toBe('   : detail')
  })

  it('leaves trailing full stops alone, as OMP does on its own rows', () => {
    expect(toolIntentLabel('Reading config.')).toBe('Reading config.')
    expect(toolIntentLabel('Reading config ...: why')).toBe('Reading config ...')
    expect(toolIntentLabel('...')).toBe('...')
  })

  it('trims the prefix after splitting on the raw intent', () => {
    expect(toolIntentLabel('  Reading config  : why  ')).toBe('Reading config')
  })

  it('splits on a colon followed by a tab or a newline', () => {
    expect(toolIntentLabel('Reading config:\tto find the port')).toBe('Reading config')
    expect(toolIntentLabel('Reading config:\nto find the port')).toBe('Reading config')
  })

  it('splits at the first qualifying colon', () => {
    expect(toolIntentLabel('a::b: c')).toBe('a::b')
  })

  it('keeps unicode and emoji intact', () => {
    expect(toolIntentLabel('Lecture du fichier café 📄: pour le port')).toBe('Lecture du fichier café 📄')
    expect(toolIntentLabel('日本語のラベル: 詳細')).toBe('日本語のラベル')
  })
})
