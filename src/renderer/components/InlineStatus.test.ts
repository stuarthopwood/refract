// The repo has no DOM, so the line renders to a string.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { InlineStatus } from './InlineStatus'

type Props = Parameters<typeof InlineStatus>[0]
const render = (props: Props): string => renderToStaticMarkup(createElement(InlineStatus, props, 'Something happened'))

describe('InlineStatus', () => {
  test.each([
    { tone: 'error', role: 'alert' },
    { tone: 'loading', role: 'status' },
    { tone: 'notice', role: 'status' },
    { tone: 'info', role: undefined }
  ] as const)('Given tone $tone, Then the role is $role', ({ tone, role }) => {
    const html = render({ tone })
    expect(html).toContain(`data-tone="${tone}"`)
    if (role) expect(html).toContain(`role="${role}"`)
    else expect(html).not.toContain('role=')
  })

  test('Given an error, Then it carries the icon and the screen-reader prefix', () => {
    const html = render({ tone: 'error' })
    expect(html).toContain('<svg')
    expect(html).toContain('<span class="sr-only">Error: </span>')
    expect(html).toContain('text-destructive')
  })

  test.each(['info', 'loading', 'notice'] as const)('Given tone %s, Then there is no icon or Error prefix', (tone) => {
    const html = render({ tone })
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('Error:')
  })

  test('Given an error with a leading override, Then the default icon is dropped but the prefix stays', () => {
    const html = render({ tone: 'error', leading: createElement('i', { 'data-testid': 'lead' }) })
    expect(html).toContain('data-testid="lead"')
    expect(html).not.toContain('<svg')
    expect(html).toContain('Error: ')
  })

  test('Given an error with no children, Then there is no Error prefix', () => {
    expect(renderToStaticMarkup(createElement(InlineStatus, { tone: 'error' }))).not.toContain('Error:')
  })

  test.each([
    { density: 'block', has: 'p-4 text-sm', lacks: 'px-2 py-1' },
    { density: 'compact', has: 'px-2 py-1 text-xs', lacks: 'p-4' }
  ] as const)('Given $density density, Then the classes are $has', ({ density, has, lacks }) => {
    const html = render({ density })
    expect(html).toContain(has)
    expect(html).not.toContain(lacks)
  })
})
