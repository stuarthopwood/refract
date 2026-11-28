import type { ITheme } from '@xterm/xterm'
import { withResolvedTokens } from '@/lib/resolveCssColour'
import { adjustForContrast, parseHex } from '@/lib/projectColor'

// The terminal draws on the right pane's own surface, so its palette follows the active theme and is nudged to stay
// readable there: a shell prints dim greys and pure blues that the tokens alone do not guarantee (spec 144 US1).

/** WCAG AA for body text; the bright ANSI row gets more so "bright" still reads as brighter than its base. */
export const TERMINAL_MIN_CONTRAST = 4.5
export const TERMINAL_BRIGHT_MIN_CONTRAST = 7

type Reader = (token: string) => string

/** Theme token behind each ANSI hue. Black and white are the muted and normal text colours of the surface. */
const ANSI_TOKENS = {
  black: 'muted-foreground',
  red: 'severity-error',
  green: 'severity-success',
  yellow: 'severity-warning',
  blue: 'severity-info',
  magenta: 'chart-4',
  cyan: 'project-2',
  white: 'foreground'
} as const

type AnsiName = keyof typeof ANSI_TOKENS

const BRIGHT_KEYS = {
  black: 'brightBlack',
  red: 'brightRed',
  green: 'brightGreen',
  yellow: 'brightYellow',
  blue: 'brightBlue',
  magenta: 'brightMagenta',
  cyan: 'brightCyan',
  white: 'brightWhite'
} as const satisfies Record<AnsiName, keyof ITheme>

/** Rounding the nudged colour to 8-bit channels can land a hair under the target, so ask for a small margin. */
const ROUNDING_MARGIN = 0.05

/** Pairs each colour with the surface it sits on; an unresolvable surface leaves colours untouched. */
function readable(hex: string, surface: string, min: number): string {
  const background = parseHex(surface)
  return background === null ? hex : adjustForContrast(hex, background, min + ROUNDING_MARGIN).hex
}

export function buildTerminalTheme(read: Reader): ITheme {
  const background = read('sidebar-right')
  const foreground = readable(read('foreground'), background, TERMINAL_MIN_CONTRAST)
  const theme: ITheme = {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    // A translucent primary keeps the selected text's own colour legible, unlike an opaque fill.
    selectionBackground: `${read('primary')}59`
  }
  for (const name of Object.keys(ANSI_TOKENS) as AnsiName[]) {
    const hex = read(ANSI_TOKENS[name])
    theme[name] = readable(hex, background, TERMINAL_MIN_CONTRAST)
    theme[BRIGHT_KEYS[name]] = readable(hex, background, TERMINAL_BRIGHT_MIN_CONTRAST)
  }
  return theme
}

/** The palette as the app renders it now; call again when the theme changes. */
export function readTerminalTheme(): ITheme {
  return withResolvedTokens('', buildTerminalTheme)
}
