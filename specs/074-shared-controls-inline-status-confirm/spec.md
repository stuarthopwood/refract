# spec 074: Shared controls, inline status text and confirm dialogs (#935)

Two of the #935 audit groups move onto shared components (ADR 0003): bare inline loading, error and empty text (`InlineStatus`), and hand-built confirm dialogs (`ConfirmAlertDialog`).

## Clarifications

### Session 2026-10-30 (self-grill, Skippy delegated by Stuart; ui-architect-v3 ruling recorded in the gate)

- Q: Which groups? [Decided] Inline status text and confirm dialogs: the two with the most call sites and no overlap with the spec 073 files. Left for later: icon button plus Tooltip, StatusIndicator, count and tag pills, listbox popovers, refresh, EmptyState compound sites.
- Q: One component for loading, error and empty lines? [Decided] `InlineStatus` with `tone` (info, loading, error) and `density` (block, compact). The role follows the tone: error is `alert`, loading is `status`, info has none.
- Q: Extend or fork the confirm dialog? [Decided] Extend `ConfirmAlertDialog`: `cancelLabel`, `size`, `error`, a `children` body slot, `cancelRef`, `onOpenAutoFocus`, optional `confirmLabel` (omitted means an info dialog), and `onCloseAutoFocus` may return `false` to let Radix restore focus.
- Q: Confirm button variant? [Decided] The shared default (`invert`) applies; Merge and the fork warning change from the default variant. Destructive dialogs pass `destructive`.
- Q: DeleteDialog, ReviewDialog, ContextShakeMenu? [Decided: defer] Each has a bespoke body (leftover list, review form, no busy state). They go in the follow-up issue.
- Q: Spec 073 files? [Decided] `RightPaneShell.tsx` subagent status stays untouched.

## Functional requirements

- FR-1: Loading, error and empty lines in the Files, Git changes, Pull request, Session list and issue label surfaces render through `InlineStatus` with identical type scale and roles.
- FR-2: Sign out, Merge, Remove project, the fork warning and the conflict-resolve dialog render through `ConfirmAlertDialog` with no behaviour change except the confirm variant in FR-3.
- FR-3: Merge and the fork warning use the shared confirm variant.
- FR-4: Focus returns to the trigger on close exactly as before.

## Success criteria

- `pnpm ci:local` passes; no new tests; no file grows past its baseline.
- The live check opens the migrated dialogs and states in a debug build.
