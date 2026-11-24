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

  it('returns the full intent when the prefix before the colon is empty', () => {
    expect(toolIntentLabel('   : detail')).toBe(': detail')
  })

  it('strips trailing full stops and the space before them', () => {
    expect(toolIntentLabel('Reading config ...: why')).toBe('Reading config')
    expect(toolIntentLabel('Reading config.')).toBe('Reading config')
  })

  it('falls back to the full intent when stripping leaves nothing', () => {
    expect(toolIntentLabel('...')).toBe('...')
  })

  it('trims surrounding whitespace', () => {
    expect(toolIntentLabel('  Reading config  : why  ')).toBe('Reading config')
  })
})
