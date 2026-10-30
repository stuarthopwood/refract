# Plan 058: Switching motion

Design: CSS utilities in `globals.css` on `tw-animate-css`, plus one hook `src/renderer/components/useEnterOnSwitch.ts` (beside `useWindowVisible.ts`). The hook toggles a utility class with a forced reflow to restart the animation on an existing element, so nothing remounts and scroll or state is preserved. Baseline-capped TSX files (`App.tsx`, `ChatPane.tsx`, `MessageInput.tsx`, `Transcript.tsx`) must not grow: edits there add attributes to existing elements, and any new lines are offset by removals.

Constitution check: no new dependency, shared hook and classes, no new tests (prototyping), Tauri security baseline untouched (renderer only).

Order: tokens and utilities, hook, view and session switch, right pane and tabs, pills, session list, settings, dialog audit, docs.
