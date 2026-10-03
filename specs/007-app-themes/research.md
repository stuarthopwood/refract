# Research: App themes

Decisions follow the format: Decision / Rationale / Alternatives considered. Items marked
**UNVERIFIED** get a probe task that runs first in [tasks.md](tasks.md), with the result recorded
in `docs/spike/FINDINGS.md` (constitution IV).

## 1. Built-in theme list for this spec

**Decision**: Dark only, presets only. Stuart's explicit 2026-10-02 instruction overrides this
spec's original Light/Dark/High-contrast/System design: "I don't think I want a light mode, the
icon doesn't look right with it. Dark only, dark theme presets only." Every built-in theme is a
dark-toned preset; there is no light theme and no OS-follow/System mode. Ship the existing single
dark theme as one named preset, plus at least one more dark preset, reasonably including a
dedicated high-contrast dark variant to preserve the accessibility intent of the old FR-013. This
is a direct instruction, not a planning inference — unlike the exact count and names of presets
beyond those two, which remains a flagged, unresolved assumption (spec.md Assumptions) to confirm
with Stuart later, the same way the original "Presets only" decision was flagged. `ThemeId` is a
closed string-literal union today with no `'light'` member; adding a further built-in preset later
is additive (a new union member), not a breaking change to any contract here.

**Rationale**: Stuart's instruction is unambiguous and direct: no light mode, dark presets only.
Preserving the old FR-013 high-contrast-variant intent (rather than dropping it) keeps the
accessibility guarantee the original spec made, now scoped to the all-dark preset list instead of
"in addition to Light and Dark."

**Alternatives considered**: Keeping a light theme as an optional, unlisted preset for a future
spec to surface — rejected: Stuart's instruction is "dark only," not "dark by default"; there is
nothing provisional about it. Picking exact names/count for the second-and-later dark presets now
— rejected as not Stuart's to delegate to this document; flagged as an open question instead, per
the planning brief.

## 2. Theme tokens live in CSS; metadata lives in `src/shared/themes.ts`

**Decision**: A new `src/shared/themes.ts` exports `THEMES: Record<ThemeId, ThemeDefinition>`
(`name`, `swatch`, `syntaxTheme`, `titleBarOverlay`) — small, reasoned metadata imported directly
by main, preload, and renderer (the existing shared-module pattern, plan.md "Source code"). The
actual colour values stay as CSS custom properties in `src/renderer/styles/globals.css`, one class
per theme (`.theme-dark`, `.theme-dark-high-contrast`, and so on for any further dark preset),
replacing today's single hardcoded `.dark` block.

**Rationale**: Tailwind v4's `@theme inline` indirection in `globals.css` only resolves real CSS
custom properties, not JS-injected styles, so bulk colour values have to stay in CSS regardless.
Keeping them next to spec 001's existing dark block (rather than moving everything into a JS
object main/renderer would have to serialize) keeps the diff small and the per-theme token groups
(base, state colours, diff, scrollbar) easy to compare side by side, exactly as spec 001's own
block already is.

**Alternatives considered**: Generating CSS from the JS `ThemeDefinition` table at build time —
rejected as unnecessary indirection for a short preset list; a human reads and edits CSS custom
properties directly today and should keep doing so.

## 3. No `theme.list()` IPC request

**Decision**: The renderer imports `THEMES` from `src/shared/themes.ts` directly for the picker
and Shiki theme selection — no round trip needed, since shared modules are already imported by all
three processes (plan.md "Source code"). Sonner's forced mode is not driven by `THEMES` at all;
see decision 11 for its hardcoded `'dark'` constant.

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
`src/main/ipc/theme.ts` that reads the already-loaded `SettingsStore` (synchronous in main) and
returns `{ theme: ThemeId }`. `main.tsx`'s very first lines call it and set the resolved class on
`<html>` before `createRoot().render()`, replacing today's hardcoded
`document.documentElement.classList.add('dark')`.

**Rationale**: FR-012/SC-003 require no flash of the wrong theme on a window's first paint.
Blocking the renderer's single JS thread for one cheap, one-time call means nothing can paint
(there is no DOM content yet, since this runs before React mounts) until the right class is
already set — stronger than an async `await` before mounting, which would leave a window open to
painting an unstyled or default-classed frame during the wait. `createWindow()` already holds the
window hidden (`show: false`) until `ready-to-show`, which remains the backstop; this decision
removes the only other way a flash could occur (a theme-less first frame from the renderer's own
process).

**Alternatives considered**: An async `settings.get()` awaited before `createRoot().render()` —
rejected per the flash risk above. Passing the initial theme via `webPreferences.additionalArguments`
(read with `process.argv` in a preload script) — rejected: `sendSync` is the simpler, already-
idiomatic Electron pattern for exactly this "read one main-process fact before the renderer
paints" case, and it is one call, not a standing channel.

**UNVERIFIED**: that a synchronous `ipcRenderer.sendSync` call still works end to end under this
app's `sandbox: true` + `contextIsolation: true` preload build (electron-vite's isolated preload
mode, chosen in spec 001 T003) with no flash observed in practice. Probed in tasks.md's first
task; recorded in `docs/spike/FINDINGS.md`.

## 5. Moot: no OS-follow live update needed

This decision was originally "System-mode live follow: `nativeTheme` in main, pushed as an
event" — a `nativeTheme.on('updated', ...)` listener forwarding Windows light/dark changes to
every window as a `theme:os-changed` event. It is moot given the dark-only decision (Decision 1):
there is no System mode and nothing to follow between, so no OS-change listener, no
`theme:os-changed` event, and no probe task for `nativeTheme.updated`'s reliability are needed.
This heading is kept, with decision numbers after it left stable, since later decisions and
tasks.md cross-reference it by number.

