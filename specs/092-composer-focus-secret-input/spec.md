# Spec 092: composer focus handoff and secret input

Issues: #1285 (composer focus stranded on body) and #1295 (mask extension secret input prompts). Branch `composer-focus-secret-1285-1295` (Lane AC). Decisions: the "Decided (Skippy, delegated by Stuart 2026-10-31)" comments on both issues; see `clarifications.md`. No new tests (prototyping phase). Lane AD owns the Issues and Pull requests views; none is touched here.

Folder choice: #1285 takes the converge route and is amended into spec 001 as FR-120 (`specs/001-core-session-workspace/spec.md`, task T412). #1295 is new, so it lives here. This folder holds both for the live check, since one `verify-tauri-092.mjs` covers both.

## Problem

When a turn ends stopped, the composer disables while it holds focus and focus falls to `<body>`. Stop-and-restore also focuses twice. Separately, an extension `input` request with `secret: true` (OMP 18.13.2) renders as a plain visible text field and echoes the value in the answered summary.

## Functional requirements

- FR-001 (#1285, FR-120 in spec 001) Focus moves to the stop banner's first enabled button, else the labelled banner, when the composer disables under focus; it returns to the textarea on re-enable only from the banner or body.
- FR-002 (#1285) `stopAndRestore` focuses the composer once; `RetryLine` adds no second focus call.
- FR-003 (#1285) Dark (high contrast) composer outline is measured against 3:1 and reported; no token change if it passes (15.42:1 focus, 9.54:1 resting border, 5.27:1 control border).
- FR-004 (#1295) Rust `classify_dialog` reads `secret` on `input` requests only and carries it on `PendingRequest::Question`; the TypeScript model mirrors it (`secret?: boolean`).
- FR-005 (#1295) The shared `SecretInput` (`components/SecretInput.tsx`, built on `Input` and `IconButton`) starts masked, has a labelled reveal toggle with `aria-pressed`, sets autocomplete, correction and spellcheck off, and does not block paste.
- FR-006 (#1295) After answering a secret request the bridge row's detail reads "Secret entered" and the persisted row reads "Answered"; neither shows the value or its length, and the field is cleared on submit.
- FR-007 (#1295) The answer value is never logged, persisted to the transcript or registry, or echoed in an event.
- FR-008 Live check `scripts/verify-tauri-092.mjs` exercises each changed path with screenshots and writes `report.json` with the code `gitHead`. Secret prompts are driven through the recorded-frame fake omp (no OMP 18.13.2 extension is assumed installed).

## Success criteria

- Typecheck, vitest and every `check:*` script pass; `ci:local` passes. `verify-tauri-092.mjs` passes from the committed HEAD and `report.json.gitHead` equals it.
- Six-reviewer gate: PASS from every gating reviewer after the last code change.
