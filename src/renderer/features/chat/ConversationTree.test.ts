// The repo has no jsdom, so the tree view is checked as the markup a row renders and through the pure helpers
// the dialog shares (ordering, refusal text, label save rule, composer text after a Rewind).
import { createElement } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Result } from '../../../shared/ipc'
import type { ConversationTreeEntry } from '../../../shared/model'
import { ConversationTreeRow, type ConversationTreeRowProps } from './ConversationTreeRow'
import { NOT_IDLE_TREE_REASON, NO_AGENT_TREE_MESSAGE, composerTextAfterRewind, labelToSave, roleLabel, saveEntryLabel, treeActionMessage, treeDepths } from './conversationTree'

function entry(over: Partial<ConversationTreeEntry> = {}): ConversationTreeEntry {
  return { id: 'e1', parentId: null, role: 'user', text: 'Fix the build', timestamp: null, label: null, ...over }
}

function row(over: Partial<ConversationTreeRowProps> = {}): string {
  const props: ConversationTreeRowProps = {
    entry: entry(),
    depth: 0,
    isLeaf: false,
    actionsDisabled: false,
    reasonId: 'reason',
    actionError: null,
    onRewind: () => undefined,
    onFork: () => undefined,
    onLabel: async () => null,
    ...over
  }
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ConversationTreeRow, props)))
}

const OK: Result<null> = { ok: true, value: null }

describe('Conversation tree row (FR-197)', () => {
  it('Given a user message, When its row renders, Then the text, Rewind, Fork and a label button show', () => {
    const html = row()
    expect(html).toContain('Fix the build')
    expect(html).toContain('Rewind to here')
    expect(html).toContain('Fork from here')
    expect(html).toContain('Add label')
  })

  it('Given the leaf entry, When its row renders, Then it is marked current', () => {
    const html = row({ isLeaf: true })
    expect(html).toContain('aria-current="true"')
    expect(html).toContain('Current')
  })

  it('Given a labelled entry, When its row renders, Then the label shows and the button offers an edit', () => {
    const html = row({ entry: entry({ label: 'before refactor' }) })
    expect(html).toContain('before refactor')
    expect(html).toContain('Edit label')
  })

  it('Given a message without text, When its row renders, Then a placeholder names the role', () => {
    expect(row({ entry: entry({ role: 'assistant', text: '' }) })).toContain('(Agent message without text)')
  })

  it('Given a deeper entry, When its row renders, Then it is indented and capped', () => {
    expect(row({ depth: 2 })).toContain('margin-left:1.5rem')
    expect(row({ depth: 50 })).toContain('margin-left:4.5rem')
  })

  it('Given an entry, When its row renders, Then the label button names the message it tags', () => {
    expect(row()).toContain('aria-label="Add label for You message: Fix the build"')
    expect(row({ entry: entry({ label: 'x' }) })).toContain('aria-label="Edit label for You message: Fix the build"')
  })
})

