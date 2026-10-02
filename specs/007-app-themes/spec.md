# Feature Specification: App themes

**Feature Branch**: `007-app-themes` (no branch created; work lands on `main`)
**Created**: 2026-10-02
**Status**: Draft
**Input**: Stuart's request: "Feat: Whole app is themable. Default respect os default, Custom
theme picker in settings with live preview." Backlog issue #4 ("Settings screen: theme, UI font,
code font") and `docs/DESIGN.md` ("Look and feel") record dark-by-default with a light option as
a provisional default; this spec replaces that default with the OS-following behaviour below and
adds the Appearance section of the Settings screen (spec 004) that picks a theme. UI font and
code font stay with issue #4 and are out of scope here.

## Clarifications

### Session 2026-10-02

- Q: What is a custom theme? -> A: Presets only: the developer picks from a built-in list of
  complete themes; there is no colour editor, and no import or export.
- Q: What does live preview mean? -> A: Repaint the whole app live: choosing a theme in Settings
  repaints the whole app immediately while Settings is open; Save keeps it, and Cancel or leaving
  Settings reverts it.
- Q: What is the default theme? -> A: Follow the OS until you choose: first launch follows the
  Windows light-or-dark setting and keeps following it as that setting changes, until the
  developer picks a theme in Settings.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Follow the OS by default (Priority: P1)

A developer installs Refract and opens it for the first time without touching any settings. The
app starts in whichever of its built-in Light or Dark appearance matches Windows' current
light-or-dark setting. If the developer later changes that Windows setting, Refract follows along
live, without a restart, for as long as the developer has not picked a theme of their own in
Settings.

**Why this priority**: This is the behaviour every developer gets without taking any action, and
it is the baseline every other story in this spec is a deliberate departure from; nothing else in
this spec is testable without it.

**Independent Test**: Install Refract fresh, open it with Windows set to dark, and confirm it
opens dark. Switch Windows to light while Refract is open and confirm it switches without a
restart. Open Settings and confirm the theme picker shows "System" as the current entry.

**Acceptance Scenarios**:

1. **Given** a fresh install with no theme ever chosen, **When** the developer opens Refract while
   Windows is set to its dark appearance, **Then** Refract opens using its Dark built-in theme.
2. **Given** the same fresh state, **When** the developer opens Refract while Windows is set to
   its light appearance, **Then** Refract opens using its Light built-in theme.
3. **Given** Refract is open and no theme has been chosen, **When** the developer changes Windows'
   light-or-dark setting, **Then** Refract's active theme changes to match, without the developer
   restarting Refract or any Session.
4. **Given** no theme has been chosen, **When** the developer opens the Settings screen's
   Appearance section, **Then** the theme picker shows "System" as the currently selected entry.
5. **Given** a theme has previously been chosen and saved, **When** the developer changes Windows'
   light-or-dark setting, **Then** Refract's active theme does not change, because it is no longer
   following the OS.

---

### User Story 2 - Pick a theme in Settings with a live preview (Priority: P1)

A developer opens the Settings screen (spec 004) and finds an Appearance section with a theme
picker: "System" plus every built-in theme, each shown by name with a small colour swatch, and the
currently active one marked in text as well as by colour. Choosing a different entry repaints the
whole app immediately, so the developer can see it against their own chat, code, and session
list before committing to it. Save keeps the choice; Cancel, Esc, or leaving Settings without
saving puts the previous theme back.

**Why this priority**: This is the entire feature Stuart asked for: without a picker there is
nothing to choose, and without a live, whole-app preview the picker is no better than reading a
name off a list.

**Independent Test**: Open Settings, choose a theme other than the current one, confirm the whole
app repaints immediately (not a sample swatch), press Cancel, and confirm the app reverts to the
previous theme. Repeat, this time pressing Save, reopen Settings, and confirm the chosen theme is
still the one marked current.

**Acceptance Scenarios**:

1. **Given** the Settings screen, **When** the developer looks at the Appearance section,
   **Then** it shows a theme picker listing "System" first, then every built-in theme, each with
   its name and a small colour swatch, and the currently active entry marked both in text and by
   colour.
2. **Given** the theme picker, **When** the developer chooses a different entry, **Then** the
   whole app — not only a sample area inside Settings — repaints immediately to that theme's
   colours.
3. **Given** a theme has been chosen but not saved, **When** the developer activates Save,
   **Then** that theme becomes the app's persisted choice and stops the app from following the OS.
