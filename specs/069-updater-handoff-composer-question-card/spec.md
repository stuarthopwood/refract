# Spec 069: Updater hand-off, composer spelling, status pills, Question card

Issues: #1433, #1431, #1429, #1434, #1435. Amends spec 006 (updates), 062 (composer context menu) and 001 (Question card, FR-066).

## Self-grill outcomes (against CONTEXT.md, docs/adr, code)

- Delegated decisions already recorded on each issue stand; no open question remains.
- #1433: no failure evidence survives (log rolled, `lastError` cleared). Root cause is unproven. Scope is observability and a correct failure state; verification (checksum, Authenticode pin, installer directly in `updates/`) is not weakened.
- #1431: Radix `ContextMenuTrigger` cancels the native menu, and page script cannot read spelling suggestions. The suggestion source is the Windows Spell Checking API via a Rust command, shown as items in the existing shared menu builders.
- #1434/#1435: one shared option-row class (ADR 0003), reused by `AskCard` and `RequestCard`.

## Requirements

- **FR-1 (#1433)** The install hand-off helper MUST capture the installer's exit code and write timestamped output (stdout, stderr, exit code) to `updates/install.log` in the data dir.
- **FR-2** The old version MUST be relaunched only when the install failed; after a successful install the relaunch starts the new version at the same path.
- **FR-3** Next-launch reconciliation MUST set `lastError` to a message carrying the installer exit code and the log path when the log records a failure, and a distinct message when the helper recorded nothing.
- **FR-4** If the install hand-off itself fails, the log MUST record the outer helper's stdout, stderr and exit code, and `lastError` keeps that cause.
- **FR-5 (#1431)** Right-click (or Shift+F10 / Menu key) on a misspelled word in the composer shows up to five suggestions and "Add to dictionary" above the existing items. Where the platform cannot supply them, the menu is unchanged and the reason is recorded on the issue.
- **FR-6 (#1429)** The composer status line gap between pills is 12px (`gap-x-3`).
- **FR-7 (#1434)** Question card option rows (single and multiple choice, both card paths) have no border and use a fill; the control is leading and vertically centred on the row; Cancel is a labelled ghost button.
- **FR-8 (#1435)** Activating a real option of a single-choice question (pointer click or Space) advances to the next incomplete question or submits the batch. Arrow keys never advance. Other, multiple choice, Cancel, Next and Submit are unchanged.

## Clarifications

- Q: Does a successful install relaunch? A: Yes, `current_exe` is the new binary after install. FR-2 only forbids relaunching the old one as if nothing happened; a failed install relaunches the old one and the log plus next-launch `lastError` say it failed.
- Q: What counts as success? A: Installer exit code 0.
- Q: Where is "Add to dictionary" stored? A: The Windows user dictionary through `ISpellChecker::Add`, which persists across restarts.

## Out of scope

Transcript menus, code blocks, tool rows and Mermaid (#471), Session list, footer alignment (#1387).
