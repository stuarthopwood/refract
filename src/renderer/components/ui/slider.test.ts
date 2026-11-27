import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Slider, forwardFirstValue, sliderFraction, sliderStopFractions } from './slider'

const render = (props: Partial<Parameters<typeof Slider>[0]> = {}): string =>
  renderToStaticMarkup(createElement(Slider, { value: 50, onValueChange: () => undefined, ...props }))

describe('sliderFraction', () => {
  it('maps_value_to_zero_to_one_and_clamps', () => {
    expect(sliderFraction(50, 0, 100)).toBe(0.5)
    expect(sliderFraction(150, 0, 100)).toBe(1)
    expect(sliderFraction(-5, 0, 100)).toBe(0)
    expect(sliderFraction(5, 10, 10)).toBe(0)
  })
})

describe('sliderStopFractions', () => {
  it('draws_dots_for_a_small_set_of_steps', () => {
    expect(sliderStopFractions(0, 4, 1)).toEqual([0, 0.25, 0.5, 0.75, 1])
  })

  it('draws_no_dots_for_a_fine_range_or_a_single_stop', () => {
    expect(sliderStopFractions(0, 100, 1)).toEqual([])
    expect(sliderStopFractions(0, 1, 1)).toEqual([])
  })
})

describe('forwardFirstValue', () => {
  it('passes_the_first_value_through_to_the_callback', () => {
    const seen: number[] = []
    forwardFirstValue((value) => seen.push(value))([42])

    expect(seen).toEqual([42])
  })

  it('ignores_an_empty_report', () => {
    const seen: number[] = []
    forwardFirstValue((value) => seen.push(value))([])

    expect(seen).toEqual([])
  })
})

describe('Slider M3 shape', () => {
  it('thumb_is_a_44_by_24_hit_target_with_a_4px_bar', () => {
    const html = render()

    expect(html).toContain('role="slider"')
    expect(html).toMatch(/h-11 w-6/)
    expect(html).toContain('after:w-1')
    expect(html).toContain('after:bg-primary')
  })

  it('root_is_44px_tall_and_track_is_16px_thick', () => {
    const html = render()

    expect(html).toMatch(/data-slot="slider"[^>]*class="[^"]*\bh-11\b/)
    expect(html).toMatch(/data-slot="slider-track"[^>]*class="[^"]*\bh-4\b/)
  })

  it('splits_the_track_around_the_handle_with_a_6px_gap', () => {
    const html = render({ value: 50 })

    expect(html).toContain('data-slot="slider-range"')
    expect(html).toContain('data-slot="slider-remainder"')
    expect(html).toContain('width:max(0px, calc(calc(12px + (100% - 24px) * 0.5) - 8px))')
    expect(html).toContain('left:calc(calc(12px + (100% - 24px) * 0.5) + 8px)')
  })

  it('draws_stop_dots_only_for_a_small_step_set', () => {
    expect(render({ min: 0, max: 4, step: 1, value: 2 }).match(/data-slot="slider-stop"/g)).toHaveLength(5)
    expect(render({ min: 0, max: 100, step: 1 })).not.toContain('slider-stop')
  })

  it('track_background_replaces_the_split_track', () => {
    const html = render({ trackBackground: 'linear-gradient(red, blue)' })

    expect(html).toContain('linear-gradient(red, blue)')
    expect(html).not.toContain('data-slot="slider-range"')
    expect(html).toContain('after:shadow-')
  })

  it('keeps_forced_colors_fallbacks', () => {
    const html = render()

    expect(html).toContain('forced-colors:bg-[Highlight]')
    expect(html).toContain('forced-colors:bg-[GrayText]')
  })
})
