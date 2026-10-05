# Research: Brand watermark

Decisions follow the format: Decision / Rationale / Alternatives considered. Nothing here depends
on an unverified OMP/RPC behaviour (constitution IV), so there are no **UNVERIFIED** items or probe
tasks — every decision below rests on this process's own already-shipped Chromium/CSS platform
(Electron 44.5.1) or on code already read in this checkout.

## 1. Anchor region: the reading area, not the outer chat panel (corrected after design review)

**Decision**: The mark is anchored to the bottom-right corner of the **reading area** — the
scrollable transcript container (`ChatPane.tsx`'s `<div className="min-h-0 flex-1 overflow-
hidden">` wrapping `<Transcript />`, lines 441-443) — not the outer `ResizablePanel id="chat"` in
`src/renderer/App.tsx`, and not the whole window.

**Rationale**: A design review (`ui-architect-v3`) found, and a direct code read confirmed, that
this spec's first draft anchored the mark to the OUTER chat panel's own bottom-right corner, which
sits directly behind the composer: `ChatPane.tsx` renders its transcript container (line 441-443)
and `<MessageInput key={sessionId} .../>` (lines 444-450) as plain flex siblings inside one
`flex h-full flex-col` root (line 344) — the composer is laid out in normal flow, not an overlay,
and `MessageInput.tsx`'s own composer field is a solid, opaque `bg-composer-background` fill (line
737, docs/DESIGN.md "Composer tone": "a solid field... never a translucent alpha composite"). A
mark anchored a fixed 24px from the OUTER panel's bottom edge sits inside the composer's own
vertical footprint at almost every window size, and strictly worse as the message box grows (up to
~8 lines, DESIGN.md "Message box") — the outer panel's bottom edge does not move, but the
composer's top edge rises to meet it. Anchoring to the transcript container instead fixes this
structurally: that container is `flex-1` (all the height the header and composer do not take), so
its own bottom edge is, by flexbox layout, always exactly the composer's current top edge — the
mark's fixed inset from that edge (decision 7) clears the composer at every height with no runtime
tracking needed (decision 8).

**Alternatives considered**: Keeping the outer-panel anchor and instead subtracting the composer's
current height from the offset via a CSS custom property (`bottom: calc(var(--composer-height) +
1.5rem)`), updated by a `ResizeObserver` watching the composer — rejected (decision 8): it needs a
live JS measurement and a per-resize write, against FR-022's "no per-frame JavaScript" and this
spec's existing "CSS owns placement" principle, for a problem the transcript container's own
already-`flex-1` layout already solves for free. The whole window, and the whole main content area
(session list + chat + Subagent panel) — both still rejected for the original reason (every other
region already paints its own opaque background over it; the Subagent panel's own content is
opaque exactly the same way the composer is).

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

## 3. One instance, belonging to the eligible pane's reading area

**Decision**: `BrandWatermark` (`variant="live"`) mounts in up to three places, never more than one
of which is ever actually rendered at once: (a) `App.tsx`'s own `paneSessionIds.length === 0` div
(no pane open at all — no composer exists in this branch, so the mark anchors to that div's own
full box); (b) `ChatPane.tsx`'s `!session` `<Empty>` fallback (lines 278-290 — a Session id is
assigned to this pane but the session itself did not resolve; also no composer rendered here); (c)
`ChatPane.tsx`'s normal transcript container (decision 1), gated by a new `showWatermark?: boolean`
prop that `App.tsx` passes `true` only to the single pane shown when there is one, or to `paneB`
(index 1, the right/second pane) when a true two-pane split is showing — never to `paneA`.

