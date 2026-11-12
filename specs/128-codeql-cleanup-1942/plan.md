# Plan: Clear open CodeQL alerts (#1942)

**Spec**: `specs/128-codeql-cleanup-1942/spec.md` | **Issue**: #1942

## Approach

Three independent slices, no product behaviour change: (A) CodeQL advanced setup files, (B) Rust log-line fixes, (C) script fixes with unit tests. No renderer or IPC change. `ci.yml` untouched. No builds or tests run during the spec phase; the Rust build slot is used once at implement.

## Code to touch (on `origin/main` e543a18c)

### A. CodeQL advanced setup (FR-001..003, FR-010)

- `.github/workflows/codeql.yml` (new): triggers `pull_request`, `push` to `main`, weekly `schedule`; matrix over `actions`, `javascript-typescript`, `python`, `rust` with `build-mode: none` for all (interpreted languages and Rust); steps `actions/checkout`, `github/codeql-action/init` with `config-file: ./.github/codeql/codeql-config.yml` (no `queries:` key, so the default suite), `github/codeql-action/analyze`; `permissions: security-events: write, contents: read, actions: read`. Pin action versions the way `ci.yml` and `release.yml` pin theirs (check at implement).
- `.github/codeql/codeql-config.yml` (new): `paths-ignore: - scripts/verify-*.mjs`.
- Not touched: `.github/workflows/ci.yml`, `release.yml`, `issue-triage.yml`. Check branch protection names no CodeQL check that the new workflow would rename.

### B. Rust cleartext-logging (FR-004), all under `src-tauri/src`

- `session/token_guard.rs:186` and `:230`: drop the session id and the context-token count argument from the two `log::info!` lines; rename the `tokens` binding if CodeQL's name heuristic still matches.
- `fs/leftover_summary.rs:346`: drop `{session_id}` from the `log::debug!`.
- `git/worktree_holders/diag.rs:25`: drop `{session_id}` and the pid vectors (`alive`, `descendants_alive`); keep the booleans/counts if useful.
- `process/pid_records.rs:114,134,148`: drop `{pid}` and `{session_id}`; keep `{err}`. `:37` and `:166` carry no ids; leave.
- `session/agent/pause.rs:127`: `{err:?}` to `{err}`, drop `self.session_id`.
- `session/working_mode/store.rs:33`: drop `{session_id}`.
- `shell/notifications.rs:160`: drop `{session_id}`.
- Tests: pure message changes; existing tests must pass. No new tests (no new logic).

### C. Scripts (FR-005..009)

- `scripts/check-parity.mjs:94`: replace the pattern with `/^\s*(?:\/\/[^\n]*\n\s*)*mod\s+\w+\s*\{/`. Extract the Rust-mod matcher to a small exported function in a new helper module so a test can import it without running the script; test that old and new patterns agree on a table of inputs (blank lines, line comments, no comments, `mod x {`, `mod x;`, comment-only).
- `scripts/check-drag-regions.mjs:109`: replace `.replace(/[.]/g, '\\.')` with a full metachar escape, as `check-parity.mjs:166` already does (`/[.*+?^${}()|[\]\\]/g`). Put the shared escape in an exported helper so the test can reach it; test with names containing `.`, `*`, `(`, `\`.
- `scripts/release-changelog.mjs:105`: replace the `RegExp` build with a line scan: find the first line whose text starts with `## v${version} (`; keep the existing slice logic at `:106-112`. Test: exact match, `1.2.3` vs `1.2.30`, CRLF input, version absent.
- `scripts/verify-tauri.mjs:102`: replace `spawnSync_('cmd.exe', ['/c', 'pnpm', ...])` with the shared build helper `buildAndCopyExeFresh` in `scripts/verify-tauri-scratch-helpers.mjs:104` if its copy-to-scratch semantics fit; otherwise call `pnpm` directly with `shell: false` on the platform's pnpm shim. No test (a live, build-heavy script); verified by reading plus a `pnpm verify:tauri` run in the build slot only if the controller asks.
- Test files: `scripts/*.test.mjs` beside the scripts (house pattern: `scripts/check-indent.test.mjs`), run by `pnpm test` (vitest).
- Size: every touched file stays under 600 lines (`pnpm check:file-size`).

## Rollout (see spec)

1. Implement and push. 2. Controller runs `gh api -X PATCH repos/stuarthopwood/refract/code-scanning/default-setup -f state=not-configured`. 3. Rerun the PR's CodeQL workflow; confirm it passes and the verify-script alerts are gone. 4. Merge. Until step 2 the PR's CodeQL check is red (default setup rejects the advanced SARIF upload); expected. Accepted risk: no CodeQL scan of `main` between steps 2 and 4.

## Checks

- `pnpm test` (new script tests), `cargo test` and `cargo clippy` for the Rust edits, `pnpm check:file-size`, `pnpm check:parity`, in the Rust build slot at implement.
- After the controller's step 3: Security tab shows none of the Problem-table alerts for the fixed rules.

## Risks

- CodeQL may still flag a Rust line after the id is dropped (heuristic on variable names); then rename and rerun.
- `build-mode: none` for Rust needs a CodeQL version that supports it; the action's latest v3/v4 does.
- Extracting helpers must not change script behaviour; the table tests guard that.
