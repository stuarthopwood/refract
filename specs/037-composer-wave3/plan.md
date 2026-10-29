# Plan: Composer (wave 3)

Spec: `spec.md`. Reuse rule (ADR 0003): every UI element is a shared component in `src/renderer/components/`, extended by a prop. Constraints: 600-line cap and the `MessageInput.tsx` baseline never grow; keep `isFocusStranded` and its `useLayoutEffect` (spec 031); `store/settings.rs` and `ipc/settings.rs` are at the cap, so new Rust settings code goes in sibling files; Tauri security baseline (Principle V) applies to every new command.

## Work packages (WP) and file ownership

| WP | Issues | Main files | Notes |
|---|---|---|---|
| A Composer shell | #675, #839, #1149, #1084 | new `components/ComposerBox.tsx`, `features/chat/MessageInput.tsx`, `features/right-pane/side-chat/SideChatPanel.tsx`, `styles/globals.css` (composer tokens), `scripts/theme-contrast-pairs.mjs`, `scripts/composer-selection-contrast.mjs`, `scripts/verify-1050-command-pill*.mjs`, `scripts/verify-tauri-scratch-helpers.mjs`, `docs/design/*` | First. Owns MessageInput.tsx until it reports. |
| B Queued panel and picker | #1145, #1129 | new `features/chat/QueuedPanel.tsx` (+ hook), `ChatPane.tsx`, `ModelPicker.tsx` | After A (MessageInput.tsx). |
| C Approvals | #1140, #496 | `features/chat/RequestCard.tsx`, `ApprovalModePill.tsx`, `ComposerStatusLine.tsx`, `src/shared/model.ts`, `src/shared/slash-commands.ts`, `src-tauri/src/session/agent/requests.rs`, `commands.rs`, `omp/process.rs`, `store/settings*.rs` | #1140 before the mode. Independent of A/B files except `ComposerStatusLine.tsx`. |
| D Background agents | #712, #865 | `SessionAgent.ts`, `readout.ts`, Agents panel/pill, new status banner component in `components/`, `ChatPane.tsx` (mount, after B), `docs/design/patterns.md` | Probe `async.enabled` and `get_subagents` first; record the result on #712. |
| E Readout and status text | #1258, #1265, #1268 | `ShimmerText.tsx`, `globals.css` (shimmer vars), `ReadoutChips.tsx` / `ContextUsageChip.tsx` / new `AiCreditsChip.tsx`, `src-tauri/src/github/copilot_plan.rs`, `settings_finished_turn_times.rs`, `store/settings.rs` split, `docs/design/foundations-motion.md` | Independent. Banner gap lives in `ChatPane.tsx`/status parent: coordinate with B and D. |

Order: A, then B, C, D, E in parallel with disjoint files; `ChatPane.tsx` edits (B mount, D banner, E gap) are applied one worker at a time. The director commits by path after each report.

## Verification
`pnpm typecheck`, `pnpm test` (existing), `check:*` per package as touched; the full `pnpm ci:local` and the live check happen only in the build slot.
