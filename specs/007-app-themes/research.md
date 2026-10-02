# Research: App themes

Decisions follow the format: Decision / Rationale / Alternatives considered. Items marked
**UNVERIFIED** get a probe task that runs first in [tasks.md](tasks.md), with the result recorded
in `docs/spike/FINDINGS.md` (constitution IV).

## 1. Built-in theme list for this spec

**Decision**: Ship exactly three built-in themes for v1 — Light, Dark, and High contrast — plus
System mode (which only ever picks between Light and Dark). This is the FR-013 minimum ("at
least one dedicated high-contrast theme in addition to Light and Dark") and nothing more.

**Rationale**: The spec's Assumptions section flags a broader reading ("at least one further dark
and one further light variant... the exact list and names are decided in planning and should be
confirmed with Stuart") as explicitly unresolved and not asserted by any FR. No functional
requirement or acceptance scenario asks for more than three built-in themes. Stuart's own
"Presets only" clarification bounds this spec to a fixed list, not an open-ended one, so the
conservative choice is the smallest list that satisfies every FR, leaving room to add variants
later. `ThemeId` is an open string-literal union (`'light' | 'dark' | 'high-contrast'`), so adding
a fourth or fifth built-in theme later is additive, not a breaking change to any contract here.

**Alternatives considered**: Shipping 5 themes (Light, Dark, a second light variant, a second
dark variant, High contrast) now, matching the Assumption's broader reading — rejected because it
roughly doubles the per-theme contrast-audit (T019), swatch, and syntax-theme work for a count no
FR requires, and Stuart has not actually picked names for a second light/dark variant; shipping
that speculative work risks building themes he would rather name or tune himself. This decision
was made without asking Stuart, per the planning brief; flagged in the handback report.

## 2. Theme tokens live in CSS; metadata lives in `src/shared/themes.ts`

**Decision**: A new `src/shared/themes.ts` exports `THEMES: Record<ThemeId, ThemeDefinition>`
(`name`, `swatch`, `mode: 'light' | 'dark'`, `syntaxTheme`, `titleBarOverlay`) — small, reasoned
metadata imported directly by main, preload, and renderer (the existing shared-module pattern,
plan.md "Source code"). The actual colour values stay as CSS custom properties in
`src/renderer/styles/globals.css`, one class per theme (`.theme-light`, `.theme-dark`,
`.theme-high-contrast`), replacing today's single hardcoded `.dark` block.

**Rationale**: Tailwind v4's `@theme inline` indirection in `globals.css` only resolves real CSS
custom properties, not JS-injected styles, so bulk colour values have to stay in CSS regardless.
Keeping them next to spec 001's existing light/dark blocks (rather than moving everything into a
JS object main/renderer would have to serialize) keeps the diff small and the per-theme token
groups (base, state colours, diff, scrollbar) easy to compare side by side, exactly as spec 001's
own two blocks already are.

**Alternatives considered**: Generating CSS from the JS `ThemeDefinition` table at build time —
rejected as unnecessary indirection for three themes; a human reads and edits CSS custom
properties directly today and should keep doing so.

## 3. No `theme.list()` / `theme.getOsPreference()` IPC requests

**Decision**: The renderer imports `THEMES` from `src/shared/themes.ts` directly for the picker,
Shiki theme selection, and Sonner's forced mode — no round trip needed, since shared modules are
already imported by all three processes (plan.md "Source code"). The OS preference is known from
the one-time synchronous bootstrap read (Decision 4) and kept live afterwards by the
`theme:os-changed` event (Decision 5); no polling request is needed.

**Rationale**: Minimizes the IPC surface to exactly the two effects only main can perform
(persisting `settings.json`, and moving the native title-bar overlay colour), consistent with
constitution V ("only the main process ... touches ... the file system"; window chrome is
main-only for the same reason OMP processes are).

**Alternatives considered**: An async `theme.list()` request mirroring `repositories.branches` —
rejected: it would just re-serialize data the renderer already has from its own shared-module
import, adding a request/response cycle with no new information.

## 4. Pre-paint bootstrap: synchronous `theme:bootstrap`

**Decision**: Preload exposes a synchronous `window.refract.themeBootstrap()` wrapping
`ipcRenderer.sendSync('theme:bootstrap')`, answered by a synchronous `ipcMain.on` handler in
`src/main/ipc/theme.ts` that reads the already-loaded `SettingsStore` and
`nativeTheme.shouldUseDarkColors` (both synchronous in main) and returns
`{ settingsTheme: ThemeSetting; osDark: boolean }`. `main.tsx`'s very first lines call it and set
the resolved class on `<html>` before `createRoot().render()`, replacing today's hardcoded
`document.documentElement.classList.add('dark')`.

**Rationale**: FR-015/SC-005 require no flash of the wrong theme on a window's first paint.
Blocking the renderer's single JS thread for one cheap, one-time call means nothing can paint
(there is no DOM content yet, since this runs before React mounts) until the right class is
already set — stronger than an async `await` before mounting, which would leave a window open to
painting an unstyled or default-classed frame during the wait. `createWindow()` already holds the
window hidden (`show: false`) until `ready-to-show`, which remains the backstop; this decision
removes the only other way a flash could occur (a theme-less first frame from the renderer's own
process).

