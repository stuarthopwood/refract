# Implementation Plan: Geist and Geist Mono defaults with a lighter weight scale

**Branch**: `geist-fonts-lighter-weights` | **Date**: 2026-10-27 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/027-geist-font-weights/spec.md`

## Summary

Bundle Geist Mono, point `--font-ui` and `--font-code` at Geist and Geist Mono, override Tailwind's `--font-weight-*` tokens once (300/400/500/600) so every utility shifts, set body weight and `b`/`strong` from the tokens, put the composer on the Code font, and add a persisted `codeLigatures` switch (Rust store, IPC, bridge, store, Settings > Chat, root attribute).

## Technical Context

**Language/Version**: TypeScript (React, Tailwind v4 in `globals.css`), Rust (Tauri v2, `src-tauri/`)
**Storage**: the existing settings JSON store (new key `codeLigatures`)
**Testing**: no new tests (prototyping phase); existing suite and `pnpm ci:local` stay green; live check by CDP computed styles and screenshots
**Constraints**: 600-line file cap (`check:file-size`; `ipc.ts` baseline 898, current 892; `model.ts` baseline 656 so append to the existing line), reusable components (ADR 0003: reuse `SettingSwitchRow`), Tauri security baseline (no new capability or network)
**Scope**: fonts and weights only; no spacing, colour or size change (#1252 follows)

## Constitution Check

Principle V (Tauri security baseline): no new IPC capability beyond one boolean setter that validates its argument with `require_bool`, like #1242. Fonts are local files served from the app bundle (no CDN). ADR 0001 (three-layer design tokens): the weight scale lives in theme tokens in `@theme`, not in components. ADR 0003: the Settings row reuses `SettingSwitchRow`; the composer change edits the shared `Textarea` call and the shared `COMPOSER_MIRROR_CLASS`.

## Design

1. **Font files** (`src/renderer/assets/fonts/`): add `GeistMono-Variable.woff2` from the official `vercel/geist-font` release (npm `geist` package, `dist/fonts/geist-mono/GeistMono-Variable.woff2`), append its OFL text to `OFL.txt` if different, and verify `liga` survives by reading the GSUB feature list with a font parser (fonttools in a scratch dir).
2. **`globals.css`** (1770 lines; CSS is outside the size gate, but keep additions small): `@font-face` for Geist Mono (100 900); `--font-ui` Geist first, `--font-code` Geist Mono first, `--font-brand` unchanged; `@theme` adds `--font-weight-normal: 300; --font-weight-medium: 400; --font-weight-semibold: 500; --font-weight-bold: 600`; base layer sets `body { font-weight: var(--font-weight-normal) }` and `b, strong { font-weight: var(--font-weight-semibold) }`; `code, pre, kbd` keep `font-variant-ligatures: normal`, plus `:root[data-code-ligatures="off"] .font-code, ... { font-variant-ligatures: none }`; update the "never used for app chrome" comments.
3. **Literal weights**: `diff-view.css:50` and `:56` use `var(--font-weight-normal)`.
4. **Composer**: add `font-code` to the `Textarea` className at `MessageInput.tsx` (~1335) and to `COMPOSER_MIRROR_CLASS` (`CommandPillOverlay.tsx:91`), so textarea and every mirror share one font; `COMMAND_PILL_TEXTAREA_CLASS` is checked for a font override.
5. **Setting plumbing (copy of #1242)**: `src-tauri/src/store/code_ligatures.rs` (`KEY`, `parse`, setter), `settings.rs` (field, parse, serialise, `#[path]` mod), `src-tauri/src/ipc/settings_code_ligatures.rs` and `ipc/mod.rs` registration, `src/shared/ipc.ts` (`SETTINGS_SET_CODE_LIGATURES`, bridge type), `src/shared/model.ts` (field on the existing line), `src/tauri-bridge/index.ts`, `src/renderer/state/settings-store.ts` (`setCodeLigatures`), a root-attribute effect where the theme is applied, and a `SettingSwitchRow` in `ChatDisplaySection.tsx` ("Code ligatures", on by default).
6. **Docs**: `docs/DESIGN.md` "Look and feel" and `docs/design/foundations-typography-spacing.md` (weight scale, fonts), `docs/PLAN.md` row status.

## Verification

- `pnpm ci:local` (typecheck, tests, `check:*`, contrast gate, cargo fmt, clippy, test).
- Live check: `pnpm verify:tauri` pattern with a scratch `REFRACT_DATA_DIR` and own debug port; assert computed `font-family`/`font-weight` for body, button, `strong`, `code`, composer and its mirror; ligature toggle live and persisted; screenshot all five themes.
- Contrast: `scripts/check-theme-contrast.mjs`, then eyeball muted text and 13px chips.

## Risks

- Tailwind v4 `@theme` weight override not applying: caught by computed-style check; fallback is `@theme inline` or an explicit `@utility` set.
- A woff2 without `liga`: caught by the GSUB check; fallback is the TTF converted with fonttools without subsetting.
- `font-code` on the composer shifts glyph widths: mirrors share the class, so alignment holds; checked with ghost text, chips and the command pill in the live check.
