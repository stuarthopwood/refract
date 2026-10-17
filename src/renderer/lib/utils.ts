// Issue #928 fix (Critical, Gate951Code): the default `cn` export (tailwind-merge-style) treats
// a bare `text-<name>` utility as a TEXT COLOUR by default, so `cn('... text-readout
// text-muted-foreground')` collapsed to just `text-muted-foreground` -- `text-readout`
// (ReadoutChip.tsx's own font-size utility, globals.css's `--text-readout: 13px`) was silently
// stripped from every status-line chip's className, so every chip rendered at the browser's
// un-sized default (~16px) regardless of this story's own CSS. Confirmed live by this story's
// own CDP check measuring every chip at ~16px, not 13px.
//
// Fix: register `readout` as a known FONT-SIZE class name (not a colour) via `createCn`'s
// `extend.classGroups` option (real API verified against `node_modules/cn`'s own
// `dist/config.cjs`/`config.d.ts`) -- `{ text: ['readout'] }` adds `text-readout` to the
// `font-size` group, the same group `text-xs`/`text-sm`/etc already belong to, so it is correctly
// recognised as a font-size utility and no longer collides with `text-<colour>` utilities.
// Verified with a throwaway `node -e` against this exact config: `cn('text-readout
// text-muted-foreground')` now returns both classes, unchanged from the input order.
import { createCn } from 'cn/config'
import type { CnFunction } from 'cn'

// Gate round 2 (found live, found-and-fixed as part of a later merge): `createCn`'s own return
// type is only nameable through `cn/config`'s internal, non-exported module path -- TS cannot
// portably infer it without this explicit annotation (TS2883). `CnFunction` is `cn`'s own public
// type export for exactly this shape, re-used here rather than invented.
export const cn: CnFunction = createCn({ extend: { classGroups: { 'font-size': [{ text: ['readout'] }] } } })
