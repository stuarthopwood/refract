// The non-drag way to resize the right pane (spec 013 FR-025, WCAG 2.5.7): one list of width
// choices rendered by two shells, the resize handle's context menu (right-click, Shift+F10 or the
// menu key) and the app menu bar's "Right pane width" dropdown (AppMenuBar.tsx), so the two never drift.
// While chat is hidden the pane's width is the remainder, so "Show chat" replaces the presets (spec 137 FR-024).
import { Maximize2Icon, MessagesSquareIcon, Minimize2Icon, PanelRightCloseIcon, PanelRightIcon } from 'lucide-react'
import {
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator
} from '@/components/ui/context-menu'
import {
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { RIGHT_PANE_DEFAULT_WIDTH_PX, RIGHT_PANE_MIN_WIDTH_PX, useRightPaneStore, useViewStore } from '@/state'
import { useSplitStore } from '@/state/split-store'
import { choiceDisabled, currentChoiceValue, measurePaneLayout } from './pane-width-model'
import { choiceText, widthShowsOneChat } from './pane-width-choice'
import { rightPaneRef } from './right-pane-handle'
import { hideChatPane, showChatPane, useCanToggleChatPane, useChatPaneHidden } from './toggle-chat-pane'
import { toggleRightPane } from './toggle-right-pane'

const RIGHT_PANE_WIDE_WIDTH_PX = 640

export const PANE_WIDTH_CHOICES = [
  { label: 'Narrow', widthPx: RIGHT_PANE_MIN_WIDTH_PX, icon: Minimize2Icon },
  { label: 'Default', widthPx: RIGHT_PANE_DEFAULT_WIDTH_PX, icon: PanelRightIcon },
  { label: 'Wide', widthPx: RIGHT_PANE_WIDE_WIDTH_PX, icon: Maximize2Icon }
] as const

const PRESET_WIDTHS: readonly number[] = PANE_WIDTH_CHOICES.map((choice) => choice.widthPx)

/** Sets the pane to a preset width, opening it first when it is collapsed. */
export function setPaneWidth(widthPx: number): void {
  const store = useRightPaneStore.getState()
  if (store.open) {
    rightPaneRef.current?.resize(widthPx)
    return
  }
  // App.tsx's layout effect resizes the panel to `widthPx` as it expands.
  store.setWidth(widthPx)
  store.toggleCollapsed()
}

export function closePane(): void {
  if (useRightPaneStore.getState().open) toggleRightPane()
}

function usePaneWidthMenuState() {
  const widthPx = useRightPaneStore((s) => s.widthPx)
  const open = useRightPaneStore((s) => s.open)
  const chatHidden = useChatPaneHidden()
  const canToggleChat = useCanToggleChatPane()
  const isSplit = useSplitStore((s) => s.paneSessionIds.length === 2)
  const canAct = useViewStore((s) => s.view) === 'chat'
  const layout = measurePaneLayout()
  return {
    open,
    chatHidden,
    canAct,
    canToggleChat,
    current: currentChoiceValue({ open, chatHidden, widthPx, presets: PRESET_WIDTHS }),
    isDisabled: (choiceWidthPx: number) => choiceDisabled({ widthPx: choiceWidthPx, canAct, layout }),
    // A Split needs two 360 px chat panes; a width that leaves less shows one chat, so the menu says so.
    choiceLabel: (choice: { label: string; widthPx: number }) => choiceText({ ...choice, shownAsOneChat: widthShowsOneChat({ widthPx: choice.widthPx, isSplit, layout }) })
  }
}

const chatToggleLabel = (chatHidden: boolean) => (chatHidden ? 'Show chat' : 'Hide chat')
const toggleChatFromMenu = (chatHidden: boolean) => (chatHidden ? showChatPane() : hideChatPane())

export function PaneWidthContextMenuItems() {
  const state = usePaneWidthMenuState()
  return (
    <>
      {state.chatHidden ? null : (
        <>
          <ContextMenuRadioGroup value={state.current} onValueChange={(value) => setPaneWidth(Number(value))}>
            {PANE_WIDTH_CHOICES.map((choice) => (
              <ContextMenuRadioItem key={choice.widthPx} icon={choice.icon} value={String(choice.widthPx)} disabled={state.isDisabled(choice.widthPx)}>
                {state.choiceLabel(choice)}
              </ContextMenuRadioItem>
            ))}
          </ContextMenuRadioGroup>
          <ContextMenuSeparator />
        </>
      )}
      <ContextMenuItem icon={MessagesSquareIcon} onSelect={() => toggleChatFromMenu(state.chatHidden)} disabled={!state.canToggleChat}>
        {chatToggleLabel(state.chatHidden)}
      </ContextMenuItem>
      <ContextMenuItem icon={PanelRightCloseIcon} onSelect={closePane} disabled={!state.canAct || !state.open}>
        Close pane
      </ContextMenuItem>
    </>
  )
}

export function PaneWidthDropdownItems() {
  const state = usePaneWidthMenuState()
  return (
    <>
      {state.chatHidden ? null : (
        <>
          <DropdownMenuRadioGroup value={state.current} onValueChange={(value) => setPaneWidth(Number(value))}>
            {PANE_WIDTH_CHOICES.map((choice) => (
              <DropdownMenuRadioItem key={choice.widthPx} icon={choice.icon} value={String(choice.widthPx)} disabled={state.isDisabled(choice.widthPx)}>
                {state.choiceLabel(choice)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
        </>
      )}
      <DropdownMenuItem icon={MessagesSquareIcon} onSelect={() => toggleChatFromMenu(state.chatHidden)} disabled={!state.canToggleChat}>
        {chatToggleLabel(state.chatHidden)}
      </DropdownMenuItem>
      <DropdownMenuItem icon={PanelRightCloseIcon} onSelect={closePane} disabled={!state.canAct || !state.open}>
        Close pane
      </DropdownMenuItem>
    </>
  )
}
