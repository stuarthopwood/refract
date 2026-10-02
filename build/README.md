# build/

Brand/icon assets for Refract. This directory is not currently wired into any
packaging step except where noted below.

- **`icon.ico`** — The active app icon. Referenced by `src/main/index.ts`'s
  `icon:` option (used for the dev-time window icon). This is the only file
  in this directory actually used by the app today.
- **`refract-icon.ico`** — Byte-identical copy of `icon.ico`, kept under its
  original delivered filename (Stuart's original deliverable). Not referenced
  by any code or build step.
- **`refract-icon.res`** — A hand-compiled Windows resource file. Nothing in
  this repo currently references it. Once spec 006 wires up electron-builder
  packaging, electron-builder writes its own resources from the `win.icon`
  config option rather than consuming a pre-compiled `.res`, so this file is
  not part of that path.
- **`refract-hero.png`** (1.3MB) — Stuart's original source art for the hero
  icon, at full resolution. `src/renderer/assets/brand/refract-hero.png` (a
  256x256 downscale used for in-app bundling) was derived from this file.
  This file itself is not referenced by any code or build step.

In short: only `icon.ico` is currently wired in. The other three are Stuart's
original deliverables kept for reference / possible future packaging use, not
currently part of any build step.
