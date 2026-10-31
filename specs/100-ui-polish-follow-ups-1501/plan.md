# Plan: spec 100

Specify route, chore-sized. Clarifications are the issue's decided comment (no open questions).

- Renderer shared: `ui/select.tsx`, `ui/composerFocus.ts` (new), `ui/input.tsx`, `ui/textarea.tsx`, `ui/copy-button.tsx`, `IconButton.tsx`; importers of the moved focus constants.
- Renderer features: `PullRequestDetail.tsx`, `IssueDetail.tsx`, `IssueList.tsx`, `ProjectListPane.tsx`, `ManageSessionsToolbar.tsx`, `NewSessionDialog.tsx`.
- Docs: `docs/design/components.md`.
- Script: `scripts/verify-tauri-100.mjs`.
- Risk: the stacked `aria-invalid:focus-visible:border-destructive` variant must outrank `focus-visible:border-ring`; verified live on all three field types.
