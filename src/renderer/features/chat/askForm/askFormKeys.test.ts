import { describe, expect, test } from 'vitest'
import { escapeCancelsForm } from './askFormKeys'

describe('escapeCancelsForm', () => {
  test.each(['INPUT', 'input', 'TEXTAREA'])('Given focus in a %s, When Esc is pressed, Then the form is not cancelled', (tagName) => {
    expect(escapeCancelsForm('Escape', false, { tagName })).toBe(false)
  })

  test('Given focus in a contenteditable region, When Esc is pressed, Then the form is not cancelled', () => {
    expect(escapeCancelsForm('Escape', false, { tagName: 'DIV', isContentEditable: true })).toBe(false)
  })

  test.each(['BUTTON', 'DIV'])('Given focus on a %s inside the card, When Esc is pressed, Then the form is cancelled', (tagName) => {
    expect(escapeCancelsForm('Escape', false, { tagName })).toBe(true)
  })

  test('Given a target without a tag, When Esc is pressed, Then the form is cancelled', () => {
    expect(escapeCancelsForm('Escape', false, null)).toBe(true)
  })

  test('Given another key or an IME composition, When pressed, Then the form is not cancelled', () => {
    expect(escapeCancelsForm('Enter', false, { tagName: 'BUTTON' })).toBe(false)
    expect(escapeCancelsForm('Escape', true, { tagName: 'BUTTON' })).toBe(false)
  })
})