4. **Given** a theme has been chosen but not saved, **When** the developer activates Cancel,
   presses Esc, or navigates away from Settings to another screen, **Then** the app reverts to
   whichever theme (a saved theme, or System) was active before the picker was opened.
5. **Given** the app is following System, **When** the developer chooses "System" in the picker
   and saves, **Then** nothing changes visibly, and any previously saved specific theme is
   cleared so the app resumes following the OS.
6. **Given** the theme picker, **When** the developer operates it using only the keyboard,
   **Then** arrow keys move between entries, the focused entry shows a visible focus indicator,
   and Enter or Save commits the focused entry the same way a pointer choice would.

---

### User Story 3 - Everything follows the theme (Priority: P2)

Whatever theme is active, every part of the app reflects it: the chat transcript and its tool
rows, code blocks and their syntax colours, diffs, the session list and its state colours,
dialogs and menus, toasts, tooltips and hover cards, the chip row, scrollbars, selection and focus
rings, and the Settings screen itself. No part of the app keeps a colour fixed to light or dark
regardless of which theme is active, and every built-in theme stays readable and keeps the four
Session states tellable apart.

**Why this priority**: A theme that recolours the chrome but leaves code blocks, diffs, or the
session list stuck in one appearance looks broken rather than themed; this story is what makes
"whole app is themable" true rather than partial, but it depends on Stories 1 and 2 existing
first to have something to apply.

**Independent Test**: Switch through every built-in theme one at a time and, for each, check the
chat transcript, a code block, a diff, the session list's four states, an open dialog, a toast, a
tooltip, the chip row, a scrollbar, and the Settings screen itself; confirm each reflects the
active theme and that text and state icons stay readable and tellable apart throughout.

**Acceptance Scenarios**:

1. **Given** any built-in theme is active, **When** the developer looks at the chat transcript,
   tool rows, code blocks, and diffs, **Then** their colours match that theme, including the
   code blocks' syntax colours.
2. **Given** any built-in theme is active, **When** the developer looks at the session list,
   **Then** its background and the four Session states (working, idle, needs you, stopped) use
   that theme's colours, and each state is still distinguishable from the others by icon and text,
   not only by colour.
3. **Given** any built-in theme is active, **When** a dialog, menu, toast, tooltip, or hover card
   is shown, **Then** it uses that theme's colours rather than a fixed light or dark appearance.
4. **Given** any built-in theme is active, **When** the developer looks at the chip row,
   scrollbars, or any selection or focus ring, **Then** they use that theme's colours.
5. **Given** any built-in theme is active, **When** the developer opens the Settings screen,
   **Then** Settings itself uses that theme's colours rather than a fixed appearance.
6. **Given** any built-in theme, **When** its text and non-text parts are measured, **Then** body
   text meets at least 4.5:1 contrast and large text and non-text parts (such as focus rings and
   scrollbar thumbs) meet at least 3:1, matching WCAG AA.

---

### User Story 4 - The theme survives and applies everywhere (Priority: P2)

Once the developer saves a theme (or returns to System), that choice survives closing and
reopening Refract, and it applies to every pane and panel at once: a split chat pane (spec 005),
the side panel (spec 004), and a window opened later, all starting in the right theme from their
very first paint, with no flash of the wrong appearance.

**Why this priority**: A theme choice that resets on restart, or that only some panes pick up,
undermines Stories 1 through 3; this is lower priority than choosing and applying a theme because
it is about durability rather than the core behaviour.

**Independent Test**: Save a non-default theme, restart Refract, and confirm it opens already in
that theme with no visible flash of another appearance. Open a split chat pane and the Settings
side panel and confirm both show the same theme.

**Acceptance Scenarios**:

1. **Given** a theme was saved (or System was last chosen), **When** Refract is closed and
   reopened, **Then** it opens in that same theme.
2. **Given** Refract is starting up, **When** its window first paints, **Then** it already shows
   the saved theme or System's current match; it never shows an unthemed or wrongly themed frame
   first.
3. **Given** a saved theme, **When** the developer opens a second pane in a split chat (spec 005)
   or the Settings side panel (spec 004), **Then** both show the same active theme as the rest of
   the app.

---

### Edge Cases

- Windows switches its light-or-dark setting while the developer is previewing an unsaved theme
  in Settings: the preview wins until Save or Cancel; the OS change takes effect only once the
  developer is back in System mode.
