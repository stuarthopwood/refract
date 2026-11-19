// Spec 137 FR-014, FR-018 to FR-020 (#2075): the one hide/show action for the Chat pane area, shared
// by the rail toggle, the palette, the "Right pane width" menus and Ctrl+Shift+H. It mirrors
// `toggle-right-pane.ts`, including the focus rules.
import { isFocusStranded } from '@/lib/focus'
import { RIGHT_PANE_CONTENT_SELECTOR } from '@/lib/right-pane-selectors'
import { useAgentAnnouncementStore } from '@/state/agent-announcement-store'
import { useRightPaneStore } from '@/state/right-pane-store'
import { useSplitStore } from '@/state/split-store'
import { useViewStore, type MainView } from '@/state/view-store'
import { closesPaneOnShowChat, measurePaneLayout } from './pane-width-model'

export interface ChatPaneToggleOptions {
  /** True from the shortcut or the palette: focus always moves. A pointer click leaves it where it is. */
  viaKeyboard?: boolean
}

export type ChatFocusTarget = 'none' | 'right-pane' | 'composer'

const CHAT_AREA_SELECTOR = '[data-session-pane], [data-chat-empty-state]'
const COMPOSER_SELECTOR = '[aria-label="Message"]:not(:disabled)'
const TRANSCRIPT_SELECTOR = '[role="region"][aria-label="Transcript"]'
const LAUNCHER_SELECTOR = '[data-panel-launcher] button'
const RIGHT_PANE_SHELL_SELECTOR = '[data-right-pane-shell]'

/** Other views and a chat view with no Session (it renders Home) always show the chat area; the stored preference is untouched (FR-013). */
export function effectiveChatCollapsed(chatCollapsed: boolean, view: MainView, hasSession: boolean): boolean {
  return chatCollapsed && view === 'chat' && hasSession
}

/** Only a chat view with an open Session has a chat to hide or show; with none it is Home, which never collapses. */
export function canToggleChat(input: { view: MainView; hasSession: boolean }): boolean {
  return input.view === 'chat' && input.hasSession
}

/** Where focus goes after a hide or show: only when it was lost, was in the hidden area, or the user used the keyboard. */
export function chatToggleFocus(input: { hiding: boolean; viaKeyboard: boolean; focusInChat: boolean; focusLost: boolean }): ChatFocusTarget {
  const move = input.viaKeyboard || input.focusLost || (input.hiding && input.focusInChat)
  if (!move) return 'none'
  return input.hiding ? 'right-pane' : 'composer'
}

/** The rendered state, for `aria-expanded` and the toggle's label. */
export function useChatPaneHidden(): boolean {
  const chatCollapsed = useRightPaneStore((s) => s.chatCollapsed)
  const view = useViewStore((s) => s.view)
  const hasSession = useSplitStore((s) => s.paneSessionIds.length > 0)
  return effectiveChatCollapsed(chatCollapsed, view, hasSession)
}

/** False disables the rail toggle (no Session) and the shortcut's no-op cases. */
export function useCanToggleChatPane(): boolean {
  const view = useViewStore((s) => s.view)
  const hasSession = useSplitStore((s) => s.paneSessionIds.length > 0)
  return canToggleChat({ view, hasSession })
}

function focusRightPane(): void {
  const target = document.querySelector<HTMLElement>(RIGHT_PANE_CONTENT_SELECTOR) ?? document.querySelector<HTMLElement>(LAUNCHER_SELECTOR)
  target?.focus()
}

// A Split's Focused Chat pane gets the focus; a Session with no composer falls back to its transcript region.
function focusFrontComposer(): void {
  const { paneSessionIds, focusedIndex } = useSplitStore.getState()
  const sessionId = paneSessionIds.length === 2 ? paneSessionIds[focusedIndex] : paneSessionIds[0]
  const pane = sessionId === undefined ? null : document.querySelector<HTMLElement>(`[data-session-pane="${CSS.escape(sessionId)}"]`)
  const target =
    pane?.querySelector<HTMLElement>(COMPOSER_SELECTOR) ?? pane?.querySelector<HTMLElement>(TRANSCRIPT_SELECTOR) ?? document.querySelector<HTMLElement>('[data-chat-empty-state]')
  target?.focus()
}

function moveFocus(target: ChatFocusTarget): void {
  if (target === 'none') return
  requestAnimationFrame(target === 'composer' ? focusFrontComposer : focusRightPane)
}

function readFocus(): { focusInChat: boolean; focusLost: boolean } {
  const active = document.activeElement
  return { focusInChat: Boolean(active?.closest(CHAT_AREA_SELECTOR)), focusLost: isFocusStranded(active, null) }
}

/** Hides the chat area; opens the right pane on its last active tab first when it is closed (FR-018). */
export function hideChatPane(options: ChatPaneToggleOptions = {}): void {
  const store = useRightPaneStore.getState()
  const hasSession = useSplitStore.getState().paneSessionIds.length > 0
  if (store.chatCollapsed || !canToggleChat({ view: useViewStore.getState().view, hasSession })) return
  const target = chatToggleFocus({ hiding: true, viaKeyboard: options.viaKeyboard === true, ...readFocus() })
  store.setChatCollapsed(true)
  useAgentAnnouncementStore.getState().announce('Chat hidden')
  moveFocus(target)
}

/** Chat takes its width first: a window with no room left for the pane shows chat alone, tabs and `widthPx` kept (FR-014). */
export function showChatPane(options: ChatPaneToggleOptions = {}): void {
  const store = useRightPaneStore.getState()
  if (!store.chatCollapsed) return
  const closePaneToo = store.open && closesPaneOnShowChat(measurePaneLayout())
  const { focusInChat, focusLost } = readFocus()
  const focusLeavesPane = closePaneToo && Boolean(document.activeElement?.closest(RIGHT_PANE_SHELL_SELECTOR))
  const target = chatToggleFocus({ hiding: false, viaKeyboard: options.viaKeyboard === true, focusInChat, focusLost: focusLost || focusLeavesPane })
  store.setChatCollapsed(false)
  if (closePaneToo) store.toggleCollapsed()
  useAgentAnnouncementStore.getState().announce('Chat shown')
  moveFocus(target)
}

export function toggleChatPane(options: ChatPaneToggleOptions = {}): void {
  if (useRightPaneStore.getState().chatCollapsed) showChatPane(options)
  else hideChatPane(options)
}

/** For a drag of the chat panel to or from zero width: syncs the store and announces. Focus stays here; `RightPaneResizeHandle` moves it off a handle that this disables. */
export function syncChatCollapsedFromDrag(collapsed: boolean): void {
  const store = useRightPaneStore.getState()
  if (store.chatCollapsed === collapsed) return
  store.setChatCollapsed(collapsed)
  useAgentAnnouncementStore.getState().announce(collapsed ? 'Chat hidden' : 'Chat shown')
}
