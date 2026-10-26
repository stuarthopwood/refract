# Tasks: Lighter font weights and sentence-case action verbs

**Input**: Design documents from `specs/022-font-weights-verbs/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [quickstart.md](./quickstart.md)
**Tests**: No new tests (prototyping rule, 2026-10-08). No existing vitest test asserts a font class or tool label, so none needs an expectation change ([research.md](./research.md) Decision 5). Verification is the existing gates plus a live check.

**Format**: `[ID] [P?] [Story] Description`. `[P]` means the task can run in parallel with other `[P]` tasks in the same phase (different files). Line numbers are against `origin/main` at `4c973d43` (2026-10-26); re-grep each before editing and fix drifted references in place. Every weight target comes from the research inventory; do not re-decide it.

**Rules for every phase**: edit only the files the phase owns; do not grow any file over 600 lines or any baselined file in `scripts/file-size-baseline.json`; reusable components first (`docs/design/components.md`); no new tests; commit and push after the phase.

## Phase A: verb map and the shared row label (US1, US2)

**Owns**: `src/renderer/features/chat/toolVerbs.ts` (new), `CollapsedLine.tsx`, `ToolRow.tsx`, `ThoughtRunRow.tsx`, `SkillPromptRow.tsx`, `RequestCard.tsx`, `Transcript.tsx` (all under `src/renderer/features/chat/`).

- [X] T001 [US2] Create `src/renderer/features/chat/toolVerbs.ts` per research Decision 2 and plan Design 1: frozen `TOOL_VERBS` (read, edit, write, bash, grep, find, thinking, skill), `toolVerb(tool, phase)` with `Object.hasOwn` lookup, `sentenceCaseToolName(tool)` (empty result returns "Tool"), and `toolAriaPrefix(status)` (status word for `error`, `interrupted`, `cancelled`, `exited`; otherwise `undefined`), reusing `toolStatusLabel` from `toolStatus.tsx`. About 40 lines.
- [X] T002 [US1] `CollapsedLine.tsx:163`: drop `font-medium` from the label span and add `data-slot="collapsed-line-label"`; update the doc comment at `:43` to say regular weight. Callers' `labelClassName` colours stay.
- [X] T003 [US2] `ToolRow.tsx` (599 lines, HIGH cap risk: at most one net new line, the import). `:210` label becomes `toolVerb(item.tool, phase)`; `:343` `toolLabel` uses `toolVerb('skill', phase)` (no colon) and the verb for the solo or group tool; `:348` grouped label becomes `${verb} ×N` (FR-013); aria names at `:198-201` and `:393-404` become prefix (from `toolAriaPrefix`), verb and summary joined by spaces, keeping command-style rows (bash, grep) with no visible label (FR-006). `:590` is a subagent name, not a tool id: leave it. If the file would exceed 600, first move `SubagentRow` (`:575-599`) unchanged into `SubagentRow.tsx` and add that file to this phase.
- [X] T004 [US1] `ToolRow.tsx:536` and `:543`: muted section labels "Prompt" and "Result" drop `font-medium` (400). Same file as T003; do together.
- [X] T005 [US2] `ThoughtRunRow.tsx`: run header accessible name at `:210` and label at `:216` read "Thinking" while live and "Thought process" when done, from `toolVerb('thinking', …)`; `thoughtLabel` at `:37` takes "Thinking" from the map and keeps "Thought for Ns" and "Thought" (FR-014).
- [X] T006 [P] [US2] `SkillPromptRow.tsx:28`: "Skill invoked:" becomes "Skill invoked" (FR-005).
- [X] T007 [US2] `RequestCard.tsx:293`: "Asked user:" becomes "Asked user" (FR-005). Keep the raw tool id at `:407` ("Allow tool: …"; FR-015).
- [X] T008 [US3] `RequestCard.tsx`: `:328`, `:334`, `:555` drop `font-medium` (400); `:311` stays 500. Same file as T007.
- [X] T009 [US2] `Transcript.tsx:870` (baselined at 1059: no growth): the live announcement `${toolStatusLabel('running')} ${row.tool}` becomes `toolVerb(row.tool, 'running')` (FR-015). Remove the `toolStatusLabel` import only if it becomes unused.

**Checkpoint**: `pnpm typecheck`, `pnpm check:file-size`; `ToolRow.tsx` at or under 600.

## Phase B: shared components (US3)

**Owns**: `src/renderer/components/ui/{badge,button,context-menu,dropdown-menu,kbd,message,sidebar}.tsx`, `src/renderer/components/SettingFieldRow.tsx`. Independent of Phase A.

- [X] T010 [P] [US3] `components/ui/badge.tsx:7`: base `font-medium` becomes `font-normal`.
- [X] T011 [P] [US3] `components/ui/button.tsx`: base `:7` stays 500; add `font-normal` to the `ghost` variant (`:29-30`) and the `link` variant (`:33`).
- [X] T012 [P] [US3] `components/ui/context-menu.tsx:207` and `dropdown-menu.tsx:211`: menu labels drop `font-medium` (400).
- [X] T013 [P] [US3] `components/ui/kbd.tsx:8`, `message.tsx:63`, `message.tsx:76`: drop `font-medium` (400).
- [X] T014 [P] [US3] `components/ui/sidebar.tsx:404` (group label) and `:575` (menu badge): drop `font-medium` (400); `:469` (`data-active` state) stays 500.
- [X] T015 [P] [US3] `components/SettingFieldRow.tsx:28`: field label drops `font-medium` (400).
- Keep unchanged (verify only): `alert-dialog.tsx:155`, `alert.tsx:52`, `card.tsx:40`, `dialog.tsx:133`, `empty.tsx:62`, `input.tsx:10`, `sheet.tsx:117`, `tabs.tsx:49`, `toggle.tsx:9`.

**Checkpoint**: `pnpm typecheck`.

## Phase C: chat transcript rows (US1)

**Owns**: `src/renderer/features/chat/{AdvisoryRow,AgentMessageRow,ChainStageLine,ToolCallDialog,Markdown,AskCard,UpNextList,UserMessageRow,PinnedTodoPanel,QueuedChipList}.tsx`, `features/chat/diff-view.css`, `features/chat/readout/TodoTree.tsx`, `features/subagents/SubagentPanel.tsx`. Depends on T002 only for the visual result, not for the edit.

- [X] T016 [P] [US1] `AdvisoryRow.tsx:251`, `:283`, `:289`: muted section labels drop `font-medium` (400). `:242` and `:271` need no edit (they inherit from `CollapsedLine`).
- [X] T017 [P] [US1] `AgentMessageRow.tsx:22` and `:73`: drop `font-medium`, keep the colour class.
- [X] T018 [P] [US1] `ChainStageLine.tsx:127` and `:136`: drop `font-medium` (400).
- [X] T019 [P] [US1] `ToolCallDialog.tsx:85`: muted section label drops `font-medium` (400). Keep the raw tool id in the title at `:161` and `:186` (FR-015).
- [X] T020 [P] [US3] `Markdown.tsx:461` (headings) and `:831` (table header): `font-semibold` becomes `font-medium` (500). Baselined at 997: in place, no growth.
- [X] T021 [P] [US3] `AskCard.tsx:443`, `:467`, `:511`, `:529`: drop `font-medium` (400); `:405` stays 500.
- [X] T022 [P] [US3] `UserMessageRow.tsx:91`, `PinnedTodoPanel.tsx:223`, `QueuedChipList.tsx:65`: drop `font-medium` (400). `UpNextList.tsx:40` stays 500.
- [X] T023 [P] [US3] `diff-view.css:50` and `:56`: `font-weight: 600` becomes `font-weight: 400`.
- [X] T024 [P] [US1] `readout/TodoTree.tsx:72`: drop `font-medium` (400); `:104` stays 500.
- [X] T025 [P] [US1] `features/subagents/SubagentPanel.tsx:449`: drop `font-medium` (400); update the comment at `:443`.

## Phase D1: chat chrome and readouts (US3)

**Owns**: `src/renderer/features/chat/{ChatHeader,ChatPane,ConversationSwitcher,ModelCatalogGroup,ApprovalModePill,roleCycleStore,RoleOption}.tsx`, `features/chat/readout/{AgentsCard,ContextUsageChip,TodoCard}.tsx`.

- [X] T026 [P] [US3] `ChatHeader.tsx:72`: badge `font-semibold uppercase tracking-wide` becomes `font-medium` (500, sentence case). `:58` stays 500.
- [X] T027 [P] [US3] `ChatPane.tsx:1115` and `:1283`: drop `font-medium` (400). Baselined at 1445: in place, no growth.
- [X] T028 [P] [US3] `ConversationSwitcher.tsx:165`, `:183`; `ModelCatalogGroup.tsx:65`, `:99`; `ApprovalModePill.tsx:105`: drop `font-medium` (400).
- [X] T029 [P] [US3] `roleCycleStore.tsx:95`: `font-semibold` removed (400).
- [X] T030 [P] [US3] `RoleOption.tsx:46`: selected `font-semibold` becomes `font-medium` (500). Live-check the reflow (SC-005).
- [X] T031 [P] [US3] `readout/AgentsCard.tsx:54`, `:65`; `readout/ContextUsageChip.tsx:60`; `readout/TodoCard.tsx:46`: drop `font-medium` (400). Add `data-slot="agents-card-name"` to the `:65` element for T046.

## Phase D2: sessions, right pane, status bar, readiness (US3)

**Owns**: `src/renderer/features/sessions/{SessionList,GroupHeader,SessionDetailsCard,AddRepositoryDialog,NewSessionDialog,DeleteDialog}.tsx`, `features/right-pane/PanelTabBar.tsx`, `features/right-pane/placeholders/{AgentBuilderPanel,FdbKnowledgePanel}.tsx`, `features/right-pane/side-chat/SideChatPanel.tsx`.

- [X] T032 [P] [US3] `SessionList.tsx:236`: `font-semibold` becomes `font-medium` (500); `:415` drops `font-medium` (ghost variant supplies 400); `:254` stays 500.
- [X] T033 [P] [US3] `GroupHeader.tsx:109`, `SessionDetailsCard.tsx:90`, `AddRepositoryDialog.tsx:67`, `NewSessionDialog.tsx:111`, `DeleteDialog.tsx:354`: drop `font-medium` (400).
- [X] T034 [P] [US3] `PanelTabBar.tsx:202`: `font-semibold` becomes `font-medium` (500); `:404` stays 500.
- [X] T035 [P] [US3] `placeholders/AgentBuilderPanel.tsx:43`, `placeholders/FdbKnowledgePanel.tsx:34`, `side-chat/SideChatPanel.tsx:332`: drop `font-medium` (400). Leave their `uppercase` as is (follow-up).
- Keep unchanged (verify only): `status-bar/StatusBar.tsx:70` (500), `readiness/Readiness.tsx:63` (700), `:64` and `:68` (500).

## Phase D3: profile (US3)

**Owns**: `src/renderer/features/profile/{AddAccountPanel,KeyboardShortcutsDialog,ManageAccountsDialog,ManageSessionRow,OmpProvidersSection,ProfileItem,ProfileMenu}.tsx`.

- [X] T036 [P] [US3] `AddAccountPanel.tsx:122`: `font-semibold` becomes `font-medium` (500).
- [X] T037 [P] [US3] `KeyboardShortcutsDialog.tsx:101`: drop `font-medium` (400).
- [X] T038 [P] [US3] `ManageAccountsDialog.tsx:491`, `:581`, `:585`, `:609`: drop `font-medium` (400); `:470`, `:504`, `:524`, `:547` stay 500. Baselined at 720: in place.
- [X] T039 [P] [US3] `ManageSessionRow.tsx:541`: drop `font-medium` (400). Baselined at 662: in place.
- [X] T040 [P] [US3] `OmpProvidersSection.tsx:141`, `:185`; `ProfileItem.tsx:261`; `ProfileMenu.tsx:359`: drop `font-medium` (400). `OmpProvidersSection.tsx:92`, `:178` stay 500. `ManageSessionsScreen.tsx:174` stays 600 (not owned; verify only).

## Phase D4: pull requests and Settings (US3)

**Owns**: `src/renderer/features/pull-requests/{MergeDialog,PullRequestList,PullRequestRow,StatePill,Timeline}.tsx`, `src/renderer/features/settings/{AppearanceSection,ModelRolesSection,RightPaneSection,SettingsScreen}.tsx`.

- [X] T041 [P] [US3] `PullRequestList.tsx:52`: remove `data-[state=active]:font-semibold` (Tabs supplies 500). Live-check no reflow (SC-005).
- [X] T042 [P] [US3] `MergeDialog.tsx:176`, `PullRequestRow.tsx:87`, `StatePill.tsx:27`, `Timeline.tsx:72`, `:85`, `:95`, `:159`, `:167`: drop `font-medium` (400).
- [X] T043 [P] [US3] `AppearanceSection.tsx:204`, `:223`; `ModelRolesSection.tsx:388`; `RightPaneSection.tsx:33`; `SettingsScreen.tsx:174`: drop `font-medium` (400).
- [X] T044 [P] [US3] `ModelRolesSection.tsx:559` and `:576`: `font-semibold` becomes `font-medium` (500).
- Keep unchanged (verify only): page titles at 600 (`PullRequestDetail.tsx:221`, `PullRequestsView.tsx:171`, `AppearanceSection.tsx:174`, `ChatDisplaySection.tsx:45`, `ModelRolesSection.tsx:527`, `OmpSection.tsx:21`, `RightPaneSection.tsx:25`, `SessionsSection.tsx:18`, `SettingsScreen.tsx:107`, `:162`) and 500 at `AppearanceSection.tsx:179`, `:182`, `ChatWidthPicker.tsx:76`, `SettingsScreen.tsx:135`, `ThemePicker.tsx:76`.

## Phase E: design docs (US3)

**Owns**: `docs/design/foundations-typography-spacing.md`, `docs/design/product-chat.md`. Can run any time.

- [X] T045 [P] [US3] `docs/design/foundations-typography-spacing.md`: add a "Font weight scale" section with the FR-007 table (one scale on every theme; 450 rejected and why); line 24 "medium weight" becomes "regular weight"; line 39 group header label `font-medium` becomes `font-normal`; add an "Action labels" rule under case and label style (sentence-case verbs from `src/renderer/features/chat/toolVerbs.ts`, running and done forms, sentence-case fallback, no trailing colons). `docs/design/product-chat.md:22`: "Asked user:" becomes "Asked user" (FR-011).
- The `docs/PLAN.md` row status is updated by the director in the implementation PR, not by a lane worker.

## Phase F: live-check scripts and verification

**Owns**: the `scripts/verify-*.mjs` files listed in research Decision 4. Depends on Phases A to E.

- [X] T046 [P] Update the selectors in research Decision 4's table in place: `span.font-medium` becomes `[data-slot="collapsed-line-label"]`; `verify-632-grouped-calls.mjs:504` regex `/^bash(\s*×2)?$/` becomes `/^Ran(\s*×2)?$/`; `verify-700-pill-cards.mjs:405` selects `[data-slot="agents-card-name"]` (from T031). No script gains lines (`verify-570` and `verify-700` are at 600, `verify-632` is baselined at 673).
- [ ] T047 Run `rg -n "font-(medium|semibold|bold)|font-weight" src/renderer` and confirm every remaining use matches a keep row in the research inventory (SC-003); semibold only on page titles, bold only at `Readiness.tsx:63`.
- [ ] T048 Run `pnpm typecheck`, `pnpm test`, `pnpm check:indent`, `pnpm check:ui-text`, `pnpm check:theme-contrast`, `pnpm check:file-size`; all pass with no new contrast failure (FR-012, SC-004).
- [ ] T049 Live check per [quickstart.md](./quickstart.md) on a scratch Tauri debug build (never `pnpm dev`): five themes, 360 px, screenshots; confirm SC-001, SC-002, SC-005, verbs, accessible names and row start position.

## Dependencies

- A has no prerequisites. B is independent. C, D1 to D4 and E edit disjoint files and can run in parallel with each other and with A; C's visual result depends on T002. T046 depends on T002 and T031. T047 to T049 run after all other phases.

## Coverage

| Requirement | Tasks |
|---|---|
| FR-001 | T002, T016, T017, T018, T024, T025 |
| FR-002, FR-004 | T001, T003, T005 |
| FR-003 | T001 |
| FR-005 | T003, T006, T007 |
| FR-006 | T001, T003 |
| FR-007, FR-009 | T010 to T044, T047 |
| FR-008 | T004, T016, T019, T020, T024, T026, T029, T030, T032, T041 |
| FR-010 | T002, T010 to T015, T032, T041 |
| FR-011 | T045 |
| FR-012 | T048 |
| FR-013 | T003 |
| FR-014 | T005 |
| FR-015 | T007, T009, T019 |
| SC-001, SC-002, SC-005 | T049 |
| SC-003 | T047 |
| SC-004 | T048 |
