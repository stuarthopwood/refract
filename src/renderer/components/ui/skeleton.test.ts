// #1848: the pulse is decoration, so it must stop for people who ask for reduced motion.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Skeleton } from './skeleton'

describe('Skeleton', () => {
  it('pulses_but_stops_the_animation_under_reduced_motion', () => {
    const html = renderToStaticMarkup(createElement(Skeleton))
    expect(html).toContain('animate-pulse')
    expect(html).toContain('motion-reduce:animate-none')
  })

  it('merges_the_caller_class_without_losing_the_reduced_motion_rule', () => {
    const html = renderToStaticMarkup(createElement(Skeleton, { className: 'h-8 w-full' }))
    expect(html).toContain('h-8 w-full')
    expect(html).toContain('motion-reduce:animate-none')
  })
})
