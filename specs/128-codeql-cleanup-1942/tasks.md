# Tasks: Clear open CodeQL alerts (#1942)

**Spec**: `specs/128-codeql-cleanup-1942/spec.md` | **Plan**: `plan.md`

Parallel slices: A (T001-T002), B (T003-T006), C (T007-T012) touch disjoint files. `[P]` marks a task that can run alongside others.

- [X] T001 [P] Add `.github/codeql/codeql-config.yml` with `paths-ignore: - scripts/verify-*.mjs` (FR-002)
- [X] T002 Add `.github/workflows/codeql.yml`: pull_request, push to main, weekly schedule; matrix actions, javascript-typescript, python, rust, `build-mode: none`; `config-file` set, default queries; least-privilege permissions; confirm no branch-protection rule names a CodeQL check (FR-001, FR-003)
- [X] T003 [P] Rust `session/token_guard.rs:186,230`: drop session id and token count from both log lines; rename `tokens` var if it trips the heuristic (FR-004)
- [X] T004 [P] Rust `fs/leftover_summary.rs:346`, `git/worktree_holders/diag.rs:25`, `session/working_mode/store.rs:33`, `shell/notifications.rs:160`: drop ids and pids from log lines (FR-004)
- [X] T005 [P] Rust `process/pid_records.rs:114,134,148`: drop pid and session id, keep `{err}` (FR-004)
- [X] T006 [P] Rust `session/agent/pause.rs:127`: `{err:?}` to `{err}`, drop id (FR-004) (RegistryStoreError has no Display, so the line logs no error text)
- [X] T007 [P] Red tests first: `scripts/check-parity.test.mjs` asserting old and new `mod` patterns match the same inputs (FR-005, FR-009)
- [X] T008 `scripts/check-parity.mjs:94`: new pattern, matcher exported from a helper module without running the script on import (FR-005)
- [X] T009 [P] Red tests first: `scripts/check-drag-regions.test.mjs` for tag names with `.`, `*`, `(`, `\` (FR-006, FR-009)
- [X] T010 `scripts/check-drag-regions.mjs:109`: full metachar escape via an exported helper (FR-006)
- [X] T011 [P] Red tests first: `scripts/release-changelog.test.mjs` for exact heading match, `1.2.3` vs `1.2.30`, CRLF, absent version (FR-007, FR-009)
- [X] T012 `scripts/release-changelog.mjs:105`: line-start scan for `## v${version} (`, no regex (FR-007)
- [X] T013 `scripts/verify-tauri.mjs:102`: drop `cmd.exe /c`; reuse `buildAndCopyExeFresh` from `scripts/verify-tauri-scratch-helpers.mjs` if it fits, else spawn `pnpm` without a shell (FR-008) (helper does not fit: it uses shell:true and lacks the retry; runs the repo-local `@tauri-apps/cli/tauri.js` with `process.execPath`: fixed path, no shell, no pnpm shim, no env-derived command)
- [ ] T014 Run in the Rust build slot: `pnpm test`, `cargo test`, `cargo clippy`, `pnpm check:parity`, `pnpm check:file-size` (FR-009)
- [ ] T015 Push; mark the PR ready only after the rollout steps; hand to controller for default-setup disable (FR-010)
- [ ] T016 After the controller disables default setup: rerun the PR's CodeQL workflow; confirm it passes and verify-script alerts are not reported (SC-002)
- [ ] T017 Docs: update `docs/PLAN.md` row 1c.1b status to done after merge; note the scanning-gap risk in the PR body
