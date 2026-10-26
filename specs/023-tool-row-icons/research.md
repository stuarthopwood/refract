# Research: Tool-row icons with verb tooltips

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-10-26

Every Technical Context item in the plan is resolved; there is no open NEEDS CLARIFICATION. Line numbers are against `d3957363`.

## Decision 1: where the intent comes from, and in what order

- **Decision**: live rows read `frame.intent`, then `frame.args.i`, then `frame.args.intent` on `tool_execution_start`; history and `get_messages` snapshot rows read the `toolCall` part's `arguments.i`, then `arguments.intent`. An empty or whitespace-only value is absent. When a snapshot or a later frame has no intent, an existing intent is kept.
- **Rationale**: [FINDINGS item 64](../../docs/spike/FINDINGS.md) observed the live field at the top level of the start frame (OMP 18.12.6 emitter, fixtures `scripts/fixtures/omp-frames/997-notice-severity.jsonl:57` and `ask.jsonl:16`) and the history field as `arguments.i` (387 of 559 `toolCall` parts in the ten newest local session files, none with `arguments.intent`). `src-tauri/src/session/readout_activity.rs:77-81` already reads `intent`, then `args.intent`, for the readout, so the order extends a reader that exists. The `args.intent` and `arguments.intent` fallbacks cost nothing and cover an older or future OMP.
- **Alternatives considered**: the renderer reading `item.args.i` itself. Rejected: live `args` do not carry the intent (OMP lifts it to the frame), so the renderer would see it only for reopened Conversations and SC-007 would fail; sanitising also belongs at the IPC boundary (decision 2).

## Decision 2: sanitise the intent in Rust, render it as text

- **Decision**: a new `src-tauri/src/omp/transcript/tool_intent.rs` holds `read_live_intent(frame)`, `read_history_intent(arguments)` and `sanitize_intent(raw) -> Option<String>`. It removes C0 and C1 control characters and bidirectional formatting characters (U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069), collapses every run of whitespace (including newlines) to one space, trims, and caps at 400 characters on a character boundary. The renderer puts the result in a plain React text node inside the row label, which already truncates with an ellipsis.
- **Rationale**: the intent is untrusted model text (constitution Principle V). One sanitiser at the boundary means the transcript, the accessible name and any future surface get the same clean string. The 400 cap matches the readout's existing `bounded()` cap in `readout_activity.rs`. A new module keeps `transcript.rs` (1750 lines, baseline 1813) from growing.
- **Alternatives considered**: sanitising in the renderer. Rejected: every consumer would need to remember it. Reusing `readout_activity.rs`'s helper directly. Rejected: it lives in the session readout module and does not strip bidirectional characters; `tool_intent.rs` may call `bounded()` if it is made `pub(crate)`, but must add the character filtering itself.

## Decision 3: extend the one verb map in place

- **Decision**: `src/renderer/features/chat/toolVerbs.ts` keeps `TOOL_VERBS` as the only map. Each entry becomes `{ icon, running, done, base }` with the values in FR-003; thinking keeps `{ running, done }` with no icon and no base. `find` and `glob` point at one shared entry object. `toolVerb(tool, status)` takes the row status (`RowStatus` from `toolStatus.tsx`): running form for `running`, done form for `done`, base form for `error`, `interrupted`, `cancelled` and `exited`. An unmapped tool returns `sentenceCaseToolName(tool)` for every status. For thinking, a non-complete status returns the done form (thought rows never ask for it today). Entries are looked up with `Object.hasOwn`, as now.
- **Rationale**: FR-002 forbids a second map. Holding the icon component reference in a `.ts` file needs no JSX. The two existing callers that pass a phase (`ThoughtRunRow.tsx`, `Transcript.tsx:870`) pass `'running'` or `'done'` and keep working.
- **Alternatives considered**: a separate icon map keyed by tool id. Rejected by FR-002. Keeping the base form out of the map and reusing the sentence-case name. Rejected by Stuart's grill answer of 2026-10-26 (raw names never show for mapped tools).

## Decision 4: lucide icon names

- **Decision**: FileText, Pencil, FilePlus, Terminal, Braces, TextSearch, FolderSearch, ScanSearch, Replace, Waypoints, Users, MessageCircleQuestionMark (lucide-react 1.49.0 renamed MessageCircleQuestion), Globe, GitPullRequest, Bug, Database, Image, Hourglass, BookOpen, Plug, Wrench, all from `lucide-react` (1.49.0).
- **Rationale**: these are the spec's names (FR-003 to FR-005). lucide-react has no GitHub brand icon, so `github` uses GitPullRequest. The implementing slice confirms each export compiles under `pnpm typecheck` (this worktree had no `node_modules` when planned); if an export is missing, it picks the nearest lucide glyph, records the swap in the slice report, and updates FR-003 in the same change.
- **Alternatives considered**: custom SVGs. Rejected: reusable-components rule and maintenance cost.

## Decision 5: one display resolver for the special cases

