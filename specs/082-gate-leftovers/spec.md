# Spec 082: gate leftovers from specs 079 and 080

Issues: #1481 (from PR #1483, spec 079), #1482 (from PR #1484, spec 080). Branch `gate-leftovers-082` (Lane S). Decisions: the "Decided (Skippy, delegated by Stuart 2026-10-31)" comments on each issue; see `clarifications.md`. No new tests (prototyping phase); existing tests must keep passing. No theme token files are touched.

## Problem

The five-reviewer gates on PR #1483 and PR #1484 left Medium and Low findings that were filed as #1481 and #1482. Left alone they let the same defects recur: hand-built icon buttons that bypass `IconButton`, lint scripts that miss conditional and fractional sizes, an alarm popover with unlabelled errors, and Rust helpers with unbounded or racy input handling.

## User stories

- US-1 As a keyboard or screen-reader user, every icon-only control in the chat header, panel tab bar and message rows has a name equal to its tooltip, a 24 px minimum target and a shortcut hint where one exists.
- US-2 As a maintainer, `check:icon-only-controls` and `check:hit-targets` fail on the patterns the first versions missed, so the gate cannot be bypassed by a conditional or fractional size.
- US-3 As a user of the alarm popover, an error is announced against its input, clears when I edit, and stale notices do not reappear when I reopen the form.
- US-4 As a user of the profile and image-save paths, hostile or oversized input cannot leave control characters in a display name or lose a file to a temp-name collision.

## Functional requirements

- FR-001 ChatHeader pause, find and close and PanelTabBar single-panel close use `IconButton`; the pause label equals its tooltip. Find and close carry `shortcut` and `aria-keyshortcuts`.
- FR-002 `check:icon-only-controls` matches conditional sizes; `check:hit-targets` matches fractional sizes and arbitrary px below 24; both share `scripts/renderer-tsx-files.mjs`; baselines regenerated.
- FR-003 `check:spacing` rejects blank allowlist reasons.
- FR-004 Settings h1 is semibold; Home links read "Show all"; `TitlebarBand` imports `@/components/PanelHeader`.
- FR-005 Docs: plan-template items 7-8 are advisory; spec 079 FR-003 and FR-009 amended; `docs/design/components.md` records the ChatHeader/PanelTabBar IconButton rule, the pause-label rule and the "Switch to" button style.
- FR-006 Alarm popover: shared `FieldLabel`; `aria-describedby` points at the error; an error clears when either input changes; the re-arm notice clears when the form opens; Re-arm then Dismiss, left-aligned.
- FR-007 MessageMenu kebab label is "More actions, <snippet>" with an emoji-safe 32-character snippet; the pre-arm Copy placeholder is an `IconButton`.
- FR-008 Rust: `truncate_display_name` strips control characters before capping and is used by both the profile fetch and the profile cache; `image_save` retries its temp name on `AlreadyExists` (up to 8 attempts); the `on_stderr_lines` wrapper is removed.
- FR-009 Live check `scripts/verify-tauri-082.mjs` chains the 082 UI check, 079, 072, 076 and 008, and writes `report.json` with the code `gitHead`.

## Items: done and skipped

| Item | Result | Where |
|---|---|---|
| ChatHeader pause/find/close to `IconButton` | done | `ChatHeader.tsx:58,65,74` |
| PanelTabBar close to `IconButton` | done | `PanelTabBar.tsx:87` |
| Lint widening (conditional, fractional, arbitrary px) | done | `check-icon-only-controls.mjs:23`, `check-hit-targets.mjs:25`, `renderer-tsx-files.mjs:9` |
| `check:spacing` blank reason | done | `check-spacing.mjs:76` |
| Settings h1 weight | done | `SettingsScreen.tsx:46` |
| "Show all" wording | done | `HomeGitHubSections.tsx:47,95` |
| `TitlebarBand` import path | done | `TitlebarBand.tsx:7` |
| Plan-template advisory items, spec 079 amendments, components doc | done | `.specify/templates/plan-template.md`, `specs/079-design-sweep-d-f/spec.md`, `docs/design/components.md` |
| Alarm `FieldLabel`, describedby, error clearing, re-arm layout | done | `FieldLabel.tsx:7`, `AlarmClock.tsx:41,76,83,96` |
| MessageMenu kebab label and Copy placeholder | done | `MessageMenu.tsx:17,80,84` |
| `truncate_display_name` | done | `github/profile.rs:29`, `store/profile_cache.rs:51` |
| `image_save` temp-name retry | done | `ipc/image_save.rs:93-114` |
| `on_stderr_lines` wrapper removed | done | `github/cli.rs:464` |
| Truncated comment at ManageAccountsDialog | done | `ManageAccountsDialog.tsx:~20` |
| Live check coverage for Settings, Home, ChatHeader | done | `scripts/verify-tauri-082-ui.mjs` |
| Hit-target widening for `Switch` and inline `<a>` | skipped | WCAG 2.5.8 exempts inline links; `Switch` size is fixed in the shared component |
| `openOnArm` on TranscriptKebab | skipped | behaviour change, no a11y gain |
| Empty Manage sessions "New session" | skipped | needs `NewSessionDialog` without a repository; the empty state already points back to chat |
| `Button loading` migration, shared `Spinner` | skipped | many call sites, live-behaviour risk |
| #1477 partial FRs 009, 010, 011, 015, 021, 026 | skipped | cross-cutting; carried to the follow-up issue |
| Other micro-tidies (alarm-fired-store sync, per-row Tooltip root, `commandRowText`, GitHubAccountRow refs, `ScreenHeader` `cn`) | skipped | no defect; carried to the follow-up issue |
| Right-pane close live screenshot | skipped | no stable way to open a panel in the fake-omp harness; covered by typecheck and the icon-only lint |

## Success criteria

- `pnpm ci:local` passes. `verify-tauri-082.mjs` passes from the committed HEAD and `report.json.gitHead` equals it.
- Six-reviewer gate: PASS from every gating reviewer after the last code change.
