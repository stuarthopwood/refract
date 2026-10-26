# Implementation Plan: Tool-row icons with verb tooltips

**Branch**: `stuarthopwood-feat-469-tool-row-icons` | **Date**: 2026-10-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/023-tool-row-icons/spec.md` (issue #469)

## Summary

Every tool row and tool group row gets the tool's icon in its leading slot and moves the status icon to the trailing status and duration slot. The row label becomes the call's intent (a short, model-written description that OMP already sends), or, when there is none, the verb from spec 022's shared verb map: the running form, the done form, or a new base form for calls that did not complete. Raw tool ids leave the visible rows; they stay in a tooltip on the tool icon, in the tool-call dialog title, and, behind a new Settings switch "Show tool names on rows" (off by default), muted after the label.

Technical approach:

- Extend the one verb map (`src/renderer/features/chat/toolVerbs.ts`) in place with an icon and a base form per entry; add a sibling resolver for MCP, `xd://` writes and unknown tools.
- Carry the intent from OMP to the renderer as a new optional, sanitised `intent` field on the transcript tool item, read in Rust from the live start frame and from history and snapshot `toolCall` arguments ([FINDINGS item 64](../../docs/spike/FINDINGS.md)).
- Add `toolNames` to the existing transcript display settings and its existing one-field setter, so no new IPC channel is needed.
- Build the icon from one shared `ToolIcon` component and the icon tooltip from the shared Radix tooltip.

## Technical Context

**Language/Version**: TypeScript 5 and React 19 (renderer, `src/renderer`, `src/shared`); Rust 2021 (Tauri v2 host, `src-tauri/`)

**Primary Dependencies**: lucide-react 1.49.0 (icons), radix-ui (tooltip, switch), serde and serde_json (Rust frame mapping). No new dependency.

**Storage**: the existing settings JSON in the Refract data directory (`transcriptDisplay` object gains `toolNames`); OMP session files are read only, as today.

**Testing**: no new tests (prototyping rule, 2026-10-08). Existing vitest and `cargo test` suites must keep passing; Rust tests that build `TranscriptItem::Tool` literals and the settings tests get the new field where they no longer compile. Gate of record: `node scripts/ci-local.mjs`; live check with a scratch debug Tauri build through `scripts/verify-tauri.mjs`.

**Target Platform**: Windows desktop (Tauri v2, WebView2), the five built-in themes.

**Project Type**: desktop app (Rust host plus React renderer).

**Performance Goals**: no measurable change to transcript render cost; the map lookup is a frozen-object read per row. The Settings switch applies to every visible row within one second (SC-006).

**Constraints**: 600-line soft cap per source file and the baseline in `scripts/file-size-baseline.json` (see the file-size plan below); reusable components first (`docs/design/components.md`); intent is untrusted text (constitution Principle V); no new IPC channel, so `pnpm check:parity` stays green.

**Scale/Scope**: 21 map entries (FR-003), about 16 source files touched, 4 new renderer modules (`toolDisplay.ts`, `toolRowParts.tsx`, `SubagentRow.tsx`, `ToolIcon.tsx`), 1 new Rust module.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. OMP is the engine, Refract is the host**: Refract only reads fields OMP already sends (`intent`, `arguments.i`); it does not ask OMP for anything new or change how a turn runs. PASS.
- **II. RPC wire contract**: no new frame, command or field sent to OMP. The approval card title still starts with `Allow tool:` and its text is unchanged (FR-016). PASS.
- **III. Session and process lifecycle**: untouched. PASS.
- **IV. Evidence before design**: both intent field shapes (live top-level `intent` on `tool_execution_start`; history and snapshot `arguments.i`) were observed on 2026-10-26 in OMP 18.12.6 and in session files written by 18.12.x, and recorded as [FINDINGS item 64](../../docs/spike/FINDINGS.md). Every file and line in this plan was read at `d3957363` on 2026-10-26. PASS.
- **V. Tauri security baseline**: no new command, capability, channel or event; the settings setter keeps its field allow-list (it gains `toolNames`). The intent is untrusted model text: Rust strips control and bidirectional override characters, folds it to one line, trims it and caps it at 400 characters before it crosses the IPC boundary, and the renderer renders it as a React text node (no `innerHTML`, no link detection). PASS.

