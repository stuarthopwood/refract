# Refract brand assets

The Refract mark: a Greek "pi" (the app orchestrates `omp` -- a "Pi" -- sessions) with a beam
entering from the left and refracting into five coloured rays fanning to the right ("One Pi,
every angle."). Font: **Archivo Black** (SIL OFL-1.1, see `src/renderer/assets/fonts/OFL.txt`),
the one bundled font in the app (docs/DESIGN.md "Look and feel").

## Single source of truth

`src/renderer/components/brand/mark-geometry.json` holds every colour and coordinate. Two things
read it and nothing else defines the design by hand:

- `src/renderer/components/brand/RefractMark.tsx` -- renders it as JSX for the in-app brand
  header (`src/renderer/features/readiness/Readiness.tsx`). Real SVG, so it stays crisp at any
  size there; no rasterisation step involved.
- `resources/brand/build-icons.mjs` -- renders it to the Windows app icon (`build/icon.ico`) and
  regenerates `resources/brand/icon-full.svg` / `icon-small.svg` as a byproduct (those two files
  are generated output, checked in for inspection/reference -- never hand-edit them; edit
  `mark-geometry.json` and rerun the script instead).

To change a colour or position: edit `mark-geometry.json`, then `pnpm build:icon`. The in-app
header picks up the change on the next build automatically (it reads the same JSON).

## Why the icon has two designs, not one

`icon-full.svg` is the detailed mark (dot-grid background, glow, five-ray fan) -- used for 48px
and up. `icon-small.svg` is the glyph only, no fan, no dot grid, with its own larger/centred glyph
position (`piGlyphSmall` in the JSON) -- used for 16/24/32px. Below ~48px the five thin rays and
their dots compress into a muddy smear when downsampled from the full design, so the small tier
drops the fan entirely rather than shrinking it; shrinking the glyph itself still reads fine down
to 16px.

## Regenerating `build/icon.ico`

```
pnpm build:icon
```

runs `resources/brand/build-icons.mjs` through the project's own Electron binary (it needs a real
browser engine to rasterise SVG + a webfont -- `msedge.exe --headless=new --screenshot` hung
indefinitely in this environment, which is why the script drives Electron directly instead of a
generic headless-browser CLI). Two non-obvious things the script does, both load-bearing:

- **Each generated SVG embeds the font in its own `<style>`, not the host page's.** An SVG used
  in "image mode" (an `<img>` src, or drawn to a `<canvas>` via `drawImage`, which is how the
  small icon tiers are produced -- see below) cannot see an enclosing page's `@font-face` at all;
  it silently falls back to a system font that still looks plausible at a glance. A
  data-URI `@font-face` inside the SVG's own `<defs>`/`<style>` renders correctly in every
  context: inline in a live DOM, as a standalone file opened directly, or drawn to a canvas.
- **Small sizes are produced by canvas `drawImage`, not a window sized to the target pixels.**
  Windows enforces a real minimum window size well above the small icon tiers -- empirically
  ~32x39px for a `BrowserWindow` even with `useContentSize: true` and `frame: false` (confirmed by
  creating one at a requested 16x16 and reading back `getBounds()`). The script instead creates
  one normal-sized window, loads each SVG as a high-resolution `<img>` (1024px, matching its
  `viewBox`), and draws it to an off-screen `<canvas>` at every target size with
  `imageSmoothingQuality: 'high'`, which sidesteps the window-size floor entirely.

If you ever re-derive this script from scratch, two other gotchas proved costly the first time
(no longer applicable to the checked-in version, since it no longer renders one size per window,
but worth keeping in mind for any similar Electron-capture pipeline):

- Capturing a window larger than the screen's actual `workArea` gets silently clamped --
  `capturePage()` then returns the clamped size, not the requested one. Assert the captured size
  before trusting it.
- The HTML wrapper needs `overflow: hidden`, or a one-pixel overflow bakes a real scrollbar into
  the captured bitmap along the right and bottom edges.

## Licence

Archivo Black ships under the SIL Open Font License 1.1. `src/renderer/assets/fonts/OFL.txt` is
the unmodified licence text, next to the unmodified font file, per its terms.
