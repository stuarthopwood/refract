# Implementation Plan: Checklist right-pane panel (#2012)

**Branch**: `feat/checklist-panel-2012` | **Date**: 2026-11-20 | **Spec**: [spec.md](./spec.md)
**Input**: spec 139; protocol in [ADR 0011](../../docs/adr/0011-checklist-protocol.md) and the [design](../../docs/design/checklist-protocol.md); store from spec 138.

## Summary

A hosted `'checklist'` panel renders the active Checklist of the front Session. A renderer store (`state/checklist-store.ts`) keeps one active checklist per Session with rev ordering, subscribes to `checklist:update` from `init-stores.ts`, hydrates from `checklist.get`, auto-opens the panel, and runs tick/untick through `checklist.mutate` without optimism. A small backend change (first) adds a per-Session `toolUnavailable` flag and changes `checklist.get` to `{checklist, toolUnavailable}`. Shared changes: `CHECKBOX_BOX_ONLY_CLASS`, four contrast pairs, the widened nav-highlight CSS.

## Technical Context

- Renderer: React + Zustand + Vitest, co-located `*.test.ts(x)`. Rust: Tauri, `#[path]` test files as in `ipc/checklist.test.rs`.
- Touched existing files (all re-read in T001): `src/shared/ipc-checklist.ts`, `src/renderer/tauri-bridge/checklist.ts` (get wrapper; `mutate` shape untouched, so #2013 does not conflict), `src-tauri/src/ipc/checklist.rs`, `checklist.test.rs`, `src-tauri/src/checklist/store.rs`, `src-tauri/src/agent_tools/mod.rs` (refusal site, line 114), `agent_tools/panels.rs`, `specs/124-tool-channel-1193/contracts/panel-actions.json`, `features/right-pane/panel-registry.ts`, `RightPaneShell.tsx`, `state/init-stores.ts`, `components/ui/checkbox.tsx`, `scripts/theme-contrast-pairs.mjs`, `styles/globals.css`, `features/chat-nav/highlightRow.ts` (consumed, not changed).
- New files: `state/checklist-store.ts` (+ test), `features/right-pane/checklist/` with `ChecklistPanel.tsx`, `ChecklistRow.tsx`, `checklist-status.ts`, `useChecklistAnnouncer.ts`, `reveal.ts`, each with a co-located test. #2013 adds its controls into `ChecklistRow.tsx` afterwards.
- Hash/crate or dependency additions: none.

## Design

- **Backend flag.** `ChecklistStore` keeps `tool_unavailable: HashSet<SessionId>` guarded like the existing per-Session state; `set_tool_unavailable(id)`, `clear_tool_unavailable(id)`, dropped on Session removal. `agent_tools/mod.rs:114` sets it beside the warn; a successful call clears it. `get_with` returns `{checklist, toolUnavailable}`. The renderer type `ChecklistGetResult` lives in `ipc-checklist.ts`; the Rust golden/parity test names the key.
- **Store shape.** `bySession: Record<sessionId, {checklist: Checklist | null, toolUnavailable: boolean, pending: Record<itemId, true>, refusal: Record<itemId, {code, message, status?}>}>`, `revealRequest: {sessionId, checklistId, itemId} | null`. `applyUpdate(payload)` drops when `checklist.rev <= held.rev` for the same `checklistId`; a different `checklistId` replaces (and flags `replaced` for the announcer). `hydrate(sessionId)` calls `get`. `mutateItem(sessionId, op)` captures `sessionId` and `baseRev` at call time and applies the result to that Session only.
- **Auto-open.** In `init-stores.ts`, one `checklist:update` listener: always `applyUpdate`; if `opened === true` and the Session is front (via `frontSessionIdOf`), call `openPanel('checklist', {focus:false})` only when absent from `openPanelIds`. A front-Session subscription calls `hydrate`.
- **Panel.** `ChecklistPanel` renders `<ol>` of `ChecklistRow`, a mounted polite live region, the tool-unavailable and error states, and the focus move on replace. `ChecklistRow` renders the box-only tick (`CHECKBOX_BOX_ONLY_CLASS`), status glyph and word, text, value, `completedBy`, reason text and the `role=alert` refusal. Row root carries `data-nav-highlight` support and `outline-offset:-2px`.
- **Status map.** `CHECKLIST_STATUS_GLYPH` in `checklist-status.ts`; complete composes `STATUS_GLYPH['success-done']`.
- **Reveal consumer.** `reveal.ts` exports `useRevealRequest(sessionId, activeChecklistId, rowRefs)`; it calls `flashRowHighlight` and clears via `clearReveal`.
- **Announcer.** Compares previous and next checklist per Session and emits open, replace, and per-item changes made by the agent (`updatedBy === 'agent'`); developer ticks announce nothing extra.

## Risks and notes

- Changing the `checklist.get` result shape touches every caller; T005 enumerates them with grep and migrates all in the same commit (no shim).
- `openPanel` side effects (`right-pane-store.ts:67-81`) are why auto-open guards on `openPanelIds`.
- Contrast: `state-working` and `severity-success` can fail on some presets on `sidebar-right`; if the new pairs fail, T007 fixes the usage (icon colour class) rather than loosening the minimum.
- `globals.css` and `ChecklistRow.tsx` are touched again by #2013; this lane stays under 400 lines per file.
- Live check follows `docs/rust-build.md` isolation and `skill://verify-refract-tauri-build-live`.

## Constitution / repo rules
Testing rule V1 (co-located unit tests, guard-mutation proof), comments say why only, files under 600 lines, no hard-coded hex, no baseline additions.
