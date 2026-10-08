// Spec 007 US2: the Appearance settings section (FR-001 - FR-006) -- the first section in this
// screen needing its own commit/discard step (unlike "Session readout", whose toggles apply
// live with no Save). Save persists whichever entry the picker currently shows chosen
// (`previewing ?? theme`, already live the instant the user clicks/arrows onto it via
// `ThemePicker`'s own `preview` calls -- FR-003), Cancel discards it. Escape and unmounting
// (switching Settings sections, or leaving Settings entirely) both revert any open preview the
// same way (FR-005) -- `cancelPreview` is a genuine no-op once nothing is being previewed, so
// firing it unconditionally on unmount never fights a Save that just completed.
import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { BrandWatermark } from '@/features/chat/BrandWatermark'
import { useSettingsStore, useThemeStore } from '@/state'
import { ThemePicker } from './ThemePicker'

export function AppearanceSection() {
  const isDirty = useThemeStore((state) => state.previewing !== null)
  const watermarkEnabled = useSettingsStore((state) => state.settings.watermarkEnabled)
  const setWatermarkEnabled = useSettingsStore((state) => state.setWatermarkEnabled)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const wasDirtyRef = useRef(false)
  // Quality-gate remediation (a11y, round 2): scopes the focus-restoration effect below (and
  // its radio-group query) to THIS section's own DOM subtree, so a future section also titled
  // 'Theme' (spec 008's planned Theme submenu) can never be matched by mistake, and so the
  // effect can tell whether focus was already inside this section before moving it.
  const rootRef = useRef<HTMLDivElement>(null)

  // Matches SettingsScreen.tsx's own "Session readout" heading-focus pattern: this component
  // mounts fresh every time the developer switches to this section (SettingsScreen renders it
  // conditionally, never keeping it mounted-but-hidden), so focusing its own heading here covers
  // exactly the same case that pattern already covers for the other section.
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  // Quality-gate remediation (a11y, HIGH, corroborated -- this repo already treats this exact
  // failure mode as a High fix elsewhere, SettingsScreen.tsx/lib/focus.ts): Save/Cancel use
  // native `disabled={!isDirty}`, so the instant either completes and `isDirty` flips back to
  // false, Chromium silently drops focus to `<body>` rather than leaving it on the button that
  // is about to become disabled. Move focus to the picker's now-checked radio entry (falling
  // back to this section's own heading) right after that transition, the same "focus somewhere
  // meaningful after the blur" pattern `focusSettingsEntry`/`focusSessionsNav` already use.
  useEffect(() => {
    if (wasDirtyRef.current && !isDirty) {
      // Quality-gate remediation (a11y, round 2): only steal focus if it wasn't already
      // somewhere deliberate OUTSIDE this section (e.g. the Settings nav) when Save/Cancel/
      // Escape fired -- Escape in particular can fire while focus is still on a nav item, and
      // this effect previously yanked it into this section's radio group regardless.
      const active = document.activeElement
      const activeWasOutside = active !== null && active !== document.body && !rootRef.current?.contains(active)
      if (!activeWasOutside) {
        const checkedRadio = rootRef.current?.querySelector<HTMLElement>(
          '[role="radiogroup"][aria-label="Theme"] [role="radio"][aria-checked="true"]'
        )
        if (checkedRadio) checkedRadio.focus()
        else headingRef.current?.focus()
      }
    }
    wasDirtyRef.current = isDirty
  }, [isDirty])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      // Quality-gate remediation (round 5, a11y -- corroborated by two independent reviewers):
      // holding Escape down to close AppMenuBar.tsx's Alt-opened bar auto-repeats a `keydown`
      // (~500ms after the first, then faster). By the time that repeat event fires, AppMenuBar's
      // own listener has already unmounted (it closed on the first, genuine Escape), so the
      // repeat event reaches only this listener, and AppMenuBar's root (and the `role="menubar"`
      // guard below) is already gone from the DOM too -- nothing stopped this handler from
      // treating the repeat as a brand-new Escape and cancelling an in-progress theme preview the
      // user never intended to touch. A round-4 fix tried to solve this from AppMenuBar.tsx's own
      // side instead (an `event.repeat` guard there); it never worked, for the same reason (that
      // listener is already gone by repeat time) -- see AppMenuBar.tsx's own comment. The actual
      // fix has to live here, on the listener that is still attached when the repeat arrives.
      if (event.repeat) return
      // Quality-gate remediation (HIGH): the old `[role="dialog"]` selector (and no
      // `defaultPrevented` check) stole Escape from the Alt menu bar and any Radix
      // menu/listbox too, silently cancelling an unrelated preview -- narrowed to spec 005's
      // own already-fixed pattern (round-3 remediation), which only matches a REAL modal.
      //
      // Quality-gate remediation (a11y, round 2, corroborated by all three reviewers): the
      // `defaultPrevented` check above only works if AppMenuBar.tsx's own Escape listener
      // happens to run first -- it does not when AppMenuBar's bar-visible listener attaches
      // AFTER this component already has (the common case: Settings > Appearance opened, THEN
      // Alt pressed). Guarding on `[role="menubar"]` directly checks whether the Alt bar is
      // open right now, independent of event-listener registration order.
      //
      // Quality-gate remediation (Low, round 4): scoped to AppMenuBar's own `aria-label="App
      // menu"` specifically (set on its root alongside `role="menubar"`) -- a bare
      // `[role="menubar"]` would also match ANY future unrelated menubar Refract adds, silently
      // disabling this Escape-to-cancel guard for every one of them too.
      if (document.querySelector('[role="alertdialog"], [role="dialog"][aria-modal="true"], [role="menubar"][aria-label="App menu"]')) return
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
    <div ref={rootRef}>
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
      {/* Spec 012 (research.md decisions 9, 14): applies live, no Save/Cancel -- the divider
          plus this control's own clear labelling keeps that from reading as governed by the
          row above it. */}
      <hr className="my-6 border-divider" />
      <div className="flex items-center justify-between gap-4">
        {/* Quality-gate remediation (accessibility-auditor, Low): the whole two-line block (title
            plus description) used to sit inside the <label>, so a screen reader announced both
            every time this control got focus -- putting only the title in the label and wiring
            the description in via `aria-describedby` (the same pattern as a native form hint)
            announces the title as the name and the description separately, once, as a hint. */}
        <div className="flex flex-col gap-0.5">
          <label htmlFor="watermark-toggle" className="text-sm font-medium">Background watermark</label>
          <span id="watermark-toggle-description" className="text-xs text-muted-foreground">A faint Refract mark shown in the corner of the chat area.</span>
        </div>
        <Switch
          id="watermark-toggle"
          aria-describedby="watermark-toggle-description"
          checked={watermarkEnabled}
          onCheckedChange={(checked) => void setWatermarkEnabled(checked)}
        />
      </div>
      <div className="mt-3 flex size-28 items-center justify-center rounded-md border border-border">
        <BrandWatermark variant="preview" />
      </div>
    </div>
  )
}