**Rationale**: `ChatPane.tsx` is deliberately "independently-scoped" per pane (`docs/DESIGN.md`
"Split chat pane"); mounting the mark unconditionally inside it would duplicate it once per open
pane, directly violating FR-008 ("one watermark, not one per pane", the brief's own wording). A
single boolean prop, set by `App.tsx` (which already knows, from `paneSessionIds`/`focusedIndex`,
exactly which pane is the single/right one), is the simplest way to pick exactly one eligible
instance without `ChatPane` instances needing to coordinate with each other. The narrow-window
collapse (spec 005 research.md Decision 6, `!canShowSplit`) already renders through the SAME
single-pane branch as a true single Session, so it needs no separate case: whichever `ChatPane` is
actually mounted there already receives `showWatermark`.

**Alternatives considered**: Mounting once at the outer chat container (the first draft) —
rejected (decision 1): that anchor sits behind the composer. Letting each `ChatPane` instance
privately read `useSplitStore` to decide for itself whether it is "the right one" — rejected:
`App.tsx` already computes exactly this (`paneA`/`paneB`, `focusedIndex`) for its own rendering
decisions, so a prop is less code and one fewer place the split-pane rule could drift out of sync
with the actual render branch.

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

## 5. Opacity: one named constant, with a real measured starting value and ceiling

**Decision**: `--watermark-opacity: 0.06;` is declared once in `globals.css`'s `:root` block
(alongside `--radius`, the only other theme-independent custom property there today), not inside
each `.theme-*` block. Future tuning of this one line should not exceed **0.12** without
re-running the measurement below.

**Rationale**: A design review cited unverified numbers (roughly 5.93:1/11.8:1 at 0.06, a 0.08
ceiling); per the brief, those are not accepted — decision 13 below recomputes the real contrast
directly from `globals.css`'s own token values, using the identical OKLab/gamma-correct
alpha-compositing math `scripts/check-theme-contrast.mjs` already uses (so this spec's own numbers
are methodologically consistent with the one contrast script the codebase already trusts). The
real margin at `0.06` is far larger than the review guessed (roughly 7.2:1 muted-foreground / 13.8:1
chat-foreground on the tighter Dark preset, both against a 4.5:1 floor) — WCAG contrast is, in
fact, nowhere near the binding constraint on how faint or strong this mark can be: the tightest
pair (Dark, muted-foreground) does not cross 4.5:1 until roughly opacity 0.32. `0.06` is kept as the
starting value (a genuinely faint mark, matching Stuart's word), and `0.12` is set as a documented
ceiling with real headroom to spare (muted-on-mark 6.56:1, chat-on-mark 12.63:1 at that ceiling for
Dark, the tighter preset) rather than at the edge of failure — see decision 13 for the full table.

**Alternatives considered**: Accepting the review's un-computed 0.06-0.08 range at face value —
rejected per the brief ("Do not accept that"); the real numbers are both more favourable and a
different shape (margin degrades slowly, not sharply, as opacity rises) than the review implied. A
per-theme opacity (a lower value for the high-contrast preset, which has even more headroom) —
rejected as unneeded complexity: decision 13's table shows the high-contrast preset's margin is
strictly larger than Dark's at every opacity tested, so the single shared constant is already safe
for both without a per-theme override.

## 6. Size: a CSS container-query clamp, not a JS resize listener

**Decision**: `ChatPane.tsx`'s transcript container (decision 1) gets `container-type: size` added
to its existing class string; the mark's own box is
`width: clamp(96px, 20cqw, 280px); aspect-ratio: 1` (square, matching `refract-hero.svg`'s own
tightened `viewBox="96 122 320 320"`, itself square), with height following from the aspect ratio,
not a second clamp.

**Rationale**: CSS container query units (`cqw`) have shipped in Chromium since M105 (2022) —
Electron 44.5.1 (this app's pinned version, confirmed live via a throwaway probe, decision 11)
bundles Chromium 152, so this is an already-established web platform fact, not a project-specific
unverified one (constitution IV's UNVERIFIED marker is reserved for OMP/RPC facts, not long-shipped
browser features). A CSS-only clamp costs nothing at runtime (FR-022: no per-frame JavaScript, no
`ResizeObserver` callback), unlike a JS-measured alternative. Sizing against the transcript
container specifically (rather than the outer panel) also means the clamp automatically narrows
when the session list or Subagent panel takes more width, or when a split halves the available
space — exactly the surface the mark is actually anchored to (decision 1).

**Alternatives considered**: A `ResizeObserver` in `BrandWatermark.tsx` setting an inline `width`
on every resize — rejected: strictly more runtime cost (a JS callback per resize) for a purely
decorative element with no behavioural reason to need it, directly against FR-022. Viewport units
(`vw`) instead of container units — rejected: `vw` is relative to the whole window, not the reading
area's own (possibly narrower, session-list-widened, or split) width, which would desync the mark's
size from the region it is actually anchored to.

## 7. Offset: a fixed 24px inset, the existing Tailwind spacing scale

**Decision**: The mark sits `right-6 bottom-6` (Tailwind's `1.5rem` / 24px step) from the reading
area's own edges — a single, non-scaling value, not relative to the mark's own size or the window.

**Rationale**: 24px is an already-used step on Tailwind's default spacing scale (the same scale
every other inset/padding value in this codebase already draws from, e.g. `SettingsScreen.tsx`'s
`p-6` content padding); picking a value already on that scale, rather than inventing a bespoke one,
keeps the mark visually consistent with the rest of the app's spacing rhythm without adding a new
design-token category for one feature. Anchored to the reading area's own bottom edge (decision 1),
this 24px inset is also exactly what keeps the mark clear of the composer: the reading area's
bottom edge already sits flush against the composer's top edge, so the mark never touches it.

**Alternatives considered**: An offset relative to the mark's own size (e.g. 10%) — rejected: it
makes the inset itself shrink as the window narrows, which reads as the mark creeping toward the
corner rather than staying consistently inset, a subtler and less predictable rule for no real
benefit.

## 8. Mounted inside the existing transcript wrapper; composer clearance by flex geometry, not JS

**Decision**: `BrandWatermark` is added as the FIRST child of `ChatPane.tsx`'s existing transcript
container (`<div className="relative min-h-0 flex-1 overflow-hidden [container-type:size]">` —
adding only `relative` and `[container-type:size]` to its current class string), immediately before
`<Transcript sessionId={sessionId} />`, guarded by the new `showWatermark` prop (decision 3).
`BrandWatermark` itself is `absolute inset-0 pointer-events-none -z-10` with its mask-image box
positioned inside that bound (`absolute right-6 bottom-6`). The App.tsx/ChatPane `<Empty>` mount
points (decision 3) get the same small `relative` treatment on their own existing root element, no
extra wrapper div.

**Rationale**: This is a strictly SMALLER change than the first draft's own new wrapper div: the
transcript container already has `overflow-hidden` (needed for `Transcript`'s own scrolling,
unrelated to this spec), so `BrandWatermark`'s own box already clips at that existing boundary with
no new ancestor and no new clipping risk introduced to anything else. Because this container is
already `flex-1` inside `ChatPane`'s `flex h-full flex-col` root (decision 1), the composer-
clearance guarantee (FR-007) is a structural consequence of layout that already exists today, not
new behaviour this spec has to maintain. `MessageScroller`/`MessageScrollerViewport`/
`MessageScrollerContent` (`src/renderer/components/ui/message-scroller.tsx`) set no `bg-*` class of
their own, so the mark (mounted as their sibling, `-z-10`) shows through wherever the transcript has
no painted content — confirmed by direct read, not assumed. `-z-10` (the same class `App.tsx`
already uses for its permanent drag-strip element) is reused rather than inventing a new stacking
convention.

**Alternatives considered**: A `ResizeObserver`-driven `--composer-height` CSS variable (decision
1's rejected alternative) — strictly more code and runtime cost for a guarantee the existing
`flex-1` layout already provides. Adding a brand-new wrapper `<div>` around the whole conditional in
`App.tsx` (the first draft) — rejected: it would have wrapped real content (the composer included)
in a NEW ancestor, which is exactly the clipping risk this decision avoids by reusing the
transcript container's own, already-present `overflow-hidden` instead of introducing a second one
further up the tree.

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

## 11. Hidden under `forced-colors: active` AND `prefers-reduced-transparency: reduce`

**Decision**: `BrandWatermark`'s own CSS class is wrapped in
`@media (forced-colors: active), (prefers-reduced-transparency: reduce) { display: none; }` in
`globals.css`.

**Rationale**: Windows High Contrast mode (the `forced-colors` media feature) replaces
author-specified colours with a small system palette and can render a `mask-image`
unpredictably; Windows' own "Show transparency in Windows" setting, when turned off, maps to the
`prefers-reduced-transparency: reduce` media feature, and a faint, semi-transparent-reading mark
is exactly what that setting asks apps to avoid. Per the brief, this was verified, not assumed:
a throwaway Electron probe (`C:/tmp/spec012-mq/main.js`, deleted after use, not part of this
repo) launched a hidden `BrowserWindow` with this app's own `sandbox: true`/`contextIsolation:
true` preload posture and evaluated `window.matchMedia('(prefers-reduced-transparency: reduce)')`
inside it. Result, this app's exact pinned versions: Electron `44.5.1`, Chromium `152.0.7977.130`
— `matchMedia(...).media` echoed back the query verbatim (`"(prefers-reduced-transparency:
reduce)"`, not degraded to `"not all"`, which is how an unrecognised media feature serializes),
confirming Chromium genuinely parses and evaluates it rather than silently ignoring it (`.matches`
itself read `false`, the expected default with the OS setting not forced on in that environment).
Since the mark is purely decorative, hiding it outright under either condition is the simple,
standard pattern — the same category of unconditional rule `globals.css`'s existing
`@media (prefers-reduced-motion: reduce)` block already uses for a different concern (collapsing
animation), placed in the same file, outside any `@layer`, for the same "global override" reason.

**Alternatives considered**: Using `forced-color-adjust: none` to force the author colour through
unconditionally — rejected: that is the opposite of this decision's intent (preserving, not
suppressing, the mark under forced-colors), and a purely decorative element has no accessibility
argument for insisting on its own colour against the user's own explicit high-contrast choice.
Treating `prefers-reduced-transparency` as a best-effort, unverifiable rule (constitution IV
UNVERIFIED marker) — rejected once the probe above confirmed it is a real, recognised feature at
this app's pinned Electron/Chromium version; writing it as a soft "where supported" rule would
have been needlessly hedged given the evidence.

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

## 13. Contrast arithmetic: computed from the real tokens, not the review's estimate

**Decision**: The opacity's starting value and ceiling (decision 5) are set from a direct
computation against the real `oklch(...)` values in `globals.css`, reusing
`scripts/check-theme-contrast.mjs`'s own published OKLab-to-linear-sRGB matrices and its
gamma-correct alpha-compositing fix (that script's own comment: "browsers alpha-composite in
gamma-encoded sRGB space, not linear light") verbatim, run as a throwaway Node script
(`C:/tmp/spec012-mq/contrast.mjs`, deleted after use, not part of this repo). The pair checked is:
the watermark's own rendered colour — `--muted-foreground` masked at `--watermark-opacity` over
`--background` — as the composited backdrop, against the two text colours that can plausibly sit
over it in the reading area: `--muted-foreground` itself (secondary/meta text, e.g. timestamps)
and `--chat-foreground` (primary prose, docs/DESIGN.md "Chat text colour"). Both must clear 4.5:1
(WCAG AA body text) against that composited backdrop, in both built-in presets.

**Real numbers** (ratio format `X:1`, floor 4.5:1):

| Theme | Opacity | muted-fg vs. plain bg | muted-fg-on-mark | chat-fg-on-mark |
|---|---|---|---|---|
| dark | — | 7.63 | — | — |
| dark | 0.06 (starting) | — | **7.16** | **13.78** |
| dark | 0.12 (documented ceiling) | — | 6.56 | 12.63 |
| dark | 0.30 (where margin starts getting tight) | — | 4.57 | 8.80 |
| dark-high-contrast | — | 13.28 | — | — |
| dark-high-contrast | 0.06 (starting) | — | 12.35 | 17.38 |
| dark-high-contrast | 0.12 (documented ceiling) | — | 11.16 | 15.70 |

(`dark`'s own plain-background contrast rows — 7.63 muted-fg / 14.68 chat-fg, not tabulated a
second time above — are the baseline every "on-mark" column is compared against; the "on-mark"
numbers are always slightly below the plain-background ones, since the mark is a step toward
`muted-foreground`'s own lightness, never away from it, and `dark-high-contrast` keeps a larger
absolute margin at every opacity since both its background and foreground start further apart.)

**Rationale**: The design review's own numbers (roughly 5.93:1/11.8:1 at 0.06) were not computed
from this codebase's real tokens and are meaningfully lower than the real result — this matters
because a reviewer's unverified guess, if trusted, would have produced an unnecessarily
conservative (or, in the other direction, an unknowingly risky) opacity choice; computing it
directly removes that guesswork. The real headroom is large enough that WCAG contrast is not
actually the binding constraint on this mark's faintness or strength at all (the Dark preset's
tighter pair does not cross 4.5:1 until roughly opacity 0.32) — the documented 0.12 ceiling is
chosen with real margin to spare specifically so a future aesthetic tuning pass has room to move
without re-deriving this table from scratch, not because 0.12 is where failure begins.

**Alternatives considered**: Trusting the review's numbers without recomputation — rejected per
the brief's explicit instruction. Checking against `--foreground` instead of `--chat-foreground`
— rejected: `docs/DESIGN.md` "Chat text colour" states no chat surface uses the bare `--foreground`
token for prose, so `--chat-foreground` (the one actually used) is the real worst-case "primary
text" pair, not a token nothing in the reading area renders with.

## 14. Settings control: its own sub-section, separated from Save/Cancel, standard copy

**Decision**: `AppearanceSection.tsx` renders the watermark `Switch` and its preview (decision 9)
in their own block, visually separated from the theme picker's Save/Cancel row by a divider
(`<hr className="my-6 border-border" />`) and its own small heading ("Background watermark"
rendered as the Switch's own label, not a separate `<h3>`, matching how the Session readout
toggles already label themselves — no new heading level is introduced). The visible label reads
"Background watermark"; its one-line description is plain, jargon-free prose (no spec id, no
"FR"/"T" identifier, no parenthetical aside), following the repo's UI-text rules
(`docs/DESIGN.md`, "No bracket/parenthetical UI copy").

**Rationale**: `AppearanceSection.tsx` already ends in a Save/Cancel row that governs ONLY the
theme picker above it (`handleSave`/`handleCancel`, both calling `theme-store.ts` actions); adding
a live-apply `Switch` directly below that row, with no visual break, risks reading as "also
governed by Save/Cancel" even though `setWatermarkEnabled` persists immediately on change. A
divider plus the control's own clear labelling removes that ambiguity without inventing a new
settings-screen convention — `<hr>` dividers between unrelated groups of controls are already an
ordinary pattern, and "Background watermark" (rather than "Watermark" alone) states what the
control visually produces in the same style the Session readout labels already use ("Changes",
"Context window usage" — short, concrete nouns, no implementation jargon).

**Alternatives considered**: A second `<h3>` heading above the switch — rejected: the Session
readout toggles use only a label + description per control, no sub-headings between them;
introducing one here for a single control would be an inconsistent, one-off heading level. Naming
the control just "Watermark" — rejected: "watermark" alone is closer to print/document jargon than
a plain description of what the developer sees (a faint mark in the background), and "Background
watermark" reads immediately as "the faint thing in the background," matching the plain-language
bar the rest of the Settings screen already holds to.
