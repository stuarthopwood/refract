# Research: Brand watermark

Decisions follow the format: Decision / Rationale / Alternatives considered. Nothing here depends
on an unverified OMP/RPC behaviour (constitution IV), so there are no **UNVERIFIED** items or probe
tasks — every decision below rests on this process's own already-shipped Chromium/CSS platform
(Electron 44.5.1) or on code already read in this checkout.

## 1. Anchor region: the chat area, not the whole window

**Decision**: The mark is anchored to the bottom-right corner of the "chat" region in
`src/renderer/App.tsx` — the `ResizablePanel id="chat"` that hosts either one `ChatPane` or the
two-pane split group (spec 005) — not the whole window, not the "main content area" including the
session list and Subagent panel.

**Rationale**: Every other region of the window already paints its own opaque background: the
status bar (`StatusBar.tsx`) is `bg-card` and sits outside the main content area entirely below it;
the session list and Subagent panel are each their own `ResizablePanel` with the sidebar/background
tokens already applied. Anchoring to the whole window's bottom-right corner would, in the common
case (Subagent panel open), place the mark directly behind that panel's own opaque content — never
visible. Anchoring to the chat area alone guarantees it is visible in the place the developer
actually spends the most time looking (the transcript, the composer's surrounding space, and the
"Select a Session" empty state), and it is unaffected by the Subagent panel's width the way the
window-wide option would be.

**Alternatives considered**: The whole window — rejected per the opaque-panel reasoning above.
"The main content area" (session list + chat + Subagent panel combined, i.e. the
`ResizablePanelGroup` itself) — rejected: this corner would sit inside the Subagent panel exactly
when it is open (an incidental, state-dependent visibility the chat-only anchor avoids), and
inside the chat pane's own right edge exactly when it is closed, which is the same inconsistency
in a different guise.

## 2. Hidden on Settings, Readiness, and Manage sessions

**Decision**: The real mark never renders on the Settings screen, the Readiness (first-run)
screen, or the future Manage sessions screen (spec 008, not yet built — `view-store.ts`'s
`'manage-sessions'` value is currently a typed stub with no render branch in `App.tsx`). Each of
these replaces the chat area's `ResizablePanel` entirely with its own content
(`App.tsx`'s `view === 'settings' ? <SettingsScreen /> : …`), so the mark's own container simply
does not exist there — no extra conditional is needed to suppress it.

**Rationale**: These are task-focused administrative screens, not the ambient chat workspace the
mark is meant to sit behind. The Readiness screen already carries a large, non-faint rendering of
the same `refract-hero.svg` in its brand header (`docs/DESIGN.md` "First run and empty states"); a
second, faint corner copy there would read as a mistake, not a feature. The Settings screen's own
two-column layout (`SettingsScreen.tsx`: a 192px `nav` plus a content pane already filled with
either the Session readout toggle list or the theme picker and its Save/Cancel row) has little
genuinely empty background space for a corner mark to sit in without crowding real controls.

**Alternatives considered**: Rendering the real mark behind Settings' own background too (so the
toggle is "previewable" by literally showing the real effect there) — rejected in favour of a
small, dedicated preview (decision 9) instead: it keeps every full-screen, task-focused view
watermark-free for the same consistency reason, while still meeting the brief's requirement that
the toggle's effect be checkable without leaving Settings.

## 3. One instance regardless of split: mounted at the outer chat container, not inside `ChatPane`

**Decision**: The mark is a new, small presentational component (`BrandWatermark.tsx`) mounted
once, directly inside the `ResizablePanel id="chat"` in `App.tsx`, as a sibling positioned *before*
the existing conditional (single pane vs. two-pane split group) content — never inside `ChatPane.tsx`
itself.

