# Feature Specification: Settings (wave 2)

**Feature Branch**: `wave2-settings`
**Status**: Draft
**Input**: One PR for the wave 2 "Settings" bundle in `docs/PLAN.md`: #714 (with its 2026-10-26 Advanced amendment), #717, #1070, #1141, #450 and #842. Decisions: the 2026-10-29 wave 2 Settings grill (a comment on each issue; glossary terms Settings page, Settings group, Advanced, Role colour and Text size in `CONTEXT.md`). Numbered 036: 035 went to the right pane lane (merged first). Sibling wave 2 lanes (Session list; Right pane and Explorer) run in parallel, so this spec stays inside Settings files and touches shared components additively only.

## Clarifications

### Session 2026-10-29 (wave 2 grill, Stuart)

- Nav is one flat list of task-based sections: Appearance, Chat, Status line, Models, Advanced (renamed from OMP), Sessions, Panels. Only rows that exist today are placed; no empty sections (#714).
- New shared `SettingsPage`, `SettingsGroup` and `SettingRow` replace the hand-copied row layouts (including `SettingFieldRow` and `SettingSwitchRow`). Width cap `max-w-2xl` for toggle pages and `max-w-3xl` for Models, left-aligned next to the nav; rows stack the control under the label below 480 px (#714).
- Models, current model (#714 part 3): each role shows its current model as text with provider and thinking level at rest; the dropdown stays as "Change". An inherited role shows its resolved model only for links a probe of the supported OMP confirms; every other unset role says "OMP picks one automatically". The probe runs first and its result is recorded on #714 before any inheritance text ships.
- Role colours (#714 part 4): option A. Only the four switcher roles (default, smol, slow, plan) get a `--role-*` token, each at 3:1 on every preset; all other roles stay neutral. Role colours are not severity or session-state colours, and always sit beside the role name and the role icon. `docs/design/foundations-icons.md` is amended to add "role identity".
- The Advanced rework in #714's 2026-10-26 amendment is in scope: one page, seven groups, hand-written descriptions beside the key in `TOKEN_GUARD_KEYS`, radio groups for enums, a reorderable checklist for compaction method order, a per-model table, number fields with units, dependent rows disabled while the parent is off, advisor model moves to Models > Advisor, and the KB unit bug is fixed.
- Icons (#717): `SettingRow` takes an `icon` prop; one shared readout-kind-to-icon map (also used by `ReadoutChips`) and one role-icon map; the issue's starting mapping stands; `foundations-icons.md` gets the Settings line.
- Theme picker (#1070): a shared `ThemeSwatchChip` used by `ProfileMenu` and `ThemePicker`; leading ring-and-dot radio via `RADIO_RING_CLASS` / `RADIO_DOT_CLASS`; no trailing "Current"; keyboard model and Save/Cancel unchanged.
- Widget role (#1141): `widget` joins Chat roles after Smol and Tiny, label "Widget", description "Designs background job charts; uses Smol until set."; the TypeScript list (`src/shared/model.ts`) and the Rust list (`src-tauri/src/ipc/model_roles.rs`) change together.
- Brand mark (#450): icon (decorative) and wordmark text in the Settings header; the Session list does not stay visible.
- Text size (#842): App, Chat and Code scales, 80 to 150 percent, step 5, default 100; presets Small 90, Default 100, Large 115, Larger 130; slider plus number field; a "Text size" group in Appearance; text only, through redeclared `--text-*` variables in role containers; smallest text clamped at 11 px; arbitrary `text-[...]` sizes become tokens; persisted `typography` setting with a setter and the theme bootstrap carrying the scales; Rust code goes in new small sibling files because `store/settings.rs` and `ipc/settings.rs` are at the 600-line cap.

### Session 2026-10-29 (pickup, assumptions recorded without a question)

- Q: Where does the Rust role list live? -> A: `src-tauri/src/ipc/model_roles.rs` (the issue's `omp/model_roles.rs` path is stale); the TypeScript side is `src/shared/model.ts` (`ModelRoleId`, `CHAT_MODEL_ROLES`, `ROLE_CATALOG_KIND`).
- Q: Which section ids does the nav use? -> A: `appearance`, `chat`, `status-line`, `models`, `advanced`, `sessions`, `panels`; `SettingsSectionId` in `view-store.ts` is renamed to match (`session-readout` to `status-line`, `model-roles` to `models`, `omp` to `advanced`, `right-pane` to `panels`). A persisted old id falls back to `appearance`.
- Q: Probe outcome unknown at spec time. -> A: Until the probe confirms a link, every unset role except `widget` (documented to resolve like Smol, and shown as "Uses Smol" by the existing fallback label) shows "OMP picks one automatically". The probe is task T6 and its result is written on #714; only confirmed links are added to the displayed set.
- Q: Preset and slider interaction. -> A: A preset sets all three scales; moving any slider makes the preset row show none selected; "Reset" per role and "Reset all" return to 100.
- Q: Clamp rule. -> A: Each `--text-*` variable is `max(11px, calc(base * scale))`, so only the smallest tokens are affected in practice.
- Q: Which `--role-*` hues? -> A: Four categorical hues chosen from outside the severity, session-state, agent-message and project colour sets, tuned per preset so each is 3:1 against its surface; `check:theme-contrast` gets the pairs.
- Q: Does the Advanced per-model table need a model catalog? -> A: It uses the existing chat model catalog and picker; values stay in Refract's launch overlay string form (`model=tokens, ...`) so `src-tauri/src/omp/token_guard/values.rs` changes only for the advisor key move and unit label.
- Q: Does the advisor row keep writing OMP's global config? -> A: No. Models > Advisor reads and writes the token guard store value `modelRoles.advisor` and says it applies to new Sessions.
- Clarify pass: no further ambiguity that changes the implementation.

## User Scenarios and Testing

### User Story 1 - A calm, grouped Settings screen (P1)

1. **Given** Settings is open, **Then** the nav lists Appearance, Chat, Status line, Models, Advanced, Sessions and Panels, each with a leading icon, and every existing setting is reachable once.
2. **Given** a 1920 or 2560 px window, **Then** no switch or picker sits more than about one reading column from its label.
3. **Given** a window under 480 px or 200 percent zoom, **Then** controls stack under their labels with no horizontal scroll.
4. **Given** Settings is open, **Then** the Refract icon and wordmark show in the header beside the back button.

### User Story 2 - Models show what is selected (P1)

1. **Given** any role row, **Then** the current model's name, provider and thinking level are visible as text without opening the dropdown.
2. **Given** an unset role with a probe-confirmed link, **Then** the row reads "Inherited from <role>: <model>"; otherwise "OMP picks one automatically".
3. **Given** the Chat roles group, **Then** Widget follows Smol and Tiny and saves to OMP's `widget` role.
4. **Given** default, smol, slow or plan, **Then** the row carries a role colour swatch, the role icon and the name; no other role has a colour.

### User Story 3 - Advanced is organised (P1)

1. **Given** Advanced, **Then** rows sit in seven labelled groups, each with a plain-English description and an appropriate control.
2. **Given** Compact when idle is off, **Then** the two idle rows stay visible, indented and disabled with a stated reason.
3. **Given** the spill threshold row, **Then** its unit reads KB.

### User Story 4 - Matching theme rows (P2)

1. **Given** Appearance, **Then** each theme row shows a leading radio ring, the name and the two-colour chip, with no "Current" text, matching Profile > Theme.

### User Story 5 - Text size (P2)

1. **Given** Appearance > Text size, **When** the App, Chat or Code slider or number field changes, **Then** exactly that role's text rescales live, layout, spacing and icons stay put, and the value persists across restart with no flash at first paint.
2. **Given** a preset is chosen, **Then** all three scales change together; Reset and Reset all return to 100.

## Requirements

- **FR-001** `SettingsPage`, `SettingsGroup` and `SettingRow` exist as shared components; every Settings section is built from them; `SettingFieldRow` and `SettingSwitchRow` are absorbed or re-exported, with no second row layout left in Settings.
- **FR-002** `SettingsPage` caps its column at `max-w-2xl` (`max-w-3xl` for Models), left-aligned; rows stack below 480 px; groups are `role="group"` labelled by their heading; focus lands on the page heading on a section change.
- **FR-003** The nav is the flat list in the Clarifications, with a leading icon per item from the shared map, `aria-current` on the active item, and the section ids renamed per the assumption above.
- **FR-004** The Settings header shows the brand mark (decorative icon plus wordmark text) beside the back button; the back button keeps its `aria-label` and focus order.
- **FR-005** `SettingRow` takes an optional `icon` (16 px, muted, `aria-hidden`, fixed slot so labels align). One readout-kind-to-icon map is imported by `ReadoutChips` and the Status line section; one role-icon map is imported by Models. No icon where no distinct glyph exists. `foundations-icons.md` gains the Settings line and the "role identity" amendment.
- **FR-006** Each role row shows the catalog-resolved model name, provider and thinking level as text (suffix stripped before lookup; unknown values show the raw selector with a note; comma lists show the first entry and "then N more"; no clipped names).
- **FR-007** Inherited-role text is shown only for links the probe confirms; otherwise "OMP picks one automatically". The probe result is recorded on #714.
- **FR-008** `--role-default`, `--role-smol`, `--role-slow` and `--role-plan` exist in every preset at 3:1 on the surfaces they sit on, are covered by `check:theme-contrast`, and are applied only as a swatch with the name and icon beside it.
- **FR-009** `widget` is added to `ModelRoleId`, `CHAT_MODEL_ROLES`, `ROLE_CATALOG_KIND` (chat), the role descriptors, the role-icon map and the Rust role list in one change.
- **FR-010** Advanced shows the seven groups of #714's amendment; `TOKEN_GUARD_KEYS` carries a group and a hand-written description per key; the page intro states once that values apply to new Sessions; a row shows "Default: X" and Reset only when the value differs from the default; format hints appear in the validation error.
- **FR-011** Controls: radio groups (system prompt images None / AGENTS.md only / All; advisor review mode Every turn / Agent end); a reorderable checklist for compaction method order (checkbox plus move up/down buttons, no drag-only path, new position announced); a per-model threshold table (picker, token count, remove, Add model); number fields with unit suffix and thousands separators; dependent idle rows disabled with `aria-disabled`.
- **FR-012** The advisor model is read and written through the token guard store from Models > Advisor, and the Advanced row is removed; `tools.artifactSpillThreshold` is labelled in KB.
- **FR-013** `ThemeSwatchChip` is one shared component used by `ProfileMenu` and `ThemePicker`; the picker row uses `RADIO_RING_CLASS` / `RADIO_DOT_CLASS`, shows no "Current", and keeps its roving-tabindex keyboard model and Save/Cancel flow; the dot is visibly painted (non-zero rect).
- **FR-014** A `typography` setting `{ appScale, chatScale, codeScale }` (each 0.8 to 1.5, default 1, step 0.05) persists through `settings.setTypography`, broadcasts `settings:changed`, and is carried by the synchronous theme bootstrap so first paint is already scaled.
- **FR-015** `--text-*` variables are scaled by `--scale-app` at `:root` and redeclared with `--scale-chat` and `--scale-code` inside the transcript, code block, tool output, diff, inline code and composer containers; each result is clamped to at least 11 px; spacing, icons and control heights do not scale.
- **FR-016** Appearance has a "Text size" group: three slider plus number field rows (with `aria-valuetext` such as "110 percent, about 15 px", Home and End keys, a live preview line), presets Small 90, Default 100, Large 115, Larger 130, per-role Reset and Reset all; changes apply live and are announced politely once; the help text notes that WebView2 does not read Windows text scaling.
- **FR-017** No arbitrary `text-[...]` size remains in `src/renderer` except an intentional, commented exception; they become `text-*` tokens.
- **FR-018** Rust code for the new setting and bootstrap goes in new small sibling files; no file grows past its `scripts/file-size-baseline.json` entry or the 600-line cap; no new tests are added.

## Out of Scope

Font families, bundling and the ligature switch (#4, #839); icon scaling; the role switcher itself (#766); Settings search; settings not yet built (#554 and the others listed in #714); a repository-override view of roles; `ChatWidthPicker` restyling (#1070 leaves it out); the Session list and Right pane lanes.

## Success Criteria

- `pnpm ci:local` passes; CDP screenshots on a scratch instance of every Settings page on Dark and High contrast at 1280, 1920 and 2560 px; text scale walk at 80 and 150 percent shows no clipped text or horizontal overflow; the 40 px Chrome band and rail geometry are unchanged; a save, an inherited role, an alias value and a Widget save are exercised live.
