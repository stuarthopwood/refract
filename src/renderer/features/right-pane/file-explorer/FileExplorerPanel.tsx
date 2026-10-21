// File explorer panel (spec 015): the fifth right-pane tenant. Slice 1 (T006-T010) shipped the
// shell plus a plain, click-to-expand nested list. Slice 2 (T012, T018, T020) replaces that list
// with a real WAI-ARIA treeview (role="tree"/"treeitem", roving tabindex, full keyboard nav,
// type-ahead, virtualised per the live tree's own flattened visible rows), adds git status marks
// and a "show ignored files" toggle, and adds the bottom preview split (`FilePreviewPane.tsx`).
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import {
  AlertCircleIcon,
  ArrowRightLeftIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  Code2Icon,
  CopyIcon,
  EllipsisVerticalIcon,
  EyeOffIcon,
  FileIcon,
  FileWarningIcon,
  FileX2Icon,
  FilePlus2Icon,
  FolderIcon,
  FolderOpenIcon,
  PencilIcon,
  TriangleAlertIcon,
  type LucideIcon
} from 'lucide-react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { toast } from 'sonner'
import { ActiveIndicatorBar } from '@/components/ActiveIndicatorBar'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { Switch } from '@/components/ui/switch'
import { isFocusStranded } from '@/lib/focus'
import { notify, useFileExplorerStore, useSessionsStore } from '@/state'
import type { GitStatusMark } from '../../../../shared/model'
import type { ExpandableNode } from '../../../state/file-explorer-store'
import { FilePreviewPane } from './FilePreviewPane'

interface FileExplorerPanelProps {
  /** The Session this tree follows -- no independent binding of its own (FR-004), the same
   * pattern spec 013's Subagents panel and spec 014's Side chat already use: it always reflects
   * whichever Session the chat pane currently shows. */
  sessionId: string | null
}

/** FR-010/FR-024: icon-plus-text-equivalent per status mark, never colour alone (reuses already-
 * gated tokens); `renamed`/`conflicted`/`staged` (R7 #790/#768) keep this exhaustive, #768 designs them. Exported (research.md decision 2) for `GitChangesFileRow.tsx`'s reuse, no second copy. */
export const STATUS_MARKS: Record<GitStatusMark, { Icon: LucideIcon; className: string; label: string }> = {
  modified: { Icon: PencilIcon, className: 'text-state-needs-you', label: 'Modified' },
  added: { Icon: FilePlus2Icon, className: 'text-state-working', label: 'Added' },
  untracked: { Icon: CircleDashedIcon, className: 'text-state-working', label: 'Untracked' },
  deleted: { Icon: FileX2Icon, className: 'text-destructive', label: 'Deleted' },
  ignored: { Icon: EyeOffIcon, className: 'text-muted-foreground', label: 'Ignored' },
  renamed: { Icon: ArrowRightLeftIcon, className: 'text-state-needs-you', label: 'Renamed' },
  conflicted: { Icon: AlertCircleIcon, className: 'text-destructive', label: 'Conflicted' },
  staged: { Icon: CheckCircle2Icon, className: 'text-state-working', label: 'Staged' }
}

interface NodeRow {
  kind: 'node'
  node: ExpandableNode
  depth: number
  posinset: number
  setsize: number
  /** This row's own position among every OTHER node row, in flattened visible order --
   * independent of `absIndex` (this row's position in the FULL `rows` array, "more" rows
   * included), which keyboard nav never needs: Up/Down/Home/End/type-ahead all skip "more" rows
   * entirely (nothing to select there), so they only ever need to walk this narrower sequence. */
  nodeIndex: number
}

interface MoreRow {
  kind: 'more'
  depth: number
  count: number
  key: string
  /** PR #671 gate round 4 fix (Medium, A11y4): the "N more" row is a real `role="treeitem"` now
   * (see its own render site), so it needs its own `aria-posinset`/`aria-setsize` like any other
   * sibling -- it always renders LAST among its own siblings, so `posinset` is always `setsize`. */
  posinset: number
  setsize: number
}

type FlatRow = NodeRow | MoreRow

/** Flattens `root`'s currently-EXPANDED subtree into the rows the tree actually renders (T012):
 * a collapsed folder's own children are not in this array at all. `showIgnored`-filters out any
 * `ignored`-marked row (and, with it, that row's own subtree, if it is a folder) before indexing
 * siblings for `aria-posinset`/`aria-setsize`, so a hidden row never shows up in either count.
 * Each folder's own "N more" row (its own `truncated` count) is appended immediately after that
 * folder's own listed children (and their own nested rows), at the same depth as those children
 * -- matching where the capped listing itself stops, and counts as one more sibling in
 * `aria-setsize` (PR #671 gate round 4 fix, Medium, A11y4): it occupies a real position in the
 * group even though it is not a `treeitem` a screen reader can activate. */
function flattenVisible(root: ExpandableNode | null, showIgnored: boolean): FlatRow[] {
  if (!root?.children) return []
  const rows: FlatRow[] = []
  let nodeCounter = 0
  function walk(nodes: ExpandableNode[], depth: number, parentPath: string, truncatedHere: number | undefined): void {
    const visible = nodes.filter((node) => showIgnored || node.gitStatus !== 'ignored')
    const siblingCount = visible.length + (truncatedHere ? 1 : 0)
    visible.forEach((node, i) => {
      rows.push({ kind: 'node', node, depth, posinset: i + 1, setsize: siblingCount, nodeIndex: nodeCounter })
      nodeCounter += 1
      if (node.kind === 'folder' && node.expanded && node.children) {
        walk(node.children, depth + 1, node.path, node.truncated)
      }
    })
    if (truncatedHere) {
      rows.push({ kind: 'more', depth, count: truncatedHere, key: `more:${parentPath}`, posinset: siblingCount, setsize: siblingCount })
    }
  }
  walk(root.children, 0, root.path, root.truncated)
  return rows
}

/** Spec 015 Slice 3 (contracts/ipc.md `fileExplorer.copyPath`): joins `relativePath`'s own
 * POSIX-`/`-separated segments (`FileTreeNode.path`'s convention) onto `worktreePath`'s own
 * OS-native separator, for the renderer-side `navigator.clipboard.writeText` attempt only
 * (`useWorktreeActions.ts`'s own clipboard-first pattern) -- never the security boundary
 * itself, which stays server-side (`resolveInWorktree`, `fileExplorer.copyPath`'s own handler). */
function joinWorktreePath(worktreePath: string, relativePath: string): string {
  const separator = worktreePath.includes('\\') ? '\\' : '/'
  const trimmedRoot = worktreePath.replace(/[\\/]+$/, '')
  return `${trimmedRoot}${separator}${relativePath.split('/').join(separator)}`
}

// PR #671 gate round 7 fix (Sec7/Code7/A11y7/Verif7 real-impact fix): `ensureWatcher`
// (`src/main/ipc/fileExplorer.ts`) opens a recursive directory watcher that blocks rename/move
// of every ANCESTOR of the worktree root for as long as it runs -- previously, once the first
// panel for a Session opened, nothing ever stopped it again until archive/delete/recreate/fatal/
// app quit. `RightPaneShell.tsx` conditionally renders this component only while its tab is the
// ACTIVE one (`activePanelId === 'file-explorer' && <FileExplorerPanel .../>`) -- switching to a
// different tab, or closing the last open tab, genuinely unmounts it; switching to a DIFFERENT
// Session while staying on this tab keeps the component mounted but changes `sessionId`. Module-
// level (not component state) and keyed by `sessionId`, not by component instance -- strictly,
// `App.tsx` renders only ONE `RightPaneShell`, so at most one `FileExplorerPanel` is ever
// mounted for a given Session today; the ref-count exists for React StrictMode's own
// mount-unmount-remount dev-time double-invoke (and HMR), not a real multi-instance case (Code8
// Low correction -- a prior version of this comment wrongly cited a hypothetical split pane).
// Ref-counting still keeps the stop/ensure ordering correct under that double-invoke: the first
// mount's own `ensureWatching` and the immediate unmount's `stopWatching` net out to zero before
// the real, lasting mount's own `ensureWatching` runs.
const watcherRefCounts = new Map<string, number>()

