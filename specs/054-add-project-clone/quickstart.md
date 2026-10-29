# Quickstart 054: live check with a fake gh

Use the Rust build live-check rules (`docs/rust-build.md`): shared `CARGO_TARGET_DIR`, `pnpm exec tauri build --debug --no-bundle`, copy the exe to a scratch dir, run with your own `--remote-debugging-port` and a scratch `REFRACT_DATA_DIR`. Never `pnpm dev`, never `%APPDATA%\refract-tauri`.

## Fake gh

`resolve_gh` prefers `%LOCALAPPDATA%\refract\tools\gh\gh.exe` over PATH (#1343). Put the fake where the build finds it without touching a real install: either point `LOCALAPPDATA` at a scratch dir for the app process (so the fake sits at `<scratch>\refract\tools\gh\gh.exe`), or, if the real tools copy exists, use a scratch `LOCALAPPDATA` anyway so the real one is not replaced.

The fake answers by argv:

- `auth status --json hosts`: one signed-in `github.com` account `me`.
- `api user/orgs ...`: prints `acme-co`.
- `repo list me ...` and `repo list acme-co ...`: JSON arrays (include one private repo, one with a 400-char description with control characters, 100 rows for one owner, one repo whose `owner/name` equals a Project added earlier).
- `repo clone <owner/name> <dir> -- --progress`: create `<dir>`, write progress lines with `\r` to stderr (`Receiving objects:  10%` ... `Resolving deltas: 100%`), sleep a few seconds, run `git init` in `<dir>` and exit 0. A mode switch via a file next to the fake makes it exit 1 with "Repository not found" on stderr, or sleep for 60 s (for Cancel).
- Log every argv to a file so argument arrays can be inspected.

## Steps (each states the expected result)

1. Start with no Projects: first-run shows a filled **Add project** button with a chevron; the menu shows only "Local folder..." then "Clone from GitHub...", text only (FR-001, FR-003).
2. Add one Project through Local folder; the footer shows a ghost **Add project** with a chevron up; the menu opens upward (FR-001, FR-005).
3. Open Clone from GitHub: own account first, `acme-co` second, sticky headers, count "Showing X of Y"; private row has a lock and "Private"; the long description is truncated, plain text (FR-008 to FR-010, FR-028).
4. Filter narrows across owners; the count is announced (screen reader or live-region inspection).
5. Pick a row: destination empty and Clone disabled with no default; Browse to a scratch folder; checkbox ticked; Clone enabled (FR-014, FR-015).
6. Press Clone: dialog closes at once, a loading toast shows stages, no spinner on the trigger (FR-018, FR-004); the argv log shows `repo clone owner/name <dir> -- --progress` as separate arguments.
7. On finish: toast "Cloned name" with **Open**, stays until dismissed; the Project is in the list; Settings > Projects shows the parent as the default (FR-015, FR-019, FR-020).
8. Reopen the dialog: destination prefilled `<default>\<name>`; checkbox hidden; change the parent: checkbox unticked but shown.
9. Pick the repository equal to the existing Project: **Already added** badge; the button reads **Open project** and selects that Project; no new `repo clone` in the log (FR-017).
10. Paste `https://evil.example/owner/name`, `http://github.com/o/n`, `git@github.com:o/n.git`, `owner/name/extra`, `-owner/name`: each is refused inline with `aria-invalid`; no `gh` call (FR-013, FR-025).
11. Destination non-empty: refused inline (FR-027). Destination is an existing empty folder: clone works; force a failure and confirm the empty folder remains.
12. Cancel mode: start a 60 s clone, press Cancel in the toast: "Clone cancelled", the child process is gone, and the folder Refract created is removed (FR-029, FR-030). Repeat with a pre-existing empty folder: it stays.
13. Failure mode: toast shows the fixed "not found or no access" sentence, persists, and contains no raw stderr (FR-032).
14. Start two clones, then close the app mid-clone: no `gh` child remains; created folders removed (FR-033).
15. Signed-out mode (fake returns no accounts): the dialog shows "Sign in to GitHub to see your repositories" with **Sign in**; paste still clones (FR-016).
16. Keyboard only: open the menu, move with arrows, Enter, Escape returns focus to the trigger; tab through the dialog and the toast Cancel (FR-002, FR-038). Check on at least the dark and light themes.
17. Run `pnpm ci:local` once; existing suites stay green. Note `check:parity` has no Electron side after #796.

PR 2: search the UI for "repository" on every screen reachable (Session list, Manage sessions, Pull requests, Settings, dialogs); only "GitHub repository" remains; `pnpm ci:local` including `check:ui-text` passes.