**Alternatives considered**: An async `settings.get()` + a new async OS-preference request awaited
before `createRoot().render()` — rejected per the flash risk above. Passing the initial theme via
`webPreferences.additionalArguments` (read with `process.argv` in a preload script) — rejected:
`sendSync` is the simpler, already-idiomatic Electron pattern for exactly this "read one
main-process fact before the renderer paints" case, and it is one call, not a standing channel.

**UNVERIFIED**: that a synchronous `ipcRenderer.sendSync` call still works end to end under this
app's `sandbox: true` + `contextIsolation: true` preload build (electron-vite's isolated preload
mode, chosen in spec 001 T003) with no flash observed in practice. Probed in tasks.md's first
task; recorded in `docs/spike/FINDINGS.md`.

## 5. System-mode live follow: `nativeTheme` in main, pushed as an event

**Decision**: Main registers one `nativeTheme.on('updated', ...)` listener at app start (beside
the existing `joinKillOnCloseJob()` / `reapStale()` startup sequence in `src/main/index.ts`) and
forwards `{ dark: nativeTheme.shouldUseDarkColors }` as `theme:os-changed` to every window. The
renderer's `theme-store.ts` applies it only while `settingsTheme === 'system'` and no preview is
active (FR-002, FR-021); it still records `osDark` so System mode resolves instantly the moment a
preview ends or Cancel/Esc reverts to System.

**Rationale**: `nativeTheme` is Electron's own cross-platform hook for exactly this OS signal, and
main already needs `nativeTheme.shouldUseDarkColors` once for the synchronous bootstrap read
(Decision 4), so reusing the same source for live updates avoids a second code path that could
disagree with the first (for example, a renderer-side `prefers-color-scheme` media-query listener
reading Chromium's own notion of the setting, which may update on a different cadence than
Electron's native hook that also drives the main-only title-bar overlay colour).

**Alternatives considered**: `window.matchMedia('(prefers-color-scheme: dark)')` in the renderer —
rejected: it cannot also drive the title-bar overlay colour (main-only, constitution V), so using
it would still require a separate main-side `nativeTheme` listener for that surface, meaning two
sources of the same fact instead of one.

**UNVERIFIED**: whether Electron 44.5.1's `nativeTheme.updated` event reliably fires when Windows
11's Settings > Personalization > Colors > "Choose your mode" is changed while Refract is running,
without requiring a restart or window focus change. Probed in tasks.md's first task (a human
toggles the real OS setting while a probe script listens and logs the event with a timestamp);
recorded in `docs/spike/FINDINGS.md`.

## 6. High-contrast theme is never part of System mode

**Decision**: System mode (FR-002) only ever resolves to Light or Dark, driven solely by
`nativeTheme.shouldUseDarkColors`. Choosing "High contrast" is only ever an explicit pick in the
picker or profile submenu; there is no automatic detection of a Windows high-contrast mode.

**Rationale**: FR-001 and FR-002 both say "Light or Dark"; no FR asks Refract to detect or react
to a Windows contrast-mode toggle. Scoping System mode narrowly avoids an undocumented behaviour
(switching the user into Refract's High contrast theme because Windows' own accessibility setting
changed) that nothing in the spec requests and that could surprise a developer who turned on
Windows high contrast for a different app.

**Alternatives considered**: Also following a Windows high-contrast toggle into Refract's High
contrast theme — rejected as unrequested scope; can be proposed as a future FR if Stuart asks.

## 7. Live preview: one derived store, not an imperative revert

**Decision**: `theme-store.ts` holds `{ settingsTheme, osDark, previewing: ThemeId | null }` and
always derives the displayed class as
`previewing ?? (settingsTheme === 'system' ? (osDark ? 'dark' : 'light') : settingsTheme)`.
The Appearance picker and the profile Theme submenu (spec 008) both call `preview(id | null)`
while open (also invoking `theme.preview(id | null)` over IPC, for the title-bar overlay only —
every other surface repaints from the derived class, no round trip). `save(id)` calls
`theme.set(id)`, which both persists and updates `settingsTheme`; Cancel, Esc, and navigating
away all simply call `preview(null)`, which needs no separate "what was it before" bookkeeping
because the derived class already falls back to the untouched `settingsTheme`/`osDark` pair the
moment `previewing` clears.

**Rationale**: FR-007 requires reverting to "whichever theme ... was active before the picker was
opened" on three different exit paths (Cancel, Esc, navigate away) that the Assumptions section
already declares equivalent; a derived-state store makes all three the same one-line action
instead of three call sites each needing to remember and restore a prior value.

**Alternatives considered**: Saving a snapshot of the pre-preview theme and restoring it
explicitly on each exit path — rejected as the same outcome with three codepaths to keep in sync
instead of one.

## 8. No CSS transition on a theme switch

