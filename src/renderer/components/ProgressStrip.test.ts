// The repo has no jsdom: the strip is rendered to a string and the markup is asserted on; the live
// region's effect is covered through its pure `nextAnnouncement` reducer.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { nextAnnouncement, ProgressStrip, SEGMENT_CLASS, type ProgressStripProps } from './ProgressStrip'

function render(props: Partial<ProgressStripProps> = {}) {
  return renderToStaticMarkup(createElement(ProgressStrip, { value: 1, max: 4, label: '1/4 done', ...props }))
}

describe('ProgressStrip segments', () => {
  const segments = ['done', 'running', 'queued'] as const

  it('draws one aria-hidden segment per entry, in order', () => {
    const html = render({ segments, value: 1, max: 3 })
    const states = [...html.matchAll(/<span aria-hidden="true" data-segment="(\w+)"/g)].map((match) => match[1])
    expect(states).toEqual(['done', 'running', 'queued'])
  })

  it('maps done to a solid success fill, queued to a muted-foreground edge on the muted surface, running to a pulsing outline', () => {
    const html = render({ segments })
    expect(html).toMatch(/data-segment="done"[^>]*class="[^"]*bg-severity-success-fill/)
    expect(html).toMatch(/data-segment="queued"[^>]*class="[^"]*border-muted-foreground[^"]*bg-muted/)
    const running = html.match(/data-segment="running"[^>]*class="([^"]*)"/)![1]
    expect(running).toContain('border-2')
    expect(running).toContain('border-accent-text')
    expect(running).toContain('animate-pulse')
  })

  it('keeps the queued edge off the 1.39:1 divider token, which is below the 3:1 non-text floor', () => {
    expect(SEGMENT_CLASS.queued).not.toContain('border-divider')
  })

  it('tells the three states apart without fills under forced colours: thick solid, dashed, highlight outline', () => {
    expect(SEGMENT_CLASS.done).toContain('forced-colors:border-4')
    expect(SEGMENT_CLASS.done).toContain('forced-colors:border-solid')
    expect(SEGMENT_CLASS.queued).toContain('forced-colors:border-dashed')
    expect(SEGMENT_CLASS.running).toContain('forced-colors:border-[Highlight]')
    expect(SEGMENT_CLASS.running).not.toContain('forced-colors:border-dashed')
  })

  it('stops the running pulse under reduced motion and keeps the outline', () => {
    const running = render({ segments }).match(/data-segment="running"[^>]*class="([^"]*)"/)![1]
    expect(running).toContain('motion-reduce:animate-none')
    expect(running).toContain('border-accent-text')
  })

  it('does not pulse the done or queued segments', () => {
    const html = render({ segments })
    expect(html.match(/data-segment="done"[^>]*class="([^"]*)"/)![1]).not.toContain('animate-pulse')
    expect(html.match(/data-segment="queued"[^>]*class="([^"]*)"/)![1]).not.toContain('animate-pulse')
  })

  it('draws a slim h-1 bar on one row beside the label, never the h-2 stacked bar (#2318)', () => {
    // Mutation: restore the h-2 chunky bar or stack the label above it.
    const html = render({ segments, value: 1, max: 3 })
    expect(html).toMatch(/role="progressbar"[^>]*class="[^"]*\bh-1\b/)
    expect(html).not.toMatch(/role="progressbar"[^>]*class="[^"]*\bh-2\b/)
    expect(html).toMatch(/^<div class="flex items-center gap-2/)
    expect(html.indexOf('1/4 done')).toBeLessThan(html.indexOf('role="progressbar"'))
  })

  it('keeps the progressbar role, label and values and takes a custom aria-valuetext', () => {
    const html = render({ segments, value: 1, max: 3, valueText: '1 of 3 stages done', label: '1/3 done' })
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuemin="0"')
    expect(html).toContain('aria-valuemax="3"')
    expect(html).toContain('aria-valuenow="1"')
    expect(html).toContain('aria-valuetext="1 of 3 stages done"')
    expect(html).toMatch(/aria-labelledby="[^"]+"/)
    expect(html).toContain('1/3 done')
  })

  it('uses theme tokens only, never a hex colour', () => {
    expect(render({ segments })).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})

describe('ProgressStrip without segments', () => {
  it('renders the legacy continuous fill with a percent aria-valuetext', () => {
    const html = render({ value: 2, max: 4 })
    expect(html).toContain('aria-valuetext="50%"')
    expect(html).toContain('style="width:50%"')
    expect(html).toContain('bg-foreground')
    expect(html).not.toContain('data-segment')
  })

  it('keeps the warning and error fill colours', () => {
    expect(render({ state: 'warning' })).toContain('bg-severity-warning')
    expect(render({ state: 'error' })).toContain('bg-severity-error')
  })
})

describe('nextAnnouncement', () => {
  it('announces the done text once, on the below-max to max change', () => {
    const first = nextAnnouncement(true, false, 'All stages done', '')
    expect(first).toBe('All stages done')
    expect(nextAnnouncement(true, true, 'All stages done', first)).toBe(first)
  })

  it('stays silent for a bar that first renders full, and clears when it drops below max', () => {
    expect(nextAnnouncement(true, true, 'All stages done', '')).toBe('')
    expect(nextAnnouncement(false, true, 'All stages done', 'All stages done')).toBe('')
  })

  it('announces nothing without done text', () => {
    expect(nextAnnouncement(true, false, undefined, '')).toBe('')
  })
})
