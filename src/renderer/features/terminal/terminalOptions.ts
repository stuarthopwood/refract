import type { ITerminalOptions } from '@xterm/xterm'
import { TERMINAL_MIN_CONTRAST } from './terminalTheme'

// The xterm options that are about access rather than looks, kept apart so a test can pin them without a DOM.

export type AccessOptions = Pick<ITerminalOptions, 'screenReaderMode' | 'cursorBlink' | 'minimumContrastRatio'>

/**
 * Screen reader mode is always on: it mirrors the screen into an off-screen live region, which costs a little on a
 * flooding shell but is the only way a screen reader hears terminal output at all. `minimumContrastRatio` lets xterm
 * lift any cell colour a program picks that the theme's own palette cannot control.
 */
export function accessOptions(motionReduced: boolean): AccessOptions {
  return { screenReaderMode: true, cursorBlink: !motionReduced, minimumContrastRatio: TERMINAL_MIN_CONTRAST }
}
