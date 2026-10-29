# Spec 054: Add project and clone from GitHub (#867)

**Branch**: `add-project-flyout` | **Created**: 2026-10-29 | **Status**: Draft | **Input**: issue #867 (grilled 2026-10-15) plus the 2026-10-29 delegated decisions (two-PR split, ui-architect-v3 ruling).

The "Add repository" button becomes **Add project**, a flyout with **Local folder...** and **Clone from GitHub...**. Cloning picks or pastes a GitHub repository, clones it in the background with progress and Cancel, then adds the clone as a Project. A default clone folder lives in a new Settings > Projects section. A second PR makes **Project** the user-facing term everywhere.

Terms (`CONTEXT.md`): **Project** is the local checkout added to Refract; **GitHub repository** is the remote copy. Cloning a GitHub repository creates a Project.

## Scope split

- **PR 1** (FR-001 to FR-040): flyout, `AddProjectDialog` (renamed from `AddRepositoryDialog`), Clone dialog, background clone with progress and Cancel, Settings > Projects default clone folder.
- **PR 2** (FR-041 to FR-046): user-facing Repository to Project string sweep, amend spec 001 FR-055, `CONTEXT.md`, `docs/design/*`. Strings only; identifiers, `repositories.*` channel names, the registry schema and `registry.json` do not change.

## User stories

### US1 - Add a Project by cloning a GitHub repository (P1, PR 1)

A developer opens **Add project > Clone from GitHub...**, filters the list of their and their organisations' repositories, picks one, accepts the prefilled destination and presses **Clone**. The dialog closes, a toast shows progress, and when it finishes the Project is in the Session list with an **Open** action.

**Independent test**: with a fake `gh` that answers `repo list` and `repo clone`, run the quickstart; the cloned folder exists and a Project row appears.

1. **Given** the user is signed in to gh, **When** the Clone dialog opens, **Then** the list shows own repositories first, then organisations A to Z, up to 100 most recently updated per owner, under sticky owner headers.
2. **Given** the list is shown, **When** the user types in the filter, **Then** rows narrow across all owners and "Showing X of Y" updates.
3. **Given** a row is selected and a destination is set, **When** the user presses **Clone**, **Then** the dialog closes at once and one loading toast per clone shows the current stage with a Cancel action.
4. **Given** a clone finishes, **When** the Project is added, **Then** the toast becomes "Cloned X" with **Open**, auto-dismissing after about 5 seconds.

### US2 - Pick a source by pasting (P1, PR 1)

