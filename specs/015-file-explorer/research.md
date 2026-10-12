# Phase 0 Research: File explorer

1. **VS Code launch cannot reuse `resolveExecutable` (`src/main/process/executables.ts`) as-is.**
   That resolver walks PATH directories and applies PATHEXT, which is exactly right for a bare
   name that resolves to one real executable -- but `code`'s own PATH entry is a `bin/` folder
   containing `code.cmd`, a batch wrapper, not `Code.exe` (which lives in the parent install
   directory, e.g. `%LOCALAPPDATA%\Programs\Microsoft VS Code\`). Resolving to `code.cmd` would
   recreate the exact problem issue://463 flags: Node's 2024 BatchBadBinary fix means a `.cmd`
   cannot be spawned without `shell: true`, and `shell: true` risks argument injection via
   `& | ^ %` in a filename being passed as an argument. A new, dedicated
   `resolveVSCodeExecutable()` (same module, `executables.ts`, or a sibling file) is specified
   instead: checks fixed known install roots for `Code.exe` directly --
   `%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe` (default one-click user install) first,
   then `%ProgramFiles%\Microsoft VS Code\Code.exe` and `%ProgramFiles(x86)%\Microsoft VS
   Code\Code.exe` (system installs) -- the same fixed-path-with-fallback shape
   `resolvePowerShell()`/`taskkillPath()` already use in that file. Spawn with `shell: false` and
   an args array (`[worktreeRelativeOrAbsolutePath]`; no `--goto <path>:<line>` since no caller in
   this spec's scope ever supplies a line number, carved out per the issue's own decision comment).
   No known install root found means a "VS Code not found" UI state, never a silent fallback to
   `shell.openPath` or any other launcher.

2. **The git-status-marks reader is a new function reusing `gitRaw` (`src/main/git/git.ts`), not
   `diffStat.ts`'s own function.** `diffStat.ts` answers a different question -- committed and
   uncommitted changes since the merge-base with the Session's Base branch (`git diff-index
   <merge-base>` plus `ls-files --others`), built for the session details card's own +/- counts.
   The file explorer's status marks need the simpler, more familiar question: "what does this
   working tree look like against HEAD right now" (modified/added/untracked/deleted), the same
   question `git status` itself answers. The new reader calls
   `gitRaw(worktreePath, ['status', '--porcelain=v1', '-z', '--ignored=matching'])` once: `-z`
   NUL-delimits entries with no C-style path quoting (same reasoning `diffStat.ts` already
   documents for its own `ls-files -z` -- non-ASCII/special-character filenames and real
   leading/trailing spaces survive intact), and `--ignored=matching` makes the SAME single git
   call double as the ignore-handling source (decision 6 below), rather than invoking git twice
   for two separate purposes. Each returned `XY path` pair maps to one of modified / added /
   untracked / deleted / ignored for that row; a path with no entry at all is clean. This is a
   plain working-tree status read, not a merge-base diff, and does not call or wrap
   `diffStat.ts`'s own `computeDiffStat`.

3. **Binary detection reuses `diffStat.ts`'s NUL-byte heuristic, applied to a header slice, not
   the extension.** `diffStat.ts.isBinary()` already reads up to `BINARY_SNIFF_BYTES` (8000) and
   checks for a NUL byte -- git's own binary heuristic. The file explorer's preview reader applies
   the identical check to a capped read (the first slice of the file, same 8000-byte budget) before
   deciding whether to attempt a text/markdown/code render; a NUL found in that slice means the
   binary/"cannot preview" panel, regardless of the file's extension (a `.txt` can be binary, a
   `.dat` can be plain text -- magic-byte/content sniffing, never an extension allowlist, per the
   issue's own technical note).

4. **Image bytes cross the IPC boundary and become a displayable `<img>` the same way a pasted
   attachment already does: a `data:` URL, not a blob URL or a raw-buffer prop.**
   `src/renderer/features/chat/attachments.ts`'s `PendingImageAttachment.previewUrl` is documented
   inline as `` `data:${mimeType};base64,${base64}`, used for the thumbnail and the modal `` and is
   rendered directly as `<img src={image.previewUrl}>` (`AttachmentStrip.tsx`). That attachment's
   bytes originate client-side (a clipboard paste, already in the renderer); the file explorer's
   image bytes originate in main (a capped file read over IPC) and arrive at the renderer as a
   base64 string plus a MIME type resolved from the same magic-byte sniff decision 3 describes (no
   extension-based MIME guess). The renderer wraps it in the identical `data:${mimeType};base64,
   ${base64}` template and renders a plain `<img>` -- no new convention invented, and no
   blob-URL/`URL.createObjectURL` path introduced, since the existing convention already covers a
   base64 payload arriving by any route.

5. **File watcher: Node's `fs.watch({ recursive: true })` is available on Windows, but needs
   debouncing and a rename-ambiguity tolerance, not a polling fallback.** `fs.watch`'s
   `recursive` option has shipped cross-platform (including win32) since Node 20; on Windows it is
   backed by `ReadDirectoryChangesW`, which can coalesce or reorder rapid successive writes and
   reports both "a file was created" and "a file was renamed" as the ambiguous `rename` event type
   (Node's own documented caveat) -- the watcher therefore treats every `rename` event as "re-list
   this event's directory," not "this specific path was deleted," and debounces a burst of events
   (e.g. a git checkout touching many files at once) into one re-list per affected directory on a
   short trailing-edge timer, rather than a tree rebuild per raw event. No polling fallback is
   specified: Windows is the only platform this app ships on, and `ReadDirectoryChangesW` coverage
   is unconditional there (unlike the inotify-depth limits recursive watch has on Linux, which
   motivate a polling fallback in cross-platform tools but do not apply here).

6. **Ignore handling reuses the SAME git status call as the status marks (decision 2), rather than
   a second call or a hand-rolled `.gitignore` parser.** `git status --porcelain=v1 -z
   --ignored=matching` already lists every ignored path alongside tracked/untracked/modified ones
   in one invocation; the tree builder filters ignored paths out by default and the "show ignored
   files" toggle simply stops filtering them, with no second git process and no reimplementation of
   `.gitignore`'s own match semantics (nested `.gitignore` files, negation patterns, `.git/info/
   exclude`) -- git's own ignore engine is authoritative, exactly as git itself behaves from the
   command line, and `.git` itself is never listed by `git status` or shown by the tree regardless
   of the toggle (FR, not a filter git is asked to apply).

7. **Tree virtualisation reuses `react-virtuoso` (4.18.16), already a pinned dependency** (spec
   004/readout work; confirmed present in `package.json`) -- no new runtime dependency is added for
   this spec's own large-repository requirement (issue://463's "large repos: virtualise + cap
   entries per folder"). Each expanded folder's own children are the virtualised list (lazy-loaded
   on first expand, per the issue), capped per folder (a fixed maximum entry count per directory,
   with a "N more" row past the cap, rather than an unbounded render) rather than flattening the
   entire tree into one giant virtualised list -- this keeps roving-tabindex/ARIA
   `aria-expanded`/arrow-key navigation scoped the same way a native OS tree control behaves,
   consistent with `DESIGN.md`'s existing preference for an established list-virtualisation
   library over a bespoke one.

8. **Icon choice: `FolderTreeIcon`, distinct from every icon already in use on a right-pane rail
   button or an existing file-system action.** The four `HOSTED_PANELS` icons today are `BotIcon`
   (Subagents), `LibraryIcon` (FDB Knowledge), `HammerIcon` (Agent Builder), `MessageCircleIcon`
   (Side chat, spec 014) -- none reads as "files." `FolderOpenIcon` is already used elsewhere in
   this codebase for actions, not a panel identity (`AddRepositoryDialog.tsx`'s Browse button,
   `SessionDetailsCard.tsx`'s own "Open in file explorer" reveal button) and reusing it for the
   panel's own rail icon would visually conflate "open this panel" with "open the OS file
   explorer," the exact action this panel's own context menu also offers (Reveal in File
   Explorer) -- a collision this spec avoids by choosing a shape that reads as "a tree of files,"
   not "a single open folder." No git-changes-panel precedent exists yet to clash with: issue://464
   (the git-changes panel itself) is unbuilt, confirmed by searching the codebase for any
   `git-changes`/`GitChangesIcon`-shaped registration -- none found; `GitBranchIcon`/
   `FolderGit2Icon`/`GitPullRequestIcon` are already spoken for (branch labels, repository labels,
   pull request state) and are reserved in spirit for #464's own future icon choice, not reused
   here. `FolderTreeIcon` is lucide-react's own literal "a folder containing a nested tree," the
   closest available literal match (same reasoning spec 014's research.md decision 5 and spec
   013's research.md decision 8 both used: pick the single most literal shape, not a close
   metaphor).

9. **`PanelId`/IPC-namespace naming follows spec 014's own convention exactly.**
   `panel-registry.ts`'s `PanelId` union gains `'file-explorer'`, mirroring `'side-chat'`'s own
   addition (research.md decision 4, spec 014) -- no change to `PanelTabBar.tsx`, `IconRail.tsx`,
   or `PanelLauncher.tsx`, all of which already iterate `HOSTED_PANELS` generically; only
   `panel-registry.ts` and `RightPaneShell.tsx`'s one `activePanelId === '<id>'` switch change. The
   IPC namespace is `fileExplorer.*` (`fileExplorer.listDirectory`, `fileExplorer.readPreview`,
   `fileExplorer.getStatus`, `fileExplorer.openInVSCode`, `fileExplorer.reveal`,
   `fileExplorer.copyPath`), mirroring `sideChat.*`'s own naming shape
   (`sideChat.ask`/`sideChat.cancel`/`sideChat.getHistory`) rather than a differently-cased or
   differently-grouped alternative. Live refresh follows the same per-"thread" streaming shape
   `SUBAGENT_PATCH`/`SIDE_CHAT_PATCH` already establish: a new `FILE_EXPLORER_PATCH` event keyed
   by Session id, carrying either an incremental directory delta or (on watcher-coalescing
   uncertainty) a full re-list of the affected directory, with the renderer's own store
   responsible for preserving each node's expansion state across a patch (new nodes merge in
   place; a node's `expanded` boolean is never reset by an incoming patch for a directory it did
   not itself concern).

10. **Per-Session store keying mirrors `side-chat-store.ts`, a new `file-explorer-store.ts`.**
    Each Session's tree, its own expansion state, the current preview selection, and the git
    status map are keyed by Session id in one store, the same per-Session keying
    `side-chat-store.ts` already established for its own thread state (research.md decision 6,
    spec 014) -- not a single global tree bound to "whichever Session is focused" with no
    per-Session persistence, since a split view's two panes each show their own focused Session's
    tree (the decision comment on #463, cited in spec.md's Clarifications) and switching back to a
    Session already visited should not require a fresh directory listing for the root the watcher
    already covers.
