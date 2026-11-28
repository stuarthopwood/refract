import { describe, expect, it } from 'vitest'
import { accessOptions } from './terminalOptions'
import { TERMINAL_MIN_CONTRAST } from './terminalTheme'

describe('terminal access options', () => {
  it('always turns screen reader mode on', () => {
    expect(accessOptions(false).screenReaderMode).toBe(true)
    expect(accessOptions(true).screenReaderMode).toBe(true)
  })

  it('blinks the cursor only while motion is not reduced', () => {
    expect(accessOptions(false).cursorBlink).toBe(true)
    expect(accessOptions(true).cursorBlink).toBe(false)
  })

  it('asks xterm to keep every cell at the same contrast as the palette', () => {
    expect(accessOptions(false).minimumContrastRatio).toBe(TERMINAL_MIN_CONTRAST)
  })
})
