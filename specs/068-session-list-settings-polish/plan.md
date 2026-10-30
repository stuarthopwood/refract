# Plan 068

Touched files by issue.

- #1422: `features/sessions/GroupHeader.tsx` (new `GroupHeaderRow`, trigger loses its hover fill), `RepositoryGroup.tsx`, `ArchivedGroup.tsx`, `features/right-pane/git-changes/GitChangesGroup.tsx`.
- #1416: `features/sessions/ShowHiddenToggle.tsx`, `state/init-stores.ts`.
- #1418: `features/sessions/SessionDetailsCard.tsx`.
- #1420: new `components/revealAction.ts`; `path-actions.tsx`, `SessionDetailsCard.tsx`, `sessionActions.ts`, `Markdown.tsx` (`FileLinkButton`, minimum lines); `docs/design/foundations-icons.md`, `product-layout.md`.
- #1428: `components/ui/count-badge.tsx`, `features/right-pane/IconRail.tsx`.
- #1424: `features/settings/AppearanceSection.tsx`, `ThemePicker.tsx`, `ChatWidthPicker.tsx`, `state/theme-store.ts`, `state/chat-width-store.ts`.
- Docs: `docs/PLAN.md` rows for the six issues.

No new tests. Verification: `pnpm ci:local`, `pnpm check:ui-text`, live run.
