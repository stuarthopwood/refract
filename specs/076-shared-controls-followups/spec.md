# spec 076: Shared-control follow-ups (#1461) and transcript-menu follow-ups (#1454)

Finishes the deferred dialog migrations and review leftovers from spec 074 (#935), and the performance and keyboard leftovers from the transcript menus (spec 065, #471). Renderer plus one Rust refactor; no IPC shape change.

## Clarifications

### Session 2026-10-30 (self-grill, Skippy delegated by Stuart; ui-architect-v3 rulings recorded on #1461 and #1454)

- Q: Confirm button variant? [Decided: `default`] `invert` was made for the neutral Stop button; a confirm is the primary action and keeps the theme colour (Obsidian, Nordic Frost, Cyber Amber). Destructive stays destructive.
- Q: ReviewDialog? [Decided] The compose step stays a form `Dialog`; only the Approve and Request changes confirm step moves to `ConfirmAlertDialog`.
- Q: DeleteDialog? [Decided] Moves to `ConfirmAlertDialog` (bullets, status, leftover list as `children`; `error` through InlineStatus; `confirmDisabled` while the check loads). The first-sentence error emphasis is dropped.
- Q: ContextShakeMenu open paths? [Decided] Right-click, Shift+F10 and the Menu key open the same menu as click (controlled `DropdownMenu`); no kebab, the readout is already the trigger. Its confirm moves to `ConfirmAlertDialog`.
- Q: `cancelRef` and `onOpenAutoFocus`? [Decided: remove] Radix `AlertDialog` already focuses Cancel on open; SignOutDialog's override is redundant.
- Q: Busy fieldset? [Decided] Replace `fieldset disabled` with a labelled `role="group"` (`bodyLabel`); busy blocks input through `aria-disabled`, so focus is never dropped. `aria-busy` is dropped.
- Q: Transcript kebab? [Decided] A `TranscriptMenuButton` ("More actions") opens the same menu as right-click. Tool row: end of the header, shown on hover, focus or open. Code block header: last control, always visible. Message row: after Copy, same reveal as Copy, never while streaming.
- Q: Copy feedback? [Decided] Inline `CopyButton` keeps the check icon plus polite announcement; menu items keep the sonner toast; wording is the same on both, failures go through `notify`. All copy items use `CopyIcon`.
- Q: Lazy mount? [Decided] The per-message menu and ghost Copy mount on first pointer or focus entry.
- Q: Not in this spec? [Decided] The remaining #935 groups, and the other #1454 UI items (Toggle contrast, 8px grid, moving TranscriptMenu to components/, BlockActionBar, "Copy as Markdown" rename, enlarged targets, image-only keyboard anchor), go to one follow-up issue.

## Functional requirements

- FR-1: `ConfirmAlertDialog` loses `cancelRef` and `onOpenAutoFocus`, right-aligns a lone button, renders the error through `InlineStatus`, labels its body group, drops `aria-busy`, and uses the `default` confirm variant.
- FR-2: Merge shows "Retry" after an error and clears the error when the method changes; the fork warning is split into short lines and uses `size="md"`; ReportIssueDialog's `busyLabel` shows.
- FR-3: DeleteDialog, the ReviewDialog confirm step and the ContextShakeMenu confirm render through `ConfirmAlertDialog` with unchanged behaviour (busy guards, focus return).
- FR-4: Right-click, Shift+F10 and a click all open the Context shake menu.
- FR-5: Tool rows and code blocks (and messages) have a visible kebab that opens the transcript menu.
- FR-6: Mermaid export uses `canvas.toBlob`; the message menu and ghost Copy mount lazily.
- FR-7: `clipboard.saveImage` moves to `src-tauri/src/ipc/image_save.rs`; the image caps are 8 MiB and decoding runs in `spawn_blocking`.

## Success criteria

- `pnpm ci:local` passes; no new tests; no file grows past its baseline.
- A live check from the committed HEAD opens each migrated dialog and the kebab, and saves an image to disk.
