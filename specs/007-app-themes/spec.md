# Feature Specification: App themes

**Feature Branch**: `007-app-themes` (no branch created; work lands on `main`)
**Created**: 2026-10-02
**Status**: Draft
**Input**: Stuart's request: "Feat: Whole app is themable. Default respect os default, Custom
theme picker in settings with live preview." Backlog issue #4 ("Settings screen: theme, UI font,
code font") and `docs/DESIGN.md` ("Look and feel") record dark-by-default with a light option as
a provisional default; this spec replaces that default with the dark-preset-only picker described
below and adds the Appearance section of the Settings screen (spec 004) that picks a theme. UI
font and code font stay with issue #4 and are out of scope here.

## Clarifications

### Session 2026-10-02

- Q: What is a custom theme? -> A: Presets only: the developer picks from a built-in list of
  complete themes; there is no colour editor, and no import or export.
- Q: What does live preview mean? -> A: Repaint the whole app live: choosing a theme in Settings
  repaints the whole app immediately while Settings is open; Save keeps it, and Cancel or leaving
  Settings reverts it.
- Q: What is the default theme? -> A: Follow the OS until you choose: first launch follows the
  Windows light-or-dark setting and keeps following it as that setting changes, until the
  developer picks a theme in Settings. (Superseded by the later session below: there is no OS
  setting to follow, since there is no light theme.)

### Session 2026-10-02 (later)

- Q: Does Refract offer a light theme? -> A: No. Dark only: every built-in theme is a dark-toned
  preset; there is no light theme, and no OS-follow/System mode, since there is nothing to follow
  between.

### Session 2026-10-20 (#1039, grilled 2026-10-19, none deferred)

- Q: What should Cyber Amber's surfaces look like? -> A: Default Dark's own lightness ladder.
  **Amended same day (Stuart, issue comment): PURE neutral greys, chroma 0 -- no warm tint on
  any surface token.** No more distinct, browner canvas of its own.
- Q: What is Cyber Amber's accent? -> A: A vivid orange, settling the preset's own open
  question (peach or amber) as neither: accent text and links are about `#fb923c`; the filled
  Send/primary button is about `#c2410c` with white text.
- Q: Does Cyber Amber's warning colour change? -> A: No -- it stays golden amber, and MUST stay
  visually distinct from the new accent by hue, so a warning never reads as an accent
  (`docs/design/foundations-icons.md:53`, "colour is meaning").
- Q: Does the softer-text change apply to every built-in theme? -> A: No -- only Default Dark
  and Cyber Amber. `--foreground` moves from near-white to about `oklch(0.90 0 0)`;
  `--chat-foreground` goes a step softer, to about `oklch(0.86 0 0)`; muted text stays a clear
  step below both, and every text pair keeps 4.5:1 or better. **Superseded the same day (see
  the final 2026-10-20 session below): #1039 drops its own text softening entirely.**

### Session 2026-10-20 (later, #1039 issue comment amendment)

- Q: The first #1039 cut gave Cyber Amber's surfaces a barely-visible warm tint (chroma 0.005,
  hue 50) -- does that stay? -> A: No. Every surface token (`--background`, `--sidebar`,
  `--card`/`--popover`, `--muted`/`--accent`/`--secondary`, `--border`, `--input`) becomes PURE
  neutral (chroma 0), byte-identical to Default Dark's own surface tokens. The orange accent
  and the warning-hue move are unchanged. **Corrected same day (Stuart): the softer text
  (`--foreground`/`--chat-foreground`/`--muted-foreground`) is ALSO pure neutral, byte-identical
  to Default Dark's own text tokens -- see the follow-up session below.**

### Session 2026-10-20 (later still, #1039 correction -- text tokens are neutral too)