**Decision**: The class swap that repaints the app carries no transition; FR-017 is satisfied
unconditionally, not gated behind a `prefers-reduced-motion` check.

**Rationale**: FR-017 requires no animated transition, and there is no requirement for one when
reduced motion is off either; an unconditional rule is simpler than a conditional one and the
existing `prefers-reduced-motion` block in `globals.css` already exists for a different purpose
(collapsing ambient animation/transition durations generally), not for this deliberate, instant
repaint.

**Alternatives considered**: A brief cross-fade when reduced motion is off — rejected: no FR or
acceptance scenario asks for one, and adding it would need its own reduced-motion gate FR-017
does not request.

## 9. Syntax highlighting follows the active theme's `syntaxTheme`

**Decision**: Each `ThemeDefinition.syntaxTheme` names a Shiki bundled theme
(`light` → `github-light`, `dark` → `github-dark`, `high-contrast` → `github-dark-high-contrast`).
`Markdown.tsx`'s `getHighlighter()` loads all three up front (replacing today's two), and
`CodeBlock` picks by the active theme id instead of today's binary `isDark` check.

**Rationale**: FR-018 requires every built-in theme to render code blocks in its own colours,
including a language Shiki has no grammar for (falls back to the theme's base text/background
colours, which Shiki already does for an unrecognised language — this path is unchanged, only the
theme selection is). A dedicated high-contrast Shiki theme keeps code blocks at the same contrast
bar as the rest of that theme (FR-011) instead of reusing `github-dark`'s ordinary contrast ratio.

**UNVERIFIED**: that `github-dark-high-contrast` is a real theme name bundled in the pinned
`shiki@4.4.3`, and that `createHighlighter({ themes: [...] })` resolves it without error. Probed
in tasks.md's first task; recorded in `docs/spike/FINDINGS.md`.

## 10. Mermaid theming depends on spec 001 T066 landing first

**Decision**: Build the colour-mapping table (active `ThemeDefinition` → Mermaid `themeVariables`)
in this spec, but the call into `mermaid.initialize` happens only once spec 001 T066 (Mermaid
rendering itself, not yet built — its own task checkbox is unchecked) lands; until then this
spec's Mermaid task only adds the mapping, not a call into a renderer that does not exist yet.

**Rationale**: Cross-spec work is a dependency note, never a task that edits another spec's files
(planning brief). T066 is still pending in spec 001's own convergence tasks, so there is nothing
to wire the mapping into yet; recording the mapping now means the eventual T066 implementation (or
this spec's own follow-up once T066 ships) has the colours ready rather than inventing them later.

**Alternatives considered**: Using one of Mermaid's own named themes (`dark`, `default`,
`forest`, ...) picked per Refract theme — rejected: a built-in Mermaid theme is a close but
different palette than Refract's own tokens, which would read as "almost matching" rather than
following the theme (FR-019 says follow the active theme's colours, not merely stay readable with
an unrelated palette).

## 11. `next-themes` kept, narrowly, only for Sonner compatibility

**Decision**: Wrap `<App />` in `next-themes`'s `ThemeProvider` in `main.tsx`, with
`forcedTheme` bound to the active `ThemeDefinition.mode` (`'light' | 'dark'`) from
`theme-store.ts` — not to the browser/OS. This exists solely so `src/renderer/components/ui/
sonner.tsx`'s existing `useTheme()` call keeps compiling and theming toasts correctly without a
rewrite; `next-themes` is not consulted anywhere else and its own system-detection is unused
(System mode already has its own path, Decision 5).

**Rationale**: `next-themes` is already a pinned dependency used only by the copied shadcn
`sonner.tsx` component; replacing that one call site would mean diverging from the shadcn-copied
file for no functional gain, whereas `forcedTheme` is next-themes' documented escape hatch for
"theme is controlled by something else" — exactly this case, since High contrast has no next-themes
equivalent and must still pick one of Sonner's two toast variants via its `mode` field.

**Alternatives considered**: Rewriting `sonner.tsx` to read `theme-store.ts` directly and drop
`next-themes` entirely — rejected as a larger, unrequested change to a shadcn-owned file for a
one-line behavioural difference (`forcedTheme` achieves the same result without touching it).

## 12. Contrast verified by a one-off script, not CI

**Decision**: `scripts/check-theme-contrast.mjs` parses each theme's OKLCH token pairs straight
out of `globals.css`, converts to sRGB and relative luminance, and checks the FR-011 ratios
(4.5:1 body text / state-colour pairs, 3:1 large text and non-text parts) for every built-in
theme and every FR-010 surface's token pair. It is run by hand during the Polish task, exactly as
spec 001 T089 verified scrollbar contrast "from the computed colours" — no CI wiring is requested
by this spec.

**Rationale**: Matches the constitution's prototype stance (no automated test suite requirement)
while still giving a repeatable, objective pass/fail per pair instead of eyeballing swatches.

**Alternatives considered**: A browser-based contrast checker extension used manually with no
script — rejected: a script is reusable the next time a token changes, and its numbers go
straight into the handback report instead of a screenshot.
