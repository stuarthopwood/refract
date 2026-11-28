import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TranscriptItem } from '../../../shared/model'
import { AgentMessageRow, AgentSteerRow } from './AgentMessageRow'

// A static render cannot click the row open, so the first boolean `useState` after `skip` others (the steer row's own dialog state) is seeded to true.
const seed = vi.hoisted(() => ({ skip: 0, armed: false }))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: ((initial: unknown) => {
      if (seed.armed && typeof initial === 'boolean') {
        if (seed.skip > 0) seed.skip -= 1
        else {
          seed.armed = false
          return actual.useState(true)
        }
      }
      return actual.useState(initial as never)
    }) as typeof actual.useState
  }
})
vi.mock('@/state', () => ({
  useSettingsStore: (select: (state: { settings: object }) => unknown) => select({ settings: {} }),
  notify: vi.fn(),
  useSessionsStore: (select: (state: { sessions: unknown[] }) => unknown) => select({ sessions: [] })
}))

type AgentMessageItem = Extract<TranscriptItem, { kind: 'agent-message' }>
type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

// Every opening tag directly wrapping `text`: the collapsed summary and the expanded body both hold it.
function tagsAround(html: string, text: string): string[] {
  return [...html.matchAll(new RegExp(`(<[^>]*>)${text}<`, 'g'))].map((m) => m[1] ?? '')
}

function renderOpen(element: React.ReactElement, skip: number): string {
  seed.skip = skip
  seed.armed = true
  try {
    return renderToStaticMarkup(element)
  } finally {
    seed.armed = false
  }
}

describe('agent message bodies use the chat line height (#360)', () => {
  it('gives an expanded agent message body the shared chat leading', () => {
    const item = { kind: 'agent-message', id: 'm1', from: 'main', to: 'sub', text: 'Body of the message.' } as unknown as AgentMessageItem
    const html = renderOpen(React.createElement(AgentMessageRow, { item }), 0)
    expect(tagsAround(html, 'Body of the message\\.').some((tag) => tag.includes('leading-chat'))).toBe(true)
  })

  it('gives an expanded agent steer body the shared chat leading', () => {
    const item = { kind: 'tool', id: 't1', status: 'done', target: 'sub', write: { content: 'Steer body.' } } as unknown as ToolItem
    const html = renderOpen(React.createElement(AgentSteerRow, { item }), 1)
    expect(tagsAround(html, 'Steer body\\.').some((tag) => tag.includes('leading-chat'))).toBe(true)
  })
})
