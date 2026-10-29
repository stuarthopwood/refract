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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { SettingSwitchRow } from '@/components/SettingSwitchRow'
import { SELECTED_SEGMENT_CLASS, ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { BrandWatermark } from '@/features/chat/BrandWatermark'
import { HOLIDAY_CONTENT } from '@/features/holidays/holidayContent'
import { useChatWidthStore, useHolidayStore, useSettingsStore, useThemeStore } from '@/state'
import { ThemePicker } from './ThemePicker'
import { ChatWidthPicker } from './ChatWidthPicker'

export function AppearanceSection() {
  // Issue #554: the Save/Cancel row below now governs both pickers -- dirty if EITHER has an
  // open preview, same "disabled={!isDirty}" gate as before.
  const themeDirty = useThemeStore((state) => state.previewing !== null)
  const chatWidthDirty = useChatWidthStore((state) => state.previewing !== null)
  const isDirty = themeDirty || chatWidthDirty
  const watermarkEnabled = useSettingsStore((state) => state.settings.watermarkEnabled)
  const setWatermarkEnabled = useSettingsStore((state) => state.setWatermarkEnabled)
  const holidayTouches = useSettingsStore((state) => state.settings.holidayTouches)
  const setHolidayTouches = useSettingsStore((state) => state.setHolidayTouches)
  const activityText = useSettingsStore((state) => state.settings.activityText ?? 'plain')
  const setActivityText = useSettingsStore((state) => state.setActivityText)
  const animatedStatusText = useSettingsStore((state) => state.settings.animatedStatusText !== false)
  const setAnimatedStatusText = useSettingsStore((state) => state.setAnimatedStatusText)
  const activeHolidayId = useHolidayStore((state) => state.activeHoliday)
  const holidayEntry = holidayTouches !== 'off' && activeHolidayId ? HOLIDAY_CONTENT[activeHolidayId] : null
  const headingRef = useRef<HTMLHeadingElement>(null)
  const wasDirtyRef = useRef(false)
  // Issue #554 gate round 2 (H1): tracks which group's dirty flag most recently went
  // false->true, so the focus-restoration effect below knows which group's checked radio to
  // focus after a Save/Cancel click (when focus was on THAT button, not a radio) -- without
  // this both previews committing via one shared Save always focused Theme's own radio, even
  // when only Chat width had actually been touched.
  const lastDirtyGroupRef = useRef<'theme' | 'chatWidth' | null>(null)
  const prevThemeDirtyRef = useRef(false)
  const prevChatWidthDirtyRef = useRef(false)
  useEffect(() => {
    if (themeDirty && !prevThemeDirtyRef.current) lastDirtyGroupRef.current = 'theme'
    if (chatWidthDirty && !prevChatWidthDirtyRef.current) lastDirtyGroupRef.current = 'chatWidth'
    prevThemeDirtyRef.current = themeDirty
    prevChatWidthDirtyRef.current = chatWidthDirty
  }, [themeDirty, chatWidthDirty])
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
        // Issue #554 gate round 2 (H1, corrected after a live-check falsification): "leave it
        // alone" must key on the focused radio STILL being the CHECKED one after the revert --
        // not merely on focus sitting on any radio. Arrowing back to the saved value flips
        // `chatWidthDirty` false on its own, and the radio focus never left IS the one that
        // becomes checked again, so this correctly leaves it alone. But Escape (or Cancel) away
        // from a DIFFERENT previewed value leaves focus on a radio whose `aria-checked` just
        // flipped to false (the roving-tabindex pattern drops its `tabIndex` to -1 too, but a
        // DOM element never auto-blurs just because its own tabIndex changed) -- a real bug a
        // live check caught: focus stayed on the now-unchecked, now off-roving-tabindex "Full"
        // radio instead of moving to the newly-checked "Reading column" one. Checking
        // `aria-checked === 'true'` on the focused element itself (not merely its role) covers
        // both cases correctly, and also the Save/Cancel-button case below (focus there is on a
        // button, never a radio, so this is false there too).
        const activeIsCheckedRadio =
          active instanceof HTMLElement &&
          active.getAttribute('role') === 'radio' &&
          active.getAttribute('aria-checked') === 'true' &&
          (rootRef.current?.contains(active) ?? false)
        if (!activeIsCheckedRadio) {
          const groupLabel = lastDirtyGroupRef.current === 'chatWidth' ? 'chat-width-heading' : 'theme-heading'
          const checkedRadio = rootRef.current?.querySelector<HTMLElement>(
            `[role="radiogroup"][aria-labelledby="${groupLabel}"] [role="radio"][aria-checked="true"]`
          )
          if (checkedRadio) checkedRadio.focus()
          else headingRef.current?.focus()
        }
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
      // Issue #554: Escape cancels whichever preview(s) are actually open -- a no-op call to
      // `cancelPreview()` when nothing is previewed is harmless (both stores' own contract).
      if (useThemeStore.getState().previewing === null && useChatWidthStore.getState().previewing === null) return
      event.preventDefault()
      useThemeStore.getState().cancelPreview()
      useChatWidthStore.getState().cancelPreview()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // FR-005: navigating away without saving (switching to another Settings section, or leaving
  // Settings entirely) always reverts -- both already unmount this component.
  useEffect(() => {
    return () => {
      useThemeStore.getState().cancelPreview()
      useChatWidthStore.getState().cancelPreview()
    }
  }, [])

  function handleSave() {
    const themeState = useThemeStore.getState()
    if (themeState.previewing !== null) void themeState.save(themeState.previewing)
    const chatWidthState = useChatWidthStore.getState()
    if (chatWidthState.previewing !== null) void chatWidthState.save(chatWidthState.previewing)
  }

  function handleCancel() {
    useThemeStore.getState().cancelPreview()
    useChatWidthStore.getState().cancelPreview()
  }

  return (
    <div ref={rootRef}>
      <h2 ref={headingRef} tabIndex={-1} className="mb-1 text-base font-semibold outline-none">Appearance</h2>
      <p className="mb-4 text-sm text-muted-foreground">Choose how the app looks and reads.</p>
      {/* Issue #554 gate round 2 (L1): each group now gets its own heading and hint, wired via
          aria-labelledby/aria-describedby instead of a bare aria-label on the radiogroup -- this
          intro paragraph above is the shared lead-in for the whole section, not Theme's own. */}
      <h3 id="theme-heading" className="mb-1 text-sm font-medium">Theme</h3>
      <p id="theme-hint" className="mb-2 text-xs text-muted-foreground">The colour palette used across the app.</p>
      <ThemePicker labelledBy="theme-heading" describedBy="theme-hint" />
      <h3 id="chat-width-heading" className="mt-4 mb-1 text-sm font-medium">Chat width</h3>
      <p id="chat-width-hint" className="mb-2 text-xs text-muted-foreground">How wide the chat transcript reads.</p>
      <ChatWidthPicker labelledBy="chat-width-heading" describedBy="chat-width-hint" />
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
        <div className="flex flex-col gap-1">
          <label htmlFor="watermark-toggle" className="text-sm">Background watermark</label>
          <span id="watermark-toggle-description" className="text-xs text-muted-foreground">
            {holidayEntry ? 'A faint mark shown in the corner of the chat area — a seasonal glyph while a holiday is active.' : 'A faint Refract mark shown in the corner of the chat area.'}
          </span>
        </div>
        <Switch
          id="watermark-toggle"
          aria-describedby="watermark-toggle-description"
          checked={watermarkEnabled}
          onCheckedChange={(checked) => void setWatermarkEnabled(checked)}
        />
      </div>
      <div className="mt-2 flex size-28 items-center justify-center rounded-md border border-border">
        <BrandWatermark variant="preview" />
      </div>
      {/* Issue #1048 (Holiday touches): applies live, next to the watermark switch, the same
          "no Save/Cancel" posture spec 012's own control above uses. */}
      <div className="mt-6 flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="holiday-touches-select" className="text-sm">Holiday touches</label>
          <span id="holiday-touches-description" className="text-xs text-muted-foreground">Seasonal artwork and ambient motion near a holiday.</span>
        </div>
        <Select value={holidayTouches} onValueChange={(value) => void setHolidayTouches(value as typeof holidayTouches)}>
          <SelectTrigger id="holiday-touches-select" aria-describedby="holiday-touches-description" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="full">Full</SelectItem>
            <SelectItem value="artwork">Artwork only</SelectItem>
            <SelectItem value="off">Off</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {/* #526 (FR-111): applies live, same posture as Holiday touches. The shared segmented
          `ToggleGroup` (ProviderSwitch, ManageSessionsToolbar) -- no one-off control. */}
      <div className="mt-6 flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span id="activity-text-label" className="text-sm">Activity text</span>
          <span id="activity-text-description" className="text-xs text-muted-foreground">
            Shown for each Session in the Session list and in the banner above the composer when it has
            nothing more specific to say. Plain shows &ldquo;Working…&rdquo;; Playful shows a friendly
            phrase such as &ldquo;On it…&rdquo;.
          </span>
        </div>
        <ToggleGroup
          type="single"
          value={activityText}
          onValueChange={(value) => {
            // Radix emits '' when the selected segment is clicked again; keep one selected.
            if (value === 'plain' || value === 'playful') void setActivityText(value)
          }}
          variant="outline"
          size="sm"
          spacing={0}
          aria-labelledby="activity-text-label"
          aria-describedby="activity-text-description"
        >
          <ToggleGroupItem value="plain" className={SELECTED_SEGMENT_CLASS}>Plain</ToggleGroupItem>
          <ToggleGroupItem value="playful" className={SELECTED_SEGMENT_CLASS}>Playful</ToggleGroupItem>
        </ToggleGroup>
      </div>
      {/* Issue #1242 (FR-042): applies live; also lets the user stop the looping shimmer (WCAG 2.2.2). */}
      <div className="mt-6">
        <SettingSwitchRow
          id="animated-status-text"
          label="Animated status text"
          description="A moving highlight on the status line above the message box while the agent is working. Always still when you have reduced motion on."
          checked={animatedStatusText}
          onCheckedChange={(checked) => void setAnimatedStatusText(checked)}
        />
      </div>
    </div>
  )
}