- **Decision**: a new `src/renderer/features/chat/toolDisplay.ts` exports `resolveToolDisplay(tool, target)` returning `{ key, entryTool, icon, rawId }`:
  - `mcp__<name>`: Plug, label is `sentenceCaseToolName(<name>)` ("Tool" when empty), key and raw id are the tool id. No server and tool split (#1226).
  - `write` with a target starting `xd://<x>`: `<x>`'s entry (icon and verbs) or Wrench plus `sentenceCaseToolName(<x>)`; key `xd:<x>`; raw id `write xd://<x>`.
  - any other mapped tool: its entry; key and raw id are the tool id.
  - anything else: Wrench and the sentence-case name.
  It also exports `toolRowLabel(tool, target, intent, status)`: the trimmed intent when non-empty, otherwise `toolVerb(entryTool, status)` or the sentence-case fallback.
- **Rationale**: keeps the special cases out of `ToolRow.tsx` (598 lines) and gives `groupToolItems.ts` a single key to group on.
- **Alternatives considered**: putting the resolver inside `toolVerbs.ts`. Rejected: it mixes per-call logic (targets, intents) into the static map.

## Decision 6: row assembly outside ToolRow.tsx

- **Decision**: first move `SubagentRowProps`, `SubagentBody` and `SubagentRow` with their comment blocks (`ToolRow.tsx:499-598`) unchanged into a new `SubagentRow.tsx` and update the one importer (`SubagentChainRow.tsx:23`). Then put the label, raw-id span, trailing `meta` (status icon, then duration) and accessible-name builders in a new `toolRowParts.tsx`, used by both `ToolCallRow` and `ToolGroupRow`. Command-style rows (`COMMAND_STYLE_TOOLS`, `bash` and `grep`) stop hiding their label; `commandRowText` in `formatToolCommand.ts` drops the `$ ` and `grep ` prefixes (FR-006).
- **Rationale**: the 600-line cap. The split is a cohesive, behaviour-free extraction, as issue #806 asks.
- **Alternatives considered**: baselining `ToolRow.tsx` above 600. Rejected: a new file must not exceed the cap and an offender must not grow.

## Decision 7: one shared ToolIcon

- **Decision**: `src/renderer/components/ToolIcon.tsx` takes `{ tool, target?, tone?: 'muted' | 'error', className? }`, resolves the glyph through `resolveToolDisplay`, and renders it `aria-hidden`, `size-4`, `shrink-0`, with `text-muted-foreground`, or `text-severity-error` (the class failed row labels use today, `ToolRow.tsx:209` and `:417`) for `error`. Tool rows, group rows, the approval card and `SubagentRow` use it.
- **Rationale**: FR-021 asks for one shared component that reads the map. `components/` already imports from `features/chat` (`InlineDisclosure.tsx` imports `@/features/chat/linkStyles`), so the dependency direction has a precedent. Contrast (FR-020): `text-muted-foreground` and `text-severity-error` are the theme tokens already used for muted row text and failed labels; the live check confirms 3:1 in all five themes (quickstart step 6).
- **Alternatives considered**: a `ToolIcon` inside `features/chat`. Rejected by the reusable-components rule (the approval card and subagent rows also need it).

## Decision 8: tooltip opened by icon hover or trigger focus

- **Decision**: `CollapsedLine` gains an optional `iconTooltip?: string`. When set, the icon slot is wrapped in the shared `Tooltip` (`src/renderer/components/ui/tooltip.tsx`) with a controlled `open`: true while Radix reports pointer hover on the icon trigger (an `aria-hidden` `span`, `asChild`), or while the row's trigger button has focus and matches `:focus-visible` (tracked with `onFocus` and `onBlur` on the trigger). The icon span is not focusable, so no tab stop is added (SC-003). Tooltip text is the raw id (`resolveToolDisplay().rawId`).
- **Rationale**: FR-011 needs both hover and keyboard focus without a new tab stop; Radix only opens on the trigger's own focus, so the row's focus state has to drive `open`. The app already wraps the root in `TooltipProvider` (`src/renderer/main.tsx`).
- **Alternatives considered**: a native `title` attribute. Rejected: no keyboard focus behaviour and not the shared component. Making the icon focusable. Rejected: adds a tab stop per row.

## Decision 9: keep the intent out of the target

- **Decision**: `first_string_arg` in `src-tauri/src/omp/transcript.rs:350` skips the keys `i` and `intent`.
- **Rationale**: `serde_json` is built without `preserve_order`, so an object's keys iterate sorted and `i` sorts before most argument names. For tools that fall through to `first_string_arg` (`wait`, unknown and MCP tools, `ast_grep`, `lsp` and others), the target, and so the row summary, would repeat the intent next to the label. FR-018 needs `wait`'s summary to be what it waits for.
- **Alternatives considered**: stripping `i` from `args` before storing them. Rejected: the tool-call dialog shows the full arguments and should stay faithful.

## Decision 10: the setting rides the existing transcript display path

- **Decision**: add `toolNames: boolean` to `TranscriptDisplaySettings` (`src/shared/transcriptDisplay.ts`), default `false` in `DEFAULT_TRANSCRIPT_DISPLAY`; mirror it in Rust (`src-tauri/src/store/settings.rs`, `#[serde(rename = "toolNames", default)] tool_names: bool`, parse default `false`, setter arm `"toolNames"`) and add `"toolNames"` to the field allow-list and error message in `src-tauri/src/ipc/settings.rs:308-311`. The renderer reads it with `useSettingsStore((s) => s.settings.transcriptDisplay.toolNames)` in the row parts. The switch is a `SettingSwitchRow` after "Show tool calls" in `ChatDisplaySection.tsx`.
- **Rationale**: `setTranscriptDisplay(field: keyof TranscriptDisplaySettings, visible)` already takes one field at a time, so no IPC channel changes and `pnpm check:parity` stays green. Settings saved before this change have no `toolNames` key and read as `false`.
- **Alternatives considered**: a new top-level setting and channel. Rejected: more surface, same behaviour.

## Decision 11: grouping key

- **Decision**: `groupToolItems.ts` (about `:87`) compares `resolveToolDisplay(item.tool, item.target).key` instead of `item.tool`, so `write xd://a`, `write xd://b` and plain `write` never share a group (FR-013). Skill rows keep their #543 boundary unchanged.
- **Rationale**: one key from one resolver; no special case in the grouper.
- **Alternatives considered**: grouping on `tool + target`. Rejected: it would stop plain `read` calls on different files from grouping.
