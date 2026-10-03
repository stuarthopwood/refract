// Shared window-chrome action (spec 001 T100, FR-057): double-clicking a draggable top-row area
// maximises or restores the window. One helper so the left nav header and the chat header don't
// each duplicate the IPC call and its error handling.
import { notify } from '@/state'

export function toggleMaximize(): void {
  void window.refract.window.toggleMaximize().then((result) => {
    if (!result.ok) notify(result.error)
  })
}
