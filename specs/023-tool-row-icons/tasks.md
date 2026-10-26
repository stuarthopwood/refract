# Tasks: Tool-row icons with verb tooltips

**Input**: Design documents from `specs/023-tool-row-icons/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [quickstart.md](./quickstart.md)
**Tests**: No new tests (prototyping rule, 2026-10-08): no test files, cases, mocks or fixtures. Existing vitest and `cargo test` suites must keep passing; update an existing test only where this change stops it compiling or passing (for example `TranscriptItem::Tool` literals that need `intent: None`). Verification is the gate of record plus a live check.

**Format**: `[ID] [P?] [Story] Description`. Tasks are grouped into slices; each slice is one fresh worker (target under about 60 model requests) and owns the files listed under it. `[P]` on a slice means it can run in parallel with the other `[P]` slices in the same wave (no shared files). Line numbers are against `d3957363` (2026-10-26); re-grep each before editing and fix drifted references in place. Decisions come from [research.md](./research.md); do not re-decide them.

**Rules for every slice**: edit only the files the slice owns; do not grow any file over 600 lines or any baselined file in `scripts/file-size-baseline.json`; reusable components first (`docs/design/components.md`, `AGENTS.md` "Reusable UI components"); no new tests; never `pnpm dev`; cargo commands use `CARGO_TARGET_DIR=C:\Users\shopwood\.cargo-target\refract`, `CARGO_INCREMENTAL=0`, `CARGO_BUILD_JOBS=4` and `--manifest-path src-tauri/Cargo.toml`; safe deletion (literal absolute paths only, never a variable-built, empty, `.`, `..`, `~`, `*` or bare-drive target, nothing deleted inside the repo except named scratch files, no `git clean -f`, `git reset --hard`, `git checkout .` or `git restore .`); report changed files so the controller commits and pushes after each slice.

## Wave 1: foundations (all five slices in parallel)

### Slice 1 [P]: split SubagentRow out of ToolRow (no behaviour change)

**Owns**: `src/renderer/features/chat/ToolRow.tsx`, `src/renderer/features/chat/SubagentRow.tsx` (new), `src/renderer/features/chat/SubagentChainRow.tsx` (import line only).

- [x] T001 Move `SubagentRowProps`, `SubagentBody` and `SubagentRow` with their comment blocks (`ToolRow.tsx:499-598`) unchanged into new `src/renderer/features/chat/SubagentRow.tsx`, carrying only the imports they use; drop imports `ToolRow.tsx` no longer needs.
- [x] T002 `SubagentChainRow.tsx:23`: import `SubagentBody` and `SubagentRow` from `./SubagentRow`. Grep `src/renderer` for any other importer of these names from `./ToolRow` and repoint it.

**Checkpoint**: `pnpm typecheck`, `pnpm test`, `pnpm check:file-size`; `ToolRow.tsx` about 500 lines.

### Slice 2 [P]: intent in the transcript model (Rust and shared type)

**Owns**: `src-tauri/src/omp/transcript.rs`, `src-tauri/src/omp/transcript/tool_intent.rs` (new), `src-tauri/src/omp/diff.rs`, `src/shared/model.ts`, and any existing Rust test file that stops compiling because of the new field.

- [x] T003 [US2] Create `src-tauri/src/omp/transcript/tool_intent.rs` (research Decision 2): `read_live_intent(frame: &Value) -> Option<String>` (`intent`, then `args.i`, then `args.intent`), `read_history_intent(arguments: &Value) -> Option<String>` (`i`, then `intent`), and `sanitize_intent(&str) -> Option<String>` (strip C0 and C1 controls and U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069; collapse whitespace to one space; trim; cap 400 characters on a character boundary; empty is `None`). Register it with `mod tool_intent;` beside `mod subagent_items;` (`transcript.rs:30`). Keep it under 600 lines.
- [x] T004 [US2] `transcript.rs:84` `TranscriptItem::Tool`: add `#[serde(default, skip_serializing_if = "Option::is_none")] intent: Option<String>` (data-model). Set it at `apply_tool_execution_start` (`:1123`, push at `:1155`) from `read_live_intent(frame)`; when the item already exists, set it only if it is `None` today.
- [x] T005 [US2] `transcript.rs` history and snapshot `"toolCall"` branch (about `:890-960`; merges at `:926` and `:936`, new item at `:951`): read `read_history_intent(arguments)`; a new item takes it; a merge keeps the existing intent when the new value is `None` (data-model state table).
- [x] T006 [US2] Result-only constructions (`transcript.rs:1271`, `:1504`) and `omp/diff.rs:150`: `intent: None`. Fix every existing test literal that no longer compiles the same way.
- [x] T007 [US1] `transcript.rs:350` `first_string_arg`: skip the keys `i` and `intent` (research Decision 9).
- [x] T008 [US2] `src/shared/model.ts` tool item (about `:417-451`): add `intent?: string` with no net line growth (baseline 656); pay for the line by shortening a comment in the same file (for example merge two comment lines in the tool item block).