export function FileExplorerPanel({ sessionId }: FileExplorerPanelProps) {
  const root = useFileExplorerStore((s) => (sessionId ? (s.bySession[sessionId]?.root ?? null) : null))
  // Gate round 5 fix (Code5 HIGH1): a reactive selector, not an imperative `getState()` read --
  // the latter only ever ran once per `sessionId` change, so `resetSession` (fired from
  // `FILE_EXPLORER_RESET`) deleting this Session's entry had nothing to re-trigger the effect
  // below with. Subscribing to presence itself means the effect's own dependency array sees the
  // `true -> false` transition and re-runs, exactly like a brand-new Session's first mount.
  const hasSessionEntry = useFileExplorerStore((s) => (sessionId ? sessionId in s.bySession : false))
  const status = useFileExplorerStore((s) => (sessionId ? (s.bySession[sessionId]?.status ?? 'loading') : 'loading'))
  const error = useFileExplorerStore((s) => (sessionId ? (s.bySession[sessionId]?.error ?? null) : null))
  const showIgnored = useFileExplorerStore((s) => (sessionId ? (s.bySession[sessionId]?.showIgnored ?? false) : false))
  const selectedPath = useFileExplorerStore((s) => (sessionId ? (s.bySession[sessionId]?.selectedPath ?? null) : null))
  const preview = useFileExplorerStore((s) => (sessionId ? (s.bySession[sessionId]?.preview ?? null) : null))
  const previewLoading = useFileExplorerStore((s) => (sessionId ? (s.bySession[sessionId]?.previewLoading ?? false) : false))
  const loadDirectory = useFileExplorerStore((s) => s.loadDirectory)
  const toggleExpanded = useFileExplorerStore((s) => s.toggleExpanded)
  const setShowIgnored = useFileExplorerStore((s) => s.setShowIgnored)
  const setSelectedPath = useFileExplorerStore((s) => s.setSelectedPath)
  const loadPreview = useFileExplorerStore((s) => s.loadPreview)
  const worktreePath = useSessionsStore((s) =>
    sessionId ? s.sessions.find((session) => session.id === sessionId)?.worktreePath : undefined
  )

  const containerRef = useRef<HTMLDivElement>(null)
  const treeContainerRef = useRef<HTMLDivElement>(null)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  // Gate round 9 fix (A11y9 Medium): kept live via a plain assignment on every render (see the
  // assignment right after `rows` itself is computed below) so `handleFocusOut`'s own listener
  // (attached once, on mount) always reads the CURRENT logical row list, never a stale closure
  // -- needed to tell a row merely scrolled out of Virtuoso's rendered window (still logically
  // present here) apart from one genuinely removed (deleted on disk, a folder collapsed).
  const rowsRef = useRef<FlatRow[]>([])
  // Gate round 8 fix (A11y8 Medium), moved up here in round 9 so the earlier `[sessionId,
  // status]` effect below can also wrap its own programmatic `.focus()` call with it: brackets
  // every rescue's one synchronous `.focus()` call (a native `focus` event fires synchronously
  // inside `HTMLElement.focus()`) so `onRowFocus` can skip `setSelectedPath` while it is set,
  // restoring KEYBOARD position without hijacking the user's own selection.
  const rescueFocusRef = useRef(false)
  // (Gate round 9 fix (A11y9 Medium) added a deferred-rescue flag here, consumed on the user's
  // own next keypress -- round 10 (A11y10/Code10/Verif10 HIGH) found it stole focus back into
  // the tree after the user had deliberately clicked somewhere non-focusable, since nothing ever
  // disarmed it on that click; removed below, see the big comment above `handleFocusOut`.)
  // Type-ahead buffer (T012, FR-022): resets 500ms after the last keypress, same timeout
  // convention as a native `<select>`'s own type-ahead. A ref, not state -- it drives no render
  // of its own, only the NEXT keypress's search.
  const typeaheadRef = useRef<{ buffer: string; timer: ReturnType<typeof setTimeout> | undefined }>({ buffer: '', timer: undefined })
  // Gate round 13 fix (A11y13/Verif13 HIGH): `moveToRow` below asks Virtuoso to scroll to a row
  // and focuses it in the `scrollIntoView` `done` callback -- correct for a SHORT jump, but on a
  // LONG one (`End`/`Home`/type-ahead across hundreds of rows, estimated row heights not yet
  // measured) `done` can fire once scrolling itself settles, before the target row has actually
  // mounted in the DOM. The `querySelector(...)?.focus()` call then silently finds nothing and
  // does nothing, stranding focus on `<body>` after a key the TREE ITSELF handles -- not the
  // separate, disclosed mouse-wheel/resize scroll-out limitation elsewhere in this file, since no
  // further user action caused this one. Holds the target path moveToRow could not immediately
  // focus; retried by the `renderedRange` effect below once a LATER `rangeChanged` shows the row
  // is actually in the DOM.
  // Gate round 14 fix (Code14 HIGH): react-virtuoso's own `scrollIntoView` subscribes each call's
  // `done` to the SAME next `scrollingInProgress` true->false edge -- a SUPERSEDED call's `done`
  // is never cancelled, so it still fires on that edge alongside (or before) the newest call's
  // own `done`. A fast End-then-Home (or any two long jumps before the first one's own scroll
  // settles) let the OLDER call's `done` re-arm this ref (its own target still unmounted) AFTER
  // the newer call's `done` had already succeeded and cleared it -- `moveGenRef` below (bumped at
  // the top of every `moveToRow` call, checked at the top of every `done`) makes a superseded
  // call's `done` a no-op instead, closing the stale-`done`-re-arming race specifically. Whether
  // this fully explains an `End`-then-`Home` race's own observed behaviour is open -- see the
  // next comment and tasks.md's own "Round 15 gate fixes" section.
  // Known open limitation (round 16, correcting round 14/15): after a type-ahead-initiated long
  // jump into a never-before-measured 1000+-row batch, the list scrolls (scrollTop moves) but
  // focus does not land on the target row; after an `End`-then-`Home` race the final scrollTop
  // matches `Home`'s own target and focus still lands on `<body>` -- cause not established in
  // either case. See tasks.md's own "Round 15"/"Round 16 gate fixes" sections for the live
  // evidence and open hypotheses (no surviving artifact from round 15's own live runs; see that
  // section for why).
  const moveGenRef = useRef(0)
  const pendingFocusPathRef = useRef<string | null>(null)
  // Tracks whether focus is currently somewhere inside this panel, kept live via a document-wide
  // `focusin` listener -- NOT read at the moment `sessionId`/`status` changes: by the time this
  // component re-renders for a Session switch or a Retry, the row/button that had focus may
  // already be mid-unmount, and a removed element's forced blur reads as `<body>`, not this
  // panel. Copies `ChatPane.tsx`'s own `chatHadFocusRef` pattern exactly (PR #671 gate fix,
  // accessibility-auditor/code-reviewer MEDIUM, round 2).
  const hadFocusRef = useRef(false)
  useEffect(() => {
    const updateFocusFlag = () => {
      hadFocusRef.current = !!containerRef.current?.contains(document.activeElement)
    }
    updateFocusFlag()
    document.addEventListener('focusin', updateFocusFlag)
    return () => document.removeEventListener('focusin', updateFocusFlag)
  }, [])

  // FR-004/FR-005: the root listing, once per Session per app run (mirrors side-chat's own
  // `loadHistory`-on-first-open effect, spec 014). Only the very first attempt is automatic --
  // once a Session has EITHER succeeded or failed once, this effect never fires again for it;
  // a failed load's own Retry button (below) is the only way to try again.
  useEffect(() => {
    if (!sessionId || hasSessionEntry) return
    void loadDirectory(sessionId, '')
  }, [sessionId, hasSessionEntry, loadDirectory])

  // PR #671 gate round 7 fix (Sec7/Code7/A11y7/Verif7 real-impact fix): stops the Session's
  // recursive watcher the instant this is the LAST mounted `FileExplorerPanel` instance for it
  // (ref-counted via the module-level `watcherRefCounts` above), and restarts it (without a full
  // reload, so the cached expansion/scroll state the `bySession` entry already holds survives
  // untouched) when one mounts again. Keyed on `[sessionId]` alone, deliberately: this must
  // re-run for a Session SWITCH while this tab stays active (the component instance survives,
  // only the prop changes) exactly the same way it re-runs for a genuine mount/unmount, so the
  // OLD Session's watcher is released and the NEW one's is (re)started either way. Does not
  // touch `bySession`/`resetSession` -- an actual tree reload only ever happens via
  // `FILE_EXPLORER_RESET` (watcher-fatal/archive/recreate/restore) or the "load once" effect
  // above, neither of which this effect fires. Gate round 8 correction (Code8/Sec8/Verif8
  // Medium): this component renders while its tab is the ACTIVE one, which INCLUDES while the
  // right pane itself is collapsed (dragged shut) -- `RightPaneShell.tsx` keeps `activePanelId`
  // unchanged on collapse, so the panel (and this effect, and the watcher it holds open) stays
  // mounted, just invisible; the ancestor-folder lock continues while nothing is shown. This is
  // the accurate scope of the fix -- "while a panel for this Session is actually mounted" never
  // meant "only while visible". Round 8 also fixed the separate claim, previously here and in
  // `fileExplorer.ts`'s own `ensureWatching` handler, that re-mounting "only resumes live-patch
  // delivery" with the renderer's cache otherwise untouched -- `ensureWatching` now re-flushes
  // every path this Session still has loaded, so a stop/restart cycle also catches up anything
  // that changed while unwatched (see that handler's own doc comment for the full account).
  useEffect(() => {
    if (!sessionId) return
    const id = sessionId
    const count = (watcherRefCounts.get(id) ?? 0) + 1
    watcherRefCounts.set(id, count)
    // Gate round 8 fix (Code8 Low): `void` alone drops a `{ ok: false }` IPC result silently --
    // logged, not surfaced as a toast, since neither call has any user-facing recovery action
    // (a failure here just means the watcher didn't (re)start; the NEXT mount/unmount retries).
    if (count === 1) {
      window.refract.fileExplorer
        .ensureWatching(id)
        .then((result) => {
          if (!result.ok) console.warn('FileExplorerPanel: ensureWatching failed', result.error)
        })
        .catch((err) => console.warn('FileExplorerPanel: ensureWatching rejected', err))
    }
    return () => {
      const remaining = (watcherRefCounts.get(id) ?? 1) - 1
      if (remaining <= 0) {
        watcherRefCounts.delete(id)
        window.refract.fileExplorer
          .stopWatching(id)
          .then((result) => {
            if (!result.ok) console.warn('FileExplorerPanel: stopWatching failed', result.error)
          })
          .catch((err) => console.warn('FileExplorerPanel: stopWatching rejected', err))
      } else {
        watcherRefCounts.set(id, remaining)
      }
    }
  }, [sessionId])

  // PR #671 gate round 4 fix (High, A11y4): the EARLIER version of this comment claimed this
  // effect also covered a preview-pane toggle (Source/Wrap) unmounting -- it does not, and never
  // could, since this effect only re-runs on `[sessionId, status]`, neither of which changes when
  // `preview.kind` does. Reclaims focus onto the container ONLY when it is actually stranded --
  // never unconditionally, which would steal focus from somewhere the user deliberately moved it
  // to (the sidebar row just clicked) even on a render where `hadFocusRef` never got a chance to
  // update first. Keyed on `[sessionId, status]`: a Retry (same Session, `status` flips `loading`
  // -> `error` -> `ready`) unmounts the Retry button exactly the same way a Session switch
  // unmounts a focused row, and needs the identical rescue (PR #671 gate fix, accessibility-
  // auditor/code-reviewer MEDIUM, round 2). The SEPARATE `focusout` listener below is the general
  // rescue for everything ELSE that can unmount a focused control without `sessionId`/`status`
  // changing at all -- a live-refresh patch removing/collapsing the focused row, or an FR-021
  // delete unmounting the preview toolbar/Wrap/Source button. Gate round 11 correction: a
  // virtualised row merely scrolling out of view is NOT rescued by this listener (see the
  // disclosed limitation in the effect below) -- it used to be, rounds 7-9, before round 10
  // removed that path as its own worse accessibility regression.
  useEffect(() => {
    if (!hadFocusRef.current) return
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (isFocusStranded(active, containerRef.current)) containerRef.current?.focus()
      // Gate round 6 fix (A11y6 Low): once `status` is `'ready'` again (including the reload
      // `FILE_EXPLORER_RESET` triggers after a watcher-fatal/archive/restore/recreateWorktree
      // event) and focus landed on the bare container -- either from the rescue just above, or
      // from an earlier one in the same reload cycle -- upgrade it to the actual tabbable tree
      // row, so a keyboard user lands somewhere useful instead of an unlabelled wrapper. Gate
      // round 9 fix (A11y9 Medium): wrapped in `rescueFocusRef` too -- this is also a
      // programmatic rescue focus, not a user action, so it must not hijack selection either.
      if (status === 'ready' && document.activeElement === containerRef.current) {
        const treeRow = treeContainerRef.current?.querySelector<HTMLElement>('[data-tree-row-path][tabindex="0"]')
        rescueFocusRef.current = true
        try {
          treeRow?.focus({ preventScroll: true })
        } finally {
          rescueFocusRef.current = false
        }
      }
    })
  }, [sessionId, status])

  // PR #671 gate round 4 fix (High, A11y4): a watcher patch removing/collapsing the focused tree
  // row, an FR-021 delete unmounting the preview toolbar's own Wrap/Source/action buttons, or a
  // virtualised row scrolling a focused element out of the DOM all drop focus to `<body>` with
  // NEITHER `sessionId` NOR `status` changing -- the effect above never re-runs for any of them.
  // A document-wide `focusin` listener (like `hadFocusRef`'s own) cannot catch this case: there is
  // no NEW `focusin` event when an element is simply removed out from under focus. A `focusout`
  // listener on the container itself fires for all three -- but, per round 11's own correction
  // below, only the first two are actually rescued; the third (scroll-out) is a disclosed
  // limitation, not silently dropped from this comment's own accounting.
  //
  // Gate round 5 fix (Code5 HIGH2, A11y5 HIGH): `relatedTarget === null` alone is NOT a reliable
  // "the focused element was removed" signal -- Chromium also reports `relatedTarget: null` for
  // a perfectly deliberate click on any NON-focusable area (a chat message, the panel's own
  // header label, empty space), which blurs to `<body>` the exact same way. The previous version
  // rescued focus in BOTH cases, stealing it back from a user who had just clicked somewhere
  // else on purpose. Captures `lost` (`event.target`) at focusout time, before anything unmounts,
  // and only rescues a frame later if `lost` is ACTUALLY gone/unusable (`!isConnected`, inside an
  // `[inert]` subtree, or `disabled`) -- never merely "focus moved to something non-focusable".
  // Gate round 7 fix (A11y7/Code7/Verif7): round 6's own fix here (below) special-cased a row
  // merely scrolled out of Virtuoso's rendered window (`!isConnected` reads it the same as a
  // real removal) by parking focus on the bare container instead of stealing it -- but the
  // container is a `role="group"` div with no `onKeyDown` of its own: arrows, Home/End and
  // type-ahead did nothing there, and `Tab` from it reached the "Show ignored files" switch
  // first in DOM order, never a tree row. Removed below; both cases (genuinely removed AND
  // merely scrolled out) now use the SAME final rescue a few lines down, which focuses the
  // actual tabbable row (`tabbableAbsIndex` is recomputed via `rangeChanged` to the first
  // RENDERED row whenever the previously-tabbable one scrolls out of view, so that row is
  // always real, present, and fully keyboard-functional -- never the bare container).
  //
  // Gate round 8 fix (A11y8 Medium): that round-7 rescue moved SELECTION, not just focus --
  // `onRowFocus` below calls `setSelectedPath` on every row focus event, including this
  // PROGRAMMATIC one, so a row scrolling out from under a focused AND selected row (clicking a
  // row both focuses AND selects it via `selectAndActivate`/`onFocus`, corrected wording --
  // round 8's own comment wrongly said "focuses it" alone) silently moved `aria-selected` and
  // announced a new row the user never navigated to -- worse with every subsequent scroll,
  // since the rescue re-fired each time the tabbable row changed. `rescueFocusRef` wraps every
  // rescue's one synchronous `.focus()` call (a native `focus` event fires synchronously inside
  // `HTMLElement.focus()`, so setting/clearing this flag immediately around that one call
  // reliably brackets just this rescue's own event, never a user's real Tab/click): `onRowFocus`
  // skips `setSelectedPath` while it is set, so the rescue restores KEYBOARD position without
  // also hijacking the user's own selection.
  //
  // Gate round 9 fix (A11y9 Medium, REVERTED round 10 -- see below): round 8's own fix still
  // re-fired this rescue on EVERY single scroll tick that pushed the focused-and-selected row
  // out of Virtuoso's rendered window, even though the row is merely virtualised away, not
  // genuinely gone -- continuous wheel-scrolling hopped focus from row to row, each hop a fresh
  // announcement to a screen reader (WCAG 2.2.4/4.1.3 noise), never examined before now. Round 9
  // tried a ONE-SHOT deferred rescue for this case, consumed by the user's own next keydown
  // anywhere in the document.
  //
  // Gate round 10 fix (A11y10/Code10/Verif10 HIGH): the deferred rescue was itself a worse
  // defect than the noise it fixed -- exactly the "deliberate click on a non-focusable area must
  // not have focus stolen back" case round 5 rated HIGH (Code5 HIGH2/A11y5 HIGH), reintroduced.
  // Nothing disarmed the flag on a click: scroll a focused+selected row out of view (flag
  // armed), then deliberately click non-focusable chat text or empty space to read or select it
  // (focus is already `<body>`, so no `focusout`/`focusin` fires to clear anything) -- the VERY
  // NEXT keypress anywhere, for ANY reason (PageDown/arrows to scroll the transcript, Ctrl+C to
  // copy, the start of an app accelerator), silently pulled focus and the announcement into a
  // tree row the user never navigated to, and (a separate bug on top) the key's own default
  // action then ran against that newly-focused row instead of wherever the user actually meant
  // it to go (Tab skipped past the tree entirely; arrows/PageDown/Space scrolled the TREE, not
  // the transcript). The flag also never expired on its own. Removed entirely, along with the
  // `deferredRescueArmed` ref and the document-wide `keydown` listener that consumed it.
  //
  // Accepted, disclosed limitation (not re-attempted this round, per round 9's own now-reverted
  // attempt): a focused+selected row that merely scrolls out of Virtuoso's rendered window drops
  // focus to `<body>` and STAYS there, with no action from the user -- a WCAG 2.4.3 Focus Order
  // violation. Arrow keys, Home/End and type-ahead all stop working until the user presses Tab
  // (if the row scrolled out ABOVE the rendered window) or Shift+Tab (if BELOW) -- Chromium's own
  // sequential-focus-navigation starting point depends on which direction the lost element sat
  // relative to the viewport [INFERENCE, probe-observed by a round-11 gate reviewer against a
  // minimal scratch page, not this component]; pressing the OTHER key leaves the tree entirely
  // (WCAG 2.1.1 Keyboard is met only through that one correct direction, not unconditionally).
  // Re-entry via either key has NOT been live-verified against this actual component, by keyboard
  // or by screen reader -- carried on the PR's own not-verified list. Once re-entered, the
  // roving-tabindex mechanism (`rowsRef`, `tabbableAbsIndex`, recomputed via `rangeChanged` below
  // to the first RENDERED row whenever the previously-tabbable one scrolls out) lands on a real,
  // present, fully keyboard-functional row -- never the bare container. The row's own
  // `aria-selected` is never touched by a scroll, only `document.activeElement` moves. A row
  // genuinely gone (deleted on disk, an ancestor folder collapsed -- `!isConnected` AND absent
  // from the CURRENT logical `rows` list, not merely virtualised away) still rescues immediately,
  // below -- that case was never in question, only the scroll-only one. Real mitigations exist
  // and are NOT built here: keep the focused row's own index always rendered (Virtuoso's
  // `increaseViewportBy`, or re-`scrollIntoView` the focused index on every `rangeChanged`), or
  // switch the tree to the `aria-activedescendant` pattern so DOM focus never leaves the
  // `role="tree"` container even while the active row is virtualised away. This is an accepted
  // limitation pending Stuart's own sign-off (recorded as an open question on #463), not a closed
  // decision.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    function performRescue(): void {
      const treeRow = treeContainerRef.current?.querySelector<HTMLElement>('[data-tree-row-path][tabindex="0"]')
      // Gate round 8 fix (A11y8 Low): if the rendered range happens to hold no row with
      // `tabindex="0"` (for example only a virtualised "more" row is currently in view, or
      // `rows` is momentarily empty), fall back to the first rendered row of ANY tabindex
      // before giving up to the preview region or the bare container -- landing on the
      // container is the exact round-7 defect this round's own fix above removes everywhere
      // ELSE it could happen; this closes the one remaining narrow path to it.
      const anyRow = treeContainerRef.current?.querySelector<HTMLElement>('[data-tree-row-path]')
      const previewRegion = containerRef.current?.querySelector<HTMLElement>('[role="region"]')
      const target = treeRow ?? anyRow ?? previewRegion ?? containerRef.current
      rescueFocusRef.current = true
      try {
        target?.focus({ preventScroll: true })
      } finally {
        rescueFocusRef.current = false
      }
    }
    function handleFocusOut(event: FocusEvent): void {
      if (event.relatedTarget !== null) return
      const lost = event.target as Element | null
      requestAnimationFrame(() => {
        if (!isFocusStranded(document.activeElement, containerRef.current)) return
        if (lost) {
          const genuinelyGone =
            !lost.isConnected || lost.closest('[inert]') !== null || (lost as HTMLButtonElement).disabled === true
          if (!genuinelyGone) return
          const lostRowPath = lost.closest('[data-tree-row-path]')?.getAttribute('data-tree-row-path') ?? null
          if (lostRowPath !== null && rowsRef.current.some((row) => row.kind === 'node' && row.node.path === lostRowPath)) {
            // Merely scrolled out of the rendered window, still logically present in `rows` --
            // the accepted, disclosed limitation above: no rescue, Tab/Shift+Tab re-enters.
            return
          }
          // Gate round 12 fix (A11y12/Code12 HIGH/Medium): round 11's own `data-tree-more-row`
          // marker was dead -- nothing ever read it, so a clicked-then-scrolled-out "N more" row
          // still fell through to `performRescue()` below (that row carries no
          // `data-tree-row-path` at all, so `lostRowPath` above is always `null` for it). Reads
          // the row's own stable `key` (`more:${parentPath}`, see `flattenVisible` above) back off
          // the element and checks it against the CURRENT `rows` list the exact same way the node
          // case just above does -- still present means merely scrolled out (no rescue, same
          // disclosed limitation); genuinely gone (its parent folder collapsed or the listing
          // changed) still falls through to the rescue below.
          const lostMoreKey = lost.closest('[data-tree-more-key]')?.getAttribute('data-tree-more-key') ?? null
          if (lostMoreKey !== null && rowsRef.current.some((row) => row.kind === 'more' && row.key === lostMoreKey)) {
            return
          }
        }
        performRescue()
      })
    }
    container.addEventListener('focusout', handleFocusOut)
    return () => {
      container.removeEventListener('focusout', handleFocusOut)
    }
  }, [])

  const rows = useMemo(() => flattenVisible(root, showIgnored), [root, showIgnored])
  // Gate round 9 fix (A11y9 Medium): kept live every render so `handleFocusOut` above (attached
  // once, on mount) always reads the CURRENT logical row list, never a stale closure.
  rowsRef.current = rows

  const nodeAbsIndices = useMemo(() => {
    const indices: number[] = []
    rows.forEach((row, i) => {
      if (row.kind === 'node') indices.push(i)
    })
    return indices
  }, [rows])
  const selectedNodeIndex = useMemo(() => {
    if (nodeAbsIndices.length === 0) return -1
    const found = nodeAbsIndices.findIndex((absIndex) => (rows[absIndex] as NodeRow).node.path === selectedPath)
    return found === -1 ? 0 : found
  }, [rows, nodeAbsIndices, selectedPath])
  const selectedAbsIndex = nodeAbsIndices[selectedNodeIndex]
  // PR #671 gate round 4 fix (High, A11y4): `react-virtuoso`'s own scroll container carries
  // `tabIndex: 0` by default (confirmed against the installed package's own source), adding a
  // SECOND tab stop inside `role="tree"` that FR-022/SC-006 forbid -- Tab from "Show ignored
  // files" landed on an unnamed, roleless scroll box, with arrow keys there just scrolling it
  // rather than running tree navigation. Passing `tabIndex={-1}` on `<Virtuoso>` below removes
  // that stop; `renderedRange` (fed by `rangeChanged`) tracks which rows are CURRENTLY in the DOM
  // at all, so the one real tree Tab stop can be recomputed as "the selected row, if Virtuoso has
  // it rendered; otherwise the first rendered node row" -- without this, scrolling the selected
  // row out of view (a mouse wheel, or remounting at the top after a panel switch, FR-025) left
  // NO row anywhere with `tabIndex={0}`, so Tab skipped the tree entirely.
  const [renderedRange, setRenderedRange] = useState<{ startIndex: number; endIndex: number }>({ startIndex: 0, endIndex: 0 })
  const tabbableAbsIndex = useMemo(() => {
    if (
      selectedAbsIndex !== undefined &&
      selectedAbsIndex >= renderedRange.startIndex &&
      selectedAbsIndex <= renderedRange.endIndex
    ) {
      return selectedAbsIndex
    }
    for (let i = renderedRange.startIndex; i <= renderedRange.endIndex; i += 1) {
      if (rows[i]?.kind === 'node') return i
    }
    return undefined
  }, [selectedAbsIndex, renderedRange, rows])
  // Gate round 13 fix (A11y13/Verif13 HIGH): the retry side of `pendingFocusPathRef` (see that
  // ref's own comment above) -- re-runs every time Virtuoso reports a new rendered range
  // (`rangeChanged`), which fires again once a long `scrollIntoView` jump's target row actually
  // mounts. Looks the pending path up directly rather than trusting `tabbableAbsIndex`/any index
  // math, since a row's actual presence in the DOM is exactly what failed last time.
  // Gate round 14 fix (A11y14/Verif14/Sec14 Medium): two guards added before ever focusing --
  // (1) the pending path's own row must still be a NODE row in the CURRENT `rows` (`rowsRef`,
  // kept live every render below); a live-refresh patch, a collapse, or a reset can remove the
  // row entirely before it ever mounts, and a stale pending path for a row that no longer exists
  // must never be chased. (2) focus must still actually be STRANDED (`<body>`, nothing, or
  // already somewhere inside this panel) -- if the user has since Tabbed or clicked into
  // something OUTSIDE this panel on purpose (the composer, another pane), a later unrelated
  // `rangeChanged` (a live-refresh patch, an ordinary mouse-wheel scroll) must never pull focus
  // back out of wherever they deliberately moved it to.
  useEffect(() => {
    const pendingPath = pendingFocusPathRef.current
    if (!pendingPath) return
    if (!rowsRef.current.some((row) => row.kind === 'node' && row.node.path === pendingPath)) {
      pendingFocusPathRef.current = null
      return
    }
    const active = document.activeElement
    // Gate round 15 fix (A11y15/Code15 Medium): narrowed to `treeContainerRef` (the tree itself),
    // not `containerRef` (the whole panel, which also covers the preview pane, the "Show ignored
    // files" switch, and the toolbar) -- a Tab INTO the preview pane or the switch is still
    // "moved on purpose" and must clear the pending retry exactly like moving outside the panel
    // entirely; `containerRef` wrongly treated that as "still in the tree", so a later unrelated
    // `rangeChanged` could pull focus back out of the preview pane the user had just Tabbed into.
    if (active && active !== document.body && !treeContainerRef.current?.contains(active)) {
      pendingFocusPathRef.current = null
      return
    }
    const target = treeContainerRef.current?.querySelector<HTMLElement>(`[data-tree-row-path="${CSS.escape(pendingPath)}"]`)
    if (!target) return
    pendingFocusPathRef.current = null
    target.focus({ preventScroll: true })
  }, [renderedRange])
  // Gate round 13 fix (A11y13/Verif13 HIGH): a `pointerdown` anywhere in the document means the
  // user just acted on purpose -- a pending retry from an EARLIER key move must never steal focus
  // back after that, the identical principle round 10's own HIGH fix already applies to the
  // (now-removed) deferred scroll-out rescue. Document-level, not container-scoped: the user may
  // click outside this panel entirely (a chat message, empty space). Gate round 14 fix (A11y14
  // Medium): also clears on a `focusin` whose target lands OUTSIDE this panel (a keyboard Tab to
  // the composer fires no `pointerdown` at all, so that alone missed exactly this case). Gate
  // round 15 fix (A11y15/Code15 Medium): "outside" means outside `treeContainerRef` (the tree
  // itself), not `containerRef` (the whole panel) -- see the retry effect's own matching comment
  // above for why a Tab into the preview pane or the "Show ignored files" switch must count too.
  useEffect(() => {
    function clearPendingFocus(): void {
      pendingFocusPathRef.current = null
    }
    function clearPendingFocusIfOutside(event: FocusEvent): void {
      if (!treeContainerRef.current?.contains(event.target as Node | null)) clearPendingFocus()
    }
    document.addEventListener('pointerdown', clearPendingFocus, true)
    document.addEventListener('focusin', clearPendingFocusIfOutside, true)
    return () => {
      document.removeEventListener('pointerdown', clearPendingFocus, true)
      document.removeEventListener('focusin', clearPendingFocusIfOutside, true)
    }
  }, [])
  // Gate round 13 fix (A11y13/Verif13 HIGH): a pending retry targets a specific row PATH, which
  // only means anything for the Session that asked for it -- clears on every Session switch (the
  // cleanup below) and on unmount, so a retry queued for one Session's tree can never fire against
  // a different Session's (or no) tree mounted after it. Gate round 15 fix (Sec15 LOW): also
  // bumps `moveGenRef` -- a `scrollIntoView` call started just before a Session switch can still
  // have its own `done` fire afterward, against whatever tree is mounted by then; bumping here
  // makes that stale `done` a no-op, same guard `moveToRow` already uses for a superseded call
  // within the SAME Session.
  useEffect(() => {
    return () => {
      pendingFocusPathRef.current = null
      moveGenRef.current += 1
    }
  }, [sessionId])

  function activateRow(node: ExpandableNode): void {
    if (!sessionId) return
    if (node.kind === 'folder') {
      if (node.children === undefined) {
        // First expand: fetch, which also sets `expanded: true` on success (store's own
        // `withChildrenAt`).
        void loadDirectory(sessionId, node.path)
      } else {
        // Already fetched (collapsing or re-expanding): flip the local flag only, never re-fetch.
        toggleExpanded(sessionId, node.path)
      }
    } else if (node.kind === 'file') {
      void loadPreview(sessionId, node.path)
    }
    // `cannot-access`: nothing to activate.
  }

  function selectAndActivate(node: ExpandableNode): void {
    if (!sessionId) return
    setSelectedPath(sessionId, node.path)
    activateRow(node)
  }

  async function handleOpenInVSCode(path: string): Promise<boolean> {
    if (!sessionId) return true
    const result = await window.refract.fileExplorer.openInVSCode(sessionId, path)
    if (!result.ok) {
      notify(result.error)
      return true
    }
    // `{ opened: false }` is a normal result (FR-017, contracts/ipc.md), never an IPC error --
    // `TreeNodeRow` shows the "VS Code not found" state inline, never a toast.
    return result.value.opened
  }

  async function handleReveal(path: string): Promise<void> {
    if (!sessionId) return
    const result = await window.refract.fileExplorer.reveal(sessionId, path)
    if (!result.ok) notify(result.error)
  }

  // Mirrors `useWorktreeActions.ts`'s own clipboard-first-then-IPC-fallback pattern, scoped to
  // one file's own absolute path instead of the whole worktree root.
  async function handleCopyPath(path: string): Promise<void> {
    if (!sessionId) return
    if (worktreePath) {
      try {
        await navigator.clipboard.writeText(joinWorktreePath(worktreePath, path))
        toast.success('Path copied')
        return
      } catch {
        // fall through to the main-process clipboard channel
      }
    }
    const result = await window.refract.fileExplorer.copyPath(sessionId, path)
    if (result.ok) toast.success('Path copied')
    else notify(result.error)
  }

  function moveToRow(row: NodeRow, absIndex: number): void {
    if (!sessionId) return
    setSelectedPath(sessionId, row.node.path)
    // Gate round 13 fix (A11y13/Verif13 HIGH): a fresh move always supersedes an earlier,
    // still-pending retry -- see `pendingFocusPathRef`'s own comment above.
    pendingFocusPathRef.current = null
    // Gate round 14 fix (Code14 HIGH): bumped here, checked at the top of `done` below -- see
    // `moveGenRef`'s own comment above `pendingFocusPathRef`'s declaration for why a superseded
    // call's `done` must become a no-op.
    const gen = ++moveGenRef.current
    virtuosoRef.current?.scrollIntoView({
      index: absIndex,
      done: () => {
        if (gen !== moveGenRef.current) return
        const target = treeContainerRef.current?.querySelector<HTMLElement>(`[data-tree-row-path="${CSS.escape(row.node.path)}"]`)
        if (target) {
          // Gate round 14 fix (Code14 HIGH): clears any stale pending path before focusing --
          // belt-and-braces alongside the `gen` guard just above (this `done` is the CURRENT
          // move by construction once that guard passes, so nothing should be pending here
          // already, but clearing explicitly costs nothing and removes any doubt).
          pendingFocusPathRef.current = null
          target.focus()
        } else {
          // Gate round 13 fix (A11y13/Verif13 HIGH): on a long jump (Home/End/type-ahead across
          // hundreds of rows), Virtuoso's `done` can fire once SCROLLING itself settles, before
          // the target row has actually mounted (estimated row heights, not yet measured) --
          // `querySelector` finds nothing here and focus would otherwise silently strand on
          // `<body>`. Queues a retry the `renderedRange` effect above consumes the moment a LATER
          // `rangeChanged` shows this row is actually in the DOM.
          pendingFocusPathRef.current = row.node.path
        }
      }
    })
  }

  function handleTypeahead(char: string, row: NodeRow): void {
    clearTimeout(typeaheadRef.current.timer)
    typeaheadRef.current.buffer += char.toLowerCase()
    const buffer = typeaheadRef.current.buffer
    typeaheadRef.current.timer = setTimeout(() => {
      typeaheadRef.current.buffer = ''
    }, 500)
    const total = nodeAbsIndices.length
    for (let offset = 1; offset <= total; offset += 1) {
      const candidateNodeIndex = (row.nodeIndex + offset) % total
      const candidateAbsIndex = nodeAbsIndices[candidateNodeIndex]
      const candidate = candidateAbsIndex === undefined ? undefined : rows[candidateAbsIndex]
      if (candidate && candidate.kind === 'node' && candidate.node.name.toLowerCase().startsWith(buffer)) {
        moveToRow(candidate, candidateAbsIndex!)
        return
      }
    }
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLDivElement>, row: NodeRow, absIndex: number): void {
    const node = row.node
    switch (event.key) {
      case 'ArrowRight': {
        event.preventDefault()
        if (node.kind !== 'folder') break
        if (!node.expanded) {
          activateRow(node)
          break
        }
        const childRow = rows[absIndex + 1]
        if (childRow && childRow.kind === 'node' && childRow.depth === row.depth + 1) {
          moveToRow(childRow, absIndex + 1)
        }
        break
      }
      case 'ArrowLeft': {
        event.preventDefault()
        if (node.kind === 'folder' && node.expanded) {
          activateRow(node)
          break
        }
        for (let i = absIndex - 1; i >= 0; i -= 1) {
          const candidate = rows[i]
          if (!candidate) break
          if (candidate.depth < row.depth) {
            if (candidate.kind === 'node') moveToRow(candidate, i)
            break
          }
        }
        break
      }
      case 'ArrowDown': {
        event.preventDefault()
        const nextAbs = nodeAbsIndices[row.nodeIndex + 1]
        if (nextAbs !== undefined) moveToRow(rows[nextAbs] as NodeRow, nextAbs)
        break
      }
      case 'ArrowUp': {
        event.preventDefault()
        const prevAbs = nodeAbsIndices[row.nodeIndex - 1]
        if (prevAbs !== undefined) moveToRow(rows[prevAbs] as NodeRow, prevAbs)
        break
      }
      case 'Home': {
        event.preventDefault()
        const firstAbs = nodeAbsIndices[0]
        if (firstAbs !== undefined) moveToRow(rows[firstAbs] as NodeRow, firstAbs)
        break
      }
      case 'End': {
        event.preventDefault()
        const lastAbs = nodeAbsIndices[nodeAbsIndices.length - 1]
        if (lastAbs !== undefined) moveToRow(rows[lastAbs] as NodeRow, lastAbs)
        break
      }
      // Gate round 11 fix (A11y11 HIGH): PageUp/PageDown were unhandled, so their native default
      // action scrolled Virtuoso's own scroller out from under the focused row with no tree
      // navigation happening at all -- once the row left the rendered window, Virtuoso unmounted
      // it, dropping focus to `<body>` with nothing to rescue it (the round-10 removal of the
      // deferred rescue closed a worse bug but left this keyboard path, previously covered,
      // unrescued). Moves by one page of NODE rows (folders/files only, matching every other
      // keyboard move here, never counting a virtualised "N more" row), where a page is however
      // many node-or-not rows are CURRENTLY rendered (`renderedRange`, fed by Virtuoso's own
      // `rangeChanged`) -- the same notion of "a page" the user can actually see on screen,
      // clamped to the first/last node row rather than wrapping or doing nothing past either end.
      case 'PageDown': {
        event.preventDefault()
        const page = Math.max(1, renderedRange.endIndex - renderedRange.startIndex)
        const targetNodeIndex = Math.min(nodeAbsIndices.length - 1, row.nodeIndex + page)
        const targetAbs = nodeAbsIndices[targetNodeIndex]
        if (targetAbs !== undefined) moveToRow(rows[targetAbs] as NodeRow, targetAbs)
        break
      }
      case 'PageUp': {
        event.preventDefault()
        const page = Math.max(1, renderedRange.endIndex - renderedRange.startIndex)
        const targetNodeIndex = Math.max(0, row.nodeIndex - page)
        const targetAbs = nodeAbsIndices[targetNodeIndex]
        if (targetAbs !== undefined) moveToRow(rows[targetAbs] as NodeRow, targetAbs)
        break
      }
      case 'Enter': {
        event.preventDefault()
        selectAndActivate(node)
        break
      }
      default: {
        // Gate round 11 fix (A11y11 HIGH): Space's native default action is ALSO to scroll the
        // nearest scrollable ancestor (Virtuoso's own scroller) exactly like PageUp/PageDown
        // above -- prevented here, before falling through to type-ahead (where a literal space
        // character is harmless: no file/folder name in this tree starts with one in practice,
        // and if one ever did, matching it is still correct type-ahead behaviour, not a new
        // select/activate binding the spec never asked for on this key).
        if (event.key === ' ') event.preventDefault()
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          handleTypeahead(event.key, row)
        }
      }
    }
  }

  function handleRetry(): void {
    if (!sessionId) return
    // PR #671 gate fix (code-reviewer MEDIUM, round 2): focuses the container BEFORE the fetch
    // starts, not after -- the Retry button just clicked is about to unmount the instant
    // `status` flips to `'loading'` (`loadDirectory`'s own synchronous `set` call, before its
    // first `await`), and waiting for the reclaim effect above means one extra animation frame
    // where focus already reads as `<body>` to anything checking synchronously.
    containerRef.current?.focus()
    void loadDirectory(sessionId, '')
  }

  return (
    <div
      ref={containerRef}
      role="group"
      tabIndex={-1}
      aria-label="File explorer"
      className="flex h-full flex-col overflow-hidden p-2 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
    >
      {!sessionId ? (
        <Empty className="h-full">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderIcon aria-hidden />
            </EmptyMedia>
            <EmptyTitle>No Session open</EmptyTitle>
            <EmptyDescription>Open a Session to browse its files.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : status === 'loading' ? (
        <p role="status" className="p-2 text-sm text-muted-foreground">
          Loading…
        </p>
      ) : status === 'error' ? (
        <Empty className="h-full">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TriangleAlertIcon aria-hidden />
            </EmptyMedia>
            <EmptyTitle>Couldn't load this Session's files</EmptyTitle>
            <EmptyDescription role="alert">{error}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={handleRetry}>
              Retry
            </Button>
          </EmptyContent>
        </Empty>
      ) : !root?.children || root.children.length === 0 ? (
        <Empty className="h-full">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderOpenIcon aria-hidden />
            </EmptyMedia>
            <EmptyTitle>Empty worktree</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="no-drag-region flex shrink-0 items-center justify-between gap-2 border-b border-divider px-1 pb-1.5">
            <label htmlFor="file-explorer-show-ignored" className="text-xs text-muted-foreground">
              Show ignored files
            </label>
            <Switch
              id="file-explorer-show-ignored"
              checked={showIgnored}
              onCheckedChange={(checked) => sessionId && setShowIgnored(sessionId, checked)}
            />
          </div>
          <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
            <ResizablePanel defaultSize="60%" minSize="20%">
              {rows.length === 0 ? (
                <p className="p-2 text-xs text-muted-foreground">
                  Every entry here is ignored. Turn on "Show ignored files" above to see them.
                </p>
              ) : (
                <div ref={treeContainerRef} role="tree" aria-label="Files" className="h-full">
                  <Virtuoso
                    ref={virtuosoRef}
                    style={{ height: '100%' }}
                    data={rows}
                    tabIndex={-1}
                    initialTopMostItemIndex={selectedAbsIndex ?? 0}
                    rangeChanged={setRenderedRange}
                    computeItemKey={(_index, row) => (row.kind === 'node' ? row.node.path : row.key)}
                    itemContent={(absIndex, row) =>
                      row.kind === 'more' ? (
                        // PR #671 gate round 4 fix (Medium, A11y4): a real `role="treeitem"` (not
                        // a plain unreachable `<div>`) so a screen reader's own per-item browse
                        // mode announces it; `aria-disabled` (never an activatable item) and
                        // `tabIndex={-1}` keep it out of the roving-tabindex/keyboard sequence --
                        // Up/Down/Home/End/type-ahead all skip "more" rows by construction
                        // (`nodeAbsIndices` never includes one). Gate round 11 fix (A11y11 Low),
                        // round 12 correction (A11y12/Code12 HIGH/Medium): round 11 added a plain
                        // boolean `data-tree-more-row` marker here, but `handleFocusOut` never
                        // actually read it back (dead code, the claimed fix did not exist) --
                        // `data-tree-more-key` carries this row's own stable `key`
                        // (`more:${parentPath}`) instead, which `handleFocusOut` now reads and
                        // checks against the CURRENT `rows` list the same way a node row's own
                        // path is checked, so a clicked-then-scrolled-out "more" row is correctly
                        // treated as merely virtualised away, not rescued.
                        <div
                          role="treeitem"
                          aria-disabled="true"
                          aria-level={row.depth + 1}
                          aria-setsize={row.setsize}
                          aria-posinset={row.posinset}
                          tabIndex={-1}
                          data-tree-more-key={row.key}
                          style={{ paddingLeft: `${row.depth * 16 + 4}px` }}
                          className="px-1 py-0.5 text-xs text-muted-foreground"
                        >
                          {row.count} more…
                        </div>
                      ) : (
                        <TreeNodeRow
                          row={row}
                          absIndex={absIndex}
                          selected={row.nodeIndex === selectedNodeIndex}
                          tabbable={absIndex === tabbableAbsIndex}
                          onRowClick={selectAndActivate}
                          onRowFocus={(node) => sessionId && !rescueFocusRef.current && setSelectedPath(sessionId, node.path)}
                          onRowKeyDown={handleRowKeyDown}
                          onOpenInVSCode={handleOpenInVSCode}
                          onReveal={handleReveal}
                          onCopyPath={handleCopyPath}
                        />
                      )
                    }
                  />
                </div>
              )}
            </ResizablePanel>
            <ResizableHandle withHandle aria-label="Resize file tree and preview" />
            <ResizablePanel defaultSize="40%" minSize="15%">
              <FilePreviewPane
                preview={preview}
                previewLoading={previewLoading}
                onOpenInVSCode={handleOpenInVSCode}
                onReveal={handleReveal}
                onCopyPath={handleCopyPath}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        </>
      )}
    </div>
  )
}

