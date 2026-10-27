# Tasks: Geist and Geist Mono defaults with a lighter weight scale

**Input**: `specs/027-geist-font-weights/` (spec.md, plan.md). No new tests (prototyping phase).

## Phase 1: Fonts and tokens (US1, US2)

- [ ] T001 [US2] Add `src/renderer/assets/fonts/GeistMono-Variable.woff2` from the official `geist` npm package; update `OFL.txt` if needed; verify `liga` in GSUB with fonttools in a scratch dir.
- [ ] T002 [US1] `globals.css`: Geist Mono `@font-face`; `--font-ui` and `--font-code` stacks; `--font-weight-*` tokens in `@theme`; body weight; `b, strong` semibold; update brand-only comments.
- [ ] T003 [US1] `diff-view.css:50` and `:56`: literal 400 becomes `var(--font-weight-normal)`.
- [ ] T004 [US2] Composer: `font-code` on the `Textarea` in `MessageInput.tsx` and on `COMPOSER_MIRROR_CLASS` in `CommandPillOverlay.tsx`.

## Phase 2: Ligatures switch (US3)

- [ ] T005 Rust: `store/code_ligatures.rs`, `store/settings.rs` wiring, `ipc/settings_code_ligatures.rs`, `ipc/mod.rs` registration.
- [ ] T006 Shared and renderer: `ipc.ts`, `model.ts`, `tauri-bridge/index.ts`, `settings-store.ts`, root-attribute effect, `ChatDisplaySection.tsx` switch row, CSS rule for `data-code-ligatures="off"`.

## Phase 3: Docs and gate

- [ ] T007 Docs: `docs/DESIGN.md`, `docs/design/foundations-typography-spacing.md`, `docs/PLAN.md` row.
- [ ] T008 `pnpm typecheck`, `pnpm test`, `check:file-size`, `scripts/check-theme-contrast.mjs` (renderer-only checks, no cargo).
- [ ] T009 Build slot: `pnpm ci:local` with the cargo env, then the live check and five-theme screenshots.
