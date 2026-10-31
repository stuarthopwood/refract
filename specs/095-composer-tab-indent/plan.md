# Plan (spec 095)

- `src/renderer/features/chat/composerIndent.ts`: pure edit planners (`planIndent`, `planListContinuation`) returning a minimal `{ from, to, insert, selStart, selEnd }` edit, plus `applyEdit` (`execCommand`).
- `src/renderer/features/chat/useComposerIndent.ts`: hook owning the focus-mode state; `handleKeyDown(event)` returns true when it consumed the key.
- `src/renderer/features/chat/ComposerIndentHint.tsx`: visible hint plus the sr-only description.
- `MessageInput.tsx`: hook-up only (hook call, one call in `handleKeyDown`, `onBlur`, the hint, the description id). Must not exceed its file-size baseline.
- `KeyboardShortcutsDialog.tsx`: contextual rows.
- `scripts/verify-tauri-095.mjs`: live check with the recorded-frame fake omp.
