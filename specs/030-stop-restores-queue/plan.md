# Plan: spec 030

- `src-tauri/src/session/agent/chat.rs` `stop()`: try `abort_and_restore_queue`; on a non-success response fall back to `abort`. Returns `{ messages: [{ text, images }], imagesDropped, truncated }`. Images are rebuilt as `{type, data, mimeType}` only. Pure parsing lives in `chat_restore.rs` to keep `chat.rs` small.
- `src-tauri/src/ipc/chat.rs` `chat_stop`: return that value instead of `null`.
- `src/shared/ipc.ts` + `src/tauri-bridge/index.ts`: `chat.stop` returns `Result<StopResult>`.
- `src/renderer/features/chat/restoreQueue.ts`: `stopAndRestore(sessionId)` shared by the Stop button and Ctrl+Shift+X; appends text, adds images, announces, warns, focuses the composer.
- `scripts/fixtures/omp-frames/stop-911.jsonl`: the tape waits for `abort_and_restore_queue` and answers with an empty restore.
- Docs: `omp-usage.md` Stop row, `docs/PLAN.md` row.
- Probe (live): queue two messages mid-turn, Stop, check the composer and that no new turn starts.

Constitution II: `message`, never `text`, on the wire. Constitution V: images from OMP are re-filtered to supported mime types; re-sending still passes `chat.send` validation.
