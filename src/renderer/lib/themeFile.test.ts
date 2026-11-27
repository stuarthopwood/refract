import fixture from '../../../src-tauri/test-data/theme-file.json?raw'
import { describe, expect, it } from 'vitest'
import schema from '../../shared/theme.schema.json'
import tokenList from '../../shared/theme-tokens.json'
import { THEME_SCHEMA_URL } from '../../shared/themeSchema'
import { THEME_FORMAT_EXAMPLE, customThemeJson, themeFileJson } from './themeFile'

describe('themeFileJson', () => {
  it('puts $schema first and keeps the format fields after it', () => {
    const parsed = JSON.parse(themeFileJson('Mine', 'dark', { primary: '#fff' }))
    expect(Object.keys(parsed)).toEqual(['$schema', 'version', 'name', 'base', 'tokens'])
    expect(parsed.$schema).toBe(THEME_SCHEMA_URL)
  })

  it('points at the shipped schema, whose $id is the same URL', () => {
    expect(schema.$id).toBe(THEME_SCHEMA_URL)
  })
})

describe('export paths', () => {
  it('custom export writes $schema first', () => {
    const parsed = JSON.parse(customThemeJson({ name: 'Mine', base: 'dark', tokens: { primary: '#fff' } }))
    expect(Object.keys(parsed)[0]).toBe('$schema')
  })

  it('built-in export (full token set) writes $schema first', () => {
    const tokens = Object.fromEntries(tokenList.tokens.map((t) => [t, '#000000ff']))
    const parsed = JSON.parse(themeFileJson('Dark copy', 'dark', tokens))
    expect(Object.keys(parsed)[0]).toBe('$schema')
  })

  it('matches the fixture the Rust parser test reads', () => {
    expect(fixture.replace(/\r\n/g, '\n')).toBe(themeFileJson('Mine', 'dark', { primary: '#ff2d95' }))
  })
})

describe('THEME_FORMAT_EXAMPLE', () => {
  const example = JSON.parse(THEME_FORMAT_EXAMPLE)

  it('uses a base the schema allows and only tokens it lists', () => {
    expect(schema.properties.base.enum).toContain(example.base)
    for (const token of Object.keys(example.tokens)) expect(schema.properties.tokens.properties, token).toHaveProperty(token)
  })

  it('has a name the schema pattern accepts', () => {
    expect(new RegExp(schema.properties.name.pattern).test(example.name)).toBe(true)
  })
})
