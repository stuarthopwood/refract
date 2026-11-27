import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const rendererDir = new URL('..', import.meta.url)
const css = readFileSync(new URL('styles/globals.css', rendererDir), 'utf8')

// The first top-level rule that opens with `selector {`, up to its closing brace in column 0.
const ruleBody = (selector: string): string => {
  const start = css.indexOf(`\n${selector} {`)
  expect(start, `${selector} rule in globals.css`).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('\n}', start))
}

// A focus utility with a literal width: `focus-visible:ring-2`, `focus-visible:outline-1`, `focus:ring-[3px]`,
// `group-focus-visible/handle:outline-2`. `-0` resets and `(length:--focus-ring-width)` do not match.
const RAW_FOCUS_WIDTH = /focus[^\s"'`]*:(?:outline|ring)-(?:[1-9]\d*|\[\d+px\])$/
// State rings share the `ring-N` name but mark invalid/checked/selected, not keyboard focus.
const isStateRing = (token: string): boolean => /^aria-invalid:|data-\[|^[a-z-]*:?aria-/.test(token)

const sourceFiles = (): string[] =>
  (readdirSync(rendererDir, { recursive: true }) as string[]).filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file))

describe('focus ring width token', () => {
  it('root_is_2px_and_dark_high_contrast_is_3px', () => {
    expect(ruleBody(':root')).toMatch(/--focus-ring-width:\s*2px;/)
    expect(ruleBody('.theme-dark-high-contrast')).toMatch(/--focus-ring-width:\s*3px;/)
  })

  it('flags_a_raw_focus_width_and_spares_state_rings_and_the_token', () => {
    const flagged = (token: string) => RAW_FOCUS_WIDTH.test(token) && !isStateRing(token)
    expect(flagged('focus-visible:outline-2')).toBe(true)
    expect(flagged('forced-colors:focus-visible:ring-[3px]')).toBe(true)
    expect(flagged('group-focus-visible/handle:outline-1')).toBe(true)
    expect(flagged('focus-visible:ring-(length:--focus-ring-width)')).toBe(false)
    expect(flagged('focus-visible:ring-0')).toBe(false)
    expect(flagged('aria-invalid:not-focus-visible:ring-1')).toBe(false)
    expect(flagged('data-[state=checked]:ring-2')).toBe(false)
  })

  it('no_renderer_source_hard_codes_a_focus_outline_or_ring_width', () => {
    const offenders: string[] = []
    for (const file of sourceFiles()) {
      const lines = readFileSync(new URL(file.replaceAll('\\', '/'), rendererDir), 'utf8').split(/\r?\n/)
      for (const [index, line] of lines.entries()) {
        for (const token of line.split(/[\s"'`]+/)) {
          if (RAW_FOCUS_WIDTH.test(token) && !isStateRing(token)) offenders.push(`${file}:${index + 1} ${token}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('no_focus_visible_rule_in_globals_css_hard_codes_an_outline_width', () => {
    const offenders: string[] = []
    // Comments precede selectors, so strip them first; `[data-nav-highlight]` is a landing highlight, not a focus ring.
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)
    for (const [, selector = '', body = ''] of rules) {
      if (!/:focus(?:-visible)?\b/.test(selector) || selector.includes('[data-nav-highlight]')) continue
      if (/outline(?:-width)?:\s*\d+px/.test(body)) offenders.push(selector.trim())
    }
    expect(offenders).toEqual([])
  })
})
