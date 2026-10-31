# Plan (spec 092)

Renderer: `lib/focus.ts` (`focusStopBanner`), `features/chat/StopBanner.tsx`, new `features/chat/useComposerFocusHandoff.ts`, `MessageInput.tsx`, `restoreQueue.ts`, `RetryLine.tsx`, new shared `components/SecretInput.tsx`, `RequestCard.tsx`, `shared/model.ts`. Rust: `session/agent/types.rs`, `session/agent/requests.rs`.

Verification: typecheck, vitest, `check:*` scripts, `check:parity`, `ci:local` under the build slot, then `scripts/verify-tauri-092.mjs` from the committed HEAD.
