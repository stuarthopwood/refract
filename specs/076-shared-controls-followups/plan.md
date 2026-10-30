# Plan: spec 076

1. `ConfirmAlertDialog`: props `bodyLabel`, `confirmDisabled`; remove `cancelRef`, `onOpenAutoFocus`, `aria-busy`; InlineStatus error; default variant; footer alignment.
2. Call sites: SignOutDialog, MergeDialog (Retry, clear error, labelled radios), PullRequestDetail fork warning, ReportIssueDialog `busyLabel`.
3. Migrate DeleteDialog, ReviewDialog confirm step, ContextShakeMenu (and its right-click open).
4. Transcript: `TranscriptMenuButton`, lazy mounting in `MessageMenu`, `toBlob` in `mermaidImage.ts`.
5. Rust: new `image_save.rs`, 8 MiB caps, `spawn_blocking` decode.
6. Docs and housekeeping: `components.md`, GitChangesPanel comment, `verify-tauri-074.mjs`, `docs/PLAN.md`.
7. Verify: `pnpm ci:local`, `scripts/verify-tauri-076.mjs`, six-reviewer gate.
