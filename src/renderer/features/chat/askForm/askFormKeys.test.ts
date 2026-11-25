import { describe, expect, test } from 'vitest'
import { enterSubmitsForm, escapeCancelsForm } from './askFormKeys'

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

describe('enterSubmitsForm', () => {
  const row = (role: string) => ({ tagName: 'BUTTON', getAttribute: (name: string) => (name === 'role' ? role : null) })

  test('Given focus in a text input, When Enter is pressed, Then the form submits', () => {
    expect(enterSubmitsForm('Enter', false, false, { tagName: 'INPUT' })).toBe(true)
  })

  test('Given focus in a textarea, When Enter is pressed, Then the form does not submit', () => {
    expect(enterSubmitsForm('Enter', false, false, { tagName: 'TEXTAREA' })).toBe(false)
  })

  test.each(['radio', 'checkbox'])('Given focus on a %s row, When Enter is pressed, Then the form submits', (role) => {
    expect(enterSubmitsForm('Enter', false, false, row(role))).toBe(true)
  })

  test('Given focus on a button, When Enter is pressed, Then the button keeps it', () => {
    expect(enterSubmitsForm('Enter', false, false, { tagName: 'BUTTON' })).toBe(false)
  })

  test('Given composition, a held key or another key, Then the form does not submit', () => {
    expect(enterSubmitsForm('Enter', true, false, { tagName: 'INPUT' })).toBe(false)
    expect(enterSubmitsForm('Enter', false, true, { tagName: 'INPUT' })).toBe(false)
    expect(enterSubmitsForm('a', false, false, { tagName: 'INPUT' })).toBe(false)
  })
})
