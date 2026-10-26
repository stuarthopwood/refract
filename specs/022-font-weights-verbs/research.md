# Research: Lighter font weights and sentence-case action verbs

**Feature**: [spec.md](./spec.md) | **Date**: 2026-10-26

All line numbers are against `origin/main` at commit `4c973d43` (2026-10-26). Re-check each with `grep` before editing; a reference that has drifted is fixed in place, not skipped.

## Decision 1: the weight scale, applied through shared components

- **Decision**: 400 body text, labels, metadata, muted section labels, badges, ghost and link buttons; 500 buttons, selected states, in-chat headings (dialog, card, sheet and alert titles count as in-chat headings); 600 page titles only; 700 brand wordmark only. One scale, every theme.
- **Rationale**: Stuart's grill (2026-10-23). Light-on-dark text reads bolder, and the old mix of 500 and 600 for the same role was inconsistent. Tailwind's `font-normal`, `font-medium`, `font-semibold` and `font-bold` map one-to-one to 400, 500, 600 and 700, so no new token is needed.
- **Alternatives considered**: 450 (rejected: static Segoe UI on Windows 10 has no 450); a dark-theme-only weight token (rejected: two scales to maintain, and the grill chose one).
- **Shared component changes**: `Badge` base 500 to 400; `Button` keeps 500 but the `ghost` and `link` variants add `font-normal`; `Kbd`, the `ContextMenuLabel` and `DropdownMenuLabel`, the `Message` metadata slots, the `SidebarGroupLabel` and `SidebarMenuBadge` go to 400; `Tabs`, `Toggle`, dialog, sheet, card, alert and empty titles keep 500. `CollapsedLine`'s label goes to 400, which fixes every transcript row (tool, advisory, notice, Stage, agent message, thought) in one place.

## Decision 2: one verb map module

- **Decision**: a new module `src/renderer/features/chat/toolVerbs.ts`, beside the tool rows, exporting:
  - `TOOL_VERBS`: a frozen record from tool id to `{ running, done }`: `read` Reading/Read, `edit` Editing/Edited, `write` Writing/Wrote, `bash` Running/Ran, `grep` Searching/Searched, `find` Searching/Searched, `thinking` Thinking/Thought process, `skill` Using skill/Used skill.
  - `toolVerb(tool: string, phase: 'running' | 'done'): string`: the map entry, or the sentence-case fallback.
  - `sentenceCaseToolName(tool: string): string`: underscores and hyphens to spaces, repeated spaces collapsed, trimmed, first letter upper case, the rest unchanged; an empty result returns `'Tool'`.
  - Phase rule: `running` maps to the running form and `done` to the done form; `error`, `exited`, `interrupted` and `cancelled` show the sentence-case tool name (gate amendment 2026-10-26, see spec Clarifications).
