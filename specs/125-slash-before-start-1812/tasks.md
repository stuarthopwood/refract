# Tasks: Slash commands before the agent starts (#1812)

- [x] T001 Persist and serve the last-known command list (`store/last_commands.rs`) (FR-001)
- [x] T002 Wait up to 10 s for the first commands report before validating (`command_wait.rs`, `ipc/chat.rs`) (FR-002)
- [x] T003 Re-export `COMMANDS_WAIT` beside `mod command_wait` (FR-002)
- [x] T004 "Starting agent…" empty state (`useSlashMenuCompletion.ts`, `MessageInput.tsx`) (FR-003)
- [x] T005 `isLocalNativeCommand` and skip the forced start (`slash-commands.ts`, `MessageInput.tsx`) (FR-004)
- [x] T006 `/new` no-op on a never-started agent (`conversations.rs`) (FR-004)
- [x] T007 One in-flight send per Session (`MessageInput.tsx`) (FR-005)
- [x] T008 PLAN.md row
- [x] T009 `slash-commands.test.ts` for `isLocalNativeCommand`
- [ ] T010 Typecheck and node checks done in this lane; Rust build, ci:local and live check pending in the shared build slot