Post-design re-check (after research and data model): unchanged, PASS. No Complexity Tracking entry is needed.

## File-size plan (issue #806)

Counts at `d3957363`. The cap is 600; a baselined file must never grow.

| File | Now | Plan |
|---|---|---|
| `src/renderer/features/chat/ToolRow.tsx` | 598 | First move `SubagentRowProps`, `SubagentBody` and `SubagentRow` (`:499-598`, with their comment blocks) unchanged into a new `SubagentRow.tsx`, freeing about 80 lines. Row-label, meta and aria assembly go in a new `toolRowParts.tsx`, not here. |
| `src/renderer/features/chat/RequestCard.tsx` | 600 (not baselined) | Must stay at or under 600. The icon goes on the title line (`:407`) as one JSX node; trim or merge one comment line to pay for the import. |
| `src/renderer/features/chat/SubagentChainRow.tsx` | 588 | Import path change only (`./SubagentRow`); no growth. |
| `src/shared/model.ts` | 656 (baseline 656) | No net growth: adding `intent?: string` to the tool item costs one line, paid by shortening a comment in the same block (for example `:116`). |
| `src-tauri/src/omp/transcript.rs` | 1750 (baseline 1813) | May grow up to the baseline but should not: sanitising and reading logic goes in a new `src-tauri/src/omp/transcript/tool_intent.rs`; `transcript.rs` gains only the field, the call sites and the `mod` line. |
| `src/renderer/features/chat/CollapsedLine.tsx` | 309 | Grows by about 30 lines (icon tooltip wrapper and focus-visible state). |
| `src/renderer/features/chat/toolVerbs.ts` | 46 | Grows to about 110 lines (21 entries with icon and base form). |
| `src/renderer/features/chat/Transcript.tsx` | 967 (baseline 1059) | Not expected to change; if it does, no growth. |

## Project Structure

### Documentation (this feature)

```text
specs/023-tool-row-icons/
├── spec.md              # Feature spec (specify and clarify, amended 2026-10-26)
├── plan.md              # This file
├── research.md          # Phase 0 decisions
├── data-model.md        # Phase 1 entities and fields
├── quickstart.md        # Phase 1 live-verify guide
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

No `contracts/` folder: the feature adds no external interface. The only boundary change is one optional field on an existing IPC payload and one field on an existing settings setter, both described in [data-model.md](./data-model.md).

### Source code (repository root)

```text
src-tauri/src/
├── omp/transcript.rs                 # TranscriptItem::Tool gains `intent`; start-frame and history/snapshot sites set it
├── omp/transcript/tool_intent.rs     # NEW: read_live_intent, read_history_intent, sanitize_intent
├── omp/diff.rs                       # Tool literal gains `intent: None`
├── store/settings.rs                 # transcript display gains `tool_names` ("toolNames"), default false
├── store/settings_tests.rs           # only if a literal stops compiling
└── ipc/settings.rs                   # setter allow-list gains "toolNames"

src/shared/
├── model.ts                          # tool item gains `intent?: string` (no net growth)
└── transcriptDisplay.ts              # `toolNames: boolean`, default false