- **Rationale**: FR-002 to FR-004; issue #469 needs to import the same map. A `Record` with `Object.hasOwn` (not `in`) avoids prototype keys such as `toString`, matching `formatToolCommand.ts:42-44`'s own reasoning for using a `Set`.
- **Alternatives considered**: putting the map in `src/shared` (rejected: only the renderer uses it; the repo rule keeps a single-consumer module beside its consumer); extending `toolStatus.tsx` (rejected: it is about status, not verbs, and #469 would pull in the status icons).

## Decision 3: accessible names

Today a tool row's name is `${toolStatusLabel(status)} ${tool} ${summary}` (`ToolRow.tsx:198-201`, `:393-404`), so a running read reads "Running read src/a.ts". With verbs this would become "Running Reading src/a.ts". New rule (spec FR-006): the name starts with the verb (`toolVerb(tool, phase)`), then the summary; a status prefix is kept only for `error` ("Failed"), `interrupted`, `cancelled` and `exited`. `Transcript.tsx:870`'s live announcement `${toolStatusLabel('running')} ${row.tool}` becomes `toolVerb(row.tool, 'running')` (FR-015).

## Decision 4: stable selector for the row label

The `CollapsedLine` label span (`CollapsedLine.tsx:163`) is located by `span.font-medium` in 14 live-check scripts. Removing `font-medium` breaks them silently. The label span gains `data-slot="collapsed-line-label"` (matching the `data-slot` convention in `components/ui`), and the scripts select on that instead. These scripts are not in CI (`.github/workflows/ci.yml` runs none of them); they are kept working because later lanes reuse them for live checks.

| Script | Lines | Uses of `font-medium` or raw tool ids to update |
|---|---|---|
| `scripts/verify-557-thought-runs.mjs` | 589 | `:84`, `:87`, `:339` |
| `scripts/verify-558-blocker-callout.mjs` | 484 | `:64`, `:91` |
| `scripts/verify-565-spine.mjs` | 589 | `:64`, `:377` |
| `scripts/verify-570-tool-colours.mjs` | 600 (at cap) | `:70`, `:102`, `:344`, `:488`, `:524` |
| `scripts/verify-632-grouped-calls.mjs` | 673 (baselined) | `:93` (comment), `:103`, `:118`, `:496`, `:504` (also matches `/^bash(\s*×2)?$/`, becomes `/^Ran(\s*×2)?$/`), `:506` |
| `scripts/verify-911-stop-neutral.mjs` | 399 | `:87` |
| `scripts/verify-917-advisor-command.mjs` | 315 | `:193`, `:244`, `:257` |
| `scripts/verify-941-stage-naming-helpers.mjs` | 553 | `:261` |
| `scripts/verify-error-prefix-space.mjs` | 322 | `:46`, `:52`, `:77` |
| `scripts/verify-p1-agentmsg.mjs` | 265 | `:187` |
| `scripts/verify-tauri-ask.mjs` | 590 | `:197`, `:200`, `:205`, `:371`, `:380`, `:389` |
| `scripts/verify-700-pill-cards.mjs` | 600 (at cap) | `:405` `.font-medium` targets an agent name in `AgentsCard.tsx:65`, which goes to 400; select on a `data-slot` added there or on the element's position |
| `scripts/verify-680-686-chat-header.mjs` | 290 | `:70` targets `ChatHeader.tsx:58`, which stays 500: no change |
| `scripts/verify-1074-text-opacity-helpers.mjs` | 228 | `:9` targets `ChatHeader.tsx:58`: no change |

Each edit replaces a selector in place; no script may gain lines (two are at the 600 cap and one is baselined).

## Decision 5: existing tests

The vitest suite (11 files: `queuedChips`, `resume`, `windowTranscriptTurns`, `modelRoleSuffix`, `clipboard-copy-decision`, `clipboard-sanitise`, `model-roles-store`, `sessions-store`, `canResumeSession`, `model`, `repositoryName`) asserts no font class and no tool label text. No existing test needs its expectation changed. No new tests are added (prototyping rule, 2026-10-08).

## Decision 6: file-size cap

| File | Lines now | Risk |
|---|---|---|
| `src/renderer/features/chat/ToolRow.tsx` | 599 (cap 600, not baselined) | HIGH: at most one net new line. Replace label and aria expressions in place; put any helper (status prefix rule) in `toolVerbs.ts`. If it would exceed 600, extract `SubagentRow` (`:575-599`) into its own file first, unchanged. |
| `scripts/verify-570-tool-colours.mjs`, `scripts/verify-700-pill-cards.mjs` | 600 each | Selector edits in place only. |
| `scripts/verify-632-grouped-calls.mjs` | 673 (baselined) | In place only; may shrink. |
| `src/renderer/features/chat/ChatPane.tsx` 1445, `Markdown.tsx` 997, `Transcript.tsx` 1059, `ManageAccountsDialog.tsx` 720, `ManageSessionRow.tsx` 662 | baselined | Class or one-expression edits in place; no growth. |
| `src/renderer/features/chat/toolVerbs.ts` | new | Far under the cap (about 40 lines). |

## Inventory: every weight use in `src/renderer`

Found with `rg -n "font-(medium|semibold|bold)|font-weight" src/renderer` on 2026-10-26: 107 `font-medium` uses in code (plus 2 in comments), 22 `font-semibold`, 1 `font-bold`, and 2 CSS `font-weight: 600` declarations, 132 in total. `font-normal` uses (17) are left as they are. The `@font-face` `font-weight: 100 900` range in `globals.css:13` is a font descriptor, not a use.

Columns: **Now** is the current weight, **Role** the scale role, **Target** the new weight; "keep" means no edit. **Phase** refers to [tasks.md](./tasks.md).

### Phase A: verb map and the shared row label (chat)

| File:line | Now | Role | Target |
|---|---|---|---|
| `features/chat/CollapsedLine.tsx:163` | 500 | transcript row label | 400 (plus `data-slot`); update the doc comment at `:43` |
| `features/chat/ToolRow.tsx:536` | 500 | muted section label "Prompt" | 400 |
| `features/chat/ToolRow.tsx:543` | 500 | muted section label "Result" | 400 |
| `features/chat/RequestCard.tsx:311` | 500 | in-chat heading (question heading) | keep 500 |
| `features/chat/RequestCard.tsx:328` | 500 | avatar initials (badge) | 400 |
| `features/chat/RequestCard.tsx:334` | 500 | name label | 400 |
| `features/chat/RequestCard.tsx:555` | 500 | option label | 400 |

### Phase B: shared components

| File:line | Now | Role | Target |
|---|---|---|---|
| `components/ui/alert-dialog.tsx:155` | 500 | dialog title | keep 500 |
| `components/ui/alert.tsx:52` | 500 | alert title | keep 500 |
| `components/ui/badge.tsx:7` | 500 | badge | 400 |
| `components/ui/button.tsx:7` | 500 | button | keep 500; add `font-normal` to `ghost` (`:29-30`) and `link` (`:33`) |
| `components/ui/card.tsx:40` | 500 | card title | keep 500 |
| `components/ui/context-menu.tsx:207` | 500 | muted menu label | 400 |
| `components/ui/dialog.tsx:133` | 500 | dialog title | keep 500 |
| `components/ui/dropdown-menu.tsx:211` | 500 | menu label | 400 |
| `components/ui/empty.tsx:62` | 500 | empty-state title | keep 500 |
| `components/ui/input.tsx:10` | 500 | file-picker button (`file:`) | keep 500 |
| `components/ui/kbd.tsx:8` | 500 | key cap (metadata) | 400 |
| `components/ui/message.tsx:63` | 500 | muted message metadata | 400 |
| `components/ui/message.tsx:76` | 500 | muted message metadata | 400 |
| `components/ui/sheet.tsx:117` | 500 | sheet title | keep 500 |
| `components/ui/sidebar.tsx:404` | 500 | muted group label | 400 |
| `components/ui/sidebar.tsx:469` | 500 | selected state (`data-active`) | keep 500 |
| `components/ui/sidebar.tsx:575` | 500 | menu badge (count) | 400 |
| `components/ui/tabs.tsx:49` | 500 | tab (button, selected or not) | keep 500 |
| `components/ui/toggle.tsx:9` | 500 | button | keep 500 |
| `components/SettingFieldRow.tsx:28` | 500 | field label | 400 |

### Phase C: chat transcript rows

| File:line | Now | Role | Target |
|---|---|---|---|
| `features/chat/AdvisoryRow.tsx:251` | 500 | muted section label "Guidance" | 400 |
| `features/chat/AdvisoryRow.tsx:283` | 500 | muted section label "Guidance" | 400 |
| `features/chat/AdvisoryRow.tsx:289` | 500 | muted section label "Location(s)" | 400 |
| `features/chat/AdvisoryRow.tsx:242`, `:271` | inherits 500 | advisory label | 400 through `CollapsedLine` (Phase A); no edit |
| `features/chat/AgentMessageRow.tsx:22` | 500 | agent-message label | 400 (drop `font-medium`, keep colour) |
| `features/chat/AgentMessageRow.tsx:73` | 500 | agent-message label | 400 (drop `font-medium`, keep colour) |
| `features/chat/ChainStageLine.tsx:127` | 500 | Stage label (button) | 400 |
| `features/chat/ChainStageLine.tsx:136` | 500 | Stage label | 400 |
| `features/chat/ToolCallDialog.tsx:85` | 500 | muted section label | 400 |
| `features/chat/Markdown.tsx:461` | 600 | in-chat heading | 500 |
| `features/chat/Markdown.tsx:831` | 600 | table header (in-chat heading) | 500 |
| `features/chat/readout/TodoTree.tsx:72` | 500 | 11 px muted group label | 400 |
| `features/chat/readout/TodoTree.tsx:104` | 500 | current task (selected state) | keep 500 |
| `features/chat/AskCard.tsx:405` | 500 | in-chat heading | keep 500 |
| `features/chat/AskCard.tsx:443`, `:467`, `:511`, `:529` | 500 | option labels | 400 |
| `features/chat/UpNextList.tsx:40` | 500 | in-chat heading "Up next" | keep 500 |
| `features/chat/UserMessageRow.tsx:91` | 500 | avatar initials | 400 |
| `features/chat/PinnedTodoPanel.tsx:223` | 500 | current task label | 400 |
| `features/chat/QueuedChipList.tsx:65` | 500 | queued chip (badge) | 400 |
| `features/chat/diff-view.css:50`, `:56` | 600 | diff `+`/`−` marker | 400 (the glyph is the cue) |
| `features/subagents/SubagentPanel.tsx:449` | 500 | Stage header label | 400; update the comment at `:443` |

### Phase D1: chat chrome and readouts

| File:line | Now | Role | Target |
|---|---|---|---|
| `features/chat/ChatHeader.tsx:58` | 500 | Session name (in-chat heading) | keep 500 |
| `features/chat/ChatHeader.tsx:72` | 600 uppercase | Session badge | 500, drop `uppercase tracking-wide` |
| `features/chat/ChatPane.tsx:1115` | 500 | drop-zone message | 400 |
| `features/chat/ChatPane.tsx:1283` | 500 | inline link button | 400 |
| `features/chat/ConversationSwitcher.tsx:165` | 500 | list item title | 400 |
| `features/chat/ConversationSwitcher.tsx:183` | 500 | conversation title text | 400 |
| `features/chat/ModelCatalogGroup.tsx:65` | 500 | muted section label | 400 |
| `features/chat/ModelCatalogGroup.tsx:99` | 500 | status metadata | 400 |
| `features/chat/ApprovalModePill.tsx:105` | 500 | menu option label | 400 |
| `features/chat/roleCycleStore.tsx:95` | 600 | role-cycle overlay text | 400 |
| `features/chat/RoleOption.tsx:46` | 600 | selected state | 500 |
| `features/chat/readout/AgentsCard.tsx:54` | 500 | card metadata "N running" | 400 |
| `features/chat/readout/AgentsCard.tsx:65` | 500 | agent name | 400 |
| `features/chat/readout/ContextUsageChip.tsx:60` | 500 | " high" status word (coloured) | 400 |
| `features/chat/readout/TodoCard.tsx:46` | 500 | card metadata "x of y" | 400 |

### Phase D2: sessions, right pane, status bar, readiness

| File:line | Now | Role | Target |
|---|---|---|---|
| `features/sessions/SessionList.tsx:236` | 600 | sidebar brand title | 500 |
| `features/sessions/SessionList.tsx:254` | 500 | nav button (Pull requests) | keep 500 |
| `features/sessions/SessionList.tsx:415` | 500 | ghost button | 400 (drop `font-medium`; the ghost variant supplies 400) |
| `features/sessions/GroupHeader.tsx:109` | 500 | muted group label | 400 |
| `features/sessions/SessionDetailsCard.tsx:90` | 500 | status metadata | 400 |
| `features/sessions/AddRepositoryDialog.tsx:67` | 500 | field label | 400 |
| `features/sessions/NewSessionDialog.tsx:111` | 500 | field label | 400 |
| `features/sessions/DeleteDialog.tsx:354` | 500 | field label | 400 |
| `features/right-pane/PanelTabBar.tsx:202` | 600 | panel title (not a page title) | 500 |
| `features/right-pane/PanelTabBar.tsx:404` | 500 | tab | keep 500 |
| `features/right-pane/placeholders/AgentBuilderPanel.tsx:43` | 500 | muted section label | 400 |
| `features/right-pane/placeholders/FdbKnowledgePanel.tsx:34` | 500 | muted section label | 400 |
| `features/right-pane/side-chat/SideChatPanel.tsx:332` | 500 | echoed question (body) | 400 |
| `features/status-bar/StatusBar.tsx:70` | 500 | popover heading | keep 500 |
| `features/readiness/Readiness.tsx:63` | 700 | brand wordmark | keep 700 |
| `features/readiness/Readiness.tsx:64` | 500 | brand tagline | keep 500 |
| `features/readiness/Readiness.tsx:68` | 500 | page title | keep 500 (the scale caps, it does not raise) |

### Phase D3: profile

| File:line | Now | Role | Target |
|---|---|---|---|
| `features/profile/AddAccountPanel.tsx:122` | 600 | device code display | 500 |
| `features/profile/KeyboardShortcutsDialog.tsx:101` | 500 | muted section heading | 400 |
| `features/profile/ManageAccountsDialog.tsx:470`, `:504`, `:524` | 500 | in-dialog headings | keep 500 |
| `features/profile/ManageAccountsDialog.tsx:491` | 500 | muted section heading | 400 |
| `features/profile/ManageAccountsDialog.tsx:547` | 500 | empty-state heading | keep 500 |
| `features/profile/ManageAccountsDialog.tsx:581` | 500 | account name | 400 |
| `features/profile/ManageAccountsDialog.tsx:585`, `:609` | 500 | status metadata | 400 |
| `features/profile/ManageSessionRow.tsx:541` | 500 | Session name in a row | 400 |
| `features/profile/ManageSessionsScreen.tsx:174` | 600 | page title | keep 600 |
| `features/profile/OmpProvidersSection.tsx:92` | 500 | section heading | keep 500 |
| `features/profile/OmpProvidersSection.tsx:141`, `:185` | 500 | status metadata | 400 |
| `features/profile/OmpProvidersSection.tsx:178` | 500 | empty-state heading | keep 500 |
| `features/profile/ProfileItem.tsx:261` | 500 | account name | 400 |
| `features/profile/ProfileMenu.tsx:359` | 500 | account name | 400 |

### Phase D4: pull requests and Settings

| File:line | Now | Role | Target |
|---|---|---|---|
| `features/pull-requests/MergeDialog.tsx:176` | 500 | option label | 400 |
| `features/pull-requests/PullRequestDetail.tsx:221` | 600 | page title | keep 600 |
| `features/pull-requests/PullRequestList.tsx:52` | 600 when active | selected tab | 500 (drop `data-[state=active]:font-semibold`; `Tabs` supplies 500) |
| `features/pull-requests/PullRequestRow.tsx:87` | 500 | list row title | 400 |
| `features/pull-requests/PullRequestsView.tsx:171` | 600 | page title | keep 600 |
| `features/pull-requests/StatePill.tsx:27` | 500 | state pill (badge) | 400 |
| `features/pull-requests/Timeline.tsx:72`, `:85`, `:95`, `:159`, `:167` | 500 | actor names, label chip, thread path | 400 |
| `features/settings/AppearanceSection.tsx:174` | 600 | page title | keep 600 |
| `features/settings/AppearanceSection.tsx:179`, `:182` | 500 | sub-headings | keep 500 |
| `features/settings/AppearanceSection.tsx:204`, `:223` | 500 | field labels | 400 |
| `features/settings/ChatDisplaySection.tsx:45` | 600 | page title | keep 600 |
| `features/settings/ChatWidthPicker.tsx:76` | 500 | selected state | keep 500 |
| `features/settings/ModelRolesSection.tsx:388` | 500 | field label | 400 |
| `features/settings/ModelRolesSection.tsx:527` | 600 | page title | keep 600 |
| `features/settings/ModelRolesSection.tsx:559`, `:576` | 600 | sub-headings | 500 |
| `features/settings/OmpSection.tsx:21` | 600 | page title | keep 600 |
| `features/settings/RightPaneSection.tsx:25` | 600 | page title | keep 600 |
| `features/settings/RightPaneSection.tsx:33` | 500 | field label | 400 |
| `features/settings/SessionsSection.tsx:18` | 600 | page title | keep 600 |
| `features/settings/SettingsScreen.tsx:107` | 600 | screen title "Settings" | keep 600 |
| `features/settings/SettingsScreen.tsx:135` | 500 | selected nav item | keep 500 |
| `features/settings/SettingsScreen.tsx:162` | 600 | page title | keep 600 |
| `features/settings/SettingsScreen.tsx:174` | 500 | toggle label | 400 |
| `features/settings/ThemePicker.tsx:76` | 500 | selected state | keep 500 |

### Totals

| Target | Uses | Of which changed |
|---|---|---|
| 400 | 78 | 78 (75 from 500, 1 from 600, 2 CSS from 600) |
| 500 | 42 | 10 (from 600) |
| 600 | 11 | 0 |
| 700 | 1 | 0 |
| **All** | **132** | **88** |

Every target is checked against the spec's FR-007 roles. Items resolved by the worker rather than named in the issue and worth a second look: `Button` `link` variant at 400, `diff-view.css` markers at 400, `ContextUsageChip.tsx:60` at 400, `PanelTabBar.tsx:202` at 500, `AddAccountPanel.tsx:122` at 500, `TodoTree.tsx:104` kept at 500, and `Readiness.tsx:64`/`:68` kept at 500.