- The developer closes Refract while previewing an unsaved theme: nothing is persisted; the next
  launch shows whatever was last saved (a specific theme, or System).
- A saved theme no longer exists among the built-in themes (for example, after an app update
  removes it): Refract falls back to System rather than failing to render or showing stale
  colours.
- The developer has the OS reduced-motion setting on: switching themes shows no animated
  transition between the old and new colours.
- A developer who needs higher contrast than Light or Dark provide: at least one built-in theme
  is a dedicated high-contrast theme.
- A screenshot or a screen reader user: the live repaint itself is not announced to assistive
  technology; only the picker's own selection-state text changes are.
- A code block whose language has no syntax-colour entry in the active theme: it still renders
  using the theme's base text and background colours, without an error.
- A diagram (Mermaid, spec 001 FR-043) uses colours baked into the diagram itself: it either
  follows the active theme or uses a fixed palette that stays readable against every built-in
  theme's background.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: On first launch, before the developer has ever chosen a theme, Refract MUST start
  in whichever of its Light or Dark built-in theme matches the Windows light-or-dark appearance
  setting at that moment.
- **FR-002**: While no theme has been chosen (System mode), Refract MUST keep following the
  Windows light-or-dark setting live: a change to that OS setting MUST change Refract's active
  theme without the developer restarting Refract or any Session.
- **FR-003**: The Settings screen (spec 004) MUST include an Appearance section containing a
  theme picker listing "System" first, then every built-in theme, each shown by its name and a
  small colour swatch.
- **FR-004**: The theme picker MUST mark the entry matching the currently active theme both in
  its text and by colour; while in System mode, the "System" entry MUST be the one marked.
- **FR-005**: Choosing a different entry in the theme picker MUST repaint the whole app
  immediately to that entry's colours, covering every pane and panel visible at that moment, not
  only a sample area inside Settings.
- **FR-006**: A theme chosen in the picker MUST NOT become the app's lasting choice until the
  developer activates Save; activating Save MUST persist that choice (a specific theme, or
  System) as the one Refract starts in and follows afterwards.
- **FR-007**: Activating Cancel, pressing Esc, or navigating away from Settings without saving
  MUST revert the app to whichever theme (a saved theme, or System) was active before the picker
  was opened.
- **FR-008**: Choosing "System" in the picker and saving MUST clear any previously saved specific
  theme and return the app to following the Windows light-or-dark setting live (FR-002).
- **FR-009**: The theme picker MUST be fully keyboard operable: arrow keys MUST move the focus
  between entries, the focused entry MUST show a visible focus indicator, and confirming the
  focused entry MUST have the same effect as choosing it with the pointer.
- **FR-010**: Every themed surface — the chat transcript and its tool rows, code blocks and their
  syntax colours, diffs, the session list and its state colours, dialogs and menus, toasts,
  tooltips and hover cards, the chip row, scrollbars, selection and focus rings, and the Settings
  screen itself — MUST take its colours from the active theme; none of them MUST keep a
  hard-coded light or dark colour regardless of which theme is active.
- **FR-011**: Each built-in theme MUST meet WCAG AA contrast: at least 4.5:1 for body text and at
  least 3:1 for large text and non-text UI parts, including focus rings and scrollbar thumbs.
- **FR-012**: In every built-in theme, the four Session states (working, idle, needs you, stopped)
  MUST stay distinguishable from one another by icon and text, not only by colour.
- **FR-013**: The built-in theme list MUST include at least one dedicated high-contrast theme in
  addition to Light and Dark.
- **FR-014**: The saved theme choice (a specific theme, or System) MUST persist across Refract
  restarts and MUST apply to every pane and panel, including a split chat pane (spec 005) and the
  Settings side panel (spec 004), and to a window opened after the choice was made.
- **FR-015**: A Refract window MUST show the correct theme — the saved theme, or System's current
  match — from its first paint; it MUST NOT show an unthemed or wrongly themed frame first.
- **FR-016**: When the saved theme no longer exists among the built-in themes, Refract MUST fall
  back to System mode rather than failing to render or keeping stale colours.
- **FR-017**: Switching the active theme MUST NOT play an animated transition between the old and
  new colours while the developer's OS reduced-motion setting is on.
- **FR-018**: A fenced code block (spec 001 FR-050) whose language has no syntax-colour entry in
  the active theme MUST still render using that theme's base text and background colours, without
  an error.
