# Plan: spec 074

Renderer only; no IPC, Rust or state changes.

1. Add `src/renderer/components/InlineStatus.tsx`.
2. Extend `src/renderer/components/ConfirmAlertDialog.tsx` (props listed in spec.md).
3. Swap call sites: FileExplorerPanel, FilePreviewPane, GitChangesPanel, ChangesTab, Timeline, PullRequestDetail, RepositoryGroup, IssueLabelPicker.
4. Migrate dialogs: SignOutDialog, MergeDialog, RemoveRepositoryDialog, the PullRequestDetail fork warning, GitChangesFileRow.
5. Docs: `docs/design/components.md`, `docs/PLAN.md`.
6. Verify: `pnpm ci:local`, live check, review gate.
