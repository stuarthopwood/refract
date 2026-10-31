# Plan

1. Rust: `updates/install_on_quit.rs`, `updates/mod.rs` (hash pin, canonical and reparse check, sentinel, parse, PowerShell path); `ipc/spellcheck.rs` (misspelt flag, word limits).
2. Contract: `shared/ipc-spellcheck.ts`, `tauri-bridge/index.ts`.
3. Renderer: `ComposerContextMenu.tsx`, `palette/menuItems.tsx`, `ui/checkbox.tsx`, `chat/AskCard.tsx`, `SuspectWindowsNotice.tsx`, `lib/suspectContextWindow.ts`, `ContextUsageReadout.tsx`, `ContextShakeMenu.tsx`.
4. Docs: `docs/design/components.md`, `docs/PLAN.md`.
5. Verify: typecheck, vitest, check:* scripts, cargo gate (slot), live check `scripts/verify-tauri-090.mjs`, review gate.