- **FR-019**: A Mermaid diagram (spec 001 FR-043) MUST either follow the active theme's colours or
  use a fixed palette that stays readable against the background of every built-in theme.
- **FR-020**: The live repaint triggered by choosing an entry in the theme picker MUST NOT be
  announced to assistive technology beyond the picker's own selection-state text changing.
- **FR-021**: While Windows' light-or-dark setting changes during an unsaved preview in Settings,
  the previewed theme MUST remain shown; the OS change MUST take effect only once the developer
  returns to System mode, by choosing "System" or by Cancel reverting to a prior System state.
- **FR-022**: Closing Refract while an unsaved theme is being previewed MUST NOT persist that
  preview; the next launch MUST show whatever was last saved (a specific theme, or System).

### Key Entities

- **Theme**: one complete, named set of colours covering every themed surface in FR-010; built in
  to Refract, never edited, imported, or exported by the developer.
- **Theme setting**: the app-wide, persisted record of either a specific Theme or System,
  defaulting to System on first launch, read at startup and by every pane, panel, and window.
- **Theme picker**: the Appearance section control listing System and every Theme by name and
  swatch, marking the currently active one, and driving the live, whole-app repaint described in
  User Story 2.
- **Preview**: the app's momentarily active theme while a choice in the picker has been made but
  not yet saved; discarded on Cancel, Esc, leaving Settings, or closing Refract, without changing
  the persisted Theme setting.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A fresh install with no theme ever chosen opens matching the Windows light-or-dark
  setting, 100% of the time, across both OS settings.
- **SC-002**: While following System, changing the Windows light-or-dark setting changes Refract's
  active theme within 2 seconds, with no restart of Refract or any Session.
- **SC-003**: Choosing an entry in the theme picker repaints every visible pane and panel within 1
  second, not only a sample area inside Settings.
- **SC-004**: Leaving the theme picker without saving — by Cancel, Esc, or navigating away —
  reverts to the theme that was active before the picker opened, 100% of the time.
- **SC-005**: After a full app restart, Refract shows the saved theme (or System's current match)
  from the window's first paint, with no observable flash of another appearance, 100% of the time.
- **SC-006**: Every built-in theme meets WCAG AA contrast (at least 4.5:1 for body text, at least
  3:1 for large text and non-text parts) across every surface listed in FR-010.
- **SC-007**: In every built-in theme, including the high-contrast one, the four Session states
  remain distinguishable from one another by icon and text alone, with colour removed.
- **SC-008**: A developer using only the keyboard can select any entry in the theme picker, see it
  previewed live, and commit it with Save or discard it with Cancel, with a visible focus
  indicator throughout.

## Assumptions

- The built-in theme list is Light and Dark (the two System mode picks between), plus at least
  one high-contrast theme, and at least one further dark and one further light variant. This is a
  reading of "theme picker" implying more than a two-entry list; the exact list and names are
  decided in planning and should be confirmed with Stuart.
- There is no colour editor, and no import or export of themes, per Stuart's "Presets only"
  answer; both are candidates for a later spec, not this one.
- The UI font and code font settings named in backlog issue #4 stay with that issue; this spec
  covers colour themes only.
- The theme setting is app-wide, not per-Session, stored alongside Refract's other settings (for
  example Approval mode and the Session readout choices from spec 004), matching how those
  settings already work.
- "Save" has the same keep-the-choice meaning in this spec as elsewhere in Refract; Cancel, Esc,
  and leaving the screen are treated as equivalent ways to discard a preview, because Stuart's
  "live preview" answer named Save and Cancel specifically and did not distinguish Esc or
  navigating away from Cancel.
- This spec depends on spec 004 for the Settings screen the Appearance section is added to, and on
  spec 001 FR-043 (Mermaid diagrams), FR-050 (code block language fallback), and the session
  list's state colour roles (`docs/DESIGN.md`, "Look and feel") for the surfaces User Story 3
  must cover. A scrollbar-styling requirement is referenced as one of those surfaces on the
  assumption that scrollbars are themed regardless of which spec first styles them.
- Windows 11 is the only supported platform, consistent with the constitution; "OS reduced-motion
  setting" and "Windows light-or-dark setting" both mean the corresponding Windows 11 setting.
- No remote content or downloaded themes: every built-in theme ships with the app.
