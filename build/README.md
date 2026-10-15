# build/

Brand and icon assets for Refract.

- **`icon.ico`** — The app icon (the isometric cube-and-arms mark). Eight PNG frames: 16, 24, 32,
  48, 64, 96, 128, and 256 px, 32-bit with transparency. The same artwork is exported into
  `src-tauri/icons/` (32x32.png, 128x128.png, 128x128@2x.png, icon.ico) and wired into
  `src-tauri/tauri.conf.json`'s `bundle.icon` and `bundle.windows.nsis.installerIcon` (#855).
- **`refract-icon-v2.svg`** — The source artwork the icon and the in-app hero are made from. Treat it
  as the source of truth: transparent background, 512 x 512 viewBox, no external references. Nothing
  loads this file at runtime.

The in-app hero (the readiness screen's brand header and the left nav's header) is
`src/renderer/assets/brand/refract-hero.svg`: the same paths as `refract-icon-v2.svg` with the
viewBox tightened to the artwork so the mark fills its box at small sizes. If the artwork changes,
regenerate that copy from `refract-icon-v2.svg`; do not edit the two independently.
