// Spec 007 US2: the Appearance settings section (FR-001 - FR-006) -- the first section in this
// screen needing its own commit/discard step (unlike "Session readout", whose toggles apply
// live with no Save). Save persists whichever entry the picker currently shows chosen
// (`previewing ?? theme`, already live the instant the user clicks/arrows onto it via
// `ThemePicker`'s own `preview` calls -- FR-003), Cancel discards it. Escape and unmounting
// (switching Settings sections, or leaving Settings entirely) both revert any open preview the
// same way (FR-005) -- `cancelPreview` is a no-op once nothing is being previewed, so firing it
// unconditionally on unmount never fights a Save that just completed.
import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { useThemeStore } from '@/state'
import { ThemePicker } from './ThemePicker'

export function AppearanceSection() {
  const isDirty = useThemeStore((state) => state.previewing !== null)
  const headingRef = useRef<HTMLHeadingElement>(null)

  // Matches SettingsScreen.tsx's own "Session readout" heading-focus pattern: this component
  // mounts fresh every time the developer switches to this section (SettingsScreen renders it
  // conditionally, never keeping it mounted-but-hidden), so focusing its own heading here covers
  // exactly the same case that pattern already covers for the other section.
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      // Same dialog-open skip guard App.tsx's own window-scoped Ctrl+Shift+\ listener uses --
      // don't steal Escape from a modal (e.g. a future confirm dialog) that should handle it.
      if (document.querySelector('[role="alertdialog"], [role="dialog"]')) return
      if (useThemeStore.getState().previewing === null) return
      event.preventDefault()
      useThemeStore.getState().cancelPreview()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // FR-005: navigating away without saving (switching to another Settings section, or leaving
  // Settings entirely) always reverts -- both already unmount this component.
  useEffect(() => {
    return () => {
      useThemeStore.getState().cancelPreview()
    }
  }, [])

  function handleSave() {
    const state = useThemeStore.getState()
    void state.save(state.previewing ?? state.theme)
  }

  function handleCancel() {
    useThemeStore.getState().cancelPreview()
  }

  return (
    <div>
      <h2 ref={headingRef} tabIndex={-1} className="mb-1 text-base font-semibold outline-none">Appearance</h2>
      <p className="mb-4 text-sm text-muted-foreground">Choose the colour theme used across the app.</p>
      <ThemePicker />
      <div className="mt-4 flex gap-2">
        <Button variant="default" size="sm" onClick={handleSave} disabled={!isDirty}>
          Save
        </Button>
        <Button variant="outline" size="sm" onClick={handleCancel} disabled={!isDirty}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