- Q: Round 1 of the 2026-10-20 amendment left Cyber Amber's text tokens
  (`--foreground`/`--chat-foreground`/`--muted-foreground`) at the first #1039 cut's own faint
  warm tint -- is that right? -> A: No. The original grill item 3 set `--foreground` ≈
  `oklch(0.90 0 0)` and `--chat-foreground` ≈ `oklch(0.86 0 0)` -- chroma 0, in BOTH themes.
  Every Cyber Amber text token (`--foreground`, `--chat-foreground`, `--muted-foreground`, and
  every token that aliases `--foreground` -- `--card-foreground`, `--popover-foreground`,
  `--accent-foreground`, `--sidebar-foreground`, `--secondary-foreground`,
  `--sidebar-accent-foreground`) becomes chroma 0, byte-identical to Default Dark's own text
  tokens. Only the accent family (`--accent-text`, `--primary`/`--send`, markdown links), the
  warning hue, and `themes.ts`'s own `swatchPrimary` differ from Default Dark -- `--ring` is
  NOT part of this family (the achromatic-ring decision, 2026-10-09, applies here too; gate
  round 1 correction, 2026-10-20: an earlier draft of this session wrongly listed `--ring`
  among the differing tokens).

### Session 2026-10-20 (final, #1039 drops its own text softening)

- Q: #1039's own text softening (`--foreground`/`--chat-foreground` retuned in Default Dark and
  Cyber Amber) went through three same-day corrections (surfaces-only pure-neutral, then
  text-pure-neutral-too, ...) -- is any of it kept? -> A: No. Stuart decided text softening
  belongs to a NEW, separate, app-wide issue instead (white at opacity 0.9 for headers/UI, 0.78
  for body/chat, 0.6 for muted, in every built-in preset except Dark (high contrast)) -- out of
  this spec's scope. `--foreground`, `--chat-foreground` and `--muted-foreground` in both
  Default Dark and Cyber Amber revert to `origin/main`'s own current values (`oklch(0.985 0 0)`/
  `oklch(0.90 0 0)`/`oklch(0.708 0 0)`), untouched by #1039. #1039's final, settled shape:
  Cyber Amber equals Default Dark (surfaces AND text) plus the orange accent and Send; `--ring`
  stays achromatic and byte-identical to Default Dark's own (gate round 1 correction), and a
  warning hue moved to 88.

### Session 2026-10-20 (post-draft-PR self-review on PR #1094)

