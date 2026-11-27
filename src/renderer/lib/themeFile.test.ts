import { describe, expect, it } from 'vitest'
import schema from '../../shared/theme.schema.json'
import { THEME_SCHEMA_URL } from '../../shared/themeSchema'
import { THEME_FORMAT_EXAMPLE, themeFileJson } from './themeFile'

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