A developer pastes `owner/name` or a `https://github.com/owner/name` URL for something not in the list (another person's public repository, an org they cannot list). This works signed out for public repositories.

1. **Given** the paste field holds `owner/name`, **When** the user presses **Clone**, **Then** the clone starts exactly as for a list row.
2. **Given** the paste field holds a non-GitHub host or a malformed value, **When** the field blurs or **Clone** is pressed, **Then** the field is `aria-invalid` with a described error and no process is spawned.
3. **Given** a row is picked, **When** the user types in the paste field (or the reverse), **Then** the other source clears.

### US3 - Add a local folder from the flyout (P1, PR 1)

**Add project > Local folder...** opens the existing dialog, retitled **Add project**, keeping paste-a-path and Browse.

1. **Given** the footer or the first-run screen, **When** the user opens the flyout, **Then** both items show, text only, in the order Local folder then Clone from GitHub.
2. **Given** the Local folder dialog, **When** a valid path is submitted, **Then** behaviour matches today's add.

### US4 - Default clone folder (P2, PR 1)

The Clone dialog prefills `<default clone folder>\<repo-name>`. With no default, the destination is empty and **Clone** is disabled until **Browse**. A **Use this folder for future clones** checkbox saves the parent folder. Settings > Projects > Cloning > **Default clone folder** shows, changes and clears it.

1. **Given** no default, **When** the dialog opens, **Then** the destination is empty, Clone is disabled and the checkbox is ticked and shown.
2. **Given** a default and an edited destination whose parent differs, **When** shown, **Then** the checkbox is unticked but visible; **Given** the parent equals the default, **Then** it is hidden.
3. **Given** the checkbox is ticked and Clone succeeds in starting, **Then** the parent folder is saved as the default.

### US5 - Already added (P2, PR 1)

A GitHub repository whose remote matches an existing Project shows an **Already added** badge. Choosing it, or pasting it, makes the primary button **Open project**, closes the dialog and selects the existing Project. No second clone.

### US6 - Signed out of gh (P2, PR 1)

The flyout item stays enabled. The list is replaced by "Sign in to GitHub to see your repositories" and a **Sign in** button reusing the R9 `gh auth login` flow. Paste and destination still work.

### US7 - Cancel and failure (P2, PR 1)

Cancel stops the clone, removes only the folder Refract created in this attempt, and shows "Clone cancelled". Failures persist in the toast with a plain-language reason.

### US8 - Project is the user-facing term (P3, PR 2)

Every user-visible string says Project where it means a local checkout; "GitHub repository" stays where it names GitHub's object.

## Functional requirements

### PR 1: flyout and dialogs

- **FR-001**: The Session list footer and the first-run screen show one **Add project** trigger (no ellipsis) with a chevron, replacing "Add repository". Footer: ghost button, `FolderPlusIcon`, trailing `ChevronUpIcon`, menu opens upward. First-run: filled primary button, `ChevronDownIcon`, menu opens below.
- **FR-002**: The trigger has accessible name "Add project" and `aria-haspopup="menu"`; arrows, Enter and Escape work and Escape returns focus to the trigger.
- **FR-003**: The menu holds exactly "Local folder..." and "Clone from GitHub...", text only, no icons. It is one shared component, `AddProjectMenu` (props: `variant`, `side`), built on `ui/dropdown-menu`.
- **FR-004**: The trigger shows no spinner and no busy state while clones run; a second clone may start while one runs (cap in FR-024).
- **FR-005**: "Local folder..." opens `AddProjectDialog` (renamed from `AddRepositoryDialog`, title **Add project**) with unchanged paste and Browse behaviour and unchanged `repositories.add`.
- **FR-006**: The Clone dialog is `CloneProjectDialog`, `sm:max-w-lg`, one step, in this order: filter, grouped list, paste field, **Clone into** folder plus **Browse**, **Use this folder for future clones** checkbox, footer **Cancel** and **Clone**.
- **FR-007**: The grouped list is `components/FilterableGroupedListbox.tsx`, extracted from the `ModelPicker` pattern (combobox plus listbox, `aria-activedescendant`). `ModelPicker` is not migrated in this story.
- **FR-008**: Own account first, organisations A to Z, up to 100 most recently updated repositories per owner, sticky owner headers, one filter box over name and description.
- **FR-009**: Rows show `owner/name`, a description as plain text (single line, truncated), and for private repositories a lock icon plus sr-only "Private". Colour is never the only cue.
- **FR-010**: A count "Showing X of Y" is visible and announced through a polite sr-only live region when the filter changes.
- **FR-011**: A per-owner load failure shows an inline "Couldn't load {owner}" row with **Retry** that re-requests only that owner; other owners stay usable.
- **FR-012**: Picking a row clears the paste field and typing in the paste field clears the picked row.
- **FR-013**: Paste is validated on blur and on **Clone**; failure sets `aria-invalid` and a described error. Accepted forms: `owner/name`; `https://github.com/owner/name`, optionally with `.git` or one trailing slash. Everything else is refused (FR-025).
- **FR-014**: Destination is prefilled `<default>\<repo-name>` and editable with **Browse** (`repositories.pickFolder`). **Clone** is disabled while the destination or the source is empty.
- **FR-015**: The checkbox is ticked and shown when no default exists; unticked but shown when the destination's parent differs from the default; hidden when equal. On a successful start with the box ticked, the renderer saves the destination's parent via `settings.setDefaultCloneFolder`.
- **FR-016**: Signed out (`signedIn: false`): the list is replaced by "Sign in to GitHub to see your repositories" and a **Sign in** button reusing the R9 `accounts.github.addStart` flow; on completion the list reloads. Paste and destination stay usable.
- **FR-017**: A repository whose GitHub remote matches a Project (case-insensitive `owner/name`, host `github.com`, any remote) shows an outline **Already added** badge, stays enabled, and turns the primary button into **Open project**, which closes the dialog and selects that Project. The same applies to a pasted source (the backend answers `existing`, FR-021).
- **FR-018**: Pressing **Clone** closes the dialog immediately. Each clone has one non-dismissible loading toast (via a new progress-toast helper in `notify.ts`) showing the fixed stage text (no percentages) and a **Cancel** action.
- **FR-019**: On success the toast becomes "Cloned {name}" with **Open** and auto-dismisses after about 5 seconds. On cancel it shows "Clone cancelled". Errors persist until dismissed. Toast text changes announce politely; errors announce assertively.
- **FR-020**: Settings gains a **Projects** section with a **Cloning** group and one `SettingRow` "Default clone folder": truncated monospace path or muted "Not set", **Browse**, and **Clear** (always shown, disabled when empty). Changes save immediately.

### PR 1: backend

- **FR-021**: `repositories.clone` validates the source (FR-025) and destination (FR-027), finds an existing Project by remote (FR-017) and replies `{ kind: 'existing', projectId }`, or spawns the clone and replies `{ kind: 'started', cloneId }`. It does not wait for the clone to finish.
- **FR-022**: The clone runs `gh repo clone <owner/name> <destination> -- --progress`, as an argument array, with no shell, `CREATE_NO_WINDOW`, stdin closed, and `gh` located by `resolve_gh` (which prefers `%LOCALAPPDATA%\refract\tools\gh\gh.exe` over PATH, #1343; the spec relies on that existing behaviour and does not change it). No token is read, stored or passed; gh's own auth and `git_protocol` apply. Forks keep gh's default `upstream` remote.
- **FR-023**: Progress is parsed from the child's stderr (split on `\r` and `\n`) into fixed stages: Starting, Receiving objects, Resolving deltas, Updating files. Emitted text is only these fixed stage names plus an optional integer percent; raw stderr is never emitted or logged. Events are throttled to at most 4 per second per clone and always sent on a stage change.
- **FR-024**: At most 4 clones run at once; a fifth is refused with "Too many clones are running. Wait for one to finish." Two clones to the same resolved destination are refused.
- **FR-025**: Source validation in Rust only. Owner: 1 to 39 chars of `[A-Za-z0-9-]`, not starting or ending with `-`, no `--`. Name: 1 to 100 chars of `[A-Za-z0-9._-]`, not `.` or `..`, one trailing `.git` stripped. URL: scheme `https` only, host exactly `github.com` (ASCII case-insensitive), no userinfo, port, query or fragment, exactly two path segments (a trailing `/` allowed). `git@`, `http`, other hosts, `tree/...` paths and anything with whitespace or control characters are refused with `invalid-argument`. The renderer never builds a `gh` argument.
- **FR-026**: `repositories.listGitHub` runs `gh auth status --json hosts` to find signed-in `github.com` accounts, lists organisations with `gh api user/orgs --paginate --jq .[].login` (active account), then one `gh repo list <owner> --json nameWithOwner,description,isPrivate,updatedAt --limit 100` per owner, 4 at a time, 30 seconds per owner. Owners come from gh output and are re-validated by FR-025 before use as an argument. Results sort by `updatedAt` descending per owner.
- **FR-027**: Destination rules: absolute path; parent exists and is a directory; the final segment is not a Windows reserved device name and has no trailing dot or space; the destination is not a drive root, a Project path, or inside `.git`. A destination that exists and is not empty is refused ("That folder already exists and isn't empty."). An existing empty folder is allowed but is treated as pre-existing (FR-029).
- **FR-028**: Descriptions from gh are stripped of control and bidi-format characters, truncated to 300 characters, and rendered by the renderer as plain text only (no markdown, no HTML, no links).
- **FR-029**: Before spawn, Refract records `created_by_us = !destination.exists()` and the literal resolved destination path. On cancel or failure, if and only if `created_by_us`, Refract removes that exact path after the child tree has exited, after re-checking the path equals the recorded one and is not a root, the parent, a Project path, or the home folder. A pre-existing folder is never removed or emptied. Removal failure is reported ("Cancelled; couldn't remove {path}").
- **FR-030**: `repositories.cloneCancel(cloneId)` is idempotent: close stdin, then `taskkill /T /F` after the 750 ms grace, as `GhLoginFlow::cancel` does. An unknown or finished `cloneId` replies ok with no effect.
- **FR-031**: On exit code 0, Refract adds the destination through the same add path as `repositories.add` (shared function, no behaviour change to `repositories.add`) and emits `done` with the new Project. If the add fails after a successful clone, the clone folder is kept and the toast says "Cloned to {path}, but couldn't add it as a Project. Use Add project > Local folder."
- **FR-032**: A failed exit maps to one fixed sentence by exit code and a 2 KB private stderr tail (not found or no access, signed out, network, destination problem, other): never raw stderr.
- **FR-033**: On app exit every running clone is cancelled and cleaned up best-effort (FR-029 applies).
- **FR-034**: `repositories.listGitHub` returns `signedIn: false` with no owners when no `github.com` account exists, and an error with code `gh-unavailable` when gh is missing; the dialog then shows the sign-in or install message and keeps paste usable.
- **FR-035**: `settings.defaultCloneFolder` is stored in `settings.json` under `defaultCloneFolder` (string or absent). `settings.setDefaultCloneFolder(path | null)` accepts an absolute existing directory or null; an invalid stored value reads as null. The change broadcasts `settings:changed`.
- **FR-036**: New IPC types live in new `src/shared` modules (`ipc-repositories-clone.ts`); `src/shared/ipc.ts` stays at or under its 902-line baseline. New Rust code lives in `src-tauri/src/ipc/repositories_clone.rs` and `src-tauri/src/github/repo_ref.rs`, `repo_list.rs` and `repo_clone.rs`; `repositories.rs` changes by no more than a few lines (extract the add function).
- **FR-037**: The Clone dialog loads data only through the new channels; no avatars, web views or remote content (constitution Principle V).
- **FR-038**: Clone progress, errors and the Cancel action are keyboard reachable; focus moves to an error message when the dialog shows one; all new UI meets 4.5:1 contrast on every theme using existing tokens.
- **FR-039**: Every new control is a shared component (`components/` and `components/ui/`); no hand-styled one-off (ADR 0003).
- **FR-040**: No new tests are written (prototyping rule). Verification is the quickstart live check and the existing suites staying green via `pnpm ci:local`.

### PR 2: Project term

- **FR-041**: Every user-visible string, announcement, tooltip, empty state and Rust error message that reaches the UI says **Project** for a local checkout (including `REPOSITORY_HAS_SESSIONS_MESSAGE`); each regex hit is classified, and identifiers are left alone.
- **FR-042**: **GitHub repository** stays where it names GitHub's own object ("Clone a GitHub repository", "This project has no GitHub repository").
- **FR-043**: `repositories.*` channel names, TypeScript and Rust identifiers, the registry schema and `registry.json` are unchanged; no migration.
- **FR-044**: `specs/001-core-session-workspace/spec.md` FR-055's term list changes from "Session, Repository, Conversation, Base branch" to "Session, Project, Conversation, Base branch". The ban on development-process words is unchanged.
- **FR-045**: `CONTEXT.md` makes Project the term and moves Repository to _Avoid_ for UI copy; `docs/DESIGN.md` and `docs/design/*` wording follows.
- **FR-046**: `scripts/check-ui-text.mjs` still passes (its patterns do not match the word Project).

## Edge cases

- Destination exists and is non-empty: refused before spawn, inline error on the destination field.
- Destination is an existing empty folder: clone proceeds; on failure the folder is left, not removed.
- Same repository already cloned elsewhere: shown as **Already added**; no second clone.
- Repository name that matches a Windows reserved name: refused.
- gh not installed: list shows an install message; paste fails with "The GitHub CLI (gh) isn't installed."
- Private repository, wrong account active: clone fails with the "not found or no access" sentence.
- App quit mid-clone: clones cancelled; created folders removed best-effort.
- Cancel pressed after the child exited: no effect.
- Very long description or control characters: sanitised, truncated.
- Many organisations: owners load 4 at a time; rows appear as each owner returns, with a per-owner loading row.
- A second clone started while one runs: allowed up to 4.
- The removal target changed between record and cleanup (symlink, junction): cleanup refuses and reports.

## Success criteria

- A developer clones a listed or pasted repository and sees the Project without touching a terminal.
- Closing the dialog never stops a clone; Cancel always does, and leaves no folder Refract created.
- No code path builds a shell string or runs `gh` with an unvalidated owner, name or URL.
- `pnpm ci:local` is green, and the quickstart live check passes with the fake `gh`.
- After PR 2, no user-visible string says "repository" for a local checkout.

## Clarifications

Session 2026-10-29. Each answer is taken from the issue body, its 2026-10-15 grill, or the 2026-10-29 delegated decisions; none needed Stuart.

- Q: One PR or two? A: Two. PR 1 is the flyout, Clone dialog, background clone and default folder; PR 2 is the string sweep (decision a).
- Q: Does the Electron feature-detection note apply? A: No; Electron is gone (#796), the channels are always present (decision b).
- Q: Does the trigger show a spinner while cloning (issue grill 6)? A: No; the toast is the single progress surface (UI ruling overrides grill 6's spinner line).
- Q: Where does the default clone folder live and what happens with none? A: Settings > Projects; empty destination with Clone disabled until Browse, and a "Use this folder for future clones" checkbox ticked by default (grill 2, 3).
- Q: Which repositories are listed? A: Own plus every organisation, 100 most recently updated per owner, grouped, one filter; paste covers the rest (grill 4).
- Q: What if the repository is already a Project? A: Matched by GitHub remote URL, "Already added", choosing it selects the existing Project (grill 5).
- Q: What does a long clone do when the dialog closes? A: Continues in the background with a toast and Cancel; Open on success (grill 6, toast detail from the UI ruling).
- Q: Signed out? A: Item stays enabled; sign-in prompt reusing R9; paste still works (grill 7).
- Q: What does the rename touch? A: User-facing text only; identifiers, channels and registry unchanged; amend FR-055 and `CONTEXT.md` (issue, decision a).
- Q: Which IPC and settings names? A: `repositories.listGitHub`, `repositories.clone`, `repositories.cloneCancel`, event `repositories.cloneProgress`, settings key `defaultCloneFolder` (issue proposals plus the lane brief). The setter channel `settings.setDefaultCloneFolder` is chosen here to match the existing `settings.set*` convention.
- Q: Which accounts' private repositories are listed? A: Those the gh active account can see; Refract never switches accounts. Owners are every signed-in `github.com` account login plus the active account's organisations. (Assumption, see analysis.)
- Q: What if the add step fails after a successful clone? A: Keep the clone and say so; never delete a complete clone. (Assumption.)
