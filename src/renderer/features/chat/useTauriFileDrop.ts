// Tauri build only (issue #793, spike section 2): Tauri's own native drag-drop handler swallows
// the HTML5 `drop` DOM event before `ChatPane.tsx`'s own `handlePaneDrop` ever sees it
// (`dragDropEnabled` defaults to `true`, left unset in `tauri.conf.json`'s window config), so the
// composer never attaches a dropped image there today. Listens to `window.refract.attachments.
// onFileDrop` instead (absent in the Electron build, where the DOM path already works
// unmodified), hit-tests the drop's physical-pixel `position` against whichever mounted pane it
// landed on, and shares the attach-loop/notify core with `ChatPane.tsx`'s own Electron `File[]`
// path (`attachDroppedPaths.ts`).
//
// ONE global `onFileDrop` subscription for the whole app (gate fix), not one per mounted
// `ChatPane` (split view can mount two): `getCurrentWebview().onDragDropEvent` is a single native
// hook, so every `useTauriFileDrop` caller instead registers/deregisters its own pane descriptor
// in `panes` below, and the one shared listener fans a drop out to whichever pane's own
// `getBoundingClientRect()` the position actually falls inside.
import { useEffect, useRef } from 'react'
import { attachResolvedPaths, remainingAttachmentSlots } from './attachDroppedPaths'
import { notify } from '@/state'

interface PaneDescriptor {
  sessionId: string
  paneRef: { current: HTMLElement | null }
  /** Read fresh on every drop, not captured at registration time -- `composerDisabled` changes
   * across renders without the pane ever unmounting/re-registering. */
  isComposerDisabled: () => boolean
  dragDepthRef: { current: number }
  setIsDraggingFiles: (value: boolean) => void
}

const panes = new Set<PaneDescriptor>()
let unsubscribe: (() => void) | undefined

function ensureSubscribed(): void {
  if (unsubscribe) return
  const onFileDrop = window.refract.attachments.onFileDrop
  if (!onFileDrop) return
  unsubscribe = onFileDrop(({ paths, position }) => {
    // Nothing else ever clears the drag-over overlay for a real drop in this build (the DOM
    // `drop` event each pane's own `handlePaneDrop` normally resets it on never fires here) --
    // reset every mounted pane unconditionally; idempotent and harmless for the ones not hit.
    for (const pane of panes) {
      pane.dragDepthRef.current = 0
      pane.setIsDraggingFiles(false)
    }
    // `position` is physical pixels relative to the webview's own top-left corner (spike section
    // 2's own doc comment on `DragDropEvent`); `getBoundingClientRect()` is CSS pixels AT THE
    // CURRENT ZOOM. `devicePixelRatio` is exactly the physical-to-CSS conversion factor Chromium
    // itself uses at any zoom level (it is defined as OS scale factor times page zoom, the same
    // combination that turns a physical input coordinate into a CSS one) -- not just the OS
    // scale factor, so this stays correct at a non-100% page zoom too, not only a non-100% OS
    // display scale.
    const x = position.x / window.devicePixelRatio
    const y = position.y / window.devicePixelRatio
    for (const pane of panes) {
      const rect = pane.paneRef.current?.getBoundingClientRect()
      if (!rect) continue
      // Half-open bounds (gate fix): a drop exactly on the shared edge between two side-by-side
      // panes (split view) must land in exactly one of them, never both.
      if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) continue
      void handleDrop(pane, paths)
      break
    }
  })
}

async function handleDrop(pane: PaneDescriptor, paths: string[]): Promise<void> {
  // Gate round 1 (D2 Medium): records the native drop's own paths against this Session's
  // allow-list BEFORE attaching any of them -- `readFile` refuses an absolute path that was
  // never recorded this way (or via `pickFiles`), so a CONFUSED renderer (a stale/incorrect
  // in-memory path, a logic bug) can no longer read an arbitrary absolute file merely by asking
  // for it.
  // Gate round 3 (Code3 HIGH): the Result is now checked -- an unknown/deleted sessionId (the
  // same `invalid-argument` `resolve_session_worktree` already surfaces to `pickFiles`) used to
  // be silently swallowed here, then fail confusingly later at the first `readFile` call instead.
  const recordResult = await window.refract.attachments.recordDroppedPaths(pane.sessionId, paths)
  if (!recordResult.ok) {
    notify(recordResult.error)
    return
  }
  const remainingSlots = remainingAttachmentSlots(pane.sessionId)
  const capped = paths.slice(0, remainingSlots)
  const resolved = capped.map((filePath) => ({ name: filePath.split(/[\\/]/).pop() ?? filePath, filePath }))
  await attachResolvedPaths(pane.sessionId, resolved, [], paths.length, remainingSlots, pane.isComposerDisabled())
}

interface UseTauriFileDropArgs {
  sessionId: string
  paneRef: { current: HTMLElement | null }
  composerDisabled: boolean
  dragDepthRef: { current: number }
  setIsDraggingFiles: (value: boolean) => void
}

export function useTauriFileDrop({ sessionId, paneRef, composerDisabled, dragDepthRef, setIsDraggingFiles }: UseTauriFileDropArgs): void {
  const composerDisabledRef = useRef(composerDisabled)
  composerDisabledRef.current = composerDisabled
  useEffect(() => {
    ensureSubscribed()
    const descriptor: PaneDescriptor = {
      sessionId,
      paneRef,
      isComposerDisabled: () => composerDisabledRef.current,
      dragDepthRef,
      setIsDraggingFiles
    }
    panes.add(descriptor)
    return () => {
      panes.delete(descriptor)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])
}
