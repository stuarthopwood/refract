# Tasks: 8px spacing grid with a 4px half-step

Spec: `spec.md`. Plan: `plan.md`. Order matters: T1-T3 first, areas next, flip the gate last. No new tests (prototyping phase). Commit and push after every task.

- [ ] **T1** `scripts/check-spacing.mjs` + `scripts/spacing-allowlist.json` + `package.json` `check:spacing` + a `check:spacing` step in `.github/workflows/ci.yml` (so `ci:local` runs it). Report-only first (prints the count, exits 0). Covers FR-005.
- [ ] **T2** Primitives: `src/renderer/components/ui/button.tsx` sizes (`sm` `h-6`, `icon-sm` `size-6`, glyphs `size-4`), then every other file in `components/ui/` for spacing and icon boxes. Update existing tests that assert old classes. FR-001, 002, 004.
- [ ] **T3** Docs: rewrite "Spacing grid" and "Control heights" in `docs/design/foundations-typography-spacing.md`, Sizes in `docs/design/components.md` (lines 42-48, 58), accessibility target notes if they cite 28px. FR-006.
- [ ] **T4** Sidebar and session list (`features/sidebar`, session list, manage sessions): spacing, icon boxes, fixed row-height constants. [P]
- [ ] **T5** Chat transcript (`features/chat`, message rows, tool rows, advisories): keep 24px turn / 4px bookkeeping rhythm. [P]
- [ ] **T6** Composer: spacing and icons; keep overlay mirror `box-shadow` technique (FR-007). [P]
- [ ] **T7** Settings screens. [P]
- [ ] **T8** Right pane (git changes, file explorer, side chat, PR views). [P]
- [ ] **T9** Dialogs and every remaining file under `src/renderer` (`components/`, `lib` class strings, CSS).
- [ ] **T10** Flip `check:spacing` to failing; clear or allowlist (with a reason) the remainder; `CONTEXT.md` and `docs/PLAN.md` row to done. FR-001, 006.
- [ ] **T11** Gate: `pnpm ci:local`; live check on a debug build, screenshots of sidebar, chat, composer, settings, right pane, a dialog in every theme, 320px width, 400% zoom. FR-008, 009.
- [ ] **T12** Open the ready PR (`feat(ui): move the app to an 8px spacing grid`, body `Closes #1252`), run the five-reviewer gate, fix findings, file one follow-up issue for Mediums and Lows.

[P] tasks touch disjoint folders and can be done in any order after T3; a shared component found inside an area is fixed in T2's folder, not copied.
