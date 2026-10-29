# Tasks: Settings (wave 2)

Spec: `spec.md`. Plan: `plan.md`. No new tests (prototyping phase); existing tests that assert changed ids, labels or classes are updated, never deleted. Commit and push after every task. Work packages (WP) are independent units for parallel workers; the dependency line says what must land first. Every worker reports changed files so the director commits them straight away. Safe deletion: literal absolute paths only, nothing deleted inside the repo except named scratch files.

## Dependency graph

```
WP-A (frame, nav, brand, icon maps, docs)  --->  WP-B (Models)
                                            \->  WP-C (Advanced)
                                            \->  WP-D (Appearance, Text size UI)
WP-E (Rust text-size setting, bootstrap)  ---------> WP-D T15 (wire the store; renderer degrades to 100 without it)
WP-B T5 (widget lists) and T6 (probe), and all of WP-E, have no dependency on WP-A and may start at once.
```

- WP-A first (about one worker). WP-B, WP-C and WP-D start after WP-A merges into the branch, run in parallel and touch disjoint files. WP-E is independent and can start immediately. WP-B T6 (probe) can start immediately and feeds T7.
- Shared-file regions: `globals.css` (WP-B role tokens, WP-D text variables), `src/shared/themes.ts` (WP-B only), `src/shared/ipc.ts` (WP-E only), `view-store.ts` (WP-A only), `ProfileMenu.tsx` (WP-A section ids, WP-D ThemeSwatchChip, separate lines).

## WP-A: Shared Settings frame (FR-001 to FR-005)

- [ ] **T1** Create `SettingsPage`, `SettingsGroup`, `SettingRow` (with `icon` prop, 480 px stack, `aria-describedby`, `--divider` rows, width caps `max-w-2xl` / `max-w-3xl`). Absorb `SettingFieldRow` and `SettingSwitchRow`.
  Files: `src/renderer/components/settings/SettingsPage.tsx`, `SettingsGroup.tsx`, `SettingRow.tsx` (new); `src/renderer/components/SettingFieldRow.tsx`, `src/renderer/components/SettingSwitchRow.tsx` (wrap or remove, update imports).
- [ ] **T2** Icon maps: shared readout-kind-to-icon map imported by `ReadoutChips`; role-icon map; nav icon map.
  Files: `src/renderer/components/icons/readout-icons.ts`, `src/renderer/components/icons/role-icons.ts` (new); `src/renderer/features/chat/readout/ReadoutChips.tsx`.
- [ ] **T3** Rebuild the nav and header: flat list Appearance, Chat, Status line, Models, Advanced, Sessions, Panels with leading icons; rename section ids; brand mark (decorative icon plus wordmark text) beside the back button; port the five hand-copied layouts to the shared components with no behaviour change (Status line = old Session readout, Panels = old Right pane, Sessions, Chat), and give Models and Advanced a `SettingsPage` wrapper only.
  Files: `src/renderer/features/settings/SettingsScreen.tsx`, `ChatDisplaySection.tsx`, `RightPaneSection.tsx`, `SessionsSection.tsx`, `SettingsNav.tsx` and `SettingsBrand.tsx` (new, to keep `SettingsScreen` small); the Session readout switches move to a new `StatusLineSection.tsx` (extracted from `SettingsScreen.tsx`); `src/renderer/state/view-store.ts`; section-id callers `src/renderer/App.tsx`, `features/chat/MessageInput.tsx`, `features/profile/ProfileItem.tsx`, `features/profile/ProfileMenu.tsx` (ids only); `ModelRolesSection.tsx` and `OmpSection.tsx` (wrapper only, via `SettingsPage`).
- [ ] **T4** Docs: `docs/design/foundations-icons.md` (Settings line, "role identity" amendment to the colour-is-meaning sentence), `docs/design/components.md` (SettingsPage, SettingsGroup, SettingRow, ThemeSwatchChip), `docs/PLAN.md` row status, `CONTEXT.md` if terms drift.
  Depends on: T1 to T3 for wording; may be done last in the package.

## WP-B: Models (FR-006 to FR-009)

Depends on WP-A (T1, T2) except T5 (widget lists) and T6 (probe).