**Rationale**: `ChatPane.tsx` is deliberately "independently-scoped" per pane (`docs/DESIGN.md`
"Split chat pane"); mounting the mark there would duplicate it once per open pane, directly
violating FR-007 ("one watermark, not one per pane", the brief's own wording). Mounting it one
level up, at the container both the single-pane and the split-group branches already share, gives
exactly one DOM instance regardless of `paneSessionIds.length`, with no conditional logic of its
own needed to suppress a second copy.

**Alternatives considered**: Mounting inside `ChatPane` with a flag naming "which pane owns the
mark" — rejected as needless coordination state between sibling panes for a purely decorative
element the shared container can place once without any pane needing to know about it.

## 4. Single-colour silhouette via CSS `mask-image`, not the artwork's full colour

**Decision**: The mark renders as a flat silhouette: a `div` with `mask-image: url(.../refract-hero.svg)`
(`mask-size: contain; mask-repeat: no-repeat; mask-position: center`) and
`background-color: var(--muted-foreground)`, at a fixed low opacity (decision 5) — not the
artwork's own teal/amber/violet/core palette.

**Rationale**: `--muted-foreground` is already declared in every `.theme-dark`/`.theme-dark-high-
contrast` block (spec 007, `globals.css`) specifically as the token for secondary/meta content
(`docs/DESIGN.md` "Chat text colour" already reserves it for exactly this kind of role). Reusing it
means: (a) the mark automatically matches any future built-in theme preset with zero extra work,
since it reads a token every theme already defines; (b) the WCAG contrast proof (FR-014) reduces to
one flat colour blended at one opacity against one background per theme, rather than needing to
reason about three separate hues' blending maths each; (c) no second, differently-coloured copy of
`refract-hero.svg` needs to exist — the exact same file already bundled for the Readiness/left-nav
header is reused unmodified, satisfying "reuses the prerequisite asset, no second copy."

**Alternatives considered**: The artwork's full colour, at low opacity — rejected: harder to prove
AA analytically per theme (three independent hues' luminance contributions instead of one), and it
would read as a second small illustration competing with the chat content rather than a quiet tonal
watermark. A dedicated new CSS token (e.g. `--watermark-color`) instead of reusing
`--muted-foreground` — rejected as an unnecessary new per-theme value when an existing, correctly-
scoped token already fits.

## 5. Opacity: one named constant, declared once, theme-independent

**Decision**: `--watermark-opacity: 0.06;` is declared once in `globals.css`'s `:root` block
(alongside `--radius`, the only other theme-independent custom property there today), not inside
each `.theme-*` block.

**Rationale**: The faintness is a fixed design decision ("faint", Stuart's own word), not a
per-theme value the way colours are — it needs exactly one home to tune later, matching how
`--radius` already lives in `:root` for the same "theme-independent constant" reason. `0.06` is this
spec's deliberate starting value, confirmed against WCAG AA for every built-in theme preset by
extending `scripts/check-theme-contrast.mjs` during the Polish task (tasks.md) rather than merely
asserted here, the same "run by hand, not CI" discipline spec 007 decision 12 already established
for that script.

**Alternatives considered**: A per-theme opacity (e.g. a lower value for the high-contrast preset,
which starts from pure black/white and so has more headroom) — rejected as unneeded complexity
before the contrast script's own measurement shows a real need for it; if the Polish task's
measurement fails AA for any preset at `0.06`, lowering the one shared constant is the first fix to
try before reaching for a per-theme override.

## 6. Size: a CSS container-query clamp, not a JS resize listener

**Decision**: The chat `ResizablePanel`'s own wrapper div gets `container-type: size` (a new,
small wrapper this spec adds — see decision 8); the mark's own box is
`width: clamp(96px, 20cqw, 280px); aspect-ratio: 1` (square, matching `refract-hero.svg`'s own
tightened `viewBox="96 122 320 320"`, itself square), with height following from the aspect ratio,
not a second clamp.

**Rationale**: CSS container query units (`cqw`) have shipped in Chromium since M105 (2022) —
Electron 44.5.1 (this app's pinned version, spec 007 plan.md "Technical Context") bundles a far
newer Chromium, so this is an already-established web platform fact, not a project-specific
unverified one (constitution IV's UNVERIFIED marker is reserved for OMP/RPC facts, not long-shipped
browser features). A CSS-only clamp costs nothing at runtime (FR-021: no per-frame JavaScript, no
`ResizeObserver` callback), unlike a JS-measured alternative.

**Alternatives considered**: A `ResizeObserver` in `BrandWatermark.tsx` setting an inline `width`
on every resize — rejected: strictly more runtime cost (a JS callback per resize) for a purely
decorative element with no behavioural reason to need it, directly against FR-021. Viewport units
(`vw`) instead of container units — rejected: `vw` is relative to the whole window, not the chat
area's own (possibly narrower, session-list-widened, or split) width, which would desync the mark's
size from the region it is actually anchored to.

## 7. Offset: a fixed 24px inset, the existing Tailwind spacing scale

**Decision**: The mark sits `right-6 bottom-6` (Tailwind's `1.5rem` / 24px step) from the chat
area's own edges — a single, non-scaling value, not relative to the mark's own size or the window.

**Rationale**: 24px is an already-used step on Tailwind's default spacing scale (the same scale
every other inset/padding value in this codebase already draws from, e.g. `SettingsScreen.tsx`'s
`p-6` content padding); picking a value already on that scale, rather than inventing a bespoke one,
keeps the mark visually consistent with the rest of the app's spacing rhythm without adding a new
design-token category for one feature.

**Alternatives considered**: An offset relative to the mark's own size (e.g. 10%) — rejected: it
makes the inset itself shrink as the window narrows, which reads as the mark creeping toward the
corner rather than staying consistently inset, a subtler and less predictable rule for no real
benefit.

## 8. One new positioning wrapper, not a clipping ancestor over real content

**Decision**: `App.tsx`'s `ResizablePanel id="chat"` currently renders its conditional content
directly inside one `<ErrorBoundary>`. This spec wraps that existing `<ErrorBoundary>` in one new
`<div className="relative h-full [container-type:size]">`, with `<BrandWatermark />` added as a
sibling *before* it inside that same new wrapper. `BrandWatermark` itself is
`absolute inset-0 overflow-hidden pointer-events-none -z-10` with its mask-image box positioned
inside that bound (`absolute right-6 bottom-6`).

**Rationale**: The `overflow-hidden`/clipping behaviour needed to keep the mark's own box from
ever visibly overflowing its corner (edge case: an extremely narrow chat area) is scoped to
`BrandWatermark`'s own small wrapper alone — it has no DOM children other than the mask-image box,
so it cannot clip a Radix popover, dropdown, or hover card, every one of which (shadcn's Radix
primitives) portals its content to `document.body` rather than rendering as a DOM descendant of
whatever opened it. The new `relative`/`container-type` wrapper this decision adds is a pure
positioning/sizing context with no `overflow` rule of its own, so it changes nothing about how the
existing `<ErrorBoundary>` content paints, scrolls, or overflows.

**Alternatives considered**: Adding `overflow: hidden` directly to the existing `ResizablePanel`
content wrapper (skipping the extra nested div) — rejected: that wrapper is an ancestor of the real
transcript/composer content, so clipping at that level risks clipping anything inside it that
intentionally overflows its own box (unconfirmed without a dedicated audit) — scoping the clip to
`BrandWatermark`'s own leaf wrapper removes that risk entirely rather than requiring the audit.
`-z-10` (the same class App.tsx already uses for its permanent drag-strip element) is reused rather
than inventing a new stacking convention.

## 9. Settings-screen preview: a small dedicated element, not the real mark

**Decision**: The Appearance section (`AppearanceSection.tsx`) gains a small (roughly 96×96px),
bordered preview box using the exact same `BrandWatermark` visual (same mask-image, same colour
token, same opacity constant) rendered at a fixed size rather than the responsive clamp, shown or
hidden by the same `watermarkEnabled` state the switch controls.

**Rationale**: Decision 2 keeps the real mark off the Settings screen entirely; this is how the
brief's "the toggle's effect should be previewable there" requirement is still met without
reintroducing the real mark onto a screen this spec deliberately keeps watermark-free. Reusing
`BrandWatermark`'s own rendering (rather than building a second, separately-maintained visual) means
the preview can never visually drift from what the real mark actually looks like.

**Alternatives considered**: Showing the real, responsively-sized mark behind the Settings screen's
whole background — rejected per decision 2's reasoning. A text-only "on"/"off" state with no visual
preview at all — rejected: it would not actually let the developer see the mark's own appearance
(colour, faintness) before deciding, which a Switch's own checked state already communicates for
free, making a text-only readout redundant rather than additive.

## 10. IPC and persistence: mirrors `setReadoutVisibility` exactly

**Decision**: `Settings.watermarkEnabled: boolean` (default `true`) extends the existing
`settings.json` row (`src/shared/model.ts`). A new `settings.setWatermarkEnabled(enabled: boolean):
Promise<Result<Settings>>` request (`IPC_REQUESTS.SETTINGS_SET_WATERMARK_ENABLED`) persists the
whole row and returns this call's own written value, broadcasting `settings:changed` — the exact
same race-safety contract `setReadoutVisibility`/`setApprovalMode`/`setTheme` already document
(`src/main/store/settings.ts`). A non-boolean payload is the existing `invalid-argument` error code
(no new error code needed); a non-boolean value already on disk (a hand-edited or stale file) is
corrected to `true` on read, the same lazy-correction pattern `SettingsStore.open` already applies
to `theme`/`split`.

**Rationale**: Reusing an established, already-reviewed pattern exactly (rather than inventing a
new shape) is both less code and less risk; `setReadoutVisibility` is the closest existing precedent
(a single boolean-ish field toggled live from a `Switch`, persisted whole-row), closer in shape to
this feature than `theme.set`'s preview/commit pair (decision 9's reasoning already explains why
this feature does not need that pair's semantics).

**Alternatives considered**: Folding the new field into the existing
`settings.setReadoutVisibility`-style keyed setter (treating it as an eighth "readout kind") —
rejected: the watermark is not a session-readout-chip visibility choice, and conflating the two
would misname the Appearance-section control as a "readout" in code for no benefit.

## 11. Hidden under `forced-colors: active`

**Decision**: `BrandWatermark`'s own CSS class is wrapped in
`@media (forced-colors: active) { display: none; }` in `globals.css`.

**Rationale**: Windows High Contrast mode (the `forced-colors` media feature) replaces
author-specified colours with a small system palette and can render a `mask-image` unpredictably;
since the mark is purely decorative, hiding it outright is the simple, standard pattern — the same
category of unconditional rule `globals.css`'s existing `@media (prefers-reduced-motion: reduce)`
block already uses for a different concern (collapsing animation), placed in the same file, outside
any `@layer`, for the same "global override" reason.

**Alternatives considered**: Using `forced-color-adjust: none` to force the author colour through
unconditionally — rejected: that is the opposite of this decision's intent (preserving, not
suppressing, the mark under forced-colors), and a purely decorative element has no accessibility
argument for insisting on its own colour against the user's own explicit high-contrast choice.

## 12. Reuses `refract-hero.svg` verbatim; no new asset, no CSP change

**Decision**: The one `mask-image` source is exactly
`src/renderer/assets/brand/refract-hero.svg`, imported the same way `Readiness.tsx` already imports
`refract-hero.png` (a default Vite asset-URL import) — no second file, no build-time recolouring
step.

**Rationale**: The brief is explicit that the prerequisite asset must not be redone or duplicated.
Because this file is `url()`-referenced only from within the app's own bundled CSS under the same
origin ("self"), the existing CSP (`img-src 'self' data:`, `src/renderer/index.html`, CSS
`mask-image`/`background-image` resources fall under the `img-src` fetch directive) needs no
change — exactly the mechanism the existing hero `<img>` usage already relies on, just reused for a
CSS `mask-image` reference instead of an `<img src>`.

**Alternatives considered**: A build step producing a pre-recoloured, pre-cropped raster watermark
asset — rejected as an unnecessary second asset and build step when a CSS `mask-image` against the
existing vector file already gives a resolution-independent, themeable result for free.
