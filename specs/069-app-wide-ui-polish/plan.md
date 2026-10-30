# Plan: spec 069

Renderer only. Shared pieces first, call sites second.

1. `components/ui/select.tsx`: shared trigger, chevron, item and panel constants; `MultiSelectChecklist` adopts them.
2. `globals.css`: `--field-border`, `--field-ring-width`, `--ghost-edge` per theme; `.titlebar-surface` transparent.
3. `input.tsx`, `textarea.tsx`: quiet classes. Browse buttons to `ghost`.
4. `button.tsx` `ghost-destructive`; `CardFooter` right-aligned; chat cards, comment box, Appearance and Memory triage rows reordered.
5. Chrome: `SessionList` header removed, `HolidayAccessory`, `IconRail`, `AppMenuBar`, `layout.ts`.
6. Docs: `components.md`, `accessibility.md`, `foundations-tokens-theming.md`, `PLAN.md`.
