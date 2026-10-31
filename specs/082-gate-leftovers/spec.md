# Spec 082: gate leftovers from specs 079 and 080

Issues: #1481 (from PR #1483, spec 079), #1482 (from PR #1484, spec 080). Branch `gate-leftovers-082`. Decisions: see the "Decided (Skippy, delegated by Stuart 2026-10-31)" comments on each issue.

## Functional requirements

- FR-001 ChatHeader pause, find and close and PanelTabBar single-panel close use `IconButton`; the pause label equals its tooltip.
- FR-002 `check:icon-only-controls` matches conditional sizes; `check:hit-targets` matches fractional and arbitrary px sizes below 24; both share `scripts/renderer-tsx-files.mjs`.
- FR-003 `check:spacing` rejects blank allowlist reasons.
- FR-004 Settings h1 is semibold; Home uses "Show all"; `TitlebarBand` imports `@/components/PanelHeader`.
- FR-005 Docs: plan-template items 7-8 advisory; spec 079 FR-003 and FR-009 amended; `docs/design/components.md` updated.
- FR-006 Alarm fired row: shared `FieldLabel`, `aria-describedby` on the error, errors clear on edit, re-arm notice clears on open, Re-arm then Dismiss left-aligned.
- FR-007 MessageMenu kebab label includes an emoji-safe message snippet; pre-arm Copy placeholder is an `IconButton`.
- FR-008 Rust: `truncate_display_name` strips control characters before capping; `image_save` temp file retries on `AlreadyExists`; `on_stderr_lines` wrapper removed.
- FR-009 Live check `scripts/verify-tauri-082.mjs` covers Home, Settings, right pane, Profile menu, ChatHeader and the alarm popover.

## Skipped, with reasons

- Hit-target widening for `Switch` and inline links (WCAG 2.5.8 exemption; shared fixed size).
- `openOnArm` on TranscriptKebab (no a11y gain).
- Empty Manage sessions "New session" (needs `NewSessionDialog` without a repository; the empty state already points back to chat).
- `Button loading` migration, shared `Spinner`, and #1477 FR-009/010/011/015/021/026 (many call sites, live-behaviour risk).
