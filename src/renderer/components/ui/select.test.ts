import { describe, expect, test } from 'vitest'
import { SELECT_TRIGGER_CLASS } from './select'

describe('SELECT_TRIGGER_CLASS', () => {
  test.each([
    'aria-disabled:cursor-not-allowed',
    'aria-disabled:opacity-50',
    'aria-disabled:hover:bg-transparent',
    'dark:aria-disabled:hover:bg-transparent'
  ])('Given a trigger that is aria-disabled, Then it carries %s so every dropdown looks inert without being disabled', (token) => {
    expect(SELECT_TRIGGER_CLASS.split(' ')).toContain(token)
  })
})