describe('Rewind and Fork while the agent works (FR-198)', () => {
  it('Given a working Session, When a row renders, Then both actions are inert and point at the reason', () => {
    const html = row({ actionsDisabled: true })
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(2)
    expect(html.match(/aria-describedby="reason"/g)).toHaveLength(2)
  })

  it('Given an idle Session, When a row renders, Then the actions are live', () => {
    const html = row()
    expect(html).not.toContain('aria-disabled="true"')
    expect(html).not.toContain('aria-describedby="reason"')
  })

  it('Given a row busy with its own action and no reason shown, When it renders, Then nothing points at a missing reason', () => {
    const html = row({ actionsDisabled: true, reasonId: undefined })
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(2)
    expect(html).not.toContain('aria-describedby')
  })

  it('Given a working Session and a failed action, When the row renders, Then both the reason and the failure describe the actions', () => {
    const html = row({ actionsDisabled: true, actionError: 'Something broke' })
    expect(html.match(/aria-describedby="reason [^"]+"/g)).toHaveLength(2)
  })

  it('Given a refused action, When the row renders, Then the failure shows on the row', () => {
    expect(row({ actionError: 'Something broke' })).toContain('Something broke')
  })

  it('Given a not-idle refusal, When mapped, Then it reads the same reason the buttons show', () => {
    expect(treeActionMessage({ code: 'not-idle', message: 'raw' })).toBe(NOT_IDLE_TREE_REASON)
    expect(treeActionMessage({ code: 'tree-failed', message: 'raw' })).toBe('raw')
    expect(treeActionMessage({ code: 'agent-not-running', message: 'raw' })).toBe(NO_AGENT_TREE_MESSAGE)
  })
})

describe('Tree ordering', () => {
  it('Given parents-first entries, When depths are computed, Then each is one deeper than its parent', () => {
    const depths = treeDepths([entry({ id: 'a' }), entry({ id: 'b', parentId: 'a' }), entry({ id: 'c', parentId: 'b' }), entry({ id: 'd', parentId: 'a' })])
    expect([...depths.entries()]).toEqual([['a', 0], ['b', 1], ['c', 2], ['d', 1]])
  })

  it('Given an entry whose parent is not in the list, When depths are computed, Then it is a root', () => {
    const depths = treeDepths([entry({ id: 'a', parentId: 'missing' }), entry({ id: 'b', parentId: 'a' })])
    expect([...depths.entries()]).toEqual([['a', 0], ['b', 1]])
  })
})

describe('Role labels', () => {
  it('Given a known role, When labelled, Then it reads as a person-friendly name', () => {
    expect(roleLabel('user')).toBe('You')
    expect(roleLabel('toolResult')).toBe('Tool result')
    expect(roleLabel('bashExecution')).toBe('Shell command')
  })

  it('Given an unknown role, When labelled, Then it reads generically and never as the raw id', () => {
    expect(roleLabel('futureRole')).toBe('Other')
    expect(roleLabel('unknown')).toBe('Other')
    expect(roleLabel('toString')).toBe('Other')
  })
})

describe('Label save rule (FR-199)', () => {
  it('Given an unchanged label, When saved, Then nothing is sent', async () => {
    const label = vi.fn(async () => OK)
    expect(labelToSave('keep', ' keep ')).toBeNull()
    expect(await saveEntryLabel(label, 's1', entry({ label: 'keep' }), 'keep')).toBeNull()
    expect(label).not.toHaveBeenCalled()
  })

  it('Given a new label, When saved, Then the trimmed text is sent', async () => {
    const label = vi.fn(async () => OK)
    expect(await saveEntryLabel(label, 's1', entry(), '  milestone  ')).toBeNull()
    expect(label).toHaveBeenCalledWith('s1', 'e1', 'milestone')
  })

  it('Given a labelled entry, When the field is emptied, Then an empty label is sent to clear it', async () => {
    const label = vi.fn(async () => OK)
    expect(await saveEntryLabel(label, 's1', entry({ label: 'milestone' }), '   ')).toBeNull()
    expect(label).toHaveBeenCalledWith('s1', 'e1', '')
  })

  it('Given a refused save, When saved, Then the failure text comes back', async () => {
    const label = async (): Promise<Result<null>> => ({ ok: false, error: { code: 'entry-not-found', message: 'That message is gone.' } })
    expect(await saveEntryLabel(label, 's1', entry(), 'x')).toBe('That message is gone.')
  })
})

describe('Composer after a Rewind (FR-197)', () => {
  it('Given an empty composer, When a Rewind recovers a message, Then it becomes the composer text', () => {
    expect(composerTextAfterRewind('  ', 'Fix the build')).toBe('Fix the build')
  })

  it('Given typed text, When a Rewind recovers a message, Then both are kept', () => {
    expect(composerTextAfterRewind('half a thought', 'Fix the build')).toBe('Fix the build\n\nhalf a thought')
  })

  it('Given no recovered message, When a Rewind finishes, Then the composer is untouched', () => {
    expect(composerTextAfterRewind('half a thought', null)).toBe('half a thought')
  })
})
