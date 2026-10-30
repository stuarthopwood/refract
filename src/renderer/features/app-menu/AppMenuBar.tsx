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

// Ids come from the shared `APP_MENU_IDS`; only the label is local.
const MENUS: Array<{ id: AppMenuId; label: string }> = APP_MENU_IDS.map((id) => ({ id, label: MENU_LABEL[id] }))

const MENU_BUTTON_CLASS =
  'px-2 py-1 hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/** In-app menu bar toggled by a standalone Alt tap; each item opens the native menu by id. */
export function AppMenuBar() {
  const [visible, setVisible] = useState(false)
  const barRef = useRef<HTMLDivElement>(null)
  // Armed on Alt keydown, disarmed by any other key, blur or pointerdown, so Alt+Tab away and back can't leave it armed.
  const altArmedRef = useRef(false)
  // Focus before the bar opened, restored on dismissal; only captured while focus is outside the bar (else the second Alt tap would clobber it).
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
      // A click away chooses a new focus target; clear the ref so the restore effect doesn't fight it.
      previousFocusRef.current = null
      setVisible(false)
    }
    function onKeyDown(event: KeyboardEvent): void {
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

  // Restores pre-bar focus on Esc or a second Alt tap; a click-away clears the ref first, making this a no-op.
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
      {/* The native View menu lacks "Right pane width", so the bar carries it as a dropdown (WCAG 2.5.7). */}
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
