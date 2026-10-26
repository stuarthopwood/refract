# Implementation Plan: Lighter font weights and sentence-case action verbs

**Branch**: `stuarthopwood-feat-1208-font-weights-verbs` | **Date**: 2026-10-26 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/022-font-weights-verbs/spec.md`

## Summary

A renderer-only change. A new module `src/renderer/features/chat/toolVerbs.ts` maps tool ids to sentence-case verbs (running and done forms) with a sentence-case fallback; `ToolRow`, `ThoughtRunRow`, `SkillPromptRow`, `RequestCard` and `Transcript`'s live announcement use it, and trailing colons go. The shared row label in `CollapsedLine` drops to 400 and gains a stable `data-slot`, which lightens every transcript row at once. Shared `components/ui` primitives (Badge, Button ghost and link variants, menu labels, Kbd, Message metadata, sidebar labels and badges) move to the scale, then every remaining `font-medium`/`font-semibold`/`font-bold` use is set from the inventory in [research.md](./research.md). The scale is recorded in `docs/design/foundations-typography-spacing.md`. Nothing crosses IPC.

## Technical Context

**Language/Version**: TypeScript 5 / React 19, Tailwind CSS 4
**Primary Dependencies**: existing `components/ui/*` (class-variance-authority variants), `features/chat/CollapsedLine.tsx`, `features/chat/toolStatus.tsx`, `features/chat/formatToolCommand.ts`
**Storage**: none
**Testing**: existing gates only (`pnpm typecheck`, `pnpm test`, `pnpm check:indent`, `pnpm check:ui-text`, `pnpm check:theme-contrast`, `pnpm check:file-size`). No new tests (prototyping rule, 2026-10-08). No existing vitest test asserts a font class or tool label ([research.md](./research.md) Decision 5). Live check at the end on a scratch Tauri debug build.
**Target Platform**: Windows desktop (Tauri v2, WebView2); font Segoe UI Variable Text
**Project Type**: desktop app, renderer only
**Performance Goals**: none new; the verb lookup is a constant-time map read per row render
**Constraints**: 600-line cap (issue #806), `ToolRow.tsx` is at 599; reusable components first (ADR 0003, `docs/design/components.md`); no `types.ts`/`constants.ts` dumping ground
**Scale/Scope**: 132 weight uses, 88 of them changed; 6 label sites changed to verbs

## Constitution Check

- I (OMP is the engine): no change to how OMP is driven; tool ids still come from OMP frames unchanged. PASS.
- II (RPC wire contract): no frame or command changes. PASS.
- III (Session and process lifecycle): untouched. PASS.
- IV (Evidence before design): every file and line in the inventory was read from `origin/main` on 2026-10-26; the label selectors used by live-check scripts were found by grep before deciding on `data-slot`. PASS.
- V (Tauri security baseline): no new command, capability, channel or event. Tool names from OMP are rendered as text through React (no `innerHTML`), as today. PASS.

## File-size plan (issue #806)

| File | Now | Plan |
|---|---|---|
| `features/chat/ToolRow.tsx` | 599 | Net growth at most one line (the `toolVerbs` import). Status-prefix and verb logic lives in `toolVerbs.ts`. If the edit cannot fit, first move `SubagentRow` (`:575-599`) unchanged into `SubagentRow.tsx`. |
| `features/chat/CollapsedLine.tsx` | 309 | Class and attribute edit in place |
| `features/chat/ThoughtRunRow.tsx` | 254 | Two label expressions use the map |
| `features/chat/Transcript.tsx` | 1059 (baselined) | One expression at `:870` in place; no growth |
| `features/chat/ChatPane.tsx` 1445, `Markdown.tsx` 997, `profile/ManageAccountsDialog.tsx` 720, `profile/ManageSessionRow.tsx` 662 | baselined | Class edits in place; no growth |
| `scripts/verify-570-tool-colours.mjs` 600, `verify-700-pill-cards.mjs` 600, `verify-632-grouped-calls.mjs` 673 (baselined) | at or over cap | Selector edits in place only |
| `features/chat/toolVerbs.ts` | new | About 40 lines |

## Project structure

```text
src/renderer/features/chat/toolVerbs.ts        # new: TOOL_VERBS, toolVerb(), sentenceCaseToolName(), toolAriaPrefix()
src/renderer/features/chat/CollapsedLine.tsx   # label 400 + data-slot="collapsed-line-label"
src/renderer/features/chat/{ToolRow,ThoughtRunRow,SkillPromptRow,RequestCard,Transcript}.tsx
src/renderer/components/ui/{badge,button,context-menu,dropdown-menu,kbd,message,sidebar}.tsx
src/renderer/components/SettingFieldRow.tsx
src/renderer/features/**                         # inventory sweep, phases C and D
docs/design/foundations-typography-spacing.md    # weight scale and verb rule
scripts/verify-*.mjs                              # selector update only (research.md Decision 4)
```

## Design

1. **Verb map** (`toolVerbs.ts`): see [research.md](./research.md) Decision 2. Also exports `toolAriaPrefix(status: RowStatus): string | undefined`, returning `toolStatusLabel(status)` for `error`, `interrupted`, `cancelled` and `exited`, and `undefined` for `running` and `done` (Decision 3).
2. **Tool rows** (`ToolRow.tsx`): `:210` label `item.tool` becomes `toolVerb(item.tool, phase)`; `:343` `'Using skill:'` becomes `toolVerb('skill', phase)`, `solo ? last.tool : group.tool` becomes the verb; `:348` grouped label `${group.tool} ×N` becomes `${verb} ×N`; aria names at `:198-201` and `:393-404` become `[toolAriaPrefix(status), verb, summary]` joined with spaces, keeping the existing command-style branch (no visible label, verb only in the name). `:590` (subagent name) is not a tool id and is unchanged.
3. **Thought rows** (`ThoughtRunRow.tsx`): `:216` (label) and `:210` (accessible name) take "Thinking" and "Thought process" from the map; `thoughtLabel` at `:37` uses the map's "Thinking" and keeps its duration forms.
4. **Colon labels**: `SkillPromptRow.tsx:28` "Skill invoked", `RequestCard.tsx:293` "Asked user".
5. **Live announcement**: `Transcript.tsx:870` uses `toolVerb(row.tool, 'running')`.
6. **Row label weight**: `CollapsedLine.tsx:163` drops `font-medium`, adds `data-slot="collapsed-line-label"`; the label keeps the body colour by default and callers' `labelClassName` colours (error, success, agent message) still apply.
7. **Shared primitives**: per the Phase B table in research.md.
8. **Sweep**: per the Phase C and D tables in research.md, one folder group per task.
9. **Docs**: `docs/design/foundations-typography-spacing.md` gets a "Font weight scale" section (the table from FR-007), line 24 changes "medium weight" to "regular weight", line 39 changes `font-medium` to `font-normal`; a "Action labels" bullet under "Case and label style" states the verb rule and points to `toolVerbs.ts`. `docs/design/product-chat.md:22` "Asked user:" becomes "Asked user".

## Phases and lanes

Implementation runs as narrow slices with disjoint file sets ([tasks.md](./tasks.md)): A (verbs and row label), B (shared primitives), C (chat transcript rows), D1 to D4 (app-wide sweep by folder), E (docs), F (live-check script selectors and verification). B, C and D1 to D4 can run in parallel once A has landed (C and D depend on A only for the row label; B is independent). E can run any time. F runs last.

## Complexity tracking

None.
