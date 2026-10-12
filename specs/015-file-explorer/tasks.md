# Tasks: File explorer

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Prerequisites**: spec 013 (right pane shell, panel-registry.ts, RightPaneShell.tsx) and spec 014
(side chat, the per-Session panel-binding and renderer-store-keying precedent this spec follows)
both merged on `main` (#665, #669). Windows 11 only.

**Tests**: none. Refract is a prototype (constitution, Development Workflow; AGENTS.md #605). Each
phase ends with a **Checkpoint** that runs the matching [quickstart.md](quickstart.md) section by
hand, on the built app. `pnpm typecheck` and `pnpm build` MUST pass before a change lands on
`main`; run `pnpm check:ui-text`, `pnpm check:theme-contrast`, and `pnpm check:drag-regions` once
per full gate, not per task.

**Organization**: three slices, the same incremental-shippability reasoning specs 013/014 both
used -- shell/hosting/one-shot listing first (a visible, inert-ish tree that reads real directory
data), tree UI/keyboard/live refresh/git-status/preview second (the feature's actual day-to-day
behaviour), VS Code launch and polish last (the bridge from read-only preview to real editing,
plus the accessibility and live-verification pass before a PR is called ready). Task IDs (`T001`
onward) are local to this spec.

**GitHub issue**: issue://463 covers this spec's whole scope; no additional per-task issues filed.
Decision comment: [issuecomment-6116156748](https://github.com/stuarthopwood/refract/issues/463#issuecomment-6116156748).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task).
- **[Story]**: the user story from [spec.md](spec.md) (US1 to US5). Setup, Foundational, and
  Polish tasks carry no story label.
- Tasks that edit the same file are never both marked [P].

---

## Slice 0: Docs (this spec's own docs-only PR; blocks every other slice)

**Purpose**: the Spec Kit record for this feature, written before any implementation PR opens,
the same ordering spec 013/014 both used.

- [x] T001 Write `specs/015-file-explorer/spec.md`, `research.md`, `plan.md`, `data-model.md`,
  `contracts/ipc.md`, `quickstart.md`, `checklists/requirements.md`.
- [x] T002 [P] `pnpm check:indent`-equivalent scan (`node scripts/check-indent.mjs`) on every
  touched file.

**Checkpoint**: the docs-only PR merges before Slice 1 starts.

---

## Slice 1 / Phase 1: Shell, IPC contract, and one-shot directory listing (blocks Slices 2 and 3)

**Purpose**: a real, rail-reachable panel that reads the Session's actual worktree and renders a
lazily-loaded tree -- no keyboard/ARIA polish, no preview, no git status, no VS Code launch yet.
Independently verifiable (the icon appears, the panel opens, a real folder expands to its real
children), same incremental-shippability spec 013/014's own Slice 1s used.

- [x] T003 Reuse `resolveInWorktree` (`src/main/ipc/files.ts`, issue #610) -- **corrected during
  implementation**: this spec's own `plan.md`/`research.md` originally assumed a NEW helper was
  needed; `resolveInWorktree` already exists, already hardened through 5 documented quality-gate
  rounds for the exact same containment problem (research.md decision 11, added this round).
  Added a thin `resolveListTarget` wrapper in `fileExplorer.ts` (T004) that special-cases
  `relativePath === ''` (lists the worktree root itself, which the shared function deliberately
  refuses as `file-missing` -- correct for its own `revealFile` call site, wrong for this one)
  and defers to the unmodified shared function for every other value. `plan.md`/`research.md`/
  `data-model.md`/`contracts/ipc.md` updated to match (decision 11); no new containment
  implementation was written. **PR #671 gate fix round (security-auditor/code-reviewer MEDIUM)**:
  `resolveListTarget` also rejects `.git` as a listing TARGET, not just as a listed ROW --
  checked on the `relativePath` as typed AND again on its realpath'd result relative to the root
  (catches the Windows 8.3 alias `GIT~1`, which only reads as `.git` after `fs.realpath` expands
  it), ASCII case-insensitively either way (`containsGitSegment`, shared so Slice 2's
  `readPreview` reuses it rather than a second copy). **PR #671 gate round 2 fix (HIGH,
  reproduced live)**: `resolveInWorktree` itself gained a no-follow, one-segment-at-a-time walk
  (`resolveNoFollow`) in place of its own bare `fs.realpath(candidate)` call -- round 1's fix at
  the `fileExplorer.ts` call site only vetted a link's first hop, so a chain or a middle-segment
  link still reached an unvetted `fs.realpath` through `resolveInWorktree`'s OWN existing code.
  Fixing it inside `resolveInWorktree` itself (not a second, competing implementation) closes the
  gap for every caller at once -- `fileExplorer.ts`'s listing/expand AND `revealFile` -- see
  T004's own entry below for the mechanism.
- [x] T004 [P] Add `fileExplorer.listDirectory(sessionId, relativePath)` to `src/main/ipc/`: a new
  `src/main/ipc/fileExplorer.ts` (mirrors `side-chat.ts`'s own validation/error-mapping shape) that
  resolves the Session's `worktreePath` from the registry (never the renderer, constitution V),
  calls `resolveListTarget` (T003), lists that directory's immediate children only (folders before
  files, alphabetical case-insensitive within each group per FR-006), one level deep (lazy-load,
  FR-005) -- no recursion, no git status yet (Slice 2). `.git` itself always excluded
  case-insensitively (FR-007). **PR #671 gate round 1 fix (security-auditor HIGH)**: a
  symlink/junction dirent's own `kind` is classified WITHOUT ever `fs.stat`/`fs.realpath`-ing an
  unvetted target -- the original version called `fs.stat` on every such entry unconditionally,
  which follows the link; a target that is a UNC path would make Windows attempt an outbound
  SMB/NTLM authentication just from opening the panel, no click required.
  **Round 1's own fix was incomplete, found and reproduced live in round 2 (security-auditor/
  code-reviewer/verification/a11y HIGH)**: it vetted only a link's FIRST hop (its own raw
  `readlink` target text), then handed that text to `resolveInWorktree`, whose `fs.realpath`
  followed the REST of a link CHAIN (`a` -> in-root `b`, `b` -> `\\attacker\share`) -- or a link
  sitting in a MIDDLE segment of the target's own path -- before the containment check ever ran,
  a zero-click outbound SMB/NTLM connection. Fixed by moving the no-follow walk INTO
  `resolveInWorktree` itself (`resolveNoFollow`, files.ts): it walks a candidate one path segment
  at a time with `fs.lstat`, and for any segment that is itself a link, `fs.readlink`s it,
  text-checks the raw target (UNC/device, containment) and RESTARTS the walk from the worktree
  root with the target's own relative segments prepended, rather than trusting it as a safe base
  -- the exact fix a middle-segment link needs, since Windows resolves every component of a path
  string during an ordinary `lstat`/`realpath`-equivalent call, not only the final one.
  `classifySymlinkEntry` now simply delegates the entry's own path to `resolveInWorktree`
  directly (no separate, narrower check of its own) and additionally classifies `'cannot-access'`
  when the resolved target lands under a `.git` segment. Classification runs with bounded
  concurrency (`SYMLINK_CLASSIFY_CONCURRENCY`, matching `repositories.ts`'s own `remotesBounded`
  worker-pool shape), never one `readlink`/`stat` after another. Readdir failures (ENOENT/ENOTDIR/
  EACCES/EPERM/other) map to plain-English messages, never `err.message` or the resolved path
  itself (`mapReaddirError`). The repeated inline error-mapping block shared with `files.ts`'s own
  `revealFile` handler is one exported `resolveErrorResult` in `files.ts`, used by both -- its own
  `worktree-missing` message no longer embeds the absolute path either (round 2 fix, the panel's
  error state rendered it verbatim via `role="alert"`).
- [x] T005 [P] Add `IPC_REQUESTS.FILE_EXPLORER_LIST_DIRECTORY` (and a comment reserving the
  Slice-2/3 request names in `contracts/ipc.md`, so the shared `src/shared/ipc.ts` naming
  convention stays visible from this slice's own commit, even though the later requests
  themselves land with their own slice) plus `RefractApi.fileExplorer.listDirectory` and the
  `FileTreeNode` type (`src/shared/model.ts`, matching `DiffStat`'s own placement precedent, not
  `frames.ts` which is OMP-wire-frame-shaped data only) to `src/preload/index.ts`.
- [x] T006 [P] Add `'file-explorer'` to `PanelId` and a descriptor (`FolderTreeIcon`, `hasCount:
  false`, research.md decision 8) to `HOSTED_PANELS` in
  `src/renderer/features/right-pane/panel-registry.ts` (FR-026).
- [x] T007 Create `src/renderer/state/file-explorer-store.ts`: per-Session keying (research.md
  decision 10, mirrors `side-chat-store.ts`). **Differs from this task's own original plan**: a
  recursive `root: ExpandableNode | null` tree (`FileTreeNode` plus `children?: ExpandableNode[]`/
  `expanded?: boolean`, RECURSIVELY -- matching data-model.md's own corrected design, below)
  rather than a flat `expanded: Set<string>` sidecar -- a sidecar would need a second, parallel
  lookup structure kept in sync with whatever shape the tree itself takes; mutating the tree node
  in place (`withChildrenAt`/`withExpandedToggled`, structural sharing so an unrelated branch's
  object identity survives an unrelated directory's own fetch) is the simpler, single-source-of-
  truth shape for a tree that does not yet need Slice 2's own virtualisation/windowing concerns.
  `loadDirectory(sessionId, relativePath)` fetches and expands; a separate
  `toggleExpanded(sessionId, relativePath)` flips an already-fetched folder's own `expanded` flag
  with NO re-fetch (collapsing a folder must never re-read it -- only expanding one for the first
  time does). No preview/patch handling yet (Slice 2). **PR #671 gate fix round**:
  `ExpandableNode` is now one exported, genuinely recursive type (`code-reviewer MEDIUM`: the
  original six repeated `FileTreeNode & { children?: FileTreeNode[]; expanded?: boolean }`
  inline intersections were NOT recursive -- a node two levels deep lost those fields' own
  typing). `root`/`error` grow a `status: 'loading' | 'error' | 'ready'` and `error: string |
  null` pair (`code-reviewer HIGH`; `accessibility-auditor`/`test-reviewer MEDIUM`): the original
  boolean-only `loaded` field had no way to represent "the root listing failed", so a failed load
  left the panel showing "Loading…" forever with no retry.
- [x] T008 [P] Export `useFileExplorerStore` from `src/renderer/state/index.ts` (all four spots:
  import, re-export, the dev-only `RefractDevStores` interface, and its own object literal --
  matching every other store's own four-spot pattern in this file).
- [x] T009 Create `src/renderer/features/right-pane/file-explorer/FileExplorerPanel.tsx`: an
  empty-worktree/loading state plus a plain nested list (not yet the WAI-ARIA tree pattern --
  Slice 2, FR-022) wired to `useFileExplorerStore`, fetching the root on first open per Session
  (mirrors side-chat's own `loadHistory`-on-first-open effect) and lazily fetching a folder's
  children on click-to-expand (`loadDirectory` the first time, `toggleExpanded` thereafter).
  **PR #671 gate fix round 1**: a `status: 'error'` state renders an `Empty` with the IPC error
  message and a Retry button calling `loadDirectory(sessionId, '')` again (`code-reviewer HIGH`);
  "Loading…" carries `role="status"` and shows only while `status === 'loading'`. A file (or
  `cannot-access`) row is a non-interactive `<span>`, never a `<button disabled>`
  (`accessibility-auditor MEDIUM`: a disabled button reads to a screen reader as "button,
  unavailable", announcing a broken control rather than a plain row).
  **PR #671 gate fix round 2 (code-reviewer MEDIUM: round 1's own focus-sink claim did not match
  its implementation)**: the panel's own scroll container is a focus sink (`tabIndex={-1}`,
  `aria-label="File explorer"`, the same `focus-visible:outline-2` convention
  `SessionList.tsx`/`RightPaneShell.tsx` already use), but `hadFocusRef` is kept current by a
  DOCUMENT-WIDE `focusin` listener, not the container's own `onFocus`/`onBlur` props -- a removed
  focused element's forced blur reads as `<body>`, not this panel, by the time any local blur
  handler could observe it. Reclaim (keyed on `[sessionId, status]`, inside a
  `requestAnimationFrame`) only fires when focus is actually STRANDED (gone, on `<body>`,
  disconnected, or a disabled control still inside the panel), never unconditionally on every
  Session change, which would otherwise steal focus from somewhere the user deliberately moved
  it to. This is `ChatPane.tsx`'s own `chatHadFocusRef`/`isFocusStranded` pattern exactly --
  **PR #671 gate fix round 3 (code-reviewer MEDIUM, DRY)**: `isFocusStranded` is now one shared
  export from `src/renderer/lib/focus.ts`, imported by both `ChatPane.tsx` and this panel,
  replacing round 2's own byte-for-byte copy. The "No Session open" empty state renders INSIDE
  this same focusable container too (round 3 fix, accessibility-auditor LOW), not as an early
  return before the container mounts, so the reclaim effect always has a real element to focus
  even if `sessionId` goes `null` while focus is inside the panel.
- [x] T010 Edit `RightPaneShell.tsx`: one more `activePanelId === 'file-explorer'` branch rendering
  `FileExplorerPanel` (depends on T006, T009).
- [x] T011 [P] `pnpm typecheck` and `pnpm build`; fix any error before proceeding. Run
  `check:indent`, `check:ui-text`, `check:theme-contrast`, `check:drag-regions` once for the whole
  slice. **Results**: typecheck pass (both tsconfigs); vitest 376/376 (no new tests, AGENTS.md
  #605); check:indent 0 odd-indent (321 files); check:ui-text 0 leaks (371 files); check:theme-
  contrast 313/313 (no new token); check:drag-regions 0 violations (109 files); build pass.
  **Re-run after the PR #671 gate fix round** (same file counts, no new files this round):
  typecheck pass (both tsconfigs); vitest 376/376; check:indent 0/321; check:ui-text 0/371 (one
  transient leak found and fixed first -- a dev comment's own task-ID reference survived
  minification immediately next to a JSX `/* @__PURE__ */` annotation; reworded, not a bundler
  config change); check:theme-contrast 313/313; check:drag-regions 0/109; build pass.
  **Re-run again after the PR #671 gate round 2 fix** (same file counts; one clean rebuild
  confirmed the fix was actually bundled, after a build run against a stale `out/` gave
  misleading live-verification results mid-round -- see the round-2 checkpoint note below):
  typecheck pass (both tsconfigs); vitest 376/376; check:indent 0/321; check:ui-text 0/371;
  check:theme-contrast 313/313; check:drag-regions 0/109; build pass.

**Checkpoint**: live-verified (scratch clone under `C:/tmp/refract-file-explorer-s1` -- never
`C:/Repos/personal` -- own `--user-data-dir`/CDP port 9343, torn down by pid-verified `taskkill`,
deleted by literal path afterward; one seeded Session pointed at a real clone of this repository
itself, a genuine nested worktree), 6 files (5 screenshots + `report.json`) + `sha256.json` under
`C:/Users/shopwood/refract-live-check-463-slice1/`, 0 duplicate hashes. Confirmed live: all five
rail buttons present in order (`subagents`, `fdb-knowledge`, `agent-builder`, `side-chat`,
`file-explorer`); opening the panel shows the worktree root's real top-level entries, folders
before files (`.github`, `.omp`, `.specify`, `build`, `docs`, `node_modules`, `out`, `scripts`,
`specs`, `src`, then every root file); `.git` itself never appears as a row (asserted via a DOM
text search, not just a glance); clicking `src` lazily fetches and shows its real children
(`main`, `preload`, `renderer`, `shared`); clicking it again collapses with no second fetch
(`toggleExpanded`, confirmed by the UI correctly hiding the children with no new IPC round trip
visible in the screenshot timing). Path-containment against three string-level escape attempts
(`../../../../Windows/System32`, `C:\Windows`, `\\?\C:\Windows`) all rejected `outside-worktree`.

**PR #671 gate round 1 fix, live-verified with REAL fixtures** (scratch clone under
`C:/tmp/refract-fx-gatefix`, own `--user-data-dir`/CDP ports 9351-9352, pid-verified `taskkill`
each run, deleted by literal path afterward; isolation proof: live `%APPDATA%\pinion\
processes.json` mtime unchanged across the run, `%APPDATA%\refract` absent, scratch `userdata\
processes.json` mtime fresh): 3 files (2 screenshots + `report.json`) + `sha256.json` under
`C:/Users/shopwood/refract-live-check-671-gatefix/`, 0 duplicate hashes. A real `mklink /J`
junction to an OUTSIDE folder (a sibling scratch folder, never touched: confirmed by the entry
resolving to `kind: "cannot-access"` rather than following it to find out), a real `mklink /J`
junction to an IN-ROOT folder (`src`, resolving to `kind: "folder"`, its own real children
(`main`/`preload`/`renderer`/`shared`) listed correctly when expanded), a real `mklink /D`
directory SYMLINK to the same outside folder (Developer Mode was enabled on this machine, so
creation needed no elevation; also `kind: "cannot-access"`), and a dangling junction (its target
folder deleted after linking: also `kind: "cannot-access"`) were all exercised directly against
the real `fileExplorer.listDirectory` IPC method (`window.refract.fileExplorer.listDirectory`
via `Runtime.evaluate`) and via the rendered UI (screenshot confirms the escaping/broken entries
render with `FileWarningIcon` and no disclosure chevron -- non-expandable, matching the in-root
junction and every ordinary folder/file around them, which render unaffected). The
**realpath-stage escape** Main asked for directly -- `listDirectory(sessionId,
'escape-outside-junction')` and `listDirectory(sessionId, 'escape-outside-symlink')`, i.e. asking
to LIST INTO the escaping link itself, not just see it as a row -- both returned
`outside-worktree`, never reaching the target; `listDirectory(sessionId,
'escape-inroot-junction')` returned the in-root junction's real children, `ok: true`. Reworded
disclosure (Verif1/A11y1/Code1 gate finding, all now corrected): the three STRING-level escape
attempts above (reconfirmed this round, same results) only ever exercise `resolveInWorktree`'s
TEXT-ONLY pre-checks (lexical containment, the leading-`//` UNC check) -- they do NOT reach the
`fs.realpath`-based check a symlink/junction escape actually hits; that check is now independently,
directly exercised by the real fixtures above, not merely inferred from issue #610's own gate
history. `.git` as a direct listing TARGET (`listDirectory(sessionId, '.git')` and `'.GIT'`) also
reconfirmed rejected `outside-worktree` this round.

**PR #671 gate round 2 (HIGH, reproduced live by all four reviewers): round 1's fix was
incomplete.** `classifySymlinkEntry` only vetted a link's FIRST hop; a chain (`a -> b`, `b ->
UNC`) or a link in a MIDDLE path segment still reached `resolveInWorktree`'s bare
`fs.realpath(candidate)` unvetted on the second hop -- a zero-click outbound SMB/NTLM connection.
Fixed by moving the no-follow walk INSIDE `resolveInWorktree` itself (`resolveNoFollow`,
files.ts): walks a candidate one path segment at a time with `fs.lstat`; any segment that is
itself a link has its raw `readlink` target text-checked (`isUnsafeToken`, the same checks a
top-level token gets) and, if safe, the walk RESTARTS from the worktree root with the target's
own relative segments prepended -- never trusting a substituted target as a safe base to resolve
further, since Windows follows reparse points transparently for intermediate path components too,
not only a path's final one. Capped at `MAX_LINK_HOPS` (32) against a cycle. `classifySymlinkEntry`
now simply delegates to the hardened `resolveInWorktree` (no separate, narrower check of its own)
and additionally classifies `'cannot-access'` for an in-root target under a `.git` segment.
`resolveErrorResult`'s `worktree-missing` message no longer embeds the absolute worktree path
(the panel's own error state rendered it verbatim via `role="alert"`); the handler's own
`notFound` message no longer embeds the raw session id either. The focus-sink now copies
`ChatPane.tsx`'s own `chatHadFocusRef`/`isFocusStranded` pattern exactly (a document-wide
`focusin` listener, reclaim only when focus is genuinely stranded, keyed on `[sessionId, status]`
so a Retry gets the same rescue a Session switch does); `handleRetry` focuses the container
BEFORE the fetch starts, so the Retry button's own unmount never drops focus to `<body>` even for
one frame. `file-explorer-store.ts`'s IPC invoke is now wrapped in try/catch so a rejected
Promise cannot leave `status: 'loading'` stuck forever.

**Live-verified with REAL fixtures** (scratch clone under `C:/tmp/refract-fx-gatefix2`, own
`--user-data-dir`/CDP ports 9361-9364 across three focused runs, pid-verified `taskkill` each
time, deleted by literal path afterward -- an EARLIER run against a stale `out/` build (predating
these round-2 source changes) gave misleading results first: `chain-a` resolved `file-missing`
instead of `outside-worktree`, the root listing took 4106 ms, and the SMB connection count
increased by one -- all three signs the OLD, unfixed code had genuinely attempted to realpath
through the chain into the nonexistent UNC share. Caught by checking `out/main/index.js`'s own
timestamp against the source files' last edit, a clean rebuild (`out/` deleted first) confirmed
present via a literal string search, then every test below re-run against the correct build;
isolation proof RECORDED in `report.json`, not only
prose: live `%APPDATA%\pinion\processes.json` mtime (`2026-10-11T08:42:12Z`) identical before and
after every run across all three launches, `%APPDATA%\refract` absent both before and after,
scratch `userdata\processes.json` mtime fresh each launch): 6 files (3 screenshots +
`report.json` + `ui-report.json` + `focus-switch-report.json`, the last two added by a fourth,
focused scratch run for the session-switch focus check below) + `sha256.json` under
`C:/Users/shopwood/refract-live-check-671-gatefix2/`, 0 duplicate hashes.

- **Two-hop chain** (`chain-a` -> in-root `chain-b` -> `\\127.0.0.1\refract-none-<random>`,
  never a real remote host): root listing classifies BOTH `chain-a` and `chain-b` as
  `kind: "cannot-access"`. `listDirectory(sessionId, 'chain-a')` (the realpath-stage escape,
  listing INTO the chain's own first link) returns `outside-worktree` in 4 ms.
- **Middle-segment link** (`mid-b` -> UNC; `mid-a2`'s own raw target is the relative text
  `mid-b\System32`, i.e. a link sits PART-WAY along the path, not at its end): classified
  `cannot-access`; `listDirectory(sessionId, 'mid-a2')` returns `outside-worktree` in 3 ms.
- **Hop-cap cycle** (`cycle-a` -> `cycle-b` -> `cycle-a`): classified `cannot-access`;
  `listDirectory(sessionId, 'cycle-a')` returns `outside-worktree` in 14 ms -- rejected via the
  32-hop cap, not a hang.
- **Two in-root hops ending outside** (`multihop-a` -> in-root `multihop-b` -> in-root
  `multihop-c` -> UNC): classified `cannot-access`; `listDirectory(sessionId, 'multihop-a')`
  returns `outside-worktree` in 3 ms.
- **In-root chain ending in-root** (`inroot-chain-a` -> in-root `inroot-chain-b` -> `src`, a real
  folder): classified `kind: "folder"`; `listDirectory(sessionId, 'inroot-chain-a')` returns
  `ok: true` with `src`'s own 4 real children -- confirms the fix does not break a legitimate
  multi-hop in-root link.
- **Invalid DNS hostname** (`invalid-host-link` -> `\\pinion-probe-nohost-<random>.invalid\s`):
  classified `cannot-access`; `listDirectory` into it returns `outside-worktree` in 3 ms -- no
  DNS resolution attempted (the raw UNC-shaped text is rejected before any lookup).
- **No outbound connection attempted, stated honestly**: `Get-NetTCPConnection -RemotePort 445`
  count was IDENTICAL before and after the root listing that classifies all of the above (both
  readings: 1, an unrelated pre-existing baseline connection on this shared dev machine, not
  created by this test). This is suggestive, not conclusive proof of zero packets -- the stronger
  evidence is the root listing's own elapsed time (37 ms for 16 new link entries, including two
  multi-hop chains and a 32-hop-capped cycle) and each individual escape attempt's elapsed time
  (2-14 ms) -- far too fast for even one local SMB share-not-found round trip, let alone a DNS
  lookup against an unresolvable hostname, both of which measurably slowed an EARLIER run of this
  same test against a stale pre-fix build (root listing 4106 ms; an SMB connection count that DID
  increase by one during that run) -- that earlier, slower, connection-incrementing run is the
  fix's own regression baseline, confirming the vulnerability these fixtures target is real and
  reproducible, not merely theoretical. **Independently corroborated, PR #671 gate round 3**:
  three reviewers each built their own scratch probe of the real `isUnsafeToken`/`resolveNoFollow`
  code, with every `fs.lstat`/`readlink`/`realpath`/`stat` call logged, and ran 30+ fixtures
  (chains, middle-segment links, cycles, 8.3 aliases, trailing dots) through it independently of
  this slice's own live check -- their call logs show NO call ever received a UNC argument. That
  is stronger evidence than this slice's own timing/connection-count method (which remains
  honestly described as suggestive, not conclusive, since it does not instrument every syscall).
- **Accepted residual risk, not closed (PR #671 gate round 3, security-auditor/verification LOW)**:
  a TOCTOU window exists between `resolveNoFollow`'s own last `fs.lstat` and the caller's final
  `fs.realpath` -- a link swapped into an already-checked segment in that window could still be
  followed by that `fs.realpath` call. The post-realpath containment check still rejects the
  RESULT (never an escape), but a UNC-targeted swap could still trigger an outbound SMB/NTLM
  attempt during that window before the rejection lands. Exploiting this needs a process with
  write access to the worktree while a listing is in flight -- the same local attacker who could
  already reach a UNC path directly -- so this is accepted, not mitigated, documented in
  `resolveNoFollow`'s own doc comment (files.ts) rather than silently assumed away.
- **`sub/.git` and the Windows 8.3 alias `GIT~1`** (confirmed enabled on this volume via `dir /x
  /a`, showing `.git` <-> `GIT~1`): `listDirectory(sessionId, 'sub/.git')`,
  `listDirectory(sessionId, 'GIT~1')` and `listDirectory(sessionId, 'sub/GIT~1')` all three
  return `outside-worktree`, live-verified (not merely asserted from reading the code).
- **Forced `worktree-missing` live**: the Session's real worktree folder renamed away, then the
  file explorer panel opened -- screenshot shows the panel's own `Empty` error state ("Couldn't
  load this Session's files" / "This Session's worktree folder no longer exists", NO absolute
  path, unlike the separate, pre-existing, UNCHANGED `ChatPane.tsx` worktree-missing banner
  alongside it, which still shows the path by its own established, separately-reviewed
  convention) with a Retry button. Retry explicitly focused (`document.activeElement` confirmed
  equal to the button) before a REAL keyboard `Enter` (`Input.dispatchKeyEvent`) was dispatched;
  the worktree was restored just before that keypress so the retry genuinely succeeds. A second
  screenshot after the keypress shows the full real tree rendered again, and
  `document.activeElement` is a `<DIV>` (the panel's own container, never `<body>`) -- Retry
  never drops focus.
- **Session-switch focus, verified separately** (same evidence folder, `03-after-session-
  switch.png` + `focus-switch-report.json`, a fourth scratch instance,
  `C:/tmp/refract-fx-focuscheck`, same teardown discipline): two Sessions created, the file
  explorer opened on the first and a real folder row (`src`) given focus
  (`document.activeElement` confirmed as that `<button>`), then switched to the second Session.
  `document.activeElement` afterward is a connected `<DIV>` (the panel's own container, not
  `<body>`) showing the second Session's own real tree -- the exact `[sessionId, status]`-keyed
  reclaim effect this round's fix added, exercised by the OTHER trigger besides Retry.
- **Three string-level escape attempts and the earlier round-1 fixtures** (outside junction,
  in-root junction, broken junction, outside symlink) were all re-run this round too, same
  results as before.

**PR #671 gate round 3 live verification** (a direct probe of the REAL `isUnsafeToken`/
`resolveNoFollow`/`resolveInWorktree` source, copied verbatim with only Electron's own imports
removed, run under Node 26 type-stripping against real NTFS junctions/symlinks under
`C:/tmp/r671-round3-probe` -- matching the same technique the round-3 gate reviewers themselves
independently used; junction/symlink fixtures deleted afterward with `rmdir` on each literal
link path only, never recursing into a link, and the real target folders confirmed intact
before the rest of the scratch tree was removed):
- **The alias regression itself, fixed**: worktree `wt`, junction `alias -> wt`. An in-root link
  `viaalias` whose absolute target is written in the ALIAS form (`alias\src`, simulating a tool
  that ran with its own cwd set to the alias, e.g. pnpm). Calling `resolveInWorktree(alias,
  'viaalias/real.txt')` -- the realistic case, where the Session's OWN recorded `worktreePath` IS
  the alias the link was written through -- now returns `ok: true` with the correct real path.
  Before this round's fix it returned `outside-worktree` (fails closed, never an escape, but a
  real functional regression this round closes).
- **No weakening of containment**: with the SAME fixture set, an escaping link (`escape -> ` an
  outside folder) is still rejected `outside-worktree`, and an ordinary in-root link still
  resolves `ok: true`.
- **The `loop -> '.'` self-reference fix**: a link pointing at the worktree root itself now
  returns `file-missing`, matching the existing rule for a top-level token equal to the root,
  instead of silently resolving to the root folder.
- **No round-2 regression**: the SAME `chain-a -> in-root chain-b -> UNC` fixture from round 2,
  re-run against this round's code, still correctly returns `outside-worktree`.

---

## Slice 2 / Phase 2: Tree UI, keyboard, live refresh, git status, preview (User Stories 1-3, 5)

**Purpose**: the feature's actual day-to-day behaviour -- a real WAI-ARIA tree a developer can
navigate by keyboard, that stays current as the agent edits files, shows git status at a glance,
and previews every file type the spec promises.

- [X] T012 Implement the WAI-ARIA tree pattern on `FileExplorerPanel.tsx`'s rows: `role="tree"`/
  `role="treeitem"`, `aria-expanded` on every folder row, roving `tabindex` (one tab stop for the
  whole tree), arrow-key navigation (left/right collapse-or-parent / expand-or-first-child,
  up/down between visible rows), Home/End, type-ahead, Enter opens that row's preview (FR-022).
  Virtualise each expanded folder's own children list via `react-virtuoso` (already a pinned
  dependency, research.md decision 7), capped per folder with a "N more" row past the cap (Edge
  Cases: a huge repository). **The cap MUST be enforced in MAIN too** (`fileExplorer.ts`'s
  `listDirectory`, before any per-entry `readlink`/classification work runs), not only by renderer
  virtualisation (PR #671 gate round 2 fix, security-auditor/code-reviewer LOW): a folder with
  very many entries otherwise sends every one of them over IPC and classifies every symlink among
  them, with no upper bound, before the renderer ever gets a chance to cap what it renders. Return
  `{ entries, truncated: number }` so the renderer's own "N more" row has a real count to show.
- [X] T013 [P] Add a file-system watcher in main (`fs.watch({ recursive: true })`, research.md
  decision 5): debounced, treats every `rename` event as "re-list this event's own directory," not
  "this exact path was deleted" (Node's own documented Windows ambiguity). Emits
  `IPC_EVENTS.FILE_EXPLORER_PATCH` keyed by Session id, carrying the affected directory's fresh
  listing (FR-020).
- [X] T014 [P] Add `onFileExplorerPatch` to preload; wire it once in `init-stores.ts` (mirrors
  every other event subscription's central-wiring location, side-chat's own precedent).
- [X] T015 `file-explorer-store.ts`: `applyPatch(sessionId, directoryListing)` merges a patched
  directory's children in place, NEVER resets any node's `expanded` boolean for a directory the
  patch did not itself concern (FR-020, SC-003).
- [X] T016 [P] Add a shared git-status reader to `src/main/git/` (new file, e.g. `status.ts`):
  `gitRaw(worktreePath, ['status', '--porcelain=v1', '-z', '--ignored=matching'])` (research.md
  decisions 2 and 6), parsed into a per-path `GitStatusMap` (modified/added/untracked/deleted/
  ignored). Returns `null` on any failure (mirrors `diffStat.ts`'s own never-throw-into-renderer
  convention), never gated on #464's own existence (FR-011).
- [X] T017 Add `fileExplorer.getStatus(sessionId)` IPC request/handler/preload wiring (depends on
  T016); `file-explorer-store.ts` fetches it once per directory load and on every patch, folded
  into the same loading cycle as T013/T015 (no separate poll).
- [X] T018 Tree row status marks: icon-plus-text (or text alone), never colour alone (FR-010,
  FR-024); the "show ignored files" toggle reveals `ignored`-status rows without ever revealing
  `.git` itself (FR-007, FR-009).
- [X] T019 [P] Add `fileExplorer.readPreview(sessionId, relativePath)` main handler: size-capped
  read (FR-002), binary detection via `diffStat.ts`'s own NUL-byte-in-a-header-slice heuristic
  (research.md decision 3, FR-003), returns a `FilePreview` (text/markdown/image/binary/
  too-large) per data-model.md.
- [X] T020 Create the preview renderer region in `FileExplorerPanel.tsx` (or a new
  `FilePreviewPane.tsx` alongside it): text/code via the shared `CodeBlock`/Shiki with line
  numbers and a wrap toggle (FR-012); markdown via the shared `Markdown` component with a Source
  toggle (FR-013); image as a `data:${mimeType};base64,${base64}` `<img>`, the identical
  convention `attachments.ts`/`AttachmentStrip.tsx` already use (research.md decision 4, FR-014);
  binary/too-large shows the "cannot preview" panel with size and type (FR-015); a file deleted
  while previewed shows a "this file no longer exists" state (FR-021), never stale content or a
  thrown error. **Corrected during implementation**: the shared `CodeBlock` has no line-numbers
  option of its own (`code`/`lang`/`wrap`/`copyText` props only, checked against its actual
  source) -- a plain `CodeBlock` with this pane's own Wrap toggle is the accepted fallback, no new
  line-numbered variant built. **Round 4 superseded this note**: `CodeBlock` gained an opt-in
  `lineNumbers` prop (FR-012, Verif4) specifically for this caller -- the sentence above describes
  only Slice 2's own first pass, not the shipped Slice 2/3 result; kept here unedited as a record
  of what changed, not as current fact.
- [X] T021 [P] Run the full gate (`pnpm typecheck`, `pnpm build`, `check:indent`, `check:ui-text`,
  `check:theme-contrast`, `check:drag-regions`); fix any error before proceeding.

**Checkpoint**: live-verified in a fresh isolated scratch Electron instance (own `--user-data-dir`/
CDP port, never Stuart's live Sessions), named screenshots, sha256-checked, 0 duplicates. Keyboard
navigation exercised end-to-end (arrow keys, Home/End, Enter) with exactly one Tab stop for the
whole tree; a modified/added/untracked file each show a distinct status mark in the tree (a
`deleted` mark exists in `getStatus`'s own map but can never attach to a rendered ROW -- a deleted
tracked file has no `readdir` entry left to put a mark on; see the round-5 correction below);
`.gitignore` toggle reveals/hides ignored rows without ever revealing `.git`; a text file, a
markdown file (both renders), an image, and a binary/oversized file each preview correctly; a live
edit outside Refract (a real file add/modify/delete in the worktree) updates the tree in place
with every previously-expanded folder still expanded; a previewed file deleted live shows the
"no longer exists" state.

**Live-verified** (isolated scratch Electron, `C:/tmp/refract-463-s23` -- never `C:/Repos/personal`,
own `--user-data-dir`/CDP port 9341, torn down by pid-verified `taskkill` and deleted by literal
path afterward; isolation proof: live `%APPDATA%\pinion\processes.json` mtime unchanged across the
run, `%APPDATA%\refract` absent): 10 screenshots under
`C:/Users/shopwood/refract-live-check-671-slice23/`. A real git worktree with a modified, a staged
(added), an untracked file, plus an `.gitignore`-matched ignored file, each showed its own
distinct status mark (icon + `sr-only` text) both via direct `window.refract.fileExplorer.
getStatus`/`listDirectory` IPC calls and in the rendered tree; a deleted tracked file's own
`deleted` mark was likewise confirmed via the direct `getStatus` IPC call, but (round-5
correction, Main's own explicit instruction) the original sentence here wrongly also claimed it
showed "in the rendered tree" -- that is structurally impossible: `listDirectory` lists via
`readdir`, which has no entry at all for a path that no longer exists, so there is no row for any
mark to attach to. FR-010's `deleted` mark is therefore never rendered in Slices 1-3; a decision
on #463 proposes amending FR-010 to say so explicitly (conservative default, synthetic
deleted-rows deferred). The "Show ignored files" toggle
revealed/hid the ignored row live. Keyboard navigation driven by REAL CDP `Input.dispatchKeyEvent`
(not programmatic `.click()`): ArrowUp/Down between visible rows, Home/End to the first/last visible
row (including a toggled-on ignored row), type-ahead jump, ArrowLeft (file -> parent; expanded
folder -> collapse), ArrowRight (collapsed folder -> expand; expanded folder -> first child), Enter
(opened a file's preview, confirmed via the `region[aria-label="Preview of <name>"]` DOM node) --
exactly one tab stop confirmed via `data-tree-row-path`/`tabIndex` inspection throughout. A text
file (TypeScript, syntax-highlighted), a markdown file (rendered, Source toggle available), a PNG
(magic-byte detected, no extension involved), and a 200-byte binary file (`isBinary` heuristic) each
previewed correctly; a path-escape attempt (`../../../../Windows/System32`) and a direct `.git`
listing attempt both still rejected `outside-worktree`. **Live file-watcher refresh, genuinely
live**: creating `src/livecreated.ts` on disk emitted two real `FILE_EXPLORER_PATCH` events over
IPC (the `src` directory and the root, both re-listed server-side) with every previously-expanded
folder still expanded. **Correction (PR #671 gate round 4, Sec4/Code4/A11y4/Verif4, all four
independently reproduced live): this specific claim was WRONG, a false generalisation from a
single-level test case.** `withPatchedChildren` actually replaced a patched directory's `children`
WHOLESALE, so a patch for ANY folder collapsed every expanded DESCENDANT under it; this round's
own single root-level patch (only one level deep) never happened to exercise a nested case, so it
passed by accident. The screenshot cited two paragraphs below (`09-preview-deleted-live.png`) is
itself the disproof: it shows `src` collapsed immediately after a live delete, directly
contradicting this sentence. Fixed and RE-verified live with a genuinely nested case this round --
see the round-4 evidence paragraph below. **FR-021, genuinely live**: deleting the currently-
previewed `src/index.ts`
from disk flipped the preview to "This file no longer exists" with no extra IPC call, confirmed via
DOM inspection and a screenshot. **A real bug was found and fixed live**: expanding a folder AFTER
the root's own git-status fetch resolved showed its children with no status mark at all, even
though the map already had the right answer -- `file-explorer-store.ts`'s `loadDirectory` now
re-applies the known `gitStatus` map to newly-attached children (fix committed and re-verified live:
`index.ts`/Modified, `staged.ts`/Added, `livecreated.ts`/Untracked all correctly marked after the
fix). Row context menu (right-click, confirmed via a real `Input.dispatchMouseEvent` right-click,
not a simulated event) showed the exact 3 expected items. `openInVSCode` genuinely spawned real
`Code.exe` processes (confirmed via `Get-Process`); `copyPath` was independently verified by reading
the real OS clipboard afterward (`Get-Clipboard` returned the exact expected absolute path, not just
an `{ok:true}` IPC result); `reveal` returned `{ok:true}` (the resulting Explorer window itself was
not independently screenshotted). **Not verified live this round**: clicking the preview-toolbar/
kebab-menu DOM buttons themselves end-to-end (the underlying IPC calls and the buttons' own
rendering were each confirmed separately, not the full click-through); the "VS Code not found"
state (VS Code is installed on this machine, so the absent-install path could not be exercised);
dragging the tree/preview resizable split handle; `prefers-reduced-motion`/forced-colors emulation.
**Closed this round by Sec4's own probe (c)**: non-ASCII/embedded-space paths through the
`-z`-based git invocation -- `sp ace é.txt` came through intact.

**PR #671 gate round 4 re-verification** (fresh isolated scratch Electron, two instances:
`C:/tmp/refract-463-gate4`, own `--user-data-dir`/CDP port 9342 each, pid-verified `taskkill`
each time, deleted by literal path afterward -- a restart mid-session, same scratch parent, was
needed to add a second registry session for the delete-root test, since `registry.json` is only
read at startup; isolation proof unchanged across both: live `%APPDATA%\pinion\processes.json`
mtime identical before and after, `%APPDATA%\refract` absent throughout): 4 screenshots + `report.
json` + `sha256.json` under `C:/Users/shopwood/refract-live-check-671-gate4/`, 0 duplicate hashes,
all 4 viewed.

- **FR-009/FR-010 folder marks, genuinely live**: a real `.gitignore`-matched `node_modules/`
  folder (containing `pkg/`) and a real untracked `newdir/` folder (containing `inner.txt`) each
  showed their own correct mark; `node_modules` was correctly HIDDEN by default (`showIgnored:
  false`) and correctly appeared once the toggle was flipped; once expanded, `node_modules/pkg`
  showed `Ignored` and `newdir/inner.txt` showed `Untracked` -- the descendant-inheritance half of
  the fix, confirmed live, not just the top-level folder's own mark.
- **Nested expansion AND focus survive a live patch, genuinely live (the exact case round 2-3's
  own claim above got wrong)**: `src` -> `src/nested` -> `src/nested/deep` expanded three levels
  deep, `src/nested/deep/c.ts` given real keyboard focus (`document.activeElement` confirmed),
  then BOTH a root-level file (`root.md`) and the deeply-nested file itself (`c.ts`) edited live on
  disk in the SAME burst. After: all three folders still `aria-expanded="true"`, `c.ts` still
  focused, both edited files correctly showing a fresh `Modified` mark -- screenshot `02-nested-
  expansion-and-focus-preserved-after-patch.png`.
- **Tab-order walk, genuinely live (A11y4's own explicit ask)**: starting from the "Show ignored
  files" switch, a sequence of 6 real `Input.dispatchKeyEvent` Tab presses was recorded via
  `document.activeElement` at each step: switch -> exactly ONE `role="treeitem"` stop (the
  previously-focused `c.ts` row) -> the resize handle (`role="separator"`, now correctly labelled
  `aria-label="Resize file tree and preview"`) -> the preview region -> out of the panel entirely
  into the icon rail's own buttons. No second tree stop anywhere in the sequence -- screenshot
  `03-tab-order-walk-state.png`.
- **Deleted-root watcher fix, module-level verified (Code4's own Critical)**: a same-process Node
  probe imported the REAL, unmodified `watchDirectory.ts` (Node 26 type-stripping; a `.mjs` copy
  with only type ANNOTATIONS stripped, matching round 3's own established probe technique, since
  this package's own `"type": "commonjs"` blocks a direct ESM import of a `.ts` file) and deleted
  the watched root from WITHIN that same process. Measured results: `eventCount: 0` throughout 6
  samples over 3 seconds after the delete (the fatal-detection fired on the absolute-path signal
  of the very FIRST event, before anything was ever queued), `fatalFired: true`, `cpuUserMs: 0` /
  `cpuSystemMs: 15` over that whole window (no spin, nothing resembling the original ~120,000
  events/s flood), and a FRESH `watchDirectory()` call against the recreated root succeeded and
  correctly delivered exactly one event for a trigger file written into it afterward.
  **Round-5 correction (Main's own explicit instruction, Sec5/Verif5 both independently
  reproduced)**: the original version of this bullet claimed bash `rm -rf`/PowerShell
  `Remove-Item` both failing live against the real running app proved "Windows'
  `ReadDirectoryChangesW` handle on the watched root blocks a foreign process from deleting or
  renaming it, a genuine Windows file-sharing constraint" -- this is FALSE. Sec5 and Verif5 each
  independently ran their OWN cross-process delete against a plain `fs.watch`'d directory and
  succeeded every time (Verif5's own probe: a foreign delete succeeded and produced 321,821 rename
  events in 3 seconds). Whatever blocked the original attempt was a different handle entirely
  (most likely a real OMP agent process auto-started for that hand-seeded Session, holding the
  worktree as its own process CWD -- Windows locks a directory that is any process's CWD against
  external deletion, unrelated to `fs.watch`). The claim is withdrawn; "Full raw JSON in
  `report.json`" also overstated what that file actually contained for this specific probe. See
  this round's own fresh evidence (below) for the actual app-level end-to-end re-test, with a
  saved probe script and raw JSON this time.
- **Git-lock concurrency fix, genuinely verified under real contention (Sec4/Code4's own explicit
  ask)**: 40 iterations of `git add -A && git commit` ran in a tight loop against the SAME repo the
  real running app's own file-explorer watcher was actively watching, each iteration adding one new
  root-level `stress-N.txt` file (`stress-0.txt` through `stress-39.txt`, 40 files total) --
  concurrently with a SEPARATE 45-file burst write across three directories (`src/`, `src/nested/`,
  `src/nested/deep/`, 15 files each) to independently fire the app's own coalesced `getStatus`
  calls, PLUS a direct `getStatus` IPC call issued mid-stress (which itself returned `{ok:true}`
  with a real status map in 182ms). Result: **0 failures, 0 lock contentions, out of 40/40** --
  against the gate's own reported baseline of 31/60 failures without the fix. The tree remained
  fully responsive and correctly listed all 40 of the git-lock script's own new root-level
  `stress-*.txt` files afterward (the separate 45-file burst across the three subdirectories also
  appeared correctly, just not all visible in the one screenshot below without scrolling/
  expanding) -- screenshot `04-tree-healthy-after-concurrent-stress.png`.
- **Re-confirmed with the round-4 fixes in place**: `openInVSCode` (`{opened:true}`, 11 real
  `Code.exe` processes confirmed via `Get-Process`, now with `ELECTRON_RUN_AS_NODE`/`NODE_OPTIONS`
  stripped from the child's env), `reveal` (`{ok:true}`), `copyPath` (`{ok:true}`, the real OS
  clipboard independently read back via `Get-Clipboard` and matched exactly), a path-escape attempt
  and a direct `.git` listing attempt (both still `outside-worktree`).
- **Still not verified this round** (unchanged from the list above): the "VS Code not found"
  state, the preview-toolbar/kebab DOM click-through, the resizable split drag,
  `prefers-reduced-motion`/forced-colors emulation.

### Round 5 gate fixes + live re-verification (Sec5/Code5/A11y5/Verif5, all FAILed; fresh evidence,
### `C:/Users/shopwood/refract-live-check-671-gate5/`: report.json, 2 probe scripts + raw stdout,
### 1 screenshot, sha256.json, 7 files, 0 duplicates)

Fixes: `FILE_EXPLORER_RESET` event (watcher-fatal/archive/restore/recreateWorktree lifecycle,
Code5 HIGH1); focus-steal rescue now checks the lost element is genuinely gone, not merely
scrolled out or blurred by a deliberate click elsewhere (Code5 HIGH2/A11y5 HIGH); watcher-flush
dedup by path; `truncated` now survives a live patch (Code5 Medium x2); `withGitStatusMerged`
only inherits ignored/untracked, not modified (Code5 Low); case-insensitive/truncation-aware
`isPathGoneUnderPatch` (Code5 Low); `TreeNodeRow` ids are `useId()`-based, not path-based (A11y5
Medium); `CodeBlock`'s line-number gutter is one `<pre aria-hidden>` text node, not one `<div>`
per line (Code5 Medium); `watchDirectory.ts`'s `stop()` sets `stopped` too, `'__ignore__'` ->
`null` (Sec5 Low x2); `readPreview.ts` non-regular-file -> `read-error` not `deleted`, size-aware
buffer (Sec5 Low x2); `status.ts`'s execution-hook comment corrected + `--ignore-submodules=all`
(Sec5 Medium); `openInVSCode`'s env-strip is case-insensitive (Sec5 Low). Full detail: commit
message, round-5 code.

**Live-verified** (two isolated scratch Electron instances, `C:/tmp/refract-463-r5` and
`C:/tmp/refract-463-r5-anc`, CDP port 9341 each, pid-verified `taskkill` each time, both deleted
by literal path afterward; isolation: live `%APPDATA%\pinion\processes.json` mtime
`2026-10-11T08:42:12Z` -- IDENTICAL before and after this round, i.e. unchanged since round 4 --
`%APPDATA%\refract` absent throughout):
- `useId()` row ids confirmed (`aria-labelledby="_r_22_-name"`, not path-derived).
- Gutter: one `<pre aria-hidden>`, line count matches `code.split('\n').length`; Wrap removes the
  gutter and applies computed `white-space: pre-wrap`.
- All 5 of A11y5's demanded preview/focus scenarios, each genuinely live: (a) above; (b) focused
  Wrap button + external file delete -> focus rescued to a real tree row + "no longer exists"
  shown; (c) external delete of a previewed file's ANCESTOR folder (not just its immediate
  parent, never tested before) -> "no longer exists" shown correctly; (d) focused row deleted on
  disk -> rescued to a surviving row; (e) a focused row scrolled out of Virtuoso's rendered
  window (60 extra fixture files, forced virtualisation) correctly did NOT get rescued (it is
  still logically present, per the A11y5 fix), `tabbableAbsIndex`'s "first rendered row" fallback
  (never exercised before) correctly took over, and a real CDP Tab keypress landed in exactly one
  step on that row.
- Focus-steal fix, the other direction: a real CDP click on a genuinely non-focusable, no-
  tabindex-ancestor-anywhere heading correctly left focus on `<body>` -- NOT stolen back to the
  tree (two earlier click targets in this same test accidentally landed on a focusable ancestor
  first, a false negative; the third, isolated attempt is the real reproduction).
- `truncated` survives a live patch: a 1005-file directory's "5 more…" row became "6 more…" after
  adding one more file externally, not resetting/disappearing.
- FR-014 (flagged twice, never fixed before this round): a real 48x48 generated PNG (valid
  zlib/CRC32, not a placeholder) rendered with `img.src` prefix `data:image/png;base64,...`,
  `naturalWidth/Height: 48`.
- `FILE_EXPLORER_RESET` fires on `SESSIONS_ARCHIVE` and `SESSIONS_RESTORE` (captured directly via
  a renderer-side listener), AND actually causes an automatic reload: archiving (which stops the
  watcher first) while a brand-new file was added externally during that stopped window still
  surfaced that file immediately with no manual interaction -- only possible because
  `resetSession` dropped the stale store entry and the panel's now-reactive `hasSessionEntry`
  effect (previously a one-shot `getState()` read that never re-fired) re-triggered
  `loadDirectory('')` on its own.

**Round-6 correction (Sec6/Code6/A11y6/Verif6, all four independently reproduced, superseding the
paragraph immediately above)**: round 5's own "new finding" above was ITSELF confounded, the same
class of error as round 5's own correction of round 4. Four independent probes this round (two
runtimes: Node 26.10.0 and the Electron 44.5.1 runtime), none touching the real app, found:
deleting the exact watched root succeeds (a 110k-143k absolute-filename event flood followed, on
both `fs.rmSync` and `cmd rd /s /q`); a recursive delete of the root's own PARENT also succeeds;
renaming the root's PARENT fails `EPERM`; renaming the ROOT ITSELF succeeds too, but with ZERO
watcher events (the handle silently follows the moved folder). A same-process "confound" probe
(a plain child process with cwd set to the root, no watcher at all) reproduced round 5's exact
`EPERM, Permission denied: '<root>'` text. This round's own re-test through the REAL running app
(not a standalone script) found the root cause directly: opening a Session (clicking its row)
spawns a real OMP agent process (`omp.exe --mode rpc-ui ...`, `SessionAgent.ts:466`) with its own
`cwd` set to that Session's `worktreePath` (`SessionAgent.ts:466`) -- **round-7 correction: this
is the mechanism INFERRED from reading `SessionAgent.ts`, not something the process scan itself
shows.** `Get-CimInstance Win32_Process` exposes a PID and `CommandLine` only, never a process's
`cwd` or open handles -- the scan's real job was finding the exact `omp.exe` PID for this
Session (not command-line substring matching, which could false-match an unrelated process), so
the actual causal proof is the before/after pair: EPERM on delete -> `stopAgent(id)` -> that same
PID confirmed gone via a follow-up full scan -> delete succeeds. A session opened with the file
explorer panel NEVER touched still reproduced the identical `EPERM` on an external delete, and
the exact `omp.exe` pid for that Session was found holding it; calling
`window.refract.sessions.stopAgent(id)`, confirmed via a follow-up full process scan to have
actually exited, made the identical delete succeed immediately afterward. **Round-7 correction
(Sec7/Code7/A11y7/Verif7, all four independently reproduced on Node 26 AND Electron 44.5.1): "the
watcher itself was never the cause, in any round" and "only an ANCESTOR of the root is locked by
something unrelated to this app entirely" (both below) are FALSE.** The Session's own agent
process blocks the worktree ROOT itself (released by `stopAgent`, above) -- that part was right.
But SEPARATELY, this PR's OWN recursive `fs.watch` handle (opened by `watchDirectory.ts` via
`ensureWatcher`, this file's own code) independently blocks rename/move of EVERY ANCESTOR of the
root, for the watcher's entire lifetime (first panel open until archive/delete/recreate/fatal/
app-quit stops it) -- a real, user-facing consequence OF THIS PR, not something "unrelated to the
app". Fixed this round (Round 7 section below): the watcher now stops the instant the last open
`FileExplorerPanel` for a Session unmounts, and restarts (without a full reload) when one mounts
again, so the lock is held only while a panel for that Session is actually open this run, not
for the rest of the app's lifetime. With the Session's own agent explicitly stopped and
confirmed gone (not just assumed, not just killing the whole app, which cannot tell an agent's
handle apart from the watcher's): a foreign process CAN delete the exact watched root (flood,
`onFatal` fires, near-zero sustained CPU) AND rename it (zero events, detected only on the next
subfolder flush). Live-verified end to end, agent confirmed stopped both times (two fresh real
`git worktree` Sessions, evidence under `C:/Users/shopwood/refract-live-check-671-gate6/`):
- **External root DELETE**: succeeded in 6ms, no EPERM; CPU delta 15.6ms across the whole
  operation (no sustained spin); `FILE_EXPLORER_RESET` delivered; panel showed "Couldn't load
  this Session's files / This Session's worktree folder no longer exists / Retry" (honest, not
  stale); `sessions.recreateWorktree` then succeeded and the panel recovered AUTOMATICALLY with
  zero manual interaction.
- **External root RENAME**: succeeded; confirmed ZERO watcher events from the rename alone (tree
  stayed stale); writing a new file inside the MOVED folder's own already-loaded `sub` subfolder
  (the watcher's handle transparently follows the move) fired a real watcher event for `sub`,
  which this round's own `fileExplorer.ts` fix (any `relativePath` failing `worktree-missing` is
  now fatal, not only `''`) correctly caught, stopping the watcher and firing
  `FILE_EXPLORER_RESET` -- the same honest error state as the delete case.

### Round 6 gate fixes + live re-verification (Sec6/Code6/A11y6/Verif6, all FAILed; evidence under
### `C:/Users/shopwood/refract-live-check-671-gate6/`: report.json, raw-commands-and-output.txt
### (a hand-transcribed log of the commands run and their output, not piped/captured stdout --
### see the Round 7 section below for a labelling fix on this point and a verbatim-captured
### re-run),
### 3 scripts (`a11y-scenarios.js`, `probe-delete.js`, `spawn.js`) incl. the re-runnable
### `a11y-scenarios.js`'s own raw `a11y-report.json`, 10 screenshots, sha256.json, 17 files total
### (16 hashed in `sha256.json` plus the manifest itself), 0 duplicates. **Round-7 correction
### (Verif7)**: this header previously undercounted "16 files, 2 scripts" -- `spawn.js` was
### always a third script in this same folder, simply never counted.

Fixes beyond the root-cause correction above: `refreshDirectory`'s `worktree-missing` check no
longer gates on `relativePath === ''` (Code6/A11y6/Verif6 Medium, see the RENAME test above);
`scheduleDirectoryFlush` wraps `refreshDirectory` in `try`/`finally` so a rejection cannot pin a
key in-flight forever (Code6/Sec6/Verif6 Medium); a new `session-archived` error code --
`listDirectory` refuses an archived Session outright and `ensureWatcher` refuses to (re-)watch
one, closing the exact race round 5's own `FILE_EXPLORER_RESET` fix reopened (a still-mounted
archived panel's reload recreated a fresh watcher, undoing round 4's leak fix) (Sec6/Code6/Verif6
Medium); `sessions.ts` archive now notifies on its own failure path too (moved to the outer
`finally`), and `recreateWorktree` notifies on its own catch path as well as success
(Code6/Verif6 Medium); a new `setFileExplorerSessionBusy` marker closes a race where an in-flight
`listDirectory` call could recreate a watcher mid-delete/mid-recreate (Verif6 Low); a focused row
scrolling out of Virtuoso's window now focuses the panel's own container instead of leaving focus
on `<body>` (A11y6 Medium), and upgrades to the tabbable tree row once `status` is `'ready'` again
(A11y6 Low); `handleFocusOut`'s lost-row lookup now walks up via `closest()` so a row's own kebab
button losing focus is not misread as the row itself being removed (Code6 Low); case-insensitive
keys added where still missing: `loadedPaths`, `withPatchedChildren`'s `oldByPath` (Code6/Verif6
Low); a per-Session root-load sequence (`rootLoadSeq`), bumped by `resetSession`, drops a stale
in-flight root response landing after a reset (Sec6 Low); `readPreview.ts`'s `bytesRead >
stat.size` (growth below the cap, not just past it) now returns `read-error` instead of a
silently truncated preview (Sec6 Low); `status.ts` documents that `--ignore-submodules=all` also
hides a dirty submodule folder's own mark, not only recursion (Sec6 Low). Full detail: commit
message, round-6 code.

**Live-verified** (all 6 of A11y6's own demanded scenarios, via a re-runnable CDP script saved in
the evidence folder above (`a11y-scenarios.js` -- not committed to the repo, round-7 correction
below), not hand-annotated prose this time, raw JSON output in
`a11y-report.json` -- the script itself writes its own `report.json` into a scratch
`EVIDENCE_DIR`, manually copied and renamed to `a11y-report.json` for the final evidence folder,
not an automatic match): gutter+Wrap (single `aria-hidden` node, removed + wrap-class applied on
toggle); focus the Wrap button + delete the previewed file externally -> `wrapFocusOk: true`,
previewed deep file -> "no longer exists" shown, folder's rows fully gone; focus a row + delete it
on disk -> rescued to a connected row; a focused row scrolled out of Virtuoso's rendered window ->
focus correctly moves to the PANEL'S OWN CONTAINER (`role=group`, `aria-label="File explorer"`,
confirming this round's own A11y6 Medium fix, previously left on `<body>`), and a real CDP Tab
keypress from the "Show ignored files" switch lands in exactly one step on the first RENDERED row.
**Round-7 correction (A11y7/Code7/Verif7)**: this container-focus claim was incomplete -- the
container is a `role=group` div with no `onKeyDown` of its own, so arrows/Home/End/type-ahead did
nothing once focus actually landed there, and the scenario script only ever pressed Tab FROM the
"Show ignored files" switch, never from the container itself (where Tab reaches that same switch
first in DOM order, not a row). Round 7 removes this special case entirely -- a scrolled-out row
now falls through to the SAME final rescue used for a genuinely-removed row, which focuses the
actual tabbable `[data-tree-row-path][tabindex="0"]` row directly, never the bare container; see
the Round 7 section below for the re-verified scenario.

**Not verified this round**: an app-side `getStatus()` call-count instrumentation during a
concurrent git-lock stress burst (Verif5/Verif6's own ask); the deliberate-click-elsewhere
focus-steal direction (round 5's own test stands unchanged, nothing in round 6's code touched
that branch).

### Round 7 gate fixes (Sec7/Code7/A11y7/Verif7, all FAILed round 6; see the Round-6-correction
### rewrite above for the causal-model fix). Fixes beyond that:

The real fix (preferred over documenting a residual, per Main): the Session's recursive watcher
now stops the instant the LAST open `FileExplorerPanel` instance for that Session unmounts
(ref-counted per `sessionId` in `FileExplorerPanel.tsx`, since a split pane could in principle
show the same Session's panel twice), and restarts (without a full reload, so the cached
expansion/scroll state survives) the moment one mounts again. Two new IPC methods,
`fileExplorer.stopWatching`/`fileExplorer.ensureWatching` (contracts/ipc.md). The lock on every
ancestor of the worktree root is now held only while a panel for that Session is actually mounted
this run, not for the rest of the app's lifetime (Sec7/Code7/A11y7/Verif7 HIGH -- real impact
fix, not a documented residual).

**MEDIUM** (Sec7/Code7/Verif7): `sessions.ts`'s `SESSIONS_ARCHIVE` handler now marks the Session
busy (`setFileExplorerSessionBusy`) for the whole `await shutdown()` window, closing a race where
a `listDirectory` call resolving between `stopFileExplorerWatcher` and `archivedAt` actually being
written could recreate a watcher nothing then ever stopped (the same pattern `delete`/
`recreateWorktree` already used; archive did not).

**LOW** (A11y7/Code7): `SESSIONS_DELETE`'s failure path now calls `notifyFileExplorerReset` in
the outer `finally` when the Session still exists (a failed delete leaves it un-deleted) -- the
watcher had already been stopped unconditionally, but nothing told the renderer, leaving a stale
`'ready'` tree with nothing watching it.

**MEDIUM** (Sec7/A11y7/Code7): `resolveListTarget` (`fileExplorer.ts`) and `resolveInWorktree`
(`files.ts`) now map ONLY `ENOENT`/`ENOTDIR` from `fs.realpath(worktreeRoot)` to `worktree-missing`
-- every other code (`EACCES`/`EBUSY`/`EMFILE`, an AV scan or indexer) used to be treated
identically, and since round 6 any `worktree-missing` is FATAL (stop + reset, losing expansion/
selection and announcing "no longer exists" via `role=alert`) for what might resolve itself on
the very next read; these now return the existing, already-non-fatal `file-missing` code instead.
**LOW**s in the same area: an explicit (user-driven) `listDirectory` call that itself returns
`worktree-missing` now also stops the watcher and resets, not only the watcher's own background
flush; `refreshDirectory`'s and `listDirectory`'s own stop+reset on `worktree-missing` each now
compare the watcher handle captured before their own `await` against the current one (the same
identity guard `onFatal` already used), so a slow in-flight flush/list from an OLDER watcher can
never stop/reset a NEWER one a concurrent archive/delete/recreate already installed in its place.

**MEDIUM** (A11y7/Code7/Verif7): the scrolled-out-row focus rescue no longer parks focus on the
bare `role=group` container (which has no `onKeyDown` -- arrows/Home/End/type-ahead did nothing
there, and Tab from it reached the "Show ignored files" switch first in DOM order, not a row; see
the Round-6 live-verified correction above). Deleted the special-case branch entirely -- a
scrolled-out row and a genuinely-removed row now share the exact same final rescue, which focuses
the actual tabbable `[data-tree-row-path][tabindex="0"]` row directly (guaranteed real, rendered,
and keyboard-functional by `tabbableAbsIndex`'s own `rangeChanged` recompute). The now-dead
`rowsRef`/`lostRowPath` bookkeeping that only existed to support the deleted branch was removed
too.

**Wording reconciliation** (Verif7): `docs/PLAN.md`'s C4 row and the PR body's FR-010 section now
use the same framing ("decision requested, conservative default applied meanwhile") instead of
two different-sounding claims ("decision-blocked" vs "not blocking"). `sessions.ts`'s round-4
comment near `recreateWorktree` (about the watcher releasing the worktree ROOT folder before that
call touches it) was re-checked against this round's corrected causal model and found to already
be consistent -- no change needed there.

**Live-verified** (fresh scratch Electron instance per `verify-refract-ui-via-cdp-scratch-instance`,
`C:/tmp/refract-671-gate7` -- never touching Stuart's live Sessions; isolated `--user-data-dir`,
CDP port 9341; evidence copied to `C:/Users/shopwood/refract-live-check-671-gate7/`: 4
screenshots, a genuinely piped `raw-output.txt` (`node gate7-verify.js > raw-output.txt 2>&1`,
not hand-transcribed -- the round-6 complaint this round fixes), the driver script itself
(`gate7-verify.js`, saved in the evidence folder only, never committed to the repo), sha256.json,
7 files total, 1 script, 0 duplicates; the Session's own agent confirmed stopped via a full
`Get-CimInstance Win32_Process` scan before every ancestor-rename attempt, isolating the
watcher's own effect from the agent's):
- **(a) panel CLOSED -> ancestor rename succeeds**: opened the file-explorer panel (rail button
  `aria-pressed` false -> true, root listed), clicked the SAME rail button again
  (`aria-pressed` true -> false, confirmed via DOM query; `[aria-label="File explorer"]` confirmed
  gone from the DOM, a genuine unmount, not just a visual collapse), waited for the
  `stopWatching` IPC round-trip, then renamed the worktree's own parent folder externally:
  succeeded immediately. This is the "real fix" (item 2) working as intended.
- **(b) panel OPEN -> ancestor rename still blocked**: same fixture, panel open and root listed,
  same external rename attempt: `Access to the path '...\pinion-worktrees\repo' is denied.` --
  documents the residual honestly (the watcher locks every ancestor for as long as a panel for
  that Session is open this run), exactly as the corrected causal model above states.
- **(c) archive racing a `listDirectory`**: 15 iterations, each firing
  `Promise.all([fileExplorer.listDirectory(id, ''), sessions.archive(id)])` concurrently from the
  same tick, then immediately attempting the external ancestor rename, then `sessions.restore(id)`
  for the next iteration: 15/15 released the watcher cleanly, 0 leaks. **Round-8 correction
  (Code8/Verif8 Medium)**: this overclaimed "the busy-marker fix holds under stress" --
  `Promise.all` dispatches both calls in the same tick, so `listDirectory`'s own `ensureWatcher`
  ran and returned BEFORE `archive`'s `await shutdown()` ever started; the busy-marker window
  this fix exists to close was never actually entered. Re-run properly staggered in the Round 8
  section below.
- **(d) a transient (non-ENOENT/ENOTDIR) realpath error does not reset/wipe state**: expanded
  `src`, selected `root-file.txt` (previewed, showing "hello"), recorded `window.__resetEvents`
  length (30) and the expanded/selected DOM state, then ran `icacls <worktree> /deny
  <user>:(RX)` (a real, if brief, permission denial -- the closest practical simulation of an
  AV/indexer-style transient lock available without deeper OS tooling) immediately followed by a
  `listDirectory` call landing during the deny window, then `icacls /remove:d` to restore
  permissions. Afterward: `window.__resetEvents.length` unchanged (30, no `FILE_EXPLORER_RESET`
  fired), `src` still expanded, `root-file.txt` still selected and previewed, no `role="alert"`
  text anywhere -- the fix holds. **Round-8 correction (Code8/Sec8/Verif8 Medium)**: the
  `listDirectory` call itself was NEVER actually observed resolving during the deny window --
  `JSON.stringify(window.refract.fileExplorer.listDirectory(...))` stringifies a pending
  `Promise` object (`{}`), not its eventual result, and the `icacls` restore ran synchronously
  right after, racing (or outright preceding) the real IPC round trip. The state-preservation
  evidence above (no reset, expansion/selection unchanged) is still genuine -- that was read
  straight from the DOM, unaffected by the stringify bug -- but "the fix holds" for the
  `listDirectory` call's OWN result code was unproven. Also: `icacls /deny ...:(RX)` on Windows
  produces `EPERM`, not the `EACCES`/`UnauthorizedAccess` this round guessed -- re-run properly
  awaited in the Round 8 section below, which also captures the real result code this time.

**Not verified this round**: a genuinely slow/throttled main-process `shutdown()` to force a
WIDER archive-vs-listDirectory race window than the 15-iteration stress test's own natural IPC
timing produced (every iteration happened to land cleanly; the busy-marker fix's own code path
was read and traced, not instrumented to CONFIRM it was the specific line that fired on any one
iteration, only that the observable outcome -- no leak -- held every time). A genuinely OS-level
transient `EBUSY`/`EMFILE` on `fs.realpath` itself (as opposed to the `icacls`-deny simulation
above, which the Round 8 section below confirms actually produces `EPERM` -- a different errno,
but the SAME non-fatal code path in `resolveListTarget`/`resolveInWorktree` handles every
non-ENOENT/ENOTDIR code identically, so this is still a genuine test of the fix, just not of
that exact errno).

### Round 8 gate fixes (Sec8/Code8/A11y8/Verif8, all FAILed round 7; round 7's own "real fix" --
### stop the watcher on panel unmount -- introduced two regressions, caught by all four
### reviewers independently)

**HIGH**: `stopFileExplorerWatcher`/`FILE_EXPLORER_ENSURE_WATCHING` deleted and recreated
`loadedPaths` on every stop/restart cycle -- so after the FIRST panel close+reopen, tab switch,
or Session A->B->A switch while the tab stayed open, `refreshDirectory`'s own membership check
silently dropped every watcher patch for every directory the renderer had already loaded,
INCLUDING the root. FR-020 (live refresh) was dead for the rest of the run past that first
cycle, and FR-021 (previewed-file-deleted detection) along with it, since both depend on the
same patch delivery. Round 7's own `tasks.md`/PR claims that FR-020 was "Done, live-verified"
and that the stop/restart cycle only affected "live-patch delivery" with the cache otherwise
untouched were both wrong -- the round-7 evidence never actually reopened a panel and changed a
file, so this was never caught. Fixed: `loadedPaths` now lives in its own `loadedPathsBySession`
map, independent of the watcher handle's own on/off lifecycle -- `stopFileExplorerWatcher` never
touches it, and it is cleared only by an actual reset (`notifyFileExplorerReset`, which already
means the renderer is reloading from scratch anyway). `FILE_EXPLORER_ENSURE_WATCHING` now
re-flushes `scheduleDirectoryFlush` for every path still parked there once a watcher actually
(re)starts -- the EXISTING `applyPatch`/`withPatchedChildren`/`isPathGoneUnderPatch`/
`scheduleStatusFetch` machinery (file-explorer-store.ts) then catches up the tree, the preview,
AND git status with no new renderer code at all.

**HIGH**: the `listDirectory` worktree-missing guard compared `watchers.get(id)?.handle ===
watchedHandle`, which is `undefined === undefined` (true) whenever `ensureWatcher` itself failed
to start a watcher at all (the worktree folder was already gone, `watchDirectory` returns
`undefined` synchronously). A Session with a genuinely missing worktree and no watcher therefore
ran stop+reset on EVERY call: `resetSession` drops the entry, the load-once effect fires again
(no entry), and the cycle repeats with no debounce -- a tight IPC+realpath loop that left the
panel stuck on "loading" forever instead of ever showing the honest worktree-missing error and
Retry/Recreate state. Fixed: only stop+reset when a watcher was ACTUALLY captured this call
(`watchedHandle !== undefined`); otherwise the error returns unchanged and the renderer's
existing root-error state renders it, same as any other load failure.

**MEDIUM** (A11y8): the scrolled-out-row focus rescue moved SELECTION, not just focus --
`onRowFocus` calls `setSelectedPath` on every row focus event, including the rescue's own
programmatic `.focus()` call, so a row merely scrolled out from under a focused-but-not-selected
row silently moved `aria-selected` and announced a new row the user never navigated to, worse
with every subsequent scroll. Fixed: a `rescueFocusRef` flag brackets the one synchronous
`.focus()` call (a native `focus` event fires synchronously inside `HTMLElement.focus()`, so
setting/clearing the flag immediately around that one call reliably brackets just this rescue's
own event); `onRowFocus` skips `setSelectedPath` while it is set.

**LOW** (A11y8): the fallback chain (treeRow -> previewRegion -> container) could still land on
the bare container in the narrow case where the rendered range holds no row with `tabindex="0"`
at all. Now tries any rendered `[data-tree-row-path]` row first.

**MEDIUM wording corrections** (Sec8/Code8/Verif8): the PR's "Risks" text said the ancestor lock
is held "while ANY `FileExplorerPanel` is mounted (its tab open, regardless of which tab is
active)" -- backwards; `RightPaneShell.tsx` mounts the panel only while its OWN tab is active.
What the text missed instead: a COLLAPSED right pane (dragged shut) keeps `activePanelId`
unchanged, so the panel -- and the watcher it holds open -- stays mounted, just invisible; the
lock continues while nothing is shown. Corrected to "while File explorer is the active tab,
including while the pane is collapsed". The `ensureWatching` handler's own "only live-patch
delivery resumes, the cache is otherwise untouched" claim is also corrected (see the HIGH fix
above). `resolveInWorktree` (`files.ts`) is shared with the chat-link/`sessions.revealFile` code
(issue #610) -- the ENOENT/ENOTDIR narrowing from round 7 means EPERM/EBUSY now return
`file-missing` instead of `worktree-missing` for those callers too, strictly more honest (a
transient permission hiccup was never really "the worktree is missing" there either), disclosed
here since Verif8 flagged it as previously undisclosed.

**LOW** (Sec8): a renderer crash or reload resets the module-level ref-count `Map` in
`FileExplorerPanel.tsx` to empty, but main's own watchers are a separate process and kept running
regardless, with nothing left to ever call `stopWatching` again short of archive/delete/
recreate/app-quit. `main/index.ts` now calls `stopAllFileExplorerWatchers()` on
`render-process-gone` and a main-frame `did-start-navigation` (a reload, including dev HMR's
full-page fallback) -- both are a hard reset of the renderer's entire state, so stopping every
watcher unconditionally is correct; the renderer's own fresh mount re-calls `ensureWatching` for
whichever Session(s) reopen a panel.

**LOW** (Sec8): `setFileExplorerSessionBusy` was a plain `Set` -- two concurrent busy-markers for
the SAME Session (a delete racing a recreate, both of which call it) could clear busy state
early, reopening the exact watcher-recreation race the marker exists to close. Now reference-
counted (`Map<string, number>`): busy only actually clears once every caller that set it has also
cleared it.

**LOW** (Code8): a flush already in flight when `stopWatching` ran (the panel closed mid-flush)
no longer delivers its patch afterward -- the same handle-identity guard the `worktree-missing`
branch already used, now applied to the success path too.

**LOW** (Code8): `ensureWatching`/`stopWatching` IPC failures are logged (`console.warn`) instead
of silently dropped; neither call has a user-facing recovery action, so this is diagnostic only,
not a toast.

**LOW** (Code8): the ref-count's own doc comment wrongly justified multi-instance support with "a
split pane could in principle show the same Session's panel twice" -- `App.tsx` renders exactly
one `RightPaneShell`, so at most one `FileExplorerPanel` is ever mounted for a given Session
today. Reworded to cite React StrictMode's own mount-unmount-remount dev-time double-invoke (and
HMR) as the actual reason ref-counting still matters, not a case that does not exist in this
codebase.

**Live-verified** (fresh scratch Electron instance, `C:/tmp/refract-671-gate8` -- never touching
Stuart's live Sessions; own `--user-data-dir`/CDP port 9342; evidence under
`C:/Users/shopwood/refract-live-check-671-gate8/`: 5 screenshots, two genuinely piped raw-output
logs -- `raw-output.txt` (the main 6-test run) and `raw-output-testc-isolated.txt` (test (c)'s
own isolated re-run, below), both driver scripts saved in the evidence folder only, never
committed to the repo, sha256.json; 10 files total/2 scripts, 0 duplicates):
- **Worktree-missing loop**: renamed a Session's worktree away (agent confirmed stopped first),
  opened its panel: `window.__resetEvents.length` stayed at **0** and the honest "Couldn't load
  this Session's files / This Session's worktree folder no longer exists / Retry" state rendered
  immediately (screenshot `01-worktree-missing-error-state.png`) -- no stuck "loading", no
  reset<->reload loop.
- **Close/reopen staleness**: expanded `src`, previewed `root-file.txt`; closed the panel;
  externally added `new-file.txt` and deleted `root-file.txt`; reopened: `new-file.txt` appeared
  as a new row and the preview flipped to "This file no longer exists / root-file.txt was removed
  or renamed" -- both FR-020 and FR-021 recovered from the SAME re-flush, no separate code path
  for either (screenshot `02-close-reopen-staleness-fixed.png`).
- **Session A/B/A switch staleness**: with the tab open, switched chat focus from Session A to
  Session B (A's watcher released, B's started); added a file to A's worktree while B was
  focused; switched back to A: the new file appeared without any manual action (screenshot
  `03-session-switch-staleness-fixed.png`).
- **Scroll-focus selection preservation**: selected a row in an 80-file virtualised tree,
  scrolled it out of the rendered window: the rescue moved the ACTIVE element to a different row,
  but that row's own `aria-selected` stayed `null` (never stolen), and scrolling back confirmed
  the ORIGINAL row was still the one carrying `aria-selected="true"` (screenshot
  `04-scroll-focus-rescue.png`).
- **Test (c), honestly confounded on the first combined-run attempt, then isolated and
  corrected**: staggered `archive(); sleep(50ms); listDirectory()` (genuinely entering the
  busy-marker's own window this time, unlike round 7's same-tick `Promise.all`) initially showed
  **0/10 releasing cleanly** in the same run as the other five tests above -- traced to a
  self-inflicted confound, not a regression: a SIBLING Session's own agent (left running from the
  close/reopen test, never explicitly stopped) had its own `cwd` set inside the same parent
  folder the ancestor-rename check targets, and an agent's cwd lock on its OWN worktree also
  blocks renaming an ANCESTOR of that cwd, completely independent of the Session-under-test's own
  watcher or busy-marker state. Re-run in total isolation (`raw-output-testc-isolated.txt`): every
  Session's own agent confirmed stopped first (a full `omp` process-name/`rpc-ui` scan showed only
  pre-existing, unrelated pids from other lanes on this shared machine) -- **10/10 released
  cleanly**, confirming the busy-marker fix genuinely holds under a race that lands where it is
  supposed to this time.
- **Test (d), properly awaited this time**: `icacls <worktree> /deny <user>:(RX)`, then
  `await`ed (inside an async IIFE, not the round-7 `JSON.stringify(Promise)` bug) a `listDirectory`
  call, THEN restored the ACL only after that await resolved: the result code was genuinely
  `file-missing` (confirming the fix, and confirming the real errno is `EPERM`, not the `EACCES`
  round 7 guessed); `window.__resetEvents.length`, expansion, selection, and the absence of any
  `role="alert"` text were all unchanged before vs. after (screenshot `05-test-d-redo-after.png`).

**Not verified this round**: the round-7 carried-over gaps (an app-side `getStatus()` call-count
instrumentation during a concurrent git-lock stress burst; the deliberate-click-elsewhere
focus-steal direction; a genuinely slow/throttled `shutdown()` to force an even wider
archive-vs-`listDirectory` race window than the now-staggered 50ms gap). A real screen reader
pass on the scrolled-out-row rescue's own announcement behaviour (confirmed via DOM/`aria-selected`
state only, as in every round so far).

---

## Slice 3 / Phase 3: Open in VS Code, remaining context-menu actions, polish, final verification

**Purpose**: the bridge from read-only preview to real editing, the remaining context-menu actions,
the accessibility passes that did not fit naturally into Slice 2's own scope, and the
cross-slice gate plus live verification the assignment requires before a PR is called ready.

- [X] T022 Add `resolveVSCodeExecutable()` (new, alongside `src/main/process/executables.ts`,
  research.md decision 1): checks `%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe`, then
  `%ProgramFiles%\Microsoft VS Code\Code.exe`, then `%ProgramFiles(x86)%\Microsoft VS
  Code\Code.exe`; throws (or returns `undefined`, matching this module's own existing convention)
  if none exists. Never resolves via `resolveExecutable('code')` (FR-016).
- [X] T023 [P] Add `fileExplorer.openInVSCode(sessionId, relativePath)` IPC handler: resolves the
  absolute file path via `resolveInWorktree` (T003) and the executable via T022, spawns with
  `shell: false` and an args array (FR-016); a clear `vscode-not-found` error code when T022
  resolves nothing, surfaced as a "VS Code not found" state in the renderer, never a silent
  fallback (FR-017). **Corrected during implementation**: this task's own draft wording
  ("a clear `vscode-not-found` error code") was superseded by `contracts/ipc.md`'s own, later,
  more deliberate design (this spec's own authoritative contract, written after this task list):
  `{ opened: false }` is a normal, successful `Result` value, never an IPC-layer error code -- no
  `vscode-not-found` code exists. The renderer still shows the "VS Code not found" state inline,
  just by branching on `result.value.opened` rather than on an error.
- [X] T024 [P] Add `fileExplorer.reveal(sessionId, relativePath)` and
  `fileExplorer.copyPath(sessionId, relativePath)` IPC handlers, reusing the exact pattern
  `SessionDetailsCard.tsx`'s own worktree-root "Open in file explorer"/"Copy path" buttons already
  establish (`shell.showItemInFolder`/clipboard write), scoped to the selected file's own path
  instead of the worktree root (FR-018).
- [X] T025 Wire a row context menu (right-click and a kebab/three-dot trigger for keyboard/touch
  parity, matching this codebase's own existing row-menu conventions) and a preview-toolbar button
  group offering Open in VS Code, Reveal in File Explorer, Copy path (T023, T024) -- not "Open with
  default app" this round (FR-019).
- [X] T026 [P] A11y polish pass: the preview region is a labelled, keyboard-scrollable region
  reachable by Tab from the tree (FR-023); resizing the pane or switching panels never loses the
  tree's focus position or expansion state (FR-025, same shared mechanism spec 013's other panels
  already use); `prefers-reduced-motion`/forced-colors checked for any new transition or token;
  `outline-none` never paired without a `focus-visible:outline-*` replacement anywhere touched this
  slice.
- [X] T027 [P] Run the full gate (`pnpm typecheck`, `pnpm build`, existing `vitest`, `check:indent`,
  `check:ui-text`, `check:theme-contrast`, `check:drag-regions`); fix any error before proceeding.
  **Results**: typecheck pass (both tsconfigs); vitest 376/376 (no new tests, AGENTS.md #605);
  check:indent 0/325 (0/326 as of round 7/8's own new files; re-run before each push); check:ui-text
  0/371; check:theme-contrast 313/313 (no new tokens);
  check:drag-regions 0/110 (one violation found and fixed on the new preview toolbar, same
  `no-drag-region` convention the Show-ignored-files row already uses); build pass.
- [X] T028 Full [quickstart.md](quickstart.md) pass in an isolated scratch Electron instance (own
  `--user-data-dir`, never Stuart's live Sessions): every story's numbered steps, including a real
  VS Code launch (or a genuine "not found" state if VS Code is absent from the scratch machine's
  known install roots), Reveal in File Explorer, and Copy path. **Results**: see the Slice 2
  checkpoint's own live-verification paragraph above for the full evidence (covers Stories 1, 2, 3,
  5 in detail) plus Open in VS Code (real `Code.exe` processes spawned, confirmed via
  `Get-Process`), Copy path (the real OS clipboard independently read back afterward via
  `Get-Clipboard`, not just the IPC result), and Reveal (`{ok:true}`, the resulting Explorer
  window itself not independently screenshotted). **Not re-driven this round** (time/scope,
  disclosed rather than silently skipped): the "VS Code not found" state (VS Code is installed on
  this dev machine, so no scratch machine without it was available to exercise the absent-install
  path); the symlink/junction-escape and huge-repository-cap edge cases (both already extensively
  live-verified with real fixtures in Slice 1's own PR #671 gate rounds 1-3, not re-driven here
  since nothing in Slice 2/3's own changes touches that code path); a non-ASCII/embedded-space
  path through the `-z`-based git invocation; the resizable tree/preview split handle itself;
  `prefers-reduced-motion`/forced-colors emulation; clicking the preview-toolbar/kebab-menu DOM
  buttons themselves end-to-end (their own rendering and the underlying IPC calls were each
  confirmed separately, not the full click-through).
- [X] T029 Update `docs/PLAN.md` row C4 only: status, branch, PR number (minimal diff, this

**Checkpoint**: every quickstart.md story passes; the gate commands above exit 0; `docs/PLAN.md`
row C4 reflects the real PR.

---

## Dependency summary

- Slice 0 (T001-T002, docs-only) blocks every later task -- the spec itself must land before any
  implementation PR opens.
- Slice 1 (T003-T011) depends on Slice 0 and on specs 013/014 (both merged, #665/#669).
- Slice 2 (T012-T021) depends on Slice 1 for a working tree/store to extend.
- Slice 3 (T022-T029) depends on Slice 2 for a working preview/tree to attach VS Code launch and
  the remaining context-menu actions to.

## Parallel example

Within Slice 1, T004 (main IPC handler), T005 (shared `ipc.ts`/preload), and T006
(`panel-registry.ts`) touch disjoint files and could be split across two agents if this lane ever
parallelises; this plan assumes one agent, one slice at a time, per the "one heavy build at a
time" machine constraint already in force for this session.
