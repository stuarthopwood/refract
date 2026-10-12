# Feature Specification: File explorer

**Feature Branch**: `015-file-explorer` (work lands branches/PRs by phase, this directory is the
Spec Kit record; not a literal git branch)

**Created**: 2026-10-12

**Status**: Draft

**Input**: [issue://463](https://github.com/stuarthopwood/refract/issues/463) ("right-panel file
and folder explorer with file preview and Open in VS Code"), the triage comment on that issue
(feature/p2/ready-for-agent/Spec-Kit-route=specify, area=right-pane), and the decision comment
[issuecomment-6116156748](https://github.com/stuarthopwood/refract/issues/463#issuecomment-6116156748)
that settles the right-panel-vs-left-list placement, read-only scope, and every conservative
choice listed in Clarifications below.

## Clarifications

### Already decided (cited, not re-asked)

- **Q (issue://463, Stuart 2026-10-06)**: does the file explorer live in the right-hand panel or
  the left Session list? -> **A**: the right-hand panel, a tab in the C1 shell (spec 013/014),
  not the left Session list. Split out of #1 (side chat remains there).
- **Q (decision comment)**: is this read-only, or does it support in-app editing? -> **A**:
  read-only; editing happens in VS Code only, never in Refract.
- **Q (decision comment)**: which Session's tree does the panel show, and how does that bind? ->
  **A**: whichever Session the focused chat pane currently shows, no independent binding -- the
  same pattern spec 013's Subagents panel and spec 014's Side chat already use. A split's two
  panes each show their own focused Session's tree (no dual-rooted single tree).
- **Q (decision comment)**: which editor does "Open in VS Code" launch, and is there a picker? ->
  **A**: VS Code only, hardcoded -- no Settings editor-picker (Insiders/Cursor/custom) this round,
  carved to `future/open-questions.md`.
- **Q (decision comment)**: does "Open in VS Code" pass a line number? -> **A**: not built this
  round -- nothing in the app currently has a line number to hand it; carved out.
- **Q (decision comment)**: does the tree include OMP-owned folders (`.omp`, rules, skills)? ->
  **A**: out of scope; the tree roots at the worktree only.
- **Q (decision comment)**: does this spec build the "Add to prompt" (@ mention) flow? -> **A**:
  deferred; #465 itself is unbuilt.
- **Q (decision comment)**: does this spec build the search/filter (fuzzy find-file) box? -> **A**:
  carved out of this first build entirely; `future/open-questions.md`.
- **Q (decision comment)**: are git status marks gated on #464 (the git-changes panel), which
  doesn't exist yet? -> **A**: no circular dependency -- this spec builds a new, small, shared
  main-process git-status reader now (not part of #464's own scope), which #464 will later reuse.
- **Q (decision comment)**: which context-menu actions ship this round? -> **A**: Open in VS Code,
  Reveal in File Explorer, Copy path (all reuse existing patterns, e.g.
  `SessionDetailsCard.tsx`'s own Copy path/Open in file explorer buttons) -- NOT "Open with default
  app" this round (a fourth near-duplicate launcher path, its own follow-up).
- **Q (Main, Slice 1)**: does the preview filter out secrets-shaped files (`.env`, credentials,
  private keys) by name or content? -> **A**: no. The preview shows any file inside the Session's
  worktree that the developer could already open directly in an editor -- the same files VS Code
  itself would show, no secrets-aware filtering of `.env` or anything else by name or content.
  Two things bound the risk this choice accepts: (1) nothing read for preview ever enters the
  main transcript or OMP's own context (FR-027 below) -- previewing a secret shows it ON SCREEN
  to the developer who is already in that worktree, it does not leak it to the agent or anywhere
  OMP can see; (2) every read still goes through the exact same worktree-containment check as
  every other read (FR-001) -- `resolveInWorktree`'s own `resolveNoFollow` walk (`src/main/ipc/
  files.ts`) vets a path one segment at a time from the realpath'd root, re-checking any
  symlink/junction's OWN target (however many hops deep) before ever calling `fs.realpath`/
  `fs.stat` on it, so nothing outside the Session's own worktree is ever reached this way. (PR
  #671 gate round 2 history: round 1's own fix vetted only a link's FIRST hop, so a chain --
  `a` -> in-root `b`, `b` -> a UNC share -- or a link sitting in a middle path segment still
  reached `fs.realpath` unvetted, reproduced live as a zero-click outbound SMB/NTLM connection;
  fixed by walking every hop, not just the first.) This choice only ever exposes a file the
  developer's own Session already has on disk, never a file from elsewhere on the machine.

### Needs Stuart's decision (not yet resolved; decision comment posted, conservative choice taken)

- **Q (PR #671 gate round 5, Code5/Main's own instruction)**: FR-010 currently lists `deleted` as
  one of the git status marks tree rows show -- but a deleted TRACKED file structurally cannot
  have a row at all (`listDirectory` lists via `readdir`, which has no entry for a path that no
  longer exists, so there is nothing left to attach a `deleted` mark to; `getStatus`'s own
  `GitStatusMap` still correctly reports `deleted` for such a path, just with no row in the tree
  to show it on). Posted to issue #463 for Stuart's decision; conservative choice taken for now
  (not blocking this PR): FR-010 is read as covering modified/added/untracked only for anything
  rendered as a row, `deleted` stays a real, correct value in the underlying map (useful to #464's
  future reuse) but is never expected to render here. **A (pending)**: synthetic "ghost" rows for
  a deleted tracked file (so the mark has somewhere to render) are deferred, not built this round
  -- Stuart can overrule and ask for them in a follow-up.
- **Q (PR #671 gate rounds 7-13, A11y/Code/Verif reviewers)**: FR-022's roving-tabindex tree is
  virtualised (`react-virtuoso`), and FR-025 says resizing/switching panels MUST NOT lose the
  tree's current focus position. When the focused (and possibly selected) row scrolls out of the
  rendered window -- a mouse wheel, `PageUp`/`PageDown` (no longer a cause since round 11: the
  tree scrolls only to follow focus via `moveToRow`, so the focused row is never scrolled away by
  keys), or a
  window-resize changing Virtuoso's rendered range -- rounds 7-9 each tried a rescue (hop focus to
  another rendered row), and each one introduced a worse defect of its own (moving selection the
  user never navigated to, re-firing on every scroll tick as screen-reader noise, or -- round 9's
  deferred version -- stealing focus back after the user had deliberately clicked elsewhere on
  purpose). Round 10 removed rescue-on-scroll-out entirely rather than ship a fourth attempt;
  focus now drops to `<body>` and stays there until the user tabs back in (Tab or Shift+Tab,
  whichever direction the row left in, [INFERENCE] probe-observed against a minimal scratch page
  -- pressing the OPPOSITE key instead leaves the tree entirely rather than re-entering it; not
  live-verified against this actual tree by keyboard or screen reader as of round 13).
  Posted to issue #463 for Stuart's decision; conservative choice taken for now (not blocking this
  PR, but FR-025 is marked Partial in the AC table rather than Done until this is resolved): ship
  with the disclosed limitation rather than add a fourth rescue mechanism under gate pressure.
  **A (pending)**: two real mitigations exist and are NOT built -- keep the focused row's own
  index always rendered (Virtuoso's `increaseViewportBy`, or a `scrollIntoView` on the focused
  index on every `rangeChanged`), or switch the tree to the `aria-activedescendant` pattern so DOM
  focus never actually leaves the `role="tree"` container even while the active row is
  virtualised away. Stuart can ask for either as a follow-up, or accept the disclosed limitation
  as shipped.

### Carved out, not blocking

- Settings editor-picker beyond VS Code (item above).
- "Open in VS Code" with a line number (item above).
- OMP-owned folders in the tree (item above).
- "Add to prompt" (@ mention, #465) (item above).
- Search/filter (fuzzy find-file) box (item above).
- "Open with default app" context-menu action (item above).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Browse and preview a text or code file (Priority: P1)

A developer wants to glance at a file in the Session's worktree without switching to VS Code --
"what does this function do" or "did the agent actually write the file I expect."

**Why this priority**: the core interaction this entire feature exists for (issue://463 "file
preview"); without it, nothing else in this spec has a reason to exist.

**Independent Test**: open the File explorer panel for a Session, expand a folder, click a `.ts`
file, and confirm its syntax-highlighted content renders with line numbers while the rest of the
app (main transcript, other panels) stays unaffected.

**Acceptance Scenarios**:

1. **Given** a Session with an open worktree, **When** the developer opens the File explorer
   panel, **Then** the tree shows the worktree root's top-level entries, folders before files,
   sorted alphabetically within each group, lazily loaded (no child entries fetched until a folder
   is expanded).
2. **Given** the tree is showing, **When** the developer clicks a text/code file row, **Then** the
   preview region shows that file's content through the shared `CodeBlock`/Shiki highlighting
   (`features/chat/Markdown.tsx`), with line numbers and a wrap toggle.
3. **Given** a file is previewed, **When** the developer presses the wrap toggle, **Then** long
   lines wrap or scroll horizontally without losing the current scroll position otherwise.

### User Story 2 - Preview markdown, images, and oversized/binary files (Priority: P1)

A developer opens a `README.md`, a screenshot the agent saved, or accidentally clicks a large
binary and needs each case to show something true, never a broken or misleading render.

**Why this priority**: issue://463 names all three file-preview shapes explicitly (markdown
rendered, images shown, binary/too-large shows a clear state); shipping only the plain-text case
would leave the feature visibly incomplete for its own stated scope.

**Independent Test**: preview a `.md` file (confirm rendered + a Source toggle), a `.png` (confirm
it renders inline), and a file over the size cap or binary file (confirm the "cannot preview"
panel with size/type, never a partial or garbled render).

**Acceptance Scenarios**:

1. **Given** a markdown file is selected, **When** the preview renders, **Then** it shows through
   the shared `Markdown` component by default, with a Source toggle that swaps to the raw text
   through `CodeBlock` instead.
2. **Given** an image file (PNG/JPEG/GIF/WebP, matched by magic bytes) is selected, **When** the
   preview renders, **Then** the image displays inline via a `data:` URL built from its base64
   bytes (research.md decision 4), reusing the DiffView/image-preview styling precedent (spec 009)
   rather than a new image-viewing convention.
3. **Given** a file is binary (a NUL byte found in its first slice, research.md decision 3) or
   exceeds the preview size cap, **When** the developer selects it, **Then** the preview region
   shows a "cannot preview" panel stating the file's size and detected type, never an empty pane
   or a partial/garbled render that looks complete.

### User Story 3 - See git status marks on tree rows (Priority: P2)

A developer wants to spot at a glance which files the agent touched without opening a diff panel.

**Why this priority**: named explicitly in issue://463 ("git status marks"), but the tree is
useful without it (P1 stories above stand alone), so this is the first enhancement layer, not the
floor.

**Independent Test**: modify a tracked file, add a new untracked file, and confirm both rows show
a distinct, non-colour-only mark (icon and/or text) matching their real git state, refreshing when
the underlying file changes again.

**Acceptance Scenarios**:

1. **Given** the worktree has a modified tracked file, an added (staged) file, an untracked file,
   and a deleted-but-still-listed file, **When** the tree renders, **Then** each row shows a status
   mark (icon plus text equivalent, or text alone -- never colour alone per accessibility
   requirements) matching the current `git status --porcelain` state for that path.
2. **Given** `.gitignore` matches a path, **When** the tree renders with the default (ignored files
   hidden) setting, **Then** that path does not appear; **When** the developer turns on "show
   ignored files," **Then** it appears, marked as ignored, still never inside `.git` itself (which
   is never shown regardless of the toggle).

### User Story 4 - Open in VS Code, Reveal in File Explorer, Copy path (Priority: P1)

A developer previewing a file decides to actually edit it, or wants its real OS location.

**Why this priority**: issue://463's title itself names "Open in VS Code" as a headline
capability, and it is the feature's only bridge from read-only preview to real editing -- without
it, the panel is a dead end for any file the developer actually wants to change.

**Independent Test**: right-click a file row (and separately, use the same action from the preview
region's own toolbar) and confirm Open in VS Code launches `Code.exe` on that exact file, Reveal
in File Explorer opens the OS file manager focused on it, and Copy path puts its path on the
clipboard -- all three with VS Code genuinely absent from every known install root producing a
clear "not found" state, never a silent failure.

**Acceptance Scenarios**:

1. **Given** a file row or an open preview, **When** the developer chooses Open in VS Code (row
   context menu or preview toolbar), **Then** `Code.exe` is spawned (`shell: false`, an args array)
   via the fixed-install-root resolver (research.md decision 1), focused on that file.
2. **Given** VS Code is not found at any known install root, **When** the developer chooses Open
   in VS Code, **Then** a clear "VS Code not found" state is shown, with no fallback launcher and
   no silent no-op.
3. **Given** a file row, **When** the developer chooses Reveal in File Explorer or Copy path,
   **Then** the action reuses the existing pattern `SessionDetailsCard.tsx`'s own buttons already
   establish for the worktree root, scoped instead to the selected file's own path.

### User Story 5 - Live refresh without losing expansion state (Priority: P2)

An agent is actively editing files in the Session's worktree while the developer has the tree
open; new files should appear, deleted ones should disappear, without collapsing folders the
developer has open.

**Why this priority**: issue://463 names this explicitly ("refresh via file watcher without losing
expansion state"), but a one-shot, manually-refreshed tree (P1 stories above) is still useful on
its own -- this is the live layer on top.

**Independent Test**: expand several nested folders, have the agent (or a manual `git` operation)
add/modify/delete files in the watched tree, and confirm the tree updates in place with every
previously-expanded folder still expanded.

**Acceptance Scenarios**:

1. **Given** several folders are expanded, **When** a file is added inside one of them, **Then**
   that folder's listing gains the new row (sorted into place) without collapsing any folder,
   including itself or its ancestors.
2. **Given** a file is being previewed, **When** that exact file is deleted on disk, **Then** the
   preview region shows a clear "this file no longer exists" state rather than stale content or an
   error.

### Edge Cases

- A symlink or junction inside the worktree that resolves outside it: the tree never lists its
  target's contents as if they were inside the worktree, and any read attempt is rejected by the
  same path-containment check every other read goes through (FR-001) -- surfaced as a plain
  "cannot access" row state, not a silent skip that could let a developer believe a path is empty.
- A worktree reached through OneDrive Files-On-Demand (or another cloud-sync provider using
  reparse-point placeholders), a deduplicated file, or an `AppExecLink`: **corrected, PR #671
  gate round 3** -- round 2's own note here claimed every one of these reports as a link the same
  way a real symlink/junction does (`isSymbolicLink()`); that was [INFERENCE] and is WRONG,
  contradicted by direct observation against a real OneDrive folder with four such placeholder
  entries, all four of which Node's own `readdir({ withFileTypes: true })` reported as ordinary,
  non-link entries (`isSymbolicLink()` false for every one). By default, a cloud-sync placeholder
  hides its reparse attribute from an application that has not specifically opted in to seeing
  it, so it lists and classifies as a normal file or folder -- it never reaches the no-follow
  walk at all. The real, still-open question this raises for Slice 2 is different from a
  containment one: reading such a placeholder's CONTENT (`readPreview`) can trigger the cloud
  provider to "hydrate" (download) it on demand, an I/O-cost and privacy consideration T019 must
  account for, not a path-escape one. [INFERENCE: the hydration behaviour itself was not
  exercised, only the `isSymbolicLink()` reporting was.]
- A file is deleted while its preview is open (User Story 5, Scenario 2).
- A huge repository (many thousands of entries in one folder): the folder's own listing is capped
  per `research.md` decision 7, with a "N more" row past the cap rather than an unbounded render
  or a frozen UI.
- A binary file selected for preview (User Story 2, Scenario 3).
- The `.gitignore` toggle (User Story 3, Scenario 2).
- VS Code genuinely absent (User Story 4, Scenario 2).
- A path containing characters git itself quotes by default (non-ASCII, embedded spaces): handled
  correctly end-to-end because every git invocation in this spec uses `-z` (research.md decisions
  2 and 6), the same precedent `diffStat.ts` already established for its own `ls-files -z` call.

## Requirements *(mandatory)*

### Functional Requirements

**IPC and path safety (constitution V)**

- **FR-001**: Every file-system read (directory listing, preview content, status, VS Code launch
  target) MUST happen in the main process behind IPC; the renderer MUST never receive a raw `fs`
  handle, and every resolved path MUST be checked to stay inside the Session's worktree root,
  including through symlinks and junctions, before any read is attempted.
- **FR-002**: Every preview read MUST be size-capped; a file over the cap MUST return the
  "cannot preview" state (User Story 2, Scenario 3) rather than a partial read presented as
  complete.
- **FR-003**: Binary detection MUST be by file content (a NUL byte within a capped header slice,
  research.md decision 3), never by file extension alone.

**Tree behaviour**

- **FR-004**: The tree MUST root at the focused chat pane's own Session's worktree (constitution
  III: the Session's cwd is its worktree), with no independent root binding -- matching the pattern
  spec 013's Subagents panel and spec 014's Side chat already use (per-Session, not per-app).
- **FR-005**: The tree MUST lazy-load: a folder's children are fetched only on first expansion,
  never the whole tree up front.
- **FR-006**: The tree MUST sort folders before files, then alphabetically within each group.
- **FR-007**: The tree MUST never show `.git` itself, regardless of the "show ignored files"
  toggle (FR-009).
- **FR-008**: OMP-owned folders (`.omp`, rules, skills) are out of this spec's scope (Clarification
  item 6) -- the tree is not required to hide them specially, but is not required to surface them
  either; whatever the worktree's own filesystem contains at the root is shown subject to the
  ignore rules below.

**Ignore handling and git status (User Story 3)**

- **FR-009**: The tree MUST respect `.gitignore` by default (ignored paths hidden) and MUST offer a
  "show ignored files" toggle that reveals them, marked as ignored, without this toggle ever
  revealing `.git` itself (FR-007).
- **FR-010**: Git status marks (modified/added/untracked/deleted) MUST be shown per row as text or
  an icon-plus-text pairing, never colour alone (accessibility baseline, same rule FR-008 in spec
  014 establishes for side-chat error records).
- **FR-011**: The git-status/ignore read MUST be a single shared main-process reader
  (research.md decisions 2 and 6) built for reuse by the future git-changes panel (#464), not
  gated on that panel's own existence or scope.

**Preview per file type (User Story 1, User Story 2)**

- **FR-012**: A text/code file MUST preview through the existing shared `CodeBlock`/Shiki
  highlighting with line numbers, plus a wrap toggle.
- **FR-013**: A markdown file MUST preview rendered by default through the existing shared
  `Markdown` component, with a Source toggle that swaps to its raw text via `CodeBlock`.
- **FR-014**: An image file (matched by magic bytes, not extension) MUST preview inline as a
  `data:` URL built from its base64 bytes, following the existing convention
  `attachments.ts`/`AttachmentStrip.tsx` already establish for a pasted image's `previewUrl`
  (research.md decision 4) -- no new bytes-to-`<img>` convention is introduced.
- **FR-015**: A binary file or a file over the preview size cap MUST show the "cannot preview"
  panel with its detected size and type, never a partial render presented as complete.

**Open in VS Code and other context-menu actions (User Story 4)**

- **FR-016**: Open in VS Code MUST be offered from both the row context menu and the preview
  region's own toolbar, and MUST launch `Code.exe` resolved via a dedicated fixed-install-root
  resolver (research.md decision 1) with `shell: false` and an args array -- never via
  `resolveExecutable('code')` (which would resolve to the unspawnable `code.cmd`) and never via
  `shell: true`.
- **FR-017**: If no known VS Code install root resolves, the system MUST show a clear "VS Code not
  found" state; it MUST NOT fall back to `shell.openPath` or any other launcher silently.
- **FR-018**: Reveal in File Explorer and Copy path MUST be offered from the row context menu,
  reusing the existing pattern `SessionDetailsCard.tsx`'s own worktree-root buttons already
  establish, scoped to the selected file's own path.
- **FR-019**: "Open with default app" MUST NOT ship this round (Clarification item 11).

**Live refresh (User Story 5)**

- **FR-020**: The tree MUST refresh via a file watcher (`fs.watch({ recursive: true })`,
  research.md decision 5) without losing any folder's expansion state; a watcher event MUST
  trigger a re-list of its own affected directory, debounced against a burst of rapid events,
  never a full tree rebuild.
- **FR-021**: If the file currently open in preview is deleted, the preview region MUST show a
  clear "this file no longer exists" state rather than stale content or a thrown error.

**Accessibility (WAI-ARIA tree pattern)**

- **FR-022**: The tree MUST implement the WAI-ARIA tree pattern: `role="tree"`/`role="treeitem"`,
  `aria-expanded` on every expandable node, arrow-key navigation (left/right to collapse/expand or
  move to parent/first child, up/down to move between visible rows), Home/End to jump to the
  first/last visible row, type-ahead to jump to a row by its first letters, Enter to open that
  row's preview, and exactly ONE tab stop for the whole tree (roving `tabindex`), matching the
  shell's existing focus-management requirements (spec 013 FR-023 to FR-026).
- **FR-023**: The preview region MUST be a labelled, keyboard-scrollable region, reachable by Tab
  from the tree.
- **FR-024**: Status marks (FR-010) MUST carry a text equivalent even when shown with an icon.
- **FR-025**: Resizing the pane or switching panels (the shared right-pane shell, spec 013) MUST
  NOT lose the tree's current focus position or expansion state.

**Panel registration**

- **FR-026**: The system MUST register a new `file-explorer` panel in `panel-registry.ts`, hosted
  by spec 013's shell (rail icon, launcher entry, tab/title-row participation), alongside
  `subagents`/`fdb-knowledge`/`agent-builder`/`side-chat`, replacing none of them.

**Content exposure (Clarification item, Main's own Slice 1 ask)**

- **FR-027**: The system MUST NOT filter preview content by file name or content for
  secrets-shaped files (`.env`, credentials, private keys, or any other pattern) -- any file
  inside the Session's worktree the developer could already open directly in an editor MUST be
  previewable the same way (Clarification item 5 above). Nothing read for a directory listing,
  preview, or git status MUST ever be forwarded into the main transcript or any OMP RPC request
  (constitution II/V) -- a preview is shown on screen to the developer alone, never surfaced to
  the agent or anywhere OMP can see it.

### Key Entities

- **FileTreeNode**: one row's data -- its path (relative to the worktree root), kind
  (file/folder), expansion state (for a folder), lazy-loaded children (once expanded), and its
  current git status mark (User Story 3). Not a Refract-owned cache of file content -- only of
  what the tree currently shows and which nodes are expanded.
- **FilePreview**: the currently-selected file's preview data -- its detected kind
  (text/markdown/image/binary/too-large), and for a renderable kind, its content (text) or base64
  bytes plus MIME type (image), per FR-012 to FR-015. Cleared or replaced to a "no longer exists"
  state if the underlying file disappears (FR-021).
- **GitStatusMap**: the per-path result of the single shared git-status/ignore reader
  (research.md decisions 2 and 6) for one worktree -- modified/added/untracked/deleted/ignored,
  keyed by path, refreshed alongside the tree's own live-refresh cycle (FR-020), reused as-is by
  the future git-changes panel (#464, FR-011).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of previewed files over the size cap, or detected as binary, show the
  "cannot preview" state with size and type, never a partial render that looks complete (User
  Story 2, FR-002/FR-015).
- **SC-002**: Every read reaching the file system (listing, preview, status) resolves and checks
  its path against the worktree root before any disk access, including through a symlink or
  junction; zero reads escape the worktree in any tested scenario (FR-001, Edge Cases).
- **SC-003**: Expanding, collapsing, and refreshing (via the file watcher) never collapses a
  folder the developer did not collapse themselves -- 100% of previously-expanded folders remain
  expanded across a live-refresh cycle (User Story 5, FR-020).
- **SC-004**: 100% of git status marks render with a text equivalent (icon-plus-text or text
  alone); zero rely on colour alone (User Story 3, FR-010/FR-024).
- **SC-005**: Open in VS Code succeeds (spawns `Code.exe` with the target file) on a machine with
  VS Code installed at any of the three known roots, and shows the clear "not found" state with
  zero silent fallback when none resolves (User Story 4, FR-016/FR-017).
- **SC-006**: The tree remains keyboard-operable end-to-end (expand, collapse, navigate, open a
  preview) with exactly one Tab stop for the whole tree, matching the WAI-ARIA tree pattern
  (FR-022, SC-006 of spec 013's own accessibility bar for icon-only controls).

## Assumptions

- Windows 11, Electron/React stack, no new runtime dependency: tree virtualisation reuses
  `react-virtuoso` (4.18.16), already a pinned dependency confirmed present in `package.json`
  (research.md decision 7) -- consistent with spec 013's own Technical Context default.
- This spec assumes spec 013's shell (panel registry, rail, tab bar, launcher) and spec 014's
  per-Session panel-binding precedent as already built and unchanged by this feature.
- The exact VS Code install-root paths (research.md decision 1) are the three documented default
  locations for a Windows one-click or system install; a non-standard custom install location is
  out of scope (would show the "not found" state), consistent with "VS Code only, hardcoded, no
  picker" (Clarification item 4).
- The git-status reader (FR-011) is built now as a small, shared, standalone module specifically so
  #464 (git-changes panel) can reuse it later without this spec depending on #464's own unbuilt
  scope, resolving what otherwise read as a circular dependency between the two issues' own
  PLAN.md text.
- The lucide-react icon chosen (`FolderTreeIcon`, research.md decision 8) is an implementation-level
  choice, not a Stuart decision, open to review the same way spec 013's own icon choices were.
