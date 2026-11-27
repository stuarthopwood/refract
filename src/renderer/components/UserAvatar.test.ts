// #137: the profile avatar's update dot. The repo has no jsdom, so the markup is rendered to a string.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { UserAvatar } from './UserAvatar'

const render = (badge?: 'accent' | 'danger') => renderToStaticMarkup(createElement(UserAvatar, { name: 'Ada Lovelace', badge }))

describe('UserAvatar badge', () => {
  it('shows_an_accent_dot_for_something_pending', () => {
    expect(render('accent')).toContain('data-badge="accent"')
  })

  it('shows_a_danger_dot_in_the_destructive_colour_for_something_failed', () => {
    const html = render('danger')
    expect(html).toContain('data-badge="danger"')
    expect(html).toContain('bg-destructive')
  })

  it('renders_no_dot_when_the_badge_is_unset', () => {
    expect(render()).not.toContain('data-badge')
  })

  it('stays_hidden_from_assistive_technology_with_or_without_a_dot', () => {
    expect(render('accent')).toContain('aria-hidden="true"')
  })
})
