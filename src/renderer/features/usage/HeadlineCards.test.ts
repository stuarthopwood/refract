// The repo has no jsdom, so the markup is rendered to a string. Named `.ts` because vitest only includes `*.test.ts`.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { UsageSummary } from '../../../shared/ipc-usage'
import { HeadlineCards } from './HeadlineCards'

const summary: UsageSummary = {
  spendUsd: 1,
  credits: 0,
  calls: 10,
  totalTokens: 1000,
  cacheHitRate: 0.5,
  avgContextPerCall: 100,
  toolCalls: 1_300,
  toolResolved: 1_234,
  toolErrorRate: 0.1,
  activeDays: 2,
  sessions: 3,
  monthToDateUsd: 1,
  monthActiveDays: 2
}

describe('HeadlineCards tool error rate', () => {
  it('says the rate is over the calls that have a result, not over every call', () => {
    const html = renderToStaticMarkup(createElement(HeadlineCards, { summary, jokes: false }))

    expect(html).toContain('Over 1,234 calls with a result.')
  })

  it('puts the joke line before the denominator when jokes are on', () => {
    const html = renderToStaticMarkup(createElement(HeadlineCards, { summary, jokes: true }))

    expect(html).toMatch(/Tools are tripping over their laces\. Over 1,234 calls with a result\./)
  })
})
