# Plan: Composer context menu

- Rust: `clipboard.readText` in `src-tauri/src/ipc/clipboard.rs` (`read_text`, empty clipboard is an error). `scripts/check-parity.mjs` lane entry.
- Shared: new `src/shared/ipc-clipboard.ts` (`ClipboardApi`, both methods) so `src/shared/ipc.ts` stays under its 902-line baseline; `IPC_REQUESTS.CLIPBOARD_READ_TEXT`; bridge in `src/tauri-bridge/index.ts`.
- Renderer: `src/renderer/components/ComposerContextMenu.tsx` wraps the textarea inside `ComposerTextarea` (`ComposerBox.tsx`). It forwards the ref and props unchanged, so `MessageInput.tsx` (1209-line baseline) is untouched.
- Actions run in `onCloseAutoFocus` after Radix returns focus to the textarea: `execCommand('cut'|'insertText')` keep native undo; Copy and Cut fall back to the IPC write if `execCommand` refuses.
- Paste dispatches a synthetic `ClipboardEvent('paste')`; if the handler did not `preventDefault`, the text is inserted with `insertText`.
- Docs: `docs/PLAN.md` row.