function TreeNodeRow({
  row,
  absIndex,
  selected,
  tabbable,
  onRowClick,
  onRowFocus,
  onRowKeyDown,
  onOpenInVSCode,
  onReveal,
  onCopyPath
}: {
  row: NodeRow
  absIndex: number
  selected: boolean
  /** PR #671 gate round 4 fix (High, A11y4): the ONE roving-tabindex stop, computed by the
   * parent from `rangeChanged` (`tabbableAbsIndex`) rather than always following `selected` --
   * when the selected row has scrolled out of Virtuoso's own rendered window, `selected` would
   * otherwise point at a row that does not exist in the DOM at all, leaving NO tree row
   * reachable by Tab. */
  tabbable: boolean
  onRowClick: (node: ExpandableNode) => void
  onRowFocus: (node: ExpandableNode) => void
  onRowKeyDown: (event: KeyboardEvent<HTMLDivElement>, row: NodeRow, absIndex: number) => void
  onOpenInVSCode: (path: string) => Promise<boolean>
  onReveal: (path: string) => Promise<void>
  onCopyPath: (path: string) => Promise<void>
}) {
  const node = row.node
  const isFolder = node.kind === 'folder'
  const expanded = node.expanded === true
  const mark = node.gitStatus ? STATUS_MARKS[node.gitStatus] : null
  // T025: a file/folder row's own 3 actions (Open in VS Code, Reveal in File Explorer, Copy
  // path) -- never offered for a `cannot-access` row, which has nothing safe to open/reveal/
  // copy (main could not even resolve it).
  const canAct = node.kind !== 'cannot-access'
  const rowRef = useRef<HTMLDivElement>(null)
  // PR #671 gate round 4 fix (Medium, A11y4): the row's own accessible name was being built from
  // EVERY child in document order, including the kebab button's own `aria-label` ("More actions
  // for X") and the transient "VS Code not found" status text -- a screen reader read the whole
  // row as "staged.ts Added More actions for staged.ts". `aria-labelledby` scopes the row's name
  // to exactly the name span and (when present) the status-mark span, leaving the kebab and any
  // transient status text out of it (they still read their own separate accessible names/text
  // when focused or announced directly).
  //
  // Gate round 5 fix (Code5 Low, re-flagged A11y5 Medium): ids built from the node's own PATH
  // (as this comment used to justify, "stable, unique per row") break `aria-labelledby` the
  // instant a path contains a space -- `aria-labelledby` is a whitespace-SEPARATED id list, so
  // `fe-row-my file.ts-name` reads as two separate (nonexistent) ids, not one. `useId()` is
  // perfectly referenceable here despite being generated at render time: it is read in THIS SAME
  // render's JSX below, never serialised or passed across a render boundary, so there is no
  // "needs a plain string before render" constraint it fails to meet -- the original worry this
  // comment raised does not actually apply to this call site.
  const rowIdBase = useId()
  const nameId = `${rowIdBase}-name`
  const markId = `${rowIdBase}-mark`
  // FR-017: `{ opened: false }` is a normal result, not an IPC error (contracts/ipc.md), so this
  // shows inline rather than as a toast -- auto-clears after a few seconds or on the next
  // attempt, the same transient-but-non-toast treatment `ManageAccountsDialog.tsx`'s own
  // "GitHub CLI not found" state uses.
  const [vscodeNotFound, setVscodeNotFound] = useState(false)
  useEffect(() => {
    if (!vscodeNotFound) return
    const timer = setTimeout(() => setVscodeNotFound(false), 5000)
    return () => clearTimeout(timer)
  }, [vscodeNotFound])

  async function runOpenInVSCode(): Promise<void> {
    const opened = await onOpenInVSCode(node.path)
    setVscodeNotFound(!opened)
  }

  // Overrides Radix's own default close-auto-focus (which would return focus to whichever
  // element triggered the menu -- the kebab button for `DropdownMenuContent`, invisible at rest
  // since it only shows on hover/focus-within) -- this row is the roving-tabindex stop that
  // must hold focus afterward, the same reasoning `SessionList.tsx`'s own override documents.
  function handleMenuCloseAutoFocus(event: Event): void {
    event.preventDefault()
    rowRef.current?.focus()
  }

  const menuActions: Array<{ key: string; label: string; icon: LucideIcon; onSelect: () => void }> = [
    { key: 'open-vscode', label: 'Open in VS Code', icon: Code2Icon, onSelect: () => void runOpenInVSCode() },
    { key: 'reveal', label: 'Reveal in File Explorer', icon: FolderOpenIcon, onSelect: () => void onReveal(node.path) },
    { key: 'copy-path', label: 'Copy path', icon: CopyIcon, onSelect: () => void onCopyPath(node.path) }
  ]

  const rowContent = (
    <div
      ref={rowRef}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-setsize={row.setsize}
      aria-posinset={row.posinset}
      aria-selected={selected}
      aria-expanded={isFolder ? expanded : undefined}
      aria-labelledby={mark ? `${nameId} ${markId}` : nameId}
      // PR #671 gate round 4 fix (Medium, A11y4): the kebab's own keyboard-only reveal (Shift+F10 or the ContextMenu key) is now at least advertised on the row itself.
      aria-keyshortcuts={canAct ? 'Shift+F10' : undefined}
      tabIndex={tabbable ? 0 : -1}
      data-tree-row-path={node.path}
      style={{ paddingLeft: `${row.depth * 16 + 4}px` }}
      className="group no-drag-region relative flex w-full cursor-default items-center gap-1 rounded px-1 py-0.5 text-left text-sm hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring aria-selected:bg-accent aria-selected:text-accent-foreground forced-colors:aria-selected:border forced-colors:aria-selected:border-[Highlight]"
      onClick={() => onRowClick(node)}
      onFocus={() => onRowFocus(node)}
      onKeyDown={(event) => onRowKeyDown(event, row, absIndex)}
    >
      {selected && <ActiveIndicatorBar />}
      <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
        {isFolder && (expanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />)}
      </span>
      {isFolder ? (
        expanded ? (
          <FolderOpenIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <FolderIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        )
      ) : node.kind === 'cannot-access' ? (
        <FileWarningIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <FileIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      )}
      <span id={nameId} className="min-w-0 flex-1 truncate text-chat-foreground" title={node.name}>
        {node.name}
        {node.kind === 'cannot-access' && <span className="sr-only"> (cannot access)</span>}
      </span>
      {mark && (
        <span id={markId} title={mark.label} className="flex shrink-0 items-center">
          <mark.Icon aria-hidden className={`size-3 ${mark.className}`} />
          <span className="sr-only">{mark.label}</span>
        </span>
      )}
      {vscodeNotFound && (
        <span role="status" className="shrink-0 text-xs text-muted-foreground">
          VS Code not found
        </span>
      )}
      {canAct && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              tabIndex={-1}
              aria-label={`More actions for ${node.name}`}
              // PR #671 gate round 4 fix (Medium, A11y4): visible whenever this row is SELECTED
              // (not hover/focus-within only, which read as hover-only on a touch device with no
              // hover concept at all), and raised to a `size-6` (24px) target -- the previous
              // ~18px (icon `size-3.5` plus `p-0.5`) sat under the 24px minimum.
              className={`flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100 ${selected ? 'opacity-100' : 'opacity-0'}`}
              // The whole row (not a separate open button, unlike `SessionList.tsx`) carries
              // `onClick`/`onRowClick` above -- without this, clicking the trigger would bubble
              // up and also select/activate the row underneath it.
              onClick={(event) => event.stopPropagation()}
            >
              <EllipsisVerticalIcon aria-hidden className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onCloseAutoFocus={handleMenuCloseAutoFocus}>
            {menuActions.map((action) => (
              <DropdownMenuItem key={action.key} onSelect={action.onSelect}>
                <action.icon aria-hidden className="size-3.5" />
                {action.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )

  if (!canAct) return rowContent

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{rowContent}</ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={handleMenuCloseAutoFocus}>
        {menuActions.map((action) => (
          <ContextMenuItem key={action.key} onSelect={action.onSelect}>
            <action.icon aria-hidden className="size-3.5" />
            {action.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}
