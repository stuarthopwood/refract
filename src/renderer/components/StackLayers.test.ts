// The repo has no jsdom, so the stack components render to a string.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { GitMergeIcon, GitPullRequestIcon } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { StackBadge } from './StackBadge'
import { StackLayers } from './StackLayers'

const open = { label: 'Open', icon: GitPullRequestIcon, colorClass: 'text-pr-open' }
const merged = { label: 'Merged', icon: GitMergeIcon, colorClass: 'text-pr-merged' }

describe('StackBadge', () => {
  it('reads "Stack 2 of 3"', () => {
    const html = renderToStaticMarkup(createElement(StackBadge, { position: 2, total: 3 }))
    expect(html.replace(/<!-- -->/g, '')).toContain('Stack 2 of 3')
    expect(html).toContain('data-stack-badge')
  })
})

describe('StackLayers', () => {
  const layers = [
    { number: 10, title: 'Base', status: merged, current: false },
    { number: 11, title: 'Middle', status: open, current: true },
    { number: 12, title: null, status: open, current: false }
  ]
  const html = renderToStaticMarkup(createElement(StackLayers, { layers, onOpen: () => {} }))

  it('links every layer but the current one', () => {
    expect(html.match(/<button/g)).toHaveLength(2)
    expect(html).toContain('aria-current="true"')
  })

  it('shows the state as a word next to the icon, not by colour alone', () => {
    expect(html).toContain('Merged')
    expect(html).toContain('Open')
  })

  it('falls back to the number when a layer has no known title', () => {
    expect(html).toContain('#12')
    expect(html).not.toContain('#12 ')
  })
})
