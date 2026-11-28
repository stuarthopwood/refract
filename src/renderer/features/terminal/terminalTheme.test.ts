import { describe, expect, it } from 'vitest'
import { contrastRatio, parseHex } from '@/lib/projectColor'
import { buildTerminalTheme, TERMINAL_BRIGHT_MIN_CONTRAST, TERMINAL_MIN_CONTRAST } from './terminalTheme'

const DARK: Record<string, string> = {
  'sidebar-right': '#18181b',
  foreground: '#fafafa',
  'muted-foreground': '#52525b',
  'severity-error': '#7f1d1d',
  'severity-success': '#14532d',
  'severity-warning': '#78350f',
  'severity-info': '#1e3a8a',
  'chart-4': '#4c1d95',
  'project-2': '#134e4a',
  primary: '#3b82f6'
}
const LIGHT: Record<string, string> = {
  ...DARK,
  'sidebar-right': '#f4f4f5',
  foreground: '#a1a1aa',
  'muted-foreground': '#e4e4e7',
  'severity-error': '#fca5a5',
  'severity-success': '#bbf7d0',
  'severity-warning': '#fef08a',
  'severity-info': '#bae6fd'
}

const ratio = (a: string | undefined, b: string | undefined): number => contrastRatio(parseHex(a ?? '')!, parseHex(b ?? '')!)
const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const

describe.each([
  ['dark', DARK],
  ['light', LIGHT]
])('terminal theme on a %s surface with poorly chosen tokens', (_name, tokens) => {
  const theme = buildTerminalTheme((token) => tokens[token] ?? '#000000')

  it('uses the pane surface as the terminal background', () => {
    expect(theme.background).toBe(tokens['sidebar-right'])
    expect(theme.cursorAccent).toBe(tokens['sidebar-right'])
  })

  it('keeps the default text and every ANSI colour readable', () => {
    expect(ratio(theme.foreground, theme.background)).toBeGreaterThanOrEqual(TERMINAL_MIN_CONTRAST)
    for (const name of ANSI) expect(ratio(theme[name], theme.background), name).toBeGreaterThanOrEqual(TERMINAL_MIN_CONTRAST)
  })

  it('gives the bright row the stronger contrast', () => {
    for (const name of ANSI) {
      const bright = theme[`bright${name[0]!.toUpperCase()}${name.slice(1)}` as 'brightRed']
      expect(ratio(bright, theme.background), name).toBeGreaterThanOrEqual(TERMINAL_BRIGHT_MIN_CONTRAST - 0.05)
    }
  })

  it('selects with a translucent primary', () => {
    expect(theme.selectionBackground).toBe(`${tokens.primary}59`)
  })
})

describe('terminal theme with an unresolvable surface', () => {
  it('passes colours through rather than guessing', () => {
    const theme = buildTerminalTheme((token) => (token === 'sidebar-right' ? 'not-a-colour' : '#123456'))
    expect(theme.red).toBe('#123456')
  })
})
