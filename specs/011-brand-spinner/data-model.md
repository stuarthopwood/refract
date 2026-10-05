# Data model: Brand spinner

This feature adds one new renderer-only component and no new persisted, IPC-crossing, or
main-process data. Terms follow [CONTEXT.md](../../CONTEXT.md).

## New component (`src/renderer/components/brand/BrandSpinner.tsx`)

```ts
export interface BrandSpinnerProps {
  /** Pixel size; also selects the render variant (see "Render variant selection" below). */
  size: number
  /** Merged with the component's own classes (research.md decision 4) -- layout utilities only
   * (e.g. `shrink-0`); colour is always the fixed brand palette (research.md decision 7) and is
   * never overridable through this prop. */
  className?: string
}

export function BrandSpinner(props: BrandSpinnerProps): JSX.Element
```

- Always renders with `aria-hidden` and no accessible name of its own (research.md decision 8);
  never accepts an `aria-label`/`aria-labelledby` prop.
- Composed of one fixed core group (`opacity: 1` throughout) and three arm groups (teal, amber,
  violet), structurally matching `build/refract-icon-v2.svg`'s / the prerequisite
  `src/renderer/assets/brand/refract-hero.svg`'s own three-arm layout (spec.md "Prerequisite").
- Colours are hard-coded brand values, not CSS custom properties sourced from
  `src/renderer/styles/globals.css`'s per-theme blocks (research.md decision 7) -- the one icon-like
  component in the app whose colour does not vary with `theme-store.ts`'s active theme.

## Render variant selection

| `size` | Variant | Facet detail | Reason |
|---|---|---|---|
| `< LEGIBILITY_FLOOR_PX` (24) | Simplified | None -- one flat, solid tone per arm | fine internal facets are not recognisable below this size (research.md decision 2) |
| `>= LEGIBILITY_FLOOR_PX` (24) | Full | Every facet from the source mark | reads clearly at this size and above |

`LEGIBILITY_FLOOR_PX` is one exported constant in `BrandSpinner.tsx`, not a per-call magic number.

Today's one shipped call site passes `size={16}` (`sessionDisplay.tsx`'s `StateIcon`, `working`
case, replacing its current 16px `LoaderCircleIcon`/`animate-spin`) and therefore always renders
the Simplified variant. No shipped call site passes `size >= 24` (spec.md Assumptions,
research.md decision 10).

## Animation

No React state of any kind; the animation is pure CSS and needs no store.

- One `@keyframes` definition per arm (or one shared definition applied three times with different
  delays -- an implementation choice, not specified here): each arm's `0%`/`100%` frames are
  identical ("at rest": full opacity, no lift), with one brief "bright and lifted" frame partway
  through, so a near-zero-duration, single-iteration collapse (reduced motion, research.md decision
  6) always lands back on the matching rest frame.
- Three arms, evenly spaced a third of a cycle apart (research.md decision 3), 1.2s cycle,
  ease-in-out, infinite.
- **Shared clock** (research.md decision 5): at mount, each instance computes its own
  `animation-delay` as `-(Date.now() % 1200)`ms -- a pure function of wall-clock time, computed
  once, with no listener, no `requestAnimationFrame`, and no per-frame React work afterward. Every
  instance mounted at any moment lands on the same point in the shared 1.2s cycle as every other
  currently-mounted instance.

## No change to existing entities

- `SessionStatus`, `StateIcon`'s own props (`{ status: SessionStatus }`), `STATUS_LABEL`,
  `Session`, `Settings` (specs 001, 004, 007) are unchanged.
- `ToolRow.tsx`'s `RowStatus`/`StatusIcon`, `Transcript.tsx`'s streaming-Thinking-row icon,
  `SubagentPanel.tsx`'s `SubagentStateIcon`/`SubagentSummary['status']`, `SessionList.tsx`'s
  per-repository `creating` spinner, `Readiness.tsx`'s two checking spinners, `sonner.tsx`'s
  Toaster `loading` icon, and `ChatPane.tsx`'s "Starting the agent…" pulsing dot are all unchanged
  (research.md decision 1, spec.md FR-003).
- No change to `registry.json`, `settings.json`, or `processes.json`: nothing in this spec is
  persisted, and nothing crosses the renderer/main IPC boundary differently than it does today --
  the spinner is a renderer-only, stateless-beyond-its-own-mount-time-computation component, unlike
  spec 012's watermark (which adds a `Settings` field and an IPC round trip).

## Cross-spec data notes

- **`sessionDisplay.tsx`'s `StateIcon`** (specs 001, 004, 008 all read it) keeps its exact existing
  signature; only the JSX its `working` branch returns changes.
- **Spec 007's theme presets**: the spinner's fixed colours are read against both presets'
  background tokens for the contrast check in quickstart.md's Story 2, but the spinner itself holds
  no theme-derived state and subscribes to no theme store.