src/renderer/
├── components/ToolIcon.tsx           # NEW: shared tool icon, reads the map, aria-hidden, muted or error tone
├── features/chat/toolVerbs.ts        # extended: icon and base form per entry, base form for non-complete statuses
├── features/chat/toolDisplay.ts      # NEW: resolveToolDisplay (MCP, xd:// writes, unknown), display key, raw-id text
├── features/chat/toolRowParts.tsx    # NEW: row label (intent or verb), raw-id span, trailing meta, aria name
├── features/chat/SubagentRow.tsx     # NEW: SubagentBody and SubagentRow moved unchanged from ToolRow.tsx, then Users icon
├── features/chat/CollapsedLine.tsx   # optional icon tooltip (hover on icon or trigger focus-visible)
├── features/chat/ToolRow.tsx         # ToolCallRow and ToolGroupRow wired to the above
├── features/chat/formatToolCommand.ts# bash and grep summaries without `$` or `grep` prefix; command-style rows keep a label
├── features/chat/groupToolItems.ts   # runs keyed on the display key
├── features/chat/SubagentChainRow.tsx# import path change only
├── features/chat/RequestCard.tsx     # ToolIcon beside "Allow tool: <id>"
└── features/settings/ChatDisplaySection.tsx # "Show tool names on rows" switch
```

**Structure decision**: the existing Tauri plus React layout. New logic goes in new modules beside the files at the cap; the one verb map is extended, not copied.

## Design

1. **Verb map** (research decisions 3 and 4): each `TOOL_VERBS` entry becomes `{ icon, running, done, base }` (thinking keeps `{ running, done }` with no icon). `toolVerb(tool, status)` returns running for `running`, done for `done`, and base for `error`, `interrupted`, `cancelled` and `exited`; a tool with no entry returns `sentenceCaseToolName(tool)` in every status. `find` and `glob` share one entry object; `recall`, `retain` and `reflect` share the Database icon. The skill entry is looked up by the existing skill-row path, not by raw tool id.
2. **Display resolver** (`toolDisplay.ts`, decision 5): `resolveToolDisplay(tool, target)` returns `{ key, icon, rawId, entryTool }`. `mcp__x` gives Plug and the sentence-cased name with the prefix removed ("Tool" when empty); a `write` whose target starts `xd://` resolves to that tool's entry (Wrench and sentence-case name when unknown), key `xd:<tool>`, raw id `write xd://<tool>`; any other unmapped tool gives Wrench. `key` is what `groupToolItems.ts` groups on (FR-013).
3. **Intent** (decisions 1 and 2): Rust reads the live intent from `frame.intent`, then `args.i`, then `args.intent`, and the history or snapshot intent from `arguments.i`, then `arguments.intent`; `sanitize_intent` removes C0 and C1 control characters and bidirectional formatting characters (U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069), collapses whitespace to single spaces, trims, and caps at 400 characters; empty becomes `None`. A merge never replaces an existing intent with `None`. `first_string_arg` skips the `i` and `intent` keys so an unmapped tool's target never repeats the intent (decision 9).
4. **Row assembly** (`toolRowParts.tsx`, decision 6): label = intent or `toolVerb`; with the setting on, a muted raw-id span leads the summary slot (so it truncates with the target, before the label); `meta` = trailing `StatusIcon` then duration; accessible name = `toolAriaPrefix(status)` (spec 022's rule: a status word only for `error`, `interrupted`, `cancelled` and `exited`, whether the label is an intent or a base form), then the label, the raw id when the setting is on, and the target. Command-style rows (`bash`, `grep`) now show their label; their summaries drop the `$ ` and `grep ` prefixes.
5. **Icon and tooltip** (decisions 7 and 8): `ToolIcon` renders the mapped lucide glyph, `aria-hidden`, `size-4`, `text-muted-foreground`, or `text-severity-error` when the status is `error`. `CollapsedLine` gains an optional `iconTooltip` string: the icon slot is wrapped in the shared `Tooltip` with a controlled `open` that is true while the pointer is over the icon or while the row trigger matches `:focus-visible`. The trigger adds no tab stop.
6. **Setting** (decision 10): `transcriptDisplay.toolNames` (default false) uses the existing `setTranscriptDisplay(field, visible)` path end to end; the switch row is `SettingSwitchRow`, placed after "Show tool calls" in `ChatDisplaySection.tsx`.
7. **Other surfaces**: `RequestCard` shows `ToolIcon` before the unchanged title text; `SubagentRow` (one agent inside a Stage) takes the Users icon in its leading slot and moves its `SubagentStatusGlyph` into the trailing `meta`, ahead of the duration (FR-017); the Stage row and the "Subagents" chain row are not subagent rows and keep their status glyph where it is; the tool-call dialog title is unchanged (FR-019); thought rows are unchanged (FR-022).

## Complexity Tracking

No constitution violations to justify.

| Violation | Why needed | Simpler alternative rejected because |
|---|---|---|
| None | | |