- [ ] **T5** `widget` role in both lists: `src/shared/model.ts` (`ModelRoleId`, `CHAT_MODEL_ROLES` after smol and tiny, `ROLE_CATALOG_KIND` = chat), `src-tauri/src/ipc/model_roles.rs`, `src/renderer/features/settings/ModelRolesSection.tsx` (descriptor "Widget", "Designs background job charts; uses Smol until set."), `role-icons.ts` entry. Independent of WP-A except the icon entry (add after T2).
- [ ] **T6** Probe OMP 18.10.1 (supported version): for each unset role run `omp config get`, `omp models` and the RPC `get_state` on a scratch profile; compare to the documented chain (`smol` and `slow` inherit `default`, `tiny` through `@smol`, `memory` through `@tiny`, `widget` like `smol`, advisor `slow` or its own chain). Record the table on #714 with `gh issue comment`; write confirmed links to `roleInheritance.ts`. No source change besides that file. No scratch directory is deleted inside the repo.
- [ ] **T7** Current model as text (uses T6's table): `modelRoleCurrent.ts` (suffix stripped, alias and comma-list handling, unknown value note, thinking level label), `RoleCurrentModel.tsx`, wire into the role row; dropdown relabelled "Change"; replace `ROLE_FALLBACK_LABEL` with probe-confirmed text, else "OMP picks one automatically"; no clipped names (wrap or tooltip).
  Files: `src/renderer/features/settings/ModelRolesSection.tsx`, `modelRoleSuffix.ts`, `RoleReasoningRadios.tsx` (only if the current value shares it), new `modelRoleCurrent.ts`, `RoleCurrentModel.tsx`, `roleInheritance.ts`. Keep every file at or under 600 lines.
- [ ] **T8** Role colours: `--role-default|smol|slow|plan` per theme in `src/shared/themes.ts` and the `globals.css` theme block; `RoleSwatch.tsx` (aria-hidden swatch beside name and icon); the four rows only; pairs added to `scripts/theme-contrast-pairs.mjs`; `check:theme-contrast` clean.
  Files: `src/shared/themes.ts`, `src/renderer/styles/globals.css` (role-token block only), `scripts/theme-contrast-pairs.mjs`, `src/renderer/features/settings/RoleSwatch.tsx`, `ModelRolesSection.tsx`; doc `docs/design/foundations-tokens-theming.md` ("Role colours" paragraph).
- [ ] **T9** Models > Advisor reads and writes the token guard value `modelRoles.advisor` and says it applies to new Sessions. Coordinate with WP-C T12 (the Advanced row removal); WP-B owns the Models side.
  Files: `ModelRolesSection.tsx` (or the new advisor row file `AdvisorModelRow.tsx`), `src/renderer/state/settings-store.ts` only if a token guard accessor is missing.

## WP-C: Advanced (FR-010 to FR-012)

Depends on WP-A (T1, T3 for `SettingsPage`). Independent of WP-B except T12's removal of the advisor row, which must land with WP-B T9.

- [ ] **T10** `TOKEN_GUARD_KEYS` gets `group` and `description` for every key (the grilled 16 descriptions from #714, plus Advisor model removed and unit KB for `tools.artifactSpillThreshold`); a `unit` and `kind` extension for number, enum, order list and per-model record.
  Files: `src/shared/tokenGuard.ts`; `src-tauri/src/omp/token_guard/values.rs` only for the advisor key move and unit label if needed (no behaviour change to the overlay string forms).
- [ ] **T11** Controls: `NumberUnitField.tsx`, `RadioSettingRow.tsx` (fieldset/legend), `MethodOrderChecklist.tsx` (five methods Remote, Snapcompact, Handoff, Soft, Shake; checkbox plus move up/down, announces position), `PerModelThresholdTable.tsx` (picker, token count, remove, Add model), dependent-row support (indented, `aria-disabled`, reason text); validation error carries the format hint.
  Files: new files under `src/renderer/features/settings/advanced/`.
- [ ] **T12** `AdvancedSection.tsx` replaces `OmpSection.tsx` and `OmpValueRow.tsx` (uses T10 and T11): page intro once, seven `SettingsGroup`s (Context compaction, Idle compaction, Image compression, Subagents, Advisor, Tool output, Learning), "Default: X" plus Reset only when changed, advisor model row removed (lands with WP-B T9).
  Files: `src/renderer/features/settings/AdvancedSection.tsx` (new), `OmpSection.tsx`, `OmpValueRow.tsx` (delete after migration, literal paths), `SettingsScreen.tsx` import line only.

## WP-D: Appearance (FR-013, FR-015 to FR-017)

Depends on WP-A (T1). T15 depends on WP-E for persistence and degrades to defaults without it.

- [ ] **T13** `ThemeSwatchChip` shared component (20 by 12 px, gradient of `swatch` and `swatchPrimary`, `aria-hidden`, forced-colors border) used by `ProfileMenu` and `ThemePicker`; the picker row gets the leading `RADIO_RING_CLASS` / `RADIO_DOT_CLASS` indicator and loses "Current"; roving tabindex and Save/Cancel unchanged; dot visibly painted.
  Files: `src/renderer/components/ui/theme-swatch-chip.tsx` (new), `src/renderer/features/settings/ThemePicker.tsx`, `src/renderer/features/profile/ProfileMenu.tsx` (chip markup only), `src/renderer/components/ui/radio-group.tsx` (read only; no edit unless the class constants need export).
- [ ] **T14** Text variables in CSS: `:root` redeclares `--text-xs` through `--text-xl` as `max(11px, calc(base * var(--scale-app)))`, with `--scale-app|chat|code` defaulting to 1; the same variables redeclared in the transcript, code block, tool output, diff, inline code and composer containers using the chat or code scale; line heights stay unitless; arbitrary `text-[...]` become tokens (`--text-readout` and new named tokens as needed).
  Files: `src/renderer/styles/globals.css` (text block only), `src/renderer/components/ui/button.tsx`, `toggle.tsx`, `src/renderer/features/chat/QueuedChipList.tsx`, `RequestCard.tsx`, `SessionStartNotice.tsx`, `src/renderer/features/chat/readout/TodoTree.tsx`, the container roots (`MessageList` and the message, code block, diff and `MessageInput.tsx` wrapper classes), `docs/design/foundations-typography-spacing.md`.
- [ ] **T15** Text size UI and store (uses T14; persistence from T16 to T18): `TextSizeGroup.tsx` (presets Small 90, Default 100, Large 115, Larger 130; three `ScaleControl` rows with slider, number field, `aria-valuetext`, preview line; per-role Reset and Reset all; polite announcement; WebView2 help text), `typography-store.ts` (applies the three CSS variables, reads `settings.typography` with a default of 1, calls `settings.setTypography` when present); `main.tsx` applies the bootstrap scales on first paint.
  Files: `src/renderer/features/settings/TextSizeGroup.tsx`, `ScaleControl.tsx` (new), `src/renderer/state/typography-store.ts` (new), `src/renderer/features/settings/AppearanceSection.tsx`, `src/renderer/main.tsx`, `src/renderer/state/settings-store.ts` (additive).

## WP-E: Rust text-size setting and bootstrap (FR-014, FR-018)

Independent. Touches no renderer styling.

- [ ] **T16** `typography` in the settings store: `src-tauri/src/store/typography.rs` (parse with clamp 0.8 to 1.5 and step snap, KEY, default 1), one-line hooks in `src-tauri/src/store/settings.rs` (module, struct field, parse, serialize, setter delegating to the sibling); setter `set_typography` in the sibling file so `settings.rs` stays under 600 lines.
- [ ] **T17** IPC (after T16): `src-tauri/src/ipc/settings_typography.rs` (`settings.setTypography`, validate three numbers, broadcast `settings:changed`), register in `src-tauri/src/ipc/mod.rs`; shared types `Typography` and `Settings.typography` in `src/shared/ipc.ts` (stay within the 898-line baseline) and `setTypography` in `src/tauri-bridge/index.ts`.
- [ ] **T18** Bootstrap (after T16, T17): carry `typography` in the init script object in `src-tauri/src/lib.rs` (the `__REFRACT_THEME_BOOTSTRAP__` payload) and `themeBootstrap()` in `src/tauri-bridge/index.ts` / `src/shared/ipc.ts`; `src-tauri/src/ipc/theme.rs` only if it builds the payload. `cargo fmt`, `cargo clippy -- -D warnings` clean; existing Rust tests keep passing.

## Integration and gate

- [ ] **T19** Director: merge WP results, grep for stale section ids (`session-readout`, `model-roles`, `right-pane`, `'omp'`), `rg "text-\["` shows no arbitrary size, `pnpm typecheck`, `pnpm check:ui-text`, `check:file-size`, `check:theme-contrast`, `check:parity`.
- [ ] **T20** Quality gate: five-reviewer gate (`test-reviewer` limited to "existing tests still pass"; no new tests asked for); fix findings.
- [ ] **T21** Build slot: merge `origin/main`, `pnpm ci:local`, live check on a scratch instance (own remote-debugging port, scratch `REFRACT_DATA_DIR`) with CDP screenshots of every Settings page on Dark and High contrast at 1280, 1920 and 2560 px, text scale walk at 80 and 150 percent, a Widget save, an inherited role, an alias value and a theme preview with the dot rect measured.
- [ ] **T22** Open the ready PR (`feat(settings): settings wave 2`), body `Closes #714, #717, #1070, #1141, #450, #842` for each issue fully done; update the `docs/PLAN.md` row; reap worktrees after merge.
