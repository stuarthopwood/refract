// Spec 137 FR-022 to FR-024 (#2075; H3, M6): which width choices a window can take, and what the
// handle and the checked preset report while chat is hidden.
import { describe, expect, it } from 'vitest'
import {
  CHAT_MIN_WIDTH_PX,
  choiceDisabled,
  closesPaneOnShowChat,
  currentChoiceValue,
  fittingWidth,
  resizeHandleName,
  widthFits
} from './pane-width-model'

const presets = [240, 320, 640]
// A 1400 px window minus the 48 px rail, with the default 280 px Session list.
const defaultWindow = { groupWidthPx: 1352, sessionListPx: 280 }

describe('widthFits', () => {
  it('needs the pane width plus the chat minimum to remain after the Session list', () => {
    const room = defaultWindow.groupWidthPx - defaultWindow.sessionListPx - CHAT_MIN_WIDTH_PX
    expect(widthFits(room, defaultWindow)).toBe(true)
    expect(widthFits(room + 1, defaultWindow)).toBe(false)
  })

  it('lets Wide through at 1400 px and blocks it at 1280 px', () => {
    expect(widthFits(640, defaultWindow)).toBe(true)
    expect(widthFits(640, { groupWidthPx: 1232, sessionListPx: 280 })).toBe(false)
  })

  it('gains room when the Session list is collapsed', () => {
    expect(widthFits(640, { groupWidthPx: 1000, sessionListPx: 0 })).toBe(true)
  })

  it('never blocks on an unmeasured layout', () => {
    expect(widthFits(4096, null)).toBe(true)
  })
})

describe('fittingWidth', () => {
  it('keeps a saved width that fits beside chat', () => {
    expect(fittingWidth(640, defaultWindow)).toBe(640)
  })

  it('clamps a saved width wider than the room chat leaves', () => {
    const room = defaultWindow.groupWidthPx - defaultWindow.sessionListPx - CHAT_MIN_WIDTH_PX
    expect(fittingWidth(1240, defaultWindow)).toBe(room)
    expect(fittingWidth(1240, { groupWidthPx: 1352, sessionListPx: 480 })).toBe(512)
  })

  it('never goes below the 240 px floor', () => {
    expect(fittingWidth(1240, { groupWidthPx: 800, sessionListPx: 480 })).toBe(240)
    expect(fittingWidth(100, defaultWindow)).toBe(240)
  })

  it('keeps the saved width when the layout is unmeasured', () => {
    expect(fittingWidth(1240, null)).toBe(1240)
  })
})

describe('closesPaneOnShowChat', () => {
  it('keeps the pane when 240 px remains beside chat', () => {
    expect(closesPaneOnShowChat(defaultWindow)).toBe(false)
    expect(closesPaneOnShowChat({ groupWidthPx: 880, sessionListPx: 280 })).toBe(false)
  })

  it('closes the pane when chat plus the 240 px floor do not fit', () => {
    expect(closesPaneOnShowChat({ groupWidthPx: 879, sessionListPx: 280 })).toBe(true)
  })

  it('keeps the pane when the layout is unknown', () => {
    expect(closesPaneOnShowChat(null)).toBe(false)
  })
})

describe('choiceDisabled', () => {
  it('disables a choice that cannot fit', () => {
    const narrow = { groupWidthPx: 1000, sessionListPx: 280 }
    expect(choiceDisabled({ widthPx: 640, canAct: true, layout: narrow })).toBe(true)
    expect(choiceDisabled({ widthPx: 320, canAct: true, layout: narrow })).toBe(false)
  })

  it('disables every choice outside the chat view', () => {
    expect(choiceDisabled({ widthPx: 240, canAct: false, layout: defaultWindow })).toBe(true)
  })
})

describe('currentChoiceValue', () => {
  const base = { open: true, chatHidden: false, widthPx: 320, presets }

  it('checks the preset that matches the width', () => {
    expect(currentChoiceValue(base)).toBe('320')
    expect(currentChoiceValue({ ...base, widthPx: 639.6 })).toBe('640')
  })

  it('checks nothing for a dragged width, a closed pane or a hidden chat', () => {
    expect(currentChoiceValue({ ...base, widthPx: 500 })).toBe('')
    expect(currentChoiceValue({ ...base, open: false })).toBe('')
    expect(currentChoiceValue({ ...base, chatHidden: true })).toBe('')
  })
})

describe('resizeHandleName', () => {
  it('reports the saved width while chat shows', () => {
    expect(resizeHandleName({ open: true, chatHidden: false, widthPx: 320.4 })).toBe('Resize right pane, 320 pixels wide')
    expect(resizeHandleName({ open: false, chatHidden: false, widthPx: 320 })).toBe('Resize right pane, collapsed')
  })

  it('never reports the saved width while chat is hidden', () => {
    const name = resizeHandleName({ open: true, chatHidden: true, widthPx: 777 })
    expect(name).not.toContain('777')
    expect(name).toContain('chat is hidden')
  })
})
