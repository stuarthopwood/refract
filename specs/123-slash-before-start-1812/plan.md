# Plan: Slash commands before the agent starts (#1812)

## Backend (already on branch)
- `store/last_commands.rs`: persisted last-known list, served for a not-started Session.
- `session/agent/command_wait.rs`: `wait_for_commands(COMMANDS_WAIT)`, re-exported from `session/agent/mod.rs`; `ipc/chat.rs` awaits it before validating.
- Added: `conversations.rs` `start_new_conversation` returns `Ok(())` for a never-started (Stopped, no process) agent.

## Frontend (added)
- `shared/slash-commands.ts`: `isLocalNativeCommand` (`/new`, `/pause` bare; `/role <role>`).
- `MessageInput.tsx`: skip `sessions.open(id, true)` for those commands; `sendInFlightRef` wraps `handleSend`; pass `awaitingCommands` to the menu hook.
- `useSlashMenuCompletion.ts`: `awaitingCommands` turns the empty text into "Starting agent…".

## Checks
Typecheck, `check:file-size|comment-density|spacing|literal-colours|indent|parity`. Rust compiles in the shared build slot.
