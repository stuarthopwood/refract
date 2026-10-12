# Quickstart: verifying File explorer

Refract is a prototype with no automated tests. Each check below is a manual run of the app, per
story in [spec.md](spec.md).

## Prerequisites

- Windows 11, `pnpm install`, `pnpm dev` (or `pnpm build` + the built app), `pnpm typecheck`,
  `pnpm check:ui-text`.
- An isolated scratch instance with its own `--user-data-dir`, never Stuart's real profile
  (repo-wide safe-verification rule).
- At least one repository with an open Session, pointed at a real worktree containing a mix of
  text, markdown, image, and binary files, some tracked and some not (so git status marks and
  every preview kind are exercisable).
- VS Code installed at one of the three documented default install roots (research.md decision 1),
  to exercise Open in VS Code's success path; optionally, a second scratch Windows account or VM
  with no VS Code install, to exercise the "not found" state (SC-005).

## Checks per story

**Story 1: Browse and preview a text or code file (FR-001 to FR-004, FR-006, FR-012, FR-013,
Priority: P1)**

1. Open a Session with an open worktree, click the File explorer rail icon. Expect: the panel
   opens showing the worktree root's top-level entries, folders listed before files, sorted
   alphabetically within each group, with no child entries fetched until a folder is expanded.
2. Expand a folder. Expect: its children are fetched and rendered lazily (confirm via a
   main-process log or network/timing check that no other folder's children were fetched).
3. Click a `.ts` file. Expect: the preview region shows its content through the shared
   `CodeBlock`/Shiki highlighting, with line numbers and a wrap toggle.
4. Press the wrap toggle. Expect: long lines wrap or scroll horizontally without losing the
   current scroll position otherwise.

**Story 2: Preview markdown, images, and oversized/binary files (FR-002, FR-003, FR-012 to
FR-015, Priority: P1)**

1. Open a `README.md` (or similar). Expect: it renders through the shared `Markdown` component by
   default, with a Source toggle that swaps to the raw text through `CodeBlock` instead.
2. Open an image file (PNG/JPEG/GIF/WebP). Expect: it displays inline via a `data:` URL built from
   its base64 bytes (research.md decision 4), matching the DiffView/image-preview styling
   precedent (spec 009).
3. Open a binary file (a NUL byte found in the first preview slice, research.md decision 3) or a
   file exceeding the preview size cap. Expect: the preview region shows a "cannot preview" panel
   stating the file's size and detected type, never an empty pane or a partial/garbled render.

**Story 3: See git status marks on tree rows (FR-007 to FR-011, FR-024, Priority: P2)**

1. Modify a tracked file, add a new untracked file, and stage-but-not-commit a deleted file.
   Expect: the tree renders a status mark (icon plus text equivalent, matching the current `git
   status --porcelain` state) for each affected path -- never colour alone.
2. Confirm a path matching `.gitignore` does not appear by default; toggle "show ignored files".
   Expect: it appears, marked as ignored; confirm `.git` itself is never shown regardless of the
   toggle.

**Story 4: Open in VS Code, Reveal in File Explorer, Copy path (FR-016 to FR-019, Priority: P1)**

1. Right-click a file row (and separately, use the same action from the preview region's own
   toolbar). Expect: Open in VS Code, Reveal in File Explorer, and Copy path all reuse existing
   patterns (`SessionDetailsCard.tsx`'s own toolbar actions).
2. Choose Open in VS Code. Expect: `Code.exe` is spawned (`shell: false`, an args array) via the
   fixed-install-root resolver, focused on that file.
3. On a machine with no known VS Code install root found, choose Open in VS Code. Expect: a clear
   "VS Code not found" state is shown, with no silent fallback launcher.
4. Choose Reveal in File Explorer or Copy path. Expect: the action reuses the existing pattern
   (`SessionDetailsCard.tsx`'s own buttons), scoped instead to the selected tree row's own path.

**Story 5: Live refresh without losing expansion state (FR-020, Priority: P2)**

1. Expand several nested folders, have the folders open (or another agent) actively editing files
   in the Session's worktree without the developer opening/closing the tree. Expect: the tree
   updates in place with every watched file add/modify/delete; new files should appear, deleted
   ones should disappear, and every previously-expanded folder remains expanded (including itself
   or any of its ancestors).
2. While a file is being previewed, have that exact file deleted on disk. Expect: the preview
   region shows a clear "this file no longer exists" state rather than stale content or an error.

## Edge cases to exercise

- A symlink or junction inside the worktree that resolves outside it: confirm the tree never lists
  its contents as if they were inside it, and any read attempt is rejected by the same
  path-containment check as FR-001 (not a silent skip that could let a developer believe a path is
  empty).
- A huge repository (many thousands of entries in one folder): confirm the folder's listing is
  capped per `research.md` decision 7, with an "N more" row past the cap rather than an unbounded
  render or a frozen UI.
- A binary file selected for preview is aborted (User Story 2, Scenario 3); a path containing
  quoted characters (non-ASCII, embedded spaces) is handled correctly end-to-end through the shared
  `diffStat.ts`-style `-z`-based `git` invocation (research.md decisions 2 and 6).

## Full-gate checks (every story)

- `pnpm typecheck` and `pnpm build` pass.
- `pnpm check:ui-text` passes (no leaked "FR-NNN"/spec terms in the built bundle).
- `pnpm check:theme-contrast` passes with no new `token missing` row (no new token expected: the
  panel reuses existing surface/text tokens, same as every spec-013 panel).
- `pnpm check:drag-regions` (if present on the base branch) passes.
- A live directory listing, a live preview of a real file of each detected kind, a live git-status
  read, a live `fs.watch` refresh cycle, and a live `Code.exe` launch against a real installed VS
  Code are all exercised in the scratch instance -- never against Stuart's own Sessions.
