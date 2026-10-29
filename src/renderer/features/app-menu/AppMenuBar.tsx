// The in-app File/Edit/View/Window menu bar (docs/DESIGN.md "Layout"; FR-057): Electron's native
// menu does not reveal on Alt once the title bar is merged into the app's top row
// (`titleBarStyle: 'hidden'`, confirmed live, docs/spike/FINDINGS.md item 33), so this draws the
// same four items itself. A standalone Alt tap (keydown then keyup with no other key pressed in
// between -- never a combo like Alt+Tab or Alt+F4) toggles it; Esc or a click outside the bar
// hides it. Each item still opens the one real Electron `Menu` (`src/main/menu.ts`) by id, so
// every accelerator and role (copy, paste, undo, redo, zoom, and in development reload/toggle
// developer tools) behaves identically whether the bar is shown or not.
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { notify } from '@/state'
import { openChatFind } from '@/state/chat-find-store'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { PaneWidthDropdownItems } from '@/features/right-pane/PaneWidthMenu'
import { APP_MENU_IDS } from '../../../shared/ipc'
import type { AppMenuId } from '../../../shared/ipc'

const MENU_LABEL: Record<AppMenuId, string> = {
  file: 'File',
  edit: 'Edit',
  view: 'View',
  window: 'Window'
}

// Ids come from the one shared list (`shared/ipc.ts`'s `APP_MENU_IDS`, also used by
// `src/main/menu.ts` and `src/main/ipc/window.ts`); only the display label is this component's
// own.
const MENUS: Array<{ id: AppMenuId; label: string }> = APP_MENU_IDS.map((id) => ({ id, label: MENU_LABEL[id] }))

const MENU_BUTTON_CLASS =
  'px-2 py-1 hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

