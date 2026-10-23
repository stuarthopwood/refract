# Phase 0 Research: Git changes panel (slice 1)

1. **`git status --porcelain=v2 -z --branch`, not `v1`, for this panel specifically.** The File
   explorer panel's existing `status.rs` reads `--porcelain=v1 --ignored=matching`, which answers
   "what mark does this path have" but carries no branch or ahead/behind information at all. `v2`'s
   own header lines (`# branch.head`, `# branch.upstream`, `# branch.ab`) give branch name,
   upstream, and ahead/behind counts in the SAME call this panel already needs for the status
   entries themselves -- a second `git rev-list --left-right --count` call (or similar) would
   otherwise be needed purely for the header row. `v2`'s per-entry format differs from `v1`'s
   (`1 XY sub mH mI mW hH hI path` vs `XY path`, and a distinct `u` line shape for unmerged/
   conflicted entries with no copy/rename second path to consume), so `status.rs`'s existing
   `parse_status` is not reused as-is -- `changes_status.rs` is new parsing code, following
   `parse_status`'s established pattern (NUL-delimited, `get`-based slicing, never indexed
   directly) rather than literally reusing its function body, exactly as the issue's own grill
   comment states ("new code in `src-tauri/src/git/`, not a reuse of `status.rs`'s existing
   function as-is").

2. **`GitStatusMark` itself is reused unchanged, not re-derived.** `status.rs`'s own header
   comment already states the enum (`Modified | Added | Untracked | Deleted | Ignored | Renamed |
   Conflicted | Staged`) was extended for issues #768/#790 explicitly "for this and the future Git
   panel (#464)". `changes_status.rs`'s v2 parser maps v2's own XY/u-line codes onto this same
   enum (the precedence rules -- conflict first, then rename, then delete/add, then staged-vs-
   modified -- carry over conceptually even though the input format differs), so the renderer's
   existing `STATUS_MARKS` icon/label map (`FileExplorerPanel.tsx:52-60`) needs no change at all
   to serve this panel's rows too.

3. **Stage/unstage verbs: `git add --` / `git restore --staged --`, never `checkout`.** The issue's
   own grill decision 5 names the dedicated Git 2.23+ `restore` verb explicitly over the older,
   overloaded `checkout` (which also switches branches depending on its arguments -- a materially
   riskier command to shell with developer-visible file paths). `--worktree` (which would discard
   uncommitted edits) is deliberately NOT used by this slice's Unstage action; that verb belongs to
   slice 3's own discard feature, filed separately (#1061), so this slice never discards anything.

4. **Commit via `git commit -F -` (stdin), never `-m`.** Argv-based `-m "<message>"` has both a
   platform argument-length ceiling and a quoting/escaping surface for a multi-line message
   (subject + body) typed by a developer; stdin has neither. This mirrors the same reasoning
   `diff_stat.rs`'s own file-size caps apply elsewhere in this codebase: prefer the mechanism with
   no attacker/accident-controlled-length footgun over the one that merely "usually" has room.

5. **Panel registration follows the existing `panel-registry.ts` pattern exactly, no shell
   changes needed.** `PanelId` gains `'git-changes'`; `HOSTED_PANELS` gains one more descriptor
   (icon, name, `hasCount: true` using the already-defined-but-unused
   `{ kind: 'additions-deletions', additions, deletions }` `PanelCount` shape). This is the same
   shape spec 014 (`side-chat`) and spec 015 (`file-explorer`) already added, and those specs'
   own research.md entries record that `RightPaneShell.tsx`, `PanelTabBar.tsx`, `IconRail.tsx`, and
   `PanelLauncher.tsx` all iterate `HOSTED_PANELS` generically -- confirmed still true by reading
   `panel-registry.ts` itself, which lists all five existing panels with no other file needing a
   per-panel-id branch beyond one `activePanelId === '<id>'` switch arm in `RightPaneShell.tsx`.

6. **The existing `fs/watch.rs` debounced watcher is reused unchanged, not duplicated.** The
   issue's own grill decision 3 states this explicitly: a worktree file-system change is one of
   three refresh triggers, "reusing the existing debounced `notify` watcher (`fs/watch.rs`,
   already shared with the File explorer panel), not a second watcher implementation." The File
   explorer panel's own `ensureWatching`/`stopWatching` IPC pair (`ipc/file_explorer.rs`) is the
   lifecycle shape `ipc/git_changes.rs` mirrors: the panel calls `ensureWatching` on mount (or
   Session focus) and `stopWatching` on unmount/Session blur, so a closed panel's Session is never
   watched (spec.md FR-016).

7. **Status-transition refresh reuses `SessionStatus` as-is, no new event.** `session/agent/
   types.rs`'s existing `SessionStatus` enum (`Idle | Working | NeedsYou | Stopped`) already backs
   the Status line's own Working->(not Working) transition detection; this panel's refetch-on-
   turn-end trigger (spec.md FR-015a) subscribes to the exact same signal rather than introducing
   a second "did the agent just finish" mechanism.

8. **Badges render through the existing `DiffStatCounts` component, no new badge component.**
   `sessionDisplay.tsx`'s `DiffStatCounts` (issue #925) is already the one shared `+N`/`-N` badge
   repo-wide (green/red via `--diff-added`/`--diff-removed` tokens, muted zero, sr-only label);
   every badge this panel needs -- per-file, per-group-header aggregate, and the panel's own tab/
   rail count -- reuses it directly rather than a parallel implementation, settling the issue's own
   "badges" open question (grill decision 10).

9. **Group headers reuse `GroupHeaderTrigger` exactly, no new collapsible-header component.**
   `GroupHeader.tsx`'s `GroupHeaderTrigger` is the one collapsible-group-with-count precedent in
   the app (currently used by `SessionList.tsx`'s Archived group); it already supports a leading
   chevron, trailing `(N)` count, and a reserved actions-column slot for exactly the per-group bulk
   action this panel needs (Stage all / Unstage all), so no new header component is built.

10. **No new Settings entry, no new Tauri capability.** Neither the issue nor the grill asks for a
    toggle of any kind. This feature shells `git` through the already-capability-free process-spawn
    path `git::git::git_raw` already provides to every other git-backed feature in this app
    (`status.rs`, `diff_stat.rs`); the renderer never reaches a webview-exposed plugin API
    directly, so `capabilities/default.json` needs no new grant (constitution Principle V,
    addressed directly in plan.md's Constitution Check).
