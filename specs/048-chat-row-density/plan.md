# Implementation Plan: Chat row density and verb emphasis

**Spec**: [spec.md](spec.md) | **Issue**: #1300

## Approach

1. **Store** (Rust): `store/chat_row_density.rs` child of `settings.rs` (enum, `parse`, `write`, `set_chat_row_density`), same shape as `status_style.rs`; field on `Settings`, hooked in `from_value`, the known-keys list and `to_value`. `ipc/settings_chat_row_density.rs` registers `settings.setChatRowDensity` and emits `settings:changed`.
2. **Contract**: `src/shared/chatRowDensity.ts` (type plus the full-literal gap-class map), `Settings.chatRowDensity?`, `IPC_REQUESTS.SETTINGS_SET_CHAT_ROW_DENSITY`, `setChatRowDensity` in `ipc.ts`, `tauri-bridge`, `settings-store.ts`.
3. **Render**: `Transcript.tsx` reads the density and picks the bookkeeping gap class from the map; `transcriptRowVisibility.ts` adds `mid-turn-prose`; `CollapsedLine.tsx` label defaults to `text-foreground`; `MidTurnProseRow.tsx` drops `summaryClassName`.
4. **Control**: a "Chat row spacing" `SettingRow` with the shared `ToggleGroup` in `AppearanceSection.tsx`.
5. **Docs**: `docs/DESIGN.md` "Transcript rhythm", `docs/PLAN.md`, `CONTEXT.md` term.

## File-size plan

`settings.rs` (535) gains about 6 lines. `Transcript.tsx` stays under its baseline. New files are small.

## Constitution check

Principle V: no capability, CSP or network change. No new tests (prototyping phase).

## Verification

`pnpm typecheck`, `pnpm test`, `check:file-size`, `check:parity`; `pnpm ci:local` and a scratch-exe live check (build slot).