**Checkpoint**: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, `pnpm typecheck`, `pnpm check:file-size`, `pnpm check:omp-schema -- --check-pin`.

### Slice 3 [P]: the "Show tool names on rows" setting

**Owns**: `src/shared/transcriptDisplay.ts`, `src-tauri/src/store/settings.rs`, `src-tauri/src/store/settings_tests.rs` (only if it stops compiling), `src-tauri/src/ipc/settings.rs`, `src/renderer/features/settings/ChatDisplaySection.tsx`.

- [x] T009 [US3] `src/shared/transcriptDisplay.ts`: add `toolNames: boolean` to `TranscriptDisplaySettings` (`:11`) and `toolNames: false` to `DEFAULT_TRANSCRIPT_DISPLAY` (`:20`); update its comment.
- [x] T010 [US3] `src-tauri/src/store/settings.rs`: field `#[serde(rename = "toolNames", default)] tool_names: bool` beside `tool_calls` (`:69-70`), parse default `false` (`:190-196`), setter arm `"toolNames"` (about `:471-482`).
- [x] T011 [US3] `src-tauri/src/ipc/settings.rs:308-311`: accept `"toolNames"` alongside `"thinking"` and `"toolCalls"` and update the error message.
- [x] T012 [US3] `ChatDisplaySection.tsx`: a `SettingSwitchRow` "Show tool names on rows" after "Show tool calls" (`:64`), bound to `transcriptDisplay.toolNames` and `setTranscriptDisplay('toolNames', checked)`, with a one-line description (raw tool id shown muted after each row's label). Run `pnpm check:ui-text`.

**Checkpoint**: `pnpm typecheck`, `pnpm check:parity -- --gate` (no channel change), `cargo test`, `cargo clippy --all-targets -- -D warnings`.

### Slice 4 [P]: verb map, display resolver, shared ToolIcon

**Owns**: `src/renderer/features/chat/toolVerbs.ts`, `src/renderer/features/chat/toolDisplay.ts` (new), `src/renderer/components/ToolIcon.tsx` (new).

- [x] T013 [US1] `toolVerbs.ts` (research Decisions 3 and 4): each entry `{ icon, running, done, base }` with FR-003's values (lucide-react imports); `glob` shares `find`'s entry object; thinking keeps `{ running, done }`. `toolVerb(tool, status: RowStatus)` returns running, done, or base for `error`, `interrupted`, `cancelled`, `exited` (thinking falls back to done); unmapped tools return `sentenceCaseToolName(tool)`. Keep `toolAriaPrefix` and `toolRunningAnnouncement` behaviour. Confirm every icon export compiles; on a missing export, follow Decision 4's fallback and report it.
- [x] T014 [US1] New `toolDisplay.ts` (Decision 5): `resolveToolDisplay(tool, target)` returning `{ key, entryTool, icon, rawId }` for mapped, `mcp__*` (Plug; an empty name after `mcp__` reads "Tool"), `write` to `xd://<x>`, and unknown (Wrench) tools; `toolRowLabel(tool, target, intent, status)` returning the trimmed intent or the verb or sentence-case fallback.
- [x] T015 [US1] New `src/renderer/components/ToolIcon.tsx` (Decision 7): props `{ tool, target?, tone?: 'muted' | 'error', className? }`; renders the resolved glyph `aria-hidden`, `size-4 shrink-0`, `text-muted-foreground` or `text-severity-error`.

**Checkpoint**: `pnpm typecheck`; existing callers (`ThoughtRunRow.tsx`, `Transcript.tsx:870`, `ToolRow.tsx`) compile unchanged.

### Slice 5 [P]: icon tooltip slot on CollapsedLine

**Owns**: `src/renderer/features/chat/CollapsedLine.tsx`.

- [x] T016 [US3] Add optional `iconTooltip?: string` (research Decision 8): when set, wrap the icon slot in the shared `Tooltip`/`TooltipTrigger asChild`/`TooltipContent` from `src/renderer/components/ui/tooltip.tsx` with a controlled `open` = Radix hover state OR the row trigger focused and matching `:focus-visible` (`onFocus`/`onBlur` on the trigger). No new tab stop; the icon wrapper stays `aria-hidden`. With no `iconTooltip`, output is unchanged for every existing caller.

**Checkpoint**: `pnpm typecheck`, `pnpm test`.

## Wave 2: wiring (after wave 1; slices 6 and 8 in parallel, slice 7 after slice 6)

### Slice 6 [P]: summaries and grouping

**Depends on**: Slice 4.
**Owns**: `src/renderer/features/chat/formatToolCommand.ts`, `src/renderer/features/chat/groupToolItems.ts`.

- [x] T017 [US1] `formatToolCommand.ts` (FR-006): `commandRowText` drops the `$ ` prefix for `bash` and the leading `grep ` for `grep` (summary is the command, or the quoted pattern and path). Keep the `COMMAND_STYLE_TOOLS` export so `ToolRow.tsx` still compiles until slice 7.
- [x] T018 [US1] `groupToolItems.ts:87` (Decision 11): compare `resolveToolDisplay(item.tool, item.target).key` with the run's first item's key instead of `item.tool`. Skill boundaries (#543) unchanged.

**Checkpoint**: `pnpm typecheck`, `pnpm test` (update an existing assertion only if it pinned the old `$ ` or `grep ` text).

### Slice 7: tool rows and group rows

**Depends on**: Slices 1, 2, 3, 4, 5, 6.
**Owns**: `src/renderer/features/chat/ToolRow.tsx`, `src/renderer/features/chat/toolRowParts.tsx` (new).

- [x] T019 [US1] New `toolRowParts.tsx` (Decision 6): helpers used by both row kinds: the label (`toolRowLabel`), a muted raw-id span placed at the start of the summary when `transcriptDisplay.toolNames` is on (read with `useSettingsStore`), the trailing `meta` (`StatusIcon` then duration), and the accessible name (`toolAriaPrefix(status)`, label, raw id when on, target; FR-015).
- [x] T020 [US1] `ToolCallRow` (about `:186-237`): `icon={<ToolIcon tool target tone/>}` (FR-001, FR-020), `iconTooltip={rawId}` (FR-011), label from T019 for every tool including `bash` and `grep` (stop hiding the label for `COMMAND_STYLE_TOOLS`), status icon moved into `meta`, aria name from T019; error label colour unchanged (`text-severity-error`).
- [x] T021 [US1] `ToolGroupRow` (about `:277-420`): shared tool's `ToolIcon` and tooltip; label `${toolVerb(entryTool, phase)} ×N` (FR-014); trailing status icon; aria name from T019; skill rows keep "Using skill"/"Used skill" through the map. Each member row uses T020.
- [x] T022 [US2] Confirm a row with an intent shows it as the label in every status and a `wait` row's summary is its target (FR-018). At 360 px (SC-005, FR-009) the tool icon and trailing status icon are `shrink-0`, the label truncates with an ellipsis, and the raw id and target truncate before it. Keep `ToolRow.tsx` at or under 600 lines.

**Checkpoint**: `pnpm typecheck`, `pnpm test`, `pnpm check:file-size`, `pnpm check:ui-text`.

### Slice 8 [P]: approval card and subagent rows

**Depends on**: Slices 1 and 4.
**Owns**: `src/renderer/features/chat/RequestCard.tsx`, `src/renderer/features/chat/SubagentRow.tsx`.

- [x] T023 [US4] `RequestCard.tsx:407`: `<ToolIcon tool={request.tool} />` beside the title; the text "Allow tool: {request.tool}" is unchanged (FR-016). The file is 600 lines and not baselined: free a line (merge or shorten a comment) for the import so it stays at or under 600.
- [x] T024 [US4] `SubagentRow.tsx`: leading `icon={<ToolIcon tool="task" />}` (Users); move `SubagentStatusGlyph` into `meta` ahead of the status word and duration, keeping its `sr-only` word out of double reading (FR-017). Stage and chain rows in `SubagentChainRow.tsx` are not changed.

**Checkpoint**: `pnpm typecheck`, `pnpm check:file-size`.

## Wave 3: close-out (sequential)

### Slice 9: reusable-components check and docs

**Depends on**: Slices 1 to 8.
**Owns**: `docs/design/components.md`, `docs/PLAN.md`.

- [x] T025 Reusable-components check (FR-021): grep the diff for hand-styled icons, tooltips or switches outside `src/renderer/components/`; every tool icon comes from `ToolIcon`, every tooltip from `components/ui/tooltip.tsx`, the switch from `SettingSwitchRow`. Fix any one-off by routing it through the shared component (report any source file this touches).
- [x] T026 [P] `docs/design/components.md`: add `ToolIcon` (what it reads, tones) and `CollapsedLine`'s `iconTooltip` to the shared component list.
- [x] T027 [P] `docs/PLAN.md` row 17 (#469): status to implemented, pending live check and merge, with the PR number.

### Slice 10: gate

**Depends on**: Slice 9.
**Owns**: only files a failing check points at (report each).

- [x] T028 Run `node scripts/ci-local.mjs` (typecheck, test, check:indent, check:theme-contrast, check:drag-regions, check:parity, check:file-size, check:versions, check:omp-schema, cargo fmt, test and clippy, tauri debug build, check:ui-text). Fix fallout in the owning files; update an existing test only where this change broke it.

### Slice 11: live verification

**Depends on**: Slice 10.
**Owns**: no source files; screenshots go to the session folder, not the repo.

- [ ] T029 Follow [quickstart.md](./quickstart.md) steps 1 to 9 with a scratch debug build through `scripts/verify-tauri.mjs` (scratch `REFRACT_DATA_DIR`, own CDP port, recorded-frame `session` fixture, then one short real-`omp` session for failed, MCP, `xd://` and unknown tools, reopened from history). Report pass or fail per step with evidence (DOM text, accessible names, computed colours, screenshots).

## Dependencies and execution order

| Slice | Depends on | Parallel with |
|---|---|---|
| 1 SubagentRow split | none | 2, 3, 4, 5 |
| 2 Intent model | none | 1, 3, 4, 5 |
| 3 Setting | none | 1, 2, 4, 5 |
| 4 Verb map and ToolIcon | none | 1, 2, 3, 5 |
| 5 CollapsedLine tooltip | none | 1, 2, 3, 4 |
| 6 Summaries and grouping | 4 | 8 |
| 7 Tool rows | 1, 2, 3, 4, 5, 6 | 8 |
| 8 Approval and subagent rows | 1, 4 | 6, 7 |
| 9 Components check and docs | 1 to 8 | none |
| 10 Gate | 9 | none |
| 11 Live verify | 10 | none |

User story coverage: US1 (icons and verbs) slices 4, 6, 7; US2 (intent) slices 2, 7; US3 (raw id: tooltip and setting) slices 3, 5, 7; US4 (other surfaces) slice 8. The MVP is waves 1 and 2 through slice 7.

## Open items

- Known-stale live-check scripts, not in CI, left for a follow-up: `scripts/verify-632-grouped-calls.mjs`, `scripts/verify-error-prefix-space.mjs`, `scripts/verify-565-spine.mjs` and `scripts/verify-570-tool-colours.mjs` still match the old `$ ` and `grep "` summary prefixes and expect the spinner in the leading icon slot.