- Q: A self-review against the issue body's own grill decisions, after draft PR #1094 opened,
  found Cyber Amber still diverging from Default Dark in several places the earlier sessions
  above missed -- Mermaid's own palette, `--input`,
  `--scrollbar-thumb`/`--scrollbar-thumb-hover`, `--composer-focus`, and `--ring` (wrongly
  documented as part of the accent family). Does Cyber Amber's "equals Default Dark" rule
  extend to these? -> A: Yes. Mermaid's `MERMAID_THEME_VARIABLES['cyber-amber']` now reuses
  `DARK_FAMILY` directly (`src/shared/mermaidThemeData.ts`); `--input`/`--scrollbar-thumb`/
  `--scrollbar-thumb-hover`/`--composer-focus`/`--ring`/`--sidebar-ring` are now byte-identical
  literals to Default Dark's own (not independent values, not aliases that happened to render
  the same). The status palette (severity/state/PR-state tokens) stays Cyber Amber's own,
  except that `--accent-text`'s new real hue (55.9) also closed the gap to `--severity-error`
  (hue 12): the two swatches now measure only 1.23:1 apart, under the 1.5:1 distinctness floor
  #551's own gate established. A grid search (L 0.655-0.675, chroma 0.15-0.24, hue 5-25) found
  no point clearing both that floor and the error-text-everywhere floor (>=4.5:1) at once; the
  search was widened (kept redder, hue 22, the family every other theme's own `--severity-
  error` already uses; the winning chroma, 0.12, sits outside the original 0.15-0.24 band) --
  `oklch(0.665 0.12 22)` clears every text floor (binding case 4.50:1 on the composited hover
  fill) while measuring the best
  accent-vs-error ratio achievable (1.42:1); the 1.5:1 distinctness floor is NOT met, an
  accepted departure recorded in `docs/design/accessibility.md` "Accepted departures".
  `--destructive`/`--state-stopped` alias `--severity-error` already; `--pr-closed` (a literal
  copy in every theme, #568/#529 decision 5) is updated to the same value too.

### Session 2026-10-20 (#1074, grilled 2026-10-20, none deferred)

- Q: Pure-white UI text (`--foreground`, `--chat-foreground`, `--muted-foreground`) reads too
  harsh/clinical across every built-in preset. Should it soften via alpha so each theme's own
  background tints it, replacing #1039's own abandoned text-softening attempt (that issue's
  grill item 3, superseded)? -> A: Yes. `--foreground` (headers/UI text) moves to `oklch(1 0 0
  / 90%)`, `--chat-foreground` (body/chat prose) to `oklch(1 0 0 / 78%)`, `--muted-foreground`
  (low emphasis) to `oklch(1 0 0 / 60%)`, in `dark`, `obsidian`, `nordic-frost` and
  `cyber-amber`. `dark-high-contrast` is untouched, keeping its existing solid 7:1 text (#552).
  The aliasing tokens that already resolve to `var(--foreground)` (`card-foreground`,
  `popover-foreground`, `secondary-foreground`, `accent-foreground`, `sidebar-foreground`,
  `sidebar-accent-foreground`) pick up the alpha automatically; `.theme-dark`'s own literal
  duplicates of those six tokens are switched to `var(--foreground)` so they do too. Every
  foreground that sits on a coloured fill instead of a neutral/background-toned one --
  `primary-foreground`, `send-foreground`, `destructive-foreground`,
  `sidebar-primary-foreground`, the three `state-*-foreground` tokens and the four
  `pr-*-foreground` tokens -- stays a solid, opaque literal, unaffected. Measured (gamma-
  composited, `scripts/contrast-math.mjs`): all 12 affected background/card/popover pairs
  across the four non-HC presets clear 4.5:1, worst case Obsidian's `--muted-foreground` on
  `--popover` at 6.26:1.
- Q: `src/shared/themes.ts`'s `titleBarOverlay.symbolColor` is a literal hex Electron's
  `BrowserWindow.setTitleBarOverlay` API takes with no alpha channel -- can it take the new
  alpha token directly? -> A: No. Each preset's `symbolColor` is hand-recomputed to the real
  composited colour (`--foreground` alpha-blended over that theme's own `--background`, the
  same gamma-space compositing `scripts/contrast-math.mjs` already performs for every other
  check), not a `var()` reference and not the raw pre-alpha `--foreground` value.
  `scripts/check-theme-contrast.mjs`'s metadata drift check gains a `symbolColor` comparison
  (alongside its existing `swatch`/`swatchPrimary`/`titleBarOverlay.color` checks) so a future
  edit to either side cannot drift silently.

### Session 2026-10-20 (#1074, gate round 3, Main's follow-up -- none deferred)

- Q: `src/shared/mermaidThemeData.ts`'s per-theme `primaryTextColor` comments cite a measured
  ratio against each theme's own `--card` literal -- is that the real backdrop Mermaid paints a
  node's label against? -> A: No. Mermaid's bundled `'dark'` base theme
  (`node_modules/mermaid`'s own `theme-dark.js`) hardcodes its real node fill
  (`mainBkg`/`nodeBkg`) to a literal `#1f2020`, entirely independent of our own `primaryColor`
  override -- confirmed by reading that source directly, not inferred. Every affected comment
  (`DARK_FAMILY`, Obsidian, Nordic Frost) is corrected to cite the real `#1f2020` backdrop and
  its real ratio (13.33:1/13.43:1/13.32:1 respectively); the existing literal hex values
  themselves needed no change, since all three already clear 4.5:1 against the real backdrop too.
- Q: Is Gantt/Journey task-text token coverage (`taskTextColor`, `sectionBkgColor`-family,
  `critBkgColor`) ever confirmed against a real rendered diagram, the way flowchart nodes are?
  -> A: Initially no (issue #1108, filed this round); corrected the same round -- EXTENDING an
  existing tape is allowed (the precedent #1039 set with `997-notice-severity.jsonl`'s own
  mermaid fence), so a small Journey fence is added to that same fixture and #1108 is amended
  to its narrower remaining scope (Gantt specifically; Journey is now covered).
- Q: Mermaid's own `textColor` (this file's softened #1074 value) colours Journey/Timeline task
  and section labels, sitting on the coloured `fillType0-7` task/section fills -- a genuine
  coloured-fill case FR-023 already exempts elsewhere -- measured as low as 4.06:1. Fix? -> A:
  Yes, a CODE fix, not only a fixture question: `getMermaidThemeCSS` (`mermaidTheme.ts`) gains a
  journey-scoped `color: <taskTextColor> !important` override (same solid token Gantt's own
  task bars already use for the identical role), confirmed via `node_modules/mermaid`'s own
  source that the label renders as a foreignObject HTML `div.label` sibling of the coloured
  rect, so a CSS sibling selector reliably targets it.
- Q: Mermaid's `titleColor` (flowchart cluster/subgraph titles) was never set by this file at
  all -- it fell through to Mermaid's own hardcoded solid `#F9FFFE` in every preset. Fix? -> A:
  Yes. Set explicitly per softened theme at FR-023's 0.9 tier over `--card` (byte-identical to
  `primaryTextColor`'s own value, same formula); `dark-high-contrast` keeps its own solid value.
- Q: The "Focused" session badge (`ChatHeader.tsx`) uses plain `text-foreground` on
  `bg-active-indicator/20` -- a coloured, non-neutral fill. A re-verified ratio on the now-
  translucent `--foreground` isn't the FR-023-compliant fix -- what is? -> A: A new dedicated
  solid token, `--active-indicator-foreground` (plain white in every preset, added to FR-023's
  "stays solid" exception list), replacing `text-foreground` on that one badge.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Opens in a sensible default preset on first launch (Priority: P1)

A developer installs Refract and opens it for the first time without touching any settings. The
app starts in its default dark preset — one specific built-in theme, with no OS setting and no
other concept involved in choosing it.

**Why this priority**: This is the behaviour every developer gets without taking any action, and
it is the baseline every other story in this spec is a deliberate departure from; nothing else in
this spec is testable without it.

**Independent Test**: Install Refract fresh and confirm it opens in its default dark preset. Open
Settings and confirm the theme picker marks that preset as the currently selected entry.

**Acceptance Scenarios**:

1. **Given** a fresh install with no theme ever chosen, **When** the developer opens Refract,
   **Then** Refract opens using its default dark preset.
2. **Given** no theme has been chosen, **When** the developer opens the Settings screen's
   Appearance section, **Then** the theme picker marks the default preset as the currently
   selected entry.

---

### User Story 2 - Pick a theme in Settings with a live preview (Priority: P1)

A developer opens the Settings screen (spec 004) and finds an Appearance section with a theme
picker: every built-in theme, each shown by name with a small colour swatch, and the currently
active one marked in text as well as by colour. Choosing a different entry repaints the whole app
immediately, so the developer can see it against their own chat, code, and session list before
committing to it. Save keeps the choice; Cancel, Esc, or leaving Settings without saving puts the
previous theme back.

**Why this priority**: This is the entire feature Stuart asked for: without a picker there is
nothing to choose, and without a live, whole-app preview the picker is no better than reading a
name off a list.

**Independent Test**: Open Settings, choose a theme other than the current one, confirm the whole
app repaints immediately (not a sample swatch), press Cancel, and confirm the app reverts to the
previous theme. Repeat, this time pressing Save, reopen Settings, and confirm the chosen theme is
still the one marked current.

**Acceptance Scenarios**:

1. **Given** the Settings screen, **When** the developer looks at the Appearance section,
   **Then** it shows a theme picker listing every built-in theme, each with its name and a small
   colour swatch, and the currently active entry marked both in text and by colour.
2. **Given** the theme picker, **When** the developer chooses a different entry, **Then** the
   whole app — not only a sample area inside Settings — repaints immediately to that theme's
   colours.
3. **Given** a theme has been chosen but not saved, **When** the developer activates Save,
   **Then** that theme becomes the app's persisted choice.
4. **Given** a theme has been chosen but not saved, **When** the developer activates Cancel,
   presses Esc, or navigates away from Settings to another screen, **Then** the app reverts to
   whichever theme was active before the picker was opened.
5. **Given** the theme picker, **When** the developer operates it using only the keyboard,
   **Then** arrow keys move between entries, the focused entry shows a visible focus indicator,
   and Enter or Save commits the focused entry the same way a pointer choice would.

---

### User Story 3 - Everything follows the theme (Priority: P2)

Whatever theme is active, every part of the app reflects it: the chat transcript and its tool
rows, code blocks and their syntax colours, diffs, the session list and its state colours,
dialogs and menus, toasts, tooltips and hover cards, the chip row, scrollbars, selection and focus
rings, and the Settings screen itself. No part of the app keeps a colour fixed regardless of which
preset is active, and every built-in theme stays readable and keeps the four Session states
tellable apart.

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
   is shown, **Then** it uses that theme's colours rather than a fixed appearance.
4. **Given** any built-in theme is active, **When** the developer looks at the chip row,
   scrollbars, or any selection or focus ring, **Then** they use that theme's colours.
5. **Given** any built-in theme is active, **When** the developer opens the Settings screen,
   **Then** Settings itself uses that theme's colours rather than a fixed appearance.
6. **Given** any built-in theme, **When** its text and non-text parts are measured, **Then** body
   text meets at least 4.5:1 contrast and large text and non-text parts (such as focus rings and
   scrollbar thumbs) meet at least 3:1, matching WCAG AA.

---

### User Story 4 - The theme survives and applies everywhere (Priority: P2)

Once the developer saves a theme, that choice survives closing and reopening Refract, and it
applies to every pane and panel at once: a split chat pane (spec 005), the side panel (spec 004),
and a window opened later, all starting in the right theme from their very first paint, with no
flash of the wrong appearance.

**Why this priority**: A theme choice that resets on restart, or that only some panes pick up,
undermines Stories 1 through 3; this is lower priority than choosing and applying a theme because
it is about durability rather than the core behaviour.

**Independent Test**: Save a non-default theme, restart Refract, and confirm it opens already in
that theme with no visible flash of another appearance. Open a split chat pane and the Settings
side panel and confirm both show the same theme.

**Acceptance Scenarios**:

1. **Given** a theme was saved, **When** Refract is closed and reopened, **Then** it opens in
   that same theme.
2. **Given** Refract is starting up, **When** its window first paints, **Then** it already shows
   the saved theme; it never shows an unthemed or wrongly themed frame first.
3. **Given** a saved theme, **When** the developer opens a second pane in a split chat (spec 005)
   or the Settings side panel (spec 004), **Then** both show the same active theme as the rest of
   the app.

---

### Edge Cases

- The developer closes Refract while previewing an unsaved theme: nothing is persisted; the next
  launch shows whatever was last saved (the saved preset).
- A saved theme no longer exists among the built-in themes (for example, after an app update
  removes it): Refract falls back to the default preset rather than failing to
  render or showing stale colours.
- The developer has the OS reduced-motion setting on: switching themes shows no animated
  transition between the old and new colours.
- A developer who needs higher contrast than the default dark preset provides: at least one built-
  in preset is a dedicated high-contrast dark variant.
- A screenshot or a screen reader user: the live repaint itself is not announced to assistive
  technology; only the picker's own selection-state text changes are.
- A code block whose language has no syntax-colour entry in the active theme: it still renders
  using the theme's base text and background colours, without an error.
- A diagram (Mermaid, spec 001 FR-043) uses colours baked into the diagram itself: it either
  follows the active theme or uses a fixed palette that stays readable against every built-in
  theme's background.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The Settings screen (spec 004) MUST include an Appearance section containing a
  theme picker listing every built-in theme, each shown by its name and a small colour swatch.
- **FR-002**: The theme picker MUST mark the entry matching the currently active theme both in
  its text and by colour.
- **FR-003**: Choosing a different entry in the theme picker MUST repaint the whole app
  immediately to that entry's colours, covering every pane and panel visible at that moment, not
  only a sample area inside Settings.
- **FR-004**: A theme chosen in the picker MUST NOT become the app's lasting choice until the
  developer activates Save; activating Save MUST persist that choice as the one Refract starts
  in and follows afterwards.
- **FR-005**: Activating Cancel, pressing Esc, or navigating away from Settings without saving
  MUST revert the app to whichever theme was active before the picker was opened.
- **FR-006**: The theme picker MUST be fully keyboard operable: arrow keys MUST move the focus
  between entries, the focused entry MUST show a visible focus indicator, and confirming the
  focused entry MUST have the same effect as choosing it with the pointer.
- **FR-007**: Every themed surface — the chat transcript and its tool rows, code blocks and their
  syntax colours, diffs, the session list and its state colours, dialogs and menus, toasts,
  tooltips and hover cards, the chip row, scrollbars, selection and focus rings, and the Settings
  screen itself — MUST take its colours from the active theme; none of them MUST keep a
  hard-coded colour regardless of which theme is active.
- **FR-008**: Each built-in theme MUST meet WCAG AA contrast: at least 4.5:1 for body text and at
  least 3:1 for large text and non-text UI parts, including focus rings and scrollbar thumbs.
- **FR-009**: In every built-in theme, the four Session states (working, idle, needs you, stopped)
  MUST stay distinguishable from one another by icon and text, not only by colour.
- **FR-010**: The built-in theme list MUST include at least one dedicated high-contrast variant,
  in addition to the default dark preset.
- **FR-011**: The saved theme choice MUST persist across Refract restarts and MUST apply to every
  pane and panel, including a split chat pane (spec 005) and the Settings side panel (spec 004),
  and to a window opened after the choice was made.
- **FR-012**: A Refract window MUST show the correct theme — the saved theme — from its first
  paint; it MUST NOT show an unthemed or wrongly themed frame first.
- **FR-013**: When the saved theme no longer exists among the built-in themes, Refract MUST fall
  back to the default preset rather than failing to render or keeping stale colours.
- **FR-014**: Switching the active theme MUST NOT play an animated transition between the old and
  new colours while the developer's OS reduced-motion setting is on.
- **FR-015**: A fenced code block (spec 001 FR-050) whose language has no syntax-colour entry in
  the active theme MUST still render using that theme's base text and background colours, without
  an error.
- **FR-016**: A Mermaid diagram (spec 001 FR-043) MUST either follow the active theme's colours or
  use a fixed palette that stays readable against the background of every built-in theme.
- **FR-017**: The live repaint triggered by choosing an entry in the theme picker MUST NOT be
  announced to assistive technology beyond the picker's own selection-state text changing.
- **FR-018**: On first launch, before the developer has ever chosen a theme, Refract MUST start
  in the default dark preset (the existing dark theme).
- **FR-019**: Closing Refract while an unsaved theme is being previewed MUST NOT persist that
  preview; the next launch MUST show whatever was last saved.
- **FR-020** (#1039): Within any single built-in theme, the active accent colour (`--accent-text`,
  `--primary`, `--send`) MUST stay visually distinct in hue from that theme's own warning colour
  (`--severity-warning`), so a warning never reads as an accent.
- **FR-022** (#1039, amended 2026-10-20 five times): Cyber Amber's surface and text tokens,
  plus `--input`, `--scrollbar-thumb`/`--scrollbar-thumb-hover` and `--composer-focus`, MUST
  equal Default Dark's own tokens exactly (byte-identical, OKLCH chroma ≤ 0.002 where that
  applies) -- `--ring`/`--sidebar-ring` too, achromatic per the 2026-10-09 decision and never
  part of the accent family. The status palette (`--severity-success`/`--severity-warning`/
  `--severity-error`/`--severity-info` and the state/PR-state tokens built from them) keeps
  Cyber Amber's own preset values, EXCEPT where retuning the accent moved a distinctness floor
  out of reach -- FR-020 covers the accent-vs-warning case; the accent-vs-error case has no
  single value clearing both its own distinctness floor and the error-text floor at once, so
  it is a named accepted departure instead (`docs/design/accessibility.md` "Accepted
  departures"), not a functional requirement. Only the accent family (`--accent-text`,
  `--primary`/`--send`, markdown links), the warning hue, the error family (`--severity-error`/
  `--destructive`/`--state-stopped`/`--pr-closed`), and `themes.ts`'s own `swatchPrimary` may
  differ from Default Dark.
- **FR-023** (#1074): In every built-in theme except the dedicated high-contrast one (FR-010),
  `--foreground`, `--chat-foreground` and `--muted-foreground` MUST be a translucent white
  (`oklch(1 0 0 / 90%)`, `78%` and `60%` respectively) composited over that theme's own
  background, rather than a solid colour; every other token that aliases `--foreground` for a
  neutral/background-toned fill (`card-foreground`, `popover-foreground`,
  `secondary-foreground`, `accent-foreground`, `sidebar-foreground`,
  `sidebar-accent-foreground`) MUST resolve to it via `var()` so it inherits the same alpha. A
  foreground token that sits on a coloured, non-neutral fill (`primary-foreground`,
  `send-foreground`, `destructive-foreground`, `sidebar-primary-foreground`,
  `active-indicator-foreground` (gate round 3, the "Focused" session badge), the
  `state-*-foreground` and `pr-*-foreground` tokens) MUST stay a fully opaque literal. The
  dedicated high-contrast theme (FR-010) MUST keep every one of these tokens solid, per its
  existing 7:1 text target (FR-008, #552).

### Key Entities

- **Theme**: one complete, named set of colours covering every themed surface in FR-007; built in
  to Refract, never edited, imported, or exported by the developer.
- **Theme setting**: the app-wide, persisted record of the active Theme, defaulting to a named
  default preset on first launch, read at startup and by every pane, panel, and window.
- **Theme picker**: the Appearance section control listing every Theme (preset) by name and
  swatch, marking the currently active one, and driving the live, whole-app repaint described in
  User Story 2.
- **Preview**: the app's momentarily active theme while a choice in the picker has been made but
  not yet saved; discarded on Cancel, Esc, leaving Settings, or closing Refract, without changing
  the persisted Theme setting.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Choosing an entry in the theme picker repaints every visible pane and panel within 1
  second, not only a sample area inside Settings.
- **SC-002**: Leaving the theme picker without saving — by Cancel, Esc, or navigating away —
  reverts to the theme that was active before the picker opened, 100% of the time.
- **SC-003**: After a full app restart, Refract shows the saved theme from the window's first
  paint, with no observable flash of another appearance, 100% of the time.
- **SC-004**: Every built-in theme meets WCAG AA contrast (at least 4.5:1 for body text, at least
  3:1 for large text and non-text parts) across every surface listed in FR-007.
- **SC-005**: In every built-in theme, including the high-contrast one, the four Session states
  remain distinguishable from one another by icon and text alone, with colour removed.
- **SC-006**: A developer using only the keyboard can select any entry in the theme picker, see it
  previewed live, and commit it with Save or discard it with Cancel, with a visible focus
  indicator throughout.

## Assumptions

- The built-in theme list is all-dark presets. **Decided (additive, per issue #458's "a further
  dark preset adds a key, never removes" rule):** `dark` (default), `dark-high-contrast`,
  `obsidian` (#550), `nordic-frost` and `cyber-amber` (#551) -- five built-in presets as of
  #551, no further preset count or name left open for this spec.
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
  must cover. Scrollbar styling is specified in spec 001 FR-053 (thin, dark on dark, from theme
  colours); this spec makes those colours vary per theme.
- Windows 11 is the only supported platform, consistent with the constitution; "OS reduced-motion
  setting" means the corresponding Windows 11 setting.
- No remote content or downloaded themes: every built-in theme ships with the app.
- The profile menu (spec 008) has a Theme submenu (every preset, and an "Appearance settings"
  entry that opens the Appearance section); choosing from it follows the same keep-the-choice
  rules as the Appearance picker. (Reworded from "More themes": once the submenu already lists
  every preset, a "More themes" label promises choices that aren't there.)
