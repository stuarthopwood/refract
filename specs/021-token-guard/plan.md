# Implementation Plan: Token guard

**Branch**: `feat/1212-token-guard` | **Date**: 2026-10-23 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/021-token-guard/spec.md`

## Summary

Every `omp` Refract launches gets `--config <overlay>` and `--append-system-prompt <rules file>`. A new Rust module `src-tauri/src/omp/token_guard/` writes the overlay (atomic, versioned, from a Refract-owned values store) and the rules file, builds the extra launch arguments, sends `/shake` after a turn settles when context is above 60k, and counts model calls per Conversation. The renderer adds a Settings > OMP section ("Set by Refract" rows), a "Long conversation" Status line readout with a Hand off button at 300 calls, and a pane banner at 500. The #1184 global-config reset is removed. Probe results are in [research.md](./research.md).

**Settings > Advanced batch (2026-11-03)**: `token_guard/values.rs` and `src/shared/tokenGuard.ts` move thresholds to `compaction.thresholdPercent` and `"N%"` strings (store version 2, load-time migration); `src/renderer/components/ui/NumberField` backs `NumberUnitField`/`PerModelThresholdTable`; `TokenGuardKeyInfo.impact` renders in `AdvancedRow.tsx`; row copy and method hints change in `tokenGuard.ts`. Commits in order #1553, #1579, #1555, #1580 on one PR.

## Technical Context

**Language/Version**: Rust 2021 (Tauri v2); TypeScript 5 / React 19
**Primary Dependencies**: existing `store/atomic_json.rs`, `omp::process`, `session::agent::{frame,launch,conversations}`, shared `ui/*` components, sonner
**Storage**: new `token-guard.json` (values store) and generated `token-guard-overlay.yml` and `refract-rules.md` in the Refract data dir; shipped `src-tauri/resources/refract-rules.md` embedded with `include_str!`
**Testing**: existing gates only; minimal Rust unit tests inside `token_guard/` (overlay rendering, threshold and counter logic). No new tests in `src/renderer` or `src/shared` (prototyping rule). Live check at the end.
**Target Platform**: Windows desktop
**Constraints**: 600-line cap (issue #806); ADR 0003 shared components; `pnpm check:parity` must pass; omp 18.12.6 behaviour as probed.

## Constitution Check

- I (OMP is the engine): uses OMP's own `--config`, `--append-system-prompt` and `/shake`; no parallel implementation of compaction. PASS.
- II (RPC wire contract): `/shake` is sent as `{type:"prompt", message:"/shake"}` (field `message`), only after `session_settled`, never while a turn runs; its `command_output` frame is swallowed. PASS.
- III (lifecycle): process flags, cwd, approval mode unchanged; arguments only appended. Hand off reuses `new_session` via `start_new_conversation` and requires Idle. PASS.
- IV (evidence before design): probes recorded in research.md; overlay precedence is verified live in the verify task (cannot be proven offline). PASS with a flagged live check.
- V (Tauri security baseline): no new Tauri command or capability. New channels go through `refract_request` with plain JSON payloads (`tokenGuard.get/set/reset`, `tokenGuard.handoff`); one event (`token-guard:conversation-calls` or equivalent, see contracts). Rules and overlay paths are never taken from renderer input. PASS.

## File-size plan (issue #806)

| File | Now | Plan |
|---|---|---|
| `omp/process.rs` | 1106 (baselined) | Must shrink: move `build_args` into new `omp/process_args.rs`, which also adds the two new arguments |
| `session/readout.rs` | 598 | No change; context size read via its existing store accessor |
| `store/settings.rs` | 593 | No change; values live in own store |
| `session/agent/frame.rs` | 418 | One-line hooks only, calling `token_guard` |
| `ipc.ts` 898 cap / `model.ts` 656 | baselined | New types in new `src/shared/tokenGuard.ts`; `ipc.ts` gets only channel entries |
| `ChatPane.tsx` 1444, `MessageInput.tsx` 1632 | baselined | New components `LongConversationBanner.tsx`, `LongConversationChip.tsx`; minimal wiring lines only |
| `token_guard/` | new | `mod.rs`, `values.rs`, `overlay.rs`, `rules.rs`, `args.rs`, `shake.rs`, `counter.rs`, `handoff.rs`; each far under 600 |

## Project Structure

```text
src-tauri/
  resources/refract-rules.md            # shipped rules, ~1.5k chars
  src/omp/process_args.rs               # extracted build_args + token guard args
  src/omp/token_guard/{mod,values,overlay,rules,args,shake,counter}.rs
  src/ipc/token_guard.rs                # tokenGuard.* channels
  src/session/agent/handoff.rs          # Hand off flow (summary, new conversation, first message)
src/shared/tokenGuard.ts                # value types, defaults, thresholds (300, 500, 60000)
src/renderer/features/settings/OmpSection.tsx, OmpValueRow.tsx
src/renderer/features/chat/LongConversationChip.tsx, LongConversationBanner.tsx
src/renderer/state/token-guard-store.ts
```

## #1184 removal list (Lane A)

Rust: `omp/config_guard.rs`, `omp/config_guard_tests.rs`, `omp/mod.rs` (`pub mod config_guard`), `events.rs` (`OMP_GUARD_RESET`, `emit_omp_guard_reset`), `lib.rs` (startup `run_at_startup`), `session/agent/launch.rs` (`run_before_launch`). Keep `omp/config.rs` dotted-key validator and its test (reused by #691). Leave `ipc::model_roles::set_model_role`.
Renderer/shared: `components/OmpGuardDetailsDialog.tsx`, `state/omp-guard-store.ts`, `main.tsx` mount, `state/init-stores.ts` subscribe, `shared/ompGuardNotice.ts`, `shared/ipc.ts` (type import/export, `IPC_EVENTS.OMP_GUARD_RESET`, `onOmpGuardReset`), `tauri-bridge/index.ts` (import and `onOmpGuardReset`), `styles/globals.css` sonner focus-shadow rule if only the guard toast used it.
Scripts/specs: `scripts/check-parity.mjs` (`OMP_GUARD_RESET` entry), `scripts/verify-1184-omp-settings-guard.mjs`; `specs/020-omp-settings-guard/spec.md` gets a "Superseded by 021" note, the rest stays as history. `docs/PLAN.md` is left to the director.

## Design

1. **Values store** (`values.rs`): `TokenGuardValues` with the 17 grilled keys plus snapcompact keys, seeded from `src/shared`-mirrored defaults; atomic JSON via `atomic_json`; `version` field.
2. **Overlay** (`overlay.rs`): render nested YAML from the values, write to a temp file then rename; header comment with `refractOverlayVersion`; rewritten on every launch (cheap) so edits apply to the next launch.
   **Amended (#1765)**: since #1767 Settings writes the global config (`omp config set`), and a running omp re-reads config between turns for the keys proven live (research.md sections 9, 10); the launch overlay remains only for the per-Session plan variant and the legacy migration fallback, and must be written through `overlay::write_legacy` or proven unreachable.
3. **Rules** (`rules.rs`): copy embedded rules to the data dir on launch, return the path.
4. **Args** (`args.rs`): `token_guard_args() -> Vec<OsString>`; on write failure return empty plus a one-shot toast event.
5. **Shake** (`shake.rs`): called from the settle hook; reads context tokens, if above 60_000 sends `/shake` via `proc.request`, marks the response silent, logs result; one attempt per settle; the next user prompt waits for the in-flight shake (bounded by a timeout) so it cannot race.
6. **Counter** (`counter.rs`): per Session+Conversation count of assistant `message_end`; re-derived from history on open or resume; emits snapshot updates when crossing 300 or 500.
7. **Hand off** (`handoff.rs`): Idle only; prompt the agent for a handoff summary, await settle, `start_new_conversation`, send summary as first message; failure leaves the old Conversation untouched and returns a reason.
8. **UI**: Settings `omp` section built from `SettingSwitchRow`, `ui/input`, `ui/button`, `ui/badge`; Status line chip as a `ReadoutChip` (text "Long conversation, N calls") containing a real `Button` "Hand off"; banner from shared `ui/alert`; a visually hidden `role="status"` live region announces once per threshold crossing per Conversation.

## Lanes

Lane A (overlay, launch, settings, #1184 removal) lands first. Lane B (shake, counter, readout, Hand off, banner, a11y) starts after A is merged; its files do not overlap A's except `session/agent/frame.rs` hooks and `ipc.ts` entries (B appends after A). See [tasks.md](./tasks.md).

## Complexity Tracking

None. The extra module split exists only to honour the file cap.
