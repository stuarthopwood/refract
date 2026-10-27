# Implementation Plan: 8px spacing grid with a 4px half-step

**Spec**: `specs/027-8px-spacing-grid/spec.md` | **Issue**: #1252 | **Depends on**: #1246 (Geist fonts, PR #1266) merged first, because it touches the same renderer files app-wide.

## Approach

Renderer-only change (Tailwind class edits and one Node check script). No Rust, IPC or data changes. Commits go primitives first so the rest inherits them; the gate script lands early in report-only mode and is flipped to failing once the last area is clean.

## Technical context

- Stack: React, Tailwind v4 utilities, `cva` in `src/renderer/components/ui/*`.
- Baseline scan (issue, origin/main): off-scale 6px x125, 2px x66, 10px x36, 12px x88 (half legitimate by context), 20px x9, plus arbitrary values; icon sizes `size-3`, `size-3.5`, `size-5` across about 99 files.
- Mapping rule (FR-003) is per call site by context; mechanical codemod only for unambiguous cases (`gap-1.5` to `gap-2`, `px-2.5` to `px-2`), the rest by hand per area.
- Existing gate pattern: `scripts/check-*.mjs` run through `package.json` `check:*` and `scripts/ci-local` (the list of `run:` steps mirrors `.github/workflows/ci.yml`; add `check:spacing` to both).

## Design

1. **Gate** `scripts/check-spacing.mjs`: scan `src/renderer/**/*.{ts,tsx,css}`; tokenise class-like strings; fail on `-?(p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me|gap|gap-x|gap-y|space-x|space-y)-<n>` where `<n>` not in {0, px?, 1, 2, 4, 6, 8, 10, 12} (half steps 0.5, 1.5, 2.5, 3, 3.5, 5, 7, 9, 11 fail) and on arbitrary `[Npx]`/`[Nrem]` values in those utilities when not a multiple of 4px on the allowed list. Variant prefixes (`md:`, `has-data-[...]:`, `hover:`) and `!` are stripped. Allowlist `scripts/spacing-allowlist.json`: `[{file, text, reason}]`, a stale entry fails the check (the same shape as `check:file-size`'s baseline).
2. **Primitives** (`components/ui/*`): `button.tsx` sizes per FR-002; remaining primitives (input, select, dialog, tabs, badge, card, menus, tooltip) normalised in place.
3. **Areas**, one commit each: sidebar and session list; chat transcript; composer (overlay mirror untouched); settings; right pane; dialogs and the remaining features.
4. **Icon boxes**: `size-3`, `size-3.5`, `size-5` on icons to nearest step, per area, in the same commit as the area's spacing.
5. **Row heights**: grep for fixed `h-7`/`28` row assumptions in virtualised lists (sidebar session list, transcript, file explorer) and adjust estimate constants.
6. **Docs**: rewrite the "Spacing grid" and "Control heights" sections of `foundations-typography-spacing.md`, the Sizes table of `components.md` (and its 28px mentions), `docs/PLAN.md` row, and `CONTEXT.md`.

## Constitution and rule checks

- ADR 0003 (reusable components): fix in shared components first; no hand-styled copies.
- 600-line cap: class edits only, line counts unchanged; `check:file-size` in the gate.
- No new tests while prototyping: the script has no test file. Existing `renderer` tests asserting old classes (for example `h-7`) are updated, not removed.
- Tauri security baseline: untouched.

## Verification

`pnpm ci:local`; live check on a debug build with a scratch data dir and the fake `omp`; screenshots of sidebar, chat, composer, settings, right pane and a dialog in every theme; 320px pane width and 400% zoom spot checks.

## Risks

- Large merge conflicts with #1246 and other lanes: mitigated by starting implement only after #1246 merges and by committing per area.
- Row-height assumptions in virtualised lists (flagged [INFERENCE] in the issue): checked in step 5.
- Visual regressions from blind rounding: the live screenshot pass is the check.
