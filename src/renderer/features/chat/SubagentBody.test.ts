// The repo has no jsdom: the body is rendered to a string with the real Markdown, and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/state', () => ({
  notifyPersistentError: vi.fn(),
  useSyntaxTheme: () => 'github-dark',
  useThemeKey: () => 'light',
  useSettingsStore: (select: (s: { settings: object }) => unknown) => select({ settings: {} }),
  useSessionsStore: (select: (state: { sessions: [] }) => unknown) => select({ sessions: [] })
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import type { TranscriptItem } from '../../../shared/model'
import { SubagentBody } from './SubagentRow'

type SubagentItem = Extract<TranscriptItem, { kind: 'subagent' }>

const LINKED: SubagentItem = {
  kind: 'subagent',
  id: 'i1',
  toolCallId: 't1',
  specIndex: 0,
  name: 'GateA11y',
  task: 'Check it',
  status: 'done',
  messageId: 'm1',
  result: 'Fixed in [the PR](https://x.test/pr)'
}

const body = (defaultOpen: boolean) => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(SubagentBody, { item: LINKED, showGoal: false, defaultOpen })))

describe('SubagentBody result links (#2242)', () => {
  it('renders the link as a followable anchor in the opened full view', () => {
    expect(body(true)).toMatch(/<a[^>]*href="https:\/\/x\.test\/pr"/)
  })

  it('renders nothing of the result before the first open', () => {
    expect(body(false)).not.toContain('the PR')
  })
})
