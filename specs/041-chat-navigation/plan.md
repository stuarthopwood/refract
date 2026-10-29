# Plan: Chat navigation (wave 4)

Spec: `spec.md`. ADR: `docs/adr/0005-one-message-index-for-chat-navigation.md`. One PR; work packages run strictly in order, one worker at a time, because `Transcript.tsx` and `ChatHeader.tsx` are collision files.

1. **WP-A Foundation (#750)**: `src/renderer/state/chat-nav-store.ts` (per-session index and bridge), `features/chat-nav/` (`messageIndex.ts` pure builder over `TranscriptItem[]`, `jumpToMessage.ts`, `useRegisterScrollBridge.ts`). `Transcript.tsx` registers the bridge and reveals windowed turns on request; extract code out of `Transcript.tsx` as needed so it does not grow past baseline 1059. Probe first: which `row.id` carries a user message or an `assistant-text` item after `groupMidTurnProse` grouping, and what `MessageScrollerItem` ids exist for Note rows.
2. **WP-B Previous/Next (#751)**: shared `FloatingControlStack` style layer in `components/`, `MessageStepButtons`, scroll-reveal hook, Alt+Up/Down in transcript and composer, Scroll to end glyph change in `message-scroller.tsx`.
3. **WP-C Outline (#752)**: `'outline'` in `PanelId` and last in `HOSTED_PANELS`, `OutlinePanel` with the shared panel header, `react-virtuoso` list, roving tabindex.
4. **WP-D Search (#753)**: `chat-nav-search` store, matcher (chunked, cancellable), `FindBar` floating layer, results list, Custom Highlight API painter, Ctrl+F handler scoped to chat panes, header ghost icon in `ChatHeader.tsx`.
5. **WP-E Map (#754)**: canvas `ScrollbarMap`, offsets from the DOM, hit-test, tooltip, stub, Settings toggle in the Chat group (`settings-store.ts`, Settings Chat group).
6. **WP-F Contrast and docs**: pairs in `scripts/theme-contrast-pairs.mjs`, tokens in `globals.css`, `docs/design/components.md`, `docs/PLAN.md` row.

Shared files touched additively: `Transcript.tsx` (bridge registration only, plus extractions), `ChatHeader.tsx`, `ChatPane.tsx` (Ctrl+F scope; may only shrink), `message-scroller.tsx`, `panel-registry.ts`, `globals.css`, `scripts/theme-contrast-pairs.mjs`, `settings-store.ts`.

Build slot: no cargo or tauri command until the director grants it. Typecheck, vitest and node scripts are fine. Rust is not expected to change.
