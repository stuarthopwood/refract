// Spec 137 FR-017, FR-018, FR-024, FR-034 (#2075; C1, H2): pane B survives a chat collapse because the
// width-0 report is ignored, so the split state and the visible-Session set stay as they were.
import { describe, expect, it } from 'vitest'
import { canShowSplit, chatPanelResizeAction, heldChatContentWidth, MIN_SPLIT_WIDTH_PX, nextChatWidth, rightWidthToSync, visibleSessionIds } from './chat-layout'

const base = { sizePx: 0, prevSizePx: 900, view: 'chat', open: true, chatCollapsed: false } as const

describe('nextChatWidth', () => {
  it('keeps the last real width when the collapsed panel reports 0', () => {
    expect(nextChatWidth(900, 0)).toBe(900)
    expect(nextChatWidth(null, 0)).toBeNull()
  })

  it('takes every non-zero width, including a narrow one', () => {
    expect(nextChatWidth(900, 500)).toBe(500)
    expect(nextChatWidth(null, 800)).toBe(800)
  })
})

describe('canShowSplit', () => {
  it('needs two 360 px panes', () => {
    expect(canShowSplit(null)).toBe(false)
    expect(canShowSplit(MIN_SPLIT_WIDTH_PX - 1)).toBe(false)
    expect(canShowSplit(MIN_SPLIT_WIDTH_PX)).toBe(true)
  })
})

describe('heldChatContentWidth', () => {
  it('holds the last real width once chat is hidden, before the panel reports 0', () => {
    expect(heldChatContentWidth({ chatHidden: true, panelCollapsed: false, lastWidthPx: 538 })).toBe(538)
  })

  it('keeps holding after chat is shown until the panel reports a real width', () => {
    expect(heldChatContentWidth({ chatHidden: false, panelCollapsed: true, lastWidthPx: 538 })).toBe(538)
  })

  it('lets the content follow the panel when chat is shown', () => {
    expect(heldChatContentWidth({ chatHidden: false, panelCollapsed: false, lastWidthPx: 538 })).toBeUndefined()
  })

  it('holds nothing when no real width was ever seen', () => {
    expect(heldChatContentWidth({ chatHidden: true, panelCollapsed: true, lastWidthPx: null })).toBeUndefined()
  })
})

describe('hiding chat in a Split', () => {
  const paneSessionIds = ['a', 'b']
  const widths = (reports: number[]) => reports.reduce<number | null>(nextChatWidth, null)

  it('keeps both Sessions visible and the split showing while chat is at width 0', () => {
    const chatWidthPx = widths([900, 900, 0, 0])
    expect(canShowSplit(chatWidthPx)).toBe(true)
    expect(visibleSessionIds({ paneSessionIds, splitFits: canShowSplit(chatWidthPx), frontSessionId: 'a' })).toEqual(['a', 'b'])
  })

  it('still collapses to the front Session in a window that was narrow before the hide', () => {
    const chatWidthPx = widths([500, 0])
    expect(canShowSplit(chatWidthPx)).toBe(false)
    expect(visibleSessionIds({ paneSessionIds, splitFits: canShowSplit(chatWidthPx), frontSessionId: 'b' })).toEqual(['b'])
  })

  it('shows the front Session for a single pane and none without one', () => {
    expect(visibleSessionIds({ paneSessionIds: ['a'], splitFits: false, frontSessionId: 'a' })).toEqual(['a'])
    expect(visibleSessionIds({ paneSessionIds: [], splitFits: true, frontSessionId: null })).toEqual([])
  })
})

describe('chatPanelResizeAction', () => {
  it('ignores the mount report', () => {
    expect(chatPanelResizeAction({ ...base, prevSizePx: undefined })).toBe('none')
  })

  it('ignores resizes that stay on one side of zero', () => {
    expect(chatPanelResizeAction({ ...base, sizePx: 500 })).toBe('none')
    expect(chatPanelResizeAction({ ...base, sizePx: 0, prevSizePx: 0 })).toBe('none')
  })

  it('treats a drag to zero as hiding chat while the right pane is open', () => {
    expect(chatPanelResizeAction(base)).toBe('hide')
  })

  it('restores a panel that collapsed with the right pane closed, so both are never hidden', () => {
    expect(chatPanelResizeAction({ ...base, open: false })).toBe('restore')
  })

  it('restores a panel that collapsed outside the chat view', () => {
    expect(chatPanelResizeAction({ ...base, view: 'home' })).toBe('restore')
  })

  it('does nothing when the store already asked for the collapse', () => {
    expect(chatPanelResizeAction({ ...base, chatCollapsed: true })).toBe('none')
  })

  it('shows chat when the user drags it back out of zero', () => {
    expect(chatPanelResizeAction({ ...base, sizePx: 400, prevSizePx: 0, chatCollapsed: true })).toBe('show')
  })

  it('does nothing when our own expand arrives after the store was cleared', () => {
    expect(chatPanelResizeAction({ ...base, sizePx: 400, prevSizePx: 0, chatCollapsed: false })).toBe('none')
  })

  it('leaves the stored preference alone while another view expands the panel', () => {
    expect(chatPanelResizeAction({ ...base, sizePx: 400, prevSizePx: 0, chatCollapsed: true, view: 'issues' })).toBe('none')
  })
})

describe('rightWidthToSync', () => {
  it('reports a user width', () => {
    expect(rightWidthToSync(640, false)).toBe(640)
  })

  it('never reports the width the pane gains while chat is hidden', () => {
    expect(rightWidthToSync(1400, true)).toBeNull()
  })

  it('never reports a collapsed pane', () => {
    expect(rightWidthToSync(0, false)).toBeNull()
  })
})
