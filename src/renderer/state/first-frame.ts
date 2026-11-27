// Gate for non-visual startup work (FR-184, #1898): tasks queued with `afterFirstFrame` wait until the
// first frame has painted, so remote detection, the PR count and background refreshes never delay it.
// main.tsx calls `openGateAfterFirstFrame()` right after rendering.

/** A hidden window pauses `requestAnimationFrame`; this bounds the wait so deferred work still starts. */
export const FIRST_FRAME_FALLBACK_MS = 1000

let opened = false
let scheduled = false
let queue: Array<() => void> = []

/** Runs `task` once the first frame has painted; immediately if it already has. A throwing task never blocks the rest. */
export function afterFirstFrame(task: () => void): void {
  if (opened) {
    task()
    return
  }
  queue.push(task)
}

function open(): void {
  if (opened) return
  opened = true
  const pending = queue
  queue = []
  for (const task of pending) {
    try {
      task()
    } catch (error) {
      console.error('[refract] deferred startup task failed', error)
    }
  }
}

/** The rAF callback runs before the paint, so the timeout inside it runs after it. */
export function openGateAfterFirstFrame(): void {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(() => setTimeout(open, 0))
  setTimeout(open, FIRST_FRAME_FALLBACK_MS)
}

/** Test seam: closes the gate and drops queued work. */
export function resetFirstFrameGateForTests(): void {
  opened = false
  scheduled = false
  queue = []
}
