# Plan

1. Rust: `src-tauri/src/updates/install_on_quit.rs` (`reject_redirected_installer`, `write_log_header`, `append_log`, helper script comment).
2. Renderer: `AskCard.tsx`, `ui/checkbox.tsx` (`OPTION_ROW_CLASS`), `chat-nav/stepToMessage.ts`, `ComposerContextMenu.tsx`, `palette/menuItems.tsx`, `ContextShakeMenu.tsx`, `ContextUsageReadout.tsx`, `SuspectWindowsNotice.tsx`, `lib/suspectContextWindow.ts`.
3. Script: `scripts/verify-556-zero-box.mjs` line fix; `scripts/verify-tauri-099.mjs` live check.
4. Gate: `pnpm ci:local`, live check, six-reviewer gate.