export function AppMenuBar() {
  const [visible, setVisible] = useState(false)
  const barRef = useRef<HTMLDivElement>(null)
  // Armed on Alt's own keydown; any other keydown before the matching keyup disarms it, so a
  // held Alt used as part of a shortcut never toggles the bar, only a standalone tap does. Also
  // cleared on window blur and on any mousedown/pointerdown: without this, an Alt+Tab away and
  // back (the OS consumes the Tab, so this page never sees a clearing keyup) could leave the
  // flag armed and let a later, unrelated Alt-keyup pop the bar open unexpectedly.
  const altArmedRef = useRef(false)
  // Whatever held focus right before Alt opened the bar (e.g. the message box mid-draft),
  // captured on Alt's keydown so every dismissal path below can restore it instead of leaving
  // focus to fall through to <body> (WCAG 2.1 AA 2.4.3). Only captured while focus is OUTSIDE
  // the bar: the SECOND Alt tap that closes an already-open bar also fires this keydown, and by
  // then the bar's own autoFocused "File" button holds focus, so without the `barRef` guard
  // below this ref would get clobbered with the bar's own button instead of keeping the
  // original pre-bar target.
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      altArmedRef.current = event.key === 'Alt'
      if (event.key === 'Alt' && !barRef.current?.contains(document.activeElement)) {
        previousFocusRef.current = document.activeElement as HTMLElement | null
      }
    }
    function onKeyUp(event: KeyboardEvent): void {
      if (event.key !== 'Alt') return
      if (altArmedRef.current) setVisible((current) => !current)
      altArmedRef.current = false
    }
    function onBlur(): void {
      altArmedRef.current = false
    }
    function onPointerDown(): void {
      altArmedRef.current = false
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    window.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('pointerdown', onPointerDown)
    }
  }, [])

  useEffect(() => {
    if (!visible) return
    function onMouseDown(event: MouseEvent): void {
      if (barRef.current?.contains(event.target as Node)) return
      // The Right pane dropdown's items are portalled outside the bar (scoped by data attribute).
      if ((event.target as Element).closest('[data-app-menu-dropdown]')) return
      // A click away is itself the user choosing a new focus target (e.g. clicking straight into
      // the message textarea): clear the captured ref so the restore effect below does not then
      // fight that click by yanking focus back to the pre-bar element on the next render.
      previousFocusRef.current = null
      setVisible(false)
    }
    function onKeyDown(event: KeyboardEvent): void {
      // Quality-gate remediation (a11y, round 2, corroborated by all three reviewers): closing
      // the Alt-opened bar via Escape must not look like an unhandled keypress to anything else
      // also listening for Escape on window (AppearanceSection.tsx's own preview-cancel handler
      // checks exactly this -- see its 'role="menubar"' guard for the order-independent half of
      // this fix).
      //
      // Quality-gate remediation (round 5): a round-4 `if (event.repeat) return` guard used to
      // live here, reasoning that it stopped a held-down Escape's auto-repeat from reaching
      // AppearanceSection.tsx's own preview-cancel listener. It did not: by the time the repeat
      // keydown fires (~500ms after the first), this effect's cleanup has already removed this
      // very listener (React re-rendered after the first event's `setVisible(false)`), so the
      // repeat event was never intercepted here regardless -- it fell straight through to
      // AppearanceSection.tsx's listener either way. The real fix now lives there instead (see
      // that file's own comment). Guarding here was harmless but pointless, so it is removed
      // along with the comment that claimed it worked.
      if (event.key === 'Escape') {
        // Escape inside the open dropdown only closes that dropdown (Radix), not the whole bar.
        if ((event.target as Element).closest('[data-app-menu-dropdown]')) return
        event.preventDefault()
        setVisible(false)
      }
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [visible])

  // Restores focus on Esc or a second Alt tap: both just flip `visible` to false with
  // `previousFocusRef` still holding the pre-bar target. A click-away also flips `visible` to
  // false, but its `onMouseDown` handler above clears the ref first, so this effect is a no-op
  // for that path and the user's own click target keeps focus instead of being fought over.
  useEffect(() => {
    if (visible) return
    const target = previousFocusRef.current
    previousFocusRef.current = null
    if (target?.isConnected) target.focus()
  }, [visible])

  async function openMenu(menuId: AppMenuId, target: HTMLElement): Promise<void> {
    const rect = target.getBoundingClientRect()
    const result = await window.refract.window.popupMenu(menuId, Math.round(rect.left), Math.round(rect.bottom))
    if (!result.ok) notify(result.error)
  }

  function findInChat(): void {
    const returnFocus = previousFocusRef.current
    const pane =
      returnFocus?.closest('[data-session-pane]') ??
      document.activeElement?.closest('[data-session-pane]') ??
      document.querySelector('[data-session-pane]')
    const sessionId = pane?.getAttribute('data-session-pane')
    if (!sessionId) return
    // The find bar takes focus itself; clearing the ref stops the bar's own close from stealing it.
    previousFocusRef.current = null
    setVisible(false)
    openChatFind(sessionId, returnFocus)
  }

  function focusButton(index: number): void {
    const buttons = barRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')
    if (buttons?.length) buttons[(index + buttons.length) % buttons.length]?.focus()
  }

  function onButtonKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void {
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      focusButton(index + 1)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      focusButton(index - 1)
    }
  }

  if (!visible) return null

  return (
    <div
      ref={barRef}
      role="menubar"
      aria-label="App menu"
      className="titlebar-surface no-drag-region fixed left-0 top-0 z-50 flex h-10 items-center gap-1 px-2 text-sm text-card-foreground"
      style={{ width: 'env(titlebar-area-width, 100vw)' }}
    >
      {MENUS.map((menu, index) => (
        <button
          key={menu.id}
          type="button"
          role="menuitem"
          aria-haspopup="true"
          autoFocus={index === 0}
          onKeyDown={(event) => onButtonKeyDown(event, index)}
          onClick={(event) => void openMenu(menu.id, event.currentTarget)}
          className={MENU_BUTTON_CLASS}
        >
          {menu.label}
        </button>
      ))}
      {/* View > "Right pane width" (spec 013 FR-025, WCAG 2.5.7): the native View menu is built in
          Rust (src-tauri/src/shell/menu.rs), so the renderer-drawn bar carries this entry as its
          own dropdown until the native submenu exists. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            onKeyDown={(event) => onButtonKeyDown(event, MENUS.length)}
            className={MENU_BUTTON_CLASS}
          >
            Right pane width
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" data-app-menu-dropdown>
          <PaneWidthDropdownItems />
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        type="button"
        role="menuitem"
        aria-keyshortcuts="Control+F"
        onKeyDown={(event) => onButtonKeyDown(event, MENUS.length + 1)}
        onClick={findInChat}
        className={MENU_BUTTON_CLASS}
      >
        Find in chat
        <span aria-hidden className="ms-2 text-muted-foreground">
          Ctrl+F
        </span>
      </button>
    </div>
  )
}