## 6. Moot: no System-mode/high-contrast interaction to scope

This decision was originally "High-contrast theme is never part of System mode" — scoping System
mode (old FR-002) to only ever resolve to Light or Dark, never auto-detecting Windows' own
high-contrast toggle. It is moot given the dark-only decision (Decision 1): there is no System
mode for the high-contrast preset to be excluded from. Refract still does not auto-detect a
Windows high-contrast toggle; that remains unrequested scope, now simply because no FR asks for
any OS-setting detection at all. This heading is kept, with decision numbers after it left
stable, for the same cross-reference reason as Decision 5.

## 7. Live preview: one derived store, not an imperative revert

**Decision**: `theme-store.ts` holds `{ theme: ThemeId, previewing: ThemeId | null }` and always
derives the displayed class as `previewing ?? theme`. The Appearance picker and the profile Theme
submenu (spec 008) both call `preview(id | null)` while open (also invoking `theme.preview(id |
null)` over IPC, for the title-bar overlay only — every other surface repaints from the derived
class, no round trip). `save(id)` calls `theme.set(id)`, which both persists and updates `theme`;
Cancel, Esc, and navigating away all simply call `preview(null)`, which needs no separate "what
was it before" bookkeeping because the derived class already falls back to the untouched `theme`
the moment `previewing` clears.

**Rationale**: FR-005 requires reverting to "whichever theme ... was active before the picker was
opened" on three different exit paths (Cancel, Esc, navigate away) that the Assumptions section
already declares equivalent; a derived-state store makes all three the same one-line action
instead of three call sites each needing to remember and restore a prior value.

**Alternatives considered**: Saving a snapshot of the pre-preview theme and restoring it
explicitly on each exit path — rejected as the same outcome with three codepaths to keep in sync
instead of one.

## 8. No CSS transition on a theme switch

**Decision**: The class swap that repaints the app carries no transition; FR-014 is satisfied
unconditionally, not gated behind a `prefers-reduced-motion` check.

**Rationale**: FR-014 requires no animated transition, and there is no requirement for one when
reduced motion is off either; an unconditional rule is simpler than a conditional one and the
existing `prefers-reduced-motion` block in `globals.css` already exists for a different purpose
(collapsing ambient animation/transition durations generally), not for this deliberate, instant
repaint.

**Alternatives considered**: A brief cross-fade when reduced motion is off — rejected: no FR or
acceptance scenario asks for one, and adding it would need its own reduced-motion gate FR-014
does not request.

## 9. Syntax highlighting follows the active theme's `syntaxTheme`

**Decision**: Each `ThemeDefinition.syntaxTheme` names a Shiki bundled theme (the existing dark
preset → `github-dark`, the high-contrast dark preset → `github-dark-high-contrast`, and any
further dark preset gets its own closest-matching Shiki theme). `Markdown.tsx`'s
`getHighlighter()` loads every built-in theme's Shiki theme up front, and `CodeBlock` picks by the
active theme id instead of today's binary `isDark` check.

**Rationale**: FR-015 requires every built-in theme to render code blocks in its own colours,
including a language Shiki has no grammar for (falls back to the theme's base text/background
colours, which Shiki already does for an unrecognised language — this path is unchanged, only the
theme selection is). A dedicated high-contrast Shiki theme keeps code blocks at the same contrast
bar as the rest of that theme (FR-008) instead of reusing `github-dark`'s ordinary contrast ratio.

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
following the theme (FR-016 says follow the active theme's colours, not merely stay readable with
an unrelated palette).

## 11. `next-themes` already removed; Sonner is pinned directly, nothing for this spec to do

**Decision**: Moot, overtaken by a fix landed ahead of this spec (`src/renderer/components/ui/
sonner.tsx`, 2026-10-03): `next-themes` was never actually wired to anything — `main.tsx` has no
`ThemeProvider`, so `sonner.tsx`'s old `useTheme()` call always silently fell back to its own
`"system"` default, meaning toasts followed the OS's light/dark setting independently of the
app's own (always-dark) appearance. That call, and the `next-themes` dependency itself, are gone;
`sonner.tsx` now passes `theme="dark"` as a plain literal. This spec therefore adds no
`ThemeProvider`, no `forcedTheme`, and does not reintroduce `next-themes` — there is nothing left
for Decision 1's "every built-in theme is dark-toned" to drive through next-themes, since Sonner
already reads a hardcoded literal.

**Rationale**: the alternative this decision originally rejected (rewriting `sonner.tsx` to drop
`next-themes` entirely) is exactly what happened, for unrelated reasons (the `useTheme()` call was
already dead code, not a deliberate theming mechanism). Reopening `next-themes` as a dependency now
would add back a library with zero live call sites for no benefit.

**Alternatives considered**: n/a — superseded, not re-decided.

## 12. Contrast verified by a one-off script, not CI

**Decision**: `scripts/check-theme-contrast.mjs` parses each theme's OKLCH token pairs straight
out of `globals.css`, converts to sRGB and relative luminance, and checks the FR-008 ratios
(4.5:1 body text / state-colour pairs, 3:1 large text and non-text parts) for every built-in
theme and every FR-007 surface's token pair. It is run by hand during the Polish task, exactly as
spec 001 T089 verified scrollbar contrast "from the computed colours" — no CI wiring is requested
by this spec.

**Rationale**: Matches the constitution's prototype stance (no automated test suite requirement)
while still giving a repeatable, objective pass/fail per pair instead of eyeballing swatches.

**Alternatives considered**: A browser-based contrast checker extension used manually with no
script — rejected: a script is reusable the next time a token changes, and its numbers go
straight into the handback report instead of a screenshot.
