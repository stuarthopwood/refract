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
import type { AppMenuId } from '../../../shared/ipc'

const MENUS: Array<{ id: AppMenuId; label: string }> = [
  { id: 'file', label: 'File' },
  { id: 'edit', label: 'Edit' },
  { id: 'view', label: 'View' },
  { id: 'window', label: 'Window' }
]

export function AppMenuBar() {
  const [visible, setVisible] = useState(false)
  const barRef = useRef<HTMLDivElement>(null)
  // Armed on Alt's own keydown; any other keydown before the matching keyup disarms it, so a
  // held Alt used as part of a shortcut never toggles the bar, only a standalone tap does.
  const altArmedRef = useRef(false)

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      altArmedRef.current = event.key === 'Alt'
    }
    function onKeyUp(event: KeyboardEvent): void {
      if (event.key !== 'Alt') return
      if (altArmedRef.current) setVisible((current) => !current)
      altArmedRef.current = false
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  useEffect(() => {
    if (!visible) return
    function onMouseDown(event: MouseEvent): void {
      if (barRef.current?.contains(event.target as Node)) return
      setVisible(false)
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setVisible(false)
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [visible])

  async function openMenu(menuId: AppMenuId, target: HTMLElement): Promise<void> {
    const rect = target.getBoundingClientRect()
    const result = await window.refract.window.popupMenu(menuId, Math.round(rect.left), Math.round(rect.bottom))
    if (!result.ok) notify(result.error)
  }

  function focusButton(index: number): void {
    const buttons = barRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')
    buttons?.[(index + MENUS.length) % MENUS.length]?.focus()
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
      className="fixed left-0 top-0 z-50 flex h-10 items-center gap-1 border-b border-border bg-card px-2 text-sm text-card-foreground shadow-md"
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
          className="px-2.5 py-1 hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {menu.label}
        </button>
      ))}
    </div>
  )
}
